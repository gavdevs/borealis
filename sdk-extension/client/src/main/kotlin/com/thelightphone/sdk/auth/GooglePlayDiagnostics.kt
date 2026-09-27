package com.thelightphone.sdk.auth

import android.util.Log

enum class GooglePlayDiagnosticStage {
    SIGN_IN_SCREEN, WEBVIEW, WEBVIEW_PAGE, ACCOUNT_EXCHANGE, CHECK_IN, DEVICE_CONFIG,
    PLAY_TOKEN, USER_PROFILE, SESSION_VALIDATION, SECURE_STORE,
}

enum class GooglePlayDiagnosticOutcome {
    STARTED, SUCCEEDED, CANCELLED, WAITING, SHOWN, HIDDEN, PAUSED,
    HTTP_ERROR, NETWORK_ERROR, RESPONSE_ERROR, STORAGE_ERROR, INTERNAL_ERROR,
    NAVIGATION_BLOCKED, RENDERER_GONE, TIMED_OUT,
}

/** Accepts no account values, URLs, response bodies, or exception text. */
object GooglePlayDiagnostics {
    fun record(
        stage: GooglePlayDiagnosticStage,
        outcome: GooglePlayDiagnosticOutcome,
        code: Int? = null,
    ) {
        runCatching { Log.i("BorealisGoogle", formatGooglePlayDiagnostic(stage, outcome, code)) }
    }
}

internal fun formatGooglePlayDiagnostic(
    stage: GooglePlayDiagnosticStage,
    outcome: GooglePlayDiagnosticOutcome,
    code: Int?,
): String {
    val safeCode = code?.takeIf { it in -16..599 }?.toString() ?: "NONE"
    return "stage=${stage.name} outcome=${outcome.name} code=$safeCode"
}
