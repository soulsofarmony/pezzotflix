// S5 throwaway probe: dumps the runtime capabilities (raw + ClientCapabilities) to the screen, logcat and files.
package dev.pezzotflix.s5probe

import android.app.Activity
import android.graphics.Typeface
import android.os.Bundle
import android.widget.ScrollView
import android.widget.TextView
import androidx.media3.common.util.UnstableApi

@UnstableApi
class CapsActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val tv = TextView(this).apply { typeface = Typeface.MONOSPACE; textSize = 11f; setPadding(40, 30, 40, 30); isFocusable = true }
        setContentView(ScrollView(this).apply { addView(tv) })
        val raw = Probe.collect(this)
        val ffOn = Prefs.bool(this, "ffmpeg", true) && raw.getJSONObject("ffmpeg").optBoolean("available")
        val caps = Probe.clientCapabilities(raw, ffOn)
        val capsNoFf = Probe.clientCapabilities(raw, false)
        L.obj("rawCaps", raw)
        L.obj("clientCaps", caps)
        L.file(this, "raw-caps.json", raw.toString(2))
        L.file(this, "client-caps.json", caps.toString(2))
        L.file(this, "client-caps-noffmpeg.json", capsNoFf.toString(2))
        tv.text = "ClientCapabilities (FFmpeg ${if (ffOn) "attivo" else "spento"}):\n" + caps.toString(2) + "\n\nDati grezzi:\n" + raw.toString(2)
        if (intent.getBooleanExtra("auto", false)) finish()
    }
}
