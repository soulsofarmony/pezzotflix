package dev.pezzotflix.tv.ui.player

import dev.pezzotflix.api.models.Trickplay
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Tile math (contract `Trickplay`, ADR 0009 construction notes) and the sheet LRU. */
@OptIn(ExperimentalCoroutinesApi::class)
class TrickplayTest {
    /** 2 h 29 min at 10 s: 895 tiles over 9 sheets of 10 × 10 (the last one partly filled). */
    private val tp = Trickplay(
        intervalMs = 10_000, tileWidth = 320, tileHeight = 180, columns = 10, rows = 10, count = 895,
        sheets = (0 until 9).map { "/video/media/s/tok_aaaaaaaaaaaaaaaa/trickplay/sheet-$it.jpg" },
    )

    @Test
    fun tileIndexIsTheNearestTileClampedToCount() {
        val cases = listOf(
            0L to 0, 4_999L to 0, 5_000L to 1, 14_999L to 1, 19_000L to 2, 20_000L to 2, -3_000L to 0,
            8_940_000L to 894, 8_944_000L to 894, 9_999_999L to 894,
        )
        for ((p, i) in cases) assertEquals("$p", i, TrickplayMath.tileIndex(p, tp))
    }

    @Test
    fun tileSheetColumnAndRow() {
        val cases = listOf(
            0L to TrickplayTile(0, 0, tp.sheets[0], 0, 0),
            90_000L to TrickplayTile(9, 0, tp.sheets[0], 9, 0),
            100_000L to TrickplayTile(10, 0, tp.sheets[0], 0, 1),
            990_000L to TrickplayTile(99, 0, tp.sheets[0], 9, 9),
            1_000_000L to TrickplayTile(100, 1, tp.sheets[1], 0, 0),
            1_234_000L to TrickplayTile(123, 1, tp.sheets[1], 3, 2),
            // Past count: the last real tile, never one of the padding tiles of the last sheet.
            99_000_000L to TrickplayTile(894, 8, tp.sheets[8], 4, 9),
        )
        for ((p, tile) in cases) assertEquals("$p", tile, TrickplayMath.tileAt(p, tp))
    }

    @Test
    fun aSheetTheSessionDoesNotListHasNoTile() {
        assertNull(TrickplayMath.tileAt(1_000_000, tp.copy(sheets = tp.sheets.take(1))))
    }

    @Test
    fun cropOffsetsAtTheSheetsOwnSizeAndScaledWhenDecodedSmaller() {
        val tile = TrickplayMath.tileAt(1_234_000, tp)!!
        assertEquals(TileCrop(960, 360, 320, 180), TrickplayMath.crop(tile, tp, 3200, 1800))
        assertEquals(TileCrop(480, 180, 160, 90), TrickplayMath.crop(tile, tp, 1600, 900))
        // Anamorphic 4:3 tiles (320 × 240) on the last row.
        val tall = tp.copy(tileHeight = 240)
        assertEquals(TileCrop(2880, 2160, 320, 240), TrickplayMath.crop(TrickplayMath.tileAt(990_000, tall)!!, tall, 3200, 2400))
        // A bitmap too short for the row: nothing to draw.
        assertNull(TrickplayMath.crop(TrickplayMath.tileAt(990_000, tp)!!, tp, 3200, 1000))
    }

    @Test
    fun sheetCacheKeepsTwoSheetsLoadsEachOnceAndForgetsThemOnANewSession() = runTest {
        val loads = mutableListOf<String>()
        val cache = SheetCache(backgroundScope, capacity = 2) { url: String -> loads += url; "img:$url" }
        cache.bind(listOf("a", "b", "c"))
        assertEquals("img:a", cache.get("a"))
        assertEquals("img:a", cache.get("a"))
        assertEquals("img:b", cache.get("b"))
        cache.get("a") // a is now the most recent
        assertEquals("img:c", cache.get("c"))
        assertEquals(listOf("a", "c"), cache.cachedUrls())
        assertEquals(listOf("a", "b", "c"), loads)

        cache.bind(listOf("a", "b", "c"))
        assertEquals(listOf("a", "c"), cache.cachedUrls())
        // A re-plan: new token, new urls; the old sheets go.
        cache.bind(listOf("x"))
        assertEquals(emptyList<String>(), cache.cachedUrls())
        cache.bind(null)
        assertNull(cache.cached("x"))
    }

    @Test
    fun aNewSheetCancelsTheLoadInFlightAndAFailureIsNotCached() = runTest {
        val gates = mutableMapOf<String, CompletableDeferred<String?>>()
        val cache = SheetCache(backgroundScope) { url: String -> gates.getOrPut(url) { CompletableDeferred() }.await() }
        cache.preload("a")
        val a = async { cache.get("a") }
        runCurrent()
        val b = async { cache.get("b") }
        runCurrent()
        // a was superseded: whoever waits for it gets nothing, and its late answer is not kept.
        assertNull(a.await())
        gates.getValue("a").complete("img:a")
        gates.getValue("b").complete("img:b")
        runCurrent()
        assertEquals("img:b", b.await())

        val c = async { cache.get("c") }
        runCurrent()
        gates.getValue("c").complete(null)
        runCurrent()
        assertNull(c.await())
        assertEquals(listOf("b"), cache.cachedUrls())
    }

    @Test
    fun aLoadThatEndsAfterTheSessionChangedIsDropped() = runTest {
        val gate = CompletableDeferred<String?>()
        val cache = SheetCache(backgroundScope) { _: String -> gate.await() }
        cache.bind(listOf("a"))
        cache.preload("a")
        runCurrent()
        cache.bind(listOf("z"))
        gate.complete("img:a")
        runCurrent()
        assertEquals(emptyList<String>(), cache.cachedUrls())
    }
}
