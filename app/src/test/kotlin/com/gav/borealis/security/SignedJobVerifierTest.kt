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

class SignedJobVerifierTest {
    private val now = Instant.parse("2026-09-25T18:00:00Z")
    private val keyPair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
    private val publicKey = Base64.getUrlEncoder().withoutPadding().encodeToString(keyPair.public.encoded)
    private val keyId = MessageDigest.getInstance("SHA-256").digest(keyPair.public.encoded)
        .joinToString("") { "%02x".format(it) }
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
    fun `rejects payload modified after signing`() {
        val signed = envelope(payload(deviceId = session.deviceId))
        val changed = signed.copy(payload = signed.payload.replace("Example Bank", "Other App"))

        assertFailsWith<IllegalArgumentException> { verifier.verify(session, changed) }
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
