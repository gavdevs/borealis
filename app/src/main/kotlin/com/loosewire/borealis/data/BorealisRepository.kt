package com.loosewire.borealis.data

import android.os.SystemClock
import com.loosewire.borealis.delivery.PlayArtifactDownloader
import com.loosewire.borealis.install.BorealisInstallCoordinator
import com.loosewire.borealis.install.InstallPreparationResult
import com.loosewire.borealis.install.InstallProgress
import com.loosewire.borealis.install.InstallStage
import com.loosewire.borealis.install.PendingInstallState
import com.loosewire.borealis.install.UninstallProgress
import com.loosewire.borealis.install.UninstallStage
import com.loosewire.borealis.install.isLive
import com.loosewire.borealis.install.pendingInstallState
import com.loosewire.borealis.install.supersededByRetry
import com.loosewire.borealis.security.SignedJobVerifier
import com.thelightphone.sdk.install.LightPackageInstallResult
import com.thelightphone.sdk.install.LightPackageUninstallOutcome
import com.thelightphone.sdk.install.LightPackageInstaller
import java.util.concurrent.ConcurrentHashMap
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

    /**
     * When this process committed each Android session. The SDK's pending-user-action
     * intent is single-shot and cannot be re-sent to a later process, so only these
     * timestamps can prove a confirmation is still waiting on the user.
     */
    private val committedSessions = ConcurrentHashMap<Int, Long>()
    private var lastReportedInstallOutcome: Pair<Int, PendingInstallState>? = null

    /** Elapsed realtime is monotonic, so a wall-clock change cannot revive a session. */
    private val elapsedRealtime: () -> Long = SystemClock::elapsedRealtime

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
    ): Result<PendingPairingSession> = traced(ProblemReportStage.PAIRING) {
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

    suspend fun activatePairing(): Result<BorealisSession> = traced(ProblemReportStage.PAIRING) {
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

    suspend fun sync(): Result<BorealisSnapshot> = traced(ProblemReportStage.SYNC) {
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
    ): Result<ProcessingResult> = traced(ProblemReportStage.INSTALL) {
        installMutex.withLock {
            retirePendingInstallForRetry(packageName)?.let { return@withLock it }
            require(store.loadPendingInstall() == null) { "Android is still processing the previous install." }
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
    ): Result<ProcessingResult> = traced(ProblemReportStage.UNINSTALL) {
        installMutex.withLock {
            retirePendingInstallForRetry(packageName)
            require(store.loadPendingInstall() == null) { "Android is still processing the previous install." }
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
            val pendingResult = reconcilePendingInstallInternal()
            if (store.loadPendingInstall() != null) {
                // Android still owns this attempt; an unattended pass must not race it.
                // A user tap can replace it, but the 6-hour job cannot decide for them.
                return@withLock pendingResult
                    ?: ProcessingResult("Waiting for Android to finish an install.", false)
            }
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

    /**
     * Retires a persisted session a tap has to replace. Only a commit Android has not
     * answered yet blocks the tap: a pending confirmation cannot be re-opened, so the
     * tap must immediately start a new session instead of waiting for a prompt the user
     * may have already dismissed. The requested app's own completed install
     * short-circuits the attempt so it is reported instead of downloaded again.
     */
    private suspend fun retirePendingInstallForRetry(packageName: String): ProcessingResult? {
        val pending = store.loadPendingInstall() ?: return null
        val result = pendingResultFor(pending)
        val state = pendingInstallStateFor(pending, result)
        require(state.supersededByRetry) { "Android is still finishing the previous install." }
        val retired = retirePendingInstall(pending, state, result)
        return retired.takeIf { state == PendingInstallState.Installed && pending.packageName == packageName }
    }

    /**
     * Resolves a persisted install session against Android's own package state.
     *
     * The SDK's result broadcast is not durable evidence. The confirmation intent it
     * carries is delivered once, a force-stopped app never receives the terminal
     * status, and results are stored with an asynchronous write. A confirmation is
     * reported as waiting rather than failed here, because the user can retry; but it is
     * only "live" while this process committed it, so a session inherited from an
     * earlier process is retired instead of blocking the library forever.
     */
    private suspend fun reconcilePendingInstallInternal(): ProcessingResult? {
        val pending = store.loadPendingInstall() ?: return null
        val result = pendingResultFor(pending)
        val state = pendingInstallStateFor(pending, result)
        if (!state.isLive) return retirePendingInstall(pending, state, result)
        if (state == PendingInstallState.AwaitingConfirmation) {
            reportOnce(
                pending = pending,
                state = state,
                request = JobReportRequest(
                    status = BorealisJobStatus.AwaitingUserAction.wireValue,
                    message = CONFIRM_IN_ANDROID,
                ),
            )
            return ProcessingResult(CONFIRM_IN_ANDROID, changed = false)
        }
        return ProcessingResult("Installation is still being processed by Android.", changed = false)
    }

    /**
     * Reports and forgets a session a new attempt replaces.
     *
     * The local row is always cleared: it is the only barrier to a fresh confirmation,
     * and a companion that already closed the job (or is unreachable) must never keep
     * the phone from retrying. A replacement install reuses any still-active job and
     * reports the real outcome, so a lost report heals on the next attempt.
     */
    private suspend fun retirePendingInstall(
        pending: PendingInstall,
        state: PendingInstallState,
        result: LightPackageInstallResult?,
    ): ProcessingResult {
        check(state.supersededByRetry) { "A committing install session must not be retired." }
        val deliveredVersionCode = if (state == PendingInstallState.Installed) {
            installer.installedPackage(pending.packageName)?.versionCode ?: pending.versionCode
        } else null
        val (status, message) = when (state) {
            PendingInstallState.Installed ->
                BorealisJobStatus.Succeeded to "${pending.packageName} is installed."
            PendingInstallState.Cancelled ->
                BorealisJobStatus.Cancelled to (result?.message ?: "Installation was cancelled.")
            PendingInstallState.Failed ->
                BorealisJobStatus.Failed to (result?.message ?: "Android could not install the app.")
            PendingInstallState.Orphaned ->
                BorealisJobStatus.Cancelled to INTERRUPTED_INSTALL
            // The user asked again while Android waited: the earlier confirmation is
            // abandoned, and the replacement install reports the real outcome.
            PendingInstallState.AwaitingConfirmation ->
                BorealisJobStatus.Cancelled to SUPERSEDED_INSTALL
            PendingInstallState.InProgress ->
                error("A committing install session cannot be retired.")
        }
        reportOnce(
            pending = pending,
            state = state,
            request = JobReportRequest(
                status = status.wireValue,
                installedVersionCode = deliveredVersionCode,
                message = message.takeIf { status != BorealisJobStatus.Succeeded },
            ),
        )
        installer.clearResult(pending.sessionId)
        downloader.delete(pending.jobId)
        store.clearPendingInstall()
        committedSessions.remove(pending.sessionId)
        lastReportedInstallOutcome = null
        return ProcessingResult(message, changed = true)
    }

    /** The companion is a status log, not install authority: never block on its failure. */
    private suspend fun reportOnce(
        pending: PendingInstall,
        state: PendingInstallState,
        request: JobReportRequest,
    ) {
        if (lastReportedInstallOutcome == (pending.sessionId to state)) return
        val session = store.loadSession() ?: return
        try {
            report(session = session, jobId = pending.jobId, request = request)
            lastReportedInstallOutcome = pending.sessionId to state
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            // The pending row is cleared regardless; a later attempt reports the truth.
        }
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
        committedSessions.clear()
        lastReportedInstallOutcome = null
        store.clearPendingInstall()
        store.clearPendingUninstall()
        store.forget()
    }

    /**
     * Sends a user-authored problem report for the paired device. The body is
     * normalized again here so no caller can ship credentials, account
     * identifiers, or unallowlisted diagnostics.
     */
    suspend fun submitProblemReport(
        title: String,
        description: String,
        diagnostics: String?,
    ): Result<ProblemReportResponse> = traced(ProblemReportStage.REPORT) {
        val session = store.loadSession() ?: error("Pair Borealis with the companion first.")
        problemReportValidationError(title, description)?.let { throw IllegalArgumentException(it) }
        val request = problemReportRequest(title, description, diagnostics)
        BorealisApi(session.instanceUrl).use { api ->
            val response = api.submitProblemReport(session.deviceBearer, request).getOrThrow()
            require(response.ok) { "The companion did not accept the report." }
            response
        }
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
                // Record liveness before persisting: Android's confirmation is started
                // from the SDK's broadcast receiver, and only this process can observe
                // the session as still waiting on the user.
                committedSessions[result.session.id] = elapsedRealtime()
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

    private suspend fun readLibrary(library: List<LibraryApp>, checkUpdates: Boolean): List<LibraryAppState> {
        var checked = false
        var unavailable = false
        val states = library.map { app ->
            val installed = installer.installedPackage(app.packageName)
            val available = if (checkUpdates && installed != null) {
                checked = true
                try {
                    latestVersionCode(app.packageName).takeIf { it > 0L }
                } catch (error: CancellationException) {
                    throw error
                } catch (_: Exception) {
                    // Do not label an unverified/offline version as current or expose upstream auth details.
                    unavailable = true
                    null
                }
            } else null
            LibraryAppState(app, installed?.versionCode, available)
        }
        // One aggregate event per sync: Play update checks are background work, not a
        // per-app log, and the report ring buffer must stay meaningful.
        if (checked) {
            ProblemReportLog.record(
                ProblemReportStage.GOOGLE_PLAY,
                if (unavailable) ProblemReportOutcome.UNAVAILABLE else ProblemReportOutcome.SUCCEEDED,
            )
        }
        return states
    }

    private fun pendingProgress(pending: PendingInstall, library: List<LibraryAppState>): InstallProgress =
        InstallProgress(
            displayName = library.firstOrNull { it.app.packageName == pending.packageName }?.app?.displayName
                ?: pending.packageName,
            stage = when (pendingInstallStateFor(pending, pendingResultFor(pending))) {
                PendingInstallState.AwaitingConfirmation -> InstallStage.AwaitingConfirmation
                PendingInstallState.InProgress -> InstallStage.Installing
                PendingInstallState.Orphaned -> InstallStage.Interrupted
                PendingInstallState.Installed,
                PendingInstallState.Cancelled,
                PendingInstallState.Failed -> InstallStage.ReportingResult
            },
        )

    /** The SDK's result store is keyed by session id, which Android may recycle. */
    private fun pendingResultFor(pending: PendingInstall): LightPackageInstallResult? =
        installer.result(pending.sessionId)
            ?.takeIf { it.packageName == null || it.packageName == pending.packageName }

    private fun pendingInstallStateFor(
        pending: PendingInstall,
        result: LightPackageInstallResult?,
    ): PendingInstallState =
        pendingInstallState(
            pendingVersionCode = pending.versionCode,
            result = result,
            installedVersionCode = installer.installedPackage(pending.packageName)?.versionCode,
            committedAgoMillis = committedSessions[pending.sessionId]
                ?.let { committedAt -> elapsedRealtime() - committedAt },
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

private const val CONFIRM_IN_ANDROID = "Confirm the install in Android."
private const val INTERRUPTED_INSTALL =
    "Android never confirmed this install. Tap install again to start a new confirmation."
private const val SUPERSEDED_INSTALL = "Restarting the Android confirmation."

/**
 * Runs a repository operation and records one structured event for reports.
 * Only the stage, the outcome, and a clamped HTTP status are kept; error text,
 * package names, URLs, and tokens never reach [ProblemReportLog].
 */
private suspend fun <T> traced(
    stage: ProblemReportStage,
    block: suspend () -> T,
): Result<T> {
    ProblemReportLog.record(stage, ProblemReportOutcome.STARTED)
    return try {
        Result.success(block()).also {
            ProblemReportLog.record(stage, ProblemReportOutcome.SUCCEEDED)
        }
    } catch (error: CancellationException) {
        ProblemReportLog.record(stage, ProblemReportOutcome.CANCELLED)
        throw error
    } catch (error: Exception) {
        ProblemReportLog.record(stage, ProblemReportOutcome.FAILED, (error as? BorealisApiException)?.httpStatus)
        Result.failure(error)
    }
}

private suspend fun <T> repositoryRunCatching(block: suspend () -> T): Result<T> = try {
    Result.success(block())
} catch (error: CancellationException) {
    throw error
} catch (error: Exception) {
    Result.failure(error)
}
