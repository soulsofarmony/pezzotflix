package dev.pezzotflix.tv.ui.player

import android.graphics.Bitmap
import android.util.Log
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import coil3.SingletonImageLoader
import coil3.request.CachePolicy
import coil3.request.ImageRequest
import coil3.request.SuccessResult
import coil3.request.allowHardware
import coil3.request.bitmapConfig
import coil3.size.Size
import coil3.toBitmap
import dev.pezzotflix.api.models.ClientCapabilities
import dev.pezzotflix.tv.AppContainer
import dev.pezzotflix.tv.BuildConfig
import dev.pezzotflix.tv.DebugOptions
import dev.pezzotflix.tv.LOG_TAG
import dev.pezzotflix.tv.api.ApiJson
import dev.pezzotflix.tv.api.ServerUrl
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
                CapabilityMapper.map(facts, softwareDecoders = DebugOptions.allowed() && container.debug.softwareDecoders).also {
                    Log.i(LOG_TAG, "capabilities ${ApiJson.encodeToString(ClientCapabilities.serializer(), it)}")
                }
            }
        },
        scope = viewModelScope,
        releaseScope = container.appScope,
        log = { Log.i(LOG_TAG, it) },
        onClosed = { container.libraryChanged() },
    )

    /** The preview sheets of the current session; a re-plan (new token, new urls) empties it (see init). */
    val sheets: SheetCache<ImageBitmap> = SheetCache(viewModelScope, capacity = 2, load = ::loadSheet)

    val scrubber: Scrubber = Scrubber(
        transport = object : ScrubTransport {
            override fun positionMs() = controller.positionMs()
            override fun durationMs() = controller.state.value.durationMs
            // playWhenReady: a player buffering after a seek is still "playing" for the viewer. At the end it is not.
            override fun playing() = engine.player.playWhenReady && !controller.state.value.ended
            override fun play() = controller.play()
            override fun pause() = controller.pause()
            override fun seekTo(positionMs: Long) = controller.seekTo(positionMs)
        },
        onEnter = { positionMs ->
            controller.state.value.session?.trickplay?.let { TrickplayMath.tileAt(positionMs, it) }?.let { sheets.preload(it.url) }
        },
    )

    /**
     * One sheet through Coil and the app's data-plane OkHttp: at its original size (a resized sheet moves the
     * crops), with no disk or memory cache (the url carries the session token; [sheets] is the only cache).
     * RGB_565 and no hardware bitmap: half the memory of ARGB on the 32-bit TV, and JPEG has no alpha anyway.
     */
    private suspend fun loadSheet(locator: String): ImageBitmap? {
        val url = ServerUrl.resolve(connection.base, locator) ?: return null
        val request = ImageRequest.Builder(container.app)
            .data(url.toString())
            .size(Size.ORIGINAL)
            .memoryCachePolicy(CachePolicy.DISABLED)
            .diskCachePolicy(CachePolicy.DISABLED)
            .bitmapConfig(Bitmap.Config.RGB_565)
            .allowHardware(false)
            .build()
        val result = SingletonImageLoader.get(container.app).execute(request)
        if (result !is SuccessResult) {
            Log.w(LOG_TAG, "trickplay sheet not loaded: $locator")
            return null
        }
        return result.image.toBitmap().asImageBitmap()
    }

    init {
        viewModelScope.launch { container.events.collect { controller.onEvent(it) } }
        viewModelScope.launch {
            controller.state.map { it.session?.trickplay?.sheets }.distinctUntilChanged().collect { sheets.bind(it) }
        }
        viewModelScope.launch {
            controller.state.map { controller.hasActiveSession() }.distinctUntilChanged().collect { container.setPlaying(it) }
        }
        controller.start(
            PlayerController.StartOptions(itemId = args.itemId, startPositionMs = args.startPositionMs, versionCount = args.versionCount),
        )
    }

    override fun onCleared() {
        scrubber.abort()
        sheets.clear()
        controller.close()
        engine.release()
        container.setPlaying(false)
    }
}
