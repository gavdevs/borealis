package com.loosewire.borealis.delivery

import com.aurora.gplayapi.data.models.App
import com.aurora.gplayapi.data.models.AuthData
import com.aurora.gplayapi.data.models.PlayResponse
import com.aurora.gplayapi.network.IHttpClient
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
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
