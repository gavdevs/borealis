package com.loosewire.borealis.data

import kotlinx.serialization.Serializable

@Serializable
data class CreatePairingRequest(
    val deviceLabel: String,
    val deviceBearerDigest: String,
)

@Serializable
data class PendingPairing(
    val pairingId: String,
    val userCode: String,
    val pollSecret: String,
    val verificationUrl: String,
    val expiresAt: String,
)

@Serializable
data class PairingStatus(
    val state: String,
    val deviceLabel: String,
    val expiresAt: String,
) {
    val isApproved: Boolean get() = state == "approved"
    val isTerminal: Boolean get() = state == "activated" || state == "expired"
}

@Serializable
data class ActivatePairingResponse(
    val deviceId: String,
    val keyId: String,
    val signingPublicKey: String,
    val signingPublicKeyFormat: String,
)

data class BorealisSession(
    val instanceUrl: String,
    val deviceId: String,
    val deviceBearer: String,
    val keyId: String,
    val signingPublicKey: String,
)

data class PendingPairingSession(
    val instanceUrl: String,
    val deviceBearer: String,
    val pairing: PendingPairing,
)

@Serializable
data class SignedJobEnvelope(
    val keyId: String,
    val payload: String,
    val signature: String,
)

@Serializable
data class DeviceSyncResponse(
    val deviceId: String,
    val deviceLabel: String,
    val revision: Long,
    val serverTime: String,
    val jobs: List<SignedJobEnvelope> = emptyList(),
    val library: List<LibraryApp> = emptyList(),
)

@Serializable
data class LibraryApp(
    val packageName: String,
    val displayName: String,
)

@Serializable
data class LibraryJobResponse(val job: SignedJobEnvelope)

enum class LibraryAppStatus {
    NotInstalled,
    UpToDate,
    UpdateAvailable,
    UpdateStatusUnknown,
}

data class LibraryAppState(
    val app: LibraryApp,
    val installedVersionCode: Long? = null,
    val availableVersionCode: Long? = null,
) {
    val status: LibraryAppStatus
        get() = when {
            installedVersionCode == null -> LibraryAppStatus.NotInstalled
            availableVersionCode == null -> LibraryAppStatus.UpdateStatusUnknown
            availableVersionCode > installedVersionCode -> LibraryAppStatus.UpdateAvailable
            else -> LibraryAppStatus.UpToDate
        }
}

@Serializable
data class SignedInstallJob(
    val schemaVersion: Int,
    val jobId: String,
    val deviceId: String,
    val action: String,
    val packageName: String,
    val displayName: String,
    val acceptedSignerSha256: List<String> = emptyList(),
    val issuedAt: String,
    val expiresAt: String,
    val nonce: String,
)

@Serializable
data class JobReportRequest(
    val status: String,
    val installedVersionCode: Long? = null,
    val observedSignerSha256: List<String>? = null,
    val message: String? = null,
)

@Serializable
data class JobReportResponse(
    val ok: Boolean,
    val revision: Long,
)

enum class BorealisJobStatus(val wireValue: String) {
    Installing("installing"),
    AwaitingUserAction("awaiting_user_action"),
    Succeeded("succeeded"),
    Failed("failed"),
    Cancelled("cancelled"),
}
