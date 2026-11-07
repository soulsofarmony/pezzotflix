// S5 throwaway probe: D-pad menu. Direct samples come from <direct server>/samples.json; the catalog comes
// from the Pezzotflix API (StartPlayback with the capabilities this device reports).
package dev.pezzotflix.s5probe

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.text.InputType
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.media3.common.MediaLibraryInfo
import androidx.media3.common.util.UnstableApi
import org.json.JSONArray
import org.json.JSONObject
import java.net.URL
import java.util.concurrent.Executors

@UnstableApi
class MainActivity : Activity() {
    private val io = Executors.newSingleThreadExecutor()
    private lateinit var list: LinearLayout
    private lateinit var status: TextView
    private lateinit var server: EditText
    private lateinit var direct: EditText
    private lateinit var ffmpeg: CheckBox
    private lateinit var tunnel: CheckBox

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(60, 40, 60, 40) }
        setContentView(ScrollView(this).apply { addView(col) })

        col.addView(TextView(this).apply {
            text = "Pezzotflix S5 — sonda per la TV\nMedia3 ${MediaLibraryInfo.VERSION}. Usa le frecce e OK. Nel player: ◀ ▶ salto, ▲ audio, ▼ sottotitoli, OK pausa, INDIETRO esce."
            textSize = 18f
        })
        val first = button(col, "Sample diretti (server di file)") { loadDirect() }
        button(col, "Catalogo Pezzotflix (server)") { loadCatalog() }
        button(col, "Capability del dispositivo") { startActivity(Intent(this, CapsActivity::class.java)) }
        button(col, "Test di rete (60 s)") {
            save()
            val u = direct.text.toString().trimEnd('/') + "/media/movies/Long%20Test%20(2024)/Long%20Test%20(2024)%20-%202160p.mkv"
            startActivity(Intent(this, NetActivity::class.java).putExtra("url", u).putExtra("seconds", 60).putExtra("label", "menu"))
        }
        status = TextView(this).apply { textSize = 16f; setTextColor(Color.YELLOW) }
        col.addView(status)
        list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        col.addView(list)

        col.addView(TextView(this).apply { text = "\nImpostazioni"; textSize = 18f })
        ffmpeg = CheckBox(this).apply { text = "Decoder FFmpeg software (TrueHD, e ciò che la TV non decodifica)"; isChecked = Prefs.bool(this@MainActivity, "ffmpeg", true) }
        tunnel = CheckBox(this).apply { text = "Tunneling (video e audio sincronizzati dal SoC)"; isChecked = Prefs.bool(this@MainActivity, "tunnel", false) }
        col.addView(ffmpeg); col.addView(tunnel)
        col.addView(TextView(this).apply { text = "Server Pezzotflix (http://IP:porta)" })
        server = edit(col, Prefs.get(this, "server", Prefs.DEFAULT_SERVER))
        col.addView(TextView(this).apply { text = "Server dei sample diretti (http://IP:porta)" })
        direct = edit(col, Prefs.get(this, "direct", Prefs.DEFAULT_DIRECT))
        first.requestFocus()
        // Scripted Q7 run over ADB: --es server URL --es autoItem "<title substring>" [--es ffmpeg on|off]
        // plays that catalog item through StartPlayback, with the player in scripted mode.
        intent.getStringExtra("server")?.let { server.setText(it) }
        intent.getStringExtra("ffmpeg")?.let { ffmpeg.isChecked = it == "on" }
        if (intent.getStringExtra("autoItem") != null) loadCatalog()
    }

    private fun button(parent: ViewGroup, label: String, onClick: () -> Unit): Button =
        Button(this).apply { text = label; isAllCaps = false; textSize = 17f; setOnClickListener { onClick() } }.also { parent.addView(it) }

    private fun edit(parent: ViewGroup, value: String): EditText =
        EditText(this).apply { setText(value); inputType = InputType.TYPE_TEXT_VARIATION_URI; isSingleLine = true }.also { parent.addView(it) }

    private fun save() {
        Prefs.put(this, "server", server.text.toString().trim())
        Prefs.put(this, "direct", direct.text.toString().trim())
        Prefs.putBool(this, "ffmpeg", ffmpeg.isChecked)
        Prefs.putBool(this, "tunnel", tunnel.isChecked)
    }

    private fun show(msg: String) = runOnUiThread { status.text = msg }

    // ------------------------------------------------------------------ direct samples

    private fun loadDirect() {
        save()
        val base = direct.text.toString().trimEnd('/')
        show("Carico $base/samples.json …")
        io.execute {
            try {
                val arr = JSONArray(URL("$base/samples.json").readText())
                runOnUiThread {
                    list.removeAllViews()
                    for (o in arr.objects()) {
                        val path = o.getString("path").split('/').joinToString("/") { Uri.encode(it) }
                        button(list, o.getString("title") + (o.optString("info").takeIf { it.isNotEmpty() }?.let { "  —  $it" } ?: "")) {
                            startActivity(Intent(this, PlayerActivity::class.java).putExtra("url", "$base/$path")
                                .putExtra("title", o.getString("title")).putExtra("info", o.optString("info")))
                        }
                    }
                    show("${arr.length()} sample. Server: $base")
                    list.getChildAt(0)?.requestFocus()
                }
            } catch (e: Exception) { show("Errore: $e\nIl server dei sample è avviato? (spikes/s5-tv-client/serve.sh)") }
        }
    }

    // ------------------------------------------------------------------ Pezzotflix catalog

    private fun loadCatalog() {
        save()
        val base = server.text.toString().trimEnd('/')
        show("Carico il catalogo da $base …")
        io.execute {
            try {
                val token = Api.profileToken(base)
                val items = mutableListOf<JSONObject>()
                for (kind in listOf("movie", "episode", "extra")) {
                    val r = Api.get(base, token, "/video/api/v1/items?kind=$kind&limit=100")
                    if (r.code == 200) items += r.json().getJSONArray("items").objects()
                }
                intent.getStringExtra("autoItem")?.let { want ->
                    items.firstOrNull { it.getString("title").contains(want, true) }?.let { play(base, token, it) } ?: show("autoItem non trovato: $want")
                }
                runOnUiThread {
                    list.removeAllViews()
                    for (it in items) {
                        val label = listOfNotNull(it.optString("seriesTitle").takeIf { s -> s.isNotEmpty() && s != "null" }, it.getString("title")).joinToString(" · ") +
                            "  [" + (0 until it.getJSONArray("badges").length()).joinToString(" ") { i -> it.getJSONArray("badges").getString(i) } + "]"
                        button(list, label) { play(base, token, it) }
                    }
                    show("${items.size} titoli da $base")
                    list.getChildAt(0)?.requestFocus()
                }
            } catch (e: Exception) { show("Errore: $e") }
        }
    }

    private fun play(base: String, token: String, item: JSONObject) {
        show("Avvio la sessione per ${item.getString("title")} …")
        io.execute {
            val raw = Probe.collect(this)
            val ffOn = ffmpeg.isChecked && raw.getJSONObject("ffmpeg").optBoolean("available")
            val caps = Probe.clientCapabilities(raw, ffOn)
            val req = JSONObject().put("itemId", item.getString("id")).put("capabilities", caps)
            var r = Api.post(base, token, "/video/api/v1/playback/sessions", req)
            if (r.code == 409) {
                // MVP: one session. Free the slot (a session left open by a previous run) and retry once.
                val sessions = Api.get(base, token, "/video/api/v1/playback/sessions").json().optJSONArray("sessions") ?: JSONArray()
                for (s in sessions.objects()) Api.delete(base, token, "/video/api/v1/playback/sessions/${s.getString("sessionId")}")
                r = Api.post(base, token, "/video/api/v1/playback/sessions", req)
            }
            L.ev("startPlayback", "item" to item.getString("title"), "code" to r.code, "body" to r.body.take(3000), "ffmpeg" to ffOn)
            if (r.code != 201) { show("StartPlayback ${r.code}: ${r.body.take(400)}"); return@execute }
            val s = r.json()
            val stream = s.getJSONObject("stream")
            val reasons = s.getJSONArray("reasons")
            val info = "Server: ${s.getString("mode")} (${stream.getString("protocol")}) — " + (0 until reasons.length()).joinToString("; ") { reasons.getString(it) }
            val i = Intent(this, PlayerActivity::class.java).putExtra("url", base + stream.getString("url")).putExtra("title", item.getString("title"))
                .putExtra("info", info).putExtra("api", base).putExtra("token", token).putExtra("session", s.getString("sessionId"))
                .putExtra("ffmpeg", if (ffOn) "on" else "off")
            if (stream.getString("protocol") == "hls-fmp4") i.putExtra("mime", "application/x-mpegURL")
            if (intent.getStringExtra("autoItem") != null) i.putExtra("auto", true).putExtra("volume", 0.05f).putExtra("playSec", 12)
            // Subtitle served apart (client_render .sup or sidecar WebVTT): sideload the selected one.
            val subs = s.getJSONObject("tracks").getJSONArray("subtitles").objects()
            subs.firstOrNull { it.optBoolean("selected") && it.optString("url").let { u -> u.isNotEmpty() && u != "null" } }?.let { t ->
                i.putExtra("subUrl", base + t.getString("url")).putExtra("subLang", t.optString("language", "ita"))
                    .putExtra("subMime", if (t.optString("delivery") == "client_render") "application/pgs" else "text/vtt")
            }
            runOnUiThread { show(info); startActivity(i) }
        }
    }

    override fun onDestroy() { io.shutdown(); super.onDestroy() }

    @Suppress("unused") private fun View.focus() = requestFocus()
}
