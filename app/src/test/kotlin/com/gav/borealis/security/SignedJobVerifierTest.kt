package com.gav.borealis.security

import com.gav.borealis.data.BorealisSession
import com.gav.borealis.data.SignedJobEnvelope
import java.nio.charset.StandardCharsets
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.Signature
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import java.util.Base64
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

class SignedJobVerifierTest {
    private val now = Instant.parse("2026-09-25T18:00:00Z")
    private val keyPair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
    private val publicKey = Base64.getUrlEncoder().withoutPadding().encodeToString(keyPair.public.encoded)
    private val fingerprint = MessageDigest.getInstance("SHA-256").digest(keyPair.public.encoded)
        .joinToString("") { "%02x".format(it) }
    private val keyId = "ed25519:${fingerprint.take(24)}"
    private val session = BorealisSession(
        instanceUrl = "https://borealis.example.test",
        deviceId = "device_1234567890",
        deviceBearer = "brl_device_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        keyId = keyId,
        signingPublicKey = publicKey,
    )
    private val verifier = SignedJobVerifier(Clock.fixed(now, ZoneOffset.UTC))

    @Test
    fun `verifies exact payload bytes and validates binding`() {
        val payload = payload(deviceId = session.deviceId)
        val job = verifier.verify(session, envelope(payload))

        assertEquals("com.example.bank", job.packageName)
        assertEquals(session.deviceId, job.deviceId)
    }

    @Test
    fun `verifies the exact companion-generated protocol fixture`() {
        val fixture = checkNotNull(javaClass.getResourceAsStream("/signed-install-job.json"))
            .bufferedReader(Charsets.UTF_8).use { Json.parseToJsonElement(it.readText()).jsonObject }
        fun value(name: String) = fixture.getValue(name).jsonPrimitive.content
        val paired = session.copy(
            deviceId = value("deviceId"),
            keyId = value("keyId"),
            signingPublicKey = value("publicKeySpki"),
        )
        val fromCompanion = SignedJobEnvelope(
            keyId = value("keyId"), payload = value("payload"), signature = value("signature"),
        )
        val fixtureVerifier = SignedJobVerifier(Clock.fixed(Instant.parse(value("clock")), ZoneOffset.UTC))

        val job = fixtureVerifier.verify(paired, fromCompanion)

        assertEquals("com.example.bank", job.packageName)
        assertEquals(paired.deviceId, job.deviceId)
        assertFailsWith<IllegalArgumentException> {
            fixtureVerifier.verify(paired, fromCompanion.copy(payload = fromCompanion.payload + " "))
        }
    }

    @Test
    fun `rejects payload modified after signing`() {
        val signed = envelope(payload(deviceId = session.deviceId))
        val changed = signed.copy(payload = signed.payload.replace("Example Bank", "Other App"))

        assertFailsWith<IllegalArgumentException> { verifier.verify(session, changed) }
    }

    @Test
    fun `rejects a full hash where the protocol requires an algorithm-qualified key ID`() {
        val signed = envelope(payload(deviceId = session.deviceId)).copy(keyId = fingerprint)

        assertFailsWith<IllegalArgumentException> {
            verifier.verify(session.copy(keyId = fingerprint), signed)
        }
    }

    @Test
    fun `rejects malformed key IDs`() {
        val signed = envelope(payload(deviceId = session.deviceId))
        val malformed = listOf(
            "ed25519:${"a".repeat(23)}", "ed25519:${"a".repeat(25)}",
            "ed25519:${"A".repeat(24)}", "rsa:${fingerprint.take(24)}",
        )
        for (invalid in malformed) {
            assertFailsWith<IllegalArgumentException> {
                verifier.verify(session.copy(keyId = invalid), signed.copy(keyId = invalid))
            }
        }
    }

    @Test
    fun `rejects an unknown envelope key ID`() {
        val signed = envelope(payload(deviceId = session.deviceId))

        assertFailsWith<IllegalArgumentException> {
            verifier.verify(session, signed.copy(keyId = "ed25519:${"0".repeat(24)}"))
        }
    }

    @Test
    fun `rejects a different pinned public key even when the key ID format is valid`() {
        val otherKey = KeyPairGenerator.getInstance("Ed25519").generateKeyPair().public.encoded
        val changedSession = session.copy(
            signingPublicKey = Base64.getUrlEncoder().withoutPadding().encodeToString(otherKey),
        )

        assertFailsWith<IllegalArgumentException> {
            verifier.verify(changedSession, envelope(payload(deviceId = session.deviceId)))
        }
    }

    @Test
    fun `rejects malformed or wrong-algorithm SPKI keys even with matching key IDs`() {
        val spki = keyPair.public.encoded
        val wrongAlgorithm = spki.copyOf().apply { this[8] = 0x6e } // X25519, not Ed25519
        val wrongBitString = spki.copyOf().apply { this[11] = 1 }
        for (invalid in listOf(wrongAlgorithm, wrongBitString, spki.copyOf(43), spki + byteArrayOf(0))) {
            val invalidId = "ed25519:" + MessageDigest.getInstance("SHA-256").digest(invalid)
                .joinToString("") { "%02x".format(it) }.take(24)
            val paired = session.copy(
                keyId = invalidId,
                signingPublicKey = Base64.getUrlEncoder().withoutPadding().encodeToString(invalid),
            )
            val error = assertFailsWith<IllegalArgumentException> {
                verifier.verify(paired, envelope(payload(session.deviceId)).copy(keyId = invalidId))
            }
            assertEquals("The companion signing public key is not an Ed25519 SPKI key.", error.message)
        }
    }

    @Test
    fun `rejects invalid signature lengths`() {
        val signed = envelope(payload(session.deviceId))
        for (length in listOf(0, 63, 65)) {
            val signature = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(length))
            val error = assertFailsWith<IllegalArgumentException> {
                verifier.verify(session, signed.copy(signature = signature))
            }
            assertEquals("The companion job signature is invalid.", error.message)
        }
    }

    @Test
    fun `rejects job for another device`() {
        val signed = envelope(payload(deviceId = "device_abcdefghij"))

        assertFailsWith<IllegalArgumentException> { verifier.verify(session, signed) }
    }

    @Test
    fun `rejects expired job`() {
        val payload = payload(
            deviceId = session.deviceId,
            issuedAt = "2026-09-25T16:00:00Z",
            expiresAt = "2026-09-25T17:00:00Z",
        )

        assertFailsWith<IllegalArgumentException> { verifier.verify(session, envelope(payload)) }
    }

    private fun envelope(payload: String): SignedJobEnvelope {
        val signer = Signature.getInstance("Ed25519")
        signer.initSign(keyPair.private)
        signer.update(payload.toByteArray(StandardCharsets.UTF_8))
        return SignedJobEnvelope(
            keyId = keyId,
            payload = payload,
            signature = Base64.getUrlEncoder().withoutPadding().encodeToString(signer.sign()),
        )
    }

    private fun payload(
        deviceId: String,
        issuedAt: String = "2026-09-25T17:55:00Z",
        expiresAt: String = "2026-09-25T18:25:00Z",
    ): String =
        """{"schemaVersion":1,"jobId":"job_1234567890123456","deviceId":"$deviceId","action":"install_or_update","packageName":"com.example.bank","displayName":"Example Bank","acceptedSignerSha256":["${"a".repeat(64)}"],"issuedAt":"$issuedAt","expiresAt":"$expiresAt","nonce":"nonce_123456789012"}"""
}
