package com.loosewire.borealis.install

import com.thelightphone.sdk.install.LightPackageInstallOutcome
import com.thelightphone.sdk.install.LightPackageInstallResult
import com.thelightphone.sdk.install.LightPackageIdentity
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

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

    private fun result(outcome: LightPackageInstallOutcome) =
        LightPackageInstallResult(7, "com.example.bank", outcome, null)

    @Test
    fun `a confirmation restored after app exit can never be resumed`() {
        // The SDK's pending-user-action intent is delivered once, to the process that
        // committed the session. After an exit the stored AwaitingUserAction result is
        // all that is left, and no code path can re-open that confirmation. Leaving it
        // live is what made Install/Update silently refuse to do anything until the
        // user cleared app data.
        assertEquals(
            PendingInstallState.Orphaned,
            pendingInstallState(
                pendingVersionCode = 12,
                result = result(LightPackageInstallOutcome.AwaitingUserAction),
                installedVersionCode = null,
                committedAgoMillis = null,
            ),
        )
        assertEquals(
            PendingInstallState.Orphaned,
            pendingInstallState(12, result = null, installedVersionCode = null, committedAgoMillis = null),
        )
        assertFalse(
            pendingInstallState(
                pendingVersionCode = 12,
                result = result(LightPackageInstallOutcome.AwaitingUserAction),
                installedVersionCode = null,
                committedAgoMillis = null,
            ).isLive,
        )
    }

    @Test
    fun `a session this process committed keeps its Android confirmation`() {
        assertEquals(
            PendingInstallState.AwaitingConfirmation,
            pendingInstallState(12, result(LightPackageInstallOutcome.AwaitingUserAction), null, committedAgoMillis = 1_000L),
        )
        assertEquals(
            PendingInstallState.InProgress,
            pendingInstallState(12, result = null, installedVersionCode = null, committedAgoMillis = 1_000L),
        )
        assertTrue(
            pendingInstallState(12, result(LightPackageInstallOutcome.AwaitingUserAction), null, 30_000L).isLive,
        )
        // Reconciliation waits for Android, but a second tap supersedes it immediately.
        assertTrue(
            pendingInstallState(
                12,
                result(LightPackageInstallOutcome.AwaitingUserAction),
                null,
                30_000L,
            ).supersededByRetry,
        )
    }

    @Test
    fun `an unanswered confirmation stops being live once its window passes`() {
        // Android delivers the confirmation intent only once. Ignoring or dismissing it
        // leaves the session committed with no terminal result, so the phone must
        // eventually treat it as finished and let Install/Update start a new one.
        assertEquals(
            PendingInstallState.AwaitingConfirmation,
            pendingInstallState(
                12,
                result(LightPackageInstallOutcome.AwaitingUserAction),
                null,
                INSTALL_CONFIRMATION_WINDOW_MILLIS,
            ),
        )
        listOf(
            result(LightPackageInstallOutcome.AwaitingUserAction),
            null,
        ).forEach { stored ->
            assertEquals(
                PendingInstallState.Orphaned,
                pendingInstallState(12, stored, null, INSTALL_CONFIRMATION_WINDOW_MILLIS + 1),
            )
        }
        // A negative age means the timestamps were not comparable; never call that live.
        assertEquals(
            PendingInstallState.Orphaned,
            pendingInstallState(12, result(LightPackageInstallOutcome.AwaitingUserAction), null, -1),
        )
    }

    @Test
    fun `an install Android already delivered completes without a result broadcast`() {
        // A force-stopped app never receives the terminal status. The package on the
        // device is the authority, so the pending row must still finish.
        listOf(
            null,
            result(LightPackageInstallOutcome.AwaitingUserAction),
            result(LightPackageInstallOutcome.Cancelled),
            result(LightPackageInstallOutcome.Failed),
        ).forEach { stored ->
            assertEquals(
                PendingInstallState.Installed,
                pendingInstallState(12, stored, installedVersionCode = 12, committedAgoMillis = null),
                "stored result $stored must not hide a completed install",
            )
        }
    }

    @Test
    fun `an older installed version does not count as the delivered app`() {
        assertEquals(
            PendingInstallState.Cancelled,
            pendingInstallState(
                12,
                result(LightPackageInstallOutcome.Cancelled),
                installedVersionCode = 11,
                committedAgoMillis = null,
            ),
        )
        assertEquals(
            PendingInstallState.InProgress,
            pendingInstallState(12, result = null, installedVersionCode = 11, committedAgoMillis = 1_000L),
        )
    }

    @Test
    fun `only sessions Android may still complete are reconciled as live`() {
        assertTrue(PendingInstallState.AwaitingConfirmation.isLive)
        assertTrue(PendingInstallState.InProgress.isLive)
        listOf(
            PendingInstallState.Installed,
            PendingInstallState.Cancelled,
            PendingInstallState.Failed,
            PendingInstallState.Orphaned,
        ).forEach { state -> assertFalse(state.isLive, "$state must not stay pending") }
    }

    @Test
    fun `a pending Android confirmation never blocks another install tap`() {
        // Android's confirmation is single-shot: if the user ignored or dismissed it,
        // waiting cannot produce progress. Tapping Install/Update again must restart it
        // right away, in this process as much as after a restart.
        assertFalse(InstallProgress("Example Bank", InstallStage.AwaitingConfirmation).blocksInstall)
        assertFalse(InstallProgress("Example Bank", InstallStage.Interrupted).blocksInstall)
        assertFalse(InstallProgress("Example Bank", InstallStage.ReportingResult).blocksInstall)
        assertTrue(PendingInstallState.AwaitingConfirmation.supersededByRetry)
        assertTrue(PendingInstallState.Orphaned.supersededByRetry)
        assertTrue(PendingInstallState.Installed.supersededByRetry)
        assertFalse(PendingInstallState.InProgress.supersededByRetry)
    }

    @Test
    fun `downloads and the commit itself still exclude a second session`() {
        listOf(
            InstallStage.Resolving,
            InstallStage.Downloading,
            InstallStage.Verifying,
            InstallStage.Installing,
        ).forEach { stage ->
            assertTrue(InstallProgress("Example Bank", stage).blocksInstall, "$stage must block a tap")
        }
    }
}
