package com.gav.borealis.security

import com.gav.borealis.data.BorealisSession
import com.gav.borealis.data.SignedInstallJob
import com.gav.borealis.data.SignedJobEnvelope
import java.nio.charset.StandardCharsets
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
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
        val computedKeyId = sha256Hex(publicKeyBytes)
        require(MessageDigest.isEqual(computedKeyId.toByteArray(), session.keyId.toByteArray())) {
            "The companion signing key no longer matches its key ID."
        }

        val publicKey = KeyFactory.getInstance("Ed25519")
            .generatePublic(X509EncodedKeySpec(publicKeyBytes))
        val signature = Signature.getInstance("Ed25519")
        signature.initVerify(publicKey)
        signature.update(envelope.payload.toByteArray(StandardCharsets.UTF_8))
        require(signature.verify(decodeBase64Url(envelope.signature, "job signature"))) {
            "The companion job signature is invalid."
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

    private fun validKeyId(value: String): Boolean = SHA256.matches(value)

    private companion object {
        val PACKAGE_NAME = Regex("^[a-zA-Z][a-zA-Z0-9_]*(\\.[a-zA-Z][a-zA-Z0-9_]*)+$")
        val ID = Regex("^[A-Za-z0-9_-]{16,128}$")
        val SHA256 = Regex("^[0-9a-f]{64}$")
        val MAX_CLOCK_SKEW: Duration = Duration.ofMinutes(5)
        val MAX_JOB_LIFETIME: Duration = Duration.ofHours(1)
    }
}
