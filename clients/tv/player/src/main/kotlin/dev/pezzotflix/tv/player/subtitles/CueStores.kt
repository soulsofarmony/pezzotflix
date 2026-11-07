package dev.pezzotflix.tv.player.subtitles

import androidx.annotation.OptIn
import androidx.media3.common.text.Cue
import androidx.media3.common.util.UnstableApi
import androidx.media3.extractor.text.CuesWithTiming
import androidx.media3.extractor.text.SubtitleParser
import androidx.media3.extractor.text.pgs.PgsParser
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import java.io.File
import java.io.RandomAccessFile

/**
 * The cues of one sidecar file, filled while it downloads (on an IO thread) and read by the renderer (main thread).
 * Times are on the original timeline, in µs.
 */
interface CueStore {
    /** Display units received so far (cues or display sets). */
    val size: Int

    /** The cues at [positionUs], or null while they are not ready yet (a bitmap still decoding): keep what is shown. */
    fun at(positionUs: Long): List<Cue>?

    fun close()
}

/**
 * Text cues (WebVTT), Media3's MERGE behaviour: every entry whose [start, end) holds the position shows. Entries of
 * different pieces of a growing file may overlap.
 */
@OptIn(UnstableApi::class)
class TextCueStore : CueStore {
    private val lock = Any()
    private val entries = ArrayList<CuesWithTiming>()
    private var longest = 0L

    override val size: Int get() = synchronized(lock) { entries.size }

    fun add(e: CuesWithTiming) {
        if (e.cues.isEmpty() || e.startTimeUs < 0 || e.durationUs <= 0) return
        synchronized(lock) {
            // Appended in order almost always; a late entry goes to its place.
            var i = entries.size
            while (i > 0 && entries[i - 1].startTimeUs > e.startTimeUs) i--
            entries.add(i, e)
            longest = maxOf(longest, e.durationUs)
        }
    }

    override fun at(positionUs: Long): List<Cue> = synchronized(lock) {
        var i = lastStartAtOrBefore(positionUs)
        if (i < 0) return emptyList()
        var out: List<Cue>? = null
        while (i >= 0 && entries[i].startTimeUs >= positionUs - longest) {
            val e = entries[i]
            if (positionUs < e.endTimeUs) out = if (out == null) e.cues else e.cues + out
            i--
        }
        out ?: emptyList()
    }

    private fun lastStartAtOrBefore(us: Long): Int {
        var lo = 0
        var hi = entries.size - 1
        var found = -1
        while (lo <= hi) {
            val mid = (lo + hi) ushr 1
            if (entries[mid].startTimeUs <= us) {
                found = mid
                lo = mid + 1
            } else {
                hi = mid - 1
            }
        }
        return found
    }

    override fun close() = Unit
}

/**
 * PGS display sets (Media3's REPLACE behaviour: a set shows until the next one, an empty set clears). The raw sets
 * go to a temporary file, not the heap: a full film's .sup is tens of MB, and decoded bitmaps would be far more.
 * A set is decoded when it is due, on [decoder] (one thread: PgsParser keeps state), and the next one is decoded
 * ahead, so it is ready on time.
 */
@OptIn(UnstableApi::class)
class PgsCueStore(dir: File, private val scope: CoroutineScope, private val decoder: CoroutineDispatcher) : CueStore {
    private val file: File = File.createTempFile(TEMP_PREFIX, ".sup", dir)
    private val raf = RandomAccessFile(file, "rw")
    private val lock = Any()
    private var starts = LongArray(256)
    private var offsets = LongArray(256)
    private var lengths = IntArray(256)
    private var count = 0
    private var end = 0L
    private var closed = false
    private val decoded = HashMap<Int, List<Cue>>()
    private val decoding = HashSet<Int>()
    private val parser = PgsParser()

    override val size: Int get() = synchronized(lock) { count }

    fun add(set: DisplaySet): Unit = synchronized(lock) {
        if (closed) return
        // A set out of order (never seen from the server) is dropped rather than breaking the binary search.
        if (count > 0 && set.ptsUs < starts[count - 1]) return
        raf.seek(end)
        raf.write(set.data)
        if (count == starts.size) {
            starts = starts.copyOf(count * 2)
            offsets = offsets.copyOf(count * 2)
            lengths = lengths.copyOf(count * 2)
        }
        starts[count] = set.ptsUs
        offsets[count] = end
        lengths[count] = set.data.size
        count++
        end += set.data.size
    }

    override fun at(positionUs: Long): List<Cue>? {
        val i: Int
        synchronized(lock) {
            i = lastStartAtOrBefore(positionUs)
            if (i < 0) return emptyList()
            val hit = decoded[i]
            if (hit != null) {
                request(i + 1)
                return hit
            }
            request(i)
        }
        return null
    }

    /** Called with [lock] held. */
    private fun request(i: Int) {
        if (i >= count || i in decoded || !decoding.add(i)) return
        scope.launch(decoder) {
            val bytes = synchronized(lock) {
                if (closed || i >= count) null else ByteArray(lengths[i]).also {
                    raf.seek(offsets[i])
                    raf.readFully(it)
                }
            }
            var cues: List<Cue> = emptyList()
            if (bytes != null) {
                runCatching { parser.parse(bytes, SubtitleParser.OutputOptions.allCues()) { c -> cues = c.cues } }
            }
            synchronized(lock) {
                decoding.remove(i)
                if (closed) return@launch
                decoded[i] = cues
                // Keep the sets around the one just decoded: bitmaps are large.
                decoded.keys.retainAll { it in i - 1..i + 1 }
            }
        }
    }

    private fun lastStartAtOrBefore(us: Long): Int {
        var lo = 0
        var hi = count - 1
        var found = -1
        while (lo <= hi) {
            val mid = (lo + hi) ushr 1
            if (starts[mid] <= us) {
                found = mid
                lo = mid + 1
            } else {
                hi = mid - 1
            }
        }
        return found
    }

    override fun close() {
        synchronized(lock) {
            if (closed) return
            closed = true
            decoded.clear()
            runCatching { raf.close() }
        }
        file.delete()
    }

    companion object {
        const val TEMP_PREFIX = "pzf-pgs-"
    }
}
