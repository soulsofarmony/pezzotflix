package dev.pezzotflix.tv.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import dev.pezzotflix.api.models.ItemSummary
import dev.pezzotflix.tv.AppContainer
import kotlinx.coroutines.flow.drop

class WatchlistViewModel(private val container: AppContainer) : LoadViewModel<List<ItemSummary>>() {
    init {
        reload()
    }

    override suspend fun fetch(): List<ItemSummary> = container.connection?.api?.watchlist() ?: error("no server")
}

/** "La mia lista": the server's Home has no such row, so it is a page of its own, as the web's list. */
@Composable
fun WatchlistScreen(container: AppContainer, onOpen: (String) -> Unit, onBack: () -> Unit) {
    val vm = viewModel { WatchlistViewModel(container) }
    val state by vm.state.collectAsState()
    LaunchedEffect(Unit) {
        // Back from a detail: an item may have left the list.
        if (vm.state.value is Load.Ready) vm.reload(quiet = true)
    }
    LaunchedEffect(Unit) {
        container.libraryVersion.drop(1).collect { vm.reload(quiet = true) }
    }
    val first = remember { FocusRequester() }
    Column(Modifier.fillMaxSize().padding(start = 48.dp, end = 48.dp, top = 32.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text(Txt.WATCHLIST, style = MaterialTheme.typography.headlineMedium)
        when (val s = state) {
            Load.Loading -> Busy()
            is Load.Failed -> ErrorPanel(Txt.error(s.error), listOf(Txt.RETRY to { vm.reload() }, Txt.BACK to onBack))
            is Load.Ready -> if (s.value.isEmpty()) {
                ErrorPanel(Txt.LIST_EMPTY, listOf(Txt.BACK to onBack))
            } else {
                ItemGrid(s.value, container.connection?.base, onOpen = { onOpen(it.id) }, first = first)
                InitialFocus(first)
            }
        }
    }
}
