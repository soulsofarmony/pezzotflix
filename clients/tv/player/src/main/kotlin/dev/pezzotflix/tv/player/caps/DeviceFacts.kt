package dev.pezzotflix.tv.player.caps

/**
 * What the platform reports, read at every session start (doc 05 §8.9.1): the input of [CapabilityMapper]. Plain data,
 * so the mapping is tested on the S5 snapshot of the living-room TV.
 */
data class DeviceFacts(
    val manufacturer: String,
    val model: String,
    val release: String,
    val sdk: Int,
    val isTelevision: Boolean,
    val appVersion: String,
    val videoDecoders: List<VideoDecoder>,
    /** Max input channels per audio MIME type, over the decoders Media3 finds (hardware or software). */
    val audioDecoders: Map<String, Int>,
    /** HDR types of the display: names of [HdrType]. */
    val displayHdrTypes: Set<HdrType>,
    val displayIsHdr: Boolean,
    /** Compressed passthrough on the current output: codec (ac3, eac3, truehd, dts, dtshd) to max channels probed. */
    val passthrough: Map<String, Int>,
)

enum class HdrType { DOLBY_VISION, HDR10, HLG, HDR10_PLUS }

/**
 * One video decoder. [profiles] are named as in the S5 snapshot ("main10", "main10HDR10", "high", "dvheStn(P5)", ...),
 * see [CodecProfiles]. Frame rates are the decoder's maximum at 3840x2160 and at 1920x1080, null when unsupported.
 */
data class VideoDecoder(
    val name: String,
    val mimeType: String,
    val hardware: Boolean,
    val alias: Boolean,
    val profiles: List<String>,
    val maxWidth: Int,
    val maxHeight: Int,
    val uhdMaxFps: Double?,
    val fhdMaxFps: Double?,
)

/** MediaCodecInfo.CodecProfileLevel constants to the names the mapper reads (bit flags, as on Android). */
object CodecProfiles {
    fun name(mimeType: String, profile: Int): String = when (mimeType) {
        "video/hevc" -> when (profile) {
            1 -> "main"; 2 -> "main10"; 4 -> "mainStill"; 4096 -> "main10HDR10"; 8192 -> "main10HDR10Plus"; else -> "p$profile"
        }
        "video/avc" -> when (profile) {
            1 -> "baseline"; 2 -> "main"; 4 -> "extended"; 8 -> "high"; 16 -> "high10"; 32 -> "high422"; 64 -> "high444"
            65536 -> "constrainedBaseline"; 524288 -> "constrainedHigh"; else -> "p$profile"
        }
        "video/av01" -> when (profile) { 1 -> "main8"; 2 -> "main10"; 4096 -> "main10HDR10"; 8192 -> "main10HDR10Plus"; else -> "p$profile" }
        "video/x-vnd.on2.vp9" -> when (profile) {
            1 -> "profile0"; 2 -> "profile1"; 4 -> "profile2"; 8 -> "profile3"; 4096 -> "profile2HDR"; 8192 -> "profile3HDR"
            16384 -> "profile2HDR10Plus"; 32768 -> "profile3HDR10Plus"; else -> "p$profile"
        }
        // Dolby Vision profiles are bit flags in profile-number order: bit n is profile n (DvavPer = P0 ... Dvav110 = P10).
        "video/dolby-vision" -> if (profile > 0 && Integer.bitCount(profile) == 1) "dv(P${Integer.numberOfTrailingZeros(profile)})" else "p$profile"
        else -> "p$profile"
    }
}
