package dev.pezzotflix.tv.player.subtitles

import java.io.ByteArrayOutputStream

/**
 * Synthetic PGS built in the test (no media in the repo): a 2x2 bitmap of palette entry 1 at (10, 20) on a
 * 1920x1080 plane, and the empty display set that clears it.
 */
object SupFixtures {
    const val PDS = 0x14
    const val ODS = 0x15
    const val PCS = 0x16
    const val WDS = 0x17
    const val END = 0x80

    private fun bytes(write: (ByteArrayOutputStream) -> Unit): ByteArray = ByteArrayOutputStream().also(write).toByteArray()

    private fun u16(out: ByteArrayOutputStream, v: Int) {
        out.write(v ushr 8 and 0xFF)
        out.write(v and 0xFF)
    }

    private fun u24(out: ByteArrayOutputStream, v: Int) {
        out.write(v ushr 16 and 0xFF)
        u16(out, v and 0xFFFF)
    }

    private fun u32(out: ByteArrayOutputStream, v: Long) {
        u16(out, (v ushr 16 and 0xFFFF).toInt())
        u16(out, (v and 0xFFFF).toInt())
    }

    /** A .sup segment: "PG", PTS, DTS (90 kHz), type, size, payload. */
    fun segment(pts: Long, type: Int, payload: ByteArray): ByteArray = bytes {
        it.write('P'.code)
        it.write('G'.code)
        u32(it, pts)
        u32(it, 0)
        it.write(type)
        u16(it, payload.size)
        it.write(payload)
    }

    /** Presentation composition: 1920x1080, epoch start, with one object at (10, 20) or none (clears). */
    fun pcs(objects: Int): ByteArray = bytes {
        u16(it, 1920)
        u16(it, 1080)
        it.write(0x10)
        u16(it, 0)
        it.write(0x80)
        it.write(0)
        it.write(0)
        it.write(objects)
        if (objects > 0) {
            u16(it, 0)
            it.write(0)
            it.write(0)
            u16(it, 10)
            u16(it, 20)
        }
    }

    val wds: ByteArray = bytes {
        it.write(1)
        it.write(0)
        u16(it, 10)
        u16(it, 20)
        u16(it, 2)
        u16(it, 2)
    }

    /** Palette entry 1: opaque red (Y, Cr, Cb, A). */
    val pds: ByteArray = bytes {
        it.write(0)
        it.write(0)
        it.write(1)
        it.write(81)
        it.write(240)
        it.write(90)
        it.write(255)
    }

    /** A 2x2 object, run-length coded: two pixels of entry 1, end of line, twice. */
    val ods: ByteArray = bytes {
        val rle = byteArrayOf(1, 1, 0, 0, 1, 1, 0, 0)
        u16(it, 0)
        it.write(0)
        it.write(0xC0)
        u24(it, rle.size + 4)
        u16(it, 2)
        u16(it, 2)
        it.write(rle)
    }

    /** The segments of one display set at [pts] (90 kHz): the bitmap, or the empty set that clears the screen. */
    fun displaySet(pts: Long, shows: Boolean): ByteArray = bytes {
        if (shows) {
            it.write(segment(pts, PCS, pcs(1)))
            it.write(segment(pts, WDS, wds))
            it.write(segment(pts, PDS, pds))
            it.write(segment(pts, ODS, ods))
        } else {
            it.write(segment(pts, PCS, pcs(0)))
            it.write(segment(pts, WDS, wds))
        }
        it.write(segment(pts, END, ByteArray(0)))
    }

    /** Shows at 1 s, clears at 3 s. */
    val stream: ByteArray = displaySet(90_000, shows = true) + displaySet(270_000, shows = false)
}
