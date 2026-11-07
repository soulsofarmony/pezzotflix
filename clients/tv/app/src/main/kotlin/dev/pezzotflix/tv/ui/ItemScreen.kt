package dev.pezzotflix.tv.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
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
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.tv.material3.Border
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Surface
import androidx.tv.material3.Text
import coil3.compose.AsyncImage
import dev.pezzotflix.api.models.ImageRef
import dev.pezzotflix.api.models.ItemCategory
import dev.pezzotflix.api.models.ItemDetail
import dev.pezzotflix.api.models.ItemKind
import dev.pezzotflix.api.models.ItemSummary
import dev.pezzotflix.tv.AppContainer
import dev.pezzotflix.tv.api.AppEvent
import dev.pezzotflix.tv.api.VideoApi
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.android.awaitFrame
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.launch
import okhttp3.HttpUrl

/** The detail; for a series the episode the server proposes next (GetNextUp); seasons or episodes with their state. */
data class ItemView(val detail: ItemDetail, val nextUp: ItemSummary?, val children: List<ItemSummary>)

class ItemViewModel(private val container: AppContainer, private val itemId: String) : LoadViewModel<ItemView>() {
    var acting by mutableStateOf(false)
        private set
    var actionError by mutableStateOf<String?>(null)
        private set

    init {
        reload()
    }

    private fun api(): VideoApi = container.connection?.api ?: error("no server")

    override suspend fun fetch(): ItemView {
        val api = api()
        val detail = api.item(itemId)
        val next = if (detail.kind == ItemKind.series) api.nextUp(detail.id) else null
        // GetChildren carries the profile's state of each season or episode (the detail's children may not).
        val children = if (detail.kind == ItemKind.series || detail.kind == ItemKind.season) api.children(detail.id) else emptyList()
        return ItemView(detail, next, children)
    }

    /** A watch-state change. Done: the library version moves, so this screen, Home and the lists reload. */
    fun act(call: suspend VideoApi.() -> Unit) {
        if (acting) return
        acting = true
        actionError = null
        viewModelScope.launch {
            try {
                api().call()
                container.libraryChanged()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                actionError = Txt.error(e)
            } finally {
                acting = false
            }
        }
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

/** "Stagione 2", "Speciali" for season 0 (as the web). */
fun seasonLabel(season: ItemSummary): String = when (val n = season.seasonNumber) {
    0L -> Txt.ITEM_SPECIALS
    null -> season.title
    else -> Txt.itemSeason(n)
}

/** Duration · Visto · Visto al N% (as the web's list of children). */
fun childFacts(c: ItemSummary): String {
    val state = c.state
    val percent = state?.progressPercent ?: 0.0
    return listOfNotNull(
        c.durationMs?.takeIf { it > 0 }?.let(::formatDuration),
        Txt.ITEM_WATCHED.takeIf { state?.watched == true },
        Txt.itemProgress(Math.round(percent)).takeIf { percent > 0 && percent < 100 && state?.watched != true },
    ).joinToString(" · ")
}

@Composable
fun ItemScreen(
    container: AppContainer,
    itemId: String,
    onPlay: (Screen.Player) -> Unit,
    onOpen: (String) -> Unit,
    onReplaced: (String) -> Unit,
    onBack: () -> Unit,
) {
    val vm = viewModel(key = itemId) { ItemViewModel(container, itemId) }
    val state by vm.state.collectAsState()
    LaunchedEffect(itemId) {
        // Back from the player or a child: the resume positions and watched marks may have moved.
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
        is Load.Failed -> ErrorPanel(Txt.error(s.error), listOf(Txt.RETRY to { vm.reload() }, Txt.BACK to onBack))
        is Load.Ready -> Detail(container, s.value, vm, onPlay, onOpen)
    }
}

/** Where the focus lands when the detail opens. */
private enum class FocusTarget { PRIMARY, EPISODE, ACTIONS }

@Composable
private fun Detail(container: AppContainer, view: ItemView, vm: ItemViewModel, onPlay: (Screen.Player) -> Unit, onOpen: (String) -> Unit) {
    val item = view.detail
    val base = container.connection?.base
    val backdrop = pickImage(base, item.images, listOf(ImageRef.Type.backdrop, ImageRef.Type.still), 1280)
    val first = remember { FocusRequester() }
    val list = rememberLazyListState()
    val playable = item.kind == ItemKind.movie || item.kind == ItemKind.episode || item.kind == ItemKind.extra
    val hasPrimary = (playable && item.available) || (item.kind == ItemKind.series && view.nextUp?.available == true)
    // A season opens on the episode to watch: the one started, else the first not watched.
    val episodes = if (item.kind == ItemKind.season) view.children else emptyList()
    val target = episodes.indexOfFirst { (it.state?.progressPercent ?: 0.0) > 0 && it.state?.watched != true }
        .takeIf { it >= 0 } ?: episodes.indexOfFirst { it.state?.watched != true }.takeIf { it >= 0 } ?: 0
    val focus = when {
        hasPrimary -> FocusTarget.PRIMARY
        episodes.isNotEmpty() -> FocusTarget.EPISODE
        else -> FocusTarget.ACTIONS
    }

    Box(Modifier.fillMaxSize()) {
        if (backdrop != null) {
            AsyncImage(model = backdrop, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
            Box(
                Modifier.fillMaxSize().background(
                    Brush.horizontalGradient(listOf(PzfColors.Background, PzfColors.Background.copy(alpha = 0.85f), Color.Transparent)),
                ),
            )
        }
        LazyColumn(
            state = list,
            modifier = Modifier.fillMaxSize().testTag("item-detail"),
            contentPadding = PaddingValues(horizontal = 48.dp, vertical = 36.dp),
            verticalArrangement = Arrangement.spacedBy(28.dp),
        ) {
            item(key = "header") {
                Header(container, view, vm, if (focus == FocusTarget.PRIMARY) first else null, if (focus == FocusTarget.ACTIONS) first else null, onPlay)
            }
            if (item.kind == ItemKind.series && view.children.isNotEmpty()) {
                item(key = "seasons") { Seasons(view.children, onOpen) }
            }
            if (episodes.isNotEmpty()) {
                item(key = "episodes-title") { SectionTitle(Txt.ITEM_EPISODES) }
                itemsIndexed(episodes, key = { _, it -> it.id }) { i, ep ->
                    EpisodeRow(
                        ep,
                        base,
                        onPlay = { onPlay(Screen.Player(ep.id, cardTitle(ep), null, null)) },
                        onDetails = { onOpen(ep.id) },
                        modifier = if (focus == FocusTarget.EPISODE && i == target) Modifier.focusRequester(first) else Modifier,
                    )
                }
            }
            if (item.extras.isNotEmpty()) {
                item(key = "extras") { Extras(item.extras, base, onOpen) }
            }
        }
    }
    // The target row may be below the screen: bring it in before asking for the focus.
    val targetIndex = if (focus == FocusTarget.EPISODE) 2 + target else 0
    FocusOn(first, list, targetIndex, item.id)
}

@Composable
private fun FocusOn(requester: FocusRequester, list: LazyListState, index: Int, key: Any) {
    LaunchedEffect(key) {
        if (index > 0) list.scrollToItem(index)
        awaitFrame()
        runCatching { requester.requestFocus() }
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(text, style = MaterialTheme.typography.titleLarge)
}

@Composable
private fun Header(
    container: AppContainer,
    view: ItemView,
    vm: ItemViewModel,
    primaryFocus: FocusRequester?,
    actionsFocus: FocusRequester?,
    onPlay: (Screen.Player) -> Unit,
) {
    val item = view.detail
    val poster = pickImage(container.connection?.base, item.images, listOf(ImageRef.Type.poster), 320)
    Row(horizontalArrangement = Arrangement.spacedBy(36.dp)) {
        if (poster != null) {
            AsyncImage(
                model = poster,
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.width(180.dp).aspectRatio(2f / 3f).clip(RoundedCornerShape(8.dp)),
            )
        }
        Column(Modifier.widthIn(max = 820.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            val context = item.seriesTitle?.takeIf { item.kind == ItemKind.episode || item.kind == ItemKind.season }
            context?.let { Text(it, style = MaterialTheme.typography.titleLarge, color = PzfColors.Muted) }
            Text(item.title, style = MaterialTheme.typography.displaySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(facts(item), style = MaterialTheme.typography.titleMedium, color = PzfColors.Muted)
            if (item.provisional) Text(Txt.ITEM_PROVISIONAL, style = MaterialTheme.typography.bodyLarge, color = PzfColors.Warning)
            if (!item.available) Text(Txt.ITEM_UNAVAILABLE, style = MaterialTheme.typography.bodyLarge, color = PzfColors.Warning)
            Text(item.overview ?: Txt.ITEM_NO_OVERVIEW, style = MaterialTheme.typography.bodyLarge, maxLines = 5, overflow = TextOverflow.Ellipsis)
            PlayActions(item, view.nextUp, primaryFocus, onPlay)
            StateActions(item, vm, actionsFocus)
            vm.actionError?.let { Text(it, style = MaterialTheme.typography.bodyLarge, color = PzfColors.Warning) }
        }
    }
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
private fun PlayActions(item: ItemDetail, nextUp: ItemSummary?, focus: FocusRequester?, onPlay: (Screen.Player) -> Unit) {
    val playable = item.kind == ItemKind.movie || item.kind == ItemKind.episode || item.kind == ItemKind.extra
    val resume = item.state?.resumePositionMs?.takeIf { it > 0 }
    val versions = item.versions.size.takeIf { it > 0 }
    val first = if (focus != null) Modifier.focusRequester(focus) else Modifier
    fun play(from: Long?) = onPlay(Screen.Player(item.id, cardTitleOf(item), from, versions))
    Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        when {
            playable && item.available && resume != null -> {
                // null: the server starts from the profile's resume position (the one shown).
                PzfButton(Txt.itemResume(resume), { play(null) }, first.testTag("resume"), primary = true)
                PzfButton(Txt.ITEM_FROM_START, { play(0) }, Modifier.testTag("from-start"))
            }
            playable && item.available -> PzfButton(Txt.ITEM_PLAY, { play(null) }, first.testTag("play"), primary = true)
            item.kind == ItemKind.series && nextUp != null && nextUp.available -> {
                val s = nextUp.seasonNumber
                val e = nextUp.episodeNumber
                PzfButton(
                    if (s != null && e != null) Txt.playEpisode(s, e) else Txt.ITEM_NEXT_UP,
                    { onPlay(Screen.Player(nextUp.id, cardTitle(nextUp), null, null)) },
                    first.testTag("next-up"),
                    primary = true,
                )
            }
            item.kind == ItemKind.series -> Text(Txt.ITEM_NO_NEXT_UP, style = MaterialTheme.typography.bodyLarge, color = PzfColors.Muted)
        }
    }
}

/** Watchlist (films, series, extras: doc 01), watched, and "Togli da Continua a guardare" when started (as the web). */
@Composable
private fun StateActions(item: ItemDetail, vm: ItemViewModel, focus: FocusRequester?) {
    val state = item.state
    val listable = item.kind != ItemKind.season && item.kind != ItemKind.episode
    val inList = state?.inWatchlist == true
    val watched = state?.watched == true
    val resume = state?.resumePositionMs?.takeIf { it > 0 }
    val id = item.id
    Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        PzfButton(
            if (watched) Txt.ITEM_MARK_UNWATCHED else Txt.ITEM_MARK_WATCHED,
            { vm.act { if (watched) markUnwatched(id) else markWatched(id) } },
            (if (focus != null) Modifier.focusRequester(focus) else Modifier).testTag("watched"),
            enabled = !vm.acting,
        )
        if (listable) {
            PzfButton(
                if (inList) Txt.ITEM_WATCHLIST_REMOVE else Txt.ITEM_WATCHLIST_ADD,
                { vm.act { if (inList) removeFromWatchlist(id) else addToWatchlist(id) } },
                Modifier.testTag("watchlist"),
                enabled = !vm.acting,
            )
        }
        if (resume != null) {
            PzfButton(Txt.ITEM_CLEAR_PROGRESS, { vm.act { clearProgress(id) } }, Modifier.testTag("clear-progress"), enabled = !vm.acting)
        }
    }
}

@Composable
private fun Seasons(seasons: List<ItemSummary>, onOpen: (String) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        SectionTitle(Txt.ITEM_SEASONS)
        LazyRow(contentPadding = PaddingValues(vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            items(seasons, key = { it.id }) { season ->
                val facts = listOfNotNull(Txt.ITEM_WATCHED.takeIf { season.state?.watched == true })
                PzfButton(
                    (listOf(seasonLabel(season)) + facts).joinToString(" · "),
                    { onOpen(season.id) },
                    Modifier.testTag("season-${season.seasonNumber ?: season.id}"),
                )
            }
        }
    }
}

/** One episode: OK plays it (from where it was left), "Dettagli" opens its page (watched marks, tracks). */
@Composable
private fun EpisodeRow(ep: ItemSummary, base: HttpUrl?, onPlay: () -> Unit, onDetails: () -> Unit, modifier: Modifier = Modifier) {
    val still = pickImage(base, ep.images, listOf(ImageRef.Type.still, ImageRef.Type.thumbnail, ImageRef.Type.backdrop), 320)
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        Surface(
            onClick = if (ep.available) onPlay else onDetails,
            modifier = modifier.weight(1f).testTag("episode-${ep.episodeNumber ?: ep.id}"),
            shape = ClickableSurfaceDefaults.shape(RoundedCornerShape(8.dp)),
            colors = ClickableSurfaceDefaults.colors(containerColor = PzfColors.Surface, focusedContainerColor = Color(0xFF34343C)),
            border = ClickableSurfaceDefaults.border(focusedBorder = Border(BorderStroke(3.dp, PzfColors.Focus), shape = RoundedCornerShape(8.dp))),
            scale = ClickableSurfaceDefaults.scale(focusedScale = 1.02f),
        ) {
            Row(Modifier.padding(12.dp), horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.width(160.dp).aspectRatio(16f / 9f).clip(RoundedCornerShape(6.dp)).background(placeholderColor(ep.title))) {
                    if (still != null) AsyncImage(model = still, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                    ProgressBar(ep, Modifier.align(Alignment.BottomStart))
                }
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    val number = ep.episodeNumber?.let { "$it. " }.orEmpty()
                    Text(number + ep.title, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    val facts = childFacts(ep)
                    if (facts.isNotEmpty()) Text(facts, style = MaterialTheme.typography.bodyMedium, color = PzfColors.Muted)
                    if (!ep.available) Text(Txt.ITEM_UNAVAILABLE_SHORT, style = MaterialTheme.typography.bodyMedium, color = PzfColors.Warning)
                }
            }
        }
        PzfButton(Txt.ITEM_DETAILS, onDetails, Modifier.testTag("details-${ep.episodeNumber ?: ep.id}"))
    }
}

@Composable
private fun Extras(extras: List<ItemSummary>, base: HttpUrl?, onOpen: (String) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        SectionTitle(Txt.ITEM_EXTRAS)
        LazyRow(contentPadding = PaddingValues(vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(20.dp)) {
            items(extras, key = { it.id }) { extra -> ItemCard(extra, base, onClick = { onOpen(extra.id) }) }
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
