package dev.pezzotflix.tv.player.subtitles

import androidx.media3.common.text.Cue
import androidx.media3.extractor.text.CuesWithTiming
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Robolectric: Media3's parsers build Android text spans and bitmaps. */
@RunWith(RobolectricTestRunner::class)
class CueStoresTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private fun text(s: String) = Cue.Builder().setText(s).build()

    private fun entry(startMs: Long, endMs: Long, s: String) = CuesWithTiming(listOf(text(s)), startMs * 1000, (endMs - startMs) * 1000)

    @Test
    fun textCuesShowWhileTheirTimeHoldsTheOverlappingOnesTogether() {
        val store = TextCueStore()
        store.add(entry(1_000, 3_000, "a"))
        store.add(entry(5_000, 6_000, "c"))
        // Parsed from another piece, out of order and overlapping the first.
        store.add(entry(2_000, 4_000, "b"))
        store.add(CuesWithTiming(emptyList(), 0, 1_000_000))
        val at = { ms: Long -> store.at(ms * 1000).map { it.text.toString() } }
        assertEquals(3, store.size)
        assertEquals(emptyList<String>(), at(500))
        assertEquals(listOf("a"), at(1_500))
        assertEquals(listOf("a", "b"), at(2_500))
        assertEquals(listOf("b"), at(3_000))
        assertEquals(emptyList<String>(), at(4_500))
        assertEquals(listOf("c"), at(5_999))
        assertEquals(emptyList<String>(), at(6_000))
    }

    @Test
    fun pgsSetsAreDecodedWhenDueAndAnEmptySetClears() = runTest {
        val decoder = StandardTestDispatcher(testScheduler)
        val store = PgsCueStore(tmp.root, backgroundScope, decoder)
        SupSplitter().push(SupFixtures.stream).forEach(store::add)
        assertEquals(2, store.size)

        assertEquals(emptyList<Cue>(), store.at(500_000))
        // Not decoded yet: null keeps what is on screen.
        assertNull(store.at(1_500_000))
        runCurrent()
        val shown = store.at(1_500_000)!!
        val cue = shown.single()
        assertEquals(2, cue.bitmap!!.width)
        assertEquals(2, cue.bitmap!!.height)
        assertEquals(10f / 1920, cue.position, 1e-6f)
        assertEquals(20f / 1080, cue.line, 1e-6f)
        // The next set was decoded ahead: the clear is ready on time.
        runCurrent()
        assertEquals(emptyList<Cue>(), store.at(3_500_000))

        val file = tmp.root.listFiles()!!.single()
        assertTrue(file.length() > 0)
        store.close()
        assertFalse(file.exists())
    }
}
