package com.gav.borealis.install

import com.gav.borealis.data.SignedInstallJob
import com.gav.borealis.delivery.ExpiredDeliveryUrlException
import com.gav.borealis.delivery.ArtifactDownloadProgress
import com.gav.borealis.delivery.GPlayDeliveryClient
import com.gav.borealis.delivery.PlayArtifactDownloader
import com.gav.borealis.delivery.PlayDelivery
import com.thelightphone.sdk.install.LightPackageInstallRequest
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
    ReportingResult,
}

data class InstallProgress(
    val displayName: String,
    val stage: InstallStage,
    val download: ArtifactDownloadProgress? = null,
)

sealed interface InstallPreparationResult {
    data class Submitted(
        val session: LightPackageInstallSession,
        val versionCode: Long,
    ) : InstallPreparationResult

    data class AlreadyCurrent(val versionCode: Long) : InstallPreparationResult
    data class Failed(val message: String) : InstallPreparationResult
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
    ): Pair<PlayDelivery, com.gav.borealis.delivery.DownloadedPlayArtifacts> {
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
