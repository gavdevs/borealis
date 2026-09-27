package com.gav.borealis.ui

import kotlinx.coroutines.CancellationException

/** Saved phone-local connection state, not an extra network login or account identifier. */
enum class GoogleAccountStatus(val buttonLabel: String) {
    SignedIn("SIGNED IN"),
    SignedOut("SIGN IN"),
    Unavailable("GOOGLE"),
}

internal suspend fun readGoogleAccountStatus(isConnected: suspend () -> Boolean): GoogleAccountStatus = try {
    if (isConnected()) GoogleAccountStatus.SignedIn else GoogleAccountStatus.SignedOut
} catch (cancelled: CancellationException) {
    throw cancelled
} catch (_: Exception) {
    // A protected-store error must not falsely claim the user signed out or hide their library.
    // The account screen provides the existing connection-recovery flow when opened.
    GoogleAccountStatus.Unavailable
}
