package dev.pezzotflix.tv.api

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ServerUrlTest {
    @Test
    fun normalizesWhatIsTypedOnTheTv() {
        val cases = listOf(
            "192.168.1.12:18480" to "http://192.168.1.12:18480/",
            " http://192.168.1.12:8080 " to "http://192.168.1.12:8080/",
            "http://nas.local:8080/" to "http://nas.local:8080/",
            "https://media.example.org/pzf" to "https://media.example.org/pzf/",
            "HTTP://Server:80" to "http://server/",
        )
        for ((input, expected) in cases) assertEquals(input, expected, ServerUrl.normalize(input)?.toString())
    }

    @Test
    fun rejectsWhatIsNotAnHttpAddress() {
        for (input in listOf("", "   ", "ftp://x", "http://", "192.168.1.12 8080", "http://x/?a=1", "http://x/#f")) {
            assertNull(input, ServerUrl.normalize(input))
        }
    }

    @Test
    fun resolvesLocatorsOnTheBase() {
        val base = ServerUrl.normalize("192.168.1.12:18480")!!
        assertEquals("http://192.168.1.12:18480/video/media/s/tok/file", ServerUrl.resolve(base, "/video/media/s/tok/file").toString())
    }
}
