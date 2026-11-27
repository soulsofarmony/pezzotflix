package dev.pezzotflix.tv.ui.player

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import dev.pezzotflix.api.models.Trickplay
import dev.pezzotflix.tv.ui.PzfColors
import dev.pezzotflix.tv.ui.formatClock
import kotlin.math.roundToInt

/** Preview width on the 1080p (960 × 540 dp) UI; the height follows the tile's aspect ratio. */
val PREVIEW_WIDTH = 360.dp

/**
 * Scrub mode: the bar with the target, and above it, at the target's x and kept inside the bar, the preview tile
 * with the target time below it. While the tile's sheet loads (or without trickplay) only the time shows.
 * [sheet] gives the decoded sheet for a locator, or null while it loads.
 */
@Composable
fun BoxScope.ScrubOverlay(
    targetMs: Long,
    durationMs: Long,
    trickplay: Trickplay?,
    sheet: @Composable (url: String) -> ImageBitmap?,
) {
    val fraction = if (durationMs > 0) (targetMs.toFloat() / durationMs).coerceIn(0f, 1f) else 0f
    Column(
        Modifier
            .align(Alignment.BottomCenter)
            .fillMaxWidth()
            .background(Brush.verticalGradient(listOf(Color.Transparent, Color(0xCC000000), Color(0xEE000000))))
            .padding(horizontal = 48.dp, vertical = 32.dp)
            .testTag("scrub"),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        AtFraction(fraction) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                val tile = trickplay?.let { TrickplayMath.tileAt(targetMs, it) }
                val image = tile?.let { sheet(it.url) }
                if (trickplay != null && tile != null && image != null) {
                    TilePreview(image, tile, trickplay)
                }
                Text(
                    formatClock(targetMs),
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.background(Color(0xCC000000), RoundedCornerShape(6.dp))
                        .padding(horizontal = 10.dp, vertical = 4.dp)
                        .testTag("scrub-time"),
                )
            }
        }
        Box(Modifier.fillMaxWidth().height(6.dp).background(Color(0x55FFFFFF), RoundedCornerShape(3.dp))) {
            Box(Modifier.fillMaxHeight().fillMaxWidth(fraction).background(PzfColors.Accent, RoundedCornerShape(3.dp)))
        }
    }
}

@Composable
private fun TilePreview(image: ImageBitmap, tile: TrickplayTile, tp: Trickplay) {
    val crop = TrickplayMath.crop(tile, tp, image.width, image.height) ?: return
    val shape = RoundedCornerShape(8.dp)
    val height = PREVIEW_WIDTH * (tp.tileHeight.toFloat() / tp.tileWidth)
    Canvas(
        Modifier.size(PREVIEW_WIDTH, height).clip(shape).border(2.dp, PzfColors.Focus, shape).testTag("scrub-preview"),
    ) {
        // The crop at the sheet's own pixels, scaled into the box: a resized sheet would move the cells.
        drawImage(
            image,
            srcOffset = IntOffset(crop.x, crop.y),
            srcSize = IntSize(crop.width, crop.height),
            dstSize = IntSize(size.width.roundToInt(), size.height.roundToInt()),
            filterQuality = FilterQuality.Low,
        )
    }
}

/** Places its content centred on [fraction] of the available width, clamped so it never leaves it. */
@Composable
private fun AtFraction(fraction: Float, content: @Composable () -> Unit) {
    Layout(content, Modifier.fillMaxWidth()) { measurables, constraints ->
        val placeable = measurables.single().measure(constraints.copy(minWidth = 0, minHeight = 0))
        val width = constraints.maxWidth
        val centre = (fraction * width).roundToInt()
        val x = (centre - placeable.width / 2).coerceIn(0, (width - placeable.width).coerceAtLeast(0))
        layout(width, placeable.height) { placeable.place(x, 0) }
    }
}

/** The decoded sheet for [url] from [cache], loading it on first need; null while it loads or when it failed. */
@Composable
fun rememberSheet(cache: SheetCache<ImageBitmap>, url: String): ImageBitmap? {
    // Keyed by url: an image produced for another sheet must never be drawn with this tile's crop.
    val loaded by produceState<Pair<String, ImageBitmap>?>(null, cache, url) {
        value = (cache.cached(url) ?: cache.get(url))?.let { url to it }
    }
    return cache.cached(url) ?: loaded?.takeIf { it.first == url }?.second
}
