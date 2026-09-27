package com.thelightphone.sdk.auth

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import com.thelightphone.sdk.SealedLightContext
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

class GooglePlayStoredCredential internal constructor(val email: String, val token: String) {
    override fun toString(): String = "GooglePlayStoredCredential([redacted])"
}

class GooglePlayCredentialStoreException(message: String) : Exception(message)

fun SealedLightContext.googlePlayCredentialStore(): GooglePlayCredentialStore =
    GooglePlayCredentialStore(androidContext.applicationContext)

/** Stores only the post-login Play credential; never a Google password. */
class GooglePlayCredentialStore internal constructor(private val context: Context) {
    private val file: AtomicFile
        get() = AtomicFile(File(context.noBackupFilesDir, "google-play-credential.v1"))
    private val alias: String
        get() = "${context.packageName}.google-play-credential.v1"
    private val purpose: ByteArray
        get() = "${context.packageName}:google-play-credential:v1".toByteArray(Charsets.UTF_8)

    suspend fun put(email: String, token: String) = withContext(Dispatchers.IO) {
        STORE_LOCK.withLock {
            try {
                val encrypted = GooglePlayCredentialCodec.encrypt(email, token, getKey(create = true), purpose)
                val target = file
                val output = target.startWrite()
                try {
                    output.write(encrypted)
                    target.finishWrite(output)
                } catch (error: Exception) {
                    target.failWrite(output)
                    throw error
                }
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                throw GooglePlayCredentialStoreException("Google Play credentials could not be saved securely.")
            }
        }
    }

    suspend fun get(): GooglePlayStoredCredential? = withContext(Dispatchers.IO) {
        STORE_LOCK.withLock {
            val target = file
            if (!target.baseFile.exists()) return@withLock null
            try {
                val envelope = target.openRead().use { input ->
                    val bytes = ByteArray(GooglePlayCredentialCodec.MAX_ENVELOPE_BYTES + 1)
                    var count = 0
                    while (count < bytes.size) {
                        val read = input.read(bytes, count, bytes.size - count)
                        if (read < 0) break
                        count += read
                    }
                    require(count <= GooglePlayCredentialCodec.MAX_ENVELOPE_BYTES)
                    bytes.copyOf(count)
                }
                GooglePlayCredentialCodec.decrypt(envelope, getKey(create = false), purpose)
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                throw GooglePlayCredentialStoreException("Saved Google Play credentials are unavailable. Disconnect and sign in again.")
            }
        }
    }

    suspend fun clear() = withContext(Dispatchers.IO) {
        STORE_LOCK.withLock {
            try {
                // Destroying the key also invalidates any recoverable ciphertext.
                keyStore().deleteEntry(alias)
                file.delete()
                check(!file.baseFile.exists())
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                throw GooglePlayCredentialStoreException("Google Play credentials could not be removed.")
            }
        }
    }

    private fun getKey(create: Boolean): SecretKey {
        val stored = keyStore().getKey(alias, null)
        if (stored != null) return stored as SecretKey
        check(create)
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(
                KeyGenParameterSpec.Builder(
                    alias,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setKeySize(256)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setRandomizedEncryptionRequired(true)
                    .build(),
            )
        }.generateKey()
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private companion object {
        val STORE_LOCK = Mutex()
    }
}

internal object GooglePlayCredentialCodec {
    const val MAX_ENVELOPE_BYTES = 70_000
    private const val VERSION = 1
    private const val IV_BYTES = 12
    private const val TAG_BITS = 128

    fun encrypt(email: String, token: String, key: SecretKey, purpose: ByteArray): ByteArray {
        require(isCredentialEmail(email) && isCredentialToken(token))
        val plaintext = ByteArrayOutputStream().use { bytes ->
            DataOutputStream(bytes).use { output ->
                output.writeUTF(email)
                output.writeUTF(token)
            }
            bytes.toByteArray()
        }
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key)
            cipher.updateAAD(purpose)
            require(cipher.iv.size == IV_BYTES)
            byteArrayOf(VERSION.toByte()) + cipher.iv + cipher.doFinal(plaintext)
        } finally {
            plaintext.fill(0)
        }
    }

    fun decrypt(envelope: ByteArray, key: SecretKey, purpose: ByteArray): GooglePlayStoredCredential {
        require(envelope.size in (1 + IV_BYTES + TAG_BITS / 8)..MAX_ENVELOPE_BYTES)
        require(envelope[0].toInt() == VERSION)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, envelope, 1, IV_BYTES))
        cipher.updateAAD(purpose)
        val plaintext = cipher.doFinal(envelope, 1 + IV_BYTES, envelope.size - 1 - IV_BYTES)
        return try {
            DataInputStream(ByteArrayInputStream(plaintext)).use { input ->
                val email = input.readUTF()
                val token = input.readUTF()
                require(input.available() == 0 && isCredentialEmail(email) && isCredentialToken(token))
                GooglePlayStoredCredential(email, token)
            }
        } finally {
            plaintext.fill(0)
        }
    }
}
