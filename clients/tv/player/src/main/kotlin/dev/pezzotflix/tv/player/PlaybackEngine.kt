package dev.pezzotflix.tv.player

import dev.pezzotflix.api.models.PlaybackSession
import dev.pezzotflix.tv.player.failures.FailureAction

/** What the engine reports; the controller ignores a listener whose load it no longer plays. */
interface EngineListener {
    fun onFailure(action: FailureAction)
    fun onState(state: EngineState)
    fun onSeeked()

    /** The selected subtitle served apart cannot show anything yet ("sottotitoli in preparazione"). */
    fun onSubtitlePreparing(preparing: Boolean)
}

enum class EngineState { BUFFERING, PLAYING, PAUSED, ENDED }

/**
 * One player for the whole screen (Media3Engine in the app; a fake in tests). Positions are taken as the original
 * timeline. In Direct Play Media3 reports the file time. In HLS it reports the VOD playlist time, which covers the
 * film from 0 (doc 05 §8.10), so the engine applies no offset; but Media3's TimestampAdjuster maps the first sample
 * it reads onto its segment's playlist start, so a small constant δ (tens to a couple of hundred ms, the one the
 * web corrects with initPTS) may remain. Not measured yet on the TV (S5 did not measure a far seek in Direct Stream).
 */
interface PlaybackEngine {
    /**
     * Loads the session's stream at [startMs]; it plays once the plan's tracks are applied. Returns the failure when
     * the stream cannot even be loaded (a locator that does not parse): the listener is not called for it.
     */
    fun load(session: PlaybackSession, startMs: Long, listener: EngineListener): FailureAction?

    /** The same stream with the session's new selection: tracks switch locally. */
    fun update(session: PlaybackSession)

    /** playback.subtitle_ready: the selected track served apart is final; its cues are read again and swapped. */
    fun subtitleComplete(trackId: String)

    /** Stops and forgets the stream. */
    fun unload()

    fun positionMs(): Long?
    fun bufferedMs(): Long
    fun play()
    fun pause()
    fun seekTo(positionMs: Long)
    val isPlaying: Boolean
}
