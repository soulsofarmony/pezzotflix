package dev.pezzotflix.tv.api

import dev.pezzotflix.api.models.ClientCapabilities
import dev.pezzotflix.api.models.ClientCapabilitiesAudioInner
import dev.pezzotflix.api.models.ClientCapabilitiesDevice
import dev.pezzotflix.api.models.ClientCapabilitiesSubtitles
import dev.pezzotflix.api.models.ClientCapabilitiesVideoInner
import dev.pezzotflix.api.models.DeliveryMode
import dev.pezzotflix.api.models.FallbackRequest
import dev.pezzotflix.api.models.ProgressReport
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import retrofit2.http.POST

class VideoApiTest {
    private lateinit var server: MockWebServer
    private lateinit var api: VideoApi
    private var token: String? = "tok-1"
    private var unauthorized = 0

    private val tokens = object : TokenStore {
        override fun token(): String? = token
        override fun clear() {
            token = null
        }
    }

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        api = apiFor(server)
    }

    @After
    fun tearDown() {
        server.close()
    }

    private fun apiFor(s: MockWebServer): VideoApi {
        val client = HttpClients.api(HttpClients.base(), AuthInterceptor(tokens) { unauthorized += 1 })
        return VideoApi(HttpClients.retrofit(s.url("/"), client))
    }

    private fun json(code: Int, body: String, vararg headers: Pair<String, String>): MockResponse {
        val b = MockResponse.Builder().code(code).body(body).setHeader("Content-Type", "application/json")
        headers.forEach { (k, v) -> b.setHeader(k, v) }
        return b.build()
    }

    private fun problem(code: Int, body: String, vararg headers: Pair<String, String>): MockResponse {
        val b = MockResponse.Builder().code(code).body(body).setHeader("Content-Type", "application/problem+json")
        headers.forEach { (k, v) -> b.setHeader(k, v) }
        return b.build()
    }

    private fun noContent(): MockResponse = MockResponse.Builder().code(204).build()

    private fun RecordedRequest.json(): JsonObject = Json.parseToJsonElement(body!!.utf8()).jsonObject

    private fun assertValid(schema: String, value: JsonElement) {
        val errors = Contract.errors(schema, value)
        assertTrue("$schema: $errors\n$value", errors.isEmpty())
    }

    // ------------------------------------------------------------- request bodies against the bundle schema

    @Test
    fun startPlaybackBodiesMatchTheSchemaAndKeepTheSubtitleTriState() = runBlocking {
        val cases = listOf(
            SubtitleChoice.Default to null,
            SubtitleChoice.Off to JsonNull,
            SubtitleChoice.Track("s3") to kotlinx.serialization.json.JsonPrimitive("s3"),
        )
        for ((choice, expected) in cases) {
            server.enqueue(json(201, SESSION))
            api.startPlayback(StartRequest(itemId = "item-1", capabilities = CAPS, fileId = "file-1", audioTrackId = "s4", subtitle = choice, startPositionMs = 3_600_000))
            val req = server.takeRequest()
            assertEquals("POST", req.method)
            assertEquals("/video/api/v1/playback/sessions", req.url.encodedPath)
            val body = req.json()
            assertValid("StartPlaybackRequest", body)
            if (expected == null) assertFalse("$choice: $body", "subtitleTrackId" in body) else assertEquals("$choice", expected, body["subtitleTrackId"])
            // No generated null defaults in the body (K1: the server rejects "app": null).
            assertFalse(body.toString().contains("null") && choice != SubtitleChoice.Off)
            assertEquals("Bearer tok-1", req.headers["Authorization"])
            assertEquals("it-IT", req.headers["Accept-Language"])
            assertTrue(req.headers["Content-Type"]!!.startsWith("application/json"))
        }
    }

    @Test
    fun changeTracksOffSendsAnExplicitNull() = runBlocking {
        server.enqueue(json(200, SESSION))
        api.changeTracks("sess-1", TrackChange(subtitle = SubtitleChoice.Off, positionMs = 1234))
        val req = server.takeRequest()
        assertEquals("/video/api/v1/playback/sessions/sess-1/tracks", req.url.encodedPath)
        val body = req.json()
        assertValid("ChangeTracksRequest", body)
        assertEquals("""{"positionMs":1234,"subtitleTrackId":null}""", body.toString())

        server.enqueue(json(200, SESSION))
        api.changeTracks("sess-1", TrackChange(audioTrackId = "s5", positionMs = 10))
        val audio = server.takeRequest().json()
        assertValid("ChangeTracksRequest", audio)
        assertEquals("""{"audioTrackId":"s5","positionMs":10}""", audio.toString())
    }

    @Test
    fun progressStopAndFailureBodiesMatchTheSchema() = runBlocking {
        server.enqueue(noContent())
        // Beyond Int: clientTs is int64 (the contract change of F3a).
        api.reportProgress("sess-1", ProgressReport(positionMs = 61_000, state = ProgressReport.State.playing, clientTs = 1_794_000_000_123))
        val progress = server.takeRequest()
        assertValid("ProgressReport", progress.json())
        assertEquals("""{"positionMs":61000,"state":"playing","clientTs":1794000000123}""", progress.json().toString())

        server.enqueue(noContent())
        api.stopPlayback("sess-1", 62_000)
        val stop = server.takeRequest()
        assertEquals("/video/api/v1/playback/sessions/sess-1/stop", stop.url.encodedPath)
        assertValid("StopRequest", stop.json())

        server.enqueue(json(200, SESSION))
        api.reportPlaybackFailure("sess-1", FallbackRequest(positionMs = 62_000, error = "DECODER_INIT_FAILED", suspect = FallbackRequest.Suspect.audio))
        val failure = server.takeRequest()
        assertValid("FallbackRequest", failure.json())
        assertEquals("audio", failure.json()["suspect"].toString().trim('"'))
    }

    @Test
    fun capabilitiesBodyMatchesTheSchema() {
        assertValid("ClientCapabilities", ApiJson.encodeToJsonElement(ClientCapabilities.serializer(), CAPS))
    }

    // ------------------------------------------------------------- headers and public operations

    @Test
    fun selectProfileIsAnEmptyPostWithoutContentTypeOrBearer() = runBlocking {
        server.enqueue(json(200, """{"profileToken":"tok-2","profile":{"id":"p1","name":"Simone","prefs":{"audioLanguages":["ita"],"subtitleLanguages":[],"subtitleMode":"forced"}}}"""))
        val sel = api.selectProfile("p1")
        assertEquals("tok-2", sel.profileToken)
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals(0L, req.bodySize)
        // S5: an empty POST with a form Content-Type gets 415.
        assertNull(req.headers["Content-Type"])
        assertNull(req.headers["Authorization"])
        assertEquals("it-IT", req.headers["Accept-Language"])
    }

    @Test
    fun bearerOnlyOnNonPublicOperations() = runBlocking {
        server.enqueue(json(200, """{"profiles":[]}"""))
        api.listProfiles()
        assertNull(server.takeRequest().headers["Authorization"])
        server.enqueue(json(200, """{"name":"pezzotflix","version":"1","apiVersions":["v1"],"features":{"transcode":true,"directStream":true},"ingest":{"running":false,"queued":0,"needsReview":0},"providers":[]}"""))
        api.serverInfo()
        assertNull(server.takeRequest().headers["Authorization"])
        server.enqueue(json(200, """{"rows":[]}"""))
        api.home()
        assertEquals("Bearer tok-1", server.takeRequest().headers["Authorization"])
    }

    @Test
    fun publicOperationsAreTheContractsUnsecuredOnes() {
        val fromBundle = Contract.operations.filter { it.public }.map { it.operationId }.toSet()
        assertEquals(fromBundle, PUBLIC_OPERATIONS)
    }

    @Test
    fun handWrittenBodiesApiMatchesTheContract() {
        for (m in PlaybackBodiesApi::class.java.declaredMethods) {
            val path = "/" + m.getAnnotation(POST::class.java).value
            val op = Contract.operations.singleOrNull { it.method == "POST" && it.path == path }
            assertEquals("operation for $path", m.name, op?.operationId)
        }
    }

    @Test
    fun unauthorizedClearsTheTokenOnlyForSecuredCalls() = runBlocking {
        server.enqueue(problem(401, """{"type":"about:blank","title":"Unauthorized","status":401,"code":"UNAUTHORIZED"}"""))
        val e = runCatching { api.home() }.exceptionOrNull() as ApiException
        assertEquals(401, e.status)
        assertEquals("UNAUTHORIZED", e.code)
        assertNull(token)
        assertEquals(1, unauthorized)

        token = "tok-3"
        server.enqueue(problem(401, """{"type":"about:blank","title":"x","status":401,"code":"UNAUTHORIZED"}"""))
        runCatching { api.listProfiles() }
        assertEquals("tok-3", token)
        assertEquals(1, unauthorized)
    }

    // ------------------------------------------------------------- problems

    @Test
    fun problemsMapToApiExceptions() = runBlocking {
        server.enqueue(problem(410, """{"type":"about:blank","title":"Gone","status":410,"code":"SESSION_EXPIRED","reason":"terminated"}"""))
        val gone = expectFailure { api.reportProgress("s", ProgressReport(0, ProgressReport.State.paused, 1)) }
        assertEquals(410, gone.status)
        assertEquals("terminated", gone.reason)
        assertTrue(gone.isClosed)

        server.enqueue(problem(503, """{"type":"about:blank","title":"x","status":503,"code":"STREAM_PREPARING"}""", "Retry-After" to "3"))
        val preparing = expectFailure { api.startPlayback(StartRequest("i", CAPS)) }
        assertEquals(3000L, preparing.retryAfterMs)
        assertTrue(preparing.isRetryLater)

        server.enqueue(problem(503, """{"type":"about:blank","title":"x","status":503,"code":"MEDIA_UNAVAILABLE","sessionClosed":true}"""))
        val unreachable = expectFailure { api.reportPlaybackFailure("s", FallbackRequest(0, "STREAM_FAILED", FallbackRequest.Suspect.unknown)) }
        assertTrue(unreachable.sessionClosed)
        assertFalse(unreachable.isRetryLater)

        server.enqueue(problem(409, """{"type":"about:blank","title":"x","status":409,"code":"SESSION_LIMIT_REACHED","activeSessions":[{"sessionId":"a","profileId":"p","profileName":"Ospite","itemId":"i","itemTitle":"Alien","mode":"direct_play","startedAt":1794000000000}]}"""))
        val limit = expectFailure { api.startPlayback(StartRequest("i", CAPS)) }
        assertEquals("SESSION_LIMIT_REACHED", limit.code)
        assertEquals("Alien", limit.activeSessions.single().itemTitle)

        server.enqueue(problem(422, """{"type":"about:blank","title":"x","status":422,"code":"NO_COMPATIBLE_PLAN","detail":"Nessun piano","sessionClosed":true}"""))
        val refused = expectFailure { api.changeTracks("s", TrackChange(audioTrackId = "s5")) }
        assertTrue(refused.isClosedRefusal)

        server.enqueue(MockResponse.Builder().code(502).body("<html>Bad gateway</html>").setHeader("Content-Type", "text/html").build())
        val gateway = expectFailure { api.home() }
        assertEquals(502, gateway.status)
        assertEquals("UNEXPECTED", gateway.code)

        server.enqueue(problem(410, """{"type":"about:blank","title":"Gone","status":410,"code":"CURSOR_EXPIRED"}"""))
        assertEquals("CURSOR_EXPIRED", expectFailure { api.listEvents("c", 100) }.code)
    }

    @Test
    fun noAnswerIsANetworkError() = runBlocking {
        val dead = MockWebServer()
        dead.start()
        val deadApi = apiFor(dead)
        dead.close()
        val e = expectFailure { deadApi.home() }
        assertEquals(0, e.status)
        assertEquals("NETWORK", e.code)
    }

    @Test
    fun retryAfterAcceptsSecondsAndHttpDates() {
        assertEquals(2000L, ApiException.parseRetryAfter("2"))
        assertEquals(5000L, ApiException.parseRetryAfter("Wed, 21 Oct 2015 07:28:05 GMT", nowMs = 1445412480000))
        assertNull(ApiException.parseRetryAfter("soon"))
        assertNull(ApiException.parseRetryAfter(null))
    }

    // ------------------------------------------------------------- responses

    @Test
    fun sessionDecodesAndToleratesUnknownValues() = runBlocking {
        assertValid("PlaybackSession", Json.parseToJsonElement(SESSION))
        server.enqueue(json(201, SESSION))
        val s = api.startPlayback(StartRequest("i", CAPS))
        assertEquals(DeliveryMode.direct_play, s.mode)
        assertEquals("/video/media/s/tok_abcdefghijklmnop/file", s.stream.url)
        assertEquals(10_000L, s.heartbeatIntervalMs)
        assertEquals(1_794_000_000_000L, s.expiresAt)

        server.enqueue(json(201, SESSION.replace("\"direct_play\"", "\"future_mode\"").replace("\"embedded\"", "\"teleported\"")))
        val future = api.startPlayback(StartRequest("i", CAPS))
        assertEquals(DeliveryMode.unknown_default_open_api, future.mode)
    }

    @Test
    fun eventsDecodeIntoAppEvents() = runBlocking {
        server.enqueue(
            json(
                200,
                """{"events":[
                {"seq":7,"type":"playback.session_terminated","at":1794000000000,"payload":{"sessionId":"s1","profileId":"p","itemId":"i","reason":"terminated"}},
                {"seq":8,"type":"library.item_removed","at":1794000000001,"payload":{"itemId":"i","kind":"movie","parentId":null,"replacedBy":"j"}},
                {"seq":9,"type":"playback.subtitle_ready","at":1794000000002,"payload":{"sessionId":"s1","trackId":"s6","availability":"complete"}},
                {"seq":10,"type":"something.new","at":1794000000003,"payload":{}}
                ],"nextCursor":"c10"}""",
            ),
        )
        val page = api.listEvents("c6", 100)
        val events = page.events.map(AppEvent::of)
        assertEquals(AppEvent.SessionTerminated(7, "s1", "terminated"), events[0])
        assertEquals(AppEvent.ItemRemoved(8, "i", "j"), events[1])
        assertEquals(AppEvent.SubtitleReady(9, "s1", "s6", "complete"), events[2])
        assertEquals(AppEvent.Other(10, "something.new"), events[3])
        val req = server.takeRequest()
        assertEquals("c6", req.url.queryParameter("cursor"))
        assertEquals("100", req.url.queryParameter("limit"))
    }

    private suspend fun expectFailure(block: suspend () -> Unit): ApiException {
        try {
            block()
        } catch (e: ApiException) {
            return e
        }
        fail("expected an ApiException")
        throw IllegalStateException()
    }

    companion object {
        val CAPS = ClientCapabilities(
            device = ClientCapabilitiesDevice(ClientCapabilitiesDevice.PropertyClass.tv, model = "Haier Haier OLED TV AE; Android 11 (API 30)", app = "pezzotflix-tv 0.1.0"),
            containers = listOf("mkv", "mp4", "webm"),
            protocols = listOf("progressive", "hls-fmp4"),
            video = listOf(ClientCapabilitiesVideoInner("hevc", listOf("main", "main10"), 4096, 2176, 10, 64.0)),
            audio = listOf(ClientCapabilitiesAudioInner("eac3", 8, ClientCapabilitiesAudioInner.Mode.passthrough)),
            subtitles = ClientCapabilitiesSubtitles(text = listOf("srt", "webvtt"), image = listOf("pgs"), ass = true),
            audioTrackSelection = true,
            hdr = listOf("HDR10", "HDR10+", "HLG", "DV5", "DV8"),
            displayHdr = true,
        )

        val SESSION = """
            {"sessionId":"01936f0e-7b2a-7c3d-9e4f-5a6b7c8d9e01","expiresAt":1794000000000,"heartbeatIntervalMs":10000,
             "itemId":"item-1","fileId":"file-1","mode":"direct_play","reasons":["Riproduzione diretta del file"],
             "stream":{"url":"/video/media/s/tok_abcdefghijklmnop/file","protocol":"progressive",
                       "mimeType":"video/x-matroska; codecs=\"hvc1.2.4.L153.B0, ac-3\"","startOffsetMs":0,"mediaTimestampOffsetMs":0},
             "tracks":{"audio":[{"id":"s4","type":"audio","index":4,"codec":"ac3","language":"ita","channels":6,"default":true,
                                 "selected":true,"switchWithoutRestart":false,"delivery":"embedded"}],
                       "subtitles":[{"id":"s3","type":"subtitle","index":3,"codec":"hdmv_pgs_subtitle","language":"ita",
                                     "subtitleKind":"image","selected":true,"switchWithoutRestart":true,"delivery":"embedded"}]},
             "resumePositionMs":0,"durationMs":5400000,"chapters":[],"futureField":{"x":1}}
        """.trimIndent()
    }
}
