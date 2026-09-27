package com.thelightphone.sdk.auth

import java.net.URI
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive

internal const val GOOGLE_PLAY_SIGN_IN_URL = "https://accounts.google.com/EmbeddedSetup"

internal fun isGoogleAccountsUrl(value: String?): Boolean = runCatching {
    val uri = URI(value ?: return false)
    uri.scheme.equals("https", ignoreCase = true) &&
        uri.host.equals("accounts.google.com", ignoreCase = true) &&
        uri.rawUserInfo == null && (uri.port == -1 || uri.port == 443)
}.getOrDefault(false)

internal fun isHttpsResource(value: String): Boolean = runCatching {
    val uri = URI(value)
    uri.scheme.equals("https", ignoreCase = true) &&
        !uri.host.isNullOrBlank() && uri.rawUserInfo == null
}.getOrDefault(false)

internal fun extractGoogleOauthCookie(cookieHeader: String?): String? {
    if (cookieHeader == null || cookieHeader.length > 65_536) return null
    val values = cookieHeader.split(';').mapNotNull { item ->
        val separator = item.indexOf('=')
        if (separator < 0 || item.substring(0, separator).trim() != "oauth_token") null
        else item.substring(separator + 1).trim()
    }
    return values.singleOrNull()?.takeIf(::isCredentialToken)
}

internal fun extractGoogleProfileEmail(scriptResult: String?): String? {
    if (scriptResult == null || scriptResult.length > 2_048) return null
    val primitive = runCatching { Json.parseToJsonElement(scriptResult) as? JsonPrimitive }
        .getOrNull() ?: return null
    return primitive.takeIf { it.isString }?.content?.takeIf(::isCredentialEmail)
}

internal fun isCredentialEmail(value: String): Boolean =
    value.length in 3..320 && value.count { it == '@' } == 1 &&
        !value.startsWith('@') && !value.endsWith('@') &&
        value.none { it.isWhitespace() || it.isISOControl() }

internal fun isCredentialToken(value: String): Boolean =
    value.length in 1..16_384 && value.none { it.isWhitespace() || it.isISOControl() }

/** A one-time EmbeddedSetup credential, not a website OAuth access token. */
class GooglePlaySignInCredential internal constructor(
    val email: String,
    val oauthToken: String,
) {
    override fun toString(): String = "GooglePlaySignInCredential([redacted])"
}
