package dev.pezzotflix.tv.ui.player

import dev.pezzotflix.api.models.ClientCapabilities
import dev.pezzotflix.api.models.ClientCapabilitiesDevice
import dev.pezzotflix.api.models.ClientCapabilitiesSubtitles
import dev.pezzotflix.api.models.DeliveryMode
import dev.pezzotflix.api.models.FallbackRequest
import dev.pezzotflix.api.models.PlaybackSession
import dev.pezzotflix.api.models.PlaybackSessionStream
import dev.pezzotflix.api.models.PlaybackSessionTracks
import dev.pezzotflix.api.models.ProgressReport
import dev.pezzotflix.api.models.Trickplay
import dev.pezzotflix.tv.api.PlaybackPort
import dev.pezzotflix.tv.api.StartRequest
import dev.pezzotflix.tv.api.TrackChange
import dev.pezzotflix.tv.player.EngineListener
import dev.pezzotflix.tv.player.EngineState
import dev.pezzotflix.tv.player.PlaybackEngine
import dev.pezzotflix.tv.player.PlayerController
import dev.pezzotflix.tv.player.failures.FailureAction
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Scrub mode on the real PlayerController, with a fake server and engine: progress reports send the player's own
 * position while the target moves, and a confirm lands on the target.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ScrubProgressTest {
    private class Port(private val session: PlaybackSession) : PlaybackPort {
        val progress = mutableListOf<ProgressReport>()
        override suspend fun startPlayback(request: StartRequest) = session
        override suspend fun reportProgress(sessionId: String, report: ProgressReport) {
            progress += report
        }
        override suspend fun stopPlayback(sessionId: String, positionMs: Long) = Unit
        override suspend fun changeTracks(sessionId: String, change: TrackChange) = error("unexpected")
        override suspend fun reportPlaybackFailure(sessionId: String, request: FallbackRequest) = error("unexpected")
        override suspend fun terminateSession(sessionId: String) = Unit
    }

    private class Engine : PlaybackEngine {
        var listener: EngineListener? = null
        var position = 0L
        override var isPlaying = false
        override fun load(session: PlaybackSession, startMs: Long, listener: EngineListener): FailureAction? {
            this.listener = listener
            position = startMs
            return null
        }
        override fun update(session: PlaybackSession) = Unit
        override fun subtitleComplete(trackId: String) = Unit
        override fun unload() = Unit
        override fun positionMs() = position
        override fun bufferedMs() = position
        override fun play() {
            isPlaying = true
            listener?.onState(EngineState.PLAYING)
        }
        override fun pause() {
            isPlaying = false
            listener?.onState(EngineState.PAUSED)
        }
        override fun seekTo(positionMs: Long) {
            position = positionMs
            listener?.onSeeked()
        }
    }

    private val session = PlaybackSession(
        sessionId = "sess-1", expiresAt = 1_794_000_000_000, mode = DeliveryMode.direct_play, reasons = emptyList(),
        stream = PlaybackSessionStream(url = "/video/media/s/tok_aaaaaaaaaaaaaaaa/file", protocol = PlaybackSessionStream.Protocol.progressive),
        tracks = PlaybackSessionTracks(emptyList(), emptyList()), resumePositionMs = 600_000, durationMs = 8_940_000,
        chapters = emptyList(), heartbeatIntervalMs = 10_000,
        trickplay = Trickplay(10_000, 320, 180, 10, 10, 894, listOf("/video/media/s/tok_aaaaaaaaaaaaaaaa/trickplay/sheet-0.jpg")),
    )

    private fun TestScope.controller(port: Port, engine: Engine) = PlayerController(
        api = port, engine = engine, scope = backgroundScope, releaseScope = backgroundScope, now = { currentTime },
        capabilities = {
            ClientCapabilities(
                device = ClientCapabilitiesDevice(ClientCapabilitiesDevice.PropertyClass.tv), containers = listOf("mkv"),
                protocols = listOf("progressive"), video = emptyList(), audio = emptyList(),
                subtitles = ClientCapabilitiesSubtitles(emptyList(), emptyList()),
            )
        },
    )

    /** As PlayerViewModel wires it (there the intent is Media3's playWhenReady). */
    private fun transport(c: PlayerController, engine: Engine) = object : ScrubTransport {
        override fun positionMs() = c.positionMs()
        override fun durationMs() = c.state.value.durationMs
        override fun playing() = engine.isPlaying && !c.state.value.ended
        override fun play() = c.play()
        override fun pause() = c.pause()
        override fun seekTo(positionMs: Long) = c.seekTo(positionMs)
    }

    @Test
    fun progressReportsTheRealPositionWhileScrubbingAndTheTargetAfterConfirm() = runTest {
        val port = Port(session)
        val engine = Engine()
        val c = controller(port, engine)
        c.start(PlayerController.StartOptions(itemId = "item-1"))
        runCurrent()
        engine.play()
        val s = Scrubber(transport(c, engine))

        assertTrue(s.press(forward = true, heldMs = 0, eventTimeMs = 1_000, available = true))
        repeat(30) { s.press(true, 0, 1_200L + it * 200, true) }
        assertEquals(910_000L, s.state.value!!.targetMs)
        advanceTimeBy(25_000)
        assertTrue(port.progress.isNotEmpty())
        assertTrue(port.progress.all { it.positionMs == 600_000L })
        assertEquals(ProgressReport.State.paused, port.progress.last().state)

        s.confirm()
        runCurrent()
        assertEquals(910_000L, engine.position)
        assertTrue(engine.isPlaying)
        assertEquals(910_000L, port.progress.last().positionMs)
    }
}
