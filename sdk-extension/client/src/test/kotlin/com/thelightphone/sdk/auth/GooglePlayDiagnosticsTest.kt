package com.thelightphone.sdk.auth

import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.test.Test

class GooglePlayDiagnosticsTest {
    @Test
    fun `diagnostics contain only enum identifiers and bounded numeric codes`() {
        for (stage in GooglePlayDiagnosticStage.entries) {
            for (outcome in GooglePlayDiagnosticOutcome.entries) {
                for (code in listOf(null, -16, -2, 0, 200, 400, 403, 599, -17, 600, Int.MAX_VALUE)) {
                    val line = formatGooglePlayDiagnostic(stage, outcome, code)
                    assertTrue(line.matches(Regex("stage=[A-Z_]+ outcome=[A-Z_]+ code=(NONE|-?[0-9]{1,3})")))
                }
            }
        }
    }

    @Test
    fun `HTTP status is retained without a response body`() {
        assertEquals(
            "stage=ACCOUNT_EXCHANGE outcome=HTTP_ERROR code=400",
            formatGooglePlayDiagnostic(GooglePlayDiagnosticStage.ACCOUNT_EXCHANGE, GooglePlayDiagnosticOutcome.HTTP_ERROR, 400),
        )
    }

    @Test
    fun `out of range values are not logged`() {
        assertEquals(
            "stage=WEBVIEW outcome=NETWORK_ERROR code=NONE",
            formatGooglePlayDiagnostic(GooglePlayDiagnosticStage.WEBVIEW, GooglePlayDiagnosticOutcome.NETWORK_ERROR, Int.MAX_VALUE),
        )
    }
}
