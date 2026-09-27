package com.gav.borealis.ui

import java.io.IOException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest

class GoogleAccountStatusTest {
    @Test
    fun `saved connection shows signed in and missing connection shows sign in`() = runTest {
        assertEquals("SIGNED IN", readGoogleAccountStatus { true }.buttonLabel)
        assertEquals("SIGN IN", readGoogleAccountStatus { false }.buttonLabel)
    }

    @Test
    fun `rereading reflects sign in and disconnect without a cached label`() = runTest {
        var connected = false
        val check = suspend { connected }
        assertEquals(GoogleAccountStatus.SignedOut, readGoogleAccountStatus(check))
        connected = true
        assertEquals(GoogleAccountStatus.SignedIn, readGoogleAccountStatus(check))
        connected = false
        assertEquals(GoogleAccountStatus.SignedOut, readGoogleAccountStatus(check))
    }

    @Test
    fun `storage failure leaves an account entry without falsely claiming signed out`() = runTest {
        val state = readGoogleAccountStatus { throw IOException("fixture storage failure") }
        assertEquals(GoogleAccountStatus.Unavailable, state)
        assertEquals("GOOGLE", state.buttonLabel)
    }

    @Test
    fun `cancellation is not converted into connection failure`() = runTest {
        assertFailsWith<CancellationException> {
            readGoogleAccountStatus { throw CancellationException("cancelled fixture") }
        }
    }
}
