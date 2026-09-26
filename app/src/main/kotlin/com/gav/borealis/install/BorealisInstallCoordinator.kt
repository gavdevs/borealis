package com.gav.borealis.install

import com.gav.borealis.data.SignedInstallJob
import com.gav.borealis.delivery.ExpiredDeliveryUrlException
import com.gav.borealis.delivery.GPlayDeliveryClient
import com.gav.borealis.delivery.PlayArtifactDownloader
import com.gav.borealis.delivery.PlayDelivery
import com.thelightphone.sdk.install.LightPackageInstallRequest
import com.thelightphone.sdk.install.LightPackageInstallSession
import com.thelightphone.sdk.install.LightPackageInstaller

sealed interface InstallPreparationResult {
    data class Submitted(
        val session: LightPackageInstallSession,
        val versionCode: Long,
    ) : InstallPreparationResult

    data class AlreadyCurrent(val versionCode: Long) : InstallPreparationResult
    data class NeedsSignerReview(val signerSha256: List<String>) : InstallPreparationResult
    data class Failed(val message: String) : InstallPreparationResult
}

class BorealisInstallCoordinator(
    private val play: GPlayDeliveryClient,
    private val downloader: PlayArtifactDownloader,
    private val installer: LightPackageInstaller,
) {
    suspend fun prepareAndSubmit(job: SignedInstallJob): InstallPreparationResult {
        return runCatching {
            require(installer.canRequestPackageInstalls) {
                "Allow Borealis to install unknown apps in system settings first."
            }
            val installed = installer.installedPackage(job.packageName)
            val installedSigner = installed?.signerSha256?.lastOrNull()
            val delivery = resolveAndDownload(job, installedSigner)

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

            val identity = installer.inspectBaseApk(delivery.second.base.relativePath)
                ?: error("Android could not inspect the downloaded base APK.")
            require(identity.packageName == job.packageName) {
                "The downloaded APK belongs to a different package."
            }
            require(identity.versionCode == delivery.first.app.versionCode) {
                "The downloaded APK version does not match Google Play metadata."
            }

            val observedSigners = identity.signerSha256.map(String::lowercase).distinct()
            require(observedSigners.isNotEmpty()) { "The downloaded APK did not expose a signing certificate." }
            if (job.acceptedSignerSha256.isEmpty()) {
                downloader.delete(job.jobId)
                return InstallPreparationResult.NeedsSignerReview(observedSigners)
            }
            require(observedSigners.any(job.acceptedSignerSha256.toSet()::contains)) {
                "The downloaded APK signer is not approved by the companion."
            }

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
            InstallPreparationResult.Failed(error.message ?: "The install could not be prepared.")
        }
    }

    private suspend fun resolveAndDownload(
        job: SignedInstallJob,
        installedSigner: String?,
    ): Pair<PlayDelivery, com.gav.borealis.delivery.DownloadedPlayArtifacts> {
        var lastExpiry: ExpiredDeliveryUrlException? = null
        repeat(2) { attempt ->
            val delivery = play.resolve(job.packageName, installedSigner)
            try {
                return delivery to downloader.download(job.jobId, delivery.apkFiles)
            } catch (error: ExpiredDeliveryUrlException) {
                lastExpiry = error
                downloader.delete(job.jobId)
                if (attempt == 0) play.invalidateSession()
            }
        }
        throw lastExpiry ?: IllegalStateException("Google Play delivery expired.")
    }
}
