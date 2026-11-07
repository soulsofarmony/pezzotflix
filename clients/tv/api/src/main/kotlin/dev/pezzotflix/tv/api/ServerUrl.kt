package dev.pezzotflix.tv.api

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * The server address typed by hand on the TV (doc 05 §8.8), e.g. "192.168.1.10:8080" or "http://nas.local:8080/".
 * The app never builds media URLs: control-plane locators are resolved on this base (doc 03 P1, P9).
 */
object ServerUrl {
    /** A base URL ending with "/", or null when the text is not an http(s) address. */
    fun normalize(input: String): HttpUrl? {
        val text = input.trim()
        if (text.isEmpty() || text.any { it.isWhitespace() }) return null
        val withScheme = if (text.contains("://")) text else "http://$text"
        val url = withScheme.toHttpUrlOrNull() ?: return null
        if (url.host.isEmpty() || url.query != null || url.fragment != null) return null
        val path = if (url.encodedPath.endsWith("/")) url.encodedPath else url.encodedPath + "/"
        return url.newBuilder().encodedPath(path).build()
    }

    /** Resolves a locator returned by the server ("/video/media/s/<token>/file") against the base. */
    fun resolve(base: HttpUrl, locator: String): HttpUrl? = base.resolve(locator)
}
