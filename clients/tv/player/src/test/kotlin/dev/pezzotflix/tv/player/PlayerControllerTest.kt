package dev.pezzotflix.tv.player

import dev.pezzotflix.api.models.ClientCapabilities
import dev.pezzotflix.api.models.ClientCapabilitiesDevice
import dev.pezzotflix.api.models.ClientCapabilitiesSubtitles
import dev.pezzotflix.api.models.DeliveryMode
import dev.pezzotflix.api.models.FallbackRequest
import dev.pezzotflix.api.models.PlaybackSession
import dev.pezzotflix.api.models.PlaybackSessionStream
import dev.pezzotflix.api.models.ProgressReport
import dev.pezzotflix.api.models.SessionTrack
import dev.pezzotflix.tv.api.ApiException
import dev.pezzotflix.tv.api.AppEvent
import dev.pezzotflix.tv.api.PlaybackPort
import dev.pezzotflix.tv.api.StartRequest
import dev.pezzotflix.tv.api.SubtitleChoice
import dev.pezzotflix.tv.api.TrackChange
import dev.pezzotflix.tv.player.PlayerController.Phase
import dev.pezzotflix.tv.player.failures.FailureAction
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The re-planning and session state machine of doc 05 §8.10 (doc 04 §8), with a fake server and engine. */
@OptIn(ExperimentalCoroutinesApi::class)
class PlayerControllerTest {
    private class FakePort : PlaybackPort {
        val calls = mutableListOf<String>()
        val starts = mutableListOf<StartRequest>()
        val failures = mutableListOf<FallbackRequest>()
        val changes = mutableListOf<TrackChange>()
        val progress = mutableListOf<ProgressReport>()
        val stops = mutableListOf<Pair<String, Long>>()
        var onStart: suspend (Int) -> PlaybackSession = { Fixtures.odyssey(id = "sess-$it") }
        var onFailure: (FallbackRequest) -> PlaybackSession = { error("unexpected failure report") }
        var onProgress: () -> Unit = {}
        var onChange: suspend (TrackChange) -> PlaybackSession = { error("unexpected change") }
        var onStop: suspend (String) -> Unit = {}

        override suspend fun startPlayback(request: StartRequest): PlaybackSession {
            starts += request
            calls += "start"
            return onStart(starts.size)
        }

        override suspend fun reportProgress(sessionId: String, report: ProgressReport) {
            progress += report
            calls += "progress"
            onProgress()
        }

        override suspend fun stopPlayback(sessionId: String, positionMs: Long) {
            stops += sessionId to positionMs
            calls += "stop:$sessionId"
            onStop(sessionId)
        }

        override suspend fun changeTracks(sessionId: String, change: TrackChange): PlaybackSession {
            changes += change
            calls += "change"
            return onChange(change)
        }

        override suspend fun reportPlaybackFailure(sessionId: String, request: FallbackRequest): PlaybackSession {
            failures += request
            calls += "failure:${request.suspect?.value}"
            return onFailure(request)
        }

        override suspend fun terminateSession(sessionId: String) {
            calls += "terminate:$sessionId"
        }
    }

    private class FakeEngine : PlaybackEngine {
        val loads = mutableListOf<Pair<PlaybackSession, Long>>()
        val updates = mutableListOf<PlaybackSession>()
        val completed = mutableListOf<String>()
        var listener: EngineListener? = null
        var position = 0L
        var unloads = 0
        /** The next load fails at once with this (an unparsable locator). */
        var refuse: FailureAction? = null
        override var isPlaying = false

        override fun load(session: PlaybackSession, startMs: Long, listener: EngineListener): FailureAction? {
            loads += session to startMs
            refuse?.let {
                refuse = null
                return it
            }
            this.listener = listener
            position = startMs
            return null
        }

        override fun update(session: PlaybackSession) {
            updates += session
        }

        override fun subtitleComplete(trackId: String) {
            completed += trackId
        }

        override fun unload() {
            unloads += 1
        }

        override fun positionMs(): Long = position
        override fun bufferedMs(): Long = position
        override fun play() {
            isPlaying = true
        }

        override fun pause() {
            isPlaying = false
        }

        override fun seekTo(positionMs: Long) {
            position = positionMs
        }
    }

    private val caps = ClientCapabilities(
        device = ClientCapabilitiesDevice(ClientCapabilitiesDevice.PropertyClass.tv),
        containers = listOf("mkv"), protocols = listOf("progressive", "hls-fmp4"), video = emptyList(), audio = emptyList(),
        subtitles = ClientCapabilitiesSubtitles(listOf("srt"), listOf("pgs")),
    )

    private fun TestScope.controller(port: FakePort, engine: FakeEngine, scope: CoroutineScope = backgroundScope) = PlayerController(
        api = port, engine = engine, capabilities = { caps }, scope = scope, releaseScope = backgroundScope,
        now = { currentTime },
    )

    private val stream = "/video/media/s/tok_cccccccccccccccc/hls/master.m3u8"

    private fun directStream(id: String) = Fixtures.odyssey(id = id).copy(
        mode = DeliveryMode.direct_stream,
        stream = PlaybackSessionStream(url = stream, protocol = PlaybackSessionStream.Protocol.hlsMinusFmp4),
    )

    /** Direct Stream with the SRT served as a growing WebVTT sidecar, selected. */
    private fun withGrowingSidecar(id: String, audioSel: String = "s4"): PlaybackSession {
        val s = Fixtures.odyssey(audioSel = audioSel, id = id, subSel = null).copy(
            mode = DeliveryMode.direct_stream,
            stream = PlaybackSessionStream(url = stream, protocol = PlaybackSessionStream.Protocol.hlsMinusFmp4),
        )
        val vtt = Fixtures.sub("s1", 1, "subrip", "eng", selected = true, delivery = SessionTrack.Delivery.sidecar, url = "/video/media/s/tok/subtitles/s1.vtt")
            .copy(availability = SessionTrack.Availability.growing)
        return s.copy(tracks = s.tracks.copy(subtitles = listOf(vtt)))
    }

    private val start0 = PlayerController.StartOptions(itemId = "item-2001", startPositionMs = 0)

    @Test
    fun startsAtTheResumePositionKeepsTheSessionAliveAndStopsOnClose() = runTest {
        val port = FakePort().apply { onStart = { Fixtures.odyssey(id = "sess-1").copy(resumePositionMs = 600_000) } }
        val engine = FakeEngine()
        val c = controller(port, engine)
        c.start(PlayerController.StartOptions(itemId = "item-2001"))
        runCurrent()
        assertEquals(Phase.PLAYING, c.state.value.phase)
        assertEquals(600_000L, engine.loads.single().second)
        assertEquals(caps, port.starts.single().capabilities)

        engine.position = 612_000
        engine.listener!!.onState(EngineState.PLAYING)
        advanceTimeBy(10_001)
        assertEquals(ProgressReport(612_000, ProgressReport.State.playing, 10_000), port.progress.last())

        engine.position = 700_000
        c.close()
        runCurrent()
        assertEquals("sess-1" to 700_000L, port.stops.single())
        assertEquals(Phase.CLOSED, c.state.value.phase)
        c.close()
        runCurrent()
        assertEquals(1, port.stops.size)
    }

    @Test
    fun playAtTheEndStartsAgainFromTheBeginning() = runTest {
        val port = FakePort().apply { onStart = { Fixtures.odyssey(id = "sess-1") } }
        val engine = FakeEngine()
        val c = controller(port, engine)
        c.start(PlayerController.StartOptions(itemId = "item-2001"))
        runCurrent()
        engine.position = 30_000
        engine.listener!!.onState(EngineState.ENDED)
        runCurrent()
        assertTrue(c.state.value.ended)

        c.togglePlay()
        assertEquals(0L, engine.position)
        assertTrue(engine.isPlaying)
        assertEquals(emptyList<Pair<String, Long>>(), port.stops)
    }

    @Test
    fun backWhileStartPlaybackIsInFlightStopsTheSessionItCreates() = runTest {
        val answer = CompletableDeferred<PlaybackSession>()
        val port = FakePort().apply { onStart = { answer.await() } }
        // The ViewModel's scope: Back clears the Navigation3 entry, which cancels it, then onCleared closes.
        val screen = CoroutineScope(backgroundScope.coroutineContext + Job(backgroundScope.coroutineContext[Job]))
        val c = controller(port, FakeEngine(), scope = screen)
        c.start(PlayerController.StartOptions(itemId = "item-2001"))
        runCurrent()
        assertEquals(listOf("start"), port.calls)

        screen.cancel()
        c.close()
        runCurrent()
        assertEquals(emptyList<Pair<String, Long>>(), port.stops)

        // The server had created the session: it is stopped, once, instead of holding the slot for 150 s.
        answer.complete(Fixtures.odyssey(id = "sess-late").copy(resumePositionMs = 5_000))
        runCurrent()
        assertEquals(listOf("sess-late" to 5_000L), port.stops)
    }

    @Test
    fun anAudioFailureRePlansAndLoadsTheNewStreamFromHere() = runTest {
        val port = FakePort().apply { onFailure = { directStream("sess-1") } }
        val engine = FakeEngine()
        val c = controller(port, engine)
        c.start(start0)
        runCurrent()
        engine.position = 42_000
        engine.listener!!.onFailure(FailureAction.Replan("audio", "ERROR_CODE_AUDIO_TRACK_INIT_FAILED"))
        runCurrent()
        assertEquals(FallbackRequest(42_000, "ERROR_CODE_AUDIO_TRACK_INIT_FAILED", FallbackRequest.Suspect.audio), port.failures.single())
        assertEquals(stream to 42_000L, engine.loads.last().let { it.first.stream.url to it.second })
        assertEquals(Phase.PLAYING, c.state.value.phase)
        assertEquals(1, c.state.value.attempts)
    }

    @Test
    fun aStreamThatCannotLoadIsRePlannedWithAConsistentState() = runTest {
        val port = FakePort().apply { onFailure = { Fixtures.odyssey(id = "sess-1", url = "/video/media/s/tok_bbbbbbbbbbbbbbbb/file") } }
        val engine = FakeEngine().apply { refuse = FailureAction.Replan("unknown", "BAD_STREAM_URL") }
        val c = controller(port, engine)
        c.start(start0)
        runCurrent()
        assertEquals(FallbackRequest(0, "BAD_STREAM_URL", FallbackRequest.Suspect.unknown), port.failures.single())
        assertEquals(2, engine.loads.size)
        assertEquals("/video/media/s/tok_bbbbbbbbbbbbbbbb/file", engine.loads.last().first.stream.url)
        assertEquals(Phase.PLAYING, c.state.value.phase)
        assertEquals(1, c.state.value.attempts)
        assertFalse(c.state.value.busy)
    }

    @Test
    fun afterThreeAttemptsThePlayerGivesUpAndFreesTheSlot() = runTest {
        var n = 0
        val port = FakePort().apply { onFailure = { Fixtures.odyssey(id = "sess-1", url = "/video/media/s/tok_${++n}xxxxxxxxxxxxxxx/file") } }
        val engine = FakeEngine()
        val c = controller(port, engine)
        c.start(start0)
        runCurrent()
        repeat(4) {
            engine.listener!!.onFailure(FailureAction.Replan("video", "ERROR_CODE_DECODING_FAILED"))
            runCurrent()
        }
        assertEquals(3, port.failures.size)
        assertEquals(Phase.FAILED, c.state.value.phase)
        assertEquals(4, c.state.value.failures.size)
        assertEquals(listOf("sess-1"), port.stops.map { it.first })
    }

    @Test
    fun aNetworkFailureEndsWithExactlyOneStop() = runTest {
        val port = FakePort()
        val engine = FakeEngine()
        val c = controller(port, engine)
        c.start(start0)
        runCurrent()
        engine.position = 50_000
        engine.listener!!.onFailure(FailureAction.Network("ERROR_CODE_IO_NETWORK_CONNECTION_FAILED"))
        runCurrent()
        assertEquals(Phase.NETWORK, c.state.value.phase)
        assertEquals(listOf("sess-1" to 50_000L), port.stops)
        c.close()
        runCurrent()
        assertEquals(1, port.stops.size)
    }

    @Test
    fun retryWaitsForThePendingRelease() = runTest {
        val stopped = CompletableDeferred<Unit>()
        val port = FakePort().apply { onStop = { stopped.await() } }
        val engine = FakeEngine()
        val c = controller(port, engine)
        c.start(start0)
        runCurrent()
        engine.position = 50_000
        engine.listener!!.onFailure(FailureAction.Network("ERROR_CODE_IO_NETWORK_CONNECTION_FAILED"))
        runCurrent()
        c.retry()
        runCurrent()
        // The new start does not race the stop for the only slot.
        assertEquals(listOf("start", "stop:sess-1"), port.calls)
        stopped.complete(Unit)
        runCurrent()
        assertEquals(listOf("start", "stop:sess-1", "start"), port.calls)
        assertEquals(50_000L, port.starts.last().startPositionMs)
        assertEquals(Phase.PLAYING, c.state.value.phase)
    }

    @Test
    fun aStreamGoneForATerminalReasonEndsThePlayer() = runTest {
        val port = FakePort().apply { onProgress = { throw ApiException(410, "SESSION_EXPIRED", reason = "terminated") } }
        val engine = FakeEngine()
        val c = controller(port, engine)
        c.start(start0)
        runCurrent()
        engine.position = 90_000
        engine.listener!!.onFailure(FailureAction.Restart("HTTP_404"))
        runCurrent()
        assertEquals(Phase.TERMINATED, c.state.value.phase)
        assertEquals("terminated", c.state.value.terminatedReason)
        assertEquals(1, port.starts.size)
    }

    @Test
    fun aStreamGoneAfterAnExpiryStartsAgainFromHere() = runTest {
        val port = FakePort().apply { onProgress = { throw ApiException(410, "SESSION_EXPIRED", reason = "expired") } }
        val engine = FakeEngine()
        val c = controller(port, engine)
        c.start(start0)
        runCurrent()
        engine.position = 90_000
        engine.listener!!.onFailure(FailureAction.Restart("HTTP_410"))
        runCurrent()
        assertEquals(listOf("start", "progress", "stop:sess-1", "start"), port.calls)
        assertEquals(90_000L, port.starts.last().startPositionMs)
        assertEquals("sess-2", c.state.value.session?.sessionId)
        assertEquals(Phase.PLAYING, c.state.value.phase)
    }

    @Test
    fun aHeartbeat410EndsAsExpiredOrTerminatedWithoutAStop() = runTest {
        val cases = listOf("expired" to Phase.EXPIRED, null to Phase.EXPIRED, "terminated" to Phase.TERMINATED, "item_removed" to Phase.TERMINATED)
        for ((reason, phase) in cases) {
            val port = FakePort().apply { onProgress = { throw ApiException(410, "SESSION_EXPIRED", reason = reason) } }
            val engine = FakeEngine()
            val c = controller(port, engine)
            c.start(start0)
            runCurrent()
            engine.position = 20_000
            advanceTimeBy(10_001)
            assertEquals("$reason", phase, c.state.value.phase)
            assertEquals("$reason", 20_000L, c.state.value.positionMs)
            assertTrue("$reason", engine.unloads > 0)
            // Closed on the server: leaving sends no StopPlayback.
            c.close()
            runCurrent()
            assertEquals("$reason", emptyList<Pair<String, Long>>(), port.stops)
        }
    }

    @Test
    fun aPreparingStreamIsRetriedAfterRetryAfter() = runTest {
        val port = FakePort()
        port.onStart = { n ->
            if (n == 1) throw ApiException(503, "STREAM_PREPARING", retryAfterMs = 3_000)
            Fixtures.odyssey(id = "sess-$n")
        }
        val engine = FakeEngine()
        val c = controller(port, engine)
        c.start(PlayerController.StartOptions(itemId = "item-2001"))
        runCurrent()
        assertEquals(Phase.PREPARING, c.state.value.phase)
        advanceTimeBy(3_001)
        assertEquals(Phase.PLAYING, c.state.value.phase)
        assertEquals(2, port.starts.size)
    }

    @Test
    fun controlPlaneErrorsMapToPhases() = runTest {
        val cases = listOf(
            ApiException(409, "SESSION_LIMIT_REACHED") to Phase.SESSION_LIMIT,
            ApiException(422, "NO_COMPATIBLE_PLAN") to Phase.NO_PLAN,
            ApiException(500, "STREAM_FAILED") to Phase.FAILED,
            ApiException(0, "NETWORK") to Phase.NETWORK,
            ApiException(503, "MEDIA_UNAVAILABLE", sessionClosed = true) to Phase.UNAVAILABLE,
            ApiException(404, "NOT_FOUND") to Phase.ERROR,
        )
        for ((e, phase) in cases) {
            val port = FakePort().apply { onStart = { throw e } }
            val c = controller(port, FakeEngine())
            c.start(PlayerController.StartOptions(itemId = "item-2001"))
            runCurrent()
            assertEquals(e.code, phase, c.state.value.phase)
        }
    }

    @Test
    fun aRefusedTrackChangeKeepsTheStreamWithANotice() = runTest {
        val port = FakePort().apply { onChange = { throw ApiException(422, "NO_COMPATIBLE_PLAN", detail = "Non riproducibile") } }
        val engine = FakeEngine()
        val c = controller(port, engine)
        c.start(start0)
        runCurrent()
        c.selectAudio("s5")
        runCurrent()
        assertEquals(PlayerController.Notice.ChangeRefused("Non riproducibile"), c.state.value.notice)
        assertEquals(1, engine.loads.size)
        // The engine is bound again: its failures act.
        port.onFailure = { Fixtures.odyssey(id = "sess-1") }
        engine.listener!!.onFailure(FailureAction.Replan("audio", "X"))
        runCurrent()
        assertEquals(1, port.failures.size)
    }

    @Test
    fun aChangeOnAClosedSessionStartsAgainWithTheChangeCarriedOver() = runTest {
        val cases = listOf(
            ApiException(410, "SESSION_EXPIRED", reason = "expired"),
            ApiException(404, "NOT_FOUND"),
            ApiException(422, "NO_COMPATIBLE_PLAN", sessionClosed = true),
        )
        for (e in cases) {
            val port = FakePort().apply { onChange = { throw e } }
            val engine = FakeEngine()
            val c = controller(port, engine)
            c.start(start0)
            runCurrent()
            engine.position = 30_000
            c.selectAudio("s5")
            runCurrent()
            assertEquals(e.code, listOf("start", "change", "stop:sess-1", "start"), port.calls)
            val again = port.starts.last()
            assertEquals(e.code, "s5", again.audioTrackId)
            assertEquals(e.code, "file-2001", again.fileId)
            assertEquals(e.code, 30_000L, again.startPositionMs)
            assertEquals(e.code, Phase.PLAYING, c.state.value.phase)
        }
    }

    @Test
    fun aChangeAnswered503WaitsAsPreparingThenApplies() = runTest {
        var n = 0
        val port = FakePort().apply {
            onChange = {
                if (++n == 1) throw ApiException(503, "STREAM_PREPARING", retryAfterMs = 2_000)
                directStream("sess-1").let { s -> s.copy(tracks = s.tracks.copy(audio = s.tracks.audio.map { a -> a.copy(selected = a.id == "s5") })) }
            }
        }
        val engine = FakeEngine()
        val c = controller(port, engine)
        c.start(start0)
        runCurrent()
        engine.position = 30_000
        c.selectAudio("s5")
        runCurrent()
        assertEquals(Phase.PREPARING, c.state.value.phase)
        advanceTimeBy(2_001)
        assertEquals(2, port.changes.size)
        assertEquals(Phase.PLAYING, c.state.value.phase)
        assertEquals(stream to 30_000L, engine.loads.last().let { it.first.stream.url to it.second })
        assertEquals("s5", engine.loads.last().first.tracks.audio.single { it.selected }.id)
    }

    @Test
    fun aSubtitleChangeOnTheSameStreamSwitchesLocallyAndOffIsNull() = runTest {
        val port = FakePort().apply { onChange = { Fixtures.odyssey(id = "sess-1", subSel = null) } }
        val engine = FakeEngine()
        val c = controller(port, engine)
        c.start(start0)
        runCurrent()
        engine.position = 5_000
        c.selectSubtitle(null)
        runCurrent()
        assertEquals(TrackChange(subtitle = SubtitleChoice.Off, positionMs = 5_000), port.changes.single())
        assertEquals(1, engine.loads.size)
        assertEquals(1, engine.updates.size)
        assertTrue(engine.updates.single().tracks.subtitles.none { it.selected })
    }

    @Test
    fun subtitleReadyRereadsTheOverlayAndNeverReloadsTheStream() = runTest {
        val changed = CompletableDeferred<PlaybackSession>()
        val port = FakePort().apply {
            onStart = { withGrowingSidecar("sess-1") }
            onChange = { changed.await() }
        }
        val engine = FakeEngine()
        val c = controller(port, engine)
        c.start(start0)
        runCurrent()
        // A track change in flight, then the sidecar's file becomes final.
        c.selectAudio("s5")
        runCurrent()
        c.onEvent(AppEvent.SubtitleReady(7, "sess-1", "s1", "complete"))
        assertEquals(listOf("s1"), engine.completed)
        assertEquals(SessionTrack.Availability.complete, c.state.value.session!!.tracks.subtitles.single().availability)
        // The change still applies: same stream, so the engine keeps playing with the new selection.
        changed.complete(withGrowingSidecar("sess-1", audioSel = "s5"))
        runCurrent()
        assertEquals(1, engine.loads.size)
        assertEquals("s5", engine.updates.single().tracks.audio.single { it.selected }.id)
        // Another session's event, or a growing one, does nothing.
        c.onEvent(AppEvent.SubtitleReady(8, "sess-other", "s1", "complete"))
        c.onEvent(AppEvent.SubtitleReady(9, "sess-1", "s1", "growing"))
        assertEquals(listOf("s1"), engine.completed)
    }

    @Test
    fun subtitlePreparingFollowsTheEngineAndEndsWithTheStream() = runTest {
        val port = FakePort().apply { onStart = { withGrowingSidecar("sess-1") } }
        val engine = FakeEngine()
        val c = controller(port, engine)
        c.start(start0)
        runCurrent()
        engine.listener!!.onSubtitlePreparing(true)
        assertTrue(c.state.value.subtitlePreparing)
        engine.listener!!.onSubtitlePreparing(false)
        assertFalse(c.state.value.subtitlePreparing)
        engine.listener!!.onSubtitlePreparing(true)
        c.close()
        runCurrent()
        assertFalse(c.state.value.subtitlePreparing)
    }

    @Test
    fun aSubtitleLoadFailureRePlansWhileTheVideoKeepsPlaying() = runTest {
        val port = FakePort().apply {
            onStart = { withGrowingSidecar("sess-1") }
            onFailure = { withGrowingSidecar("sess-1").let { s -> s.copy(tracks = s.tracks.copy(subtitles = emptyList())) } }
        }
        val engine = FakeEngine()
        val c = controller(port, engine)
        c.start(start0)
        runCurrent()
        engine.position = 70_000
        engine.listener!!.onFailure(FailureAction.Replan("subtitle", "SUBTITLE_LOAD_FAILED:s1"))
        runCurrent()
        assertEquals(FallbackRequest(70_000, "SUBTITLE_LOAD_FAILED:s1", FallbackRequest.Suspect.subtitle), port.failures.single())
        // Same stream: no reload, the engine takes the new selection.
        assertEquals(1, engine.loads.size)
        assertEquals(0, engine.unloads)
        assertTrue(engine.updates.single().tracks.subtitles.isEmpty())
        assertEquals(Phase.PLAYING, c.state.value.phase)
    }

    @Test
    fun aSessionTerminatedEventEndsTheLiveSession() = runTest {
        val port = FakePort()
        val engine = FakeEngine()
        val c = controller(port, engine)
        c.start(start0)
        runCurrent()
        c.onEvent(AppEvent.SessionTerminated(1, "sess-other", "terminated"))
        assertEquals(Phase.PLAYING, c.state.value.phase)
        c.onEvent(AppEvent.SessionTerminated(2, "sess-1", "terminated"))
        assertEquals(Phase.TERMINATED, c.state.value.phase)
        c.close()
        runCurrent()
        assertEquals(emptyList<Pair<String, Long>>(), port.stops)
    }
}
