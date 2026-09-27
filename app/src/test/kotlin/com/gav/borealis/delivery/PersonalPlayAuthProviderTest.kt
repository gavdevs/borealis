package com.gav.borealis.delivery

import com.aurora.gplayapi.data.models.AuthData
import com.aurora.gplayapi.data.models.PlayResponse
import com.aurora.gplayapi.exceptions.GooglePlayException
import com.aurora.gplayapi.AndroidCheckinResponse
import com.aurora.gplayapi.network.IHttpClient
import com.thelightphone.sdk.auth.GooglePlayDiagnosticOutcome
import com.thelightphone.sdk.auth.GooglePlayDiagnosticStage
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.util.Locale
import java.util.Properties
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest

/** All credentials below are deliberately public fake fixtures; no live account calls. */
class PersonalPlayAuthProviderTest {
    @Test
    fun `setup exchange reads reusable Token and canonical email not short-lived Auth`() {
        val credential = parseGoogleSetupExchange(
            response("SID=unused\r\nAuth=fake-short-lived\r\nToken=fake-aas==\r\nEmail=canonical@example.test\r\n"),
            EMAIL,
        )
        assertEquals("canonical@example.test", credential.email)
        assertEquals("fake-aas==", credential.token)
        assertEquals("PersonalPlayCredential(redacted)", credential.toString())
    }

    @Test
    fun `setup exchange falls back to supplied account when email is absent`() {
        assertEquals(EMAIL, parseGoogleSetupExchange(response("Token=fake-aas\n"), EMAIL).email)
    }

    @Test
    fun `short-lived Auth alone is not saved as account token`() {
        assertFailsWith<PersonalPlayAuthException> {
            parseGoogleSetupExchange(response("Auth=fake-short-lived\n"), EMAIL)
        }
    }

    @Test
    fun `exchange rejects errors duplicates malformed credentials and oversized responses`() {
        listOf(
            "Error=NeedsBrowser\nToken=fake-aas\nUrl=https://example.test/secret\n",
            "Token=fake-aas\nToken=another-token\n",
            "Token=fake-aas\nEmail=a@example.test\nEmail=b@example.test\n",
            "Token= \n",
            "Token=fake token\n",
            "Token=fake-aas\nEmail=bad email\n",
            "Token=" + "a".repeat(65_537),
        ).forEach { body ->
            val error = assertFailsWith<PersonalPlayAuthException> {
                parseGoogleSetupExchange(response(body), EMAIL)
            }
            assertFalse(error.toString().contains("fake-aas"))
            assertFalse(error.toString().contains("example.test/secret"))
            assertNull(error.cause)
        }
    }

    @Test
    fun `HTTP status errors never contain response credentials or error text`() {
        listOf(401, 403, 429, 503).forEach { code ->
            val error = assertFailsWith<PersonalPlayAuthException> {
                parseGoogleSetupExchange(
                    PlayResponse(code = code, errorString = "fake-secret", responseBytes = "Token=fake-secret".toByteArray()),
                    EMAIL,
                )
            }
            assertFalse(error.toString().contains("fake-secret"))
            assertNull(error.cause)
        }
    }

    @Test
    fun `sign-in validates session before committing reusable credential`() = runTest {
        val store = MemoryCredentialStore()
        val credential = PersonalPlayCredential("canonical@example.test", "fake-aas")
        var exchanged = false
        var built = false
        val provider = PersonalPlayAuthProvider(
            store,
            exchange = { email, cookie, _, _ ->
                assertEquals(EMAIL, email)
                assertEquals("fake-cookie", cookie)
                assertNull(store.value)
                exchanged = true
                credential
            },
            build = { stored, _, _ ->
                assertTrue(exchanged)
                assertSame(credential, stored)
                assertNull(store.value)
                built = true
                validSession(stored.email)
            },
        )

        val session = provider.completeSignIn(" $EMAIL ", "fake-cookie", Properties(), Locale.US)

        assertTrue(built)
        assertFalse(session.isAnonymous)
        assertSame(credential, store.value)
        assertTrue(provider.isConnected())
    }

    @Test
    fun `failed replacement keeps previous account and strips upstream errors`() = runTest {
        val original = PersonalPlayCredential(EMAIL, "fake-original")
        val store = MemoryCredentialStore(original)
        val provider = PersonalPlayAuthProvider(
            store,
            exchange = { _, _, _, _ -> PersonalPlayCredential(EMAIL, "fake-new") },
            build = { _, _, _ -> throw IOException("Token=fake-secret") },
        )

        val error = assertFailsWith<PersonalPlayAuthException> {
            provider.completeSignIn(EMAIL, "fake-cookie", Properties())
        }

        assertSame(original, store.value)
        assertEquals(0, store.writes)
        assertFalse(error.toString().contains("fake-secret"))
        assertSanitizedCoroutineFailure(error)
    }

    @Test
    fun `incomplete anonymous or wrong-account sessions are never committed`() = runTest {
        listOf(
            validSession().copy(authToken = ""),
            validSession().copy(deviceConfigToken = ""),
            validSession().copy(isAnonymous = true),
            validSession().copy(email = "another@example.test"),
        ).forEach { invalidSession ->
            val store = MemoryCredentialStore()
            val provider = provider(store) { invalidSession }
            assertFailsWith<PersonalPlayAuthException> {
                provider.completeSignIn(EMAIL, "fake-cookie", Properties())
            }
            assertNull(store.value)
            assertEquals(0, store.writes)
        }
    }

    @Test
    fun `saved personal token authenticates without repeating account setup`() = runTest {
        val store = MemoryCredentialStore(PersonalPlayCredential(EMAIL, "fake-aas"))
        val provider = PersonalPlayAuthProvider(
            store,
            exchange = { _, _, _, _ -> error("Must not exchange saved credentials") },
            build = { credential, _, _ ->
                assertEquals("fake-aas", credential.token)
                validSession(credential.email)
            },
        )
        assertEquals(EMAIL, provider.authenticate(Properties(), Locale.US).email)
        assertEquals(0, store.writes)
        provider.disconnect()
        assertFalse(provider.isConnected())
        assertFailsWith<PersonalPlayAuthException> { provider.authenticate(Properties(), Locale.US) }
    }

    @Test
    fun `upstream auth errors are mapped without retaining raw reason`() = runTest {
        val store = MemoryCredentialStore(PersonalPlayCredential(EMAIL, "fake-aas"))
        val provider = provider(store) { throw GooglePlayException.AuthException(403, "Token=fake-secret") }
        val error = assertFailsWith<PersonalPlayAuthException> { provider.authenticate(Properties(), Locale.US) }
        assertEquals("Google rejected this Play sign-in. Try signing in again on the phone.", error.message)
        assertSanitizedCoroutineFailure(error)
    }

    @Test
    fun `cancellation propagates without saving credential`() = runTest {
        val store = MemoryCredentialStore()
        val provider = provider(store) { throw CancellationException("Cancelled") }
        assertFailsWith<CancellationException> { provider.completeSignIn(EMAIL, "fake-cookie", Properties()) }
        assertEquals(0, store.writes)
    }

    @Test
    fun `cancelled sign-in cannot commit after blocking Google request returns`() = runTest {
        val store = MemoryCredentialStore()
        val buildEntered = CompletableDeferred<Unit>()
        val releaseBuild = CountDownLatch(1)
        val provider = provider(store) {
            buildEntered.complete(Unit)
            assertTrue(releaseBuild.await(5, TimeUnit.SECONDS))
            validSession()
        }
        val signIn = launch { provider.completeSignIn(EMAIL, "fake-cookie", Properties()) }
        try {
            buildEntered.await()
            signIn.cancel()
        } finally {
            releaseBuild.countDown()
        }
        signIn.join()

        assertTrue(signIn.isCancelled)
        assertNull(store.value)
        assertEquals(0, store.writes)
    }

    @Test
    fun `Google auth parameters go in form body never request URL`() {
        val connection = FakeConnection()
        var opened: URI? = null
        val client = PersonalPlayHttpClient { uri -> opened = uri; connection }

        client.post(AUTH_URL, emptyMap(), mapOf("Email" to EMAIL, "Token" to "fake+a=b", "service" to "ac2dm"))

        assertEquals(AUTH_URL, opened.toString())
        assertNull(opened!!.rawQuery)
        assertEquals("Email=person%40example.test&Token=fake%2Ba%3Db&service=ac2dm", connection.output.toString("UTF-8"))
        assertEquals("application/x-www-form-urlencoded; charset=UTF-8", connection.getRequestProperty("Content-Type"))
        assertEquals(
            listOf("application/x-www-form-urlencoded; charset=UTF-8"),
            connection.requestProperties.filterKeys { it.equals("Content-Type", ignoreCase = true) }.values.flatten(),
        )
        assertEquals("POST", connection.requestMethod)
        assertFalse(connection.instanceFollowRedirects)
        assertFalse(connection.useCaches)
        assertTrue(connection.disconnected)
    }

    @Test
    fun `raw device configuration upload explicitly labels unchanged protobuf bytes`() {
        val connection = FakeConnection()
        var opened: URI? = null
        val client = PersonalPlayHttpClient { uri -> opened = uri; connection }
        val headers = mapOf("Accept" to "application/x-protobuf")
        val protobuf = byteArrayOf(0x0a, 0x05, 0x08, 0x80.toByte(), 0x01, 0x10, 0x00)

        client.post("https://android.clients.google.com/fdfe/uploadDeviceConfig", headers, protobuf)

        assertEquals("/fdfe/uploadDeviceConfig", opened!!.path)
        assertEquals("application/x-protobuffer", connection.getRequestProperty("Content-Type"))
        assertEquals("application/x-protobuf", connection.getRequestProperty("Accept"))
        assertContentEquals(protobuf, connection.output.toByteArray())
        assertEquals("POST", connection.requestMethod)
        assertEquals(mapOf("Accept" to "application/x-protobuf"), headers)
    }

    @Test
    fun `raw protobuf upload preserves explicit content type regardless of header casing`() {
        listOf("Content-Type", "content-type", "cOnTeNt-TyPe").forEach { headerName ->
            val connection = FakeConnection()
            val client = PersonalPlayHttpClient { connection }
            val explicitType = "application/x-protobuf; charset=binary"
            val protobuf = byteArrayOf(0x0a, 0x02, 0x08, 0xff.toByte())
            val headers = mapOf(headerName to explicitType)

            client.post("https://android.clients.google.com/fdfe/uploadDeviceConfig", headers, protobuf)

            val contentTypeHeaders = connection.requestProperties
                .filterKeys { it.equals("Content-Type", ignoreCase = true) }
            assertEquals(setOf(headerName), contentTypeHeaders.keys)
            assertEquals(listOf(explicitType), contentTypeHeaders.values.flatten())
            assertContentEquals(protobuf, connection.output.toByteArray())
            assertEquals(mapOf(headerName to explicitType), headers)
        }
    }

    @Test
    fun `GET requests do not acquire a protobuf request content type`() {
        val connection = FakeConnection()
        val client = PersonalPlayHttpClient { connection }

        client.get("https://android.clients.google.com/fdfe/api/userProfile", emptyMap())

        assertEquals("GET", connection.requestMethod)
        assertTrue(connection.requestProperties.keys.none { it.equals("Content-Type", ignoreCase = true) })
        assertFalse(connection.doOutput)
        assertContentEquals(byteArrayOf(), connection.output.toByteArray())
    }

    @Test
    fun `transport rejects credential-bearing URLs and unexpected endpoints before connecting`() {
        var opened = false
        val client = PersonalPlayHttpClient { opened = true; FakeConnection() }
        listOf(
            "http://android.clients.google.com/auth",
            "https://android.clients.google.com.evil.test/auth",
            "$AUTH_URL?Token=fake-secret",
            "https://user@android.clients.google.com/auth",
            "$AUTH_URL#fragment",
            "https://android.clients.google.com:444/auth",
            "https://auroraoss.com/api/auth",
        ).forEach { url ->
            assertFailsWith<IOException> { client.post(url, emptyMap(), byteArrayOf()) }
        }
        assertFailsWith<IOException> { client.get(AUTH_URL, emptyMap()) }
        assertFalse(opened)
    }

    @Test
    fun `redirects and raw HTTP errors never expose response bodies`() {
        listOf(302, 403, 429).forEach { code ->
            val connection = FakeConnection(code, "Token=fake-secret".toByteArray())
            val response = PersonalPlayHttpClient { connection }.post(AUTH_URL, emptyMap(), byteArrayOf())
            assertFalse(response.isSuccessful)
            assertEquals(code, response.code)
            assertContentEquals(byteArrayOf(), response.responseBytes)
            assertFalse(response.errorString.contains("fake-secret"))
            assertFalse(connection.inputRead)
        }
    }

    @Test
    fun `transport strips underlying exception messages and bounds auth responses`() {
        val failing = PersonalPlayHttpClient { throw IOException("https://example.test/?Token=fake-secret") }
        val failure = assertFailsWith<IOException> { failing.post(AUTH_URL, emptyMap(), byteArrayOf()) }
        assertFalse(failure.toString().contains("fake-secret"))
        assertNull(failure.cause)

        val oversized = FakeConnection(body = ByteArray(65_537))
        assertFailsWith<IOException> {
            PersonalPlayHttpClient { oversized }.post(AUTH_URL, emptyMap(), byteArrayOf())
        }
        assertTrue(oversized.disconnected)
    }

    @Test
    fun `diagnostics report actual account exchange status without response or account data`() {
        listOf(400, 403).forEach { status ->
            val trace = DiagnosticTrace()
            val connection = FakeConnection(status, "Token=fake-secret\nEmail=$EMAIL".toByteArray())
            val error = assertFailsWith<PersonalPlayAuthException> {
                observePlayOperation(trace.sink, GooglePlayDiagnosticStage.ACCOUNT_EXCHANGE) { observation ->
                    val client = ObservedPlayHttpClient(PersonalPlayHttpClient { connection }, observation)
                    val response = client.post(
                        AUTH_URL,
                        mapOf("Authorization" to "fake-secret"),
                        mapOf("service" to "ac2dm", "Email" to EMAIL, "Token" to "fake-secret"),
                    )
                    parseGoogleSetupExchange(response, EMAIL)
                }
            }
            assertEquals(
                if (status == 400) "Google Play sign-in could not be completed. Try signing in again."
                else "Google rejected this Play sign-in. Try signing in again on the phone.",
                error.message,
            )
            assertEquals(
                listOf(
                    DiagnosticEvent(GooglePlayDiagnosticStage.ACCOUNT_EXCHANGE, GooglePlayDiagnosticOutcome.STARTED),
                    DiagnosticEvent(GooglePlayDiagnosticStage.ACCOUNT_EXCHANGE, GooglePlayDiagnosticOutcome.HTTP_ERROR, status),
                ),
                trace.events,
            )
            trace.assertNoSecrets()
        }
    }

    @Test
    fun `diagnostics distinguish check-in and device config HTTP failures`() {
        listOf(
            Triple("https://android.clients.google.com/checkin", GooglePlayDiagnosticStage.CHECK_IN, 400),
            Triple("https://android.clients.google.com/fdfe/uploadDeviceConfig", GooglePlayDiagnosticStage.DEVICE_CONFIG, 403),
        ).forEach { (url, stage, status) ->
            val trace = DiagnosticTrace()
            val failure = GooglePlayException.AuthException(status, "fake-secret")
            val actual = assertFailsWith<GooglePlayException.AuthException> {
                observePlayOperation(trace.sink, GooglePlayDiagnosticStage.CHECK_IN) { observation ->
                    ObservedPlayHttpClient(PersonalPlayHttpClient { FakeConnection(status) }, observation)
                        .post(url, emptyMap(), byteArrayOf(1, 2, 3))
                    throw failure
                }
            }
            assertSame(failure, actual)
            assertEquals(
                listOf(
                    DiagnosticEvent(stage, GooglePlayDiagnosticOutcome.STARTED),
                    DiagnosticEvent(stage, GooglePlayDiagnosticOutcome.HTTP_ERROR, status),
                ),
                trace.events,
            )
            trace.assertNoSecrets()
        }
    }

    @Test
    fun `protobuf decoding failure after HTTP success is diagnosed as response not network error`() {
        val trace = DiagnosticTrace()
        assertFailsWith<IOException> {
            observePlayOperation(trace.sink, GooglePlayDiagnosticStage.CHECK_IN) { observation ->
                val client = ObservedPlayHttpClient(
                    PersonalPlayHttpClient { FakeConnection(body = byteArrayOf(0xff.toByte())) },
                    observation,
                )
                val response = client.post("https://android.clients.google.com/checkin", emptyMap(), byteArrayOf())
                AndroidCheckinResponse.parseFrom(response.responseBytes)
            }
        }
        assertEquals(
            listOf(
                DiagnosticEvent(GooglePlayDiagnosticStage.CHECK_IN, GooglePlayDiagnosticOutcome.STARTED),
                DiagnosticEvent(GooglePlayDiagnosticStage.CHECK_IN, GooglePlayDiagnosticOutcome.SUCCEEDED, 200),
                DiagnosticEvent(GooglePlayDiagnosticStage.CHECK_IN, GooglePlayDiagnosticOutcome.RESPONSE_ERROR, 200),
            ),
            trace.events,
        )
        trace.assertNoSecrets()
    }

    @Test
    fun `exchange response without reusable token keeps real HTTP status in diagnostics`() {
        val trace = DiagnosticTrace()
        assertFailsWith<PersonalPlayAuthException> {
            observePlayOperation(trace.sink, GooglePlayDiagnosticStage.ACCOUNT_EXCHANGE) { observation ->
                val client = ObservedPlayHttpClient(
                    PersonalPlayHttpClient { FakeConnection(body = "Auth=fake-secret".toByteArray()) },
                    observation,
                )
                parseGoogleSetupExchange(client.post(AUTH_URL, emptyMap(), mapOf("service" to "ac2dm")), EMAIL)
            }
        }
        assertEquals(
            DiagnosticEvent(GooglePlayDiagnosticStage.ACCOUNT_EXCHANGE, GooglePlayDiagnosticOutcome.RESPONSE_ERROR, 200),
            trace.events.last(),
        )
        trace.assertNoSecrets()
    }

    @Test
    fun `network diagnostics do not contain underlying exception metadata`() {
        val trace = DiagnosticTrace()
        assertFailsWith<IOException> {
            observePlayOperation(trace.sink, GooglePlayDiagnosticStage.ACCOUNT_EXCHANGE) { observation ->
                ObservedPlayHttpClient(
                    PersonalPlayHttpClient { throw IOException("$EMAIL Token=fake-secret") },
                    observation,
                ).post(AUTH_URL, emptyMap(), mapOf("service" to "ac2dm"))
            }
        }
        assertEquals(
            listOf(
                DiagnosticEvent(GooglePlayDiagnosticStage.ACCOUNT_EXCHANGE, GooglePlayDiagnosticOutcome.STARTED),
                DiagnosticEvent(GooglePlayDiagnosticStage.ACCOUNT_EXCHANGE, GooglePlayDiagnosticOutcome.NETWORK_ERROR),
            ),
            trace.events,
        )
        trace.assertNoSecrets()
    }

    @Test
    fun `secure save failures are distinguished from successful session validation`() = runTest {
        val trace = DiagnosticTrace()
        val store = object : PlayCredentialStore {
            override suspend fun read(): PersonalPlayCredential? = null
            override suspend fun write(credential: PersonalPlayCredential) { throw IOException("$EMAIL fake-secret") }
            override suspend fun clear() = Unit
        }
        val provider = PersonalPlayAuthProvider(
            store,
            exchange = { _, _, _, _ -> PersonalPlayCredential(EMAIL, "fake-secret") },
            build = { _, _, _ -> validSession() },
            diagnostics = trace.sink,
        )
        val error = assertFailsWith<PersonalPlayAuthException> {
            provider.completeSignIn(EMAIL, "fake-secret", Properties())
        }
        // Preserve the existing user-facing mapping; this patch adds only a diagnostic channel.
        assertEquals("Could not reach Google Play. Check the connection and try again.", error.message)
        assertEquals(
            listOf(
                DiagnosticEvent(GooglePlayDiagnosticStage.SESSION_VALIDATION, GooglePlayDiagnosticOutcome.STARTED),
                DiagnosticEvent(GooglePlayDiagnosticStage.SESSION_VALIDATION, GooglePlayDiagnosticOutcome.SUCCEEDED),
                DiagnosticEvent(GooglePlayDiagnosticStage.SECURE_STORE, GooglePlayDiagnosticOutcome.STARTED),
                DiagnosticEvent(GooglePlayDiagnosticStage.SECURE_STORE, GooglePlayDiagnosticOutcome.STORAGE_ERROR),
            ),
            trace.events,
        )
        trace.assertNoSecrets()
    }

    @Test
    fun `secure read failures report only fixed storage category`() = runTest {
        val trace = DiagnosticTrace()
        val store = object : PlayCredentialStore {
            override suspend fun read(): PersonalPlayCredential? = throw IllegalStateException("fake-secret")
            override suspend fun write(credential: PersonalPlayCredential) = Unit
            override suspend fun clear() = Unit
        }
        val provider = PersonalPlayAuthProvider(
            store,
            exchange = { _, _, _, _ -> error("Not called") },
            build = { _, _, _ -> error("Not called") },
            diagnostics = trace.sink,
        )
        assertFailsWith<PersonalPlayAuthException> { provider.isConnected() }
        assertEquals(
            listOf(
                DiagnosticEvent(GooglePlayDiagnosticStage.SECURE_STORE, GooglePlayDiagnosticOutcome.STARTED),
                DiagnosticEvent(GooglePlayDiagnosticStage.SECURE_STORE, GooglePlayDiagnosticOutcome.STORAGE_ERROR),
            ),
            trace.events,
        )
        trace.assertNoSecrets()
    }

    @Test
    fun `diagnostic observer preserves original HTTP request and response`() {
        val trace = DiagnosticTrace()
        val headers = mapOf("Authorization" to "fake-secret")
        val params = mapOf("service" to "ac2dm", "Token" to "fake-secret", "Email" to EMAIL)
        val expected = response("Token=fake-secret")
        val delegate = object : IHttpClient by PersonalPlayHttpClient({ error("Not called") }) {
            override fun post(url: String, actualHeaders: Map<String, String>, actualParams: Map<String, String>): PlayResponse {
                assertEquals(AUTH_URL, url)
                assertSame(headers, actualHeaders)
                assertSame(params, actualParams)
                return expected
            }
        }
        val actual = observePlayOperation(trace.sink, GooglePlayDiagnosticStage.ACCOUNT_EXCHANGE) { observation ->
            ObservedPlayHttpClient(delegate, observation).post(AUTH_URL, headers, params)
        }
        assertSame(expected, actual)
        trace.assertNoSecrets()
    }

    @Test
    fun `Play token and profile requests get distinct diagnostic stages`() {
        val trace = DiagnosticTrace()
        observePlayOperation(trace.sink, GooglePlayDiagnosticStage.CHECK_IN) { observation ->
            val client = ObservedPlayHttpClient(PersonalPlayHttpClient { FakeConnection() }, observation)
            client.post(AUTH_URL, emptyMap(), mapOf("service" to "oauth2:https://www.googleapis.com/auth/googleplay"))
            client.get("https://android.clients.google.com/fdfe/api/userProfile", emptyMap(), emptyMap())
        }
        assertEquals(
            listOf(
                DiagnosticEvent(GooglePlayDiagnosticStage.PLAY_TOKEN, GooglePlayDiagnosticOutcome.STARTED),
                DiagnosticEvent(GooglePlayDiagnosticStage.PLAY_TOKEN, GooglePlayDiagnosticOutcome.SUCCEEDED, 200),
                DiagnosticEvent(GooglePlayDiagnosticStage.USER_PROFILE, GooglePlayDiagnosticOutcome.STARTED),
                DiagnosticEvent(GooglePlayDiagnosticStage.USER_PROFILE, GooglePlayDiagnosticOutcome.SUCCEEDED, 200),
            ),
            trace.events,
        )
        trace.assertNoSecrets()
    }

    @Test
    fun `diagnostic sink failures cannot change successful sign-in`() = runTest {
        val store = MemoryCredentialStore()
        val provider = PersonalPlayAuthProvider(
            store,
            exchange = { _, _, _, _ -> PersonalPlayCredential(EMAIL, "fake-secret") },
            build = { _, _, _ -> validSession() },
            diagnostics = { _, _, _ -> throw IllegalStateException("Diagnostic recorder unavailable") },
        )
        assertEquals(EMAIL, provider.completeSignIn(EMAIL, "fake-secret", Properties()).email)
        assertTrue(provider.isConnected())
    }

    private fun provider(store: PlayCredentialStore, build: () -> AuthData) = PersonalPlayAuthProvider(
        store,
        exchange = { _, _, _, _ -> PersonalPlayCredential(EMAIL, "fake-aas") },
        build = { _, _, _ -> build() },
    )

    private fun response(body: String) = PlayResponse(
        code = 200,
        isSuccessful = true,
        responseBytes = body.toByteArray(Charsets.UTF_8),
    )

    private fun validSession(email: String = EMAIL) = AuthData(
        email = email,
        aasToken = "fake-aas",
        authToken = "fake-play-session",
        deviceConfigToken = "fake-device-config",
        isAnonymous = false,
    )

    private fun assertSanitizedCoroutineFailure(error: PersonalPlayAuthException) {
        // Coroutine stack recovery may copy the safe exception and use that original safe
        // exception as its cause. Permit only those identical wrappers, never a raw failure.
        val visited = mutableSetOf<Throwable>()
        var current: Throwable? = error
        while (current != null) {
            assertTrue(visited.add(current), "Exception cause chain must not contain a cycle")
            assertEquals(PersonalPlayAuthException::class, current::class)
            assertEquals(error.message, current.message)
            assertTrue(current.suppressed.isEmpty(), "No upstream error may survive as suppressed")
            current = current.cause
        }
        assertFalse(error.stackTraceToString().contains("fake-secret"))
    }

    private companion object {
        const val EMAIL = "person@example.test"
        const val AUTH_URL = "https://android.clients.google.com/auth"
    }
}

private data class DiagnosticEvent(
    val stage: GooglePlayDiagnosticStage,
    val outcome: GooglePlayDiagnosticOutcome,
    val code: Int? = null,
)

private class DiagnosticTrace {
    val events = mutableListOf<DiagnosticEvent>()
    val sink: PlayAuthDiagnosticSink = { stage, outcome, code -> events.add(DiagnosticEvent(stage, outcome, code)) }

    fun assertNoSecrets() {
        val rendered = events.toString()
        listOf("fake-secret", "person@example.test", "https://", "IOException", "AuthException")
            .forEach { assertFalse(rendered.contains(it)) }
    }
}

private class MemoryCredentialStore(var value: PersonalPlayCredential? = null) : PlayCredentialStore {
    var writes = 0
    override suspend fun read(): PersonalPlayCredential? = value
    override suspend fun write(credential: PersonalPlayCredential) { value = credential; writes++ }
    override suspend fun clear() { value = null }
}

private class FakeConnection(
    private val status: Int = 200,
    private val body: ByteArray = "Token=fake-token".toByteArray(),
) : HttpURLConnection(URL("https://android.clients.google.com/auth")) {
    val output = ByteArrayOutputStream()
    var disconnected = false
    var inputRead = false
    override fun connect() = Unit
    override fun disconnect() { disconnected = true }
    override fun usingProxy(): Boolean = false
    override fun getResponseCode(): Int = status
    override fun getOutputStream(): ByteArrayOutputStream = output
    override fun getInputStream(): ByteArrayInputStream { inputRead = true; return ByteArrayInputStream(body) }
    override fun getContentType(): String = "text/plain; charset=UTF-8"
}
