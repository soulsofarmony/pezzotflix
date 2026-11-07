package dev.pezzotflix.tv.player.failures

import androidx.media3.common.C
import androidx.media3.common.PlaybackException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** doc 05 §8.10, the table "Segnale di Media3 → Azione". */
class FailureClassifierTest {
    private fun err(code: Int, track: Int? = null, status: Int? = null, uri: String? = null) =
        PlayerError(code, "E$code", track, status, uri)

    @Test
    fun media3SignalsMapToTheRePlanDimension() {
        val cases = listOf(
            err(PlaybackException.ERROR_CODE_DECODER_INIT_FAILED, C.TRACK_TYPE_VIDEO) to FailureAction.Replan("video", "E4001"),
            err(PlaybackException.ERROR_CODE_DECODING_FAILED, C.TRACK_TYPE_AUDIO) to FailureAction.Replan("audio", "E4003"),
            err(PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED, C.TRACK_TYPE_TEXT) to FailureAction.Replan("subtitle", "E4005"),
            err(PlaybackException.ERROR_CODE_DECODING_FORMAT_EXCEEDS_CAPABILITIES, C.TRACK_TYPE_VIDEO) to FailureAction.Replan("video", "E4004"),
            err(PlaybackException.ERROR_CODE_DECODER_INIT_FAILED, null) to FailureAction.Replan("unknown", "E4001"),
            err(PlaybackException.ERROR_CODE_AUDIO_TRACK_INIT_FAILED) to FailureAction.Replan("audio", "E5001"),
            err(PlaybackException.ERROR_CODE_AUDIO_TRACK_WRITE_FAILED) to FailureAction.Replan("audio", "E5002"),
            err(PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED) to FailureAction.Replan("container", "E3003"),
            err(PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED) to FailureAction.Replan("container", "E3001"),
            err(PlaybackException.ERROR_CODE_PARSING_MANIFEST_MALFORMED) to FailureAction.Replan("unknown", "E3002"),
            err(PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED) to FailureAction.Network("E2001"),
            err(PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT) to FailureAction.Network("E2002"),
            err(PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS, status = 404) to FailureAction.Restart("HTTP_404"),
            err(PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS, status = 410) to FailureAction.Restart("HTTP_410"),
            err(PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS, status = 401) to FailureAction.Restart("HTTP_401"),
            err(PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS, status = 500) to FailureAction.Replan("unknown", "STREAM_FAILED"),
            err(PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS, status = 503) to FailureAction.Replan("unknown", "STREAM_FAILED"),
        )
        for ((e, expected) in cases) assertEquals("${e.code}/${e.httpStatus}", expected, FailureClassifier.classify(e))
    }

    @Test
    fun subtitlesServedApartFailThroughTheOverlayNotMedia3() {
        // Media3 loads only the stream: a 404 is the stream's (the session closed), whatever the url.
        val url = "http://192.168.1.12:18480/video/media/s/tok/subtitles/s6.vtt"
        val e = err(PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS, status = 404, uri = url)
        assertEquals(FailureAction.Restart("HTTP_404"), FailureClassifier.classify(e))
        // The overlay's failure, as the web client reports it (doc 05 §8.10).
        assertEquals(FailureAction.Replan("subtitle", "SUBTITLE_LOAD_FAILED:s6"), FailureClassifier.subtitleLoadFailed("s6"))
    }

    @Test
    fun loadRetryDelays() {
        // 503: Retry-After or 2 s, for about a minute.
        assertEquals(3_000L, LoadRetry.delayMs(503, false, 1, 3_000))
        assertEquals(2_000L, LoadRetry.delayMs(503, false, 30, null))
        assertNull(LoadRetry.delayMs(503, false, 31, null))
        // Any other status: fatal at once.
        for (status in listOf(400, 404, 410, 500, 502)) assertNull("$status", LoadRetry.delayMs(status, false, 1, null))
        // No answer: 1, 2, 4, 8, 8, 8 s, then fatal.
        assertEquals(listOf(1_000L, 2_000L, 4_000L, 8_000L, 8_000L, 8_000L, null), (1..7).map { LoadRetry.delayMs(null, true, it, null) })
        // Parse errors and the like: fatal.
        assertNull(LoadRetry.delayMs(null, false, 1, null))
    }
}
