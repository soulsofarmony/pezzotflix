package dev.pezzotflix.tv.api

import dev.pezzotflix.api.models.FallbackRequest
import dev.pezzotflix.api.models.PlaybackSession
import dev.pezzotflix.api.models.ProgressReport

/**
 * The session calls the player makes (doc 03 §4, doc 04 §8). Every failure is an [ApiException]. Implemented by
 * [VideoApi]; the player's tests use a fake.
 */
interface PlaybackPort {
    suspend fun startPlayback(request: StartRequest): PlaybackSession
    suspend fun reportProgress(sessionId: String, report: ProgressReport)
    suspend fun stopPlayback(sessionId: String, positionMs: Long)
    suspend fun changeTracks(sessionId: String, change: TrackChange): PlaybackSession
    suspend fun reportPlaybackFailure(sessionId: String, request: FallbackRequest): PlaybackSession
    suspend fun terminateSession(sessionId: String)
}
