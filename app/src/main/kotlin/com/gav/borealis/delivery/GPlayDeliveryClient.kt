package com.gav.borealis.delivery

import com.aurora.gplayapi.data.models.App
import com.aurora.gplayapi.data.models.AuthData
import com.aurora.gplayapi.data.models.PlayFile
import com.aurora.gplayapi.helpers.AppDetailsHelper
import com.aurora.gplayapi.helpers.PurchaseHelper
import com.aurora.gplayapi.network.IHttpClient
import java.io.ByteArrayInputStream
import java.util.Base64
import java.util.Locale
import java.util.Properties
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

data class PlayLibraryDelivery(
    val app: App,
    val files: List<PlayFile>,
)

data class PlayDelivery(
    val app: App,
    val apkFiles: List<PlayFile>,
    val expansionFiles: List<PlayFile>,
    val libraries: List<PlayLibraryDelivery>,
)

class GPlayDeliveryClient(
    profileBytes: ByteArray,
    private val authProvider: PlayAuthProvider,
    private val httpClient: IHttpClient,
    private val locale: Locale = Locale.getDefault(),
) {
    private val profile = Properties().apply {
        ByteArrayInputStream(profileBytes).use(::load)
    }
    private val authMutex = Mutex()
    @Volatile
    private var authData: AuthData? = null

    suspend fun resolve(
        packageName: String,
        installedSignerSha256: String? = null,
    ): PlayDelivery = withContext(Dispatchers.IO) {
        require(PACKAGE_NAME.matches(packageName)) { "Invalid Play package name." }
        val auth = authenticate()
        val app = AppDetailsHelper(auth).using(httpClient).getAppByPackageName(packageName)
        require(app.packageName == packageName && app.versionCode > 0L) {
            "Google Play returned invalid package details."
        }

        val helper = PurchaseHelper(auth).using(httpClient)
        val libraries = app.dependencies.dependentLibraries.map { library ->
            require(library.packageName.isNotBlank() && library.versionCode > 0L) {
                "Google Play returned an invalid shared-library dependency."
            }
            PlayLibraryDelivery(
                app = library,
                files = helper.purchase(
                    packageName = library.packageName,
                    versionCode = library.versionCode,
                    offerType = library.offerType,
                ),
            )
        }
        val files = helper.purchase(
            packageName = app.packageName,
            versionCode = app.versionCode,
            offerType = app.offerType,
            certificateHash = installedSignerSha256?.let(::hexSha256ToBase64Url),
        )

        PlayDelivery(
            app = app,
            apkFiles = files.filter { it.type == PlayFile.Type.BASE || it.type == PlayFile.Type.SPLIT },
            expansionFiles = files.filter { it.type == PlayFile.Type.OBB || it.type == PlayFile.Type.PATCH },
            libraries = libraries,
        )
    }

    suspend fun invalidateSession() {
        authMutex.withLock { authData = null }
    }

    suspend fun changeAuthentication(block: suspend () -> Unit) {
        authMutex.withLock {
            authData = null
            block()
        }
    }

    private suspend fun authenticate(): AuthData = authMutex.withLock {
        authData ?: withContext(Dispatchers.IO) {
            authProvider.authenticate(profile, locale).also { authData = it }
        }
    }

    internal fun hexSha256ToBase64Url(value: String): String {
        require(SHA256.matches(value)) { "Invalid signer SHA-256." }
        val bytes = ByteArray(value.length / 2) { index ->
            value.substring(index * 2, index * 2 + 2).toInt(16).toByte()
        }
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }

    private companion object {
        val PACKAGE_NAME = Regex("^[a-zA-Z][a-zA-Z0-9_]*(\\.[a-zA-Z][a-zA-Z0-9_]*)+$")
        val SHA256 = Regex("^[0-9a-f]{64}$")
    }
}

fun interface PlayAuthProvider {
    suspend fun authenticate(properties: Properties, locale: Locale): AuthData
}
