package dev.pezzotflix.tv.api

import dev.pezzotflix.api.models.Event
import dev.pezzotflix.api.models.EventPage
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class EventPollerTest {
    private class Server {
        val calls = mutableListOf<Pair<Long, String?>>()
        val answers = ArrayDeque<(String?) -> EventPage>()
        var seq = 0L

        fun page(n: Int, cursor: String = "c$seq"): (String?) -> EventPage = {
            val events = (1..n).map { Event(seq = ++seq, type = "library.item_added", at = 0, payload = emptyMap()) }
            EventPage(events, cursor)
        }
    }

    private fun TestScope.poller(server: Server, received: MutableList<AppEvent>, resets: IntArray): EventPoller =
        EventPoller(
            list = { cursor, _ ->
                server.calls.add(currentTime to cursor)
                (server.answers.removeFirstOrNull() ?: server.page(0)).invoke(cursor)
            },
            onEvents = { received.addAll(it) },
            onReset = { resets[0] += 1 },
        )

    @Test
    fun firstCallHasNoCursorAndItsEventsAreSkipped() = runTest {
        val server = Server()
        val received = mutableListOf<AppEvent>()
        val p = poller(server, received, IntArray(1))
        server.answers.add(server.page(2, "c2"))
        server.answers.add(server.page(1, "c3"))
        p.setForeground(true)
        p.start(backgroundScope)
        runCurrent()
        assertEquals(listOf(0L to null), server.calls)
        assertEquals(0, received.size)
        advanceTimeBy(5_001)
        assertEquals(5_000L to "c2", server.calls[1])
        assertEquals(1, received.size)
    }

    @Test
    fun intervalsFollowForegroundAndPlayback() = runTest {
        val server = Server()
        val p = poller(server, mutableListOf(), IntArray(1))
        p.setForeground(true)
        p.start(backgroundScope)
        runCurrent()
        advanceTimeBy(10_000)
        runCurrent()
        assertEquals(listOf(0L, 5_000L, 10_000L), server.calls.map { it.first })

        p.setPlaying(true)
        runCurrent()
        advanceTimeBy(30_000)
        runCurrent()
        // The interval restarts from the change (t = 10 s): 25 s, 40 s.
        assertEquals(listOf(25_000L, 40_000L), server.calls.drop(3).map { it.first })

        p.setForeground(false)
        runCurrent()
        val before = server.calls.size
        advanceTimeBy(120_000)
        assertEquals(before, server.calls.size)

        // Back to the foreground: at once.
        p.setForeground(true)
        runCurrent()
        assertEquals(before + 1, server.calls.size)
        assertEquals(currentTime, server.calls.last().first)
    }

    @Test
    fun errorsBackOffUpToSixtySeconds() = runTest {
        val server = Server()
        val p = poller(server, mutableListOf(), IntArray(1))
        repeat(6) { server.answers.add { throw ApiException.network(java.io.IOException("down")) } }
        p.setForeground(true)
        p.start(backgroundScope)
        runCurrent()
        advanceTimeBy(300_000)
        val times = server.calls.map { it.first }
        // 0, +10, +20, +40, +60, +60 (failures), then back to 5 s.
        assertEquals(listOf(0L, 10_000L, 30_000L, 70_000L, 130_000L, 190_000L, 250_000L, 255_000L), times.take(8))
    }

    @Test
    fun expiredCursorResetsAndPollsAgainAtOnce() = runTest {
        val server = Server()
        val resets = IntArray(1)
        val p = poller(server, mutableListOf(), resets)
        server.answers.add(server.page(0, "c0"))
        server.answers.add { throw ApiException(status = 410, code = "CURSOR_EXPIRED") }
        p.setForeground(true)
        p.start(backgroundScope)
        runCurrent()
        advanceTimeBy(5_001)
        assertEquals(1, resets[0])
        assertEquals(listOf(null, "c0", null), server.calls.map { it.second })
        assertEquals(5_000L, server.calls[2].first)
    }

    @Test
    fun aFullPageIsFollowedAtOnce() = runTest {
        val server = Server()
        val received = mutableListOf<AppEvent>()
        val p = poller(server, received, IntArray(1))
        server.answers.add(server.page(0, "c0"))
        server.answers.add(server.page(EventPoller.PAGE_LIMIT.toInt(), "c100"))
        server.answers.add(server.page(3, "c103"))
        p.setForeground(true)
        p.start(backgroundScope)
        runCurrent()
        advanceTimeBy(5_001)
        assertEquals(listOf(0L, 5_000L, 5_000L), server.calls.map { it.first })
        assertEquals(103, received.size)
    }
}
