package com.gav.borealis.delivery

import kotlin.test.Test
import kotlin.test.assertEquals

class PlayArtifactDownloaderTest {
    @Test
    fun `initial byte progress is emitted immediately`() {
        val events = mutableListOf<ArtifactDownloadProgress>()
        val emitter = ArtifactProgressEmitter(events::add) { 0L }
        val progress = ArtifactDownloadProgress(1, 2, 0L, 500L)
        emitter.report(progress)
        assertEquals(listOf(progress), events)
    }

    @Test
    fun `buffer events are throttled to four times a second`() {
        var now = 0L
        val events = mutableListOf<ArtifactDownloadProgress>()
        val emitter = ArtifactProgressEmitter(events::add) { now }
        emitter.report(ArtifactDownloadProgress(1, 1, 0L, 500L))
        now = 249_999_999L
        emitter.report(ArtifactDownloadProgress(1, 1, 100L, 500L))
        now = 250_000_000L
        emitter.report(ArtifactDownloadProgress(1, 1, 200L, 500L))
        assertEquals(listOf(0L, 200L), events.map { it.downloadedBytes })
    }

    @Test
    fun `file boundaries and completion bypass throttling with aggregate bytes`() {
        val events = mutableListOf<ArtifactDownloadProgress>()
        val emitter = ArtifactProgressEmitter(events::add) { 0L }
        emitter.report(ArtifactDownloadProgress(1, 2, 0L, 500L), force = true)
        emitter.report(ArtifactDownloadProgress(1, 2, 300L, 500L), force = true)
        emitter.report(ArtifactDownloadProgress(2, 2, 300L, 500L), force = true)
        emitter.report(ArtifactDownloadProgress(2, 2, 500L, 500L), force = true)
        assertEquals(listOf(0L, 300L, 300L, 500L), events.map { it.downloadedBytes })
        assertEquals(listOf(1, 1, 2, 2), events.map { it.currentFile })
        assertEquals(500L, events.last().totalBytes)
    }
}
