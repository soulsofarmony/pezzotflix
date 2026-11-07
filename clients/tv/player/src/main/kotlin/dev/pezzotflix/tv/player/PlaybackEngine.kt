package dev.pezzotflix.tv.player

import dev.pezzotflix.api.models.PlaybackSession
import dev.pezzotflix.tv.player.failures.FailureAction
import dev.pezzotflix.tv.player.tracks.TrackPlan

/** What the engine reports; the controller ignores a listener whose load it no longer plays. */
interface EngineListener {
    fun onFailure(action: FailureAction)
    fun onState(state: EngineState)
    fun onSeeked()
    fun onNotice(notice: TrackPlan.Notice?)
}

enum class EngineState { BUFFERING, PLAYING, PAUSED, ENDED }

/**
 * One player for the whole screen (Media3Engine in the app; a fake in tests). Positions are on the original
 * timeline: Media3 reports the file time in Direct Play and the VOD playlist time in HLS, which covers the film from 0
 * (doc 05 §8.10), so no offset applies.
 */
interface PlaybackEngine {
    /** Loads the session's stream at [startMs]; it plays once the plan's tracks are applied. */
    fun load(session: PlaybackSession, startMs: Long, listener: EngineListener)

    /** The same stream with the session's new selection: tracks switch locally. */
    fun update(session: PlaybackSession)

    /** Stops and forgets the stream. */
    fun unload()

    fun positionMs(): Long?
    fun bufferedMs(): Long
    fun play()
    fun pause()
    fun seekTo(positionMs: Long)
    val isPlaying: Boolean
}
