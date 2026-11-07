package dev.pezzotflix.tv.ui

import dev.pezzotflix.api.models.SessionTrack
import dev.pezzotflix.tv.api.ApiException
import org.junit.Assert.assertEquals
import org.junit.Test

class StringsTest {
    @Test
    fun clock() {
        val cases = listOf(0L to "0:00", 59_999L to "0:59", 61_000L to "1:01", 3_600_000L to "1:00:00", 6_443_000L to "1:47:23", -5L to "0:00")
        for ((ms, text) in cases) assertEquals("$ms", text, formatClock(ms))
    }

    @Test
    fun duration() {
        val cases = listOf(25_000L to "25 s", 35_000L to "1 min", 47 * 60_000L to "47 min", 120 * 60_000L to "2 h", 107 * 60_000L to "1 h 47 min")
        for ((ms, text) in cases) assertEquals("$ms", text, formatDuration(ms))
    }

    @Test
    fun languages() {
        val cases = listOf("ita" to "Italiano", "eng" to "Inglese", "ger" to "Tedesco", "fre" to "Francese", "en" to "Inglese", "und" to null, null to null)
        for ((code, name) in cases) assertEquals("$code", name, languageName(code))
    }

    @Test
    fun channels() {
        val cases = listOf(Triple(6L, null, "5.1"), Triple(8L, "7.1", "7.1"), Triple(2L, "stereo", "2.0"), Triple(6L, "5.1(side)", "5.1"), Triple(3L, null, "3 ch"), Triple(null, null, null))
        for ((ch, layout, label) in cases) assertEquals("$ch $layout", label, channelLabel(ch, layout))
    }

    private fun track(type: SessionTrack.Type, codec: String, language: String?, channels: Long? = null, forced: Boolean? = null, title: String? = null, objectAudio: String? = null) =
        SessionTrack(id = "t", type = type, index = 0, selected = false, switchWithoutRestart = true, codec = codec, language = language, channels = channels, forced = forced, title = title, objectAudio = objectAudio)

    @Test
    fun trackLabels() {
        val cases = listOf(
            track(SessionTrack.Type.audio, "truehd", "eng", 8, objectAudio = "atmos") to "Inglese · TrueHD 7.1 Atmos",
            track(SessionTrack.Type.audio, "ac3", "ita", 6) to "Italiano · AC-3 5.1",
            track(SessionTrack.Type.subtitle, "hdmv_pgs_subtitle", "ita", forced = true) to "Italiano · PGS · forzati",
            track(SessionTrack.Type.subtitle, "subrip", null, title = "Commento") to "Lingua sconosciuta · SRT · «Commento»",
            track(SessionTrack.Type.subtitle, "subrip", "eng", title = "Inglese") to "Inglese · SRT",
        )
        for ((t, label) in cases) assertEquals(label, trackLabel(t))
    }

    @Test
    fun errorsByCode() {
        val cases = listOf(
            ApiException(0, "NETWORK") to Txt.ERROR_NETWORK,
            ApiException(404, "NOT_FOUND") to Txt.ERROR_NOT_FOUND,
            ApiException(401, "UNAUTHORIZED") to Txt.ERROR_UNAUTHORIZED,
            ApiException(503, "MEDIA_UNAVAILABLE") to Txt.ERROR_SERVICE,
            ApiException(503, "SOMETHING") to Txt.ERROR_SERVICE,
            ApiException(500, "INTERNAL") to Txt.ERROR_GENERIC,
        )
        for ((e, text) in cases) assertEquals(e.code, text, Txt.error(e))
        assertEquals(Txt.ERROR_GENERIC, Txt.error(IllegalStateException()))
    }
}
