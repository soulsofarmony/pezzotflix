package dev.pezzotflix.tv.player.subtitles

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class SplittersTest {
    private fun splitAll(stream: ByteArray, chunk: Int): List<DisplaySet> {
        val s = SupSplitter()
        val out = ArrayList<DisplaySet>()
        var at = 0
        while (at < stream.size) {
            val n = minOf(chunk, stream.size - at)
            out += s.push(stream, at, n)
            at += n
        }
        assertEquals("chunk $chunk", 0, s.pending)
        return out
    }

    @Test
    fun aSupSplitsIntoDisplaySetsWithTheirTimesWhateverTheChunks() {
        val whole = splitAll(SupFixtures.stream, SupFixtures.stream.size)
        assertEquals(listOf(1_000_000L, 3_000_000L), whole.map { it.ptsUs })
        // What PgsParser reads from an MKV block: type, size, payload of each segment, no 13-byte .sup header.
        val first = whole[0].data
        assertEquals(SupFixtures.PCS, first[0].toInt() and 0xFF)
        assertArrayEquals(byteArrayOf(0x80.toByte(), 0, 0), first.copyOfRange(first.size - 3, first.size))
        val expectedSize = listOf(SupFixtures.pcs(1), SupFixtures.wds, SupFixtures.pds, SupFixtures.ods, ByteArray(0)).sumOf { 3 + it.size }
        assertEquals(expectedSize, first.size)

        for (chunk in listOf(1, 2, 7, 13, 14, 100)) {
            val parts = splitAll(SupFixtures.stream, chunk)
            assertEquals("chunk $chunk", whole.map { it.ptsUs }, parts.map { it.ptsUs })
            for (i in whole.indices) assertArrayEquals("chunk $chunk set $i", whole[i].data, parts[i].data)
        }
    }

    @Test
    fun anIncompleteSetWaitsForTheRest() {
        val s = SupSplitter()
        val cut = SupFixtures.stream.size - 5
        assertEquals(1, s.push(SupFixtures.stream, 0, cut).size)
        assertTrue(s.pending > 0)
        assertEquals(listOf(3_000_000L), s.push(SupFixtures.stream, cut, 5).map { it.ptsUs })
        assertEquals(0, s.pending)
    }

    @Test
    fun segmentsBeforeTheFirstCompositionAreSkipped() {
        val stray = SupFixtures.segment(10, SupFixtures.WDS, SupFixtures.wds) + SupFixtures.segment(10, SupFixtures.END, ByteArray(0))
        val sets = SupSplitter().push(stray + SupFixtures.stream)
        assertEquals(listOf(1_000_000L, 3_000_000L), sets.map { it.ptsUs })
    }

    @Test
    fun aStreamThatIsNotPgsFails() {
        val e = assertThrows(SupFormatException::class.java) { SupSplitter().push("WEBVTT\n\n00:00.000 --> 00:01.000\nx\n".toByteArray()) }
        assertTrue(e.message!!.contains("byte 0"))
    }

    @Test
    fun ptsTicksToMicroseconds() {
        assertEquals(0L, SupSplitter.ptsToUs(0))
        assertEquals(1_000_000L, SupSplitter.ptsToUs(90_000))
        // The largest 32-bit PTS (13 h 15 min) does not overflow.
        assertEquals(47_721_858_833L, SupSplitter.ptsToUs(0xFFFF_FFFFL))
    }

    private val vtt = "WEBVTT\n\n" +
        "1\n00:00:01.000 --> 00:00:02.000\nPrima\n\n" +
        "2\n00:00:03.000 --> 00:00:04.000\nSeconda riga è qui\ncon due righe\n\n" +
        "00:00:05.000 --> 00:00:06.000\nTerza\n"

    private fun chunked(text: String, chunk: Int, crlf: Boolean = false): List<String> {
        val bytes = (if (crlf) text.replace("\n", "\r\n") else text).toByteArray(Charsets.UTF_8)
        val c = VttChunker()
        val docs = ArrayList<String>()
        var at = 0
        while (at < bytes.size) {
            val n = minOf(chunk, bytes.size - at)
            c.push(bytes, at, n)?.let { docs += it }
            at += n
        }
        c.finish()?.let { docs += it }
        return docs
    }

    /** The cue blocks of the pieces, header dropped. */
    private fun blocks(docs: List<String>): List<String> = docs.flatMap { d ->
        assertTrue(d, d.startsWith("WEBVTT\n\n"))
        d.removePrefix("WEBVTT\n\n").split("\n\n").filter { it.isNotBlank() }
    }

    @Test
    fun aWebVttStreamIsCutAtBlankLinesIntoPiecesThatParseAlone() {
        val expected = listOf(
            "1\n00:00:01.000 --> 00:00:02.000\nPrima",
            "2\n00:00:03.000 --> 00:00:04.000\nSeconda riga è qui\ncon due righe",
            "00:00:05.000 --> 00:00:06.000\nTerza",
        )
        assertEquals(expected, blocks(chunked(vtt, vtt.length * 2)))
        // Any cut, including one inside "è" (two bytes in UTF-8), and CRLF line ends.
        for (chunk in listOf(1, 3, 17, 64)) {
            assertEquals("chunk $chunk", expected, blocks(chunked(vtt, chunk)))
            assertEquals("crlf chunk $chunk", expected, blocks(chunked(vtt, chunk, crlf = true)))
        }
    }

    @Test
    fun theHeaderBlocksGoInFrontOfEveryPiece() {
        val styled = "WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:0\n\nSTYLE\n::cue { color: yellow }\n\n" +
            "00:00:01.000 --> 00:00:02.000\nUno\n\n"
        val c = VttChunker()
        assertNull(c.push("WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:0\n\nSTYLE\n".toByteArray()))
        val doc = c.push(styled.toByteArray().copyOfRange("WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:0\n\nSTYLE\n".length, styled.length))
        assertEquals(styled, doc)
        val next = c.push("00:00:03.000 --> 00:00:04.000\nDue\n\n".toByteArray())
        assertEquals(styled.substringBefore("00:00:01") + "00:00:03.000 --> 00:00:04.000\nDue\n\n", next)
        assertNull(c.finish())
    }
}
