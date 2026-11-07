package dev.pezzotflix.tv.player.tracks

import dev.pezzotflix.api.models.DeliveryMode
import dev.pezzotflix.api.models.PlaybackSessionStream
import dev.pezzotflix.api.models.SessionTrack.Delivery
import dev.pezzotflix.tv.player.Fixtures
import dev.pezzotflix.tv.player.Fixtures.audio
import dev.pezzotflix.tv.player.Fixtures.media
import dev.pezzotflix.tv.player.Fixtures.sub
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TrackMatcherTest {
    @Test
    fun odysseyDirectPlayForcesThePlansAudioAndSubtitle() {
        val cases = listOf(
            // (plan audio, plan subtitle) -> (media group of audio, media group of text, text off)
            Triple("s4", "s3", Triple(4, 3, false)),
            Triple("s5", "s1", Triple(5, 1, false)),
            Triple("s5", "s2", Triple(5, 2, false)),
            Triple("s4", null, Triple(4, null, true)),
        )
        for ((a, t, expected) in cases) {
            val plan = TrackMatcher.plan(Fixtures.odyssey(a, t), Fixtures.odysseyMedia())
            assertEquals("$a/$t", expected, Triple(plan.audio?.group, plan.text?.group, plan.textOff))
            assertNull(plan.notice)
        }
    }

    @Test
    fun aTrackMedia3DidNotExtractFallsBackToAttributes() {
        // The first English SRT is missing on the Media3 side: ordinals no longer line up.
        val media = Fixtures.odysseyMedia().filterNot { it.group == 1 }
        val plan = TrackMatcher.plan(Fixtures.odyssey("s4", "s2"), media)
        assertEquals(2, plan.text?.group)
        val pgs = TrackMatcher.plan(Fixtures.odyssey("s4", "s3"), media)
        assertEquals(3, pgs.text?.group)
    }

    @Test
    fun ordinalsThatDisagreeOnCodecOrLanguageAreNotTrusted() {
        // Same count, but Media3 lists the AAC first: the codec family decides.
        val media = listOf(
            media(dev.pezzotflix.tv.player.tracks.MediaTrack.Kind.AUDIO, 1, "2", "audio/mp4a-latm", null, "en", 6),
            media(dev.pezzotflix.tv.player.tracks.MediaTrack.Kind.AUDIO, 2, "3", "audio/ac3", null, "it", 6),
        )
        val plan = TrackMatcher.plan(Fixtures.odyssey("s4", null), media)
        assertEquals(2, plan.audio?.group)
    }

    @Test
    fun bladeRunnerDirectStreamUsesSidecarsByIdAndSkipsTheSup() {
        val session = Fixtures.session(
            DeliveryMode.direct_stream, "/video/media/s/tok_bbbbbbbbbbbbbbbb/hls/master.m3u8", PlaybackSessionStream.Protocol.hlsMinusFmp4,
            audio = listOf(audio("s1", 1, "truehd", "ita", 6, true, "TrueHD 5.1"), audio("s2", 2, "eac3", "eng", 6), audio("s3", 3, "ac3", "ita", 2)),
            subtitles = listOf(
                sub("s4", 4, "hdmv_pgs_subtitle", "ita", selected = true, forced = true, title = "Forced", delivery = Delivery.client_render, url = "/video/media/s/tok/subtitles/s4.sup"),
                sub("s5", 5, "hdmv_pgs_subtitle", "ita", title = "Completi", delivery = Delivery.client_render, url = "/video/media/s/tok/subtitles/s5.sup"),
                sub("s6", 6, "subrip", "ita", title = "SRT", delivery = Delivery.sidecar, url = "/video/media/s/tok/subtitles/s6.vtt"),
                sub("s7", 7, "ass", "eng", title = "ASS styled", delivery = Delivery.sidecar, url = "/video/media/s/tok/subtitles/s7.vtt"),
            ),
        )
        val media = listOf(
            media(MediaTrack.Kind.VIDEO, 0, "1", "video/hevc", null, null, null),
            media(MediaTrack.Kind.AUDIO, 1, "2", "audio/flac", null, null, 6),
            media(MediaTrack.Kind.TEXT, 2, "1:s6", Fixtures.CUES, "text/vtt", "it", null),
            media(MediaTrack.Kind.TEXT, 3, "2:s7", Fixtures.CUES, "text/vtt", "en", null),
        )
        val forced = TrackMatcher.plan(session, media)
        // One muxed audio track in HLS: no override; the .sup is not rendered by this version.
        assertNull(forced.audio)
        assertEquals(true, forced.textOff)
        assertEquals(TrackPlan.Notice.IMAGE_SUBTITLE_NOT_RENDERED, forced.notice)

        val srt = session.copy(tracks = session.tracks.copy(subtitles = session.tracks.subtitles.map { it.copy(selected = it.id == "s7") }))
        val plan = TrackMatcher.plan(srt, media)
        assertEquals(3, plan.text?.group)
        assertEquals(false, plan.textOff)
    }

    @Test
    fun burnedSubtitlesAreNotDrawnTwice() {
        val s = Fixtures.odyssey("s4", "s3")
        val burned = s.copy(tracks = s.tracks.copy(subtitles = s.tracks.subtitles.map { if (it.id == "s3") it.copy(delivery = Delivery.burned) else it }))
        val plan = TrackMatcher.plan(burned, Fixtures.odysseyMedia())
        assertEquals(true, plan.textOff)
        assertNull(plan.text)
    }

    @Test
    fun unsupportedPlannedTracksAreFailuresOfTheirDimension() {
        val plan = TrackMatcher.plan(Fixtures.odyssey("s4", "s3"), Fixtures.odysseyMedia())
        val ok = Fixtures.odysseyMedia()
        assertNull(TrackMatcher.checkSupport(ok, plan, listOf("HDR10")))

        val exceeds = ok.map { if (it.kind == MediaTrack.Kind.VIDEO) it.copy(support = 3) else it }
        assertNull("EXCEEDS_CAPABILITIES plays", TrackMatcher.checkSupport(exceeds, plan, listOf("HDR10")))

        val noVideo = ok.map { if (it.kind == MediaTrack.Kind.VIDEO) it.copy(support = 0) else it }
        assertEquals("video", TrackMatcher.checkSupport(noVideo, plan, emptyList())?.suspect)

        val noAc3 = ok.map { if (it.group == 4) it.copy(support = 1) else it }
        assertEquals(TrackFailure("audio", "TRACK_UNSUPPORTED:audio/ac3"), TrackMatcher.checkSupport(noAc3, plan, emptyList()))

        val noPgs = ok.map { if (it.group == 3) it.copy(support = 1) else it }
        assertEquals("subtitle", TrackMatcher.checkSupport(noPgs, plan, emptyList())?.suspect)
    }

    @Test
    fun dolbyVisionOutsideTheDeclaredProfilesIsAVideoFailure() {
        val plan = TrackPlan(null, null, textOff = true)
        val p7 = listOf(media(MediaTrack.Kind.VIDEO, 0, "1", "video/dolby-vision", "dvhe.07.06", null, null, selected = true))
        assertEquals(TrackFailure("video", "DV_PROFILE_UNSUPPORTED:7"), TrackMatcher.checkSupport(p7, plan, listOf("HDR10", "DV5", "DV8")))
        val p8 = listOf(media(MediaTrack.Kind.VIDEO, 0, "1", "video/dolby-vision", "dvh1.08.06", null, null, selected = true))
        assertNull(TrackMatcher.checkSupport(p8, plan, listOf("HDR10", "DV5", "DV8")))
        assertNull(TrackMatcher.dolbyVisionProfile("video/hevc", "hvc1.2.4.L153.B0"))
    }

    @Test
    fun languagesAreNormalisedToIso6391() {
        val cases = mapOf(
            "ita" to "it", "eng" to "en", "ger" to "de", "deu" to "de", "fre" to "fr", "jpn" to "ja", "it" to "it",
            "en-US" to "en", "und" to null, "" to null, null to null, "zzz" to "zzz",
        )
        for ((input, expected) in cases) assertEquals("$input", expected, TrackMatcher.normalizeLanguage(input))
    }

    @Test
    fun codecFamiliesMatchAcrossFfprobeAndMedia3() {
        val pairs = listOf(
            "ac3" to "audio/ac3", "eac3" to "audio/eac3-joc", "truehd" to "audio/true-hd", "dts" to "audio/vnd.dts.hd",
            "aac" to "audio/mp4a-latm", "flac" to "audio/flac", "pcm_s24le" to "audio/raw", "subrip" to "application/x-subrip",
            "ass" to "text/x-ssa", "hdmv_pgs_subtitle" to "application/pgs", "webvtt" to "text/vtt",
        )
        for ((server, mime) in pairs) {
            val m = media(MediaTrack.Kind.AUDIO, 0, null, mime, null, null, null)
            assertEquals(server, TrackMatcher.serverFamily(server), TrackMatcher.mediaFamily(m))
        }
        val cues = media(MediaTrack.Kind.TEXT, 0, null, Fixtures.CUES, "application/pgs", null, null)
        assertEquals("pgs", TrackMatcher.mediaFamily(cues))
    }
}
