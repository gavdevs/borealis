package com.loosewire.borealis.data

import com.loosewire.borealis.delivery.PlayArtifactDownloader
import com.loosewire.borealis.install.BorealisInstallCoordinator
import com.loosewire.borealis.install.InstallPreparationResult
import com.loosewire.borealis.install.InstallProgress
import com.loosewire.borealis.install.InstallStage
import com.loosewire.borealis.install.UninstallProgress
import com.loosewire.borealis.install.UninstallStage
import com.loosewire.borealis.security.SignedJobVerifier
import com.thelightphone.sdk.install.LightPackageInstallOutcome
import com.thelightphone.sdk.install.LightPackageUninstallOutcome
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
    val pendingUninstall: PendingUninstall? = null,
    val uninstallProgress: UninstallProgress? = null,
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
        val pendingUninstall = store.loadPendingUninstall()
        return BorealisSnapshot(
            session = store.loadSession(),
            pendingPairing = store.loadPending(),
            library = library,
            pendingInstall = pending,
            installProgress = pending?.let { pendingProgress(it, library) },
            pendingUninstall = pendingUninstall,
            uninstallProgress = pendingUninstall?.let { pendingUninstallProgress(it, library) },
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
        val pendingUninstall = store.loadPendingUninstall()
        val appStates = readLibrary(library, checkUpdates = pending == null)
        BorealisSnapshot(
            session = session,
            library = appStates,
            pendingInstall = pending,
            installProgress = pending?.let { pendingProgress(it, appStates) },
            pendingUninstall = pendingUninstall,
            uninstallProgress = pendingUninstall?.let { pendingUninstallProgress(it, appStates) },
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

    /**
     * Starts a PackageInstaller uninstall for a library app. Android shows its own
     * confirmation even when Borealis installed the app. Pending state persists
     * across process death; [reconcilePendingUninstall] resolves completion by
     * checking both the result broadcast and the package list.
     */
    suspend fun uninstallLibraryApp(
        packageName: String,
    ): Result<ProcessingResult> = repositoryRunCatching {
        installMutex.withLock {
            require(store.loadPendingInstall() == null) { "An install is still in progress." }
            require(store.loadPendingUninstall() == null) { "An uninstall is still in progress." }
            val library = store.loadLibrary()
            require(library.any { it.packageName == packageName }) {
                "The app is not in this library."
            }
            require(installer.installedPackage(packageName) != null) {
                "The app is not installed."
            }
            val session = installer.uninstall(packageName)
            store.savePendingUninstall(PendingUninstall(packageName, session.id))
            reconcilePendingUninstallInternal()
                ?: ProcessingResult("$packageName was handed to Android for uninstall.", true)
        }
    }

    suspend fun syncAndUpdate(): Result<ProcessingResult> = repositoryRunCatching {
        installMutex.withLock {
            reconcilePendingInstallInternal()?.let { return@withLock it }
            reconcilePendingUninstallInternal()?.let { return@withLock it }
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

    /**
     * Resolves a pending uninstall. PackageInstaller only guarantees the
     * pending-user-action broadcast, so success also relies on the package no
     * longer appearing in [LightPackageInstaller.installedPackage].
     */
    suspend fun reconcilePendingUninstall(): ProcessingResult? = installMutex.withLock {
        reconcilePendingUninstallInternal()
    }

    private suspend fun reconcilePendingUninstallInternal(): ProcessingResult? {
        val pending = store.loadPendingUninstall() ?: return null
        val result = installer.uninstallResult(pending.requestId)
        val stillInstalled = installer.installedPackage(pending.packageName) != null

        val (message, terminal) = when {
            !stillInstalled -> "Uninstalled ${pending.packageName}." to true
            result?.outcome == LightPackageUninstallOutcome.Cancelled ->
                (result.message ?: "Uninstall was cancelled.") to true
            result?.outcome == LightPackageUninstallOutcome.Failed ->
                (result.message ?: "Android could not uninstall the app.") to true
            result?.outcome == LightPackageUninstallOutcome.AwaitingUserAction ->
                "Confirm the uninstall in Android." to false
            else -> "Uninstall is still being processed by Android." to false
        }

        if (terminal) {
            installer.clearUninstallResult(pending.requestId)
            store.clearPendingUninstall()
        }
        return ProcessingResult(message, changed = terminal)
    }


    suspend fun forget() {
        clearPlayAuthentication()
        store.clearPendingInstall()
        store.clearPendingUninstall()
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

    private fun pendingUninstallProgress(pending: PendingUninstall, library: List<LibraryAppState>): UninstallProgress =
        UninstallProgress(
            displayName = library.firstOrNull { it.app.packageName == pending.packageName }?.app?.displayName
                ?: pending.packageName,
            stage = when (installer.uninstallResult(pending.requestId)?.outcome) {
                LightPackageUninstallOutcome.AwaitingUserAction -> UninstallStage.AwaitingConfirmation
                LightPackageUninstallOutcome.Uninstalled,
                LightPackageUninstallOutcome.Failed,
                LightPackageUninstallOutcome.Cancelled -> UninstallStage.ReportingResult
                null -> UninstallStage.Starting
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
