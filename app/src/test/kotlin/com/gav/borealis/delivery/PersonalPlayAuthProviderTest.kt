package com.gav.borealis.delivery

import com.aurora.gplayapi.data.models.AuthData
import com.aurora.gplayapi.data.models.PlayResponse
import com.aurora.gplayapi.exceptions.GooglePlayException
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
        assertEquals("POST", connection.requestMethod)
        assertFalse(connection.instanceFollowRedirects)
        assertFalse(connection.useCaches)
        assertTrue(connection.disconnected)
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
