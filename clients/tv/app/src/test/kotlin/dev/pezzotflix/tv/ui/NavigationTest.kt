package dev.pezzotflix.tv.ui

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextInput
import dev.pezzotflix.tv.AppContainer
import dev.pezzotflix.tv.AppPrefs
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import java.util.concurrent.CopyOnWriteArrayList

/** The navigation screens against a fake server: server address → profile → Home → detail, and a 401 back to profiles. */
@RunWith(RobolectricTestRunner::class)
class NavigationTest {
    @get:Rule
    val compose = createComposeRule()

    private lateinit var server: MockWebServer
    private val requests = CopyOnWriteArrayList<String>()
    @Volatile private var homeStatus = 200

    @Before
    fun setUp() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.url.encodedPath
                requests += "${request.method} $path ${request.headers["Authorization"] ?: "-"}"
                return when ("${request.method} $path") {
                    "GET /video/api/v1/server" -> json(SERVER_INFO)
                    "GET /video/api/v1/profiles" -> json(PROFILES)
                    "POST /video/api/v1/profiles/p1/select" -> json(SELECTION)
                    "GET /video/api/v1/home" ->
                        if (homeStatus == 200) json(HOME) else json("""{"type":"about:blank","title":"Unauthorized","status":401,"code":"UNAUTHORIZED"}""", homeStatus)
                    "GET /video/api/v1/items/m1" -> json(DETAIL)
                    "GET /video/api/v1/events" -> json("""{"events":[],"nextCursor":"c1"}""")
                    else -> MockResponse.Builder().code(404).build()
                }
            }
        }
        server.start()
    }

    @After
    fun tearDown() {
        server.close()
    }

    private fun json(body: String, code: Int = 200) =
        MockResponse.Builder().code(code).setHeader("Content-Type", "application/json").body(body).build()

    private fun app() = RuntimeEnvironment.getApplication()

    private fun waitFor(matcher: SemanticsMatcher) {
        compose.waitUntil(WAIT_MS) { compose.onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty() }
    }

    private fun clickable(matcher: SemanticsMatcher): SemanticsNodeInteraction {
        waitFor(matcher and hasClickAction())
        return compose.onNode(matcher and hasClickAction())
    }

    @Test
    fun firstStartGoesFromServerToDetail() {
        val container = AppContainer(app())
        compose.setContent { PzfTheme { AppNav(container) } }

        waitFor(hasText(Txt.SERVER_TITLE))
        compose.onNodeWithTag("server-url").performTextInput("127.0.0.1:${server.port}")
        clickable(hasText(Txt.SERVER_CONNECT)).performSemanticsAction(SemanticsActions.OnClick)

        waitFor(hasText(Txt.PROFILES_TITLE))
        assertEquals("http://127.0.0.1:${server.port}/", AppPrefs(app()).serverUrl)
        clickable(hasTestTag("profile-Simone")).performSemanticsAction(SemanticsActions.OnClick)

        waitFor(hasText("Film"))
        assertEquals("tok-1", AppPrefs(app()).token())
        clickable(hasText("2001: Odissea nello spazio")).performSemanticsAction(SemanticsActions.OnClick)

        waitFor(hasText(Txt.itemResume(3_600_000)))
        waitFor(hasText(Txt.ITEM_FROM_START))
        // Bearer on the profile's calls only: GetServerInfo, ListProfiles and SelectProfile are public.
        assertEquals(listOf("GET /video/api/v1/server -", "GET /video/api/v1/profiles -", "POST /video/api/v1/profiles/p1/select -"), requests.take(3))
        compose.waitUntil(WAIT_MS) { requests.any { it == "GET /video/api/v1/items/m1 Bearer tok-1" } }
    }

    @Test
    fun invalidAddressStaysOnServerScreen() {
        val container = AppContainer(app())
        compose.setContent { PzfTheme { AppNav(container) } }
        waitFor(hasText(Txt.SERVER_TITLE))
        compose.onNodeWithTag("server-url").performTextInput("http://bad host")
        clickable(hasText(Txt.SERVER_CONNECT)).performSemanticsAction(SemanticsActions.OnClick)
        waitFor(hasText(Txt.SERVER_INVALID))
        assertNull(AppPrefs(app()).serverUrl)
    }

    @Test
    fun rememberedProfileOpensHomeAndA401GoesBackToProfiles() {
        val prefs = AppPrefs(app())
        prefs.serverUrl = server.url("/").toString()
        prefs.saveProfile("old-token", "p1", "Simone")
        homeStatus = 401
        val container = AppContainer(app())
        compose.setContent { PzfTheme { AppNav(container) } }

        waitFor(hasText(Txt.PROFILES_TITLE))
        assertNull(prefs.token())
        compose.waitUntil(WAIT_MS) { requests.contains("GET /video/api/v1/home Bearer old-token") }
    }

    companion object {
        private const val WAIT_MS = 10_000L

        private const val SERVER_INFO = """{"name":"Pezzotflix","version":"0.1.0","apiVersions":["v1"],
            "features":{"transcode":true,"directStream":true},"ingest":{"running":false,"queued":0,"needsReview":0},"providers":[]}"""
        private const val PROFILE = """{"id":"p1","name":"Simone","prefs":{"audioLanguages":["ita"],"subtitleLanguages":["ita"],"subtitleMode":"forced"}}"""
        private const val PROFILES = """{"profiles":[$PROFILE]}"""
        private const val SELECTION = """{"profileToken":"tok-1","profile":$PROFILE}"""
        private const val MOVIE = """{"id":"m1","kind":"movie","title":"2001: Odissea nello spazio","badges":["4K"],"available":true,
            "provisional":false,"year":1968,"state":{"watched":false,"progressPercent":40.0,"inWatchlist":false,"resumePositionMs":3600000}}"""
        private const val HOME = """{"rows":[{"id":"movies","title":"Film","items":[$MOVIE],"nextCursor":null}]}"""
        private const val DETAIL = """{"id":"m1","kind":"movie","title":"2001: Odissea nello spazio","badges":["4K"],"available":true,
            "provisional":false,"year":1968,"durationMs":8940000,"genres":[],"credits":[],"children":[],"extras":[],"versions":[],
            "overview":"Un monolito.","state":{"watched":false,"progressPercent":40.0,"inWatchlist":false,"resumePositionMs":3600000}}"""
    }
}
