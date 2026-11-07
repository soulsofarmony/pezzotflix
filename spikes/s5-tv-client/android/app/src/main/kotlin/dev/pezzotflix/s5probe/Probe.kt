// S5 throwaway probe: what the device and Media3 report at runtime, and the ClientCapabilities JSON
// (services/video/contract, ClientCapabilities) a TV client would declare from it.
@file:Suppress("DEPRECATION")

package dev.pezzotflix.s5probe

import android.content.Context
import android.hardware.display.DisplayManager
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.media.MediaCodecInfo
import android.media.MediaCodecInfo.CodecCapabilities
import android.media.MediaCodecList
import android.os.Build
import android.provider.Settings
import android.view.Display
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaLibraryInfo
import androidx.media3.common.util.UnstableApi
import androidx.media3.common.util.Util
import androidx.media3.exoplayer.audio.AudioCapabilities
import androidx.media3.exoplayer.mediacodec.MediaCodecUtil
import org.json.JSONArray
import org.json.JSONObject

@UnstableApi
object Probe {
    private val VIDEO_MIMES = listOf("video/hevc", "video/dolby-vision", "video/av01", "video/avc", "video/x-vnd.on2.vp9")
    private val AUDIO_MIMES = listOf(
        "audio/ac3", "audio/eac3", "audio/eac3-joc", "audio/ac4", "audio/true-hd", "audio/vnd.dts", "audio/vnd.dts.hd",
        "audio/vnd.dts.uhd;profile=p2", "audio/mp4a-latm", "audio/flac", "audio/opus", "audio/raw", "audio/mpeg",
    )

    // ------------------------------------------------------------- profile / level names

    private val HEVC_LEVELS = listOf(
        "M1", "H1", "M2", "H2", "M2.1", "H2.1", "M3", "H3", "M3.1", "H3.1", "M4", "H4", "M4.1", "H4.1",
        "M5", "H5", "M5.1", "H5.1", "M5.2", "H5.2", "M6", "H6", "M6.1", "H6.1", "M6.2", "H6.2",
    )
    private val DV_LEVELS = listOf("hd24", "hd30", "fhd24", "fhd30", "fhd60", "uhd24", "uhd30", "uhd48", "uhd60", "uhd120", "8k60")
    private val AV1_LEVELS = listOf("2", "2.1", "2.2", "2.3", "3", "3.1", "3.2", "3.3", "4", "4.1", "4.2", "4.3", "5", "5.1", "5.2", "5.3", "6", "6.1", "6.2", "6.3", "7", "7.1", "7.2", "7.3")

    private fun bitIndex(v: Int): Int = Integer.numberOfTrailingZeros(v)

    fun profileName(mime: String, p: Int): String = when (mime) {
        "video/hevc" -> when (p) { 1 -> "main"; 2 -> "main10"; 4 -> "mainStill"; 4096 -> "main10HDR10"; 8192 -> "main10HDR10Plus"; else -> "p$p" }
        "video/avc" -> when (p) { 1 -> "baseline"; 2 -> "main"; 4 -> "extended"; 8 -> "high"; 16 -> "high10"; 32 -> "high422"; 64 -> "high444"; 65536 -> "constrainedBaseline"; 524288 -> "constrainedHigh"; else -> "p$p" }
        "video/av01" -> when (p) { 1 -> "main8"; 2 -> "main10"; 4096 -> "main10HDR10"; 8192 -> "main10HDR10Plus"; else -> "p$p" }
        "video/x-vnd.on2.vp9" -> when (p) { 1 -> "profile0"; 2 -> "profile1"; 4 -> "profile2"; 8 -> "profile3"; 4096 -> "profile2HDR"; 8192 -> "profile3HDR"; 16384 -> "profile2HDR10Plus"; 32768 -> "profile3HDR10Plus"; else -> "p$p" }
        "video/dolby-vision" -> when (p) {
            1 -> "dvavPer(P0)"; 2 -> "dvavPen(P1)"; 4 -> "dvheDer(P2)"; 8 -> "dvheDen(P3)"; 16 -> "dvheDtr(P4)"; 32 -> "dvheStn(P5)"
            64 -> "dvheDth(P6)"; 128 -> "dvheDtb(P7)"; 256 -> "dvheSt(P8)"; 512 -> "dvavSe(P9)"; 1024 -> "dvav110(P10)"; else -> "p$p"
        }
        else -> "p$p"
    }

    fun levelName(mime: String, l: Int): String {
        val i = bitIndex(l)
        return when (mime) {
            "video/hevc" -> HEVC_LEVELS.getOrElse(i) { "l$l" }
            "video/dolby-vision" -> DV_LEVELS.getOrElse(i) { "l$l" }
            "video/av01" -> AV1_LEVELS.getOrElse(i) { "l$l" }
            "video/avc" -> when (l) { 1 -> "1"; 2 -> "1b"; 4 -> "1.1"; 8 -> "1.2"; 16 -> "1.3"; 32 -> "2"; 64 -> "2.1"; 128 -> "2.2"; 256 -> "3"; 512 -> "3.1"; 1024 -> "3.2"; 2048 -> "4"; 4096 -> "4.1"; 8192 -> "4.2"; 16384 -> "5"; 32768 -> "5.1"; 65536 -> "5.2"; 131072 -> "6"; 262144 -> "6.1"; 524288 -> "6.2"; else -> "l$l" }
            else -> "l$l"
        }
    }

    // ------------------------------------------------------------- raw facts

    fun collect(ctx: Context): JSONObject {
        val o = JSONObject()
        o.put("build", JSONObject().apply {
            put("manufacturer", Build.MANUFACTURER); put("model", Build.MODEL); put("device", Build.DEVICE)
            put("sdk", Build.VERSION.SDK_INT); put("release", Build.VERSION.RELEASE); put("hardware", Build.HARDWARE)
            put("fingerprint", Build.FINGERPRINT)
        })
        o.put("media3", MediaLibraryInfo.VERSION)
        o.put("ffmpeg", ffmpegInfo())
        o.put("codecs", codecs())
        o.put("media3Decoders", media3Decoders())
        o.put("display", display(ctx))
        o.put("audio", audio(ctx))
        o.put("memory", JSONObject().apply {
            val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as android.app.ActivityManager
            val mi = android.app.ActivityManager.MemoryInfo(); am.getMemoryInfo(mi)
            put("totalMem", mi.totalMem); put("availMem", mi.availMem); put("lowMemory", mi.lowMemory); put("threshold", mi.threshold)
            put("memoryClassMb", am.memoryClass); put("largeMemoryClassMb", am.largeMemoryClass)
            put("maxHeap", Runtime.getRuntime().maxMemory())
        })
        return o
    }

    fun ffmpegInfo(): JSONObject {
        val o = JSONObject()
        try {
            val c = Class.forName("androidx.media3.decoder.ffmpeg.FfmpegLibrary")
            val available = c.getMethod("isAvailable").invoke(null) as Boolean
            o.put("available", available)
            if (available) {
                o.put("version", c.getMethod("getVersion").invoke(null))
                val sf = c.getMethod("supportsFormat", String::class.java)
                val s = JSONObject()
                for (m in AUDIO_MIMES) s.put(m, sf.invoke(null, m))
                o.put("supportsFormat", s)
            }
        } catch (t: Throwable) {
            o.put("available", false); o.put("error", t.toString())
        }
        return o
    }

    private fun codecs(): JSONArray {
        val arr = JSONArray()
        for (info in MediaCodecList(MediaCodecList.ALL_CODECS).codecInfos) {
            if (info.isEncoder) continue
            for (type in info.supportedTypes) {
                val t = type.lowercase()
                if (!t.startsWith("video/") && !t.startsWith("audio/")) continue
                val caps = try { info.getCapabilitiesForType(type) } catch (e: Exception) { null } ?: continue
                val c = JSONObject()
                c.put("name", info.name); c.put("type", t)
                if (Build.VERSION.SDK_INT >= 29) { c.put("hw", info.isHardwareAccelerated); c.put("alias", info.isAlias) }
                c.put("tunneled", caps.isFeatureSupported(CodecCapabilities.FEATURE_TunneledPlayback))
                c.put("secure", caps.isFeatureSupported(CodecCapabilities.FEATURE_SecurePlayback))
                c.put("adaptive", caps.isFeatureSupported(CodecCapabilities.FEATURE_AdaptivePlayback))
                val pl = JSONArray()
                for (p in caps.profileLevels) pl.put(profileName(t, p.profile) + "@" + levelName(t, p.level))
                if (pl.length() > 0) c.put("profileLevels", pl)
                caps.videoCapabilities?.let { v ->
                    c.put("maxW", v.supportedWidths.upper); c.put("maxH", v.supportedHeights.upper)
                    c.put("uhd60", v.areSizeAndRateSupported(3840, 2160, 60.0))
                    c.put("uhd24", v.areSizeAndRateSupported(3840, 2160, 24.0))
                    c.put("maxBitrate", v.bitrateRange.upper)
                    try { c.put("uhdMaxFps", v.getSupportedFrameRatesFor(3840, 2160).upper) } catch (_: Exception) {}
                    try { c.put("fhdMaxFps", v.getSupportedFrameRatesFor(1920, 1080).upper) } catch (_: Exception) {}
                }
                caps.audioCapabilities?.let { a ->
                    c.put("maxChannels", a.maxInputChannelCount)
                    c.put("sampleRates", JSONArray(a.supportedSampleRates?.toList() ?: emptyList<Int>()))
                    c.put("maxBitrate", a.bitrateRange.upper)
                }
                arr.put(c)
            }
        }
        return arr
    }

    /** The decoders Media3 itself would try, in priority order (non-secure, then tunneling). */
    private fun media3Decoders(): JSONObject {
        val o = JSONObject()
        for (m in VIDEO_MIMES + AUDIO_MIMES) {
            val a = JSONArray()
            try { for (d in MediaCodecUtil.getDecoderInfos(m, false, false)) a.put(d.name + (if (d.hardwareAccelerated) " (hw)" else " (sw)")) } catch (e: Exception) { a.put("error: $e") }
            val tun = JSONArray()
            try { for (d in MediaCodecUtil.getDecoderInfos(m, false, true)) tun.put(d.name) } catch (_: Exception) {}
            o.put(m, JSONObject().put("decoders", a).put("tunneling", tun))
        }
        return o
    }

    private fun display(ctx: Context): JSONObject {
        val o = JSONObject()
        val dm = ctx.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
        val d = dm.getDisplay(Display.DEFAULT_DISPLAY)
        val mode = d.mode
        o.put("mode", "${mode.physicalWidth}x${mode.physicalHeight}@${mode.refreshRate}")
        o.put("supportedModes", JSONArray(d.supportedModes.map { "${it.modeId}:${it.physicalWidth}x${it.physicalHeight}@${it.refreshRate}" }))
        val hc = d.hdrCapabilities
        o.put("hdrTypes", JSONArray(hc?.supportedHdrTypes?.map {
            when (it) { 1 -> "DOLBY_VISION"; 2 -> "HDR10"; 3 -> "HLG"; 4 -> "HDR10_PLUS"; else -> "T$it" }
        } ?: emptyList<String>()))
        hc?.let { o.put("maxLuminance", it.desiredMaxLuminance.toDouble()); o.put("maxAvgLuminance", it.desiredMaxAverageLuminance.toDouble()); o.put("minLuminance", it.desiredMinLuminance.toDouble()) }
        o.put("isHdr", d.isHdr)
        o.put("isWideColorGamut", d.isWideColorGamut)
        val p = Util.getCurrentDisplayModeSize(ctx)
        o.put("media3DisplaySize", "${p.x}x${p.y}")
        return o
    }

    private val ENCODINGS = listOf(
        AudioFormat.ENCODING_PCM_16BIT, AudioFormat.ENCODING_PCM_FLOAT, AudioFormat.ENCODING_AC3, AudioFormat.ENCODING_E_AC3,
        18 /* E_AC3_JOC */, 17 /* AC4 */, AudioFormat.ENCODING_DTS, AudioFormat.ENCODING_DTS_HD, 14 /* DOLBY_TRUEHD */,
        19 /* DOLBY_MAT */, AudioFormat.ENCODING_IEC61937,
    )
    private val MASKS = listOf(
        2 to AudioFormat.CHANNEL_OUT_STEREO, 6 to AudioFormat.CHANNEL_OUT_5POINT1, 8 to AudioFormat.CHANNEL_OUT_7POINT1_SURROUND,
    )

    private fun audio(ctx: Context): JSONObject {
        val o = JSONObject()
        val am = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val devs = JSONArray()
        for (d in am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
            devs.put(JSONObject().apply {
                put("type", deviceType(d.type)); put("name", d.productName?.toString()); put("id", d.id)
                put("encodings", JSONArray(d.encodings.map { encodingName(it) }))
                put("channelCounts", JSONArray(d.channelCounts.toList()))
                put("channelMasks", JSONArray(d.channelMasks.toList()))
                put("sampleRates", JSONArray(d.sampleRates.toList()))
            })
        }
        o.put("outputDevices", devs)
        // Media3's own view, which drives passthrough decisions in DefaultAudioSink.
        val caps = AudioCapabilities.getCapabilities(ctx, AudioAttributes.DEFAULT, null)
        o.put("media3AudioCapabilities", caps.toString())
        o.put("media3MaxChannelCount", caps.maxChannelCount)
        val sup = JSONObject()
        for (e in ENCODINGS) sup.put(encodingName(e), caps.supportsEncoding(e))
        o.put("media3SupportsEncoding", sup)
        // Platform direct playback (what Media3 queries on API 29+), per encoding and channel mask.
        if (Build.VERSION.SDK_INT >= 29) {
            val attrs = android.media.AudioAttributes.Builder().setUsage(android.media.AudioAttributes.USAGE_MEDIA)
                .setContentType(android.media.AudioAttributes.CONTENT_TYPE_MOVIE).build()
            val direct = JSONObject()
            for (e in ENCODINGS) {
                val ok = JSONArray()
                for ((n, mask) in MASKS) {
                    val f = AudioFormat.Builder().setEncoding(e).setSampleRate(48000).setChannelMask(mask).build()
                    if (try { AudioTrack.isDirectPlaybackSupported(f, attrs) } catch (_: Exception) { false }) ok.put(n)
                }
                direct.put(encodingName(e), ok)
            }
            o.put("directPlaybackSupported", direct)
        }
        o.put("encodedSurroundOutput", Settings.Global.getString(ctx.contentResolver, "encoded_surround_output"))
        o.put("outputSampleRate", am.getProperty(AudioManager.PROPERTY_OUTPUT_SAMPLE_RATE))
        return o
    }

    fun deviceType(t: Int): String = when (t) {
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "BUILTIN_SPEAKER"
        AudioDeviceInfo.TYPE_HDMI -> "HDMI"
        AudioDeviceInfo.TYPE_HDMI_ARC -> "HDMI_ARC"
        29 -> "HDMI_EARC"
        AudioDeviceInfo.TYPE_LINE_DIGITAL -> "LINE_DIGITAL (SPDIF)"
        AudioDeviceInfo.TYPE_LINE_ANALOG -> "LINE_ANALOG"
        AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "WIRED_HEADPHONES"
        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "BLUETOOTH_A2DP"
        AudioDeviceInfo.TYPE_USB_DEVICE -> "USB_DEVICE"
        AudioDeviceInfo.TYPE_TELEPHONY -> "TELEPHONY"
        AudioDeviceInfo.TYPE_AUX_LINE -> "AUX_LINE"
        AudioDeviceInfo.TYPE_IP -> "IP"
        AudioDeviceInfo.TYPE_BUS -> "BUS"
        AudioDeviceInfo.TYPE_REMOTE_SUBMIX -> "REMOTE_SUBMIX"
        else -> "T$t"
    }

    // ------------------------------------------------------------- ClientCapabilities for our server

    /**
     * The JSON a TV client would send in StartPlayback (contract ClientCapabilities). Built only from
     * what the device reports; [ffmpegOn] adds what the FFmpeg extension decodes in software (TrueHD, DTS,
     * DTS-HD) when it is loaded and on. Vendor DTS decoders are not in MediaCodecList on this TV.
     */
    fun clientCapabilities(raw: JSONObject, ffmpegOn: Boolean): JSONObject {
        val codecs = raw.getJSONArray("codecs").objects()
        val hwVideo = codecs.filter { it.getString("type").startsWith("video/") && it.optBoolean("hw", true) && !it.getString("name").contains("secure", true) }

        fun videoCap(mime: String, codec: String): List<JSONObject> {
            val ds = hwVideo.filter { it.getString("type") == mime }
            if (ds.isEmpty()) return emptyList()
            val profiles = linkedSetOf<String>()
            var maxW = 0; var maxH = 0; var maxFps = 0.0; var fhdFps = 0.0; var depth = 8
            for (d in ds) {
                maxW = maxOf(maxW, d.optInt("maxW")); maxH = maxOf(maxH, d.optInt("maxH"))
                maxFps = maxOf(maxFps, d.optDouble("uhdMaxFps", 0.0))
                fhdFps = maxOf(fhdFps, d.optDouble("fhdMaxFps", 0.0))
                val pls = d.optJSONArray("profileLevels") ?: JSONArray()
                for (i in 0 until pls.length()) {
                    val p = pls.getString(i).substringBefore("@")
                    val token = when (codec) {
                        "hevc" -> when { p.startsWith("main10") -> "main10"; p == "main" -> "main"; else -> null }
                        "h264" -> when (p) { "high", "constrainedHigh" -> "high"; "main" -> "main"; "baseline", "constrainedBaseline" -> "baseline"; "high10" -> "high10"; else -> null }
                        "av1" -> when { p.startsWith("main10") -> "main"; p == "main8" -> "main"; else -> null }
                        "vp9" -> when { p.startsWith("profile2") -> "profile2"; p == "profile0" -> "profile0"; else -> null }
                        else -> null
                    }
                    if (token != null) profiles.add(token)
                    if (p.startsWith("main10") || p.startsWith("profile2") || p == "high10") depth = 10
                }
            }
            // One entry per resolution tier: the contract has one maxFrameRate per entry, and a decoder that
            // does 4K at 30 fps may do 1080p at 60 (H.264 here). The engine checks frame rate after size.
            fun entry(w: Int, hgt: Int, fps: Double) = JSONObject().apply {
                put("codec", codec); put("profiles", JSONArray(profiles.toList()))
                put("maxWidth", w); put("maxHeight", hgt); put("maxBitDepth", depth)
                if (fps > 0) put("maxFrameRate", Math.floor(fps))
            }
            val out = mutableListOf(entry(maxW, maxH, maxFps))
            if (fhdFps > maxFps + 1) out.add(0, entry(1920, 1080, fhdFps))
            return out
        }

        val video = JSONArray()
        (videoCap("video/hevc", "hevc") + videoCap("video/avc", "h264") + videoCap("video/av01", "av1") + videoCap("video/x-vnd.on2.vp9", "vp9"))
            .forEach { video.put(it) }

        // HDR: what the display presents AND a decoder exists for.
        val disp = raw.getJSONObject("display")
        val types = (0 until disp.getJSONArray("hdrTypes").length()).map { disp.getJSONArray("hdrTypes").getString(it) }.toSet()
        val dvProfiles = codecs.filter { it.getString("type") == "video/dolby-vision" }
            .flatMap { d -> (d.optJSONArray("profileLevels") ?: JSONArray()).let { a -> (0 until a.length()).map { a.getString(it) } } }
            .mapNotNull { Regex("\\(P(\\d+)\\)").find(it)?.groupValues?.get(1) }.toSortedSet(compareBy { it.toInt() })
        val hdr = JSONArray()
        if ("HDR10" in types) hdr.put("HDR10")
        if ("HDR10_PLUS" in types) hdr.put("HDR10+")
        if ("HLG" in types) hdr.put("HLG")
        if ("DOLBY_VISION" in types) dvProfiles.forEach { hdr.put("DV$it") }

        // Audio: decoders the platform has (MediaCodec), plus compressed passthrough to the current output.
        val a = raw.getJSONObject("audio")
        val enc = a.getJSONObject("media3SupportsEncoding")
        fun dec(mime: String) = codecs.filter { it.getString("type") == mime }
        fun maxCh(mime: String) = dec(mime).maxOfOrNull { it.optInt("maxChannels", 2) } ?: 0
        val audio = JSONArray()
        fun add(codec: String, channels: Int, mode: String) { audio.put(JSONObject().put("codec", codec).put("maxChannels", channels).put("mode", mode)) }
        if (enc.optBoolean("E_AC3")) add("eac3", 8, "passthrough") else if (dec("audio/eac3").isNotEmpty()) add("eac3", maxCh("audio/eac3"), "decode")
        if (enc.optBoolean("AC3")) add("ac3", 6, "passthrough") else if (dec("audio/ac3").isNotEmpty()) add("ac3", maxCh("audio/ac3"), "decode")
        val ff = if (ffmpegOn) raw.getJSONObject("ffmpeg").optJSONObject("supportsFormat") ?: JSONObject() else JSONObject()
        if (enc.optBoolean("DTS_HD")) add("dtshd", 8, "passthrough") else if (dec("audio/vnd.dts.hd").isNotEmpty()) add("dtshd", maxCh("audio/vnd.dts.hd"), "decode") else if (ff.optBoolean("audio/vnd.dts.hd")) add("dtshd", 8, "decode")
        if (enc.optBoolean("DTS")) add("dts", 6, "passthrough") else if (dec("audio/vnd.dts").isNotEmpty()) add("dts", maxCh("audio/vnd.dts"), "decode") else if (ff.optBoolean("audio/vnd.dts")) add("dts", 8, "decode")
        if (enc.optBoolean("DOLBY_TRUEHD")) add("truehd", 8, "passthrough") else if (ff.optBoolean("audio/true-hd")) add("truehd", 8, "decode")
        if (dec("audio/mp4a-latm").isNotEmpty()) add("aac", maxCh("audio/mp4a-latm"), "decode")
        if (dec("audio/flac").isNotEmpty()) add("flac", maxCh("audio/flac"), "decode")
        if (dec("audio/opus").isNotEmpty()) add("opus", maxCh("audio/opus"), "decode")
        add("pcm", 8, "decode") // Media3 plays PCM from MKV itself (raw), downmix by the platform mixer.

        val b = raw.getJSONObject("build")
        return JSONObject().apply {
            put("device", JSONObject().put("class", "tv")
                .put("model", "${b.getString("manufacturer")} ${b.getString("model")}; Android ${b.getString("release")} (API ${b.getInt("sdk")}); Media3 ${raw.getString("media3")}")
                .put("app", "pezzotflix-s5-probe 0.1"))
            // Containers Media3 extracts natively. M2TS (192-byte packets) is not declared: not verified.
            put("containers", JSONArray(listOf("mkv", "mp4", "webm")))
            put("audioTrackSelection", true)
            put("protocols", JSONArray(listOf("progressive", "hls-fmp4")))
            put("video", video)
            put("hdr", hdr)
            put("displayHdr", types.isNotEmpty())
            put("audio", audio)
            put("subtitles", JSONObject()
                .put("text", JSONArray(listOf("srt", "webvtt", "tx3g")))
                .put("image", JSONArray(listOf("pgs", "vobsub", "dvb")))
                .put("ass", true))
        }
    }
}
