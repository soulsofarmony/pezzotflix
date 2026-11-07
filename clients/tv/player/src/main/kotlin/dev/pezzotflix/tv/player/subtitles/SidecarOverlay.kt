package dev.pezzotflix.tv.player.subtitles

import androidx.annotation.OptIn
import androidx.media3.common.text.Cue
import androidx.media3.common.util.UnstableApi
import androidx.media3.extractor.text.SubtitleParser
import androidx.media3.extractor.text.webvtt.WebvttParser
import dev.pezzotflix.api.models.SessionTrack
import dev.pezzotflix.tv.api.ApiException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Subtitles served apart (doc 05 §8.10): the sidecar WebVTT and the PGS .sup of a client_render track. They do not
 * go through Media3's loading, which in 1.11 parses a side-loaded file only at its end, times out on a growing one
 * (OkHttp's 30 s read timeout between sparse cues), gives up without onPlayerError, and reads no cue from a .sup.
 * Here the file is fetched with its own call and no read timeout, parsed with Media3's parsers as it arrives
 * (WebvttParser per block, PgsParser per display set), and the renderer asks for the cues at the player's position.
 * Like the web's SubtitleRenderer (clients/web/src/player/subtitles.ts):
 * - a growing track (availability growing) shows its cues as they arrive; [complete] reads the url again and swaps
 *   the cues at the end of the new file, without touching the player;
 * - 503 with Retry-After: "in preparazione", the same request after Retry-After, for at most [PREPARING_LIMIT_MS];
 *   503 without Retry-After is the server's "failed for good"; any other status, or no answer after a few tries,
 *   is a failure of the track ([Listener.onFailure]): the controller re-plans with suspect subtitle;
 * - a growing response cut short is read again once, unless it delivered meanwhile.
 * Everything but the download runs on [scope] (the main thread).
 */
@OptIn(UnstableApi::class)
class SidecarOverlay(
    http: OkHttpClient,
    /** A relative locator to an absolute url (the session's server). */
    private val resolve: (String) -> String?,
    private val scope: CoroutineScope,
    private val cacheDir: File,
    private val listener: Listener,
    private val io: CoroutineDispatcher = Dispatchers.IO,
    private val decoder: CoroutineDispatcher = Dispatchers.Default.limitedParallelism(1),
    private val now: () -> Long = System::currentTimeMillis,
    private val log: (String) -> Unit = {},
) {
    interface Listener {
        /** True while the selected track cannot show anything yet: its url answers 503, or nothing arrived yet. */
        fun onPreparing(preparing: Boolean)

        /** The selected track will not load (doc 05 §8.10): re-plan with suspect subtitle. */
        fun onFailure(trackId: String)
    }

    // No read timeout: a growing response may wait minutes between two cues.
    private val client = http.newBuilder().readTimeout(0, TimeUnit.MILLISECONDS).build()
    private var selected: SessionTrack? = null
    private var store: CueStore? = null
    private var job: Job? = null
    private var call: Call? = null
    private var token = 0
    private var preparing = false
    private var shown: List<Cue> = emptyList()

    init {
        // Copies left by a run that ended without closing them (the process was killed).
        cacheDir.listFiles { f -> f.name.startsWith(PgsCueStore.TEMP_PREFIX) }?.forEach { it.delete() }
    }

    /** True while a track is selected: the renderer polls [cuesAt]. */
    val active: Boolean get() = selected != null

    /**
     * Shows [track] (sidecar or client_render) or nothing. The same track at the same url keeps its cues; a growing
     * copy whose track is now complete is read again (a missed playback.subtitle_ready).
     */
    fun show(track: SessionTrack?) {
        val cur = selected
        if (track != null && cur != null && track.id == cur.id && track.url == cur.url) {
            selected = track
            if (cur.availability == SessionTrack.Availability.growing && track.availability == SessionTrack.Availability.complete) reload()
            return
        }
        clear()
        if (track?.url == null || !isSeparate(track)) return
        selected = track
        load(track, swapAtEnd = false)
    }

    /** playback.subtitle_ready: the track's file is final; read it again and swap at its end. */
    fun complete(trackId: String) {
        val cur = selected ?: return
        if (cur.id != trackId) return
        selected = cur.copy(availability = SessionTrack.Availability.complete)
        reload()
    }

    private fun reload() {
        val t = selected ?: return
        log("subtitle ${t.id} complete: reading it again")
        load(t, swapAtEnd = true)
    }

    /** The cues to draw at [positionMs] (original timeline); the same list instance while nothing changes. */
    fun cuesAt(positionMs: Long): List<Cue> {
        val s = store ?: return emptyList<Cue>().also { shown = it }
        val next = s.at(positionMs * 1000) ?: return shown
        if (next != shown) shown = next
        return shown
    }

    fun clear() {
        stopLoad()
        selected = null
        store?.close()
        store = null
        shown = emptyList()
        setPreparing(false)
    }

    private fun stopLoad() {
        token++
        job?.cancel()
        job = null
        call?.cancel()
        call = null
    }

    private fun setPreparing(value: Boolean) {
        if (preparing == value) return
        preparing = value
        listener.onPreparing(value)
    }

    private fun publish(next: CueStore) {
        val old = store
        store = next
        if (old !== next) old?.close()
    }

    private fun fail(t: Int, track: SessionTrack, why: String) {
        if (t != token) return
        log("subtitle ${track.id} failed: $why")
        clear()
        listener.onFailure(track.id)
    }

    private sealed interface Read {
        data object Done : Read
        data class Status(val code: Int, val retryAfterMs: Long?) : Read
        data class NoAnswer(val error: IOException) : Read
        data class Cut(val error: IOException, val delivered: Boolean) : Read
    }

    private fun load(track: SessionTrack, swapAtEnd: Boolean) {
        stopLoad()
        val t = token
        val url = track.url?.let(resolve)
        if (url == null) {
            fail(t, track, "bad url ${track.url}")
            return
        }
        if (!swapAtEnd && track.availability == SessionTrack.Availability.growing) setPreparing(true)
        job = scope.launch {
            var waitingSince: Long? = null
            var noAnswer = 0
            var cutRetried = false
            while (true) {
                val next = newStore(track)
                if (!swapAtEnd) publish(next)
                val r = try {
                    read(t, url, track, next, immediate = !swapAtEnd)
                } catch (e: CancellationException) {
                    if (next !== store) next.close()
                    throw e
                }
                if (t != token) {
                    if (next !== store) next.close()
                    return@launch
                }
                when (r) {
                    Read.Done -> {
                        if (swapAtEnd) publish(next)
                        setPreparing(false)
                        log("subtitle ${track.id}: ${next.size} units")
                        return@launch
                    }
                    is Read.Status -> {
                        if (next !== store) next.close()
                        val since = waitingSince ?: now()
                        // 503 + Retry-After: queued or briefly unreachable. Without Retry-After: failed for good.
                        if (r.code == 503 && r.retryAfterMs != null && now() - since < PREPARING_LIMIT_MS) {
                            waitingSince = since
                            if (!swapAtEnd) setPreparing(true)
                            delay(r.retryAfterMs.coerceIn(MIN_RETRY_MS, MAX_RETRY_MS))
                            continue
                        }
                        fail(t, track, "HTTP ${r.code}")
                        return@launch
                    }
                    is Read.NoAnswer -> {
                        if (next !== store) next.close()
                        if (++noAnswer <= NO_ANSWER_RETRIES) {
                            delay(1_000L shl (noAnswer - 1))
                            continue
                        }
                        fail(t, track, "no answer: ${r.error}")
                        return@launch
                    }
                    is Read.Cut -> {
                        if (next !== store) next.close()
                        if (r.error is SupFormatException) {
                            fail(t, track, "${r.error.message}")
                            return@launch
                        }
                        // A growing response cut short is read again, once until a read delivers again.
                        if (r.delivered) cutRetried = false
                        val growing = (selected ?: track).availability == SessionTrack.Availability.growing
                        if (growing && !cutRetried) {
                            cutRetried = true
                            log("subtitle ${track.id}: response cut short, reading it again (${r.error})")
                            continue
                        }
                        fail(t, track, "cut: ${r.error}")
                        return@launch
                    }
                }
            }
        }
    }

    private fun newStore(track: SessionTrack): CueStore =
        if (track.delivery == SessionTrack.Delivery.client_render) PgsCueStore(cacheDir, scope, decoder) else TextCueStore()

    /** One GET of the url into [into]. Headers and body are read on [io]; the first cue ends "in preparazione". */
    private suspend fun read(t: Int, url: String, track: SessionTrack, into: CueStore, immediate: Boolean): Read {
        val c = client.newCall(Request.Builder().url(url).build())
        call = c
        val response = try {
            withContext(io) { c.execute() }
        } catch (e: IOException) {
            currentCoroutineContext().ensureActive()
            return Read.NoAnswer(e)
        }
        if (t != token) {
            response.close()
            return Read.Done
        }
        if (!response.isSuccessful) {
            val retryAfter = ApiException.parseRetryAfter(response.header("Retry-After"))
            response.close()
            return Read.Status(response.code, retryAfter)
        }
        var delivered = false
        return withContext(io) {
            response.use { res ->
                val body = res.body
                val source = body.byteStream()
                val chunk = ByteArray(CHUNK_BYTES)
                val pgs = into as? PgsCueStore
                val text = into as? TextCueStore
                val sup = if (pgs != null) SupSplitter() else null
                val vtt = if (text != null) VttChunker() else null
                val parser = if (text != null) WebvttParser() else null
                fun deliverText(doc: String?) {
                    if (doc == null || text == null || parser == null) return
                    runCatching {
                        parser.parse(doc.toByteArray(Charsets.UTF_8), SubtitleParser.OutputOptions.allCues()) { text.add(it) }
                    }.onFailure { log("subtitle ${track.id}: a WebVTT piece did not parse: $it") }
                }
                try {
                    while (true) {
                        ensureActive()
                        val n = source.read(chunk)
                        if (n < 0) break
                        if (n == 0) continue
                        val before = into.size
                        sup?.push(chunk, 0, n)?.forEach { pgs?.add(it) }
                        vtt?.push(chunk, 0, n)?.let(::deliverText)
                        if (into.size > before && !delivered) {
                            delivered = true
                            if (immediate) scope.launch { if (t == token) setPreparing(false) }
                        }
                    }
                    vtt?.finish()?.let(::deliverText)
                    Read.Done
                } catch (e: IOException) {
                    Read.Cut(e, delivered)
                }
            }
        }
    }

    companion object {
        /** As the web (SUBTITLE_PREPARING_LIMIT_MS): waiting on 503 stops here and becomes a failure. */
        const val PREPARING_LIMIT_MS = 120_000L
        const val MIN_RETRY_MS = 500L
        const val MAX_RETRY_MS = 10_000L
        const val NO_ANSWER_RETRIES = 3
        private const val CHUNK_BYTES = 16 * 1024

        fun isSeparate(t: SessionTrack): Boolean =
            t.delivery == SessionTrack.Delivery.sidecar || t.delivery == SessionTrack.Delivery.client_render
    }
}
