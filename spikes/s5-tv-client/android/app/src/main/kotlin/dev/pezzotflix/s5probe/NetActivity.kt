// S5 throwaway probe: sustained HTTP throughput server → TV, measured by the app itself.
// Extras: url (a large file; restarted from 0 at EOF), seconds (default 60), label.
package dev.pezzotflix.s5probe

import android.app.Activity
import android.os.Bundle
import android.os.SystemClock
import android.view.WindowManager
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

class NetActivity : Activity() {
    @Volatile private var stop = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val tv = TextView(this).apply { textSize = 22f; setPadding(60, 60, 60, 60) }
        setContentView(tv)
        val url = intent.getStringExtra("url") ?: run { finish(); return }
        val seconds = intent.getIntExtra("seconds", 60)
        val label = intent.getStringExtra("label") ?: ""
        tv.text = "Test di rete: $url\n$seconds s"
        L.ev("netStart", "url" to url, "seconds" to seconds, "label" to label)
        thread {
            val perSec = LongArray(seconds)
            val buf = ByteArray(256 * 1024)
            val t0 = SystemClock.elapsedRealtime()
            var total = 0L
            var restarts = 0
            var err: String? = null
            loop@ while (!stop) {
                try {
                    val c = URL(url).openConnection() as HttpURLConnection
                    c.connectTimeout = 5000; c.readTimeout = 10000
                    c.setRequestProperty("Range", "bytes=0-")
                    c.inputStream.use { ins ->
                        while (!stop) {
                            val n = ins.read(buf)
                            if (n < 0) break
                            val sec = ((SystemClock.elapsedRealtime() - t0) / 1000).toInt()
                            if (sec >= seconds) break@loop
                            perSec[sec] += n.toLong(); total += n
                        }
                    }
                    c.disconnect(); restarts++
                } catch (e: Exception) {
                    err = e.toString(); L.ev("netError", "e" to err)
                    if ((SystemClock.elapsedRealtime() - t0) / 1000 >= seconds) break
                    SystemClock.sleep(500)
                }
                val sec = ((SystemClock.elapsedRealtime() - t0) / 1000).toInt()
                runOnUiThread { tv.text = "Test di rete in corso ($sec/$seconds s)\n${"%.1f".format(total * 8.0 / 1e6 / maxOf(1, sec))} Mb/s medi" }
            }
            val mbps = perSec.map { it * 8.0 / 1e6 }
            val sorted = mbps.sorted()
            val w5 = (0..mbps.size - 5).map { i -> mbps.subList(i, i + 5).average() }
            val o = JSONObject().put("label", label).put("seconds", seconds).put("totalBytes", total).put("avgMbps", total * 8.0 / 1e6 / seconds)
                .put("minMbps", sorted.first()).put("p5Mbps", sorted[(sorted.size * 0.05).toInt()]).put("medianMbps", sorted[sorted.size / 2])
                .put("maxMbps", sorted.last()).put("worst5sMbps", w5.minOrNull()).put("best5sMbps", w5.maxOrNull())
                .put("restarts", restarts).put("error", err).put("perSecMbps", JSONArray(mbps.map { Math.round(it * 10) / 10.0 }))
            L.obj("netSummary", o)
            runOnUiThread {
                tv.text = "Test di rete finito\nmedia ${"%.1f".format(o.getDouble("avgMbps"))} Mb/s, mediana ${"%.1f".format(o.getDouble("medianMbps"))}, " +
                    "minimo 1 s ${"%.1f".format(o.getDouble("minMbps"))}, peggiori 5 s ${"%.1f".format(o.optDouble("worst5sMbps"))} Mb/s"
            }
            if (intent.getBooleanExtra("auto", false)) runOnUiThread { finish() }
        }
    }

    override fun onDestroy() { stop = true; super.onDestroy() }
}
