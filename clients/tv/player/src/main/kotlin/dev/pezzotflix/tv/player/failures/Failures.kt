package dev.pezzotflix.tv.player.failures

import androidx.media3.common.C
import androidx.media3.common.PlaybackException

/** What the controller does about a player failure (doc 04 §8, doc 05 §8.10). */
sealed interface FailureAction {
    /** reportPlaybackFailure with this dimension: the server re-plans with the minimum change. */
    data class Replan(val suspect: String, val error: String) : FailureAction

    /** The stream answered 401/403/404/410: ask the control plane why once, then start again or show the reason. */
    data class Restart(val error: String) : FailureAction

    /** No answer after the player's own retries: "Connessione persa". */
    data class Network(val error: String) : FailureAction
}

/**
 * A Media3 PlaybackException reduced to what the classification needs (the engine extracts it): the error code and its
 * name, the track type of the failing renderer's format (C.TRACK_TYPE_*), and the HTTP status and URI of a failed load.
 */
data class PlayerError(
    val code: Int,
    val codeName: String,
    val rendererTrackType: Int? = null,
    val httpStatus: Int? = null,
    val uri: String? = null,
)

object FailureClassifier {
    /**
     * [subtitleUrls]: the resolved urls of the session's separately served subtitles; a load that failed on one of them
     * is a subtitle failure, whatever its status.
     */
    fun classify(e: PlayerError, subtitleUrls: Collection<String> = emptyList()): FailureAction {
        if (e.uri != null && subtitleUrls.any { it == e.uri }) return FailureAction.Replan("subtitle", "SUBTITLE_LOAD_FAILED")
        e.httpStatus?.let { status ->
            return when (status) {
                401, 403, 404, 410 -> FailureAction.Restart("HTTP_$status")
                // 503 is retried by the load policy (Retry-After); still failing after that, like any other 5xx.
                else -> FailureAction.Replan("unknown", "STREAM_FAILED")
            }
        }
        return when (e.code) {
            PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED, PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT -> FailureAction.Network(e.codeName)
            PlaybackException.ERROR_CODE_DECODER_INIT_FAILED, PlaybackException.ERROR_CODE_DECODER_QUERY_FAILED, PlaybackException.ERROR_CODE_DECODING_FAILED,
            PlaybackException.ERROR_CODE_DECODING_FORMAT_EXCEEDS_CAPABILITIES, PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED,
            -> FailureAction.Replan(suspectOf(e.rendererTrackType), e.codeName)
            PlaybackException.ERROR_CODE_AUDIO_TRACK_INIT_FAILED, PlaybackException.ERROR_CODE_AUDIO_TRACK_WRITE_FAILED,
            PlaybackException.ERROR_CODE_AUDIO_TRACK_OFFLOAD_INIT_FAILED, PlaybackException.ERROR_CODE_AUDIO_TRACK_OFFLOAD_WRITE_FAILED,
            -> FailureAction.Replan("audio", e.codeName)
            PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED, PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED -> FailureAction.Replan("container", e.codeName)
            PlaybackException.ERROR_CODE_PARSING_MANIFEST_MALFORMED, PlaybackException.ERROR_CODE_PARSING_MANIFEST_UNSUPPORTED -> FailureAction.Replan("unknown", e.codeName)
            PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS -> FailureAction.Replan("unknown", "STREAM_FAILED")
            else -> FailureAction.Replan(suspectOf(e.rendererTrackType), e.codeName)
        }
    }

    private fun suspectOf(trackType: Int?): String = when (trackType) {
        C.TRACK_TYPE_VIDEO -> "video"
        C.TRACK_TYPE_AUDIO -> "audio"
        C.TRACK_TYPE_TEXT -> "subtitle"
        else -> "unknown"
    }
}

/**
 * Retry delays of the load error policy (doc 05 §8.10), pure: null means fatal at once.
 * - 503: after Retry-After, else 2 s, for about a minute (STREAM_PREPARING of a subtitle or a segment);
 * - any other HTTP status: fatal at once (the controller re-plans or restarts);
 * - no answer: backoff 1, 2, 4, 8, 8, 8 s, then fatal ("Connessione persa").
 */
object LoadRetry {
    const val PREPARING_LIMIT_MS = 60_000L
    const val DEFAULT_RETRY_AFTER_MS = 2_000L
    private const val NETWORK_ATTEMPTS = 6

    fun delayMs(httpStatus: Int?, isNetwork: Boolean, errorCount: Int, retryAfterMs: Long?): Long? = when {
        httpStatus == 503 -> {
            val step = (retryAfterMs ?: DEFAULT_RETRY_AFTER_MS).coerceIn(500, 10_000)
            if (step * (errorCount - 1) < PREPARING_LIMIT_MS) step else null
        }
        httpStatus != null -> null
        isNetwork && errorCount <= NETWORK_ATTEMPTS -> 1_000L shl minOf(errorCount - 1, 3)
        else -> null
    }
}
