package dev.pezzotflix.tv.ui.player

import dev.pezzotflix.api.models.Trickplay
import dev.pezzotflix.tv.player.PlayerController.Phase
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Scrub mode on the remote (doc 08 §3 T3): entry, steps and acceleration, clamp, confirm and cancel. */
class ScrubberTest {
    private class FakeTransport(var position: Long = 600_000, var playing: Boolean = true, var duration: Long = 8_940_000) : ScrubTransport {
        val calls = mutableListOf<String>()
        override fun positionMs() = position
        override fun durationMs() = duration
        override fun playing() = playing
        override fun play() {
            playing = true
            calls += "play"
        }
        override fun pause() {
            playing = false
            calls += "pause"
        }
        override fun seekTo(positionMs: Long) {
            position = positionMs
            calls += "seek:$positionMs"
        }
    }

    private val tp = Trickplay(10_000, 320, 180, 10, 10, 895, listOf("/s0.jpg"))

    @Test
    fun entryNeedsHiddenControlsAPlayingSessionAndTrickplay() {
        assertTrue(scrubAvailable(controlsVisible = false, panelOpen = false, phase = Phase.PLAYING, trickplay = tp))
        assertFalse(scrubAvailable(controlsVisible = true, panelOpen = false, phase = Phase.PLAYING, trickplay = tp))
        assertFalse(scrubAvailable(controlsVisible = false, panelOpen = true, phase = Phase.PLAYING, trickplay = tp))
        assertFalse(scrubAvailable(controlsVisible = false, panelOpen = false, phase = Phase.REPLANNING, trickplay = tp))
        assertFalse(scrubAvailable(controlsVisible = false, panelOpen = false, phase = Phase.PLAYING, trickplay = null))
    }

    @Test
    fun withoutTrickplayThePressIsLeftToTheImmediateSeek() {
        val t = FakeTransport()
        val s = Scrubber(t)
        assertFalse(s.press(forward = true, heldMs = 0, eventTimeMs = 1_000, available = false))
        assertNull(s.state.value)
        assertEquals(emptyList<String>(), t.calls)
    }

    @Test
    fun enteringRemembersPausesPreloadsAndMovesTheTargetOnly() {
        val t = FakeTransport()
        val entered = mutableListOf<Long>()
        val s = Scrubber(t) { entered += it }
        assertTrue(s.press(forward = true, heldMs = 0, eventTimeMs = 1_000, available = true))
        assertEquals(Scrubber.State(startMs = 600_000, wasPlaying = true, targetMs = 610_000), s.state.value)
        assertEquals(listOf(600_000L), entered)
        s.press(forward = true, heldMs = 0, eventTimeMs = 1_300, available = true)
        s.press(forward = false, heldMs = 0, eventTimeMs = 1_600, available = true)
        s.press(forward = false, heldMs = 0, eventTimeMs = 1_900, available = true)
        assertEquals(600_000L, s.state.value!!.targetMs)
        // The player only paused: the real position (what progress reports send) never followed the target.
        assertEquals(listOf("pause"), t.calls)
        assertEquals(600_000L, t.position)
    }

    @Test
    fun aHeldKeyAcceleratesAfterOneAndThreeSeconds() {
        val cases = listOf(0L to 10_000L, 999L to 10_000L, 1_000L to 30_000L, 2_999L to 30_000L, 3_000L to 60_000L, 20_000L to 60_000L)
        for ((held, step) in cases) assertEquals("$held", step, Scrubber.stepFor(held))

        val t = FakeTransport(position = 0)
        val s = Scrubber(t)
        val down = 10_000L
        s.press(true, 0, down, true) // 10 s
        s.press(true, 500, down + 500, true) // first system repeat: 10 s
        s.press(true, 1_100, down + 1_100, true) // 30 s
        s.press(true, 3_200, down + 3_200, true) // 60 s
        assertEquals(110_000L, s.state.value!!.targetMs)
    }

    @Test
    fun repeatsCloserThanTheMinimumIntervalAreSkipped() {
        val s = Scrubber(FakeTransport(position = 0))
        s.press(true, 0, 1_000, true)
        s.press(true, 500, 1_500, true)
        s.press(true, 550, 1_550, true) // 50 ms later: skipped
        s.press(true, 600, 1_600, true)
        assertEquals(30_000L, s.state.value!!.targetMs)
        // A fresh press is never skipped.
        s.press(true, 0, 1_610, true)
        assertEquals(40_000L, s.state.value!!.targetMs)
    }

    @Test
    fun theTargetStaysWithinTheFilm() {
        val t = FakeTransport(position = 5_000, duration = 100_000)
        val s = Scrubber(t)
        s.press(false, 0, 1_000, true)
        assertEquals(0L, s.state.value!!.targetMs)
        repeat(20) { s.press(true, 0, 2_000L + it * 200, true) }
        assertEquals(100_000L, s.state.value!!.targetMs)
        s.moveBy(-30_000)
        assertEquals(70_000L, s.state.value!!.targetMs)
    }

    @Test
    fun confirmSeeksToTheTargetAndPlaysEvenIfItWasPaused() {
        val t = FakeTransport(playing = false)
        val s = Scrubber(t)
        s.press(true, 0, 1_000, true)
        s.press(true, 0, 1_300, true)
        assertTrue(s.confirm())
        assertNull(s.state.value)
        assertEquals(listOf("pause", "seek:620000", "play"), t.calls)
        assertFalse(s.confirm())
    }

    @Test
    fun cancelRestoresThePlayStateWithoutASeek() {
        val t = FakeTransport(playing = true)
        val s = Scrubber(t)
        s.press(true, 0, 1_000, true)
        s.press(true, 0, 1_300, true)
        assertTrue(s.cancel())
        assertNull(s.state.value)
        assertEquals(listOf("pause", "play"), t.calls)
        assertEquals(600_000L, t.position)

        val paused = FakeTransport(playing = false)
        val p = Scrubber(paused)
        p.press(false, 0, 1_000, true)
        p.cancel()
        assertEquals(listOf("pause"), paused.calls)
        assertFalse(paused.playing)
    }

    @Test
    fun cancelAfterAReplanMovedThePlayerSeeksBackToTheStart() {
        val t = FakeTransport(playing = true)
        val s = Scrubber(t)
        s.press(true, 0, 1_000, true)
        // A re-plan reloaded the stream, which started playing on its own: it is paused again and has moved on.
        t.playing = true
        s.holdPaused(playing = true)
        t.position = 602_400
        s.cancel()
        assertEquals(listOf("pause", "pause", "seek:600000", "play"), t.calls)
    }

    @Test
    fun abortForgetsTheModeWithoutTouchingThePlayer() {
        val t = FakeTransport()
        val s = Scrubber(t)
        s.press(true, 0, 1_000, true)
        s.abort()
        assertNull(s.state.value)
        assertFalse(s.cancel())
        s.holdPaused(playing = true)
        assertEquals(listOf("pause"), t.calls)
    }
}
