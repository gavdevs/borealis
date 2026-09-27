package com.gav.borealis.install

import com.thelightphone.sdk.install.LightPackageIdentity
import kotlin.test.Test
import kotlin.test.assertFailsWith

class BorealisInstallCoordinatorTest {
    private val signer = "a".repeat(64)
    private val rotatedSigner = "b".repeat(64)
    private fun identity(version: Long = 12, signers: List<String> = listOf(signer)) =
        LightPackageIdentity("com.example.bank", version, "1.2", signers)

    @Test
    fun `first authenticated Play install needs no manually approved publisher`() {
        validateDeliveredIdentity("com.example.bank", 12, identity(), null)
    }

    @Test
    fun `matching signer permits update`() {
        validateDeliveredIdentity("com.example.bank", 12, identity(), identity(version = 11))
    }

    @Test
    fun `shared signing history allows Android to verify valid rotation`() {
        validateDeliveredIdentity(
            "com.example.bank", 12,
            identity(signers = listOf(rotatedSigner, signer)), identity(version = 11),
        )
    }

    @Test
    fun `unrelated update signer is rejected`() {
        assertFailsWith<IllegalArgumentException> {
            validateDeliveredIdentity(
                "com.example.bank", 12, identity(signers = listOf(rotatedSigner)), identity(version = 11),
            )
        }
    }

    @Test
    fun `missing malformed or unavailable signing identity is rejected`() {
        listOf(emptyList(), listOf("not-a-certificate")).forEach { signers ->
            assertFailsWith<IllegalArgumentException> {
                validateDeliveredIdentity("com.example.bank", 12, identity(signers = signers), null)
            }
        }
        assertFailsWith<IllegalArgumentException> {
            validateDeliveredIdentity("com.example.bank", 12, identity(), identity(11, emptyList()))
        }
    }

    @Test
    fun `package and Play version must match downloaded APK`() {
        assertFailsWith<IllegalArgumentException> {
            validateDeliveredIdentity("com.example.other", 12, identity(), null)
        }
        assertFailsWith<IllegalArgumentException> {
            validateDeliveredIdentity("com.example.bank", 13, identity(), null)
        }
    }

    @Test
    fun `installed identity must match and updates cannot downgrade`() {
        assertFailsWith<IllegalArgumentException> {
            validateDeliveredIdentity("com.example.bank", 12, identity(), identity(version = 13))
        }
        assertFailsWith<IllegalArgumentException> {
            validateDeliveredIdentity("com.example.bank", 12, identity(), identity().copy(packageName = "com.example.other"))
        }
    }
}
