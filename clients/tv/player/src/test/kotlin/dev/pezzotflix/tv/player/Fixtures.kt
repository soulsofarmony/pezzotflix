package dev.pezzotflix.tv.player

import dev.pezzotflix.api.models.DeliveryMode
import dev.pezzotflix.api.models.PlaybackSession
import dev.pezzotflix.api.models.PlaybackSessionStream
import dev.pezzotflix.api.models.PlaybackSessionTracks
import dev.pezzotflix.api.models.SessionTrack
import dev.pezzotflix.api.models.SessionTrack.Delivery
import dev.pezzotflix.tv.player.tracks.MediaTrack

/** Plans of the S5 samples (doc 05 §8.9.2): 2001 in Direct Play, Blade Runner 2049 in Direct Stream without FFmpeg. */
object Fixtures {
    fun audio(id: String, index: Long, codec: String, lang: String?, ch: Long, selected: Boolean = false, title: String? = null) =
        SessionTrack(
            id = id, type = SessionTrack.Type.audio, index = index, selected = selected, switchWithoutRestart = false,
            codec = codec, language = lang, channels = ch, title = title, delivery = Delivery.embedded,
        )

    fun sub(
        id: String,
        index: Long,
        codec: String,
        lang: String?,
        selected: Boolean = false,
        forced: Boolean = false,
        title: String? = null,
        delivery: Delivery = Delivery.embedded,
        url: String? = null,
    ) = SessionTrack(
        id = id, type = SessionTrack.Type.subtitle, index = index, selected = selected,
        switchWithoutRestart = delivery != Delivery.embedded, codec = codec, language = lang, forced = forced,
        title = title, delivery = delivery, url = url,
    )

    fun session(
        mode: DeliveryMode,
        url: String,
        protocol: PlaybackSessionStream.Protocol,
        audio: List<SessionTrack>,
        subtitles: List<SessionTrack>,
        id: String = "sess-1",
        resumeMs: Long = 0,
    ) = PlaybackSession(
        sessionId = id, expiresAt = 1_794_000_000_000, mode = mode, reasons = listOf("motivo"),
        stream = PlaybackSessionStream(url = url, protocol = protocol), tracks = PlaybackSessionTracks(audio, subtitles),
        resumePositionMs = resumeMs, durationMs = 8_940_000, chapters = emptyList(), heartbeatIntervalMs = 10_000,
        itemId = "item-2001", fileId = "file-2001",
    )

    /** 2001: 0 hevc; 1 srt eng "Stripped"; 2 srt eng "SDH"; 3 pgs ita; 4 ac3 6ch ita (default); 5 aac 6ch eng. */
    fun odyssey(audioSel: String = "s4", subSel: String? = "s3", id: String = "sess-1", url: String = "/video/media/s/tok_aaaaaaaaaaaaaaaa/file") = session(
        DeliveryMode.direct_play, url, PlaybackSessionStream.Protocol.progressive,
        audio = listOf(audio("s4", 4, "ac3", "ita", 6, audioSel == "s4"), audio("s5", 5, "aac", "eng", 6, audioSel == "s5")),
        subtitles = listOf(
            sub("s1", 1, "subrip", "eng", subSel == "s1", title = "Stripped"),
            sub("s2", 2, "subrip", "eng", subSel == "s2", title = "SDH"),
            sub("s3", 3, "hdmv_pgs_subtitle", "ita", subSel == "s3"),
        ),
        id = id,
    )

    /** What Media3 extracts from the 2001 MKV: one group per track, text parsed during extraction. */
    fun odysseyMedia(selectedAudio: Int = 4, selectedText: Int? = 3): List<MediaTrack> = listOf(
        media(MediaTrack.Kind.VIDEO, 0, "1", "video/hevc", "hvc1.2.4.L153.B0", null, null),
        media(MediaTrack.Kind.TEXT, 1, "2", CUES, "application/x-subrip", "en", null, label = "Stripped", selected = selectedText == 1),
        media(MediaTrack.Kind.TEXT, 2, "3", CUES, "application/x-subrip", "en", null, label = "SDH", selected = selectedText == 2),
        media(MediaTrack.Kind.TEXT, 3, "4", CUES, "application/pgs", "it", null, selected = selectedText == 3),
        media(MediaTrack.Kind.AUDIO, 4, "5", "audio/ac3", null, "it", 6, selected = selectedAudio == 4),
        media(MediaTrack.Kind.AUDIO, 5, "6", "audio/mp4a-latm", "mp4a.40.2", "en", 6, selected = selectedAudio == 5),
    )

    const val CUES = "application/x-media3-cues"
    const val HANDLED = 4

    fun media(
        kind: MediaTrack.Kind,
        group: Int,
        id: String?,
        mime: String?,
        codecs: String?,
        lang: String?,
        channels: Int?,
        label: String? = null,
        forced: Boolean = false,
        support: Int = HANDLED,
        selected: Boolean = false,
    ) = MediaTrack(kind, group, 0, id, mime, codecs, lang, channels, forced, label, support, selected)
}
