package com.gav.borealis.ui

import kotlin.test.Test
import kotlin.test.assertEquals

class InstallProgressTest {
    @Test
    fun `download fraction is derived from bytes and remains bounded`() {
        assertEquals(0f, downloadFraction(0, 1_000))
        assertEquals(0.25f, downloadFraction(250, 1_000))
        assertEquals(1f, downloadFraction(1_000, 1_000))
        assertEquals(1f, downloadFraction(1_200, 1_000))
        assertEquals(0f, downloadFraction(-100, 1_000))
        assertEquals(0f, downloadFraction(500, 0))
    }

    @Test
    fun `byte labels work without locale or floating rounding surprises`() {
        assertEquals("0 KB", downloadBytes(0))
        assertEquals("512 KB", downloadBytes(524_288))
        assertEquals("1.0 MB", downloadBytes(1_048_576))
        assertEquals("10.0 MB", downloadBytes(10_485_760))
    }
}
