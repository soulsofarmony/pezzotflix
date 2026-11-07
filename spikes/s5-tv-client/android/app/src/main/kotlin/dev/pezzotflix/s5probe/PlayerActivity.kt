// S5 throwaway probe: Media3 player with a diagnostic overlay and a scripted measurement mode.
// Intent extras (all optional except url):
//   url, title, mime ("application/x-mpegURL" for HLS), auto (scripted run), playSec, seekToMs, afterSeekSec,
//   bufferMb (byte cap, 0 = Media3 default), minBufSec/maxBufSec, ffmpeg ("off" | "on" | "prefer"), volume,
//   audioIndex / subIndex (track group index among audio / text groups; subIndex -1 = off), tunnel,
//   seekMode ("exact" | "sync"), api + token + session (Pezzotflix session: heartbeat and stop), info (text).
package dev.pezzotflix.s5probe

import android.app.Activity
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Bundle
import android.os.Debug
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Gravity
import android.view.KeyEvent
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.TextView
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.text.CueGroup
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DecoderReuseEvaluation
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.SeekParameters
import androidx.media3.exoplayer.analytics.AnalyticsListener
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.trackselection.DefaultTrackSelector
import androidx.media3.exoplayer.upstream.DefaultAllocator
import androidx.media3.ui.PlayerView
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors

@UnstableApi
class PlayerActivity : Activity() {
    private lateinit var player: ExoPlayer
    private lateinit var view: PlayerView
    private lateinit var overlay: TextView
    private lateinit var allocator: DefaultAllocator
    private val h = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()

    private var title = ""
    private var url = ""
    private var auto = false
    private var info = ""

    // timings
    private var tPrepare = 0L
    private var tReady = -1L
    private var tFirstFrame = -1L
    private var seekStart = -1L
    private var seekTarget = 0L
    private var seekReady = -1L
    private var seekFrame = -1L
    private val seeks = JSONArray()
    private var rebuffers = 0
    private var rebufferMs = 0L
    private var rebufferStart = -1L
    private var audioUnderruns = 0

    // what is playing
    private var videoDecoder = "-"
    private var audioDecoder = "-"
    private var videoFormat: Format? = null
    private var audioFormat: Format? = null
    private var trackCfg: AudioSink.AudioTrackConfig? = null
    private var bandwidth = 0L
    private var droppedEvents = 0
    private var cueCount = 0
    private val cueLog = JSONArray()
    private var lastCueText = ""
    private var error: String? = null
    private var tracksApplied = false
    private var maxPssKb = 0
    private var maxAlloc = 0L

    // Pezzotflix session (optional)
    private var api: String? = null
    private var token: String? = null
    private var session: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val x = intent
        url = x.getStringExtra("url") ?: run { finish(); return }
        title = x.getStringExtra("title") ?: Uri.parse(url).lastPathSegment ?: url
        auto = x.getBooleanExtra("auto", false)
        info = x.getStringExtra("info") ?: ""
        api = x.getStringExtra("api"); token = x.getStringExtra("token"); session = x.getStringExtra("session")

        val root = FrameLayout(this)
        view = PlayerView(this)
        view.useController = false
        view.setShowBuffering(PlayerView.SHOW_BUFFERING_ALWAYS)
        root.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        overlay = TextView(this).apply {
            typeface = Typeface.MONOSPACE; textSize = 13f; setTextColor(Color.WHITE)
            setBackgroundColor(Color.argb(170, 0, 0, 0)); setPadding(18, 12, 18, 12)
        }
        root.addView(overlay, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.START).apply { setMargins(24, 24, 24, 24) })
        setContentView(root)

        val ffmpeg = x.getStringExtra("ffmpeg") ?: if (Prefs.bool(this, "ffmpeg", true)) "on" else "off"
        val rf = DefaultRenderersFactory(this)
            .setExtensionRendererMode(
                when (ffmpeg) {
                    "prefer" -> DefaultRenderersFactory.EXTENSION_RENDERER_MODE_PREFER
                    "on" -> DefaultRenderersFactory.EXTENSION_RENDERER_MODE_ON
                    else -> DefaultRenderersFactory.EXTENSION_RENDERER_MODE_OFF
                },
            )
            .setEnableDecoderFallback(true)

        allocator = DefaultAllocator(true, C.DEFAULT_BUFFER_SEGMENT_SIZE)
        val bufferMb = x.getIntExtra("bufferMb", 0)
        val lc = DefaultLoadControl.Builder().setAllocator(allocator)
        val minBuf = x.getIntExtra("minBufSec", 0)
        val maxBuf = x.getIntExtra("maxBufSec", 0)
        if (minBuf > 0 && maxBuf > 0) lc.setBufferDurationsMs(minBuf * 1000, maxBuf * 1000, 2500, 5000)
        if (bufferMb > 0) lc.setTargetBufferBytes(bufferMb * 1024 * 1024).setPrioritizeTimeOverSizeThresholds(false)

        val ts = DefaultTrackSelector(this)
        val tunnel = x.getBooleanExtra("tunnel", Prefs.bool(this, "tunnel", false))
        ts.parameters = ts.buildUponParameters().setTunnelingEnabled(tunnel)
            .setPreferredAudioLanguages("ita", "eng").setPreferredTextLanguages("ita")
            .build()

        player = ExoPlayer.Builder(this, rf).setLoadControl(lc.build()).setTrackSelector(ts).build()
        if (x.getStringExtra("seekMode") == "sync") player.setSeekParameters(SeekParameters.CLOSEST_SYNC)
        player.volume = x.getFloatExtra("volume", 1f)
        view.player = player
        player.addListener(listener)
        player.addAnalyticsListener(analytics)

        L.ev("start", "title" to title, "url" to url, "ffmpeg" to ffmpeg, "bufferMb" to bufferMb, "minBufSec" to minBuf,
            "maxBufSec" to maxBuf, "heapMaxMb" to (Runtime.getRuntime().maxMemory() / 1048576), "tunnel" to tunnel, "seekMode" to (x.getStringExtra("seekMode") ?: "exact"), "auto" to auto)

        val item = MediaItem.Builder().setUri(url).apply {
            x.getStringExtra("mime")?.let { setMimeType(it) }
            // A subtitle file served apart (the server's client_render .sup, or a test file): sideloaded.
            x.getStringExtra("subUrl")?.let { su ->
                setSubtitleConfigurations(listOf(MediaItem.SubtitleConfiguration.Builder(Uri.parse(su))
                    .setMimeType(x.getStringExtra("subMime") ?: MimeTypes.APPLICATION_PGS).setLanguage(x.getStringExtra("subLang") ?: "ita")
                    .setSelectionFlags(C.SELECTION_FLAG_DEFAULT).setLabel("sideload").build()))
            }
        }.build()
        player.setMediaItem(item, x.getLongExtra("startMs", 0L))
        tPrepare = SystemClock.elapsedRealtime()
        player.prepare()
        player.playWhenReady = true
        h.post(tick)
        if (session != null) h.postDelayed(heartbeat, 10_000)
        if (auto) scheduleAuto()
    }

    // ------------------------------------------------------------------ listeners

    private val listener = object : Player.Listener {
        override fun onPlaybackStateChanged(state: Int) {
            val now = SystemClock.elapsedRealtime()
            when (state) {
                Player.STATE_READY -> {
                    if (tReady < 0) tReady = now - tPrepare
                    if (seekStart >= 0 && seekReady < 0) seekReady = now - seekStart
                    if (rebufferStart >= 0) { rebufferMs += now - rebufferStart; rebufferStart = -1 }
                }
                Player.STATE_BUFFERING -> if (tFirstFrame >= 0 && seekStart < 0) { rebuffers++; rebufferStart = now; L.ev("rebuffer", "posMs" to player.currentPosition, "bufMs" to player.totalBufferedDuration) }
                Player.STATE_ENDED -> L.ev("ended", "posMs" to player.currentPosition)
            }
            L.ev("state", "state" to state, "posMs" to player.currentPosition)
        }

        override fun onPlayerError(e: PlaybackException) {
            var cause: Throwable? = e.cause
            val chain = StringBuilder()
            while (cause != null && chain.length < 600) { chain.append(" <- ").append(cause.toString()); cause = cause.cause }
            error = "${e.errorCodeName}: ${e.message}$chain"
            L.ev("error", "code" to e.errorCodeName, "msg" to e.message, "chain" to chain.toString())
            if (auto) h.postDelayed({ summary("error"); finish() }, 1000)
        }

        override fun onTracksChanged(tracks: Tracks) {
            val arr = JSONArray()
            for (g in tracks.groups) for (i in 0 until g.length) {
                val f = g.getTrackFormat(i)
                arr.put(JSONObject().put("type", g.type).put("mime", f.sampleMimeType).put("codecs", f.codecs).put("lang", f.language)
                    .put("label", f.label).put("ch", f.channelCount).put("supported", g.isTrackSupported(i)).put("support", g.getTrackSupport(i))
                    .put("selected", g.isTrackSelected(i)))
            }
            L.ev("tracks", "tracks" to arr)
            if (!tracksApplied) { tracksApplied = true; applyInitialTracks(tracks) }
        }

        override fun onCues(cueGroup: CueGroup) {
            val pos = player.currentPosition
            val c = cueGroup.cues.firstOrNull()
            if (cueGroup.cues.isNotEmpty()) cueCount++
            val o = JSONObject().put("ptsUs", cueGroup.presentationTimeUs).put("posMs", pos).put("n", cueGroup.cues.size)
            c?.bitmap?.let { o.put("bitmap", "${it.width}x${it.height}") }
            c?.text?.let { o.put("text", it.toString().take(60)) }
            lastCueText = if (cueGroup.cues.isEmpty()) "" else (c?.text?.toString()?.take(40) ?: "bitmap ${c?.bitmap?.width}x${c?.bitmap?.height}")
            if (cueLog.length() < 200) cueLog.put(o)
            L.obj("cue", o)
        }
    }

    private val analytics = object : AnalyticsListener {
        override fun onVideoDecoderInitialized(et: AnalyticsListener.EventTime, decoderName: String, initializedTimestampMs: Long, initializationDurationMs: Long) {
            videoDecoder = decoderName; L.ev("videoDecoder", "name" to decoderName, "initMs" to initializationDurationMs)
        }

        override fun onAudioDecoderInitialized(et: AnalyticsListener.EventTime, decoderName: String, initializedTimestampMs: Long, initializationDurationMs: Long) {
            audioDecoder = decoderName; L.ev("audioDecoder", "name" to decoderName, "initMs" to initializationDurationMs)
        }

        override fun onVideoInputFormatChanged(et: AnalyticsListener.EventTime, format: Format, decoderReuseEvaluation: DecoderReuseEvaluation?) {
            videoFormat = format; L.ev("videoFormat", "f" to format.toString(), "color" to format.colorInfo?.toString(), "hdr" to hdrLabel(format))
        }

        override fun onAudioInputFormatChanged(et: AnalyticsListener.EventTime, format: Format, decoderReuseEvaluation: DecoderReuseEvaluation?) {
            audioFormat = format; L.ev("audioFormat", "f" to format.toString())
        }

        override fun onAudioTrackInitialized(et: AnalyticsListener.EventTime, cfg: AudioSink.AudioTrackConfig) {
            trackCfg = cfg
            L.ev("audioTrack", "encoding" to encodingName(cfg.encoding), "sampleRate" to cfg.sampleRate, "channelMask" to cfg.channelConfig,
                "channels" to Integer.bitCount(cfg.channelConfig), "tunneling" to cfg.tunneling, "offload" to cfg.offload, "bufferSize" to cfg.bufferSize)
        }

        override fun onAudioUnderrun(et: AnalyticsListener.EventTime, bufferSize: Int, bufferSizeMs: Long, elapsedSinceLastFeedMs: Long) {
            audioUnderruns++; L.ev("audioUnderrun", "elapsedSinceLastFeedMs" to elapsedSinceLastFeedMs)
        }

        override fun onAudioSinkError(et: AnalyticsListener.EventTime, audioSinkError: Exception) { L.ev("audioSinkError", "e" to audioSinkError.toString()) }
        override fun onAudioCodecError(et: AnalyticsListener.EventTime, audioCodecError: Exception) { L.ev("audioCodecError", "e" to audioCodecError.toString()) }
        override fun onVideoCodecError(et: AnalyticsListener.EventTime, videoCodecError: Exception) { L.ev("videoCodecError", "e" to videoCodecError.toString()) }

        override fun onDroppedVideoFrames(et: AnalyticsListener.EventTime, droppedFrames: Int, elapsedMs: Long) {
            droppedEvents += droppedFrames; L.ev("dropped", "n" to droppedFrames, "elapsedMs" to elapsedMs, "posMs" to player.currentPosition)
        }

        override fun onRenderedFirstFrame(et: AnalyticsListener.EventTime, output: Any, renderTimeMs: Long) {
            val now = SystemClock.elapsedRealtime()
            if (tFirstFrame < 0) { tFirstFrame = now - tPrepare; L.ev("firstFrame", "ms" to tFirstFrame) }
            else if (seekStart >= 0 && seekFrame < 0) { seekFrame = now - seekStart; L.ev("seekFirstFrame", "ms" to seekFrame) }
        }

        override fun onBandwidthEstimate(et: AnalyticsListener.EventTime, totalLoadTimeMs: Int, totalBytesLoaded: Long, bitrateEstimate: Long) {
            bandwidth = bitrateEstimate
        }
    }

    // ------------------------------------------------------------------ tracks

    private fun groups(type: Int): List<Tracks.Group> = player.currentTracks.groups.filter { it.type == type }

    private fun applyInitialTracks(tracks: Tracks) {
        val ai = intent.getIntExtra("audioIndex", -1)
        val si = intent.getIntExtra("subIndex", -2)
        val b = player.trackSelectionParameters.buildUpon()
        val audio = tracks.groups.filter { it.type == C.TRACK_TYPE_AUDIO }
        if (ai >= 0 && ai < audio.size) b.setOverrideForType(TrackSelectionOverride(audio[ai].mediaTrackGroup, 0))
        val text = tracks.groups.filter { it.type == C.TRACK_TYPE_TEXT }
        if (si == -1) b.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
        else if (si >= 0 && si < text.size) b.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false).setOverrideForType(TrackSelectionOverride(text[si].mediaTrackGroup, 0))
        player.trackSelectionParameters = b.build()
    }

    private fun cycle(type: Int) {
        val gs = groups(type)
        if (gs.isEmpty()) return
        val cur = gs.indexOfFirst { it.isSelected }
        val b = player.trackSelectionParameters.buildUpon()
        if (type == C.TRACK_TYPE_TEXT && cur == gs.size - 1) {
            b.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true) // last → off
        } else {
            val next = gs[(cur + 1).mod(gs.size)]
            b.setTrackTypeDisabled(type, false).setOverrideForType(TrackSelectionOverride(next.mediaTrackGroup, 0))
        }
        player.trackSelectionParameters = b.build()
        L.ev("cycleTrack", "type" to type, "from" to cur)
    }

    // ------------------------------------------------------------------ overlay / stats

    private fun hdrLabel(f: Format?): String {
        f ?: return "-"
        if (f.sampleMimeType == MimeTypes.VIDEO_DOLBY_VISION) return "Dolby Vision (${f.codecs})"
        return when (f.colorInfo?.colorTransfer) {
            C.COLOR_TRANSFER_ST2084 -> "HDR10 (PQ)"
            C.COLOR_TRANSFER_HLG -> "HLG"
            else -> "SDR"
        }
    }

    private fun audioOut(): String {
        val c = trackCfg ?: return "-"
        val n = Integer.bitCount(c.channelConfig)
        return if (isPcm(c.encoding)) "PCM ${encodingName(c.encoding)} $n can. ${c.sampleRate} Hz" else "BITSTREAM ${encodingName(c.encoding)} (passthrough, mask $n can.)" +
            (if (c.tunneling) " tunnel" else "") + (if (c.offload) " offload" else "")
    }

    private fun stats(): JSONObject {
        val dc = player.videoDecoderCounters?.also { it.ensureUpdated() }
        return JSONObject().apply {
            put("posMs", player.currentPosition); put("durMs", player.duration); put("bufMs", player.totalBufferedDuration)
            put("allocBytes", allocator.totalBytesAllocated)
            put("dropped", dc?.droppedBufferCount ?: -1); put("rendered", dc?.renderedOutputBufferCount ?: -1)
            put("skipped", dc?.skippedOutputBufferCount ?: -1); put("maxConsecDropped", dc?.maxConsecutiveDroppedBufferCount ?: -1)
            put("rebuffers", rebuffers); put("rebufferMs", rebufferMs); put("underruns", audioUnderruns); put("bwEstimate", bandwidth)
        }
    }

    private var tickN = 0
    private val tick = object : Runnable {
        override fun run() {
            val s = stats()
            maxAlloc = maxOf(maxAlloc, allocator.totalBytesAllocated.toLong())
            if (tickN % 10 == 0) {
                val pss = Debug.getPss().toInt(); maxPssKb = maxOf(maxPssKb, pss); s.put("pssKb", pss)
                L.obj("stats", s)
            }
            tickN++
            val vf = videoFormat; val af = audioFormat
            val atxt = af?.let { "${it.sampleMimeType} ${it.codecs ?: ""} ${it.channelCount} can. ${it.sampleRate} Hz [${it.language ?: "?"}] ${it.label ?: ""}" } ?: "-"
            val nA = groups(C.TRACK_TYPE_AUDIO).size; val iA = groups(C.TRACK_TYPE_AUDIO).indexOfFirst { it.isSelected } + 1
            val tg = groups(C.TRACK_TYPE_TEXT); val iT = tg.indexOfFirst { it.isSelected }
            val stxt = if (iT < 0) "spenti (${tg.size} disponibili)" else "${tg[iT].getTrackFormat(0).sampleMimeType} [${tg[iT].getTrackFormat(0).language}] ${iT + 1}/${tg.size}  $lastCueText"
            overlay.text = buildString {
                appendLine(title)
                if (info.isNotEmpty()) appendLine(info)
                appendLine("Video:  ${vf?.let { "${it.sampleMimeType} ${it.codecs ?: ""} ${it.width}x${it.height} ${"%.3f".format(it.frameRate)} fps" } ?: "-"}")
                appendLine("HDR:    ${hdrLabel(vf)}")
                appendLine("Decoder video: $videoDecoder")
                appendLine("Audio:  $atxt  (traccia $iA/$nA)")
                appendLine("Decoder audio: $audioDecoder")
                appendLine("Uscita audio:  ${audioOut()}")
                appendLine("Sottotitoli: $stxt")
                appendLine("Frame persi: ${s.getInt("dropped")} (resi ${s.getInt("rendered")})   Rebuffer: $rebuffers (${rebufferMs} ms)   Underrun audio: $audioUnderruns")
                appendLine("Buffer: ${s.getLong("bufMs") / 1000} s, ${allocator.totalBytesAllocated / 1048576} MB   Banda stimata: ${bandwidth / 1_000_000} Mb/s")
                appendLine("Avvio: ${tFirstFrame} ms   Ultimo seek: ${seekFrame} ms")
                appendLine("${fmtMs(player.currentPosition)} / ${fmtMs(player.duration)}")
                error?.let { appendLine("ERRORE: $it") }
                append("◀ ▶ -10/+30 s   ▲ audio   ▼ sottotitoli   OK pausa   MENU nascondi   INDIETRO esci")
            }
            h.postDelayed(this, 500)
        }
    }

    private fun summary(reason: String) {
        val o = stats()
        o.put("reason", reason); o.put("title", title); o.put("url", url)
        o.put("startupReadyMs", tReady); o.put("startupFirstFrameMs", tFirstFrame); o.put("seeks", seeks)
        o.put("videoDecoder", videoDecoder); o.put("audioDecoder", audioDecoder)
        o.put("video", videoFormat?.toString()); o.put("color", videoFormat?.colorInfo?.toString()); o.put("hdr", hdrLabel(videoFormat))
        o.put("audio", audioFormat?.toString()); o.put("audioOut", audioOut())
        o.put("cues", cueCount); o.put("cueLog", cueLog); o.put("error", error); o.put("maxPssKb", maxPssKb); o.put("maxAllocBytes", maxAlloc)
        L.obj("summary", o)
    }

    // ------------------------------------------------------------------ scripted mode

    private fun doSeek(target: Long) {
        seekStart = SystemClock.elapsedRealtime(); seekTarget = target; seekReady = -1; seekFrame = -1
        L.ev("seek", "fromMs" to player.currentPosition, "toMs" to target)
        player.seekTo(target)
        h.postDelayed({ finishSeek() }, 8000)
    }

    private fun finishSeek() {
        if (seekStart < 0) return
        val o = JSONObject().put("toMs", seekTarget).put("readyMs", seekReady).put("firstFrameMs", seekFrame).put("posAfterMs", player.currentPosition)
        seeks.put(o); L.obj("seekResult", o)
        seekStart = -1
    }

    private fun scheduleAuto() {
        val playSec = intent.getIntExtra("playSec", 12)
        val afterSec = intent.getIntExtra("afterSeekSec", 10)
        h.postDelayed(object : Runnable {
            override fun run() {
                if (tFirstFrame < 0 && error == null && SystemClock.elapsedRealtime() - tPrepare < 30_000) { h.postDelayed(this, 500); return }
                h.postDelayed({
                    L.obj("beforeSeek", stats())
                    val dur = player.duration
                    val to = intent.getLongExtra("seekToMs", if (dur > 0) dur * 8 / 10 else 20_000)
                    doSeek(to)
                    h.postDelayed({ summary("auto"); finish() }, (afterSec * 1000L).coerceAtLeast(9000))
                }, playSec * 1000L)
            }
        }, 500)
    }

    // ------------------------------------------------------------------ remote keys

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.action != KeyEvent.ACTION_DOWN) return super.dispatchKeyEvent(event)
        when (event.keyCode) {
            KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_MEDIA_REWIND -> { doSeek((player.currentPosition - 10_000).coerceAtLeast(0)); return true }
            KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> { doSeek(player.currentPosition + 30_000); return true }
            KeyEvent.KEYCODE_DPAD_UP -> { cycle(C.TRACK_TYPE_AUDIO); return true }
            KeyEvent.KEYCODE_DPAD_DOWN -> { cycle(C.TRACK_TYPE_TEXT); return true }
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> { player.playWhenReady = !player.playWhenReady; return true }
            KeyEvent.KEYCODE_MENU, KeyEvent.KEYCODE_INFO -> { overlay.visibility = if (overlay.visibility == android.view.View.VISIBLE) android.view.View.GONE else android.view.View.VISIBLE; return true }
        }
        return super.dispatchKeyEvent(event)
    }

    // ------------------------------------------------------------------ Pezzotflix session

    private val heartbeat = object : Runnable {
        override fun run() {
            val pos = player.currentPosition
            val st = if (player.playbackState == Player.STATE_BUFFERING) "buffering" else if (player.isPlaying) "playing" else "paused"
            io.execute { Api.post(api!!, token, "/video/api/v1/playback/sessions/$session/progress", JSONObject().put("positionMs", pos).put("state", st).put("clientTs", System.currentTimeMillis())) }
            h.postDelayed(this, 10_000)
        }
    }

    override fun onStop() {
        super.onStop()
        if (!isFinishing) finish()
    }

    override fun onDestroy() {
        h.removeCallbacksAndMessages(null)
        if (::player.isInitialized) {
            if (!auto) summary("exit")
            val pos = player.currentPosition
            if (session != null) io.execute { Api.post(api!!, token, "/video/api/v1/playback/sessions/$session/stop", JSONObject().put("positionMs", pos)) }
            player.release()
        }
        io.shutdown()
        super.onDestroy()
    }
}
