package dev.pezzotflix.tv.player.subtitles

import java.io.ByteArrayOutputStream
import java.io.IOException

/** A PGS display set: the segments Media3's PgsParser reads from an MKV block, and its presentation time. */
class DisplaySet(
    /** PTS of its presentation composition segment, on the original timeline (the server extracts with -copyts -start_at_zero). */
    val ptsUs: Long,
    /** Segment type (u8), size (u16) and payload of every segment, PCS to END: no "PG" headers. */
    val data: ByteArray,
)

class SupFormatException(message: String) : IOException(message)

/**
 * Splits a PGS .sup stream (getSubtitle, also while it grows) into display sets. Media3 1.11 yields no cue from a
 * side-loaded .sup (S5): its PgsParser reads segments as an MKV block holds them, without the 13-byte .sup header.
 * - A .sup segment: "PG", PTS (u32, 90 kHz), DTS (u32), type (u8), size (u16), payload.
 * - A display set runs from a presentation composition segment (0x16) to an end segment (0x80); bytes before the
 *   first PCS are skipped.
 * Chunks may cut segments anywhere: the incomplete tail waits for the next push.
 */
class SupSplitter {
    private var buf = ByteArray(64 * 1024)
    private var len = 0
    private var consumed = 0L
    private val set = ByteArrayOutputStream()
    private var setPts = -1L

    fun push(chunk: ByteArray, offset: Int = 0, length: Int = chunk.size): List<DisplaySet> {
        append(chunk, offset, length)
        val out = ArrayList<DisplaySet>()
        var at = 0
        while (len - at >= HEADER_BYTES) {
            if (u16(at) != MAGIC) throw SupFormatException("not a PGS segment at byte ${consumed + at}")
            val size = u16(at + 11)
            val end = at + HEADER_BYTES + size
            if (end > len) break
            val type = buf[at + 10].toInt() and 0xFF
            if (type == PCS) {
                set.reset()
                setPts = u32(at + 2)
            }
            if (setPts >= 0) {
                set.write(buf, at + 10, 3 + size)
                if (type == END) {
                    out += DisplaySet(ptsToUs(setPts), set.toByteArray())
                    set.reset()
                    setPts = -1
                }
            }
            at = end
        }
        System.arraycopy(buf, at, buf, 0, len - at)
        len -= at
        consumed += at
        return out
    }

    /** Bytes of an incomplete segment or display set waiting for more data. */
    val pending: Int get() = len + set.size()

    private fun append(chunk: ByteArray, offset: Int, length: Int) {
        if (len + length > buf.size) buf = buf.copyOf(maxOf(buf.size * 2, len + length))
        System.arraycopy(chunk, offset, buf, len, length)
        len += length
    }

    private fun u16(at: Int): Int = ((buf[at].toInt() and 0xFF) shl 8) or (buf[at + 1].toInt() and 0xFF)

    private fun u32(at: Int): Long = (u16(at).toLong() shl 16) or u16(at + 2).toLong()

    companion object {
        const val HEADER_BYTES = 13
        private const val MAGIC = 0x5047
        const val PCS = 0x16
        const val END = 0x80

        /** 90 kHz ticks to µs. */
        fun ptsToUs(pts: Long): Long = pts * 100 / 9
    }
}

/**
 * Cuts a WebVTT stream (UTF-8) at blank lines, so each piece parses on its own with Media3's WebvttParser: the
 * header (WEBVTT and any block before the first cue) goes in front of every piece. A cue block never contains a
 * blank line, and a cut at a newline byte never splits a UTF-8 character.
 */
class VttChunker {
    private var buf = ByteArray(16 * 1024)
    private var len = 0
    private var header: String? = null
    private val headerBlocks = StringBuilder()

    /** A parseable document with the cue blocks completed by [chunk], or null when none completed. */
    fun push(chunk: ByteArray, offset: Int = 0, length: Int = chunk.size): String? {
        if (len + length > buf.size) buf = buf.copyOf(maxOf(buf.size * 2, len + length))
        System.arraycopy(chunk, offset, buf, len, length)
        len += length
        val cut = lastBlankLineEnd()
        if (cut <= 0) return null
        val text = String(buf, 0, cut, Charsets.UTF_8)
        System.arraycopy(buf, cut, buf, 0, len - cut)
        len -= cut
        return document(text)
    }

    /** The rest at the end of the stream (a last block without its blank line). */
    fun finish(): String? {
        if (len == 0) return null
        val text = String(buf, 0, len, Charsets.UTF_8)
        len = 0
        return document(text)
    }

    private fun document(text: String): String? {
        val cues = StringBuilder()
        for (block in text.replace("\r\n", "\n").split(BLANK_LINES)) {
            if (block.isBlank()) continue
            if (header == null && "-->" !in block) {
                headerBlocks.append(block.trimEnd()).append("\n\n")
                continue
            }
            if (header == null) header = headerBlocks.toString().ifEmpty { "WEBVTT\n\n" }
            cues.append(block.trimEnd()).append("\n\n")
        }
        val h = header ?: return null
        return if (cues.isEmpty()) null else h + cues
    }

    /** Index just after the last blank line ("\n\n" or "\n\r\n"), or -1. */
    private fun lastBlankLineEnd(): Int {
        var i = len - 1
        while (i >= 1) {
            if (buf[i] == NL) {
                if (buf[i - 1] == NL) return i + 1
                if (i >= 2 && buf[i - 1] == CR && buf[i - 2] == NL) return i + 1
            }
            i--
        }
        return -1
    }

    private companion object {
        const val NL = '\n'.code.toByte()
        const val CR = '\r'.code.toByte()
        val BLANK_LINES = Regex("\n[ \t]*\n+")
    }
}
