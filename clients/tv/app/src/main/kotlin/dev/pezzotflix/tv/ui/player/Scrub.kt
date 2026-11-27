package dev.pezzotflix.tv.ui.player

import dev.pezzotflix.api.models.Trickplay
import dev.pezzotflix.tv.player.PlayerController.Phase
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlin.math.abs

/** What scrub mode needs from the player (PlayerController and the Media3 player in the app; a fake in tests). */
interface ScrubTransport {
    /** The real position, original timeline. */
    fun positionMs(): Long
    fun durationMs(): Long
    /** The viewer's intent: playing, or about to play once buffered. */
    fun playing(): Boolean
    fun play()
    fun pause()
    fun seekTo(positionMs: Long)
}

/**
 * Left/right enter scrub mode only with the controls hidden, a playing session and its trickplay (ADR 0009 D6).
 * Otherwise left/right keep today's behaviour: focus between buttons, or an immediate ±10 s.
 */
fun scrubAvailable(controlsVisible: Boolean, panelOpen: Boolean, phase: Phase, trickplay: Trickplay?): Boolean =
    !controlsVisible && !panelOpen && phase == Phase.PLAYING && trickplay != null

/**
 * Scrub mode on the remote (doc 08 §3 T3): the video pauses and a target moves along the bar with its preview;
 * nothing is seeked until the viewer confirms. Progress reports keep sending the real position because the player
 * itself never moves. Main thread only.
 */
class Scrubber(
    private val transport: ScrubTransport,
    /** Entering, with the start position: the screen preloads that sheet. */
    private val onEnter: (positionMs: Long) -> Unit = {},
) {
    data class State(val startMs: Long, val wasPlaying: Boolean, val targetMs: Long)

    private val _state = MutableStateFlow<State?>(null)
    val state: StateFlow<State?> = _state.asStateFlow()
    val active: Boolean get() = _state.value != null

    private var lastStepAt = Long.MIN_VALUE

    /**
     * A left/right key down. [heldMs]: how long the key has been held (0 for a fresh press; KeyEvent's eventTime −
     * downTime for a repeat), which sets the step. [available]: may this press enter scrub mode (see
     * [scrubAvailable]). False when it did not enter: the caller seeks as before.
     */
    fun press(forward: Boolean, heldMs: Long, eventTimeMs: Long, available: Boolean): Boolean {
        var cur = _state.value
        if (cur == null) {
            if (!available) return false
            val pos = transport.positionMs()
            cur = State(startMs = pos, wasPlaying = transport.playing(), targetMs = pos)
            transport.pause()
            _state.value = cur
            onEnter(pos)
        } else if (heldMs > 0 && eventTimeMs - lastStepAt < MIN_REPEAT_INTERVAL_MS) {
            // The system repeats a held key every 50 ms: at most one step per interval keeps the target followable.
            return true
        }
        lastStepAt = eventTimeMs
        move(cur, if (forward) stepFor(heldMs) else -stepFor(heldMs))
        return true
    }

    /** Moves the target while scrubbing (the media fast-forward and rewind keys). */
    fun moveBy(deltaMs: Long) {
        _state.value?.let { move(it, deltaMs) }
    }

    /** OK or Play/Pause: seek to the target and play. */
    fun confirm(): Boolean {
        val cur = take() ?: return false
        transport.seekTo(cur.targetMs)
        transport.play()
        return true
    }

    /**
     * Back: the remembered position and play state come back. The player was only paused, so no seek is needed
     * unless something moved it meanwhile (a re-plan reloads the stream where it was, and may have played on).
     */
    fun cancel(): Boolean {
        val cur = take() ?: return false
        if (abs(transport.positionMs() - cur.startMs) > SAME_POSITION_MS) transport.seekTo(cur.startMs)
        if (cur.wasPlaying) transport.play()
        return true
    }

    /** The player left for a dialog or closed: nothing to restore. */
    fun abort() {
        _state.value = null
    }

    /** While scrubbing the video stays still: a reload that starts playing by itself (a re-plan) is paused again. */
    fun holdPaused(playing: Boolean) {
        if (active && playing) transport.pause()
    }

    private fun move(cur: State, deltaMs: Long) {
        val duration = transport.durationMs().takeIf { it > 0 } ?: Long.MAX_VALUE
        _state.value = cur.copy(targetMs = (cur.targetMs + deltaMs).coerceIn(0, duration))
    }

    private fun take(): State? = _state.value?.also { _state.value = null }

    companion object {
        const val STEP_MS = 10_000L
        const val STEP_HELD_1S_MS = 30_000L
        const val STEP_HELD_3S_MS = 60_000L
        const val MIN_REPEAT_INTERVAL_MS = 100L
        /** Paused on entry, the player may still report a few ms more: no seek for that. */
        const val SAME_POSITION_MS = 500L

        /** 10 s per press; a held key goes to 30 s after 1 s and to 60 s after 3 s. */
        fun stepFor(heldMs: Long): Long = when {
            heldMs >= 3_000 -> STEP_HELD_3S_MS
            heldMs >= 1_000 -> STEP_HELD_1S_MS
            else -> STEP_MS
        }
    }
}
