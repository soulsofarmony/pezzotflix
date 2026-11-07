// S5 throwaway probe: hand-written calls to the Pezzotflix Video Service (contract in services/video/contract).
package dev.pezzotflix.s5probe

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

object Api {
    data class Resp(val code: Int, val body: String) {
        fun json(): JSONObject = JSONObject(body.ifBlank { "{}" })
    }

    private fun call(method: String, base: String, token: String?, path: String, body: JSONObject?): Resp {
        val c = URL(base.trimEnd('/') + path).openConnection() as HttpURLConnection
        c.requestMethod = method
        c.connectTimeout = 5000; c.readTimeout = 20000
        c.setRequestProperty("Accept", "application/json")
        token?.let { c.setRequestProperty("Authorization", "Bearer $it") }
        if (body != null) {
            c.doOutput = true
            c.setRequestProperty("Content-Type", "application/json")
            c.outputStream.use { it.write(body.toString().toByteArray()) }
        }
        val code = c.responseCode
        val text = (if (code >= 400) c.errorStream else c.inputStream)?.bufferedReader()?.use { it.readText() } ?: ""
        c.disconnect()
        return Resp(code, text)
    }

    fun get(base: String, token: String?, path: String) = call("GET", base, token, path, null)
    fun delete(base: String, token: String?, path: String): Resp =
        try { call("DELETE", base, token, path, null) } catch (e: Exception) { Resp(-1, e.toString()) }
    fun post(base: String, token: String?, path: String, body: JSONObject?): Resp =
        try { call("POST", base, token, path, body) } catch (e: Exception) { Resp(-1, e.toString()) }

    /** Selects the first profile, creating "TV" only when the server has none. Returns the profile token. */
    fun profileToken(base: String): String {
        var profiles = get(base, null, "/video/api/v1/profiles").json().getJSONArray("profiles")
        if (profiles.length() == 0) {
            post(base, null, "/video/api/v1/profiles", JSONObject().put("name", "TV"))
            profiles = get(base, null, "/video/api/v1/profiles").json().getJSONArray("profiles")
        }
        val id = profiles.getJSONObject(0).getString("id")
        // An empty POST from HttpURLConnection carries a form Content-Type, which the server refuses (415): send {}.
        return post(base, null, "/video/api/v1/profiles/$id/select", JSONObject()).json().getString("profileToken")
    }
}
