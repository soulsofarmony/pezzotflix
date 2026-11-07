package dev.pezzotflix.tv.ui

import android.view.View
import android.view.inputmethod.InputMethodManager
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.SoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import dev.pezzotflix.api.models.ItemSummary
import dev.pezzotflix.tv.AppContainer
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch

class SearchViewModel(private val container: AppContainer) : ViewModel() {
    sealed interface Result {
        data object Idle : Result
        data class Loading(val query: String) : Result
        data class Ready(val query: String, val items: List<ItemSummary>) : Result
        data class Failed(val query: String, val error: Throwable) : Result
    }

    private val query = MutableStateFlow("")
    private val attempt = MutableStateFlow(0)
    private val _result = MutableStateFlow<Result>(Result.Idle)
    val result: StateFlow<Result> = _result.asStateFlow()

    init {
        viewModelScope.launch {
            combine(query, attempt) { q, n -> q.trim() to n }.distinctUntilChanged().collectLatest { (q, _) ->
                if (q.isEmpty()) {
                    _result.value = Result.Idle
                    return@collectLatest
                }
                // As the web: 250 ms after the last key, and only the last query answers.
                delay(DEBOUNCE_MS)
                _result.value = Result.Loading(q)
                _result.value = try {
                    Result.Ready(q, container.connection?.api?.search(q) ?: error("no server"))
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    Result.Failed(q, e)
                }
            }
        }
    }

    fun setQuery(text: String) {
        query.value = text
    }

    fun retry() {
        attempt.value += 1
    }

    private companion object {
        const val DEBOUNCE_MS = 250L
    }
}

/** The contract's limit on q. */
private const val MAX_QUERY_LENGTH = 200

/** Closes the soft keyboard for good: Android 11 would show it again at the next relayout (see AppNav). */
fun hideKeyboard(keyboard: SoftwareKeyboardController?, view: View) {
    keyboard?.hide()
    view.context.getSystemService(InputMethodManager::class.java)?.hideSoftInputFromWindow(view.windowToken, 0)
}

/** Search (doc 03 Search) with the TV's keyboard: results as cards; "Cerca" on the keyboard moves to the first card. */
@Composable
fun SearchScreen(container: AppContainer, onOpen: (String) -> Unit) {
    val vm = viewModel { SearchViewModel(container) }
    val result by vm.result.collectAsState()
    // Saveable: the text survives a visit to a result, as the ViewModel's results do.
    var text by rememberSaveable { mutableStateOf("") }
    var fieldFocused by remember { mutableStateOf(false) }
    val field = remember { FocusRequester() }
    val firstCard = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    val view = LocalView.current
    val focusManager = LocalFocusManager.current
    val toResults = {
        hideKeyboard(keyboard, view)
        if ((result as? SearchViewModel.Result.Ready)?.items?.isNotEmpty() == true) runCatching { firstCard.requestFocus() }
    }

    Column(Modifier.fillMaxSize().padding(start = 48.dp, end = 48.dp, top = 32.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text(Txt.SEARCH, style = MaterialTheme.typography.headlineMedium)
        Box(
            Modifier
                .widthIn(max = 820.dp)
                .fillMaxWidth()
                .background(PzfColors.Surface, RoundedCornerShape(8.dp))
                .border(BorderStroke(3.dp, if (fieldFocused) PzfColors.Focus else Color(0xFF55555E)), RoundedCornerShape(8.dp))
                .padding(horizontal = 16.dp, vertical = 14.dp),
        ) {
            if (text.isEmpty()) Text(Txt.SEARCH_PLACEHOLDER, style = MaterialTheme.typography.titleLarge, color = PzfColors.Muted)
            BasicTextField(
                value = text,
                onValueChange = {
                    text = it.take(MAX_QUERY_LENGTH)
                    vm.setQuery(text)
                },
                singleLine = true,
                textStyle = MaterialTheme.typography.titleLarge.copy(color = PzfColors.Text),
                cursorBrush = SolidColor(PzfColors.Text),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(onSearch = { toResults() }, onDone = { toResults() }),
                modifier = Modifier
                    .fillMaxWidth()
                    .focusRequester(field)
                    .onFocusChanged { fieldFocused = it.isFocused }
                    // A text field keeps Down for its cursor even on one line: with the keyboard closed
                    // (Back), Down must still reach the results below.
                    .onPreviewKeyEvent { e ->
                        if (e.type == KeyEventType.KeyDown && e.key == Key.DirectionDown) {
                            hideKeyboard(keyboard, view)
                            focusManager.moveFocus(FocusDirection.Down)
                        } else {
                            false
                        }
                    }
                    .testTag("search-field"),
            )
        }
        when (val r = result) {
            SearchViewModel.Result.Idle -> Status(Txt.SEARCH_HINT)
            is SearchViewModel.Result.Loading -> Status(Txt.LOADING)
            is SearchViewModel.Result.Failed -> ErrorPanel(Txt.error(r.error), listOf(Txt.RETRY to vm::retry))
            is SearchViewModel.Result.Ready -> if (r.items.isEmpty()) {
                Status(Txt.searchEmpty(r.query))
            } else {
                Status(Txt.searchResults(r.items.size))
                ItemGrid(
                    r.items,
                    container.connection?.base,
                    onOpen = {
                        hideKeyboard(keyboard, view)
                        onOpen(it.id)
                    },
                    first = firstCard,
                )
            }
        }
    }
    // Back from a result: the focus goes to the results, not to the field (which would open the keyboard again).
    val hasResults = remember { (vm.result.value as? SearchViewModel.Result.Ready)?.items?.isNotEmpty() == true }
    InitialFocus(if (hasResults) firstCard else field)
}

@Composable
private fun Status(text: String) {
    Text(text, style = MaterialTheme.typography.bodyLarge, color = PzfColors.Muted, modifier = Modifier.testTag("search-status"))
}
