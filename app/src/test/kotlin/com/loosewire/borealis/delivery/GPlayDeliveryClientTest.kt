package com.loosewire.borealis.delivery

import com.aurora.gplayapi.data.models.App
import com.aurora.gplayapi.data.models.AuthData
import com.aurora.gplayapi.data.models.PlayResponse
import com.aurora.gplayapi.exceptions.GooglePlayException
import com.aurora.gplayapi.network.IHttpClient
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotSame
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.runTest

class GPlayDeliveryClientTest {
    @Test
    fun `version check uses app details only and never purchases or downloads`() = runTest {
        var lookups = 0
        val play = GPlayDeliveryClient(
            profileBytes = byteArrayOf(),
            authProvider = { _, _ -> AuthData(email = "fixture@example.test") },
            httpClient = NoNetworkClient,
            detailsLookup = { _, packageName, _ ->
                lookups++
                assertEquals("com.example.bank", packageName)
                App(packageName, versionCode = 42)
            },
        )
        assertEquals(42L, play.latestVersionCode("com.example.bank"))
        assertEquals(1, lookups)
    }

    @Test
    fun `version checks reject mismatched or absent version metadata`() = runTest {
        listOf(App("com.example.other", versionCode = 42), App("com.example.bank")).forEach { details ->
            val play = GPlayDeliveryClient(
                profileBytes = byteArrayOf(),
                authProvider = { _, _ -> AuthData(email = "fixture@example.test") },
                httpClient = NoNetworkClient,
                detailsLookup = { _, _, _ -> details },
            )
            assertFailsWith<IllegalArgumentException> { play.latestVersionCode("com.example.bank") }
        }
    }

    @Test
    fun `rejected cached session is rebuilt once and the check retried`() = runTest {
        var authentications = 0
        var lookups = 0
        val usedSessions = mutableListOf<AuthData>()
        val play = GPlayDeliveryClient(
            profileBytes = byteArrayOf(),
            authProvider = { _, _ ->
                authentications++
                AuthData(email = "fixture$authentications@example.test")
            },
            httpClient = NoNetworkClient,
            detailsLookup = { auth, _, _ ->
                lookups++
                usedSessions.add(auth)
                if (lookups == 1) throw GooglePlayException.AuthException(401)
                App("com.example.bank", versionCode = 42)
            },
        )

        assertEquals(42L, play.latestVersionCode("com.example.bank"))
        assertEquals(2, authentications)
        assertEquals(2, lookups)
        assertNotSame(usedSessions[0], usedSessions[1])
    }

    @Test
    fun `session rejection is retried at most once before surfacing`() = runTest {
        var authentications = 0
        var lookups = 0
        val play = GPlayDeliveryClient(
            profileBytes = byteArrayOf(),
            authProvider = { _, _ ->
                authentications++
                AuthData(email = "fixture@example.test")
            },
            httpClient = NoNetworkClient,
            detailsLookup = { _, _, _ ->
                lookups++
                throw GooglePlayException.AuthException(401)
            },
        )

        assertFailsWith<GooglePlayException.AuthException> { play.latestVersionCode("com.example.bank") }
        assertEquals(2, authentications)
        assertEquals(2, lookups)
    }

    @Test
    fun `non-auth failures do not rebuild the session`() = runTest {
        var authentications = 0
        var lookups = 0
        val play = GPlayDeliveryClient(
            profileBytes = byteArrayOf(),
            authProvider = { _, _ ->
                authentications++
                AuthData(email = "fixture@example.test")
            },
            httpClient = NoNetworkClient,
            detailsLookup = { _, _, _ ->
                lookups++
                throw GooglePlayException.Server(503)
            },
        )

        assertFailsWith<GooglePlayException.Server> { play.latestVersionCode("com.example.bank") }
        assertEquals(1, authentications)
        assertEquals(1, lookups)
    }
}

private object NoNetworkClient : IHttpClient {
    override val responseCode = MutableStateFlow(0)
    override fun get(url: String, headers: Map<String, String>): PlayResponse = error("Unexpected network request")
    override fun get(url: String, headers: Map<String, String>, params: Map<String, String>): PlayResponse = error("Unexpected network request")
    override fun get(url: String, headers: Map<String, String>, paramString: String): PlayResponse = error("Unexpected network request")
    override fun post(url: String, headers: Map<String, String>, body: ByteArray): PlayResponse = error("Unexpected network request")
    override fun post(url: String, headers: Map<String, String>, params: Map<String, String>): PlayResponse = error("Unexpected network request")
    override fun getAuth(url: String): PlayResponse = error("Unexpected network request")
    override fun postAuth(url: String, body: ByteArray): PlayResponse = error("Unexpected network request")
}
