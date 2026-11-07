package dev.pezzotflix.tv.player.caps

import dev.pezzotflix.api.models.ClientCapabilities
import dev.pezzotflix.tv.api.ApiJson
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

/** Capabilities of the living-room TV from its S5 snapshot (doc 05 §8.9.1, doc 07 §4). */
class CapabilityMapperTest {
    private val s5Dir = File(System.getProperty("pzf.s5Dir") ?: error("pzf.s5Dir is not set: run the tests with Gradle"))

    private fun read(name: String): JsonObject = Json.parseToJsonElement(File(s5Dir, name).readText()).jsonObject

    /** raw-caps.json (what the S5 probe read on the TV) as the facts the platform reader produces. */
    private fun factsFromSnapshot(raw: JsonObject): DeviceFacts {
        val build = raw.getValue("build").jsonObject
        val codecs = raw.getValue("codecs").jsonArray.map { it.jsonObject }
        fun JsonObject.s(k: String) = getValue(k).jsonPrimitive.content
        fun JsonObject.d(k: String) = (this[k] as? JsonPrimitive)?.doubleOrNull
        val video = codecs.filter { it.s("type").startsWith("video/") }.map { c ->
            VideoDecoder(
                name = c.s("name"),
                mimeType = c.s("type"),
                hardware = (c["hw"] as? JsonPrimitive)?.booleanOrNull ?: true,
                alias = (c["alias"] as? JsonPrimitive)?.booleanOrNull ?: false,
                profiles = (c["profileLevels"] as? JsonArray)?.map { it.jsonPrimitive.content.substringBefore("@") }?.distinct().orEmpty(),
                maxWidth = c["maxW"]?.jsonPrimitive?.int ?: 0,
                maxHeight = c["maxH"]?.jsonPrimitive?.int ?: 0,
                uhdMaxFps = c.d("uhdMaxFps"),
                fhdMaxFps = c.d("fhdMaxFps"),
            )
        }
        val audioDecoders = codecs.filter { it.s("type").startsWith("audio/") }
            .groupBy { it.s("type") }
            .mapValues { (_, ds) -> ds.maxOf { it["maxChannels"]?.jsonPrimitive?.intOrNull ?: 0 } }
        val display = raw.getValue("display").jsonObject
        val audio = raw.getValue("audio").jsonObject
        val supports = audio.getValue("media3SupportsEncoding").jsonObject
        val direct = audio.getValue("directPlaybackSupported").jsonObject
        val encodings = mapOf("eac3" to "E_AC3", "ac3" to "AC3", "truehd" to "DOLBY_TRUEHD", "dtshd" to "DTS_HD", "dts" to "DTS")
        val passthrough = encodings.mapNotNull { (codec, name) ->
            if (supports[name]?.jsonPrimitive?.boolean != true) return@mapNotNull null
            val channels = direct[name]?.jsonArray?.maxOfOrNull { it.jsonPrimitive.int } ?: audio.getValue("media3MaxChannelCount").jsonPrimitive.int
            codec to channels
        }.toMap()
        return DeviceFacts(
            manufacturer = build.s("manufacturer"),
            model = build.s("model"),
            release = build.s("release"),
            sdk = build.getValue("sdk").jsonPrimitive.int,
            isTelevision = true,
            appVersion = "0.1.0",
            videoDecoders = video,
            audioDecoders = audioDecoders,
            displayHdrTypes = display.getValue("hdrTypes").jsonArray.map { HdrType.valueOf(it.jsonPrimitive.content) }.toSet(),
            displayIsHdr = display.getValue("isHdr").jsonPrimitive.boolean,
            passthrough = passthrough,
        )
    }

    /** Numbers compared by value (the spike wrote 256, the model encodes 256.0). */
    private fun normalize(e: JsonElement): JsonElement = when (e) {
        is JsonObject -> JsonObject(e.mapValues { normalize(it.value) })
        is JsonArray -> JsonArray(e.map(::normalize))
        is JsonPrimitive -> if (!e.isString && e.doubleOrNull != null) JsonPrimitive(e.doubleOrNull) else e
    }

    @Test
    fun theLivingRoomTvDeclaresWhatS5Measured() {
        val caps = CapabilityMapper.map(factsFromSnapshot(read("raw-caps.json")))
        val actual = normalize(ApiJson.encodeToJsonElement(ClientCapabilities.serializer(), caps)).jsonObject

        // The S5 expectation, with the deliberate differences of doc 05 §8.9.1: the product's device strings, and
        // subtitles limited to what the server plans for (srt, webvtt; pgs).
        val s5 = read("client-caps-noffmpeg.json")
        val expected = normalize(
            JsonObject(
                s5 + mapOf(
                    "device" to Json.parseToJsonElement("""{"class":"tv","model":"Haier Haier OLED TV AE; Android 11 (API 30)","app":"pezzotflix-tv 0.1.0"}"""),
                    "subtitles" to Json.parseToJsonElement("""{"text":["srt","webvtt"],"image":["pgs"],"ass":true}"""),
                ),
            ),
        ).jsonObject
        for (key in expected.keys + actual.keys) assertEquals(key, expected[key], actual[key])
    }

    @Test
    fun noGenericDolbyVisionAndHdrNeedsTheDisplay() {
        val facts = factsFromSnapshot(read("raw-caps.json"))
        assertEquals(listOf("HDR10", "HDR10+", "HLG", "DV4", "DV5", "DV8", "DV9", "DV10"), CapabilityMapper.map(facts).hdr)
        val sdr = facts.copy(displayHdrTypes = emptySet(), displayIsHdr = false)
        assertEquals(emptyList<String>(), CapabilityMapper.map(sdr).hdr)
        assertEquals(false, CapabilityMapper.map(sdr).displayHdr)
        val noDv = facts.copy(displayHdrTypes = setOf(HdrType.HDR10, HdrType.HLG))
        assertEquals(listOf("HDR10", "HLG"), CapabilityMapper.map(noDv).hdr)
    }

    @Test
    fun withoutPassthroughDolbyIsDecodedWithTheDecodersChannels() {
        val facts = factsFromSnapshot(read("raw-caps.json")).copy(passthrough = emptyMap())
        val audio = CapabilityMapper.map(facts).audio.associate { it.codec to (it.mode?.value to it.maxChannels) }
        assertEquals("decode" to 6L, audio["eac3"])
        assertEquals("decode" to 6L, audio["ac3"])
        assertEquals(null, audio["truehd"])
        assertEquals("decode" to 8L, audio["pcm"])
    }

    @Test
    fun anAvrWithLosslessPassthroughDeclaresIt() {
        val facts = factsFromSnapshot(read("raw-caps.json")).let { it.copy(passthrough = it.passthrough + mapOf("truehd" to 8, "dtshd" to 8, "dts" to 8)) }
        val audio = CapabilityMapper.map(facts).audio.associate { it.codec to (it.mode?.value to it.maxChannels) }
        assertEquals("passthrough" to 8L, audio["truehd"])
        assertEquals("passthrough" to 8L, audio["dtshd"])
        // DTS core carries 5.1 at most.
        assertEquals("passthrough" to 6L, audio["dts"])
    }

    @Test
    fun aFullHdOnlyDecoderGetsOneEntry() {
        val d = VideoDecoder("hw.avc", "video/avc", true, false, listOf("high"), 1920, 1088, null, 60.0)
        val facts = factsFromSnapshot(read("raw-caps.json")).copy(videoDecoders = listOf(d))
        val v = CapabilityMapper.map(facts).video.single()
        assertEquals(listOf("h264", "1920", "1088", "8", "60.0"), listOf(v.codec, "${v.maxWidth}", "${v.maxHeight}", "${v.maxBitDepth}", "${v.maxFrameRate}"))
    }

    @Test
    fun softwareDecodersOnlyWithTheEmulatorSwitch() {
        val sw = VideoDecoder("OMX.google.h264.decoder", "video/avc", false, false, listOf("high"), 4096, 2304, null, 30.0)
        val facts = factsFromSnapshot(read("raw-caps.json")).copy(videoDecoders = listOf(sw))
        assertEquals(emptyList<Any>(), CapabilityMapper.map(facts).video)
        assertEquals(listOf("h264"), CapabilityMapper.map(facts, softwareDecoders = true).video.map { it.codec })
    }

    @Test
    fun dolbyVisionProfileNamesFromTheirBitFlags() {
        assertEquals("dv(P5)", CodecProfiles.name("video/dolby-vision", 32))
        assertEquals("dv(P8)", CodecProfiles.name("video/dolby-vision", 256))
        assertEquals("main10HDR10", CodecProfiles.name("video/hevc", 4096))
        assertEquals("constrainedHigh", CodecProfiles.name("video/avc", 524288))
    }
}
