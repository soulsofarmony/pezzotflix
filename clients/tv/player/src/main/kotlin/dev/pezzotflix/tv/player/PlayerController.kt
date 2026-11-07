package dev.pezzotflix.tv.player

import dev.pezzotflix.api.models.ActiveSession
import dev.pezzotflix.api.models.ClientCapabilities
import dev.pezzotflix.api.models.FallbackRequest
import dev.pezzotflix.api.models.PlaybackSession
import dev.pezzotflix.api.models.ProgressReport
import dev.pezzotflix.api.models.SessionTrack
import dev.pezzotflix.tv.api.ApiException
import dev.pezzotflix.tv.api.AppEvent
import dev.pezzotflix.tv.api.PlaybackPort
import dev.pezzotflix.tv.api.StartRequest
import dev.pezzotflix.tv.api.SubtitleChoice
import dev.pezzotflix.tv.api.TrackChange
import dev.pezzotflix.tv.player.failures.FailureAction
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * The session, the engine and the automatic re-planning for one player screen: the web PlayerController (doc 05
 * §7.8) on coroutines, with the TV's rules (doc 05 §8.10). Everything runs on [scope] (the main thread).
 * - Operations: every user operation and automatic attempt claims [op]; async work of an older one stops. A
 *   StartPlayback answered after its operation was superseded is stopped at once (no orphan session).
 * - Engine bindings: an engine listener acts only while its generation is bound. A change that makes the server
 *   replace the stream detaches it (its 404/410 are expected); a refused change binds it again.
 * - Automatic re-plan (doc 04 §8): no question to the viewer; at most [MAX_AUTOMATIC_ATTEMPTS] per start, then the
 *   reasons and "Riprova".
 * - Closed sessions: terminated, failed or item_removed end the player with the reason; expired, stopped, shutdown or
 *   unknown start again from here. A stream's 404/410 says nothing about why: one heartbeat asks first.
 * - Giving up (a failure, leaving the player, onStop) stops the session: it would hold the only slot until timeout.
 *   Those stops run on [releaseScope], which outlives the screen.
 * - Calls that create or end a session (StartPlayback, StopPlayback) also run on [releaseScope] and are only awaited
 *   from [scope]: leaving the screen cancels the wait, not the request. A session created after its screen left is
 *   stopped at once.
 */
class PlayerController(
    private val api: PlaybackPort,
    private val engine: PlaybackEngine,
    private val capabilities: suspend () -> ClientCapabilities,
    private val scope: CoroutineScope,
    private val releaseScope: CoroutineScope,
    private val now: () -> Long = System::currentTimeMillis,
    private val log: (String) -> Unit = {},
    /** After the StopPlayback of [close] answered (or failed): the library screens refresh the resume position. */
    private val onClosed: () -> Unit = {},
) {
    enum class Phase { IDLE, STARTING, PREPARING, PLAYING, REPLANNING, FAILED, NO_PLAN, SESSION_LIMIT, EXPIRED, TERMINATED, NETWORK, UNAVAILABLE, ERROR, CLOSED }

    data class Failure(val suspect: String?, val error: String, val at: Long)
    data class ErrorInfo(val code: String, val detail: String?)

    sealed interface Notice {
        /** The server refused a track change (422): the current tracks stay. */
        data class ChangeRefused(val detail: String?) : Notice
    }

    data class State(
        val phase: Phase = Phase.IDLE,
        val session: PlaybackSession? = null,
        val capabilities: ClientCapabilities? = null,
        val positionMs: Long = 0,
        val durationMs: Long = 0,
        val bufferedMs: Long = 0,
        val playing: Boolean = false,
        val buffering: Boolean = false,
        val ended: Boolean = false,
        val attempts: Int = 0,
        val failures: List<Failure> = emptyList(),
        val error: ErrorInfo? = null,
        val activeSessions: List<ActiveSession> = emptyList(),
        val terminatedReason: String? = null,
        val notice: Notice? = null,
        val busy: Boolean = false,
        /** The selected subtitle served apart cannot show anything yet (its url answers 503, or nothing arrived). */
        val subtitlePreparing: Boolean = false,
    )

    data class StartOptions(
        val itemId: String,
        val fileId: String? = null,
        val audioTrackId: String? = null,
        val subtitle: SubtitleChoice = SubtitleChoice.Default,
        /** Original timeline; null = the profile's resume position. */
        val startPositionMs: Long? = null,
        /** Versions of the item when known: track ids without a fileId are valid only with a single version. */
        val versionCount: Int? = null,
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()
    private val s: State get() = _state.value

    private fun set(f: State.() -> State) = _state.update(f)

    private var op = 0
    /** Every load gets a new generation; its listener acts while [bound] is that generation. */
    private var generation = 0
    private var loadedGen = -1
    private var bound = -1
    private var request: StartOptions? = null
    private val replacedItems = mutableMapOf<String, String>()
    /** A session this client stopped itself: no more reports, changes or events about it. */
    private var closedSessionId: String? = null
    private var releasing: Release? = null
    private var heartbeat: Job? = null
    private var ticker: Job? = null
    private var lastState = ProgressReport.State.paused
    private var loaded = false

    private class Release(val sessionId: String, val done: Deferred<Boolean>) {
        var adopted = false
    }

    private sealed interface Outcome {
        data class Ok(val session: PlaybackSession) : Outcome
        data class Closed(val error: ApiException) : Outcome
        data object Gone : Outcome
    }

    /** True while a session is live: the event poller polls at the playback interval. */
    fun hasActiveSession(): Boolean = s.phase in LIVE_PHASES

    private fun openSession(): PlaybackSession? {
        val x = s.session
        return if (x != null && s.phase in LIVE_PHASES && x.sessionId != closedSessionId) x else null
    }

    private fun closableSession(): PlaybackSession? {
        val x = s.session
        return if (x != null && x.sessionId != closedSessionId && s.phase !in CLOSED_PHASES) x else null
    }

    /** The player gives up on its session: StopPlayback now, so the slot frees at once. */
    private fun release(positionMs: Long) {
        val x = closableSession() ?: return
        val id = x.sessionId
        closedSessionId = id
        lateinit var r: Release
        val done = releaseScope.async(start = CoroutineStart.LAZY) {
            val ok = runCatching { api.stopPlayback(id, positionMs) }.isSuccess
            scope.launch {
                if (releasing === r) releasing = null
                // Not through: the next close (Riprova, leaving) sends it again.
                if (!ok && !r.adopted && closedSessionId == id) closedSessionId = null
            }
            ok
        }
        r = Release(id, done)
        releasing = r
        done.start()
    }

    // ------------------------------------------------------------ start

    fun start(opts: StartOptions) {
        scope.launch { begin(opts) }
    }

    private suspend fun begin(given: StartOptions) {
        val opts = given.copy(itemId = currentItem(given.itemId))
        val r = request
        if (r != null && r == opts && s.phase in LIVE_PHASES) return
        val op = ++this.op
        if (s.session != null) {
            closeCurrent(positionMs())
            if (op != this.op) return
        }
        request = opts
        set { copy(attempts = 0, failures = emptyList(), error = null, notice = null, terminatedReason = null, activeSessions = emptyList()) }
        startSession(op, opts.startPositionMs)
    }

    /** "Riprova": a new StartPlayback from the current position, with fresh attempts. */
    fun retry() {
        scope.launch {
            val req = request ?: return@launch
            val pos = if (s.session != null) positionMs() else req.startPositionMs
            val op = ++this@PlayerController.op
            closeCurrent(pos ?: 0)
            if (op != this@PlayerController.op) return@launch
            request = req.copy(startPositionMs = pos)
            set { copy(attempts = 0, failures = emptyList(), error = null, notice = null, terminatedReason = null, activeSessions = emptyList()) }
            startSession(op, pos)
        }
    }

    /** SESSION_LIMIT_REACHED: stop the other session, then start again. */
    fun terminateOther(sessionId: String) {
        scope.launch {
            val op = ++this@PlayerController.op
            try {
                api.terminateSession(sessionId)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (op == this@PlayerController.op) fail(e)
                return@launch
            }
            val req = request ?: return@launch
            if (op != this@PlayerController.op) return@launch
            set { copy(activeSessions = emptyList()) }
            startSession(op, req.startPositionMs)
        }
    }

    private suspend fun startSession(op: Int, startPositionMs: Long?) {
        val req = request ?: return
        set { copy(phase = Phase.STARTING, busy = true) }
        val caps = try {
            capabilities()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (op == this.op) fail(e)
            return
        }
        if (op != this.op) return
        set { copy(capabilities = caps) }
        // Track ids are file-local: with several versions they need the fileId of their version (else 400).
        val fileId = req.fileId ?: s.session?.fileId
        val idsAllowed = fileId != null || req.versionCount == 1
        val subtitle = when (val c = req.subtitle) {
            is SubtitleChoice.Track -> if (idsAllowed) c else SubtitleChoice.Default
            else -> c
        }
        val body = StartRequest(
            itemId = req.itemId,
            capabilities = caps,
            fileId = fileId,
            audioTrackId = req.audioTrackId?.takeIf { idsAllowed },
            subtitle = subtitle,
            startPositionMs = startPositionMs?.coerceAtLeast(0),
        )
        // StartPlayback is not a session call: its 404 is an unknown item, never a closed session.
        val outcome = withPreparing(op, { startDetached(body, startPositionMs) })
        if (outcome !is Outcome.Ok) return
        val session = outcome.session
        if (op != this.op) {
            releaseScope.launch { runCatching { api.stopPlayback(session.sessionId, startPositionMs ?: session.resumePositionMs) } }
            return
        }
        playSession(op, session, startPositionMs ?: session.resumePositionMs)
    }

    /**
     * StartPlayback on [releaseScope], awaited here. If the wait is cancelled (Back while the call is in flight clears
     * the screen's scope) and the server then answers with a session, that session is stopped: nobody else knows it.
     */
    private suspend fun startDetached(body: StartRequest, startPositionMs: Long?): PlaybackSession {
        // The error travels in the Result: a failed child must not be reported to (or cancel) releaseScope.
        val call = releaseScope.async { runCatching { api.startPlayback(body) } }
        try {
            return call.await().getOrThrow()
        } catch (e: CancellationException) {
            call.invokeOnCompletion { cause ->
                if (cause != null) return@invokeOnCompletion
                val orphan = call.getCompleted().getOrNull() ?: return@invokeOnCompletion
                log("StartPlayback answered after its screen left: stopping ${orphan.sessionId}")
                releaseScope.launch { runCatching { api.stopPlayback(orphan.sessionId, startPositionMs ?: orphan.resumePositionMs) } }
            }
            throw e
        }
    }

    /** StopPlayback on [releaseScope], waited for at most STOP_WAIT_MS: a cancel or the timeout ends the wait, not the stop. */
    private suspend fun stopAndWait(ids: Collection<String>, positionMs: Long) {
        val list = ids.toList()
        val stop = releaseScope.launch { for (id in list) runCatching { api.stopPlayback(id, positionMs) } }
        withTimeoutOrNull(STOP_WAIT_MS) { stop.join() }
    }

    /**
     * Repeats a session call while it answers 503 (STREAM_PREPARING or MEDIA_UNAVAILABLE without sessionClosed), after
     * Retry-After (2 s if missing), for at most 60 s, as "in preparazione". An error [closed] recognises comes back as
     * Closed; others go to fail(). Gone when the operation was superseded or failed.
     */
    private suspend fun withPreparing(
        op: Int,
        call: suspend () -> PlaybackSession,
        first: ApiException? = null,
        closed: (ApiException) -> Boolean = { false },
    ): Outcome {
        val t0 = now()
        var pending: Exception? = first
        while (true) {
            if (pending == null) {
                try {
                    return Outcome.Ok(call())
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    if (op != this.op) return Outcome.Gone
                    pending = e
                }
            }
            val e = pending
            pending = null
            if (e is ApiException && closed(e)) return Outcome.Closed(e)
            if (e is ApiException && e.isRetryLater) {
                val left = PREPARING_LIMIT_MS - (now() - t0)
                if (left > 0) {
                    unloadEngine()
                    set { copy(phase = Phase.PREPARING, busy = true) }
                    delay(minOf(e.retryAfterMs ?: DEFAULT_RETRY_AFTER_MS, left))
                    if (op != this.op) return Outcome.Gone
                    continue
                }
            }
            fail(e)
            return Outcome.Gone
        }
    }

    /** Maps a control-plane error to a phase. The player gives up on the session: the server is told. */
    private fun fail(e: Exception) {
        val positionMs = positionMs()
        stopHeartbeat()
        unloadEngine()
        release(positionMs)
        if (e !is ApiException) {
            log("player error: $e")
            set { copy(phase = Phase.ERROR, busy = false, error = ErrorInfo("UNEXPECTED", e.message)) }
            return
        }
        val error = ErrorInfo(e.code, e.detail)
        when {
            e.status == 500 && e.code == "STREAM_FAILED" ->
                set { copy(phase = Phase.FAILED, busy = false, error = error, failures = failures + Failure(null, e.code, now())) }
            e.status == 409 && e.code == "SESSION_LIMIT_REACHED" ->
                set { copy(phase = Phase.SESSION_LIMIT, busy = false, error = error, activeSessions = e.activeSessions) }
            e.status == 422 -> set { copy(phase = Phase.NO_PLAN, busy = false, error = error) }
            e.status == 503 && e.sessionClosed -> set { copy(phase = Phase.UNAVAILABLE, busy = false, error = error) }
            e.status == 0 -> set { copy(phase = Phase.NETWORK, busy = false, error = error) }
            else -> set { copy(phase = Phase.ERROR, busy = false, error = error) }
        }
    }

    // ------------------------------------------------------------ engine

    private fun playSession(op: Int, session: PlaybackSession, startMs: Long) {
        unloadEngine()
        set { copy(session = session, durationMs = session.durationMs, positionMs = startMs, ended = false, error = null) }
        if (session.stream.protocol.value != "progressive" && session.stream.protocol.value != "hls-fmp4") {
            release(startMs)
            set { copy(phase = Phase.NO_PLAN, busy = false, error = ErrorInfo("CLIENT_UNSUPPORTED_PROTOCOL", session.stream.protocol.value)) }
            return
        }
        if (op != this.op) return
        val gen = ++generation
        val refused = engine.load(session, startMs, listenerFor(gen))
        if (refused != null) {
            // Nothing loaded and nothing set: the automatic attempt decides the next state.
            log("stream refused at load: $refused")
            scope.launch { automatic(refused, startMs) }
            return
        }
        loadedGen = gen
        bound = gen
        loaded = true
        lastState = ProgressReport.State.buffering
        set { copy(phase = Phase.PLAYING, busy = false) }
        startHeartbeat(session)
        startTicker()
    }

    private fun listenerFor(gen: Int) = object : EngineListener {
        private fun live() = bound == gen

        override fun onFailure(action: FailureAction) {
            if (!live()) return
            log("player failure: $action")
            scope.launch { automatic(action, positionMs()) }
        }

        override fun onState(state: EngineState) {
            if (!live()) return
            lastState = when (state) {
                EngineState.PLAYING -> ProgressReport.State.playing
                EngineState.BUFFERING -> ProgressReport.State.buffering
                else -> ProgressReport.State.paused
            }
            set {
                copy(
                    playing = state == EngineState.PLAYING,
                    buffering = state == EngineState.BUFFERING,
                    ended = state == EngineState.ENDED,
                    positionMs = engine.positionMs() ?: positionMs,
                )
            }
            if (state == EngineState.PAUSED || state == EngineState.ENDED) report()
        }

        override fun onSeeked() {
            if (live()) report()
        }

        override fun onSubtitlePreparing(preparing: Boolean) {
            if (live()) set { copy(subtitlePreparing = preparing) }
        }
    }

    private fun unloadEngine() {
        loadedGen = -1
        bound = -1
        if (loaded) engine.unload()
        loaded = false
        stopTicker()
        if (s.subtitlePreparing) set { copy(subtitlePreparing = false) }
    }

    /** The engine keeps playing, but its listener no longer acts: the server is replacing its stream. */
    private fun detachEngine() {
        bound = -1
    }

    /** The stream stays: the engine's listener acts again. */
    private fun rebindEngine() {
        if (loaded) bound = loadedGen
    }

    /**
     * One automatic attempt (doc 04 §8, doc 05 §8.10): re-plan from the suspect, or restart a closed session. After
     * MAX_AUTOMATIC_ATTEMPTS the player stops and shows the reasons with "Riprova".
     */
    private suspend fun automatic(action: FailureAction, positionMs: Long) {
        val op = ++this.op
        val session = openSession()
        val keepPlaying = action is FailureAction.Replan && action.suspect == "subtitle" && loaded
        if (keepPlaying) detachEngine() else unloadEngine()
        val record = when (action) {
            is FailureAction.Replan -> Failure(action.suspect, action.error, now())
            is FailureAction.Restart -> Failure(null, action.error, now())
            is FailureAction.Network -> Failure(null, action.error, now())
        }
        val failures = s.failures + record
        if (action is FailureAction.Network) {
            stopHeartbeat()
            release(positionMs)
            set { copy(phase = Phase.NETWORK, failures = failures, positionMs = positionMs, busy = false, playing = false, error = ErrorInfo("NETWORK", action.error)) }
            return
        }
        if (s.attempts >= MAX_AUTOMATIC_ATTEMPTS || session == null) {
            stopHeartbeat()
            unloadEngine()
            release(positionMs)
            set { copy(phase = Phase.FAILED, failures = failures, positionMs = positionMs, busy = false, playing = false) }
            return
        }
        set { copy(phase = Phase.REPLANNING, busy = true, failures = failures, attempts = attempts + 1, positionMs = positionMs) }
        log("automatic attempt ${s.attempts}: $action")
        if (action is FailureAction.Restart) {
            restartClosed(op, positionMs, null)
            return
        }
        val replan = action as FailureAction.Replan
        val body = FallbackRequest(positionMs = positionMs.coerceAtLeast(0), error = replan.error, suspect = suspectOf(replan.suspect))
        val next = try {
            api.reportPlaybackFailure(session.sessionId, body)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (op != this.op) return
            if (e is ApiException && e.isClosed) {
                restartClosed(op, positionMs, e)
                return
            }
            if (e !is ApiException || !e.isRetryLater) {
                fail(e)
                return
            }
            when (val r = withPreparing(op, { api.reportPlaybackFailure(session.sessionId, body) }, first = e, closed = { it.isClosed })) {
                is Outcome.Ok -> r.session
                is Outcome.Closed -> {
                    if (op == this.op) restartClosed(op, positionMs, r.error)
                    return
                }
                Outcome.Gone -> return
            }
        }
        if (op != this.op) return
        applySession(op, next, positionMs)
    }

    private fun suspectOf(s: String): FallbackRequest.Suspect =
        FallbackRequest.Suspect.entries.firstOrNull { it.value == s } ?: FallbackRequest.Suspect.unknown

    /**
     * The session is closed on the server, or its stream answers 404/410. [cause]: the control-plane error that said
     * so; null when the data plane did, so one heartbeat asks why first. A terminal reason ends the player there;
     * otherwise StopPlayback (idempotent), then StartPlayback from here.
     */
    private suspend fun restartClosed(op: Int, positionMs: Long, cause: ApiException?) {
        val old = s.session
        val pos = engine.positionMs()?.takeIf { loaded } ?: positionMs
        stopHeartbeat()
        unloadEngine()
        var reason = cause?.reason
        if (cause == null && old != null && old.sessionId != closedSessionId) {
            reason = askWhyClosed(old.sessionId, pos)
            if (op != this.op) return
        }
        if (old != null && reason != null && reason in TERMINAL_REASONS) {
            closedSessionId = old.sessionId
            set { copy(phase = Phase.TERMINATED, terminatedReason = reason, positionMs = pos, busy = false, playing = false) }
            return
        }
        if (old != null) {
            closedSessionId = old.sessionId
            stopAndWait(listOf(old.sessionId), pos)
        }
        val req = request ?: return
        if (op != this.op) return
        request = req.copy(startPositionMs = pos)
        startSession(op, pos)
    }

    /** One heartbeat: the reason of a closed session (410), or null when open, unknown (404) or silent for 10 s. */
    private suspend fun askWhyClosed(sessionId: String, positionMs: Long): String? = withTimeoutOrNull(CLOSED_REASON_TIMEOUT_MS) {
        try {
            api.reportProgress(sessionId, ProgressReport(positionMs.coerceAtLeast(0), ProgressReport.State.buffering, now()))
            null
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiException) {
            if (e.status == 410) e.reason else null
        } catch (_: Exception) {
            null
        }
    }

    // ------------------------------------------------------------ session changes

    /** Subtitles served apart are the overlay's, not part of what Media3 loads: engine.update() takes them. */
    private fun sameStream(a: PlaybackSession, b: PlaybackSession): Boolean =
        a.stream.url == b.stream.url && a.stream.protocol == b.stream.protocol

    /** A session returned by a change or a re-plan. Same stream: keep the engine; else a new load from here. */
    private fun applySession(op: Int, next: PlaybackSession, positionMs: Long) {
        val cur = s.session
        if (cur != null && loaded && sameStream(cur, next)) {
            rebindEngine()
            engine.update(next)
            set { copy(session = next, busy = false, phase = Phase.PLAYING) }
            if (cur.sessionId != next.sessionId || cur.heartbeatIntervalMs != next.heartbeatIntervalMs) startHeartbeat(next)
            return
        }
        // The old engine may have played on meanwhile: the new one starts where it is now.
        val from = if (loaded) engine.positionMs() ?: positionMs else positionMs
        playSession(op, next, from)
    }

    /**
     * ChangeTracks (doc 05 §8.10). The engine is detached for the call (the server may stop the old stream), then:
     * 404/410 or a 422 that closed the session → StartPlayback from here with the change (unless terminal);
     * 503 → "in preparazione" and the same call again; 422 → refused, the engine binds again with a notice;
     * other errors → fail().
     */
    private suspend fun change(change: TrackChange, update: (StartOptions) -> StartOptions) {
        val session = openSession() ?: return
        if (s.phase !in CHANGE_PHASES) return
        val op = ++this.op
        val positionMs = positionMs()
        detachEngine()
        set { copy(busy = true, notice = if (notice is Notice.ChangeRefused) null else notice) }
        val call: suspend () -> PlaybackSession = { api.changeTracks(session.sessionId, change.copy(positionMs = positionMs)) }
        val closedChange: (ApiException) -> Boolean = { (it.isClosed || it.isClosedRefusal) && request != null }
        suspend fun restart(e: ApiException, withChange: Boolean) {
            val terminal = (e.reason ?: "") in TERMINAL_REASONS
            if (withChange && !terminal) request = request?.let(update)
            restartClosed(op, positionMs, e)
        }
        val next: PlaybackSession = try {
            call()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (op != this.op) return
            when {
                e is ApiException && closedChange(e) -> {
                    restart(e, true)
                    return
                }
                e is ApiException && e.isRetryLater -> when (val r = withPreparing(op, call, first = e, closed = closedChange)) {
                    is Outcome.Ok -> r.session
                    is Outcome.Closed -> {
                        if (op == this.op) restart(r.error, true)
                        return
                    }
                    Outcome.Gone -> return
                }
                e is ApiException && e.status == 422 -> {
                    set { copy(notice = Notice.ChangeRefused(e.detail)) }
                    if (loaded) {
                        rebindEngine()
                        set { copy(busy = false) }
                        return
                    }
                    // Refused while the session waited for a stream: an empty ChangeTracks returns it with its stream.
                    when (val r = withPreparing(op, { api.changeTracks(session.sessionId, TrackChange(positionMs = positionMs)) }, closed = closedChange)) {
                        is Outcome.Ok -> if (op == this.op) applySession(op, r.session, positionMs)
                        is Outcome.Closed -> if (op == this.op) restart(r.error, false)
                        Outcome.Gone -> Unit
                    }
                    return
                }
                else -> {
                    fail(e)
                    return
                }
            }
        }
        if (op != this.op) return
        request = request?.let { update(it).copy(fileId = next.fileId ?: it.fileId) }
        set { copy(attempts = 0) }
        applySession(op, next, positionMs)
    }

    /** Audio always goes through ChangeTracks: the server decides whether the stream changes. */
    fun selectAudio(trackId: String) {
        val x = openSession() ?: return
        if (x.tracks.audio.firstOrNull { it.selected }?.id == trackId) return
        scope.launch {
            change(TrackChange(audioTrackId = trackId)) { it.copy(fileId = x.fileId ?: it.fileId, audioTrackId = trackId) }
        }
    }

    /** Subtitles always go to the server too, so the profile keeps the choice; null = off. */
    fun selectSubtitle(trackId: String?) {
        val x = openSession() ?: return
        if (trackId != null && x.tracks.subtitles.none { it.id == trackId }) return
        val choice = if (trackId == null) SubtitleChoice.Off else SubtitleChoice.Track(trackId)
        scope.launch {
            change(TrackChange(subtitle = choice)) {
                if (trackId != null) it.copy(fileId = x.fileId ?: it.fileId, subtitle = choice) else it.copy(subtitle = choice)
            }
        }
    }

    // ------------------------------------------------------------ events from the poller

    fun onEvent(e: AppEvent) {
        when (e) {
            is AppEvent.ItemRemoved -> {
                // A provisional item replaced by the identified one: the server session follows the file; a later
                // StartPlayback asks for the new item.
                val from = e.itemId
                val to = e.replacedBy
                if (from != null && to != null && from != to) {
                    replacedItems[from] = to
                    request = request?.let { it.copy(itemId = currentItem(it.itemId)) }
                }
            }
            is AppEvent.SubtitleReady -> {
                val x = s.session ?: return
                if (e.sessionId != x.sessionId || x.sessionId == closedSessionId) return
                val availability = SessionTrack.Availability.entries.firstOrNull { it.value == e.availability } ?: return
                val subtitles = x.tracks.subtitles.map { if (it.id == e.trackId) it.copy(availability = availability) else it }
                set { copy(session = x.copy(tracks = x.tracks.copy(subtitles = subtitles))) }
                // The track's file is final: the overlay reads it again and swaps its cues. The player and any track
                // change in flight are not touched (the overlay acts only if it still shows that track).
                val trackId = e.trackId
                if (availability == SessionTrack.Availability.complete && trackId != null && loaded) engine.subtitleComplete(trackId)
            }
            is AppEvent.SessionTerminated -> {
                val x = s.session ?: return
                if (e.sessionId == x.sessionId && x.sessionId != closedSessionId && s.phase in LIVE_PHASES) {
                    val pos = positionMs()
                    op += 1
                    stopHeartbeat()
                    unloadEngine()
                    set { copy(phase = Phase.TERMINATED, terminatedReason = e.reason, positionMs = pos, busy = false, playing = false) }
                }
            }
            else -> Unit
        }
    }

    private fun currentItem(itemId: String): String {
        var current = itemId
        repeat(replacedItems.size) { current = replacedItems[current] ?: return current }
        return current
    }

    // ------------------------------------------------------------ transport

    /** Position on the original timeline. */
    fun positionMs(): Long = (if (loaded) engine.positionMs() else null) ?: s.positionMs

    fun togglePlay() {
        if (!loaded) return
        if (engine.isPlaying) engine.pause() else play()
    }

    fun play() {
        if (!loaded) return
        // At the end, play alone would stay ended (Media3): start again from the beginning, as players do.
        if (s.ended) seekTo(0)
        engine.play()
    }

    fun pause() {
        if (loaded) engine.pause()
    }

    fun seekTo(originalMs: Long) {
        if (!loaded) return
        val duration = s.durationMs.takeIf { it > 0 } ?: Long.MAX_VALUE
        val target = originalMs.coerceIn(0, duration)
        engine.seekTo(target)
        set { copy(positionMs = target) }
    }

    fun seekBy(deltaMs: Long) = seekTo(positionMs() + deltaMs)

    fun dismissNotice() = set { copy(notice = null) }

    // ------------------------------------------------------------ heartbeat

    private fun startHeartbeat(session: PlaybackSession) {
        stopHeartbeat()
        val interval = session.heartbeatIntervalMs?.takeIf { it > 0 } ?: DEFAULT_HEARTBEAT_MS
        heartbeat = scope.launch {
            while (isActive) {
                delay(interval)
                report()
            }
        }
    }

    private fun stopHeartbeat() {
        heartbeat?.cancel()
        heartbeat = null
    }

    private fun startTicker() {
        stopTicker()
        ticker = scope.launch {
            while (isActive) {
                delay(TICK_MS)
                if (loaded && bound == loadedGen) set { copy(positionMs = engine.positionMs() ?: positionMs, bufferedMs = engine.bufferedMs()) }
            }
        }
    }

    private fun stopTicker() {
        ticker?.cancel()
        ticker = null
    }

    /** ReportProgress, also the heartbeat. A closed session offers to resume, or shows why it ended. */
    private fun report() {
        val x = s.session ?: return
        if (s.phase !in HEARTBEAT_PHASES || x.sessionId == closedSessionId) return
        val sessionId = x.sessionId
        val positionMs = positionMs()
        val state = if (loaded) lastState else ProgressReport.State.buffering
        scope.launch {
            try {
                api.reportProgress(sessionId, ProgressReport(positionMs.coerceAtLeast(0), state, now()))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (s.session?.sessionId != sessionId || s.phase !in HEARTBEAT_PHASES) return@launch
                if (sessionId == closedSessionId || s.phase == Phase.REPLANNING) return@launch
                if (e is ApiException && e.isClosed) {
                    op += 1
                    stopHeartbeat()
                    unloadEngine()
                    val reason = e.reason
                    if (reason != null && reason in TERMINAL_REASONS) {
                        set { copy(phase = Phase.TERMINATED, terminatedReason = reason, positionMs = positionMs, playing = false, busy = false) }
                    } else {
                        set { copy(phase = Phase.EXPIRED, positionMs = positionMs, playing = false, busy = false, error = ErrorInfo(e.code, null)) }
                    }
                }
            }
        }
    }

    // ------------------------------------------------------------ leaving

    /**
     * Leaving the player, or the Activity's onStop (the web's pagehide): StopPlayback for the session the server may
     * still hold (also after a failure), unless it is already terminated, expired or stopped. Idempotent.
     */
    fun close() {
        val positionMs = positionMs()
        val x = closableSession()
        if (x != null) {
            closedSessionId = x.sessionId
            releaseScope.launch {
                runCatching { api.stopPlayback(x.sessionId, positionMs) }
                onClosed()
            }
        } else if (s.phase != Phase.CLOSED) {
            onClosed()
        }
        op += 1
        stopHeartbeat()
        unloadEngine()
        set { copy(phase = Phase.CLOSED, positionMs = positionMs, playing = false, busy = false) }
    }

    /**
     * Before a new start: stops the current session unless it is already over. A stop the player sent when it gave up
     * is waited for, so the new start does not race it for the slot; no wait lasts more than STOP_WAIT_MS.
     */
    private suspend fun closeCurrent(positionMs: Long) {
        stopHeartbeat()
        unloadEngine()
        val r = releasing
        r?.adopted = true
        val toStop = mutableSetOf<String>()
        closableSession()?.let { toStop += it.sessionId }
        s.session?.let { closedSessionId = it.sessionId }
        set { copy(phase = Phase.STARTING, busy = true) }
        if (r != null) {
            val ok = withTimeoutOrNull(STOP_WAIT_MS) { r.done.await() }
            if (ok != true) toStop += r.sessionId
        }
        if (toStop.isEmpty()) return
        stopAndWait(toStop, positionMs)
    }

    companion object {
        const val MAX_AUTOMATIC_ATTEMPTS = 3
        const val PREPARING_LIMIT_MS = 60_000L
        const val DEFAULT_RETRY_AFTER_MS = 2_000L
        const val DEFAULT_HEARTBEAT_MS = 10_000L
        const val CLOSED_REASON_TIMEOUT_MS = 10_000L
        const val STOP_WAIT_MS = 3_000L
        const val TICK_MS = 500L

        private val LIVE_PHASES = setOf(Phase.STARTING, Phase.PREPARING, Phase.PLAYING, Phase.REPLANNING)
        private val HEARTBEAT_PHASES = setOf(Phase.PLAYING, Phase.PREPARING, Phase.REPLANNING)
        private val CHANGE_PHASES = setOf(Phase.PLAYING, Phase.PREPARING)
        private val CLOSED_PHASES = setOf(Phase.TERMINATED, Phase.EXPIRED, Phase.CLOSED)
        /** SESSION_EXPIRED reasons after which the player does not start again by itself. */
        val TERMINAL_REASONS = setOf("terminated", "failed", "item_removed")
    }
}
