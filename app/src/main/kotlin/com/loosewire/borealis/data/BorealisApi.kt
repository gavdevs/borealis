package com.loosewire.borealis.data

import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.request.accept
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import java.net.URI
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.SerializationException
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

class BorealisApi(
    instanceUrl: String,
    private val transport: BorealisHttpTransport = KtorBorealisHttpTransport(),
) : AutoCloseable {
    val baseUrl: String = normalizeInstanceUrl(instanceUrl)

    private val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
    }

    // The shared contract requires `source`, which is a defaulted field, so the
    // report encoder must emit defaults.
    private val reportJson = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        encodeDefaults = true
    }

    suspend fun createPairing(
        deviceLabel: String,
        deviceBearerDigest: String,
    ): Result<PendingPairing> = apiRunCatching {
        val response = transport.post(
            url = "$baseUrl/api/borealis/v1/pairings",
            body = json.encodeToString(CreatePairingRequest(deviceLabel, deviceBearerDigest)),
        )
        response.requireSuccess("Pairing request")
        decode(response.body, "pairing response")
    }

    suspend fun pairingStatus(pending: PendingPairing): Result<PairingStatus> = apiRunCatching {
        val response = transport.get(
            url = "$baseUrl/api/borealis/v1/pairings/${pending.pairingId}",
            headers = bearerHeaders(pending.pollSecret),
        )
        response.requireSuccess("Pairing status")
        decode(response.body, "pairing status")
    }

    suspend fun activatePairing(pending: PendingPairing): Result<ActivatePairingResponse> =
        apiRunCatching {
            val response = transport.post(
                url = "$baseUrl/api/borealis/v1/pairings/${pending.pairingId}/activate",
                headers = bearerHeaders(pending.pollSecret),
                body = "{}",
            )
            response.requireSuccess("Pairing activation")
            decode<ActivatePairingResponse>(response.body, "pairing activation").also { activation ->
                require(activation.signingPublicKeyFormat == SIGNING_KEY_FORMAT) {
                    "The companion returned an unsupported signing-key format."
                }
            }
        }

    suspend fun sync(deviceBearer: String): Result<DeviceSyncResponse> = apiRunCatching {
        require(validDeviceBearer(deviceBearer)) { "Stored device credential is invalid." }
        val response = transport.get(
            url = "$baseUrl/api/borealis/v1/device/sync",
            headers = bearerHeaders(deviceBearer),
        )
        response.requireSuccess("Device sync")
        decode(response.body, "device sync")
    }

    suspend fun report(
        deviceBearer: String,
        jobId: String,
        report: JobReportRequest,
    ): Result<JobReportResponse> = apiRunCatching {
        require(validDeviceBearer(deviceBearer)) { "Stored device credential is invalid." }
        require(validJobId(jobId)) { "Invalid job ID." }
        val response = transport.post(
            url = "$baseUrl/api/borealis/v1/device/jobs/$jobId/report",
            headers = bearerHeaders(deviceBearer),
            body = json.encodeToString(report),
        )
        response.requireSuccess("Job report")
        decode(response.body, "job report")
    }

    suspend fun requestLibraryJob(
        deviceBearer: String,
        packageName: String,
    ): Result<SignedJobEnvelope> = apiRunCatching {
        require(validDeviceBearer(deviceBearer)) { "Stored device credential is invalid." }
        require(validPackageName(packageName)) { "Invalid app package name." }
        val response = transport.post(
            url = "$baseUrl/api/borealis/v1/device/library/$packageName/job",
            headers = bearerHeaders(deviceBearer),
            body = "{}",
        )
        response.requireSuccess("Library install request")
        decode<LibraryJobResponse>(response.body, "library install request").job
    }

    /**
     * Files a user-authored problem report through the shared reporting contract
     * (`POST /api/borealis/v1/reports`). The request body is normalized by
     * [problemReportRequest], so credentials, account identifiers, and raw
     * exception/logcat text never reach this call.
     */
    suspend fun submitProblemReport(
        deviceBearer: String,
        report: ProblemReportRequest,
    ): Result<ProblemReportResponse> = apiRunCatching {
        require(validDeviceBearer(deviceBearer)) { "Stored device credential is invalid." }
        require(report.source == PROBLEM_REPORT_SOURCE_PHONE) { "Unsupported report source." }
        val response = transport.post(
            url = "$baseUrl/api/borealis/v1/reports",
            headers = bearerHeaders(deviceBearer),
            body = reportJson.encodeToString(report),
        )
        response.requireSuccess("Problem report")
        if (response.body.isBlank()) {
            ProblemReportResponse()
        } else {
            decode<ProblemReportResponse>(response.body, "problem report response")
        }
    }

    override fun close() {
        transport.close()
    }

    private inline fun <reified T> decode(body: String, description: String): T = try {
        json.decodeFromString(body)
    } catch (error: SerializationException) {
        throw BorealisApiException("The companion returned an invalid $description.", error)
    }

    private companion object {
        const val SIGNING_KEY_FORMAT = "spki-der-base64url"
    }
}

/**
 * Body of `POST /api/borealis/v1/reports`, shared with the website contract.
 * [diagnostics] is built only from [ProblemReportContext] through
 * [formatProblemReportDiagnostics]; it never carries the device bearer, an
 * account identity, free-form exception text, or logcat.
 */
@Serializable
data class ProblemReportRequest(
    val title: String,
    val description: String,
    val diagnostics: String? = null,
    val source: String = PROBLEM_REPORT_SOURCE_PHONE,
)

/** Mirrors the companion's `201 { ok, number, url }` receipt. */
@Serializable
data class ProblemReportResponse(
    val ok: Boolean = true,
    val number: Long? = null,
    val url: String? = null,
)

/** Coarse, non-identifying phone state that is safe to attach to a report. */
data class ProblemReportContext(
    val appVersion: String,
    val androidSdk: Int,
    val deviceModel: String,
    val paired: Boolean,
    val libraryApps: Int,
    val installedApps: Int,
    val googlePlayConnected: Boolean?,
    val installInProgress: Boolean,
    val uninstallInProgress: Boolean,
)

/** Stages Borealis can report without exposing package names or free-form text. */
enum class ProblemReportStage {
    PAIRING, SYNC, INSTALL, UNINSTALL, GOOGLE_PLAY, REPORT,
}

enum class ProblemReportOutcome {
    STARTED, SUCCEEDED, FAILED, CANCELLED, UNAVAILABLE,
}

/** A bounded, structured event: stage, outcome, and an optional small HTTP-like code. */
data class ProblemReportEvent(
    val stage: ProblemReportStage,
    val outcome: ProblemReportOutcome,
    val code: Int? = null,
    val ageMinutes: Int = 0,
)

/**
 * Ring buffer of recent Borealis activity for user-submitted reports. Records
 * only enum stages/outcomes and a clamped code — never arguments, URLs, error
 * messages, stack traces, or logcat.
 */
object ProblemReportLog {
    private const val CAPACITY = 24
    private val events = ArrayDeque<RecordedEvent>()

    private data class RecordedEvent(
        val stage: ProblemReportStage,
        val outcome: ProblemReportOutcome,
        val code: Int?,
        val atMillis: Long,
    )

    fun record(
        stage: ProblemReportStage,
        outcome: ProblemReportOutcome,
        code: Int? = null,
        nowMillis: Long = System.currentTimeMillis(),
    ) {
        val safeCode = code?.takeIf { it in -16..599 }
        synchronized(events) {
            events.addLast(RecordedEvent(stage, outcome, safeCode, nowMillis))
            while (events.size > CAPACITY) events.removeFirst()
        }
    }

    /** Oldest first, so the newest failure is the last line the user reads. */
    fun recent(nowMillis: Long = System.currentTimeMillis()): List<ProblemReportEvent> =
        synchronized(events) {
            events.map { event ->
                ProblemReportEvent(
                    stage = event.stage,
                    outcome = event.outcome,
                    code = event.code,
                    ageMinutes = ((nowMillis - event.atMillis) / 60_000L)
                        .coerceIn(0L, 99_999L).toInt(),
                )
            }
        }

    fun clear() {
        synchronized(events) { events.clear() }
    }
}

/** Canonical single-line form used both in the preview and in the request body. */
fun problemReportEventLine(event: ProblemReportEvent): String =
    "-${event.ageMinutes.coerceAtLeast(0)}m ${event.stage.name} ${event.outcome.name}" +
        (event.code?.let { " code=$it" } ?: "")

/** Hard limits mirror the shared website contract; the companion re-validates them. */
const val PROBLEM_REPORT_TITLE_LIMIT = 120
const val PROBLEM_REPORT_DESCRIPTION_LIMIT = 4_000
const val PROBLEM_REPORT_DIAGNOSTICS_LIMIT = 8_000

/** The shared contract requires a description long enough to act on. */
const val PROBLEM_REPORT_DESCRIPTION_MIN = 10

const val PROBLEM_REPORT_SOURCE_PHONE = "phone"

private const val REDACTED_CREDENTIAL = "[credential removed]"
private const val REDACTED_EMAIL = "[email removed]"

private val REPORT_CONTROL_CHARS = Regex("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]")
private val REPORT_EMAIL = Regex("[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}")
private val REPORT_DEVICE_BEARER = Regex("brl_device_[A-Za-z0-9_-]+")
private val REPORT_AUTHORIZATION = Regex("(?i)\\bbearer\\s+[^\\s,;]+")
private val REPORT_BLANK_RUNS = Regex("\\n{3,}")
private val REPORT_WHITESPACE_RUNS = Regex("\\s+")

/** Single-line titles never keep line breaks, credentials, or account identifiers. */
fun problemReportTitle(value: String): String =
    reportText(value, PROBLEM_REPORT_TITLE_LIMIT, allowNewlines = false)

/** Multi-line details keep paragraph breaks but no credentials or account identifiers. */
fun problemReportDescription(value: String): String =
    reportText(value, PROBLEM_REPORT_DESCRIPTION_LIMIT, allowNewlines = true)

fun problemReportDiagnostics(value: String): String =
    reportText(value, PROBLEM_REPORT_DIAGNOSTICS_LIMIT, allowNewlines = true)

/**
 * Renders exactly what the user is shown and what is sent. The header is
 * allowlisted local state; [events] come from [ProblemReportLog] and carry only
 * a stage, an outcome, an age, and a clamped code. When the shared size cap trims
 * the list, the newest events survive.
 */
fun formatProblemReportDiagnostics(
    context: ProblemReportContext,
    events: List<ProblemReportEvent> = ProblemReportLog.recent(),
): String {
    val header = listOf(
        "Version: ${reportText(context.appVersion, 40, allowNewlines = false)}",
        "Android SDK ${context.androidSdk} · ${reportText(context.deviceModel, 40, allowNewlines = false)}",
        "Paired on this phone: ${if (context.paired) "yes" else "no"}",
        "Library: ${context.libraryApps.coerceAtLeast(0)} apps, " +
            "${context.installedApps.coerceIn(0, context.libraryApps.coerceAtLeast(0))} installed",
        "Google Play: ${when (context.googlePlayConnected) {
            true -> "connected"
            false -> "not connected"
            null -> "unknown"
        }}",
        "Install in progress: ${if (context.installInProgress) "yes" else "no"}",
        "Uninstall in progress: ${if (context.uninstallInProgress) "yes" else "no"}",
    ).joinToString("\n")
    val eventHeader = "\nRecent Borealis activity (newest last):"
    val budget = PROBLEM_REPORT_DIAGNOSTICS_LIMIT - header.length - eventHeader.length
    val kept = ArrayDeque<String>()
    var used = 0
    for (event in events.asReversed()) {
        val line = problemReportEventLine(event)
        if (used + line.length + 1 > budget) break
        kept.addFirst(line)
        used += line.length + 1
    }
    val body = buildString {
        append(header)
        if (kept.isNotEmpty()) {
            append(eventHeader)
            kept.forEach { append('\n').append(it) }
        }
    }
    return problemReportDiagnostics(body)
}

/** Builds the only request body the phone may post for a report. */
fun problemReportRequest(
    title: String,
    description: String,
    diagnostics: String?,
): ProblemReportRequest = ProblemReportRequest(
    title = problemReportTitle(title),
    description = problemReportDescription(description),
    diagnostics = diagnostics?.let(::problemReportDiagnostics)?.takeIf(String::isNotBlank),
    source = PROBLEM_REPORT_SOURCE_PHONE,
)

/**
 * Mirrors the companion's `issueReportBodySchema` rules so the user sees a local
 * message instead of a round trip. Returns null when the report may be sent.
 */
fun problemReportValidationError(title: String, description: String): String? {
    val cleanTitle = problemReportTitle(title)
    val cleanDescription = problemReportDescription(description)
    return when {
        cleanTitle.length < 3 -> "Enter a title of at least 3 characters."
        cleanTitle.length > PROBLEM_REPORT_TITLE_LIMIT -> "Shorten the title."
        cleanDescription.length < PROBLEM_REPORT_DESCRIPTION_MIN ->
            "Describe the problem in at least $PROBLEM_REPORT_DESCRIPTION_MIN characters."
        cleanDescription.length > PROBLEM_REPORT_DESCRIPTION_LIMIT -> "Shorten the description."
        else -> null
    }
}

/**
 * Turns a failed submission into a fixed, user-facing message. Raw exception
 * text is deliberately dropped: transport errors can embed the companion URL or
 * a signed delivery link.
 */
fun problemReportFailureMessage(error: Throwable): String {
    val status = (error as? BorealisApiException)?.httpStatus
    return when {
        status == 401 -> "This phone is no longer paired. Pair again, then resend."
        status == 400 -> "The companion rejected the report. Check the title and details."
        status == 413 -> "The report is too large. Shorten the details."
        status == 429 -> "Too many reports were sent. Try again in an hour."
        status == 503 -> "Reporting is not configured on this companion."
        status == 502 -> "GitHub could not file the report. Try again later."
        status != null -> "The companion could not accept the report (HTTP $status). Try again."
        else -> "Could not reach the companion. Check your connection and try again."
    }
}

private fun reportText(value: String, limit: Int, allowNewlines: Boolean): String {
    val withoutControl = REPORT_CONTROL_CHARS.replace(value, "")
    val normalized = if (allowNewlines) {
        withoutControl.replace("\r\n", "\n").replace('\r', '\n')
            .replace(REPORT_BLANK_RUNS, "\n\n")
    } else {
        withoutControl.replace(REPORT_WHITESPACE_RUNS, " ")
    }
    val redacted = REPORT_EMAIL.replace(
        REPORT_DEVICE_BEARER.replace(
            REPORT_AUTHORIZATION.replace(normalized, "Bearer $REDACTED_CREDENTIAL"),
            REDACTED_CREDENTIAL,
        ),
        REDACTED_EMAIL,
    )
    return reportTruncate(redacted.trim(), limit)
}

private fun reportTruncate(value: String, limit: Int): String {
    if (limit <= 0) return ""
    if (value.length <= limit) return value
    // Reserve one character so the ellipsis keeps the result within the cap.
    val reserve = limit - 1
    val end = if (reserve > 0 && Character.isHighSurrogate(value[reserve - 1])) reserve - 1 else reserve
    return value.substring(0, end).trimEnd() + "…"
}

data class BorealisHttpResponse(val status: Int, val body: String)

interface BorealisHttpTransport {
    suspend fun get(url: String, headers: Map<String, String> = emptyMap()): BorealisHttpResponse
    suspend fun post(
        url: String,
        headers: Map<String, String> = emptyMap(),
        body: String,
    ): BorealisHttpResponse
    fun close()
}

private class KtorBorealisHttpTransport : BorealisHttpTransport {
    private val client = HttpClient(OkHttp) {
        expectSuccess = false
        install(HttpTimeout) {
            connectTimeoutMillis = 10_000L
            requestTimeoutMillis = 30_000L
            socketTimeoutMillis = 30_000L
        }
    }

    override suspend fun get(url: String, headers: Map<String, String>): BorealisHttpResponse {
        val response = client.get(url) {
            accept(ContentType.Application.Json)
            headers.forEach { (name, value) -> header(name, value) }
        }
        return BorealisHttpResponse(response.status.value, response.bodyAsText())
    }

    override suspend fun post(
        url: String,
        headers: Map<String, String>,
        body: String,
    ): BorealisHttpResponse {
        val response = client.post(url) {
            accept(ContentType.Application.Json)
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            headers.forEach { (name, value) -> header(name, value) }
            setBody(body)
        }
        return BorealisHttpResponse(response.status.value, response.bodyAsText())
    }

    override fun close() {
        client.close()
    }
}

class BorealisApiException(
    message: String,
    cause: Throwable? = null,
    val httpStatus: Int? = null,
) : Exception(message, cause)

fun normalizeInstanceUrl(value: String): String {
    val raw = value.trim().trimEnd('/')
    val uri = runCatching { URI(raw) }.getOrElse {
        throw IllegalArgumentException("Enter a valid companion URL.")
    }
    require(uri.scheme == "https" || uri.scheme == "http") {
        "The companion URL must use HTTP or HTTPS."
    }
    require(!uri.host.isNullOrBlank()) { "The companion URL needs a host." }
    require(uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null) {
        "The companion URL cannot contain credentials, a query, or a fragment."
    }
    return uri.toString().trimEnd('/')
}

fun generateDeviceBearer(random: SecureRandom = SecureRandom()): String =
    DEVICE_BEARER_PREFIX + Base64.getUrlEncoder().withoutPadding()
        .encodeToString(ByteArray(32).also(random::nextBytes))

fun deviceBearerDigest(deviceBearer: String): String {
    require(validDeviceBearer(deviceBearer)) { "Invalid device credential." }
    return MessageDigest.getInstance("SHA-256")
        .digest(deviceBearer.toByteArray(StandardCharsets.UTF_8))
        .joinToString("") { byte -> "%02x".format(byte) }
}

fun validDeviceBearer(value: String): Boolean {
    val payload = value.removePrefix(DEVICE_BEARER_PREFIX)
    return value.startsWith(DEVICE_BEARER_PREFIX) &&
        payload.length == 43 &&
        payload.all { character ->
            character in 'A'..'Z' || character in 'a'..'z' ||
                character in '0'..'9' || character == '-' || character == '_'
        }
}

private fun validJobId(value: String): Boolean =
    value.length in 16..128 && value.all { it.isLetterOrDigit() || it == '-' || it == '_' }

internal fun validPackageName(value: String): Boolean =
    Regex("^[a-zA-Z][a-zA-Z0-9_]*(\\.[a-zA-Z][a-zA-Z0-9_]*)+$").matches(value)

private fun bearerHeaders(value: String): Map<String, String> =
    mapOf(HttpHeaders.Authorization to "Bearer $value")

private fun BorealisHttpResponse.requireSuccess(operation: String) {
    if (status !in 200..299) {
        val detail = runCatching {
            Json.parseToJsonElement(body).toString().take(300)
        }.getOrDefault("")
        throw BorealisApiException(
            if (detail.isBlank()) "$operation failed (HTTP $status)."
            else "$operation failed (HTTP $status): $detail",
            httpStatus = status,
        )
    }
}

private suspend fun <T> apiRunCatching(block: suspend () -> T): Result<T> = try {
    Result.success(block())
} catch (error: CancellationException) {
    throw error
} catch (error: Exception) {
    Result.failure(error)
}

private const val DEVICE_BEARER_PREFIX = "brl_device_"
