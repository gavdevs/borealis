package com.gav.borealis.delivery

import com.aurora.gplayapi.data.models.App
import com.aurora.gplayapi.data.models.AuthData
import com.aurora.gplayapi.data.models.PlayFile
import com.aurora.gplayapi.helpers.AppDetailsHelper
import com.aurora.gplayapi.helpers.AuthHelper
import com.aurora.gplayapi.helpers.PurchaseHelper
import java.io.ByteArrayInputStream
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URI
import java.nio.charset.StandardCharsets
import java.util.Base64
import java.util.Locale
import java.util.Properties
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

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
        val app = AppDetailsHelper(auth).getAppByPackageName(packageName)
        require(app.packageName == packageName && app.versionCode > 0L) {
            "Google Play returned invalid package details."
        }

        val helper = PurchaseHelper(auth)
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

class AuroraDispenserAuthProvider(
    dispenserUrl: String,
    private val userAgent: String = "com.gav.borealis-0.1.0-1",
) : PlayAuthProvider {
    private val url = normalizeDispenserUrl(dispenserUrl)
    private val json = Json { ignoreUnknownKeys = true }

    override suspend fun authenticate(properties: Properties, locale: Locale): AuthData =
        withContext(Dispatchers.IO) {
            val requestBody = json.encodeToString(
                properties.stringPropertyNames().associateWith(properties::getProperty),
            )
            val connection = URI(url).toURL().openConnection() as HttpURLConnection
            connection.connectTimeout = 15_000
            connection.readTimeout = 30_000
            connection.requestMethod = "POST"
            connection.doOutput = true
            connection.instanceFollowRedirects = false
            connection.setRequestProperty("Content-Type", "application/json")
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("User-Agent", userAgent)
            try {
                OutputStreamWriter(connection.outputStream, StandardCharsets.UTF_8).use {
                    it.write(requestBody)
                }
                val status = connection.responseCode
                if (status !in 200..299) {
                    val message = when (status) {
                        429 -> "The anonymous login service is rate limited. Try again later."
                        503 -> "The anonymous login service is under maintenance."
                        else -> "Anonymous login failed (HTTP $status)."
                    }
                    throw IllegalStateException(message)
                }
                val response = connection.inputStream.bufferedReader(StandardCharsets.UTF_8).use { it.readText() }
                val credentials = json.decodeFromString<DispenserCredentials>(response)
                require(credentials.email.isNotBlank() && credentials.authToken.isNotBlank()) {
                    "The anonymous login service returned incomplete credentials."
                }
                AuthHelper.build(
                    email = credentials.email,
                    token = credentials.authToken,
                    tokenType = AuthHelper.Token.AUTH,
                    isAnonymous = true,
                    properties = properties,
                    locale = locale,
                )
            } finally {
                connection.disconnect()
            }
        }

    private fun normalizeDispenserUrl(value: String): String {
        val uri = runCatching { URI(value.trim()) }
            .getOrElse { throw IllegalArgumentException("Invalid anonymous login service URL.") }
        require(uri.scheme == "https" && !uri.host.isNullOrBlank()) {
            "The anonymous login service must use HTTPS."
        }
        require(uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null) {
            "The anonymous login service URL cannot contain credentials, a query, or a fragment."
        }
        return uri.toString().trimEnd('/')
    }
}

@Serializable
private data class DispenserCredentials(
    val email: String,
    @SerialName("authToken") val authToken: String,
)
