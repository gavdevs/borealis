package com.loosewire.borealis.ui

import com.loosewire.borealis.install.UninstallProgress
import com.loosewire.borealis.install.UninstallStage
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals

class UninstallProgressTest {
    @Test
    fun `uninstall stages stay ordered from confirmation through completion`() {
        assertEquals(
            listOf("Starting", "AwaitingConfirmation", "ReportingResult"),
            UninstallStage.entries.map { it.name },
        )
    }

    @Test
    fun `uninstall progress carries the app's display name`() {
        val progress = UninstallProgress("Example Bank", UninstallStage.AwaitingConfirmation)
        assertEquals("Example Bank", progress.displayName)
        assertEquals(UninstallStage.AwaitingConfirmation, progress.stage)
    }

    @Test
    fun `uninstall state is independent from install progress`() {
        assertNotEquals(
            UninstallProgress("App", UninstallStage.AwaitingConfirmation),
            UninstallProgress("App", UninstallStage.ReportingResult),
        )
    }
}
