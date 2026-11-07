package dev.pezzotflix.tv.player.tracks

import dev.pezzotflix.api.models.PlaybackSession
import dev.pezzotflix.api.models.SessionTrack
import java.util.Locale

/** A track as Media3 exposes it, flattened from Tracks.Group (the engine builds these). */
data class MediaTrack(
    val kind: Kind,
    val group: Int,
    val index: Int,
    val id: String?,
    val sampleMimeType: String?,
    val codecs: String?,
    val language: String?,
    val channels: Int?,
    val forced: Boolean,
    val label: String?,
    /** Media3's C.FORMAT_* support level. */
    val support: Int,
    val selected: Boolean,
) {
    enum class Kind { VIDEO, AUDIO, TEXT }

    val ref: TrackRef get() = TrackRef(group, index)
}

data class TrackRef(val group: Int, val index: Int)

/**
 * The plan's tracks on Media3's tracks (doc 05 §8.10): what to force with TrackSelectionOverride.
 * - [audio] null: no override (HLS carries one audio track; or no match, Media3 keeps its own choice);
 * - [text] the subtitle to show; [textOff] disables text rendering;
 * - [notice] a subtitle the plan selected but this client does not render yet (image subtitle served apart, F3b).
 */
data class TrackPlan(val audio: TrackRef?, val text: TrackRef?, val textOff: Boolean, val notice: Notice? = null) {
    enum class Notice { IMAGE_SUBTITLE_NOT_RENDERED }
}

/** A selected track Media3 cannot play: report it with this dimension (doc 05 §8.10). */
data class TrackFailure(val suspect: String, val error: String)

object TrackMatcher {
    // Media3 C.FORMAT_* support levels (constants, inlined).
    private const val FORMAT_EXCEEDS_CAPABILITIES = 3
    const val FORMAT_HANDLED = 4

    fun plan(session: PlaybackSession, tracks: List<MediaTrack>): TrackPlan {
        val hls = session.stream.protocol.value == "hls-fmp4"
        val audio = if (hls) null else planAudio(session.tracks.audio, tracks.filter { it.kind == MediaTrack.Kind.AUDIO })
        val sub = session.tracks.subtitles.firstOrNull { it.selected }
        val sidecarIds = session.tracks.subtitles.filter { isSeparate(it) }.map { it.id }.toSet()
        val text = tracks.filter { it.kind == MediaTrack.Kind.TEXT }
        return when {
            sub == null -> TrackPlan(audio, null, textOff = true)
            sub.delivery == SessionTrack.Delivery.client_render ->
                TrackPlan(audio, null, textOff = true, notice = TrackPlan.Notice.IMAGE_SUBTITLE_NOT_RENDERED)
            sub.delivery == SessionTrack.Delivery.burned -> TrackPlan(audio, null, textOff = true)
            sub.delivery == SessionTrack.Delivery.sidecar -> {
                val t = text.firstOrNull { sameSidecar(it.id, sub.id) }
                TrackPlan(audio, t?.ref, textOff = t == null)
            }
            else -> {
                val planEmbedded = session.tracks.subtitles.filter { !isSeparate(it) && it.delivery != SessionTrack.Delivery.burned }.sortedBy { it.index }
                val mediaEmbedded = text.filter { m -> sidecarIds.none { sameSidecar(m.id, it) } }
                val t = match(planEmbedded, sub, mediaEmbedded)
                TrackPlan(audio, t?.ref, textOff = t == null)
            }
        }
    }

    private fun planAudio(planAudio: List<SessionTrack>, media: List<MediaTrack>): TrackRef? {
        val selected = planAudio.firstOrNull { it.selected } ?: return null
        return match(planAudio.sortedBy { it.index }, selected, media)?.ref
    }

    private fun isSeparate(t: SessionTrack): Boolean =
        t.delivery == SessionTrack.Delivery.sidecar || t.delivery == SessionTrack.Delivery.client_render

    /** Side-loaded subtitles carry the plan's track id as Format.id (Media3 may prefix it with a period index). */
    fun sameSidecar(formatId: String?, trackId: String): Boolean =
        formatId != null && (formatId == trackId || formatId.endsWith(":$trackId"))

    /**
     * The media track of [target]: by ordinal within the type when both sides list the same number of tracks and the
     * pair agrees (codec family, language); otherwise the best-scoring compatible track.
     */
    fun match(plan: List<SessionTrack>, target: SessionTrack, media: List<MediaTrack>): MediaTrack? {
        if (media.isEmpty()) return null
        val ordinal = plan.indexOfFirst { it.id == target.id }
        if (plan.size == media.size && ordinal >= 0) {
            val candidate = media[ordinal]
            if (compatible(target, candidate) && languagesAgree(target.language, candidate.language)) return candidate
        }
        return media
            .filter { compatible(target, it) }
            .maxWithOrNull(compareBy<MediaTrack> { score(target, it) }.thenByDescending { kotlin.math.abs(media.indexOf(it) - ordinal) })
    }

    private fun compatible(t: SessionTrack, m: MediaTrack): Boolean {
        val a = serverFamily(t.codec)
        val b = mediaFamily(m)
        return a == null || b == null || a == b
    }

    private fun languagesAgree(a: String?, b: String?): Boolean {
        val x = normalizeLanguage(a)
        val y = normalizeLanguage(b)
        return x == null || y == null || x == y
    }

    private fun score(t: SessionTrack, m: MediaTrack): Int {
        var s = 0
        val tl = normalizeLanguage(t.language)
        val ml = normalizeLanguage(m.language)
        if (tl != null && tl == ml) s += 4
        if (tl != null && ml != null && tl != ml) s -= 4
        if (t.channels != null && m.channels != null && t.channels!!.toInt() == m.channels) s += 2
        if ((t.forced == true) == m.forced) s += 1
        if (!t.title.isNullOrBlank() && t.title == m.label) s += 2
        if (serverFamily(t.codec) != null && serverFamily(t.codec) == mediaFamily(m)) s += 1
        return s
    }

    /** ffprobe codec names (the server's Track.codec) to a family shared with Media3's MIME types. */
    fun serverFamily(codec: String?): String? {
        val c = codec?.lowercase() ?: return null
        return when {
            c == "ac3" -> "ac3"
            c == "eac3" -> "eac3"
            c == "truehd" || c == "mlp" -> "truehd"
            c == "dts" || c == "dca" -> "dts"
            c == "aac" -> "aac"
            c == "flac" -> "flac"
            c == "opus" -> "opus"
            c.startsWith("pcm") -> "pcm"
            c == "mp3" -> "mp3"
            c == "mp2" -> "mp2"
            c == "vorbis" -> "vorbis"
            c == "subrip" || c == "srt" || c == "text" -> "srt"
            c == "ass" || c == "ssa" -> "ass"
            c == "hdmv_pgs_subtitle" || c == "pgssub" || c == "pgs" -> "pgs"
            c == "webvtt" -> "vtt"
            c == "dvd_subtitle" -> "vobsub"
            c == "dvb_subtitle" -> "dvb"
            c == "mov_text" -> "tx3g"
            else -> null
        }
    }

    /** Media3 MIME types to the same families. Text parsed during extraction keeps its original MIME in codecs. */
    fun mediaFamily(m: MediaTrack): String? {
        val mime = (if (m.sampleMimeType == "application/x-media3-cues") m.codecs else m.sampleMimeType)?.lowercase() ?: return null
        return when {
            mime == "audio/ac3" -> "ac3"
            mime.startsWith("audio/eac3") -> "eac3"
            mime == "audio/true-hd" -> "truehd"
            mime.startsWith("audio/vnd.dts") -> "dts"
            mime == "audio/mp4a-latm" || mime == "audio/aac" -> "aac"
            mime == "audio/flac" -> "flac"
            mime == "audio/opus" -> "opus"
            mime == "audio/raw" -> "pcm"
            mime == "audio/mpeg" -> "mp3"
            mime == "audio/mpeg-l2" -> "mp2"
            mime == "audio/vorbis" -> "vorbis"
            mime == "application/x-subrip" -> "srt"
            mime == "text/x-ssa" -> "ass"
            mime == "application/pgs" -> "pgs"
            mime == "text/vtt" -> "vtt"
            mime == "application/vobsub" -> "vobsub"
            mime == "application/dvbsubs" -> "dvb"
            mime == "application/x-quicktime-tx3g" -> "tx3g"
            else -> null
        }
    }

    private val BIBLIOGRAPHIC = mapOf(
        "alb" to "sq", "arm" to "hy", "baq" to "eu", "bur" to "my", "chi" to "zh", "cze" to "cs", "dut" to "nl", "fre" to "fr",
        "geo" to "ka", "ger" to "de", "gre" to "el", "ice" to "is", "mac" to "mk", "mao" to "mi", "may" to "ms", "per" to "fa",
        "rum" to "ro", "slo" to "sk", "tib" to "bo", "wel" to "cy",
    )
    private val ISO3_TO_ISO1: Map<String, String> by lazy {
        Locale.getISOLanguages().associateBy { runCatching { Locale.forLanguageTag(it).isO3Language }.getOrDefault(it) }
    }

    /** ISO 639-2/B, 639-2/T or 639-1, with or without region, to 639-1 when one exists; "und" and blank are null. */
    fun normalizeLanguage(code: String?): String? {
        val c = code?.trim()?.lowercase()?.substringBefore('-')?.substringBefore('_') ?: return null
        if (c.isEmpty() || c == "und" || c == "zxx" || c == "mis" || c == "mul") return null
        if (c.length != 3) return c
        return BIBLIOGRAPHIC[c] ?: ISO3_TO_ISO1[c] ?: c
    }

    /**
     * After every onTracksChanged (doc 05 §8.10): a planned track Media3 cannot play at all is a failure of its dimension,
     * instead of silence or a black screen. EXCEEDS_CAPABILITIES plays (devices under-declare levels); the decoder's own
     * errors decide. Only exception: a Dolby Vision track whose profile is not among the declared hdr formats.
     */
    fun checkSupport(tracks: List<MediaTrack>, plan: TrackPlan, declaredHdr: Collection<String>): TrackFailure? {
        val video = tracks.filter { it.kind == MediaTrack.Kind.VIDEO }
        if (video.isNotEmpty() && video.none { it.support >= FORMAT_EXCEEDS_CAPABILITIES }) {
            return TrackFailure("video", "TRACK_UNSUPPORTED:${video.first().sampleMimeType}")
        }
        val shown = video.firstOrNull { it.selected } ?: video.firstOrNull { it.support >= FORMAT_EXCEEDS_CAPABILITIES }
        dolbyVisionProfile(shown?.sampleMimeType, shown?.codecs)?.let { p ->
            if ("DV$p" !in declaredHdr) return TrackFailure("video", "DV_PROFILE_UNSUPPORTED:$p")
        }
        val audio = tracks.filter { it.kind == MediaTrack.Kind.AUDIO }
        val plannedAudio = plan.audio?.let { r -> audio.firstOrNull { it.ref == r } } ?: audio.firstOrNull { it.selected }
        if (plannedAudio != null && plannedAudio.support < FORMAT_EXCEEDS_CAPABILITIES) {
            return TrackFailure("audio", "TRACK_UNSUPPORTED:${plannedAudio.sampleMimeType}")
        }
        if (plannedAudio == null && audio.isNotEmpty() && audio.none { it.support >= FORMAT_EXCEEDS_CAPABILITIES }) {
            return TrackFailure("audio", "TRACK_UNSUPPORTED:${audio.first().sampleMimeType}")
        }
        val text = plan.text?.let { r -> tracks.firstOrNull { it.kind == MediaTrack.Kind.TEXT && it.ref == r } }
        if (text != null && text.support < FORMAT_EXCEEDS_CAPABILITIES) {
            return TrackFailure("subtitle", "TRACK_UNSUPPORTED:${text.codecs ?: text.sampleMimeType}")
        }
        return null
    }

    /** The Dolby Vision profile of a track ("dvhe.05.06" is profile 5), or null when it is not Dolby Vision. */
    fun dolbyVisionProfile(sampleMimeType: String?, codecs: String?): Int? {
        val c = codecs?.trim()?.lowercase() ?: return null
        val prefix = c.substringBefore('.')
        if (prefix !in setOf("dvhe", "dvh1", "dvav", "dva1", "dav1") && sampleMimeType != "video/dolby-vision") return null
        return c.split('.').getOrNull(1)?.toIntOrNull()
    }
}
