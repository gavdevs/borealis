package com.gav.borealis

import com.gav.borealis.data.BorealisRepository
import com.gav.borealis.data.BorealisStore
import com.gav.borealis.delivery.GPlayDeliveryClient
import com.gav.borealis.delivery.PersonalPlayAuthProvider
import com.gav.borealis.delivery.PersonalPlayCredential
import com.gav.borealis.delivery.PersonalPlayHttpClient
import com.gav.borealis.delivery.PlayCredentialStore
import com.gav.borealis.delivery.PlayArtifactDownloader
import com.gav.borealis.install.BorealisInstallCoordinator
import com.gav.borealis.security.SignedJobVerifier
import com.thelightphone.sdk.SealedLightContext
import com.thelightphone.sdk.auth.GooglePlayDiagnostics
import com.thelightphone.sdk.auth.googlePlayCredentialStore
import java.io.ByteArrayInputStream
import java.util.Properties

class BorealisServices private constructor(
    val repository: BorealisRepository,
    private val play: GPlayDeliveryClient,
    private val google: PersonalPlayAuthProvider,
    private val profileBytes: ByteArray,
) {
    suspend fun isGoogleConnected(): Boolean = google.isConnected()

    suspend fun connectGoogle(email: String, oauthToken: String) {
        play.changeAuthentication {
            val properties = Properties().apply { ByteArrayInputStream(profileBytes).use(::load) }
            google.completeSignIn(email, oauthToken, properties)
        }
    }

    suspend fun disconnectGoogle() {
        play.changeAuthentication { google.disconnect() }
    }

    companion object {
        @Volatile
        private var instance: BorealisServices? = null

        fun from(context: SealedLightContext): BorealisServices =
            instance ?: synchronized(this) {
                instance ?: run {
                    val store = BorealisStore(context.dataStore)
                    val downloader = PlayArtifactDownloader(context.filesDir)
                    val protectedStore = context.googlePlayCredentialStore()
                    val google = PersonalPlayAuthProvider(
                        store = object : PlayCredentialStore {
                            override suspend fun read(): PersonalPlayCredential? =
                                protectedStore.get()?.let { PersonalPlayCredential(it.email, it.token) }

                            override suspend fun write(credential: PersonalPlayCredential) =
                                protectedStore.put(credential.email, credential.token)

                            override suspend fun clear() = protectedStore.clear()
                        },
                        diagnostics = GooglePlayDiagnostics::record,
                    )
                    val profileBytes = context.readAsset("gplayapi_px_9a.properties")
                    val play = GPlayDeliveryClient(
                        profileBytes = profileBytes,
                        authProvider = google,
                        httpClient = PersonalPlayHttpClient(),
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
                            latestVersionCode = play::latestVersionCode,
                            clearPlayAuthentication = { play.changeAuthentication { google.disconnect() } },
                        ),
                        play = play,
                        google = google,
                        profileBytes = profileBytes,
                    ).also { instance = it }
                }
            }
    }
}
