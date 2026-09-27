package com.gav.borealis.delivery

import com.aurora.gplayapi.GooglePlayApi
import com.aurora.gplayapi.data.models.AuthData
import com.aurora.gplayapi.data.models.PlayResponse
import com.aurora.gplayapi.data.providers.DeviceInfoProvider
import com.aurora.gplayapi.exceptions.GooglePlayException
import com.aurora.gplayapi.helpers.AuthHelper
import com.aurora.gplayapi.network.IHttpClient
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.net.URLEncoder
import java.util.Locale
import java.util.Properties
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/** The long-lived Play credential belongs in the phone's encrypted SDK store, never DataStore. */
class PersonalPlayCredential(val email: String, val token: String) {
    override fun toString(): String = "PersonalPlayCredential(redacted)"
}

interface PlayCredentialStore {
    suspend fun read(): PersonalPlayCredential?
    suspend fun write(credential: PersonalPlayCredential)
    suspend fun clear()
}

/** Carries only a safe, fixed message: do not attach upstream exceptions or response bodies. */
class PersonalPlayAuthException(message: String) : IllegalStateException(message)

/**
 * Experimental personal-account support using the same unofficial Android API as GPlayAPI.
 * This is not Google website OAuth. Only the native Google sign-in view supplies oauthToken.
 */
class PersonalPlayAuthProvider internal constructor(
    private val store: PlayCredentialStore,
    private val exchange: (String, String, Properties, Locale) -> PersonalPlayCredential,
    private val build: (PersonalPlayCredential, Properties, Locale) -> AuthData,
) : PlayAuthProvider {
    constructor(
        store: PlayCredentialStore,
        httpClient: IHttpClient = PersonalPlayHttpClient(),
    ) : this(
        store,
        { email, token, properties, locale ->
            exchangeGoogleSetupCredential(email, token, properties, locale, httpClient)
        },
        { credential, properties, locale ->
            AuthHelper.using(httpClient).build(
                email = credential.email,
                token = credential.token,
                tokenType = AuthHelper.Token.AAS,
                isAnonymous = false,
                properties = properties,
                locale = locale,
            )
        },
    )

    private val mutex = Mutex()

    override suspend fun authenticate(properties: Properties, locale: Locale): AuthData =
        withContext(Dispatchers.IO) {
            mutex.withLock {
                safePlayAuth {
                    val credential = store.read()
                        ?: throw PersonalPlayAuthException("Connect Google Play on this phone first.")
                    validateCredential(credential)
                    validateSession(build(credential, properties, locale), credential)
                }
            }
        }

    /** Commit only after Google returns a usable personal Play session. Failed replacement is safe. */
    suspend fun completeSignIn(
        email: String,
        oauthToken: String,
        properties: Properties,
        locale: Locale = Locale.getDefault(),
    ): AuthData = withContext(Dispatchers.IO) {
        mutex.withLock {
            safePlayAuth {
                val normalizedEmail = email.trim()
                validateCredential(PersonalPlayCredential(normalizedEmail, oauthToken))
                val credential = exchange(normalizedEmail, oauthToken, properties, locale)
                validateCredential(credential)
                val session = validateSession(build(credential, properties, locale), credential)
                currentCoroutineContext().ensureActive()
                store.write(credential)
                session
            }
        }
    }

    suspend fun isConnected(): Boolean = mutex.withLock {
        safePlayAuth {
            val credential = store.read() ?: return@safePlayAuth false
            validateCredential(credential)
            true
        }
    }

    /** Caller must also invalidate GPlayDeliveryClient's cached session and close the sign-in view. */
    suspend fun disconnect() = mutex.withLock { safePlayAuth { store.clear() } }
}

private fun validateSession(session: AuthData, credential: PersonalPlayCredential): AuthData {
    if (session.isAnonymous || session.email != credential.email || session.authToken.isBlank() ||
        session.deviceConfigToken.isBlank()
    ) {
        throw PersonalPlayAuthException("Google Play did not return a usable personal session. Try signing in again.")
    }
    return session
}

private fun validateCredential(credential: PersonalPlayCredential) {
    if (credential.email.length !in 3..320 || !credential.email.contains('@') ||
        credential.email.any { it.isWhitespace() || it.isISOControl() } ||
        credential.token.length !in 1..16_384 || credential.token.any { it.isWhitespace() || it.isISOControl() }
    ) {
        throw PersonalPlayAuthException("Google sign-in returned incomplete credentials. Try signing in again.")
    }
}

private inline fun <T> safePlayAuth(block: () -> T): T = try {
    block()
} catch (exception: CancellationException) {
    throw exception
} catch (exception: PersonalPlayAuthException) {
    throw exception
} catch (exception: GooglePlayException.AuthException) {
    throw playStatusFailure(exception.code)
} catch (exception: IOException) {
    throw PersonalPlayAuthException("Could not reach Google Play. Check the connection and try again.")
} catch (exception: Exception) {
    // Google and storage exceptions can embed account tokens, URLs or raw response data.
    throw PersonalPlayAuthException("Google Play sign-in could not be completed. Try signing in again.")
}

private fun playStatusFailure(status: Int): PersonalPlayAuthException = PersonalPlayAuthException(
    when (status) {
        401, 403 -> "Google rejected this Play sign-in. Try signing in again on the phone."
        429 -> "Google Play is limiting sign-in attempts. Wait a little before trying again."
        in 500..599 -> "Google Play is temporarily unavailable. Try again later."
        else -> "Google Play sign-in could not be completed. Try signing in again."
    },
)

internal fun parseGoogleSetupExchange(response: PlayResponse, fallbackEmail: String): PersonalPlayCredential {
    if (!response.isSuccessful || response.code !in 200..299) throw playStatusFailure(response.code)
    if (response.responseBytes.size > 65_536) {
        throw PersonalPlayAuthException("Google sign-in returned an invalid response. Try again.")
    }
    val fields = mutableMapOf<String, String>()
    response.responseBytes.toString(Charsets.UTF_8).lineSequence().forEach { line ->
        val separator = line.indexOf('=')
        if (separator > 0) {
            val name = line.substring(0, separator)
            if (name in setOf("Token", "Email", "Error")) {
                if (fields.put(name, line.substring(separator + 1).removeSuffix("\r")) != null) {
                    throw PersonalPlayAuthException("Google sign-in returned an invalid response. Try again.")
                }
            }
        }
    }
    if (fields.containsKey("Error")) throw playStatusFailure(401)
    // Current Aurora reads Token, not Auth. Auth alone is not a reusable account credential.
    val token = fields["Token"]
        ?: throw PersonalPlayAuthException("Google did not return a reusable Play credential. Try signing in again.")
    return PersonalPlayCredential(fields["Email"]?.takeIf { it.isNotBlank() } ?: fallbackEmail, token)
        .also(::validateCredential)
}

private fun exchangeGoogleSetupCredential(
    email: String,
    oauthToken: String,
    properties: Properties,
    locale: Locale,
    httpClient: IHttpClient,
): PersonalPlayCredential {
    var exchanged: PersonalPlayCredential? = null
    val exchangeClient = object : IHttpClient by httpClient {
        override fun post(url: String, headers: Map<String, String>, params: Map<String, String>): PlayResponse {
            check(url == GOOGLE_ANDROID_AUTH_URL)
            val response = httpClient.post(url, headers, params)
            val credential = parseGoogleSetupExchange(response, email)
            exchanged = credential
            // GPlayAPI 3.6.4 constructs the account exchange, but its helper reads Auth instead
            // of Token. Adapt just that successful response; keep all request parameters upstream.
            return response.copy(responseBytes = "Auth=${credential.token}\n".toByteArray(Charsets.UTF_8))
        }
    }
    GooglePlayApi().using(exchangeClient).generateAASToken(
        AuthData(
            email = email,
            oAuthLoginToken = oauthToken,
            isAnonymous = false,
            deviceInfoProvider = DeviceInfoProvider(properties, locale.toString()),
            locale = locale,
        ),
    )
    return exchanged ?: throw PersonalPlayAuthException("Google Play sign-in could not be completed. Try again.")
}

/**
 * The upstream default HTTP client puts auth tokens in query strings and logs entire URLs.
 * This nonlogging transport puts Android auth parameters in the POST body, restricts endpoints,
 * rejects redirects, and strips raw error responses. Use it for every personal Play helper.
 */
class PersonalPlayHttpClient internal constructor(
    private val openConnection: (URI) -> HttpURLConnection,
) : IHttpClient {
    constructor() : this({ it.toURL().openConnection() as HttpURLConnection })

    private val status = MutableStateFlow(0)
    override val responseCode: StateFlow<Int> = status.asStateFlow()

    override fun post(url: String, headers: Map<String, String>, body: ByteArray): PlayResponse =
        request(url, "POST", headers, body)

    override fun post(url: String, headers: Map<String, String>, params: Map<String, String>): PlayResponse =
        if (url == GOOGLE_ANDROID_AUTH_URL) {
            request(
                url,
                "POST",
                headers + ("Content-Type" to "application/x-www-form-urlencoded; charset=UTF-8"),
                encodeParameters(params).toByteArray(Charsets.UTF_8),
            )
        } else {
            // Preserve the library's FDFE request shape; personal auth never takes this path.
            request(withParameters(url, params), "POST", headers, byteArrayOf())
        }

    override fun get(url: String, headers: Map<String, String>): PlayResponse = request(url, "GET", headers)

    override fun get(url: String, headers: Map<String, String>, params: Map<String, String>): PlayResponse =
        request(withParameters(url, params), "GET", headers)

    override fun get(url: String, headers: Map<String, String>, paramString: String): PlayResponse =
        request(url + paramString, "GET", headers)

    override fun getAuth(url: String): PlayResponse =
        throw IOException("Anonymous authentication is not supported by this client.")

    override fun postAuth(url: String, body: ByteArray): PlayResponse =
        throw IOException("Anonymous authentication is not supported by this client.")

    private fun request(
        url: String,
        method: String,
        headers: Map<String, String>,
        body: ByteArray? = null,
    ): PlayResponse {
        status.value = 0
        val uri = try { URI(url) } catch (_: Exception) { throw IOException("Invalid Google Play endpoint.") }
        if (uri.scheme != "https" || uri.host != "android.clients.google.com" ||
            uri.port !in setOf(-1, 443) || uri.rawUserInfo != null || uri.rawFragment != null ||
            !(uri.path == "/auth" || uri.path == "/checkin" || uri.path.startsWith("/fdfe/")) ||
            (uri.path == "/auth" && (method != "POST" || uri.rawQuery != null))
        ) {
            throw IOException("Unexpected Google Play endpoint.")
        }
        var connection: HttpURLConnection? = null
        try {
            connection = openConnection(uri).apply {
                connectTimeout = 15_000
                readTimeout = 30_000
                requestMethod = method
                instanceFollowRedirects = false
                useCaches = false
                headers.forEach(::setRequestProperty)
            }
            if (body != null) {
                connection.doOutput = true
                connection.outputStream.use { it.write(body) }
            }
            val code = connection.responseCode
            status.value = code
            if (code !in 200..299) {
                return PlayResponse(code = code, isSuccessful = false, errorString = "Google Play request failed.")
            }
            val limit = if (uri.path == "/auth") 65_536 else 8 * 1024 * 1024
            val bytes = connection.inputStream.use { input ->
                val output = ByteArrayOutputStream()
                val buffer = ByteArray(8192)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    if (output.size() + count > limit) throw IOException("Google Play response was too large.")
                    output.write(buffer, 0, count)
                }
                output.toByteArray()
            }
            return PlayResponse(
                code = code,
                isSuccessful = true,
                responseBytes = bytes,
                errorString = "",
                type = connection.contentType?.substringBefore(';'),
            )
        } catch (exception: CancellationException) {
            throw exception
        } catch (_: Exception) {
            // Never let connection exceptions expose an account-bearing URL or response.
            throw IOException("Google Play request could not be completed.")
        } finally {
            connection?.disconnect()
        }
    }
}

private const val GOOGLE_ANDROID_AUTH_URL = "https://android.clients.google.com/auth"

private fun encodeParameters(params: Map<String, String>): String = params.entries.joinToString("&") {
    "${URLEncoder.encode(it.key, Charsets.UTF_8.name())}=${URLEncoder.encode(it.value, Charsets.UTF_8.name())}"
}

private fun withParameters(url: String, params: Map<String, String>): String = when {
    params.isEmpty() -> url
    '?' in url -> "$url&${encodeParameters(params)}"
    else -> "$url?${encodeParameters(params)}"
}
