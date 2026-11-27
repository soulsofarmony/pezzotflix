package dev.pezzotflix.tv.ui.player

import dev.pezzotflix.api.models.Trickplay
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive
import kotlin.math.roundToInt

/** One preview tile: its sheet (the session's relative locator, never built here) and its cell in that sheet. */
data class TrickplayTile(val index: Int, val sheet: Int, val url: String, val column: Int, val row: Int)

/** The source rectangle of a tile, in pixels of the decoded sheet. */
data class TileCrop(val x: Int, val y: Int, val width: Int, val height: Int)

/**
 * Preview math (ADR 0009 D6 and its construction notes, contract `Trickplay`). Positions are on the original media
 * timeline, the same as the player's positions: no conversion.
 */
object TrickplayMath {
    /** Tile i covers [i·I − I/2, i·I + I/2): the nearest one, never one past count (the last sheet may hold more). */
    fun tileIndex(positionMs: Long, tp: Trickplay): Int {
        val nearest = Math.round(positionMs.coerceAtLeast(0).toDouble() / tp.intervalMs)
        return minOf(tp.count - 1, nearest).coerceAtLeast(0).toInt()
    }

    /** The tile for a position, or null when the session lists no sheet for it. */
    fun tileAt(positionMs: Long, tp: Trickplay): TrickplayTile? {
        val index = tileIndex(positionMs, tp)
        val perSheet = (tp.columns * tp.rows).toInt()
        if (perSheet <= 0) return null
        val sheet = index / perSheet
        val url = tp.sheets.getOrNull(sheet) ?: return null
        val within = index % perSheet
        return TrickplayTile(index, sheet, url, within % tp.columns.toInt(), within / tp.columns.toInt())
    }

    /**
     * The tile's rectangle in a decoded sheet of [sheetWidth] × [sheetHeight] px. The server's sheets are
     * columns × tileWidth wide; a sheet decoded at another size (it should not be: Size.ORIGINAL) is scaled on its
     * width, so the cells still line up. Null when the cell falls outside the bitmap.
     */
    fun crop(tile: TrickplayTile, tp: Trickplay, sheetWidth: Int, sheetHeight: Int): TileCrop? {
        val natural = tp.columns * tp.tileWidth
        if (natural <= 0 || sheetWidth <= 0 || sheetHeight <= 0) return null
        val scale = sheetWidth.toDouble() / natural
        val x = (tile.column * tp.tileWidth * scale).roundToInt()
        val y = (tile.row * tp.tileHeight * scale).roundToInt()
        val w = minOf((tp.tileWidth * scale).roundToInt(), sheetWidth - x)
        val h = minOf((tp.tileHeight * scale).roundToInt(), sheetHeight - y)
        return if (w > 0 && h > 0) TileCrop(x, y, w, h) else null
    }
}

/**
 * The decoded sheets of one trickplay, at most [capacity] in an LRU of their own (not Coil's memory cache, which
 * the posters share: a 3200 × 1800 sheet weighs 11–23 MB on a 32-bit TV). One load at a time: asking for another
 * sheet cancels the load in flight, so scrubbing fast across sheets never decodes more than one extra. Keys are
 * the session's locators; [bind] with a new list (a re-plan: new token, new urls) drops everything.
 * Main thread only (the screen's scope).
 */
class SheetCache<T : Any>(
    private val scope: CoroutineScope,
    private val capacity: Int = 2,
    private val load: suspend (url: String) -> T?,
) {
    private val cache = object : LinkedHashMap<String, T>(capacity + 1, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, T>?): Boolean = size > capacity
    }
    private var inFlight: Pair<String, Deferred<T?>>? = null
    private var bound: List<String>? = null
    private var generation = 0

    /** The sheets of the current session; a different list empties the cache. */
    fun bind(sheets: List<String>?) {
        if (sheets == bound) return
        bound = sheets
        clear()
    }

    fun cached(url: String): T? = cache[url]

    /** Sheets held in memory, least recently used first. */
    fun cachedUrls(): List<String> = cache.keys.toList()

    /** Starts loading [url] without waiting (entering scrub mode). */
    fun preload(url: String) {
        if (cache[url] == null) start(url)
    }

    /** The sheet, loaded if needed; null when it cannot be loaded or another sheet superseded this load. */
    suspend fun get(url: String): T? {
        cache[url]?.let { return it }
        val call = start(url)
        return try {
            call.await()
        } catch (e: CancellationException) {
            // The load was superseded, not this caller: no sheet.
            if (currentCoroutineContext().isActive) null else throw e
        }
    }

    fun clear() {
        generation += 1
        inFlight?.second?.cancel()
        inFlight = null
        cache.clear()
    }

    private fun start(url: String): Deferred<T?> {
        inFlight?.let { (u, d) ->
            if (u == url && d.isActive) return d
            d.cancel()
        }
        val gen = generation
        val call = scope.async {
            val value = try {
                load(url)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                null
            }
            if (gen == generation) {
                if (value != null) cache[url] = value
                if (inFlight?.first == url) inFlight = null
            }
            value
        }
        inFlight = url to call
        return call
    }
}
