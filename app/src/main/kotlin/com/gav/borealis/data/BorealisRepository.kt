package com.gav.borealis.data

import com.gav.borealis.delivery.PlayArtifactDownloader
import com.gav.borealis.install.BorealisInstallCoordinator
import com.gav.borealis.install.InstallPreparationResult
import com.gav.borealis.security.SignedJobVerifier
import com.thelightphone.sdk.install.LightPackageInstallOutcome
import com.thelightphone.sdk.install.LightPackageInstaller
import kotlinx.coroutines.CancellationException

data class BorealisSnapshot(
    val session: BorealisSession? = null,
    val pendingPairing: PendingPairingSession? = null,
    val jobs: List<SignedInstallJob> = emptyList(),
    val pendingInstall: PendingInstall? = null,
    val revision: Long = 0L,
)

data class ProcessingResult(
    val message: String,
    val changed: Boolean,
)

class BorealisRepository(
    private val store: BorealisStore,
    private val installer: LightPackageInstaller,
    private val coordinator: BorealisInstallCoordinator,
    private val downloader: PlayArtifactDownloader,
    private val verifier: SignedJobVerifier,
    private val clearPlayAuthentication: suspend () -> Unit = {},
) {
    val canRequestPackageInstalls: Boolean
        get() = installer.canRequestPackageInstalls

    fun openInstallAccessSettings(): Boolean = installer.openInstallAccessSettings()

    suspend fun load(): BorealisSnapshot = BorealisSnapshot(
        session = store.loadSession(),
        pendingPairing = store.loadPending(),
        pendingInstall = store.loadPendingInstall(),
        revision = store.lastRevision(),
    )

    suspend fun beginPairing(
        instanceUrl: String,
        deviceLabel: String = "Light Phone III",
    ): Result<PendingPairingSession> = repositoryRunCatching {
        val normalizedUrl = normalizeInstanceUrl(instanceUrl)
        val bearer = generateDeviceBearer()
        BorealisApi(normalizedUrl).use { api ->
            val pairing = api.createPairing(deviceLabel, deviceBearerDigest(bearer)).getOrThrow()
            PendingPairingSession(normalizedUrl, bearer, pairing).also { store.savePending(it) }
        }
    }

    suspend fun pollPairing(): Result<PairingStatus> = repositoryRunCatching {
        val pending = store.loadPending() ?: error("No pairing is in progress.")
        BorealisApi(pending.instanceUrl).use { api ->
            api.pairingStatus(pending.pairing).getOrThrow()
        }
    }

    suspend fun activatePairing(): Result<BorealisSession> = repositoryRunCatching {
        val pending = store.loadPending() ?: error("No pairing is in progress.")
        val activation = BorealisApi(pending.instanceUrl).use { api ->
            api.activatePairing(pending.pairing).getOrThrow()
        }
        BorealisSession(
            instanceUrl = pending.instanceUrl,
            deviceId = activation.deviceId,
            deviceBearer = pending.deviceBearer,
            keyId = activation.keyId,
            signingPublicKey = activation.signingPublicKey,
        ).also {
            store.saveSession(it)
            store.clearPending()
        }
    }

    suspend fun sync(): Result<BorealisSnapshot> = repositoryRunCatching {
        val session = store.loadSession() ?: error("Pair Borealis with the companion first.")
        val sync = BorealisApi(session.instanceUrl).use { api ->
            api.sync(session.deviceBearer).getOrThrow()
        }
        require(sync.deviceId == session.deviceId) { "The companion returned another device's state." }
        val jobs = sync.jobs.map { verifier.verify(session, it) }
            .distinctBy(SignedInstallJob::jobId)
        store.saveRevision(sync.revision)
        BorealisSnapshot(
            session = session,
            jobs = jobs,
            pendingInstall = store.loadPendingInstall(),
            revision = sync.revision,
        )
    }

    suspend fun processJob(job: SignedInstallJob): Result<ProcessingResult> = repositoryRunCatching {
        require(store.loadPendingInstall() == null) { "Another install is still in progress." }
        processVerifiedJob(job)
    }

    suspend fun syncAndUpdate(): Result<ProcessingResult> = repositoryRunCatching {
        reconcilePendingInstall()?.let { return@repositoryRunCatching it }
        val snapshot = sync().getOrThrow()
        val update = snapshot.jobs.firstOrNull { installer.installedPackage(it.packageName) != null }
            ?: return@repositoryRunCatching ProcessingResult(
                message = if (snapshot.jobs.isEmpty()) "Borealis is up to date." else "New installs are waiting for approval on the phone.",
                changed = false,
            )
        processVerifiedJob(update)
    }

    suspend fun reconcilePendingInstall(): ProcessingResult? {
        val pending = store.loadPendingInstall() ?: return null
        val session = store.loadSession() ?: return ProcessingResult("The companion pairing is missing.", false)
        val result = installer.result(pending.sessionId)
            ?: return ProcessingResult("Installation is still being processed by Android.", false)
        val (status, message, terminal) = when (result.outcome) {
            LightPackageInstallOutcome.AwaitingUserAction ->
                Triple(BorealisJobStatus.AwaitingUserAction, "Confirm the install in Android.", false)
            LightPackageInstallOutcome.Installed ->
                Triple(BorealisJobStatus.Succeeded, "${pending.packageName} is installed.", true)
            LightPackageInstallOutcome.Cancelled ->
                Triple(BorealisJobStatus.Cancelled, result.message ?: "Installation was cancelled.", true)
            LightPackageInstallOutcome.Failed ->
                Triple(BorealisJobStatus.Failed, result.message ?: "Android could not install the app.", true)
        }
        report(
            session = session,
            jobId = pending.jobId,
            request = JobReportRequest(
                status = status.wireValue,
                installedVersionCode = if (status == BorealisJobStatus.Succeeded) pending.versionCode else null,
                message = result.message,
            ),
        )
        if (terminal) {
            installer.clearResult(pending.sessionId)
            downloader.delete(pending.jobId)
            store.clearPendingInstall()
        }
        return ProcessingResult(message, changed = terminal)
    }

    suspend fun forget() {
        clearPlayAuthentication()
        store.clearPendingInstall()
        store.forget()
    }

    private suspend fun processVerifiedJob(job: SignedInstallJob): ProcessingResult {
        val session = store.loadSession() ?: error("Pair Borealis with the companion first.")
        report(
            session,
            job.jobId,
            JobReportRequest(status = BorealisJobStatus.Installing.wireValue),
        )
        return when (val result = coordinator.prepareAndSubmit(job)) {
            is InstallPreparationResult.AlreadyCurrent -> {
                report(
                    session,
                    job.jobId,
                    JobReportRequest(
                        status = BorealisJobStatus.Succeeded.wireValue,
                        installedVersionCode = result.versionCode,
                    ),
                )
                ProcessingResult("${job.displayName} is already current.", true)
            }
            is InstallPreparationResult.NeedsSignerReview -> {
                report(
                    session,
                    job.jobId,
                    JobReportRequest(
                        status = BorealisJobStatus.ReviewRequired.wireValue,
                        observedSignerSha256 = result.signerSha256,
                        message = "Approve the observed publisher signer before installation.",
                    ),
                )
                ProcessingResult("Review ${job.displayName}'s publisher signer in the companion.", true)
            }
            is InstallPreparationResult.Failed -> {
                report(
                    session,
                    job.jobId,
                    JobReportRequest(
                        status = BorealisJobStatus.Failed.wireValue,
                        message = result.message,
                    ),
                )
                ProcessingResult(result.message, true)
            }
            is InstallPreparationResult.Submitted -> {
                store.savePendingInstall(
                    PendingInstall(
                        jobId = job.jobId,
                        sessionId = result.session.id,
                        packageName = job.packageName,
                        versionCode = result.versionCode,
                    ),
                )
                reconcilePendingInstall()
                    ?: ProcessingResult("${job.displayName} was handed to Android.", true)
            }
        }
    }

    private suspend fun report(
        session: BorealisSession,
        jobId: String,
        request: JobReportRequest,
    ) {
        BorealisApi(session.instanceUrl).use { api ->
            val response = api.report(session.deviceBearer, jobId, request).getOrThrow()
            require(response.ok) { "The companion did not accept the install status." }
            store.saveRevision(response.revision)
        }
    }
}

private suspend fun <T> repositoryRunCatching(block: suspend () -> T): Result<T> = try {
    Result.success(block())
} catch (error: CancellationException) {
    throw error
} catch (error: Exception) {
    Result.failure(error)
}
