package probe

import dev.pezzotflix.api.models.ClientCapabilities
import dev.pezzotflix.api.models.ClientCapabilitiesAudioInner
import dev.pezzotflix.api.models.ClientCapabilitiesDevice
import dev.pezzotflix.api.models.ClientCapabilitiesSubtitles
import dev.pezzotflix.api.models.ClientCapabilitiesVideoInner
import dev.pezzotflix.api.models.EventPage
import dev.pezzotflix.api.models.ItemPage
import dev.pezzotflix.api.models.MediaFileEntry
import dev.pezzotflix.api.models.PlaybackSession
import dev.pezzotflix.api.models.StartPlaybackRequest
import kotlinx.serialization.json.Json

// Throwaway probe for ADR 0008: does the generated Kotlin client decode/encode real contract payloads?

const val SESSION = """{"sessionId":"s1","expiresAt":1794067200000,"mode":"direct_play","reasons":["Riproduzione diretta"],
"stream":{"url":"/video/media/s/tok/file","protocol":"progressive","mediaTimestampOffsetMs":0,"bitrate":{"peakBps":128000000}},
"tracks":{"audio":[{"id":"a1","type":"audio","index":1,"selected":true,"switchWithoutRestart":false,"codec":"truehd","channels":8,"frameRate":null}],
"subtitles":[{"id":"s3","type":"subtitle","index":3,"selected":false,"switchWithoutRestart":true,"delivery":"embedded","url":null,"availability":"complete"}]},
"resumePositionMs":0,"durationMs":9000000,"chapters":[],"futureField":{"x":1}}"""

const val SESSION_SMALL_TS = """{"sessionId":"s1","expiresAt":1,"mode":"warp_play","reasons":[],
"stream":{"url":"u","protocol":"dash-cmaf"},"tracks":{"audio":[],"subtitles":[]},"resumePositionMs":0,"durationMs":1,"chapters":[]}"""

const val EVENTS = """{"events":[{"seq":7,"type":"playback.subtitle_ready","at":1794067200000,
"payload":{"sessionId":"s1","trackId":"s3","availability":"complete"}}],"nextCursor":"c8"}"""

const val EVENTS_SMALL_TS = """{"events":[{"seq":7,"type":"playback.subtitle_ready","at":5,
"payload":{"sessionId":"s1","trackId":"s3","availability":"complete"}}],"nextCursor":"c8"}"""

const val PAGE = """{"items":[],"nextCursor":null}"""

const val FILE = """{"fileId":"f1","rootId":"r1","rootName":"Film","relPath":"a.mkv","state":"missing","sizeBytes":64000000000,"missingSince":1794067200000,"items":[]}"""

fun attempt(label: String, block: () -> Any?) {
    try {
        val r = block()
        println("OK   $label -> ${r.toString().take(220)}")
    } catch (e: Throwable) {
        println("FAIL $label -> ${e::class.simpleName}: ${e.message?.lineSequence()?.first()?.take(200)}")
    }
}

fun caps() = ClientCapabilities(
    device = ClientCapabilitiesDevice(propertyClass = ClientCapabilitiesDevice.PropertyClass.tv, model = "Haier H65C95EUX"),
    containers = listOf("mkv", "mp4"),
    protocols = listOf("progressive", "hls-fmp4"),
    video = listOf(ClientCapabilitiesVideoInner(codec = "hevc", profiles = listOf("main10"), maxWidth = 3840, maxHeight = 2160)),
    audio = listOf(ClientCapabilitiesAudioInner(codec = "eac3", maxChannels = 8, mode = ClientCapabilitiesAudioInner.Mode.passthrough)),
    subtitles = ClientCapabilitiesSubtitles(text = listOf("srt", "webvtt"), image = listOf("pgs")),
    audioTrackSelection = true,
)

fun main() {
    val variants = listOf("generated-default" to generatedJson(), "fixed(explicitNulls=false)" to fixedJson())
    for ((name, json) in variants) {
        println("---- Json = $name")
        attempt("decode PlaybackSession (expiresAt ms epoch)") { json.decodeFromString<PlaybackSession>(SESSION) }
        attempt("decode PlaybackSession (small ts, unknown enums)") { json.decodeFromString<PlaybackSession>(SESSION_SMALL_TS).let { "${it.mode} ${it.stream.protocol}" } }
        attempt("decode EventPage (at ms epoch)") { json.decodeFromString<EventPage>(EVENTS) }
        attempt("decode EventPage (small at, payload)") { json.decodeFromString<EventPage>(EVENTS_SMALL_TS).events.first().payload }
        attempt("decode ItemPage nextCursor null") { json.decodeFromString<ItemPage>(PAGE) }
        attempt("decode MediaFileEntry sizeBytes 64e9") { json.decodeFromString<MediaFileEntry>(FILE) }
        attempt("encode StartPlaybackRequest") { json.encodeToString(StartPlaybackRequest.serializer(), StartPlaybackRequest(itemId = "i1", capabilities = caps())) }
    }
}

fun fixedJsonBase(module: kotlinx.serialization.modules.SerializersModule) = Json {
    serializersModule = module
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = false
    coerceInputValues = false
}
