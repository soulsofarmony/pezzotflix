package dev.pezzotflix.tv.player.caps

import android.app.UiModeManager
import android.content.Context
import android.content.res.Configuration
import android.hardware.display.DisplayManager
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Build
import android.view.Display
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.audio.AudioCapabilities
import androidx.media3.exoplayer.mediacodec.MediaCodecUtil

/** Reads [DeviceFacts] from the platform and from Media3, at every session start (the audio output can change). */
@OptIn(UnstableApi::class)
object PlatformFacts {
    private val VIDEO_MIMES = listOf("video/hevc", "video/avc", "video/av01", "video/x-vnd.on2.vp9", "video/dolby-vision")
    private val AUDIO_MIMES = listOf(
        "audio/eac3", "audio/ac3", "audio/true-hd", "audio/vnd.dts.hd", "audio/vnd.dts", "audio/mp4a-latm", "audio/flac", "audio/opus",
    )
    private val PASSTHROUGH = linkedMapOf(
        "eac3" to C.ENCODING_E_AC3, "ac3" to C.ENCODING_AC3, "truehd" to C.ENCODING_DOLBY_TRUEHD,
        "dtshd" to C.ENCODING_DTS_HD, "dts" to C.ENCODING_DTS,
    )
    private val CHANNEL_MASKS = listOf(
        8 to AudioFormat.CHANNEL_OUT_7POINT1_SURROUND, 6 to AudioFormat.CHANNEL_OUT_5POINT1, 2 to AudioFormat.CHANNEL_OUT_STEREO,
    )

    fun read(context: Context, appVersion: String): DeviceFacts {
        val uiMode = context.getSystemService(UiModeManager::class.java)
        val display = context.getSystemService(DisplayManager::class.java).getDisplay(Display.DEFAULT_DISPLAY)
        return DeviceFacts(
            manufacturer = Build.MANUFACTURER,
            model = Build.MODEL,
            release = Build.VERSION.RELEASE,
            sdk = Build.VERSION.SDK_INT,
            isTelevision = uiMode?.currentModeType == Configuration.UI_MODE_TYPE_TELEVISION ||
                context.resources.configuration.uiMode and Configuration.UI_MODE_TYPE_MASK == Configuration.UI_MODE_TYPE_TELEVISION,
            appVersion = appVersion,
            videoDecoders = VIDEO_MIMES.flatMap(::videoDecoders),
            audioDecoders = AUDIO_MIMES.associateWith(::audioChannels).filterValues { it > 0 },
            displayHdrTypes = hdrTypes(display),
            displayIsHdr = display?.isHdr == true,
            passthrough = passthrough(context),
        )
    }

    private fun videoDecoders(mime: String): List<VideoDecoder> {
        val infos = try {
            MediaCodecUtil.getDecoderInfos(mime, false, false)
        } catch (_: MediaCodecUtil.DecoderQueryException) {
            emptyList()
        }
        return infos.mapNotNull { info ->
            val caps = info.capabilities ?: return@mapNotNull null
            val v = caps.videoCapabilities ?: return@mapNotNull null
            VideoDecoder(
                name = info.name,
                mimeType = mime,
                hardware = info.hardwareAccelerated,
                alias = false, // Media3 already leaves aliases out
                profiles = caps.profileLevels.map { CodecProfiles.name(mime, it.profile) }.distinct(),
                maxWidth = v.supportedWidths.upper,
                maxHeight = v.supportedHeights.upper,
                uhdMaxFps = fpsAt(v, 3840, 2160),
                fhdMaxFps = fpsAt(v, 1920, 1080),
            )
        }
    }

    private fun fpsAt(v: android.media.MediaCodecInfo.VideoCapabilities, w: Int, h: Int): Double? =
        if (!v.isSizeSupported(w, h)) null else runCatching { v.getSupportedFrameRatesFor(w, h).upper }.getOrNull()

    private fun audioChannels(mime: String): Int = try {
        MediaCodecUtil.getDecoderInfos(mime, false, false)
            .maxOfOrNull { it.capabilities?.audioCapabilities?.maxInputChannelCount ?: 0 } ?: 0
    } catch (_: MediaCodecUtil.DecoderQueryException) {
        0
    }

    private fun hdrTypes(display: Display?): Set<HdrType> {
        @Suppress("DEPRECATION")
        val types = display?.hdrCapabilities?.supportedHdrTypes ?: return emptySet()
        return types.toList().mapNotNull {
            when (it) {
                Display.HdrCapabilities.HDR_TYPE_DOLBY_VISION -> HdrType.DOLBY_VISION
                Display.HdrCapabilities.HDR_TYPE_HDR10 -> HdrType.HDR10
                Display.HdrCapabilities.HDR_TYPE_HLG -> HdrType.HLG
                Display.HdrCapabilities.HDR_TYPE_HDR10_PLUS -> HdrType.HDR10_PLUS
                else -> null
            }
        }.toSet()
    }

    /**
     * Encodings Media3 accepts in bitstream on the current output, with the channels the platform takes directly. Both
     * calls are deprecated on newer APIs; they are the ones Media3 and Android 11 (the TV, API 30) use.
     */
    @Suppress("DEPRECATION")
    private fun passthrough(context: Context): Map<String, Int> {
        val caps = AudioCapabilities.getCapabilities(context, AudioAttributes.DEFAULT, null)
        val attrs = android.media.AudioAttributes.Builder()
            .setUsage(android.media.AudioAttributes.USAGE_MEDIA)
            .setContentType(android.media.AudioAttributes.CONTENT_TYPE_MOVIE)
            .build()
        val out = linkedMapOf<String, Int>()
        for ((codec, encoding) in PASSTHROUGH) {
            if (!caps.supportsEncoding(encoding)) continue
            val direct = CHANNEL_MASKS.firstOrNull { (_, mask) ->
                val format = AudioFormat.Builder().setEncoding(encoding).setSampleRate(48_000).setChannelMask(mask).build()
                runCatching { AudioTrack.isDirectPlaybackSupported(format, attrs) }.getOrDefault(false)
            }?.first
            out[codec] = direct ?: caps.maxChannelCount
        }
        return out
    }
}
