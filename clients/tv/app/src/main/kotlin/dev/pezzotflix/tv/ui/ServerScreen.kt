package dev.pezzotflix.tv.ui

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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import dev.pezzotflix.tv.AppContainer
import dev.pezzotflix.tv.api.ServerUrl
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class ServerViewModel(private val container: AppContainer) : ViewModel() {
    data class State(val busy: Boolean = false, val error: String? = null)

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    val saved: String = container.prefs.serverUrl?.removePrefix("http://")?.removeSuffix("/").orEmpty()

    /** GetServerInfo answers: the address is saved; a different server forgets the profile chosen on the old one. */
    fun connect(text: String, onConnected: () -> Unit) {
        if (_state.value.busy) return
        val base = ServerUrl.normalize(text)
        if (base == null) {
            _state.value = State(error = Txt.SERVER_INVALID)
            return
        }
        _state.value = State(busy = true)
        viewModelScope.launch {
            val c = container.connect(base)
            try {
                c.api.serverInfo()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _state.value = State(error = Txt.error(e))
                return@launch
            }
            if (container.prefs.serverUrl != base.toString()) container.prefs.clear()
            container.prefs.serverUrl = base.toString()
            _state.value = State()
            onConnected()
        }
    }
}

@Composable
fun ServerScreen(container: AppContainer, onConnected: () -> Unit) {
    val vm = viewModel { ServerViewModel(container) }
    val state by vm.state.collectAsState()
    var text by remember { mutableStateOf(vm.saved) }
    var fieldFocused by remember { mutableStateOf(false) }
    val field = remember { FocusRequester() }
    val button = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    val view = LocalView.current
    val connect = {
        // Close the keyboard and take the focus off the field before leaving; the Activity then starts a new window
        // (AppNav's restart), because Android 11 would show the keyboard again later (seen on the TV emulator, API 30).
        keyboard?.hide()
        view.context.getSystemService(InputMethodManager::class.java)?.hideSoftInputFromWindow(view.windowToken, 0)
        runCatching { button.requestFocus() }
        vm.connect(text, onConnected)
    }

    Box(Modifier.fillMaxSize().padding(48.dp), contentAlignment = Alignment.Center) {
        Column(Modifier.widthIn(max = 720.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
            Text(Txt.APP, style = MaterialTheme.typography.displaySmall)
            Text(Txt.SERVER_TITLE, style = MaterialTheme.typography.headlineMedium)
            Text(Txt.SERVER_HINT, style = MaterialTheme.typography.bodyLarge, color = PzfColors.Muted)
            Box(
                Modifier
                    .fillMaxWidth()
                    .background(PzfColors.Surface, RoundedCornerShape(8.dp))
                    .border(BorderStroke(3.dp, if (fieldFocused) PzfColors.Focus else Color(0xFF55555E)), RoundedCornerShape(8.dp))
                    .padding(horizontal = 16.dp, vertical = 14.dp),
            ) {
                if (text.isEmpty()) Text(Txt.SERVER_PLACEHOLDER, style = MaterialTheme.typography.titleLarge, color = PzfColors.Muted)
                BasicTextField(
                    value = text,
                    onValueChange = { text = it },
                    singleLine = true,
                    textStyle = MaterialTheme.typography.titleLarge.copy(color = PzfColors.Text),
                    cursorBrush = SolidColor(PzfColors.Text),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go, autoCorrectEnabled = false),
                    keyboardActions = KeyboardActions(onGo = { connect() }, onDone = { connect() }),
                    modifier = Modifier
                        .fillMaxWidth()
                        .focusRequester(field)
                        .onFocusChanged { fieldFocused = it.isFocused }
                        .testTag("server-url"),
                )
            }
            state.error?.let { Text(it, style = MaterialTheme.typography.bodyLarge, color = PzfColors.Warning) }
            PzfButton(
                if (state.busy) Txt.LOADING else Txt.SERVER_CONNECT,
                { connect() },
                Modifier.focusRequester(button),
                enabled = !state.busy,
                primary = true,
            )
        }
    }
    // A remembered address: the focus goes to "Collegati" and the keyboard stays closed.
    InitialFocus(if (vm.saved.isEmpty()) field else button)
}
