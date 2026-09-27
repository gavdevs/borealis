package com.gav.borealis.delivery

import java.io.IOException
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue
import kotlinx.coroutines.CancellationException
import okhttp3.Call
import okhttp3.Headers
import okhttp3.MediaType
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody
import okio.Buffer
import okio.BufferedSource
import okio.ForwardingSource
import okio.buffer

/** Real OkHttp requests/responses, fake execution only: no sockets or live credentials. */
class PersonalPlayHttpClientTest {
    @Test
    fun `production client forbids redirects and installs no cache or logging interceptors`() {
        val client = createPersonalPlayOkHttpClient()
        assertFalse(client.followRedirects)
        assertFalse(client.followSslRedirects)
        assertEquals(15_000, client.connectTimeoutMillis)
        assertEquals(30_000, client.readTimeoutMillis)
        assertEquals(30_000, client.writeTimeoutMillis)
        assertNull(client.cache)
        assertTrue(client.interceptors.isEmpty())
        assertTrue(client.networkInterceptors.isEmpty())
    }

    @Test
    fun `auth form replaces conflicting content type without duplicating case variants`() {
        val calls = FakePlayCalls()
        val headers = mapOf("content-type" to "application/json", "X-Test" to "fixture")
        PersonalPlayHttpClient(calls).post(AUTH_URL, headers, mapOf("Token" to "fake +&=%", "Email" to "a@example.test"))
        val request = calls.requests.single()
        assertEquals(listOf("application/x-www-form-urlencoded; charset=UTF-8"), request.headers.values("Content-Type"))
        assertEquals("fixture", request.header("X-Test"))
        assertNull(request.url.query)
        assertEquals("Token=fake+%2B%26%3D%25&Email=a%40example.test", requestBodyBytes(request).toString(Charsets.UTF_8))
        assertEquals("application/json", headers["content-type"])
    }

    @Test
    fun `FDFE query overloads preserve encoded parameters and empty POST body`() {
        val calls = FakePlayCalls()
        val client = PersonalPlayHttpClient(calls)
        client.get(FDFE_URL, emptyMap(), mapOf("doc" to "a+b &c"))
        client.get("$FDFE_URL?existing=yes", emptyMap(), mapOf("doc" to "a+b &c"))
        client.get(FDFE_URL, emptyMap(), "?doc=public.fixture")
        client.post(FDFE_URL, emptyMap(), mapOf("doc" to "public.fixture"))
        assertEquals("a+b &c", calls.requests[0].url.queryParameter("doc"))
        assertEquals("yes", calls.requests[1].url.queryParameter("existing"))
        assertEquals("a+b &c", calls.requests[1].url.queryParameter("doc"))
        assertEquals("public.fixture", calls.requests[2].url.queryParameter("doc"))
        calls.requests.take(3).forEach { assertNull(it.body); assertEquals("GET", it.method) }
        val post = calls.requests.last()
        assertEquals("POST", post.method)
        assertEquals("public.fixture", post.url.queryParameter("doc"))
        assertContentEquals(byteArrayOf(), requestBodyBytes(post))
        assertNull(post.body!!.contentType())
        assertNull(post.header("Content-Type"))
    }

    @Test
    fun `all auth GET and query variants fail before a call is created`() {
        val calls = FakePlayCalls()
        val client = PersonalPlayHttpClient(calls)
        assertFailsWith<IOException> { client.get(AUTH_URL, emptyMap()) }
        assertFailsWith<IOException> { client.get(AUTH_URL, emptyMap(), mapOf("Token" to "fake-secret")) }
        assertFailsWith<IOException> { client.get(AUTH_URL, emptyMap(), "?Token=fake-secret") }
        assertFailsWith<IOException> { client.post("$AUTH_URL?Token=fake-secret", emptyMap(), emptyMap()) }
        assertFailsWith<IOException> { client.getAuth("https://auroraoss.com/api/auth") }
        assertFailsWith<IOException> { client.postAuth("https://auroraoss.com/api/auth", byteArrayOf()) }
        assertTrue(calls.requests.isEmpty())
    }

    @Test
    fun `URL normalization cannot bypass auth endpoint restrictions`() {
        val calls = FakePlayCalls()
        val client = PersonalPlayHttpClient(calls)
        listOf(
            "https://android.clients.google.com/fdfe/../auth?Token=fake-secret",
            "https://android.clients.google.com/fdfe/%2e%2e/auth?Token=fake-secret",
            "https://android.clients.google.com/fdfe/../../auth",
            "https://android.clients.google.com/fdfe/%2e%2e/checkin",
        ).forEach { url ->
            assertFailsWith<IOException> { client.get(url, emptyMap()) }
            assertFailsWith<IOException> { client.post(url, emptyMap(), byteArrayOf()) }
        }
        assertTrue(calls.requests.isEmpty())
    }

    @Test
    fun `redirect is returned as sanitized error and body is closed without reading`() {
        val calls = FakePlayCalls(
            status = 302,
            body = "Token=fake-secret".toByteArray(),
            headers = Headers.Builder().add("Location", "https://example.test/?Token=fake-secret").build(),
        )
        val response = PersonalPlayHttpClient(calls).post(AUTH_URL, emptyMap(), byteArrayOf())
        assertEquals(1, calls.requests.size)
        assertEquals(302, response.code)
        assertFalse(response.isSuccessful)
        assertContentEquals(byteArrayOf(), response.responseBytes)
        assertEquals("Google Play request failed.", response.errorString)
        assertFalse(calls.responseBody.read)
        assertTrue(calls.responseBody.closed)
    }

    @Test
    fun `success exposes bounded bytes status and content type and closes response`() {
        val calls = FakePlayCalls(body = byteArrayOf(0, 1, 0xff.toByte()))
        val client = PersonalPlayHttpClient(calls)
        val response = client.get(FDFE_URL, emptyMap())
        assertEquals(200, client.responseCode.value)
        assertEquals(200, response.code)
        assertTrue(response.isSuccessful)
        assertContentEquals(byteArrayOf(0, 1, 0xff.toByte()), response.responseBytes)
        assertEquals("text/plain", response.type)
        assertEquals("", response.errorString)
        assertTrue(calls.responseBody.closed)
    }

    @Test
    fun `response limits are inclusive and enforced on streamed bytes not declared size`() {
        listOf(AUTH_URL to 65_536, FDFE_URL to 8 * 1024 * 1024).forEach { (url, limit) ->
            val exact = FakePlayCalls(body = ByteArray(limit), declaredLength = -1)
            val accepted = PersonalPlayHttpClient(exact).post(url, emptyMap(), byteArrayOf())
            assertEquals(limit, accepted.responseBytes.size)
            assertTrue(exact.responseBody.closed)

            val oversized = FakePlayCalls(body = ByteArray(limit + 1), declaredLength = 0)
            val client = PersonalPlayHttpClient(oversized)
            val error = assertFailsWith<IOException> { client.post(url, emptyMap(), byteArrayOf()) }
            assertSanitized(error)
            assertEquals(200, client.responseCode.value)
            assertTrue(oversized.responseBody.closed)
        }
    }

    @Test
    fun `body read failure closes response and drops raw exception`() {
        val calls = FakePlayCalls(readFailure = IOException("Token=fake-secret person@example.test"))
        val error = assertFailsWith<IOException> { PersonalPlayHttpClient(calls).get(FDFE_URL, emptyMap()) }
        assertSanitized(error)
        assertTrue(calls.responseBody.closed)
    }

    @Test
    fun `failed connection resets previous response status and drops raw exception`() {
        val calls = FakePlayCalls(status = 403)
        val client = PersonalPlayHttpClient(calls)
        client.get(FDFE_URL, emptyMap())
        assertEquals(403, client.responseCode.value)
        calls.failure = IOException("https://example.test/?Token=fake-secret")
        val error = assertFailsWith<IOException> { client.get(FDFE_URL, emptyMap()) }
        assertEquals(0, client.responseCode.value)
        assertSanitized(error)
    }

    @Test
    fun `invalid header failures are sanitized before any call is created`() {
        val calls = FakePlayCalls()
        val error = assertFailsWith<IOException> {
            PersonalPlayHttpClient(calls).get(FDFE_URL, mapOf("X-Test" to "fake-secret\nInjected: value"))
        }
        assertSanitized(error)
        assertTrue(calls.requests.isEmpty())
    }

    @Test
    fun `transport preserves cancellation`() {
        val cancelled = CancellationException("Cancelled")
        val calls = FakePlayCalls(failure = cancelled)
        val actual = assertFailsWith<CancellationException> { PersonalPlayHttpClient(calls).get(FDFE_URL, emptyMap()) }
        assertSame(cancelled, actual)
    }

    private fun assertSanitized(error: IOException) {
        assertEquals("Google Play request could not be completed.", error.message)
        assertNull(error.cause)
        assertTrue(error.suppressed.isEmpty())
        assertFalse(error.stackTraceToString().contains("fake-secret"))
        assertFalse(error.stackTraceToString().contains("person@example.test"))
    }

    private companion object {
        const val AUTH_URL = "https://android.clients.google.com/auth"
        const val FDFE_URL = "https://android.clients.google.com/fdfe/details"
    }
}

internal fun requestBodyBytes(request: Request): ByteArray = Buffer().also {
    requireNotNull(request.body).writeTo(it)
}.readByteArray()

internal class FakePlayCalls(
    private val status: Int = 200,
    private val body: ByteArray = "Token=fake-token".toByteArray(),
    var failure: Exception? = null,
    private val headers: Headers = Headers.Builder().add("Content-Type", "text/plain; charset=UTF-8").build(),
    private val declaredLength: Long = body.size.toLong(),
    private val readFailure: IOException? = null,
) : Call.Factory {
    val requests = mutableListOf<Request>()
    private val bodies = mutableListOf<TrackedPlayBody>()
    val responseBody: TrackedPlayBody get() = bodies.last()

    override fun newCall(request: Request): Call {
        requests.add(request)
        // Delegate unneeded Call interface methods only; the real call is never executed.
        return object : Call by nonExecutingClient.newCall(request) {
            override fun execute(): Response {
                failure?.let { throw it }
                val responseBody = TrackedPlayBody(body, declaredLength, readFailure).also(bodies::add)
                return Response.Builder()
                    .request(request)
                    .protocol(Protocol.HTTP_1_1)
                    .code(status)
                    .message("Public fixture")
                    .headers(headers)
                    .body(responseBody)
                    .build()
            }
        }
    }

    private companion object {
        val nonExecutingClient: OkHttpClient by lazy { OkHttpClient() }
    }
}

internal class TrackedPlayBody(
    bytes: ByteArray,
    private val declaredLength: Long,
    private val failure: IOException?,
) : ResponseBody() {
    var read = false
        private set
    var closed = false
        private set
    private val data = object : ForwardingSource(Buffer().write(bytes)) {
        override fun read(sink: Buffer, byteCount: Long): Long {
            read = true
            failure?.let { throw it }
            return super.read(sink, byteCount)
        }
        override fun close() {
            closed = true
            super.close()
        }
    }.buffer()

    override fun contentType(): MediaType = "text/plain; charset=UTF-8".toMediaType()
    override fun contentLength(): Long = declaredLength
    override fun source(): BufferedSource = data
}
