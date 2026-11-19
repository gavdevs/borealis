package com.loosewire.borealis.data

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

    @Test
    fun `library survives sync with no remaining installation jobs`() = runTest {
        val transport = RecordingTransport(BorealisHttpResponse(200, """
            {"deviceId":"device_1234567890","deviceLabel":"LP3","revision":3,
             "serverTime":"2026-09-27T18:00:00Z","jobs":[],
             "library":[{"packageName":"com.example.bank","displayName":"Example Bank"}]}
        """.trimIndent()))
        val response = BorealisApi("https://borealis.example.test", transport)
            .sync("brl_device_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").getOrThrow()
        assertTrue(response.jobs.isEmpty())
        assertEquals(listOf(LibraryApp("com.example.bank", "Example Bank")), response.library)
    }

    @Test
    fun `device requests signed install job for a library package`() = runTest {
        val bearer = "brl_device_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        val transport = RecordingTransport(BorealisHttpResponse(200,
            """{"job":{"keyId":"fake-key","payload":"fake-payload","signature":"fake-signature"}}"""))
        val job = BorealisApi("https://borealis.example.test", transport)
            .requestLibraryJob(bearer, "com.example.bank").getOrThrow()
        assertEquals("fake-payload", job.payload)
        assertEquals("https://borealis.example.test/api/borealis/v1/device/library/com.example.bank/job", transport.lastUrl)
        assertEquals("Bearer $bearer", transport.lastHeaders["Authorization"])
    }

    @Test
    fun `library install rejects path injection before making request`() = runTest {
        val transport = RecordingTransport(BorealisHttpResponse(200, "{}"))
        val api = BorealisApi("https://borealis.example.test", transport)
        assertTrue(api.requestLibraryJob(
            "brl_device_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "com.example.bank/../../other",
        ).isFailure)
        assertEquals("", transport.lastUrl)
    }

    @Test
    fun `report posts the shared contract body with device auth`() = runTest {
        val bearer = "brl_device_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        val transport = RecordingTransport(
            BorealisHttpResponse(201, """{"ok":true,"number":42,"url":"https://github.test/issues/42"}"""),
        )
        val api = BorealisApi("https://borealis.example.test", transport)

        val receipt = api.submitProblemReport(
            bearer,
            problemReportRequest(
                title = "Install failed",
                description = "The update stopped while verifying.",
                diagnostics = "Version: 0.1.10\n-0m INSTALL FAILED code=502",
            ),
        ).getOrThrow()

        assertEquals(42L, receipt.number)
        assertEquals("https://borealis.example.test/api/borealis/v1/reports", transport.lastUrl)
        assertEquals("Bearer $bearer", transport.lastHeaders["Authorization"])
        assertTrue(transport.lastBody.contains("\"source\":\"phone\""))
        assertTrue(transport.lastBody.contains("\"title\":\"Install failed\""))
        assertTrue(transport.lastBody.contains("INSTALL FAILED"))
        assertTrue(!transport.lastBody.contains(bearer))
    }

    @Test
    fun `report surfaces a companion http failure with its status`() = runTest {
        val transport = RecordingTransport(
            BorealisHttpResponse(429, """{"error":"Too many reports."}"""),
        )
        val api = BorealisApi("https://borealis.example.test", transport)

        val error = api.submitProblemReport(
            "brl_device_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            problemReportRequest("Install failed", "The update stopped.", null),
        ).exceptionOrNull()

        assertEquals(429, (error as BorealisApiException).httpStatus)
        assertTrue(problemReportFailureMessage(error).contains("Try again in an hour"))
    }

    @Test
    fun `report rejects a web-sourced body from the phone`() = runTest {
        val transport = RecordingTransport(BorealisHttpResponse(201, "{}"))
        val api = BorealisApi("https://borealis.example.test", transport)

        val result = api.submitProblemReport(
            "brl_device_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            ProblemReportRequest("Install failed", "The update stopped.", source = "web"),
        )

        assertTrue(result.isFailure)
        assertEquals(0, transport.posts)
    }

    @Test
    fun `title and description strip credentials and account identifiers`() {
        val bearer = "brl_device_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        val title = problemReportTitle("Login\nfailed with Bearer $bearer")
        val description = problemReportDescription(
            "My address is person@example.test\r\n\r\n\r\nAuthorization: Bearer $bearer",
        )

        assertEquals("Login failed with Bearer [credential removed]", title)
        assertTrue(!description.contains(bearer))
        assertTrue(!description.contains("person@example.test"))
        assertTrue(description.contains("[email removed]"))
        assertTrue(description.contains("[credential removed]"))
        assertTrue(!description.contains("\r"))
        assertTrue(!description.contains("\n\n\n"))
    }

    @Test
    fun `limits mirror the shared report contract`() {
        assertEquals(120, PROBLEM_REPORT_TITLE_LIMIT)
        assertEquals(4_000, PROBLEM_REPORT_DESCRIPTION_LIMIT)
        assertEquals(8_000, PROBLEM_REPORT_DIAGNOSTICS_LIMIT)
        assertEquals(10, PROBLEM_REPORT_DESCRIPTION_MIN)

        assertEquals(
            "Enter a title of at least 3 characters.",
            problemReportValidationError("ab", "A long enough description."),
        )
        assertEquals(
            "Describe the problem in at least 10 characters.",
            problemReportValidationError("Crash", "short"),
        )
        assertEquals(null, problemReportValidationError("Crash on sync", "It closed on every sync."))
    }

    @Test
    fun `diagnostics include recent sanitized events and stay bounded`() {
        val events = listOf(
            ProblemReportEvent(ProblemReportStage.SYNC, ProblemReportOutcome.STARTED, ageMinutes = 9),
            ProblemReportEvent(ProblemReportStage.INSTALL, ProblemReportOutcome.FAILED, code = 502, ageMinutes = 2),
        )
        val text = formatProblemReportDiagnostics(
            context = ProblemReportContext(
                appVersion = "0.1.10",
                androidSdk = 35,
                deviceModel = "Light Phone III",
                paired = true,
                libraryApps = 4,
                installedApps = 3,
                googlePlayConnected = true,
                installInProgress = false,
                uninstallInProgress = false,
            ),
            events = events,
        )

        assertTrue(text.contains("Version: 0.1.10"))
        assertTrue(text.contains("Library: 4 apps, 3 installed"))
        assertTrue(text.contains("-9m SYNC STARTED"))
        assertTrue(text.contains("-2m INSTALL FAILED code=502"))
        assertTrue(!text.contains("brl_device_"))
        assertTrue(text.length <= PROBLEM_REPORT_DIAGNOSTICS_LIMIT)
    }

    @Test
    fun `diagnostics keep the newest events when the budget is tight`() {
        // Same ordering as ProblemReportLog: oldest first, ages descending.
        val events = (1_000 downTo 1).map { index ->
            ProblemReportEvent(ProblemReportStage.INSTALL, ProblemReportOutcome.FAILED, code = 500, ageMinutes = index)
        }
        val text = formatProblemReportDiagnostics(
            context = ProblemReportContext("0.1.10", 35, "Light Phone III", true, 1, 0, null, false, false),
            events = events,
        )

        assertTrue(text.length <= PROBLEM_REPORT_DIAGNOSTICS_LIMIT)
        assertTrue(text.contains("-1m INSTALL FAILED"))
        assertTrue(!text.contains("-1000m INSTALL FAILED"))
    }

    @Test
    fun `report body always includes the source discriminator`() = runTest {
        val transport = RecordingTransport(BorealisHttpResponse(201, """{"ok":true,"number":1}"""))
        BorealisApi("https://borealis.example.test", transport).submitProblemReport(
            "brl_device_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            ProblemReportRequest("Install failed", "The update stopped."),
        ).getOrThrow()

        // `source` is a defaulted field, so defaults must still be encoded:
        // the shared server schema rejects a body without it.
        assertTrue(transport.lastBody.contains("\"source\":\"phone\""))
    }

    @Test
    fun `report log clamps codes and caps retained events`() {
        ProblemReportLog.clear()
        repeat(40) { ProblemReportLog.record(ProblemReportStage.SYNC, ProblemReportOutcome.FAILED, code = 999) }
        ProblemReportLog.record(ProblemReportStage.REPORT, ProblemReportOutcome.SUCCEEDED, code = 201)

        val recent = ProblemReportLog.recent()

        assertEquals(24, recent.size)
        assertEquals(ProblemReportStage.REPORT, recent.last().stage)
        assertEquals(201, recent.last().code)
        assertTrue(recent.dropLast(1).all { it.code == null })
        ProblemReportLog.clear()
    }
}

private class RecordingTransport(
    private val response: BorealisHttpResponse,
) : BorealisHttpTransport {
    var lastUrl: String = ""
    var lastHeaders: Map<String, String> = emptyMap()
    var lastBody: String = ""
    var posts: Int = 0

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
        lastBody = body
        posts += 1
        return response
    }

    override fun close() = Unit
}
