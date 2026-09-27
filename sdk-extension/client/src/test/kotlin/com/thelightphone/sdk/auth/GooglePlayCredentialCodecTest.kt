package com.thelightphone.sdk.auth

import javax.crypto.AEADBadTagException
import javax.crypto.KeyGenerator
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse

class GooglePlayCredentialCodecTest {
    private val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    private val purpose = "com.example.tool:google-play-credential:v1".toByteArray()

    @Test
    fun `credential round trip is encrypted and debug output redacted`() {
        val envelope = GooglePlayCredentialCodec.encrypt("person@example.test", "fake-secret", key, purpose)
        assertFalse(envelope.toString(Charsets.UTF_8).contains("person@example.test"))
        assertFalse(envelope.toString(Charsets.UTF_8).contains("fake-secret"))
        val credential = GooglePlayCredentialCodec.decrypt(envelope, key, purpose)
        assertEquals("person@example.test", credential.email)
        assertEquals("fake-secret", credential.token)
        assertEquals("GooglePlayStoredCredential([redacted])", credential.toString())
    }

    @Test
    fun `encryption uses fresh random IVs`() {
        val first = GooglePlayCredentialCodec.encrypt("person@example.test", "fake-secret", key, purpose)
        val second = GooglePlayCredentialCodec.encrypt("person@example.test", "fake-secret", key, purpose)
        assertFalse(first.contentEquals(second))
    }

    @Test
    fun `tampered ciphertext is rejected`() {
        val envelope = GooglePlayCredentialCodec.encrypt("person@example.test", "fake-secret", key, purpose)
        envelope[envelope.lastIndex] = (envelope.last().toInt() xor 1).toByte()
        assertFailsWith<AEADBadTagException> { GooglePlayCredentialCodec.decrypt(envelope, key, purpose) }
    }

    @Test
    fun `different application purpose cannot decrypt`() {
        val envelope = GooglePlayCredentialCodec.encrypt("person@example.test", "fake-secret", key, purpose)
        assertFailsWith<AEADBadTagException> { GooglePlayCredentialCodec.decrypt(envelope, key, "other".toByteArray()) }
    }

    @Test
    fun `different key cannot decrypt`() {
        val envelope = GooglePlayCredentialCodec.encrypt("person@example.test", "fake-secret", key, purpose)
        val otherKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        assertFailsWith<AEADBadTagException> { GooglePlayCredentialCodec.decrypt(envelope, otherKey, purpose) }
    }

    @Test
    fun `unknown envelope version and invalid bounds are rejected`() {
        val envelope = GooglePlayCredentialCodec.encrypt("person@example.test", "fake-secret", key, purpose)
        envelope[0] = 2
        assertFailsWith<IllegalArgumentException> { GooglePlayCredentialCodec.decrypt(envelope, key, purpose) }
        assertFailsWith<IllegalArgumentException> { GooglePlayCredentialCodec.decrypt(byteArrayOf(1), key, purpose) }
        assertFailsWith<IllegalArgumentException> {
            GooglePlayCredentialCodec.decrypt(ByteArray(GooglePlayCredentialCodec.MAX_ENVELOPE_BYTES + 1), key, purpose)
        }
    }

    @Test
    fun `empty or oversized fields cannot be stored`() {
        assertFailsWith<IllegalArgumentException> { GooglePlayCredentialCodec.encrypt("", "fake-secret", key, purpose) }
        assertFailsWith<IllegalArgumentException> { GooglePlayCredentialCodec.encrypt("person@example.test", "", key, purpose) }
        assertFailsWith<IllegalArgumentException> {
            GooglePlayCredentialCodec.encrypt("person@example.test", "x".repeat(16_385), key, purpose)
        }
    }
}
