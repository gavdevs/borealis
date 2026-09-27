package com.loosewire.borealis.security

import com.loosewire.borealis.data.BorealisSession
import com.loosewire.borealis.data.SignedInstallJob
import com.loosewire.borealis.data.SignedJobEnvelope
import com.google.crypto.tink.subtle.Ed25519Verify
import java.nio.charset.StandardCharsets
import java.security.GeneralSecurityException
import java.security.MessageDigest
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.util.Base64
import kotlinx.serialization.SerializationException
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json

class SignedJobVerifier(
    private val clock: Clock = Clock.systemUTC(),
) {
    private val json = Json {
        ignoreUnknownKeys = false
        explicitNulls = false
    }

    fun verify(session: BorealisSession, envelope: SignedJobEnvelope): SignedInstallJob {
        require(envelope.keyId == session.keyId) { "The job used an unknown signing key." }
        require(validKeyId(envelope.keyId)) { "The stored signing key ID is invalid." }

        val publicKeyBytes = decodeBase64Url(session.signingPublicKey, "signing public key")
        // Match the companion's protocol-v1 ID; still verify with the full key.
        val computedKeyId = "ed25519:${sha256Hex(publicKeyBytes).take(24)}"
        require(MessageDigest.isEqual(computedKeyId.toByteArray(), session.keyId.toByteArray())) {
            "The companion signing key no longer matches its key ID."
        }

        // RFC 8410: Ed25519 OID, absent parameters, then exactly 32 key bytes.
        require(
            publicKeyBytes.size == ED25519_SPKI_PREFIX.size + 32 &&
                publicKeyBytes.copyOfRange(0, ED25519_SPKI_PREFIX.size).contentEquals(ED25519_SPKI_PREFIX),
        ) {
            "The companion signing public key is not an Ed25519 SPKI key."
        }
        val publicKey = publicKeyBytes.copyOfRange(ED25519_SPKI_PREFIX.size, publicKeyBytes.size)
        try {
            // The LP3's Android provider cannot import Ed25519 SPKI keys.
            Ed25519Verify(publicKey).verify(
                decodeBase64Url(envelope.signature, "job signature"),
                envelope.payload.toByteArray(StandardCharsets.UTF_8),
            )
        } catch (error: GeneralSecurityException) {
            throw IllegalArgumentException("The companion job signature is invalid.", error)
        }

        val job = try {
            json.decodeFromString<SignedInstallJob>(envelope.payload)
        } catch (error: SerializationException) {
            throw IllegalArgumentException("The signed job payload is invalid.", error)
        }
        validatePayload(session, job)
        return job
    }

    private fun validatePayload(session: BorealisSession, job: SignedInstallJob) {
        require(job.schemaVersion == 1) { "Unsupported Borealis job schema." }
        require(job.deviceId == session.deviceId) { "The job belongs to another device." }
        require(job.action == "install_or_update") { "Unsupported Borealis job action." }
        require(PACKAGE_NAME.matches(job.packageName)) { "The job package name is invalid." }
        require(job.displayName.isNotBlank() && job.displayName.length <= 120) {
            "The job display name is invalid."
        }
        require(ID.matches(job.jobId) && ID.matches(job.nonce)) { "The job identifier is invalid." }
        require(job.acceptedSignerSha256.distinct().size == job.acceptedSignerSha256.size) {
            "The job contains duplicate signer fingerprints."
        }
        require(job.acceptedSignerSha256.all(SHA256::matches)) {
            "The job contains an invalid signer fingerprint."
        }

        val now = clock.instant()
        val issuedAt = parseInstant(job.issuedAt, "issue time")
        val expiresAt = parseInstant(job.expiresAt, "expiry time")
        require(!expiresAt.isBefore(now)) { "The companion job has expired." }
        require(!issuedAt.isAfter(now.plus(MAX_CLOCK_SKEW))) { "The companion job is not valid yet." }
        require(expiresAt.isAfter(issuedAt)) { "The companion job has an invalid lifetime." }
        require(Duration.between(issuedAt, expiresAt) <= MAX_JOB_LIFETIME) {
            "The companion job lifetime is too long."
        }
    }

    private fun parseInstant(value: String, label: String): Instant =
        runCatching { Instant.parse(value) }
            .getOrElse { throw IllegalArgumentException("The job $label is invalid.") }

    private fun decodeBase64Url(value: String, label: String): ByteArray = try {
        Base64.getUrlDecoder().decode(value)
    } catch (error: IllegalArgumentException) {
        throw IllegalArgumentException("The $label is not valid base64url.", error)
    }

    private fun sha256Hex(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
        .digest(bytes)
        .joinToString("") { byte -> "%02x".format(byte) }

    private fun validKeyId(value: String): Boolean = KEY_ID.matches(value)

    private companion object {
        val ED25519_SPKI_PREFIX = byteArrayOf(
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
        )
        val PACKAGE_NAME = Regex("^[a-zA-Z][a-zA-Z0-9_]*(\\.[a-zA-Z][a-zA-Z0-9_]*)+$")
        val ID = Regex("^[A-Za-z0-9_-]{16,128}$")
        val KEY_ID = Regex("^ed25519:[0-9a-f]{24}$")
        val SHA256 = Regex("^[0-9a-f]{64}$")
        val MAX_CLOCK_SKEW: Duration = Duration.ofMinutes(5)
        val MAX_JOB_LIFETIME: Duration = Duration.ofHours(1)
    }
}
