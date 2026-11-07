// S5 throwaway probe: shared helpers (logging, settings, small JSON utils).
package dev.pezzotflix.s5probe

import android.content.Context
import android.os.SystemClock
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** Every measurement goes to logcat with this fixed tag, one JSON object per line. */
object L {
    const val TAG = "PZF_S5"

    fun ev(event: String, vararg kv: Pair<String, Any?>) {
        val o = JSONObject()
        o.put("ev", event)
        o.put("t", SystemClock.elapsedRealtime())
        for ((k, v) in kv) o.put(k, v ?: JSONObject.NULL)
        line(o.toString())
    }

    fun obj(event: String, src: JSONObject) {
        val o = JSONObject(src.toString())
        o.put("ev", event)
        o.put("t", SystemClock.elapsedRealtime())
        line(o.toString())
    }

    /** logcat truncates around 4 KB: long payloads are split into numbered chunks. */
    private fun line(s: String) {
        if (s.length <= 3500) {
            Log.i(TAG, s)
            return
        }
        val id = SystemClock.elapsedRealtime() % 100000
        val n = (s.length + 3499) / 3500
        for (i in 0 until n) Log.i(TAG, "#chunk $id ${i + 1}/$n " + s.substring(i * 3500, minOf(s.length, (i + 1) * 3500)))
    }

    /** Also written to the app's external files dir, readable with adb pull. */
    fun file(ctx: Context, name: String, content: String) {
        ctx.getExternalFilesDir(null)?.let { File(it, name).writeText(content) }
    }
}

object Prefs {
    private const val NAME = "s5"
    const val DEFAULT_SERVER = "http://192.168.1.5:8080"
    const val DEFAULT_DIRECT = "http://192.168.1.5:18381"

    fun get(ctx: Context, key: String, def: String): String =
        ctx.getSharedPreferences(NAME, Context.MODE_PRIVATE).getString(key, def) ?: def

    fun put(ctx: Context, key: String, value: String) {
        ctx.getSharedPreferences(NAME, Context.MODE_PRIVATE).edit().putString(key, value).apply()
    }

    fun bool(ctx: Context, key: String, def: Boolean): Boolean =
        ctx.getSharedPreferences(NAME, Context.MODE_PRIVATE).getBoolean(key, def)

    fun putBool(ctx: Context, key: String, value: Boolean) {
        ctx.getSharedPreferences(NAME, Context.MODE_PRIVATE).edit().putBoolean(key, value).apply()
    }
}

fun JSONArray.objects(): List<JSONObject> = (0 until length()).map { getJSONObject(it) }

fun fmtMs(ms: Long): String {
    if (ms < 0) return "--:--"
    val s = ms / 1000
    return if (s >= 3600) "%d:%02d:%02d".format(s / 3600, (s / 60) % 60, s % 60) else "%02d:%02d".format(s / 60, s % 60)
}

/** android.media.AudioFormat / Media3 C.ENCODING_* names. */
fun encodingName(e: Int): String = when (e) {
    1 -> "DEFAULT"
    2 -> "PCM_16BIT"
    3 -> "PCM_8BIT"
    4 -> "PCM_FLOAT"
    5 -> "AC3"
    6 -> "E_AC3"
    7 -> "DTS"
    8 -> "DTS_HD"
    9 -> "MP3"
    10 -> "AAC_LC"
    13 -> "IEC61937"
    14 -> "DOLBY_TRUEHD"
    17 -> "AC4"
    18 -> "E_AC3_JOC"
    19 -> "DOLBY_MAT"
    20 -> "OPUS"
    21 -> "PCM_24BIT_PACKED"
    22 -> "PCM_32BIT"
    27 -> "DTS_UHD_P1"
    30 -> "DTS_UHD_P2"
    0x20000000 -> "PCM_24BIT"
    0x30000000 -> "PCM_32BIT"
    else -> "ENC_$e"
}

fun isPcm(e: Int): Boolean = e in setOf(2, 3, 4, 21, 22, 0x10000000, 0x20000000, 0x30000000, 0x50000000, 0x60000000)
