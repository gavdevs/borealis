package com.gav.borealis.data

import kotlin.test.Test
import kotlin.test.assertEquals

class LibraryAppStateTest {
    private val app = LibraryApp("com.example.bank", "Example Bank")

    @Test
    fun `uninstalled library entry stays available to install`() {
        assertEquals(LibraryAppStatus.NotInstalled, LibraryAppState(app).status)
    }

    @Test
    fun `installed app remains in library after installation`() {
        val state = LibraryAppState(app, installedVersionCode = 12, availableVersionCode = 12)
        assertEquals(app, state.app)
        assertEquals(LibraryAppStatus.UpToDate, state.status)
    }

    @Test
    fun `only a newer available version needs an update`() {
        assertEquals(LibraryAppStatus.UpdateAvailable, LibraryAppState(app, 12, 13).status)
        assertEquals(LibraryAppStatus.UpToDate, LibraryAppState(app, 13, 12).status)
    }

    @Test
    fun `missing metadata is never represented as up to date`() {
        assertEquals(LibraryAppStatus.UpdateStatusUnknown, LibraryAppState(app, 12, null).status)
    }
}
