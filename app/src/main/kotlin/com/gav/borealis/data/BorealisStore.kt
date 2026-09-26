package com.gav.borealis.data

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import kotlinx.coroutines.flow.first

class BorealisStore(private val dataStore: DataStore<Preferences>) {
    suspend fun loadSession(): BorealisSession? {
        val values = dataStore.data.first()
        val instanceUrl = values[INSTANCE_URL] ?: return null
        val deviceId = values[DEVICE_ID] ?: return null
        val deviceBearer = values[DEVICE_BEARER] ?: return null
        val keyId = values[KEY_ID] ?: return null
        val signingPublicKey = values[SIGNING_PUBLIC_KEY] ?: return null
        if (!validDeviceBearer(deviceBearer)) return null
        return BorealisSession(instanceUrl, deviceId, deviceBearer, keyId, signingPublicKey)
    }

    suspend fun saveSession(session: BorealisSession) {
        require(validDeviceBearer(session.deviceBearer)) { "Invalid device credential." }
        dataStore.edit { values ->
            values[INSTANCE_URL] = normalizeInstanceUrl(session.instanceUrl)
            values[DEVICE_ID] = session.deviceId
            values[DEVICE_BEARER] = session.deviceBearer
            values[KEY_ID] = session.keyId
            values[SIGNING_PUBLIC_KEY] = session.signingPublicKey
        }
    }

    suspend fun loadPending(): PendingPairingSession? {
        val values = dataStore.data.first()
        val instanceUrl = values[PENDING_INSTANCE_URL] ?: return null
        val deviceBearer = values[PENDING_DEVICE_BEARER] ?: return null
        val pairingId = values[PENDING_PAIRING_ID] ?: return null
        val userCode = values[PENDING_USER_CODE] ?: return null
        val pollSecret = values[PENDING_POLL_SECRET] ?: return null
        val verificationUrl = values[PENDING_VERIFICATION_URL] ?: return null
        val expiresAt = values[PENDING_EXPIRES_AT] ?: return null
        return PendingPairingSession(
            instanceUrl = instanceUrl,
            deviceBearer = deviceBearer,
            pairing = PendingPairing(pairingId, userCode, pollSecret, verificationUrl, expiresAt),
        )
    }

    suspend fun savePending(pending: PendingPairingSession) {
        dataStore.edit { values ->
            values[PENDING_INSTANCE_URL] = normalizeInstanceUrl(pending.instanceUrl)
            values[PENDING_DEVICE_BEARER] = pending.deviceBearer
            values[PENDING_PAIRING_ID] = pending.pairing.pairingId
            values[PENDING_USER_CODE] = pending.pairing.userCode
            values[PENDING_POLL_SECRET] = pending.pairing.pollSecret
            values[PENDING_VERIFICATION_URL] = pending.pairing.verificationUrl
            values[PENDING_EXPIRES_AT] = pending.pairing.expiresAt
        }
    }

    suspend fun clearPending() {
        dataStore.edit { values -> PENDING_KEYS.forEach(values::remove) }
    }

    suspend fun forget() {
        dataStore.edit { it.clear() }
    }

    suspend fun lastRevision(): Long = dataStore.data.first()[LAST_REVISION] ?: 0L

    suspend fun saveRevision(revision: Long) {
        dataStore.edit { it[LAST_REVISION] = revision.coerceAtLeast(0L) }
    }

    suspend fun loadPendingInstall(): PendingInstall? {
        val values = dataStore.data.first()
        val jobId = values[PENDING_INSTALL_JOB_ID] ?: return null
        val sessionId = values[PENDING_INSTALL_SESSION_ID] ?: return null
        val packageName = values[PENDING_INSTALL_PACKAGE] ?: return null
        val versionCode = values[PENDING_INSTALL_VERSION_CODE] ?: return null
        return PendingInstall(jobId, sessionId, packageName, versionCode)
    }

    suspend fun savePendingInstall(pending: PendingInstall) {
        dataStore.edit { values ->
            values[PENDING_INSTALL_JOB_ID] = pending.jobId
            values[PENDING_INSTALL_SESSION_ID] = pending.sessionId
            values[PENDING_INSTALL_PACKAGE] = pending.packageName
            values[PENDING_INSTALL_VERSION_CODE] = pending.versionCode
        }
    }

    suspend fun clearPendingInstall() {
        dataStore.edit { values ->
            values.remove(PENDING_INSTALL_JOB_ID)
            values.remove(PENDING_INSTALL_SESSION_ID)
            values.remove(PENDING_INSTALL_PACKAGE)
            values.remove(PENDING_INSTALL_VERSION_CODE)
        }
    }

    private companion object {
        val INSTANCE_URL = stringPreferencesKey("instance_url")
        val DEVICE_ID = stringPreferencesKey("device_id")
        val DEVICE_BEARER = stringPreferencesKey("device_bearer")
        val KEY_ID = stringPreferencesKey("key_id")
        val SIGNING_PUBLIC_KEY = stringPreferencesKey("signing_public_key")
        val LAST_REVISION = longPreferencesKey("last_revision")
        val PENDING_INSTALL_JOB_ID = stringPreferencesKey("pending_install_job_id")
        val PENDING_INSTALL_SESSION_ID = intPreferencesKey("pending_install_session_id")
        val PENDING_INSTALL_PACKAGE = stringPreferencesKey("pending_install_package")
        val PENDING_INSTALL_VERSION_CODE = longPreferencesKey("pending_install_version_code")
        val PENDING_INSTANCE_URL = stringPreferencesKey("pending_instance_url")
        val PENDING_DEVICE_BEARER = stringPreferencesKey("pending_device_bearer")
        val PENDING_PAIRING_ID = stringPreferencesKey("pending_pairing_id")
        val PENDING_USER_CODE = stringPreferencesKey("pending_user_code")
        val PENDING_POLL_SECRET = stringPreferencesKey("pending_poll_secret")
        val PENDING_VERIFICATION_URL = stringPreferencesKey("pending_verification_url")
        val PENDING_EXPIRES_AT = stringPreferencesKey("pending_expires_at")
        val PENDING_KEYS = listOf(
            PENDING_INSTANCE_URL,
            PENDING_DEVICE_BEARER,
            PENDING_PAIRING_ID,
            PENDING_USER_CODE,
            PENDING_POLL_SECRET,
            PENDING_VERIFICATION_URL,
            PENDING_EXPIRES_AT,
        )
    }
}

data class PendingInstall(
    val jobId: String,
    val sessionId: Int,
    val packageName: String,
    val versionCode: Long,
)
