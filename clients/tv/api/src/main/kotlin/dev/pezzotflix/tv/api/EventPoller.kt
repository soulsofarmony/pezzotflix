package dev.pezzotflix.tv.api

import dev.pezzotflix.api.models.EventPage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Event polling with a cursor, as in the web client (doc 05 §7.7, §8.8):
 * - the first call has no cursor: it returns the current position and no events;
 * - every 5 s with the app in the foreground, every 15 s during playback, none in the background;
 * - after an error the interval doubles up to 60 s; 410 CURSOR_EXPIRED resets the cursor and calls [onReset];
 * - a full page is followed at once by the next one.
 */
class EventPoller(
    private val list: suspend (cursor: String?, limit: Long) -> EventPage,
    private val onEvents: (List<AppEvent>) -> Unit,
    private val onReset: () -> Unit,
    private val log: (String, Throwable?) -> Unit = { _, _ -> },
) {
    @Volatile private var foreground = false
    @Volatile private var playing = false
    private var cursor: String? = null
    private var failures = 0
    /** true: poll now (back to the foreground); false: re-evaluate the interval. */
    private val wake = Channel<Boolean>(Channel.CONFLATED)
    private var job: Job? = null

    fun start(scope: CoroutineScope) {
        if (job?.isActive == true) return
        job = scope.launch { run() }
    }

    fun stop() {
        job?.cancel()
        job = null
    }

    fun setForeground(value: Boolean) {
        if (foreground == value) return
        foreground = value
        wake.trySend(value)
    }

    fun setPlaying(value: Boolean) {
        if (playing == value) return
        playing = value
        wake.trySend(false)
    }

    /** Delay before the next call, or null when polling pauses (app in the background). */
    fun nextDelay(): Long? = when {
        !foreground -> null
        failures > 0 -> minOf(FOREGROUND_INTERVAL_MS shl minOf(failures, 4), MAX_BACKOFF_MS)
        playing -> PLAYBACK_INTERVAL_MS
        else -> FOREGROUND_INTERVAL_MS
    }

    private suspend fun run() {
        // A wake sent before the start (conflated: at most one) is already accounted for by reading `foreground` now.
        wake.tryReceive()
        var now = foreground
        while (true) {
            if (!now) {
                val delayMs = nextDelay()
                val woke = if (delayMs == null) wake.receive() else withTimeoutOrNull(delayMs) { wake.receive() }
                if (woke != null) {
                    now = woke && failures == 0
                    continue
                }
            }
            now = tick()
        }
    }

    /** One call; true when the next one should follow at once. */
    private suspend fun tick(): Boolean {
        try {
            val page = list(cursor, PAGE_LIMIT)
            failures = 0
            val first = cursor == null
            cursor = page.nextCursor
            if (!first && page.events.isNotEmpty()) onEvents(page.events.map(AppEvent::of))
            return page.events.size >= PAGE_LIMIT
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiException) {
            if (e.status == 410) {
                cursor = null
                failures = 0
                onReset()
                return true
            }
            failures += 1
            log("event poll failed: ${e.code}", e)
        } catch (e: Exception) {
            failures += 1
            log("event poll failed", e)
        }
        return false
    }

    companion object {
        const val FOREGROUND_INTERVAL_MS = 5_000L
        const val PLAYBACK_INTERVAL_MS = 15_000L
        const val MAX_BACKOFF_MS = 60_000L
        const val PAGE_LIMIT = 100L
    }
}
