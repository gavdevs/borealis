package com.gav.borealis.data

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

class BorealisApiException(message: String, cause: Throwable? = null) : Exception(message, cause)

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
