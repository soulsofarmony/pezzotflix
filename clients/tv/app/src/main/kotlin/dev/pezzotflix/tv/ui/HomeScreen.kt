package dev.pezzotflix.tv.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import dev.pezzotflix.api.models.Home
import dev.pezzotflix.api.models.HomeRow
import dev.pezzotflix.tv.AppContainer
import kotlinx.coroutines.flow.drop

class HomeViewModel(private val container: AppContainer) : LoadViewModel<Home>() {
    /** The card that had the focus (row id, item id): it gets it back when the viewer returns from a detail. */
    var lastFocus: Pair<String, String>? = null

    init {
        reload()
    }

    override suspend fun fetch(): Home = container.connection?.api?.home() ?: error("no server")
}

/** Home composed by the server (doc 03): its rows in its order, cards that open the detail. */
@Composable
fun HomeScreen(container: AppContainer, onOpen: (String) -> Unit, onSwitchProfile: () -> Unit) {
    val vm = viewModel { HomeViewModel(container) }
    val state by vm.state.collectAsState()
    // Events and the end of a playback bump the library version: reload without losing what is on screen.
    LaunchedEffect(Unit) {
        container.libraryVersion.drop(1).collect { vm.reload(quiet = true) }
    }
    LaunchedEffect(Unit) {
        // Back from a detail or the player: the resume positions may have moved.
        if (vm.state.value is Load.Ready) vm.reload(quiet = true)
    }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(start = 48.dp, end = 48.dp, top = 24.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(Txt.APP, style = MaterialTheme.typography.headlineMedium, color = PzfColors.Accent)
            Spacer(Modifier.weight(1f))
            container.prefs.profileName?.let {
                Text(it, style = MaterialTheme.typography.titleMedium, color = PzfColors.Muted, modifier = Modifier.padding(end = 16.dp))
            }
            PzfButton(Txt.SWITCH_PROFILE, onSwitchProfile)
        }
        when (val s = state) {
            Load.Loading -> Busy()
            is Load.Failed -> ErrorPanel(Txt.error(s.error), listOf(Txt.RETRY to { vm.reload() }, Txt.SWITCH_PROFILE to onSwitchProfile))
            is Load.Ready -> {
                val rows = s.value.rows.filter { it.items.isNotEmpty() }
                if (rows.isEmpty()) {
                    ErrorPanel(Txt.HOME_EMPTY, listOf(Txt.RETRY to { vm.reload() }))
                } else {
                    Rows(container, rows, vm, onOpen)
                }
            }
        }
    }
}

@Composable
private fun Rows(container: AppContainer, rows: List<HomeRow>, vm: HomeViewModel, onOpen: (String) -> Unit) {
    val base = container.connection?.base
    val target = remember { FocusRequester() }
    val wanted = vm.lastFocus?.takeIf { (row, item) -> rows.any { r -> r.id.value == row && r.items.any { it.id == item } } }
        ?: (rows.first().id.value to rows.first().items.first().id)
    LazyColumn(
        modifier = Modifier.fillMaxSize().testTag("home-rows"),
        contentPadding = PaddingValues(top = 16.dp, bottom = 48.dp),
        verticalArrangement = Arrangement.spacedBy(28.dp),
    ) {
        items(rows, key = { it.id.value }) { row ->
            Column {
                Text(row.title, style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(start = 48.dp, bottom = 12.dp))
                LazyRow(
                    contentPadding = PaddingValues(horizontal = 48.dp, vertical = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(20.dp),
                ) {
                    items(row.items, key = { it.id }) { item ->
                        val isTarget = wanted.first == row.id.value && wanted.second == item.id
                        ItemCard(
                            item,
                            base,
                            onClick = { onOpen(item.id) },
                            modifier = Modifier
                                .then(if (isTarget) Modifier.focusRequester(target) else Modifier)
                                .onFocusChanged { if (it.hasFocus) vm.lastFocus = row.id.value to item.id },
                        )
                    }
                }
            }
        }
    }
    InitialFocus(target)
}
