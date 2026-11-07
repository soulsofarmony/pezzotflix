package dev.pezzotflix.tv.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** What a screen shows of one server call. A reload keeps the previous value on screen until the new one arrives. */
sealed interface Load<out T> {
    data object Loading : Load<Nothing>
    data class Ready<T>(val value: T) : Load<T>
    data class Failed(val error: Throwable) : Load<Nothing>
}

/** A screen's ViewModel around one call; [reload] cancels the call in flight. */
abstract class LoadViewModel<T> : ViewModel() {
    private val _state = MutableStateFlow<Load<T>>(Load.Loading)
    val state: StateFlow<Load<T>> = _state.asStateFlow()
    private var job: Job? = null

    protected abstract suspend fun fetch(): T

    fun reload(quiet: Boolean = false) {
        job?.cancel()
        if (!quiet || _state.value !is Load.Ready) _state.value = Load.Loading
        job = viewModelScope.launch {
            _state.value = try {
                Load.Ready(fetch())
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // A quiet refresh that fails keeps what is on screen.
                if (quiet && _state.value is Load.Ready) return@launch
                Load.Failed(e)
            }
        }
    }
}
