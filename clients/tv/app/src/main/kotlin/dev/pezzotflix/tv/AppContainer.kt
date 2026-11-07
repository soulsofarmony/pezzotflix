package dev.pezzotflix.tv

import android.app.Application
import android.content.Context
import android.os.Build
import android.util.Log
import dev.pezzotflix.tv.api.AppEvent
import dev.pezzotflix.tv.api.AuthInterceptor
import dev.pezzotflix.tv.api.EventPoller
import dev.pezzotflix.tv.api.HttpClients
import dev.pezzotflix.tv.api.ServerUrl
import dev.pezzotflix.tv.api.TokenStore
import dev.pezzotflix.tv.api.VideoApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import okhttp3.HttpUrl
import okhttp3.OkHttpClient

const val LOG_TAG = "PZF"

/** What the TV remembers: server address, profile token and name (doc 05 §8.8). Nothing else lives on the device. */
class AppPrefs(context: Context) : TokenStore {
    private val prefs = context.getSharedPreferences("pezzotflix", Context.MODE_PRIVATE)

    var serverUrl: String?
        get() = prefs.getString("serverUrl", null)
        set(value) = prefs.edit().putString("serverUrl", value).apply()

    val profileName: String? get() = prefs.getString("profileName", null)

    fun saveProfile(token: String, id: String, name: String) =
        prefs.edit().putString("profileToken", token).putString("profileId", id).putString("profileName", name).apply()

    override fun token(): String? = prefs.getString("profileToken", null)

    override fun clear() = prefs.edit().remove("profileToken").apply()
}

/**
 * Launch extras for tests on the Android emulator, honoured by debug builds and by any build on the emulator (so a
 * release APK can be proven there), never by a release build on a real device:
 * `adb shell am start -n dev.pezzotflix.tv/.MainActivity --ez pzf.softwareDecoders true --es pzf.openItem <itemId>`.
 * - softwareDecoders: declare software video decoders too (the emulator has no hardware one);
 * - openItem: open that item's detail on top of Home.
 */
data class DebugOptions(val softwareDecoders: Boolean = false) {
    companion object {
        /** The Android emulator's virtual hardware (goldfish, then ranchu). */
        fun isEmulator(): Boolean = Build.HARDWARE == "ranchu" || Build.HARDWARE == "goldfish"

        fun allowed(): Boolean = BuildConfig.DEBUG || isEmulator()
    }
}

/** One server: its API facade and its event poller. */
class Connection(val base: HttpUrl, val api: VideoApi, val poller: EventPoller)

/** Manual wiring (no DI framework): one base OkHttpClient, derived clients, the app-wide scope and event flows. */
class AppContainer(val app: Application) {
    val prefs = AppPrefs(app)
    /** Base client: Coil and Media3 use it as is (no Bearer: the data plane carries the session token in the path). */
    val http: OkHttpClient = HttpClients.base()
    /** Outlives the screens: event polling and the StopPlayback of a player that is going away. */
    val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    private val _events = MutableSharedFlow<AppEvent>(extraBufferCapacity = 64)
    val events: SharedFlow<AppEvent> = _events.asSharedFlow()

    /** Bumped when the library may have changed (events, a reset cursor, the end of a playback): screens reload. */
    private val _libraryVersion = MutableStateFlow(0)
    val libraryVersion: StateFlow<Int> = _libraryVersion.asStateFlow()

    /** A 401 cleared the profile token: back to the profile choice. */
    // A channel, not a SharedFlow: a 401 that arrives before AppNav collects (a fast first call) must not be lost.
    private val _signedOut = Channel<Unit>(Channel.CONFLATED)
    val signedOut: Flow<Unit> = _signedOut.receiveAsFlow()

    var connection: Connection? = null
        private set

    /** From the launch extras (MainActivity), when [DebugOptions.allowed]. */
    var debug = DebugOptions()

    /** An item to open on top of Home (debug launch extra); AppNav takes it. */
    val openItem = MutableStateFlow<String?>(null)
    private var foreground = false
    private var playing = false

    init {
        prefs.serverUrl?.let { ServerUrl.normalize(it) }?.let { connect(it) }
    }

    fun connect(base: HttpUrl): Connection {
        connection?.poller?.stop()
        val auth = AuthInterceptor(prefs) { _signedOut.trySend(Unit) }
        val api = VideoApi(HttpClients.retrofit(base, HttpClients.api(http, auth)))
        val poller = EventPoller(
            list = { cursor, limit -> api.listEvents(cursor, limit) },
            onEvents = { events ->
                events.forEach { _events.tryEmit(it) }
                if (events.any { it.touchesLibrary }) libraryChanged()
            },
            onReset = { libraryChanged() },
            log = { msg, e -> Log.w(LOG_TAG, msg, e) },
        )
        return Connection(base, api, poller).also { connection = it }
    }

    fun libraryChanged() {
        _libraryVersion.value += 1
    }

    /** Polling needs a profile token (listEvents is not public). */
    fun startEvents() {
        val c = connection ?: return
        if (prefs.token() == null) return
        c.poller.setForeground(foreground)
        c.poller.setPlaying(playing)
        c.poller.start(appScope)
    }

    fun stopEvents() {
        connection?.poller?.stop()
    }

    fun setForeground(value: Boolean) {
        foreground = value
        connection?.poller?.setForeground(value)
    }

    fun setPlaying(value: Boolean) {
        playing = value
        connection?.poller?.setPlaying(value)
    }

    fun launch(block: suspend CoroutineScope.() -> Unit) = appScope.launch(block = block)
}
