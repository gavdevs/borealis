package com.thelightphone.sdk.auth

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class GooglePlaySignInPolicyTest {
    @Test
    fun `only exact secure Google accounts main frame is permitted`() {
        assertTrue(isGoogleAccountsUrl(GOOGLE_PLAY_SIGN_IN_URL))
        assertTrue(isGoogleAccountsUrl("https://accounts.google.com:443/signin/challenge"))
        assertTrue(isGoogleAccountsUrl("https://ACCOUNTS.GOOGLE.COM/signin"))
        listOf(
            null, "", "https://accounts.google.com.evil.test/", "https://evilaccounts.google.com/",
            "http://accounts.google.com/", "https://accounts.google.com:444/", "javascript:alert(1)",
            "file:///accounts.google.com", "content://accounts.google.com", "intent://accounts.google.com",
            "https://accounts.google.com@evil.test/", "https://user@accounts.google.com/",
            "https://accounts.google.com\\@evil.test/", "https://accounts.google.com./",
            "https://google.com/", "https://accounts.google.com%2fevil.test/",
        ).forEach { assertFalse(isGoogleAccountsUrl(it), "Unexpected allowed URL: $it") }
    }

    @Test
    fun `only secure network resources are permitted`() {
        assertTrue(isHttpsResource("https://www.gstatic.com/assets/signin.js"))
        listOf("http://www.gstatic.com/a", "file:///a", "content://a", "data:text/plain,hello", "https://user@google.com/")
            .forEach { assertFalse(isHttpsResource(it)) }
    }

    @Test
    fun `cookie parser preserves equals and rejects duplicates and invalid tokens`() {
        assertEquals("sample==", extractGoogleOauthCookie("other=example; oauth_token=sample==; last=value"))
        assertNull(extractGoogleOauthCookie(null))
        assertNull(extractGoogleOauthCookie("not_oauth_token=sample"))
        assertNull(extractGoogleOauthCookie("oauth_token=one; oauth_token=two"))
        assertNull(extractGoogleOauthCookie("oauth_token="))
        assertNull(extractGoogleOauthCookie("oauth_token=has space"))
        assertNull(extractGoogleOauthCookie("oauth_token=has\ncontrol"))
        assertNull(extractGoogleOauthCookie("oauth_token=" + "x".repeat(16_385)))
    }

    @Test
    fun `profile result must be a bounded JSON email string`() {
        assertEquals("person@example.test", extractGoogleProfileEmail("\"person@example.test\""))
        assertEquals("person@example.test", extractGoogleProfileEmail("\"person\\u0040example.test\""))
        listOf(null, "null", "true", "{}", "[]", "\"null\"", "\"@example.test\"", "\"person@\"", "\"a b@example.test\"")
            .forEach { assertNull(extractGoogleProfileEmail(it)) }
    }

    @Test
    fun `credential debug strings never disclose account or token`() {
        val value = GooglePlaySignInCredential("person@example.test", "fake-secret")
        assertEquals("GooglePlaySignInCredential([redacted])", value.toString())
    }
}
