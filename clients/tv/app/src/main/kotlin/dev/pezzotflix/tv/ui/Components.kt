package dev.pezzotflix.tv.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Border
import androidx.tv.material3.Button
import androidx.tv.material3.ButtonDefaults
import androidx.tv.material3.Card
import androidx.tv.material3.CardDefaults
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import coil3.compose.AsyncImage
import dev.pezzotflix.api.models.ImageRef
import dev.pezzotflix.api.models.ItemKind
import dev.pezzotflix.api.models.ItemSummary
import dev.pezzotflix.tv.api.ServerUrl
import kotlinx.coroutines.android.awaitFrame
import okhttp3.HttpUrl

/** The server lists the variants it offers per artwork type (w = 160 … 1920); the client only picks among them. */
fun pickImage(base: HttpUrl?, images: List<ImageRef>?, types: List<ImageRef.Type>, preferredWidthPx: Int): String? {
    if (base == null || images.isNullOrEmpty()) return null
    for (type in types) {
        val img = images.firstOrNull { it.type == type } ?: continue
        val variants = img.variants.orEmpty().mapNotNull { (w, url) -> w.toIntOrNull()?.takeIf { it > 0 }?.let { it to url } }.sortedBy { it.first }
        val url = variants.firstOrNull { it.first >= preferredWidthPx }?.second ?: variants.lastOrNull()?.second ?: img.url
        return ServerUrl.resolve(base, url)?.toString()
    }
    return null
}

/** A stable hue from a title, for the placeholder cover (as the web client). */
fun placeholderColor(title: String): Color {
    var h = 0
    for (c in title) h = (h * 31 + c.code) % 360
    return Color.hsv(h.toFloat(), 0.45f, 0.35f)
}

/** Requests focus once the target is laid out; a target that is not attached any more is ignored. */
@Composable
fun InitialFocus(requester: FocusRequester, key: Any? = Unit) {
    LaunchedEffect(key) {
        awaitFrame()
        runCatching { requester.requestFocus() }
    }
}

@Composable
fun PzfButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, primary: Boolean = false) {
    Button(
        onClick = onClick,
        modifier = modifier,
        enabled = enabled,
        // Focus looks the same on every button (white, black text); the primary one is red only while unfocused.
        colors = ButtonDefaults.colors(
            containerColor = if (primary) PzfColors.Accent else Color(0xFF34343C),
            contentColor = if (primary) Color.White else PzfColors.Text,
            focusedContainerColor = PzfColors.Focus,
            focusedContentColor = Color.Black,
        ),
        border = ButtonDefaults.border(focusedBorder = Border(BorderStroke(3.dp, PzfColors.Focus))),
    ) {
        Text(text, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
fun Busy(modifier: Modifier = Modifier, text: String = Txt.LOADING) {
    Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text(text, style = MaterialTheme.typography.titleLarge, color = PzfColors.Muted)
    }
}

/** An error with its actions; the first action takes the focus. */
@Composable
fun ErrorPanel(message: String, actions: List<Pair<String, () -> Unit>>, modifier: Modifier = Modifier, title: String? = null) {
    val first = remember { FocusRequester() }
    Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(Modifier.widthIn(max = 720.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            if (title != null) Text(title, style = MaterialTheme.typography.headlineMedium)
            Text(message, style = MaterialTheme.typography.bodyLarge)
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                actions.forEachIndexed { i, (label, action) ->
                    PzfButton(label, action, if (i == 0) Modifier.focusRequester(first) else Modifier, primary = i == 0)
                }
            }
        }
    }
    if (actions.isNotEmpty()) InitialFocus(first, message)
}

/** Episodes and extras are landscape stills; films, series and documentaries are posters. */
fun ItemSummary.isLandscape(): Boolean = kind == ItemKind.episode || kind == ItemKind.extra

/**
 * A focusable card: on focus it grows and gets a white border (readable from the sofa). Under the image: the title,
 * a progress bar when started, and "Non disponibile" / "In attesa" when they apply.
 */
@Composable
fun ItemCard(item: ItemSummary, base: HttpUrl?, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val landscape = item.isLandscape()
    val width: Dp = if (landscape) 240.dp else 140.dp
    val image = pickImage(
        base,
        item.images,
        if (landscape) listOf(ImageRef.Type.still, ImageRef.Type.thumbnail, ImageRef.Type.backdrop, ImageRef.Type.poster) else listOf(ImageRef.Type.poster),
        if (landscape) 640 else 320,
    )
    Column(modifier.width(width)) {
        Card(
            onClick = onClick,
            modifier = Modifier.fillMaxWidth().aspectRatio(if (landscape) 16f / 9f else 2f / 3f),
            scale = CardDefaults.scale(focusedScale = 1.08f),
            border = CardDefaults.border(focusedBorder = Border(BorderStroke(3.dp, PzfColors.Focus))),
            colors = CardDefaults.colors(containerColor = placeholderColor(item.title)),
        ) {
            Box(Modifier.fillMaxSize()) {
                if (image == null) {
                    Text(
                        item.title,
                        modifier = Modifier.align(Alignment.Center).padding(8.dp),
                        style = MaterialTheme.typography.titleMedium,
                        maxLines = 4,
                        overflow = TextOverflow.Ellipsis,
                    )
                } else {
                    AsyncImage(model = image, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                }
                val progress = item.state?.progressPercent ?: 0.0
                if (progress > 0 && item.state?.watched != true) {
                    Box(Modifier.align(Alignment.BottomStart).fillMaxWidth().height(5.dp).background(Color(0x99000000))) {
                        Box(Modifier.fillMaxHeight().fillMaxWidth((progress / 100).toFloat().coerceIn(0f, 1f)).background(PzfColors.Accent))
                    }
                }
            }
        }
        Text(
            cardTitle(item),
            modifier = Modifier.padding(top = 8.dp),
            style = MaterialTheme.typography.bodyMedium,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        val flag = when {
            !item.available -> Txt.ITEM_UNAVAILABLE_SHORT
            item.provisional -> Txt.ITEM_PROVISIONAL_SHORT
            else -> null
        }
        if (flag != null) Text(flag, style = MaterialTheme.typography.bodyMedium, color = PzfColors.Warning)
    }
}

fun cardTitle(item: ItemSummary): String {
    val s = item.seasonNumber
    val e = item.episodeNumber
    if (item.kind == ItemKind.episode && s != null && e != null) {
        return listOfNotNull(item.seriesTitle, Txt.episodeCode(s, e), item.title.takeIf { it != item.seriesTitle }).joinToString(" · ")
    }
    return item.title
}
