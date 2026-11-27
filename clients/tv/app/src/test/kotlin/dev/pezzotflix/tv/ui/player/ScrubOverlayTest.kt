package dev.pezzotflix.tv.ui.player

import android.graphics.Bitmap
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.dp
import dev.pezzotflix.api.models.Trickplay
import dev.pezzotflix.tv.ui.PzfTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The scrub overlay: preview and time at the target, inside the screen; only the time while a sheet loads. */
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w960dp-h540dp-land-mdpi")
class ScrubOverlayTest {
    @get:Rule
    val compose = createComposeRule()

    private val tp = Trickplay(10_000, 32, 18, 10, 10, 150, listOf("s0", "s1"))
    // Through android.graphics: Robolectric does not shadow the colour-space overload Compose's ImageBitmap() uses.
    private val sheet0 by lazy { Bitmap.createBitmap(320, 180, Bitmap.Config.RGB_565).asImageBitmap() }
    private val sheet1 by lazy { Bitmap.createBitmap(320, 90, Bitmap.Config.RGB_565).asImageBitmap() }

    private var target by mutableStateOf(600_000L)
    private var trickplay by mutableStateOf<Trickplay?>(tp)
    private var loaded by mutableStateOf(setOf("s0"))
    private val asked = mutableListOf<String>()

    private fun show() {
        compose.setContent {
            PzfTheme {
                Box(Modifier.size(960.dp, 540.dp).testTag("root")) {
                    ScrubOverlay(target, 1_500_000, trickplay) { url ->
                        asked += url
                        when (url) {
                            "s0" -> sheet0.takeIf { "s0" in loaded }
                            "s1" -> sheet1.takeIf { "s1" in loaded }
                            else -> null
                        }
                    }
                }
            }
        }
    }

    @Test
    fun previewAndTimeFollowTheTargetAndStayInsideTheScreen() {
        loaded = setOf("s0", "s1")
        show()
        compose.onNodeWithTag("scrub-time").assertTextEquals("10:00")
        compose.onNodeWithTag("scrub-preview").assertIsDisplayed()
        val root = compose.onNodeWithTag("root").getBoundsInRoot()
        val mid = compose.onNodeWithTag("scrub-preview").getBoundsInRoot()
        assertEquals(360f, (mid.right - mid.left).value, 0.5f)
        assertEquals(202.5f, (mid.bottom - mid.top).value, 0.5f)

        target = 0
        compose.waitForIdle()
        compose.onNodeWithTag("scrub-time").assertTextEquals("0:00")
        val start = compose.onNodeWithTag("scrub-preview").getBoundsInRoot()
        assertEquals(48f, start.left.value, 0.5f)

        target = 1_500_000
        compose.waitForIdle()
        val end = compose.onNodeWithTag("scrub-preview").getBoundsInRoot()
        assertEquals(root.right.value - 48f, end.right.value, 0.5f)
        assertTrue(mid.left > start.left && mid.left < end.left)
        // 1 500 s is past count: the last tile (149), on the second sheet.
        assertEquals("s1", asked.last())
    }

    @Test
    fun whileTheSheetLoadsOnlyTheTimeShows() {
        loaded = emptySet()
        show()
        compose.onNodeWithTag("scrub-time").assertTextEquals("10:00")
        compose.onNodeWithTag("scrub-preview").assertDoesNotExist()
        loaded = setOf("s0")
        compose.waitForIdle()
        compose.onNodeWithTag("scrub-preview").assertIsDisplayed()
    }

    @Test
    fun withoutTrickplayOnlyTheTime() {
        trickplay = null
        show()
        compose.onNodeWithTag("scrub").assertExists()
        compose.onNodeWithTag("scrub-time").assertTextEquals("10:00")
        compose.onNodeWithTag("scrub-preview").assertDoesNotExist()
        assertEquals(emptyList<String>(), asked)
    }

    @Test
    fun aSheetTooSmallForTheTileShowsOnlyTheTime() {
        // 1 450 s: tile 145, row 4 of sheet 1, which decoded only 90 px tall (rows 0–4 need 90: fits; row 5 would not).
        loaded = setOf("s1")
        target = 1_450_000
        show()
        compose.onNodeWithTag("scrub-preview").assertIsDisplayed()
        trickplay = tp.copy(count = 200)
        target = 1_550_000
        compose.waitForIdle()
        compose.onNodeWithTag("scrub-preview").assertDoesNotExist()
        compose.onNodeWithTag("scrub-time").assertTextEquals("25:50")
    }
}
