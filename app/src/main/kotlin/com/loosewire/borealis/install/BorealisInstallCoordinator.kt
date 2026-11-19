package com.loosewire.borealis.install

import com.loosewire.borealis.data.SignedInstallJob
import com.loosewire.borealis.delivery.ExpiredDeliveryUrlException
import com.loosewire.borealis.delivery.ArtifactDownloadProgress
import com.loosewire.borealis.delivery.GPlayDeliveryClient
import com.loosewire.borealis.delivery.PlayArtifactDownloader
import com.loosewire.borealis.delivery.PlayDelivery
import com.thelightphone.sdk.install.LightPackageInstallOutcome
import com.thelightphone.sdk.install.LightPackageInstallRequest
import com.thelightphone.sdk.install.LightPackageInstallResult
import com.thelightphone.sdk.install.LightPackageInstallSession
import com.thelightphone.sdk.install.LightPackageInstaller
import com.thelightphone.sdk.install.LightPackageIdentity
import kotlinx.coroutines.CancellationException

enum class InstallStage {
    Resolving,
    Downloading,
    Verifying,
    Installing,
    AwaitingConfirmation,

    /** Android was handed the session, but Borealis can no longer finish it. */
    Interrupted,
    ReportingResult,
}

data class InstallProgress(
    val displayName: String,
    val stage: InstallStage,
    val download: ArtifactDownloadProgress? = null,
)

enum class UninstallStage {
    Starting,
    AwaitingConfirmation,
    ReportingResult,
}

data class UninstallProgress(
    val displayName: String,
    val stage: UninstallStage,
)

sealed interface InstallPreparationResult {
    data class Submitted(
        val session: LightPackageInstallSession,
        val versionCode: Long,
    ) : InstallPreparationResult

    data class AlreadyCurrent(val versionCode: Long) : InstallPreparationResult
    data class Failed(val message: String) : InstallPreparationResult
}

/** What a persisted install session means now that Android has had time to act on it. */
enum class PendingInstallState {
    /** Android has the delivered version, whatever the stored result says. */
    Installed,
    Cancelled,
    Failed,

    /** This process committed the session and Android is still asking for confirmation. */
    AwaitingConfirmation,

    /** Committed by this process, and no result has arrived yet. */
    InProgress,

    /**
     * Android can never finish this session for us: the confirmation intent is delivered
     * once, inside the pending-user-action broadcast, and the process that committed the
     * session is gone. Only a new install attempt can make progress.
     */
    Orphaned,
}

/**
 * True while Android may still complete the session without the user starting over.
 * Only a session this process committed qualifies: the SDK's confirmation intent is
 * single-shot, so a session inherited from an earlier process can never be resumed.
 * Reconciliation keeps waiting while this holds.
 */
val PendingInstallState.isLive: Boolean
    get() = this == PendingInstallState.AwaitingConfirmation || this == PendingInstallState.InProgress

/**
 * True when an install tap may replace this session at once.
 *
 * A confirmation on screen is not progress the user has to wait out: Android cannot
 * re-open it for us, so tapping Install/Update again is the only way to get a usable
 * confirmation and must start one immediately, in this process or after a restart.
 * Only [PendingInstallState.InProgress] is excluded, where the commit has not produced
 * a result yet and a second session would race Android.
 */
val PendingInstallState.supersededByRetry: Boolean
    get() = this != PendingInstallState.InProgress

/**
 * True while a tap must not start a second session: downloads and the commit itself.
 * A pending Android confirmation, [InstallStage.Interrupted], and
 * [InstallStage.ReportingResult] all leave the library actionable so the user can ask
 * for a fresh confirmation instead of waiting out a prompt Android will not re-show.
 */
val InstallProgress.blocksInstall: Boolean
    get() = when (stage) {
        InstallStage.Resolving,
        InstallStage.Downloading,
        InstallStage.Verifying,
        InstallStage.Installing -> true
        InstallStage.AwaitingConfirmation,
        InstallStage.Interrupted,
        InstallStage.ReportingResult -> false
    }

class BorealisInstallCoordinator(
    private val play: GPlayDeliveryClient,
    private val downloader: PlayArtifactDownloader,
    private val installer: LightPackageInstaller,
) {
    suspend fun prepareAndSubmit(
        job: SignedInstallJob,
        onProgress: (InstallProgress) -> Unit = {},
    ): InstallPreparationResult {
        return runCatching {
            require(installer.canRequestPackageInstalls) {
                "Allow Borealis to install unknown apps in system settings first."
            }
            val installed = installer.installedPackage(job.packageName)
            // The SDK exposes sorted signing history, not a current-signer marker.
            // Only send a certificate hint when that identity is unambiguous.
            val installedSigner = installed?.signerSha256?.singleOrNull()
            onProgress(InstallProgress(job.displayName, InstallStage.Resolving))
            val delivery = resolveAndDownload(job, installedSigner, onProgress)

            if (installed != null && installed.versionCode >= delivery.first.app.versionCode) {
                downloader.delete(job.jobId)
                return InstallPreparationResult.AlreadyCurrent(installed.versionCode)
            }
            require(delivery.first.libraries.isEmpty()) {
                "This app requires a separately installed shared library, which Borealis does not support yet."
            }
            require(delivery.first.expansionFiles.isEmpty()) {
                "This app requires expansion files, which Borealis does not support yet."
            }

            onProgress(InstallProgress(job.displayName, InstallStage.Verifying))
            val identity = installer.inspectBaseApk(delivery.second.base.relativePath)
                ?: error("Android could not inspect the downloaded base APK.")
            validateDeliveredIdentity(job.packageName, delivery.first.app.versionCode, identity, installed)

            onProgress(InstallProgress(job.displayName, InstallStage.Installing))
            val session = installer.install(
                LightPackageInstallRequest(
                    packageName = job.packageName,
                    baseApk = delivery.second.base,
                    splitApks = delivery.second.splits,
                    preferUnattendedUpdate = installed != null,
                ),
            )
            InstallPreparationResult.Submitted(session, identity.versionCode)
        }.getOrElse { error ->
            downloader.delete(job.jobId)
            if (error is CancellationException) throw error
            InstallPreparationResult.Failed(error.message ?: "The install could not be prepared.")
        }
    }

    private suspend fun resolveAndDownload(
        job: SignedInstallJob,
        installedSigner: String?,
        onProgress: (InstallProgress) -> Unit,
    ): Pair<PlayDelivery, com.loosewire.borealis.delivery.DownloadedPlayArtifacts> {
        var lastExpiry: ExpiredDeliveryUrlException? = null
        repeat(2) { attempt ->
            onProgress(InstallProgress(job.displayName, InstallStage.Resolving))
            val delivery = play.resolve(job.packageName, installedSigner)
            try {
                return delivery to downloader.download(job.jobId, delivery.apkFiles) { progress ->
                    onProgress(InstallProgress(job.displayName, InstallStage.Downloading, progress))
                }
            } catch (error: ExpiredDeliveryUrlException) {
                lastExpiry = error
                downloader.delete(job.jobId)
                if (attempt == 0) play.invalidateSession()
            }
        }
        throw lastExpiry ?: IllegalStateException("Google Play delivery expired.")
    }
}

/**
 * Resolves a persisted install session against the state Android actually reports.
 *
 * The SDK's result broadcast is the primary signal but not durable evidence: its
 * confirmation intent is single-shot, a force-stopped app never receives the terminal
 * status, and results are stored with an asynchronous write. Three things decide
 * whether Android may still finish the session:
 *
 * - the installed package, which is authoritative and completes an install even when
 *   the terminal broadcast was lost;
 * - [committedAgoMillis], present only while the process that committed the session is
 *   still alive, because the confirmation intent cannot be re-sent to a new process;
 * - [INSTALL_CONFIRMATION_WINDOW_MILLIS], after which an unanswered confirmation was
 *   dismissed, ignored, or abandoned rather than still on screen.
 *
 * Anything else is [PendingInstallState.Orphaned]. Both that state and a live
 * confirmation are immediately replaceable by an Install/Update tap
 * ([supersededByRetry]); the distinction only decides whether reconciliation keeps
 * waiting on Android or resolves the session here.
 */
internal fun pendingInstallState(
    pendingVersionCode: Long,
    result: LightPackageInstallResult?,
    installedVersionCode: Long?,
    committedAgoMillis: Long?,
): PendingInstallState {
    if (installedVersionCode != null && installedVersionCode >= pendingVersionCode) {
        return PendingInstallState.Installed
    }
    val stillAwaitingAndroid = committedAgoMillis != null &&
        committedAgoMillis in 0..INSTALL_CONFIRMATION_WINDOW_MILLIS
    return when (result?.outcome) {
        LightPackageInstallOutcome.Installed -> PendingInstallState.Installed
        LightPackageInstallOutcome.Cancelled -> PendingInstallState.Cancelled
        LightPackageInstallOutcome.Failed -> PendingInstallState.Failed
        LightPackageInstallOutcome.AwaitingUserAction ->
            if (stillAwaitingAndroid) PendingInstallState.AwaitingConfirmation else PendingInstallState.Orphaned
        null ->
            if (stillAwaitingAndroid) PendingInstallState.InProgress else PendingInstallState.Orphaned
    }
}

/** How long an Android install confirmation may stay unanswered before it is abandoned. */
internal const val INSTALL_CONFIRMATION_WINDOW_MILLIS = 10 * 60 * 1_000L

/** Play supplies first-install provenance; Android remains the authority on signed APK sets. */
internal fun validateDeliveredIdentity(
    packageName: String,
    versionCode: Long,
    downloaded: LightPackageIdentity,
    installed: LightPackageIdentity?,
) {
    require(downloaded.packageName == packageName) {
        "The downloaded APK belongs to a different package."
    }
    require(versionCode > 0L && downloaded.versionCode == versionCode) {
        "The downloaded APK version does not match Google Play metadata."
    }
    val observedSigners = downloaded.signerSha256.map(String::lowercase).toSet()
    require(observedSigners.isNotEmpty() && observedSigners.all(SIGNER_SHA256::matches)) {
        "The downloaded APK did not expose a valid signing certificate."
    }
    if (installed != null) {
        require(installed.packageName == packageName) { "The installed package identity does not match." }
        require(downloaded.versionCode > installed.versionCode) { "The downloaded update is not newer." }
        require(installed.signerSha256.any { it.lowercase() in observedSigners }) {
            "The update's signing certificate does not match the installed app."
        }
        // Shared history permits legitimate rotation. PackageInstaller checks the
        // cryptographic lineage/capabilities and every split, including multi-signer sets.
    }
}

private val SIGNER_SHA256 = Regex("^[0-9a-f]{64}$")
