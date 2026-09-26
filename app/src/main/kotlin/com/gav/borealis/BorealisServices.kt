package com.gav.borealis

import com.gav.borealis.data.BorealisRepository
import com.gav.borealis.data.BorealisStore
import com.gav.borealis.delivery.AuroraDispenserAuthProvider
import com.gav.borealis.delivery.GPlayDeliveryClient
import com.gav.borealis.delivery.PlayArtifactDownloader
import com.gav.borealis.install.BorealisInstallCoordinator
import com.gav.borealis.security.SignedJobVerifier
import com.thelightphone.sdk.SealedLightContext

class BorealisServices private constructor(
    val repository: BorealisRepository,
) {
    companion object {
        @Volatile
        private var instance: BorealisServices? = null

        fun from(context: SealedLightContext): BorealisServices =
            instance ?: synchronized(this) {
                instance ?: run {
                    val store = BorealisStore(context.dataStore)
                    val downloader = PlayArtifactDownloader(context.filesDir)
                    val play = GPlayDeliveryClient(
                        profileBytes = context.readAsset("gplayapi_px_9a.properties"),
                        authProvider = AuroraDispenserAuthProvider(BuildConfig.BOREALIS_DISPENSER_URL),
                    )
                    val coordinator = BorealisInstallCoordinator(
                        play = play,
                        downloader = downloader,
                        installer = context.packageInstaller,
                    )
                    BorealisServices(
                        repository = BorealisRepository(
                            store = store,
                            installer = context.packageInstaller,
                            coordinator = coordinator,
                            downloader = downloader,
                            verifier = SignedJobVerifier(),
                        ),
                    ).also { instance = it }
                }
            }
    }
}
