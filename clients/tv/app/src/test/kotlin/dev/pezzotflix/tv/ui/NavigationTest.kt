package dev.pezzotflix.tv.ui

import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.test.performTextClearance
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
import org.robolectric.shadows.ShadowLooper
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

/**
 * The navigation screens against a fake server: server address → profile → Home → detail, a 401 back to profiles,
 * series → season → episode with a watched mark, search, the watchlist and an unreachable server.
 */
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
                    "GET /video/api/v1/search" -> json(if (request.url.queryParameter("q") == "dark") PAGE_SERIES else EMPTY_PAGE)
                    "GET /video/api/v1/items" ->
                        if (request.url.queryParameter("inWatchlist") == "true") json(PAGE_MOVIE) else MockResponse.Builder().code(400).build()
                    "GET /video/api/v1/items/s1" -> json(SERIES_DETAIL)
                    "GET /video/api/v1/items/s1/next-up" -> json("""{"item":$EP2}""")
                    "GET /video/api/v1/items/s1/children" -> json("""{"items":[$SEASON1],"nextCursor":null}""")
                    "GET /video/api/v1/items/se1" -> json(SEASON_DETAIL)
                    "GET /video/api/v1/items/se1/children" -> json("""{"items":[$EP1,$EP2],"nextCursor":null}""")
                    "GET /video/api/v1/items/e2" -> json(EP2_DETAIL)
                    "PUT /video/api/v1/items/e2/watched" -> MockResponse.Builder().code(204).build()
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

    /** Runs the main looper while waiting: answers resume on it, and waitUntil alone does not run it on Robolectric. */
    private fun waitForRequests(condition: (List<String>) -> Boolean) {
        compose.waitUntil(WAIT_MS) {
            ShadowLooper.idleMainLooper()
            condition(requests.toList())
        }
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

        waitFor(hasText("Continua a guardare"))
        assertEquals("tok-1", AppPrefs(app()).token())
        scrollTo("home-rows", hasText("Film"))
        clickable(hasText("2001: Odissea nello spazio")).performSemanticsAction(SemanticsActions.OnClick)

        waitFor(hasText(Txt.itemResume(3_600_000)))
        waitFor(hasText(Txt.ITEM_FROM_START))
        // Bearer on the profile's calls only: GetServerInfo, ListProfiles and SelectProfile are public.
        assertEquals(listOf("GET /video/api/v1/server -", "GET /video/api/v1/profiles -", "POST /video/api/v1/profiles/p1/select -"), requests.take(3))
        compose.waitUntil(WAIT_MS) { requests.any { it == "GET /video/api/v1/items/m1 Bearer tok-1" } }
    }

    private fun signedIn(): AppContainer {
        val prefs = AppPrefs(app())
        prefs.serverUrl = server.url("/").toString()
        prefs.saveProfile("tok-1", "p1", "Simone")
        return AppContainer(app())
    }

    /** Lazy lists compose what is on screen only: bring the node in first. */
    private fun scrollTo(list: String, matcher: SemanticsMatcher) {
        waitFor(hasTestTag(list))
        compose.onNodeWithTag(list).performScrollToNode(matcher)
    }

    /** Runs the main looper's clock too: the search waits 250 ms after the last key. */
    private fun waitWithClock(matcher: SemanticsMatcher) {
        compose.waitUntil(WAIT_MS) {
            ShadowLooper.idleMainLooper(100, TimeUnit.MILLISECONDS)
            compose.onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty()
        }
    }

    @Test
    fun seriesToSeasonToEpisodeAndAWatchedMark() {
        val container = signedIn()
        compose.setContent { PzfTheme { AppNav(container) } }

        // Every row the server composes renders: the episode in progress has a row of its own.
        waitFor(hasText("Continua a guardare"))
        scrollTo("home-rows", hasText("Serie"))
        clickable(hasText("Dark")).performSemanticsAction(SemanticsActions.OnClick)
        waitFor(hasText(Txt.playEpisode(1, 2)))
        scrollTo("item-detail", hasTestTag("season-1"))
        clickable(hasTestTag("season-1")).performSemanticsAction(SemanticsActions.OnClick)

        // The season opens on the episode in progress, with each episode's state.
        waitFor(hasText("2. Bugie"))
        waitFor(hasText("44 min · " + Txt.itemProgress(25)))
        scrollTo("item-detail", hasText("1. Segreti"))
        waitFor(hasText("51 min · " + Txt.ITEM_WATCHED))
        scrollTo("item-detail", hasTestTag("details-2"))
        clickable(hasTestTag("details-2")).performSemanticsAction(SemanticsActions.OnClick)

        waitFor(hasText(Txt.itemResume(660_000)))
        clickable(hasTestTag("watched")).performSemanticsAction(SemanticsActions.OnClick)
        waitForRequests { it.contains("PUT /video/api/v1/items/e2/watched Bearer tok-1") }
        // Done: the detail reads its state again.
        waitForRequests { r -> r.count { it.startsWith("GET /video/api/v1/items/e2 ") } >= 2 }
    }

    @Test
    @OptIn(ExperimentalTestApi::class)
    fun searchFindsATitleAndOpensIt() {
        val container = signedIn()
        compose.setContent { PzfTheme { AppNav(container) } }

        clickable(hasTestTag("search")).performSemanticsAction(SemanticsActions.OnClick)
        waitFor(hasText(Txt.SEARCH_HINT))
        compose.onNodeWithTag("search-field").performTextInput("zzz")
        waitWithClock(hasText(Txt.searchEmpty("zzz")))
        compose.onNodeWithTag("search-field").performTextClearance()
        compose.onNodeWithTag("search-field").performTextInput("dark")
        waitWithClock(hasText(Txt.searchResults(1)))
        // Keyboard closed with Back: Down from the field reaches the results.
        compose.onNodeWithTag("search-field").performKeyInput { pressKey(Key.DirectionDown) }
        clickable(hasText("Dark")).assertIsFocused()
        clickable(hasText("Dark")).performSemanticsAction(SemanticsActions.OnClick)
        waitFor(hasText(Txt.playEpisode(1, 2)))
    }

    @Test
    fun theWatchlistIsAPageOfItsOwn() {
        val container = signedIn()
        compose.setContent { PzfTheme { AppNav(container) } }
        clickable(hasTestTag("watchlist")).performSemanticsAction(SemanticsActions.OnClick)
        waitFor(hasText(Txt.WATCHLIST))
        clickable(hasText("2001: Odissea nello spazio")).performSemanticsAction(SemanticsActions.OnClick)
        waitFor(hasText(Txt.ITEM_WATCHLIST_ADD))
    }

    @Test
    fun anUnreachableServerOffersAnotherAddress() {
        val prefs = AppPrefs(app())
        // Nothing listens on port 1.
        prefs.serverUrl = "http://127.0.0.1:1/"
        prefs.saveProfile("tok-1", "p1", "Simone")
        val container = AppContainer(app())
        compose.setContent { PzfTheme { AppNav(container) } }
        waitFor(hasText(Txt.SERVER_UNREACHABLE_TITLE))
        clickable(hasText(Txt.SERVER_CHANGE)).performSemanticsAction(SemanticsActions.OnClick)
        waitFor(hasText(Txt.SERVER_TITLE))
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
        private const val SERIES = """{"id":"s1","kind":"series","title":"Dark","badges":[],"available":true,"provisional":false,"year":2017}"""
        private const val EP1 = """{"id":"e1","kind":"episode","title":"Segreti","badges":[],"available":true,"provisional":false,
            "seasonNumber":1,"episodeNumber":1,"seriesTitle":"Dark","durationMs":3060000,
            "state":{"watched":true,"progressPercent":100.0,"inWatchlist":false}}"""
        private const val EP2 = """{"id":"e2","kind":"episode","title":"Bugie","badges":[],"available":true,"provisional":false,
            "seasonNumber":1,"episodeNumber":2,"seriesTitle":"Dark","durationMs":2640000,
            "state":{"watched":false,"progressPercent":25.0,"inWatchlist":false,"resumePositionMs":660000}}"""
        private const val SEASON1 = """{"id":"se1","kind":"season","title":"Stagione 1","badges":[],"available":true,"provisional":false,
            "seasonNumber":1,"seriesTitle":"Dark"}"""
        private const val DETAIL_LISTS = """"genres":[],"credits":[],"children":[],"extras":[],"versions":[]"""
        private const val SERIES_DETAIL = """{"id":"s1","kind":"series","title":"Dark","badges":[],"available":true,"provisional":false,
            "year":2017,$DETAIL_LISTS,"overview":"Una grotta.","state":{"watched":false,"progressPercent":0.0,"inWatchlist":false}}"""
        private const val SEASON_DETAIL = """{"id":"se1","kind":"season","title":"Stagione 1","badges":[],"available":true,
            "provisional":false,"seasonNumber":1,"seriesTitle":"Dark",$DETAIL_LISTS}"""
        private const val EP2_DETAIL = """{"id":"e2","kind":"episode","title":"Bugie","badges":[],"available":true,"provisional":false,
            "seasonNumber":1,"episodeNumber":2,"seriesTitle":"Dark","durationMs":2640000,$DETAIL_LISTS,
            "state":{"watched":false,"progressPercent":25.0,"inWatchlist":false,"resumePositionMs":660000}}"""
        private const val PAGE_SERIES = """{"items":[$SERIES],"nextCursor":null}"""
        private const val PAGE_MOVIE = """{"items":[$MOVIE],"nextCursor":null}"""
        private const val EMPTY_PAGE = """{"items":[],"nextCursor":null}"""
        private const val HOME = """{"rows":[
            {"id":"continue_watching","title":"Continua a guardare","items":[$EP2],"nextCursor":null},
            {"id":"movies","title":"Film","items":[$MOVIE],"nextCursor":null},
            {"id":"series","title":"Serie","items":[$SERIES],"nextCursor":null}]}"""
        private const val DETAIL = """{"id":"m1","kind":"movie","title":"2001: Odissea nello spazio","badges":["4K"],"available":true,
            "provisional":false,"year":1968,"durationMs":8940000,"genres":[],"credits":[],"children":[],"extras":[],"versions":[],
            "overview":"Un monolito.","state":{"watched":false,"progressPercent":40.0,"inWatchlist":false,"resumePositionMs":3600000}}"""
    }
}
