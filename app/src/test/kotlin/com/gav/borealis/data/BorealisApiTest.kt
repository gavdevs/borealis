package com.gav.borealis.data

import java.security.SecureRandom
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest

class BorealisApiTest {
    @Test
    fun `normalizes companion URL`() {
        assertEquals("https://borealis.example.test", normalizeInstanceUrl(" https://borealis.example.test/ "))
        assertFailsWith<IllegalArgumentException> { normalizeInstanceUrl("ftp://example.test") }
        assertFailsWith<IllegalArgumentException> { normalizeInstanceUrl("https://user@example.test") }
    }

    @Test
    fun `device bearer has stable shape and digest`() {
        val random = SecureRandom.getInstance("SHA1PRNG").apply { setSeed(byteArrayOf(1, 2, 3, 4)) }
        val bearer = generateDeviceBearer(random)

        assertTrue(validDeviceBearer(bearer))
        assertEquals(54, bearer.length)
        assertTrue(Regex("^[0-9a-f]{64}$").matches(deviceBearerDigest(bearer)))
    }

    @Test
    fun `sync authenticates with the raw device bearer`() = runTest {
        val bearer = "brl_device_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        val transport = RecordingTransport(
            BorealisHttpResponse(
                status = 200,
                body = """{"deviceId":"device_1234567890","deviceLabel":"LP3","revision":2,"serverTime":"2026-09-25T18:00:00Z","jobs":[]}""",
            ),
        )
        val api = BorealisApi("https://borealis.example.test", transport)

        val response = api.sync(bearer).getOrThrow()

        assertEquals(2, response.revision)
        assertEquals("Bearer $bearer", transport.lastHeaders["Authorization"])
        assertEquals("https://borealis.example.test/api/borealis/v1/device/sync", transport.lastUrl)
    }
}

private class RecordingTransport(
    private val response: BorealisHttpResponse,
) : BorealisHttpTransport {
    var lastUrl: String = ""
    var lastHeaders: Map<String, String> = emptyMap()

    override suspend fun get(url: String, headers: Map<String, String>): BorealisHttpResponse {
        lastUrl = url
        lastHeaders = headers
        return response
    }

    override suspend fun post(
        url: String,
        headers: Map<String, String>,
        body: String,
    ): BorealisHttpResponse {
        lastUrl = url
        lastHeaders = headers
        return response
    }

    override fun close() = Unit
}
