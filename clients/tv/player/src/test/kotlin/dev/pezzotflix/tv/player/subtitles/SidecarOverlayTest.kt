package dev.pezzotflix.tv.player.subtitles

import dev.pezzotflix.api.models.SessionTrack
import dev.pezzotflix.api.models.SessionTrack.Availability
import dev.pezzotflix.api.models.SessionTrack.Delivery
import dev.pezzotflix.tv.player.Fixtures
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.SocketEffect
import okhttp3.OkHttpClient
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.util.Collections
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * The overlay against a real HTTP server (MockWebServer), with one thread standing for the main thread and real time:
 * the download runs on OkHttp's blocking IO.
 */
@RunWith(RobolectricTestRunner::class)
class SidecarOverlayTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private val server = MockWebServer()
    private val mainThread = Executors.newSingleThreadExecutor()
    private val main = mainThread.asCoroutineDispatcher()
    private val scope = CoroutineScope(SupervisorJob() + main)
    private val events: MutableList<String> = Collections.synchronizedList(mutableListOf())
    private lateinit var overlay: SidecarOverlay

    @Before
    fun setUp() {
        server.start()
        val listener = object : SidecarOverlay.Listener {
            override fun onPreparing(preparing: Boolean) {
                events += "preparing:$preparing"
            }

            override fun onFailure(trackId: String) {
                events += "failure:$trackId"
            }
        }
        overlay = SidecarOverlay(OkHttpClient(), resolve = { server.url(it).toString() }, scope = scope, cacheDir = tmp.root, listener = listener)
    }

    @After
    fun tearDown() {
        onMain { overlay.clear() }
        scope.cancel()
        mainThread.shutdownNow()
        server.close()
    }

    private fun <T> onMain(block: () -> T): T = runBlocking(main) { block() }

    /** [cond] runs on the test thread: it reads the overlay through [onMain]. */
    private fun until(what: String, timeoutMs: Long = 10_000, cond: () -> Boolean) {
        val end = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs)
        while (!cond()) {
            check(System.nanoTime() < end) { "timed out waiting for $what; events $events" }
            Thread.sleep(10)
        }
    }

    private fun texts(ms: Long): List<String> = onMain { overlay.cuesAt(ms).map { it.text.toString() } }

    private fun vtt(vararg cues: Pair<Long, String>): String =
        "WEBVTT\n\n" + cues.joinToString("") { (start, text) -> "${ts(start)} --> ${ts(start + 1_000)}\n$text\n\n" }

    private fun ts(ms: Long) = "00:00:%02d.%03d".format(ms / 1000, ms % 1000)

    private fun srt(id: String, availability: Availability): SessionTrack =
        Fixtures.sub(id, 1, "subrip", "ita", selected = true, delivery = Delivery.sidecar, url = "/video/media/s/tok/subtitles/$id.vtt")
            .copy(availability = availability)

    @Test
    fun aGrowingTrackShowsItsCuesThenSwapsToTheFinalFileAtItsEnd() {
        server.enqueue(MockResponse.Builder().chunkedBody(vtt(1_000L to "Uno"), 16).build())
        onMain { overlay.show(srt("s1", Availability.growing)) }
        until("the first cue") { texts(1_500) == listOf("Uno") }
        until("preparing to end") { "preparing:false" in events.toList() }
        assertEquals(listOf("preparing:true", "preparing:false"), events.toList())

        // playback.subtitle_ready: the final file, read slowly. The cues shown stay until it is read to its end.
        val final = vtt(1_000L to "Uno", 5_000L to "Cinque")
        server.enqueue(MockResponse.Builder().body(final).throttleBody(16, 100, TimeUnit.MILLISECONDS).build())
        onMain { overlay.complete("s1") }
        assertEquals(listOf("Uno"), texts(1_500))
        assertEquals(emptyList<String>(), texts(5_500))
        until("the final file's cues") { texts(5_500) == listOf("Cinque") }
        assertEquals(listOf("Uno"), texts(1_500))
        assertEquals(2, server.requestCount)
        // No "in preparazione" for the swap, no failure.
        assertEquals(listOf("preparing:true", "preparing:false"), events.toList())

        // The session repeating the now complete track changes nothing.
        onMain { overlay.show(srt("s1", Availability.complete)) }
        assertEquals(2, server.requestCount)
    }

    @Test
    fun aQueuedTrackIsInPreparationUntilItsUrlAnswers() {
        server.enqueue(MockResponse.Builder().code(503).addHeader("Retry-After", "1").build())
        server.enqueue(MockResponse.Builder().body(vtt(2_000L to "Due")).build())
        onMain { overlay.show(srt("s2", Availability.complete)) }
        until("the cue after the wait") { texts(2_500) == listOf("Due") }
        assertEquals(listOf("preparing:true", "preparing:false"), events.toList())
        assertEquals(2, server.requestCount)
    }

    @Test
    fun aGrowingResponseCutShortIsReadAgain() {
        server.enqueue(MockResponse.Builder().body(vtt(1_000L to "Uno", 3_000L to "Tre")).onResponseBody(SocketEffect.CloseSocket()).build())
        server.enqueue(MockResponse.Builder().body(vtt(1_000L to "Uno", 3_000L to "Tre")).build())
        onMain { overlay.show(srt("s3", Availability.growing)) }
        until("the cues of the second read") { texts(3_500) == listOf("Tre") }
        assertEquals(2, server.requestCount)
        assertFalse(events.any { it.startsWith("failure") })
    }

    @Test
    fun aTrackThatWillNotLoadIsAFailureOfTheTrack() {
        val cases = listOf(
            "f503" to MockResponse.Builder().code(503).build(),
            "f404" to MockResponse.Builder().code(404).build(),
            "f410" to MockResponse.Builder().code(410).build(),
        )
        for ((id, response) in cases) {
            server.enqueue(response)
            onMain { overlay.show(srt(id, Availability.complete)) }
            until("the failure of $id") { "failure:$id" in events.toList() }
            assertFalse(id, onMain { overlay.active })
            assertEquals(id, emptyList<String>(), texts(0))
        }
    }

    @Test
    fun aPgsTrackIsDrawnFromItsDisplaySets() {
        server.enqueue(MockResponse.Builder().body(Buffer().write(SupFixtures.stream)).build())
        val sup = Fixtures.sub("s4", 4, "hdmv_pgs_subtitle", "ita", selected = true, delivery = Delivery.client_render, url = "/video/media/s/tok/subtitles/s4.sup")
        onMain { overlay.show(sup) }
        until("the bitmap") { onMain { overlay.cuesAt(1_500) }.singleOrNull()?.bitmap != null }
        val bitmap = onMain { overlay.cuesAt(1_500) }.single().bitmap!!
        assertEquals(2, bitmap.width)
        until("the clearing set") { onMain { overlay.cuesAt(3_500) }.isEmpty() }
        assertTrue(events.none { it.startsWith("failure") })
    }
}
