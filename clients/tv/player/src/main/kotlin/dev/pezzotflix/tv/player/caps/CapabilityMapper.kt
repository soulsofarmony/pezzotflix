package dev.pezzotflix.tv.player.caps

import dev.pezzotflix.api.models.ClientCapabilities
import dev.pezzotflix.api.models.ClientCapabilitiesAudioInner
import dev.pezzotflix.api.models.ClientCapabilitiesAudioInner.Mode
import dev.pezzotflix.api.models.ClientCapabilitiesDevice
import dev.pezzotflix.api.models.ClientCapabilitiesSubtitles
import dev.pezzotflix.api.models.ClientCapabilitiesVideoInner
import kotlin.math.floor

/**
 * Real capabilities only, from [DeviceFacts] (doc 05 §8.9.1). Server-side per-device overrides (doc 03 I2) remain the
 * correction where the platform misreports.
 */
object CapabilityMapper {
    private data class VideoCodec(val codec: String, val mime: String, val order: List<String>)

    private val VIDEO = listOf(
        VideoCodec("hevc", "video/hevc", listOf("main", "main10")),
        VideoCodec("h264", "video/avc", listOf("baseline", "main", "high", "high10")),
        VideoCodec("av1", "video/av01", listOf("main")),
        VideoCodec("vp9", "video/x-vnd.on2.vp9", listOf("profile0", "profile2")),
    )

    /** Channels a passthrough format can carry at most. */
    private val PASSTHROUGH_MAX = linkedMapOf("eac3" to 8, "ac3" to 6, "truehd" to 8, "dtshd" to 8, "dts" to 6)
    private val DECODE_MIMES = linkedMapOf(
        "eac3" to "audio/eac3", "ac3" to "audio/ac3", "truehd" to "audio/true-hd", "dtshd" to "audio/vnd.dts.hd",
        "dts" to "audio/vnd.dts", "aac" to "audio/mp4a-latm", "flac" to "audio/flac", "opus" to "audio/opus",
    )
    private const val MAX_CHANNELS = 8

    /**
     * [softwareDecoders]: also declare software video decoders. Never on the TV; a debug-only switch for the Android
     * emulator, which has no hardware decoder (MainActivity's launch extras).
     */
    fun map(f: DeviceFacts, softwareDecoders: Boolean = false): ClientCapabilities {
        val hw = f.videoDecoders.filter { (it.hardware || softwareDecoders) && !it.alias && !it.name.contains(".secure", ignoreCase = true) }
        val video = VIDEO.flatMap { videoEntries(it, hw.filter { d -> d.mimeType == it.mime }) }
        return ClientCapabilities(
            device = ClientCapabilitiesDevice(
                propertyClass = if (f.isTelevision) ClientCapabilitiesDevice.PropertyClass.tv else ClientCapabilitiesDevice.PropertyClass.mobile,
                model = "${f.manufacturer} ${f.model}; Android ${f.release} (API ${f.sdk})",
                app = "pezzotflix-tv ${f.appVersion}",
            ),
            containers = listOf("mkv", "mp4", "webm"),
            protocols = listOf("progressive", "hls-fmp4"),
            audioTrackSelection = true,
            video = video,
            hdr = hdr(f, hw),
            displayHdr = f.displayIsHdr,
            audio = audio(f),
            subtitles = ClientCapabilitiesSubtitles(text = listOf("srt", "webvtt"), image = listOf("pgs"), ass = true),
        )
    }

    private fun token(codec: String, profile: String): String? = when (codec) {
        "hevc" -> when {
            profile == "main" -> "main"
            profile.startsWith("main10") -> "main10"
            else -> null
        }
        "h264" -> when (profile) {
            "baseline", "constrainedBaseline" -> "baseline"
            "main" -> "main"
            "high", "constrainedHigh" -> "high"
            "high10" -> "high10"
            else -> null
        }
        "av1" -> if (profile == "main8" || profile.startsWith("main10")) "main" else null
        "vp9" -> when {
            profile == "profile0" -> "profile0"
            profile.startsWith("profile2") -> "profile2"
            else -> null
        }
        else -> null
    }

    private fun isTenBit(profile: String): Boolean =
        profile.startsWith("main10") || profile.startsWith("profile2") || profile == "high10"

    /**
     * One entry per resolution tier: the contract has a single maxFrameRate per entry, and a decoder that does 4K at 30
     * fps may do 1080p at 120. The engine checks the size before the frame rate (videoFit).
     */
    private fun videoEntries(c: VideoCodec, decoders: List<VideoDecoder>): List<ClientCapabilitiesVideoInner> {
        if (decoders.isEmpty()) return emptyList()
        val all = decoders.flatMap { it.profiles }
        val profiles = all.mapNotNull { token(c.codec, it) }.toSet().sortedBy { c.order.indexOf(it) }
        if (profiles.isEmpty()) return emptyList()
        val depth = if (all.any(::isTenBit)) 10L else 8L
        val maxW = decoders.maxOf { it.maxWidth }.toLong()
        val maxH = decoders.maxOf { it.maxHeight }.toLong()
        val uhd = decoders.mapNotNull { it.uhdMaxFps }.maxOrNull()
        val fhd = decoders.mapNotNull { it.fhdMaxFps }.maxOrNull()
        fun entry(w: Long, h: Long, fps: Double?) =
            ClientCapabilitiesVideoInner(c.codec, profiles, w, h, depth, fps?.let { floor(it) })
        return when {
            uhd == null -> listOf(entry(maxW, maxH, fhd))
            fhd != null && fhd > uhd + 1 -> listOf(entry(1920, 1080, fhd), entry(maxW, maxH, uhd))
            else -> listOf(entry(maxW, maxH, uhd))
        }
    }

    /**
     * Display HDR types that a hardware decoder can feed: HDR10, HDR10+ and HLG need a 10-bit decoder; DV<n> needs a
     * Dolby Vision decoder for profile n. Never a generic "DV", which the engine would take for profile 7 too.
     */
    private fun hdr(f: DeviceFacts, hw: List<VideoDecoder>): List<String> {
        val tenBit = hw.any { d -> d.mimeType != "video/dolby-vision" && d.profiles.any(::isTenBit) }
        val out = mutableListOf<String>()
        if (tenBit && HdrType.HDR10 in f.displayHdrTypes) out += "HDR10"
        if (tenBit && HdrType.HDR10_PLUS in f.displayHdrTypes) out += "HDR10+"
        if (tenBit && HdrType.HLG in f.displayHdrTypes) out += "HLG"
        if (HdrType.DOLBY_VISION in f.displayHdrTypes) {
            hw.filter { it.mimeType == "video/dolby-vision" }
                .flatMap { it.profiles }
                .mapNotNull { DV_PROFILE.find(it)?.groupValues?.get(1)?.toInt() }
                .toSortedSet()
                .forEach { out += "DV$it" }
        }
        return out
    }

    private val DV_PROFILE = Regex("\\(P(\\d+)\\)")

    /** Passthrough where the output takes the bitstream; otherwise decode where a decoder exists. PCM always. */
    private fun audio(f: DeviceFacts): List<ClientCapabilitiesAudioInner> {
        val out = mutableListOf<ClientCapabilitiesAudioInner>()
        for ((codec, mime) in DECODE_MIMES) {
            val pass = f.passthrough[codec]?.takeIf { it > 0 }
            val formatMax = PASSTHROUGH_MAX[codec]
            if (pass != null && formatMax != null) {
                out += ClientCapabilitiesAudioInner(codec, minOf(pass, formatMax).toLong(), Mode.passthrough)
                continue
            }
            val decode = f.audioDecoders[mime]?.takeIf { it > 0 } ?: continue
            out += ClientCapabilitiesAudioInner(codec, minOf(decode, MAX_CHANNELS).toLong(), Mode.decode)
        }
        // Media3 plays PCM from MKV itself; the platform mixer downmixes.
        out += ClientCapabilitiesAudioInner("pcm", MAX_CHANNELS.toLong(), Mode.decode)
        return out
    }
}
