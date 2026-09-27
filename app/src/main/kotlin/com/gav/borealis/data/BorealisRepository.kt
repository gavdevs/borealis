package com.gav.borealis.data

import com.gav.borealis.delivery.PlayArtifactDownloader
import com.gav.borealis.install.BorealisInstallCoordinator
import com.gav.borealis.install.InstallPreparationResult
import com.gav.borealis.install.InstallProgress
import com.gav.borealis.install.InstallStage
import com.gav.borealis.security.SignedJobVerifier
import com.thelightphone.sdk.install.LightPackageInstallOutcome
import com.thelightphone.sdk.install.LightPackageInstaller
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

data class BorealisSnapshot(
    val session: BorealisSession? = null,
    val pendingPairing: PendingPairingSession? = null,
    val library: List<LibraryAppState> = emptyList(),
    val pendingInstall: PendingInstall? = null,
    val installProgress: InstallProgress? = null,
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
    private val latestVersionCode: suspend (String) -> Long,
    private val clearPlayAuthentication: suspend () -> Unit = {},
) {
    private val installMutex = Mutex()
    private var lastReportedInstallOutcome: Pair<Int, LightPackageInstallOutcome>? = null

    val canRequestPackageInstalls: Boolean
        get() = installer.canRequestPackageInstalls

    fun openInstallAccessSettings(): Boolean = installer.openInstallAccessSettings()

    suspend fun load(): BorealisSnapshot {
        val library = readLibrary(store.loadLibrary(), checkUpdates = false)
        val pending = store.loadPendingInstall()
        return BorealisSnapshot(
            session = store.loadSession(),
            pendingPairing = store.loadPending(),
            library = library,
            pendingInstall = pending,
            installProgress = pending?.let { pendingProgress(it, library) },
            revision = store.lastRevision(),
        )
    }

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
        val library = sync.library.distinctBy(LibraryApp::packageName)
        require(library.all { validPackageName(it.packageName) && it.displayName.isNotBlank() && it.displayName.length <= 120 }) {
            "The companion returned an invalid library."
        }
        store.saveLibrary(library)
        store.saveRevision(sync.revision)
        val pending = store.loadPendingInstall()
        val appStates = readLibrary(library, checkUpdates = pending == null)
        BorealisSnapshot(
            session = session,
            library = appStates,
            pendingInstall = pending,
            installProgress = pending?.let { pendingProgress(it, appStates) },
            revision = sync.revision,
        )
    }

    suspend fun installLibraryApp(
        packageName: String,
        onProgress: (InstallProgress) -> Unit = {},
    ): Result<ProcessingResult> = repositoryRunCatching {
        installMutex.withLock {
            require(store.loadPendingInstall() == null) { "Another install is still in progress." }
            processLibraryApp(packageName, onProgress)
        }
    }

    suspend fun syncAndUpdate(): Result<ProcessingResult> = repositoryRunCatching {
        installMutex.withLock {
            reconcilePendingInstallInternal()?.let { return@withLock it }
            val snapshot = sync().getOrThrow()
            val update = snapshot.library.firstOrNull { it.status == LibraryAppStatus.UpdateAvailable }
            if (update != null) {
                processLibraryApp(update.app.packageName)
            } else {
                ProcessingResult(
                    message = if (snapshot.library.any { it.status == LibraryAppStatus.UpdateStatusUnknown }) {
                        "Library synced. Some update checks are unavailable."
                    } else {
                        "Library synced. No updates are available."
                    },
                    changed = false,
                )
            }
        }
    }

    suspend fun reconcilePendingInstall(): ProcessingResult? = installMutex.withLock {
        reconcilePendingInstallInternal()
    }

    private suspend fun reconcilePendingInstallInternal(): ProcessingResult? {
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
        if (lastReportedInstallOutcome != (pending.sessionId to result.outcome)) {
            report(
                session = session,
                jobId = pending.jobId,
                request = JobReportRequest(
                    status = status.wireValue,
                    installedVersionCode = if (status == BorealisJobStatus.Succeeded) pending.versionCode else null,
                    message = result.message,
                ),
            )
            lastReportedInstallOutcome = pending.sessionId to result.outcome
        }
        if (terminal) {
            installer.clearResult(pending.sessionId)
            downloader.delete(pending.jobId)
            store.clearPendingInstall()
            lastReportedInstallOutcome = null
        }
        return ProcessingResult(message, changed = terminal)
    }

    suspend fun forget() {
        clearPlayAuthentication()
        store.clearPendingInstall()
        store.forget()
    }

    private suspend fun processLibraryApp(
        packageName: String,
        onProgress: (InstallProgress) -> Unit = {},
    ): ProcessingResult {
        val session = store.loadSession() ?: error("Pair Borealis with the companion first.")
        val envelope = BorealisApi(session.instanceUrl).use { api ->
            api.requestLibraryJob(session.deviceBearer, packageName).getOrThrow()
        }
        val job = verifier.verify(session, envelope)
        require(job.packageName == packageName) { "The companion returned a job for another app." }
        report(
            session,
            job.jobId,
            JobReportRequest(status = BorealisJobStatus.Installing.wireValue),
        )
        return when (val result = coordinator.prepareAndSubmit(job, onProgress)) {
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
                reconcilePendingInstallInternal()
                    ?: ProcessingResult("${job.displayName} was handed to Android.", true)
            }
        }
    }

    private suspend fun readLibrary(library: List<LibraryApp>, checkUpdates: Boolean): List<LibraryAppState> =
        library.map { app ->
            val installed = installer.installedPackage(app.packageName)
            val available = if (checkUpdates && installed != null) {
                try {
                    latestVersionCode(app.packageName).takeIf { it > 0L }
                } catch (error: CancellationException) {
                    throw error
                } catch (_: Exception) {
                    // Do not label an unverified/offline version as current or expose upstream auth details.
                    null
                }
            } else null
            LibraryAppState(app, installed?.versionCode, available)
        }

    private fun pendingProgress(pending: PendingInstall, library: List<LibraryAppState>): InstallProgress =
        InstallProgress(
            displayName = library.firstOrNull { it.app.packageName == pending.packageName }?.app?.displayName
                ?: pending.packageName,
            stage = when (installer.result(pending.sessionId)?.outcome) {
                LightPackageInstallOutcome.AwaitingUserAction -> InstallStage.AwaitingConfirmation
                LightPackageInstallOutcome.Installed,
                LightPackageInstallOutcome.Failed,
                LightPackageInstallOutcome.Cancelled -> InstallStage.ReportingResult
                null -> InstallStage.Installing
            },
        )

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
