package dev.pezzotflix.tv.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import coil3.compose.AsyncImage
import dev.pezzotflix.api.models.ImageRef
import dev.pezzotflix.api.models.ItemCategory
import dev.pezzotflix.api.models.ItemDetail
import dev.pezzotflix.api.models.ItemKind
import dev.pezzotflix.api.models.ItemSummary
import dev.pezzotflix.tv.AppContainer
import dev.pezzotflix.tv.api.AppEvent
import kotlinx.coroutines.flow.drop

/** The detail and, for a series, the episode the server proposes next (GetNextUp). */
data class ItemView(val detail: ItemDetail, val nextUp: ItemSummary?)

class ItemViewModel(private val container: AppContainer, private val itemId: String) : LoadViewModel<ItemView>() {
    init {
        reload()
    }

    override suspend fun fetch(): ItemView {
        val api = container.connection?.api ?: error("no server")
        val detail = api.item(itemId)
        val next = if (detail.kind == ItemKind.series) api.nextUp(detail.id) else null
        return ItemView(detail, next)
    }
}

fun kindLabel(kind: ItemKind, category: ItemCategory?): String? = when {
    category == ItemCategory.documentary -> Txt.KIND_DOCUMENTARY
    kind == ItemKind.movie -> Txt.KIND_MOVIE
    kind == ItemKind.series -> Txt.KIND_SERIES
    kind == ItemKind.season -> Txt.KIND_SEASON
    kind == ItemKind.episode -> Txt.KIND_EPISODE
    kind == ItemKind.extra -> Txt.KIND_EXTRA
    else -> null
}

@Composable
fun ItemScreen(container: AppContainer, itemId: String, onPlay: (Screen.Player) -> Unit, onReplaced: (String) -> Unit) {
    val vm = viewModel(key = itemId) { ItemViewModel(container, itemId) }
    val state by vm.state.collectAsState()
    LaunchedEffect(itemId) {
        // Back from the player: the resume position has moved.
        if (vm.state.value is Load.Ready) vm.reload(quiet = true)
    }
    LaunchedEffect(itemId) {
        container.libraryVersion.drop(1).collect { vm.reload(quiet = true) }
    }
    LaunchedEffect(itemId) {
        // A provisional item replaced by the identified one: follow it.
        container.events.collect { e ->
            if (e is AppEvent.ItemRemoved && e.itemId == itemId) e.replacedBy?.let(onReplaced)
        }
    }
    when (val s = state) {
        Load.Loading -> Busy()
        is Load.Failed -> ErrorPanel(Txt.error(s.error), listOf(Txt.RETRY to { vm.reload() }))
        is Load.Ready -> Detail(container, s.value, onPlay)
    }
}

@Composable
private fun Detail(container: AppContainer, view: ItemView, onPlay: (Screen.Player) -> Unit) {
    val item = view.detail
    val base = container.connection?.base
    val backdrop = pickImage(base, item.images, listOf(ImageRef.Type.backdrop, ImageRef.Type.still), 1280)
    val poster = pickImage(base, item.images, listOf(ImageRef.Type.poster), 320)
    val first = remember { FocusRequester() }

    Box(Modifier.fillMaxSize()) {
        if (backdrop != null) {
            AsyncImage(model = backdrop, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
            Box(
                Modifier.fillMaxSize().background(
                    Brush.horizontalGradient(listOf(PzfColors.Background, PzfColors.Background.copy(alpha = 0.85f), Color.Transparent)),
                ),
            )
        }
        Row(Modifier.fillMaxSize().padding(48.dp), horizontalArrangement = Arrangement.spacedBy(36.dp), verticalAlignment = Alignment.CenterVertically) {
            if (poster != null) {
                AsyncImage(
                    model = poster,
                    contentDescription = null,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.width(220.dp).aspectRatio(2f / 3f).clip(RoundedCornerShape(8.dp)),
                )
            }
            Column(Modifier.widthIn(max = 760.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                item.seriesTitle?.takeIf { item.kind == ItemKind.episode }?.let {
                    Text(it, style = MaterialTheme.typography.titleLarge, color = PzfColors.Muted)
                }
                Text(item.title, style = MaterialTheme.typography.displaySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(facts(item), style = MaterialTheme.typography.titleMedium, color = PzfColors.Muted)
                if (item.provisional) Text(Txt.ITEM_PROVISIONAL, style = MaterialTheme.typography.bodyLarge, color = PzfColors.Warning)
                if (!item.available) Text(Txt.ITEM_UNAVAILABLE, style = MaterialTheme.typography.bodyLarge, color = PzfColors.Warning)
                Text(
                    item.overview ?: Txt.ITEM_NO_OVERVIEW,
                    style = MaterialTheme.typography.bodyLarge,
                    maxLines = 6,
                    overflow = TextOverflow.Ellipsis,
                )
                Actions(item, view.nextUp, first, onPlay)
            }
        }
    }
    InitialFocus(first, item.id)
}

private fun facts(item: ItemDetail): String {
    val s = item.seasonNumber
    val e = item.episodeNumber
    return listOfNotNull(
        kindLabel(item.kind, item.category),
        if (item.kind == ItemKind.episode && s != null && e != null) Txt.episodeCode(s, e) else null,
        item.year?.toString(),
        item.durationMs?.takeIf { it > 0 }?.let(::formatDuration),
        Txt.ITEM_WATCHED.takeIf { item.state?.watched == true },
    ).plus(item.badges).joinToString(" · ")
}

@Composable
private fun Actions(item: ItemDetail, nextUp: ItemSummary?, first: FocusRequester, onPlay: (Screen.Player) -> Unit) {
    val playable = item.kind == ItemKind.movie || item.kind == ItemKind.episode || item.kind == ItemKind.extra
    val resume = item.state?.resumePositionMs?.takeIf { it > 0 }
    val versions = item.versions.size.takeIf { it > 0 }
    fun play(from: Long?) = onPlay(Screen.Player(item.id, cardTitleOf(item), from, versions))
    Row(Modifier.fillMaxWidth().padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        when {
            playable && item.available && resume != null -> {
                // null: the server starts from the profile's resume position (the one shown).
                PzfButton(Txt.itemResume(resume), { play(null) }, Modifier.focusRequester(first).testTag("resume"), primary = true)
                PzfButton(Txt.ITEM_FROM_START, { play(0) }, Modifier.testTag("from-start"))
            }
            playable && item.available -> PzfButton(Txt.ITEM_PLAY, { play(null) }, Modifier.focusRequester(first).testTag("play"), primary = true)
            item.kind == ItemKind.series && nextUp != null && nextUp.available -> {
                val s = nextUp.seasonNumber
                val e = nextUp.episodeNumber
                PzfButton(
                    if (s != null && e != null) Txt.playEpisode(s, e) else Txt.ITEM_NEXT_UP,
                    { onPlay(Screen.Player(nextUp.id, cardTitle(nextUp), null, null)) },
                    Modifier.focusRequester(first).testTag("next-up"),
                    primary = true,
                )
            }
            item.kind == ItemKind.series -> Text(Txt.ITEM_NO_NEXT_UP, style = MaterialTheme.typography.bodyLarge, color = PzfColors.Muted)
        }
    }
}

private fun cardTitleOf(item: ItemDetail): String {
    val s = item.seasonNumber
    val e = item.episodeNumber
    return if (item.kind == ItemKind.episode && s != null && e != null) {
        listOfNotNull(item.seriesTitle, Txt.episodeCode(s, e)).joinToString(" · ")
    } else {
        item.title
    }
}
