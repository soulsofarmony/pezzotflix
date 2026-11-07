package dev.pezzotflix.tv.player

import android.content.Context
import android.os.Handler
import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.text.Cue
import androidx.media3.common.text.CueGroup
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.HttpDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlaybackException
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.util.EventLogger
import dev.pezzotflix.api.models.PlaybackSession
import dev.pezzotflix.tv.api.ServerUrl
import dev.pezzotflix.tv.player.failures.FailureAction
import dev.pezzotflix.tv.player.failures.FailureClassifier
import dev.pezzotflix.tv.player.failures.PlayerError
import dev.pezzotflix.tv.player.failures.PzfLoadErrorPolicy
import dev.pezzotflix.tv.player.subtitles.SidecarOverlay
import dev.pezzotflix.tv.player.tracks.MediaTrack
import dev.pezzotflix.tv.player.tracks.TrackMatcher
import dev.pezzotflix.tv.player.tracks.TrackPlan
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import okhttp3.HttpUrl
import okhttp3.OkHttpClient

/** The cues to draw now. Identity equality: comparing bitmap cues field by field would compare their pixels. */
class CueFrame(val cues: List<Cue>)

/**
 * The one ExoPlayer of a player screen (doc 05 §8.10): progressive Direct Play and HLS Direct Stream from the session's
 * locators (the session token is in the path; [http] carries no Bearer), the plan's tracks forced with
 * TrackSelectionOverride, a 100 MiB buffer cap, the TV's load error policy. Tunneling stays off.
 * Subtitles: embedded ones are Media3's; those served apart (WebVTT sidecar, PGS .sup) are the [SidecarOverlay]'s,
 * looked up at the player's position every [OVERLAY_TICK_MS]. [cues] carries whichever is showing.
 */
@OptIn(UnstableApi::class)
class Media3Engine(
    context: Context,
    http: OkHttpClient,
    private val server: HttpUrl,
    /** The hdr formats declared at the start of this session (a DV track outside them is a video failure). */
    private val declaredHdr: () -> Collection<String>,
    private val log: (String) -> Unit,
    verbose: Boolean,
) : PlaybackEngine, Player.Listener {

    val player: ExoPlayer

    private var session: PlaybackSession? = null
    private var listener: EngineListener? = null
    private var plan: TrackPlan? = null
    private var tracksApplied = false
    private var supportChecked = false
    private val main = Handler(Looper.getMainLooper())
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val _cues = MutableStateFlow(CueFrame(emptyList()))
    val cues: StateFlow<CueFrame> = _cues.asStateFlow()
    private var embeddedCues: List<Cue> = emptyList()

    private val overlay = SidecarOverlay(
        http = http,
        resolve = { ServerUrl.resolve(server, it)?.toString() },
        scope = scope,
        cacheDir = context.cacheDir,
        listener = object : SidecarOverlay.Listener {
            override fun onPreparing(preparing: Boolean) {
                this@Media3Engine.listener?.onSubtitlePreparing(preparing)
            }

            override fun onFailure(trackId: String) {
                this@Media3Engine.listener?.onFailure(FailureClassifier.subtitleLoadFailed(trackId))
            }
        },
        log = log,
    )

    private val tick = object : Runnable {
        override fun run() {
            renderOverlay()
            if (overlay.active) main.postDelayed(this, OVERLAY_TICK_MS)
        }
    }

    init {
        val loadControl = DefaultLoadControl.Builder()
            .setTargetBufferBytes(BUFFER_BYTES)
            .setPrioritizeTimeOverSizeThresholds(false)
            .build()
        val mediaSources = DefaultMediaSourceFactory(OkHttpDataSource.Factory(http))
            .setLoadErrorHandlingPolicy(PzfLoadErrorPolicy())
        player = ExoPlayer.Builder(context)
            .setLoadControl(loadControl)
            .setMediaSourceFactory(mediaSources)
            .setAudioAttributes(
                AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(),
                true,
            )
            .build()
        player.addListener(this)
        if (verbose) player.addAnalyticsListener(EventLogger(LOG_TAG))
    }

    override fun load(session: PlaybackSession, startMs: Long, listener: EngineListener): FailureAction? {
        val url = ServerUrl.resolve(server, session.stream.url)?.toString() ?: return FailureAction.Replan("unknown", "BAD_STREAM_URL")
        this.session = session
        this.listener = listener
        plan = null
        tracksApplied = false
        supportChecked = false
        val item = MediaItem.Builder()
            .setUri(url)
            .setMediaId(session.sessionId)
            .setMimeType(if (session.stream.protocol.value == "hls-fmp4") MimeTypes.APPLICATION_M3U8 else null)
            .build()
        log("load ${session.mode} ${session.stream.protocol} at ${startMs}ms")
        player.playWhenReady = false
        player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
            .clearOverrides()
            .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
            .build()
        player.setMediaItem(item, startMs)
        player.prepare()
        showOverlay(session)
        return null
    }

    override fun update(session: PlaybackSession) {
        this.session = session
        applyPlan(player.currentTracks)
        showOverlay(session)
    }

    override fun subtitleComplete(trackId: String) {
        if (session != null) overlay.complete(trackId)
    }

    override fun unload() {
        listener = null
        session = null
        overlay.clear()
        main.removeCallbacks(tick)
        embeddedCues = emptyList()
        publishCues(emptyList())
        player.stop()
        player.clearMediaItems()
    }

    /** The selected subtitle when it is served apart: the overlay draws it, and Media3's text is off (TrackMatcher). */
    private fun showOverlay(session: PlaybackSession) {
        overlay.show(session.tracks.subtitles.firstOrNull { it.selected && SidecarOverlay.isSeparate(it) })
        main.removeCallbacks(tick)
        if (overlay.active) main.post(tick) else publishCues(embeddedCues)
    }

    private fun renderOverlay() {
        if (!overlay.active || session == null) return
        publishCues(overlay.cuesAt(player.currentPosition))
    }

    private fun publishCues(cues: List<Cue>) {
        if (_cues.value.cues !== cues) _cues.value = CueFrame(cues)
    }

    override fun onCues(cueGroup: CueGroup) {
        embeddedCues = cueGroup.cues
        if (!overlay.active) publishCues(embeddedCues)
    }

    override fun positionMs(): Long? = if (session == null) null else player.currentPosition

    override fun bufferedMs(): Long = player.bufferedPosition

    override fun play() {
        player.play()
    }

    override fun pause() {
        player.pause()
    }

    override fun seekTo(positionMs: Long) {
        player.seekTo(positionMs)
    }

    override val isPlaying: Boolean get() = player.isPlaying

    fun release() {
        overlay.clear()
        main.removeCallbacks(tick)
        scope.cancel()
        player.removeListener(this)
        player.release()
    }

    // ------------------------------------------------------------ tracks

    override fun onTracksChanged(tracks: Tracks) {
        val s = session ?: return
        if (tracks.groups.isEmpty()) return
        if (!tracksApplied) {
            applyPlan(tracks)
            tracksApplied = true
            player.playWhenReady = true
        }
        if (!supportChecked) {
            supportChecked = true
            val failure = TrackMatcher.checkSupport(flatten(tracks), plan ?: return, declaredHdr())
            if (failure != null) {
                log("track not playable: $failure")
                listener?.onFailure(FailureAction.Replan(failure.suspect, failure.error))
            }
        }
        log("tracks of ${s.sessionId}: ${describe(tracks)}")
    }

    private fun applyPlan(tracks: Tracks) {
        val s = session ?: return
        val flat = flatten(tracks)
        val p = TrackMatcher.plan(s, flat)
        plan = p
        val groups = tracks.groups
        val b = player.trackSelectionParameters.buildUpon().clearOverrides()
        p.audio?.let { r -> b.setOverrideForType(TrackSelectionOverride(groups[r.group].mediaTrackGroup, r.index)) }
        if (p.textOff) {
            b.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
        } else {
            b.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
            p.text?.let { r -> b.setOverrideForType(TrackSelectionOverride(groups[r.group].mediaTrackGroup, r.index)) }
        }
        player.trackSelectionParameters = b.build()
        log("plan audio=${p.audio} text=${p.text} textOff=${p.textOff}")
    }

    private fun flatten(tracks: Tracks): List<MediaTrack> = tracks.groups.flatMapIndexed { g, group ->
        val kind = when (group.type) {
            C.TRACK_TYPE_VIDEO -> MediaTrack.Kind.VIDEO
            C.TRACK_TYPE_AUDIO -> MediaTrack.Kind.AUDIO
            C.TRACK_TYPE_TEXT -> MediaTrack.Kind.TEXT
            else -> return@flatMapIndexed emptyList()
        }
        (0 until group.length).map { i ->
            val f = group.getTrackFormat(i)
            MediaTrack(
                kind = kind,
                group = g,
                index = i,
                id = f.id,
                sampleMimeType = f.sampleMimeType,
                codecs = f.codecs,
                language = f.language,
                channels = f.channelCount.takeIf { it != Format.NO_VALUE },
                forced = f.selectionFlags and C.SELECTION_FLAG_FORCED != 0,
                label = f.label,
                support = group.getTrackSupport(i),
                selected = group.isTrackSelected(i),
            )
        }
    }

    private fun describe(tracks: Tracks): String = flatten(tracks).joinToString("; ") {
        "${it.kind}#${it.group}.${it.index} id=${it.id} ${it.sampleMimeType}/${it.codecs} ${it.language} ch=${it.channels} " +
            "support=${it.support} sel=${it.selected}"
    }

    // ------------------------------------------------------------ state and errors

    override fun onPlaybackStateChanged(playbackState: Int) = reportState()

    override fun onIsPlayingChanged(isPlaying: Boolean) = reportState()

    private fun reportState() {
        val l = listener ?: return
        val state = when {
            player.playbackState == Player.STATE_ENDED -> EngineState.ENDED
            player.isPlaying -> EngineState.PLAYING
            player.playbackState == Player.STATE_BUFFERING -> EngineState.BUFFERING
            else -> EngineState.PAUSED
        }
        l.onState(state)
    }

    override fun onPositionDiscontinuity(oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int) {
        renderOverlay()
        if (reason == Player.DISCONTINUITY_REASON_SEEK) listener?.onSeeked()
    }

    override fun onPlayerError(error: PlaybackException) {
        val l = listener ?: return
        val renderer = (error as? ExoPlaybackException)?.takeIf { it.type == ExoPlaybackException.TYPE_RENDERER }?.rendererFormat
        var http: HttpDataSource.InvalidResponseCodeException? = null
        var cause: Throwable? = error
        while (cause != null && http == null) {
            http = cause as? HttpDataSource.InvalidResponseCodeException
            cause = cause.cause
        }
        val e = PlayerError(
            code = error.errorCode,
            codeName = error.errorCodeName,
            rendererTrackType = renderer?.let { MimeTypes.getTrackType(it.sampleMimeType) },
            httpStatus = http?.responseCode,
            uri = http?.dataSpec?.uri?.toString(),
        )
        val action = FailureClassifier.classify(e)
        log("player error ${e.codeName} status=${e.httpStatus} renderer=${renderer?.sampleMimeType} -> $action")
        l.onFailure(action)
    }

    companion object {
        const val LOG_TAG = "PZF"
        /** doc 05 §8.10: about 43 s of the typical sample, 6.5 s at a UHD remux's 128 Mb/s peak. */
        const val BUFFER_BYTES = 100 * 1024 * 1024
        /** Overlay cue lookup period: well under a subtitle's on-screen precision, and cheap (one binary search). */
        const val OVERLAY_TICK_MS = 40L
    }
}
