package dev.pezzotflix.tv.ui.player

import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.pezzotflix.api.models.ClientCapabilities
import dev.pezzotflix.tv.AppContainer
import dev.pezzotflix.tv.BuildConfig
import dev.pezzotflix.tv.LOG_TAG
import dev.pezzotflix.tv.api.ApiJson
import dev.pezzotflix.tv.player.Media3Engine
import dev.pezzotflix.tv.player.PlayerController
import dev.pezzotflix.tv.player.caps.CapabilityMapper
import dev.pezzotflix.tv.player.caps.PlatformFacts
import dev.pezzotflix.tv.ui.Screen
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * One player screen: the engine, the controller and their wiring to the app (events, polling interval, library
 * refresh). Clearing it (leaving the screen) closes the session: StopPlayback runs on the app scope.
 */
class PlayerViewModel(private val container: AppContainer, args: Screen.Player) : ViewModel() {
    private val connection = container.connection ?: error("no server")

    val engine: Media3Engine = Media3Engine(
        context = container.app,
        http = container.http,
        server = connection.base,
        declaredHdr = { controller.state.value.capabilities?.hdr.orEmpty() },
        log = { Log.i(LOG_TAG, it) },
        verbose = BuildConfig.DEBUG,
    )

    val controller: PlayerController = PlayerController(
        api = connection.api,
        engine = engine,
        // Read at every start: the audio output (AVR on or off) and the display can change between sessions.
        capabilities = {
            withContext(Dispatchers.Default) {
                val facts = PlatformFacts.read(container.app, BuildConfig.VERSION_NAME)
                CapabilityMapper.map(facts, softwareDecoders = BuildConfig.DEBUG && container.debug.softwareDecoders).also {
                    Log.i(LOG_TAG, "capabilities ${ApiJson.encodeToString(ClientCapabilities.serializer(), it)}")
                }
            }
        },
        scope = viewModelScope,
        releaseScope = container.appScope,
        log = { Log.i(LOG_TAG, it) },
        onClosed = { container.libraryChanged() },
    )

    init {
        viewModelScope.launch { container.events.collect { controller.onEvent(it) } }
        viewModelScope.launch {
            controller.state.map { controller.hasActiveSession() }.distinctUntilChanged().collect { container.setPlaying(it) }
        }
        controller.start(
            PlayerController.StartOptions(itemId = args.itemId, startPositionMs = args.startPositionMs, versionCount = args.versionCount),
        )
    }

    override fun onCleared() {
        controller.close()
        engine.release()
        container.setPlaying(false)
    }
}
