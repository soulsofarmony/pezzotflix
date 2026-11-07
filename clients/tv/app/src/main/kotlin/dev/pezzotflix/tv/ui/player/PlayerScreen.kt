@file:OptIn(UnstableApi::class)

package dev.pezzotflix.tv.ui.player

import android.view.KeyEvent as AndroidKeyEvent
import android.view.ViewTreeObserver
import android.view.WindowInsets
import android.view.inputmethod.InputMethodManager
import androidx.activity.compose.BackHandler
import androidx.activity.compose.LocalActivity
import androidx.annotation.OptIn
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.nativeKeyCode
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.ui.SubtitleView
import androidx.media3.ui.compose.PlayerSurface
import androidx.media3.ui.compose.modifiers.resizeWithContentScale
import androidx.media3.ui.compose.state.rememberPresentationState
import dev.pezzotflix.tv.AppContainer
import dev.pezzotflix.tv.player.CueFrame
import dev.pezzotflix.tv.player.PlayerController.Phase
import dev.pezzotflix.tv.ui.Screen
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.StateFlow

enum class Panel { AUDIO, SUBTITLES, INFO }

private val BUSY_PHASES = setOf(Phase.IDLE, Phase.STARTING, Phase.PREPARING, Phase.REPLANNING)

/**
 * The player (doc 05 §8.10): the video, the subtitles, the controls on demand and the status overlays. The remote:
 * OK or up/down show the controls; left/right seek 10 s; play/pause and the media keys always work; Back closes a
 * panel, then the controls, then the player. Leaving the screen or the Activity's onStop closes the session.
 */
@Composable
fun PlayerScreen(container: AppContainer, args: Screen.Player, onExit: () -> Unit) {
    val vm = viewModel(key = args.toString()) { PlayerViewModel(container, args) }
    val controller = vm.controller
    val player = vm.engine.player
    val state by controller.state.collectAsState()

    var controlsVisible by remember { mutableStateOf(false) }
    var panel by remember { mutableStateOf<Panel?>(null) }
    var interactions by remember { mutableIntStateOf(0) }
    val rootFocus = remember { FocusRequester() }
    val controlsFocus = remember { FocusRequester() }

    // The Activity stops (Home button, TV off, another app): the session must not hold the slot until it times out.
    val activity = LocalActivity.current
    LifecycleEventEffect(Lifecycle.Event.ON_STOP, lifecycleOwner = (activity as? LifecycleOwner) ?: androidx.lifecycle.compose.LocalLifecycleOwner.current) {
        controller.close()
        onExit()
    }

    val view = LocalView.current
    val keepOn = state.playing || state.buffering || state.phase in BUSY_PHASES
    DisposableEffect(keepOn) {
        view.keepScreenOn = keepOn
        onDispose { view.keepScreenOn = false }
    }

    // Controls hide by themselves while the film plays and nobody touches the remote.
    LaunchedEffect(controlsVisible, panel, interactions, state.playing) {
        if (controlsVisible && panel == null && state.playing) {
            delay(CONTROLS_TIMEOUT_MS)
            controlsVisible = false
        }
    }
    LaunchedEffect(controlsVisible, panel, state.phase) {
        if (state.phase != Phase.PLAYING) return@LaunchedEffect
        runCatching { if (controlsVisible && panel == null) controlsFocus.requestFocus() else if (!controlsVisible) rootFocus.requestFocus() }
    }
    LaunchedEffect(state.ended) {
        if (state.ended) controlsVisible = true
    }

    val controlsShown = controlsVisible && state.phase == Phase.PLAYING
    val back = {
        when {
            panel != null -> panel = null
            controlsShown -> controlsVisible = false
            else -> onExit()
        }
    }
    // Fallback for a press that reaches the Activity (nothing focused inside the player); the root handles the rest.
    BackHandler(enabled = panel != null || controlsShown) { back() }

    val dialog = state.phase !in BUSY_PHASES && state.phase != Phase.PLAYING && state.phase != Phase.CLOSED

    Box(
        Modifier
            .fillMaxSize()
            .background(Color.Black)
            .onPreviewKeyEvent { e ->
                if (e.key.nativeKeyCode == AndroidKeyEvent.KEYCODE_BACK) {
                    // Handled here, on release. Left to Compose, a press on a button inside the player only moves the
                    // focus out to this Box (FocusDirection.Exit) and seems lost (seen on the TV emulator).
                    if (e.type == KeyEventType.KeyUp) back()
                    return@onPreviewKeyEvent true
                }
                if (e.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                interactions++
                if (dialog) return@onPreviewKeyEvent false
                when (e.key.nativeKeyCode) {
                    AndroidKeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> controller.togglePlay().let { true }
                    AndroidKeyEvent.KEYCODE_MEDIA_PLAY -> controller.play().let { true }
                    AndroidKeyEvent.KEYCODE_MEDIA_PAUSE -> controller.pause().let { true }
                    AndroidKeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> controller.seekBy(SKIP_MS * 3).let { true }
                    AndroidKeyEvent.KEYCODE_MEDIA_REWIND -> controller.seekBy(-SKIP_MS * 3).let { true }
                    AndroidKeyEvent.KEYCODE_DPAD_LEFT, AndroidKeyEvent.KEYCODE_DPAD_RIGHT -> {
                        if (controlsVisible || panel != null) return@onPreviewKeyEvent false
                        controller.seekBy(if (e.key.nativeKeyCode == AndroidKeyEvent.KEYCODE_DPAD_LEFT) -SKIP_MS else SKIP_MS)
                        true
                    }
                    AndroidKeyEvent.KEYCODE_DPAD_CENTER, AndroidKeyEvent.KEYCODE_ENTER, AndroidKeyEvent.KEYCODE_DPAD_UP,
                    AndroidKeyEvent.KEYCODE_DPAD_DOWN, AndroidKeyEvent.KEYCODE_MENU,
                    -> {
                        if (controlsVisible || panel != null) return@onPreviewKeyEvent false
                        controlsVisible = true
                        true
                    }
                    else -> false
                }
            }
            .focusRequester(rootFocus)
            .focusable()
            .testTag("player"),
    ) {
        Video(player)
        Subtitles(vm.engine.cues)
        if (controlsVisible && state.phase == Phase.PLAYING) {
            Controls(
                title = args.title,
                state = state,
                focus = controlsFocus,
                onTogglePlay = controller::togglePlay,
                onSeek = controller::seekBy,
                onPanel = { panel = it },
            )
        }
        panel?.let { p ->
            if (state.phase == Phase.PLAYING || state.phase == Phase.PREPARING) {
                SidePanel(p, state, onAudio = { controller.selectAudio(it); panel = null }, onSubtitle = { controller.selectSubtitle(it); panel = null })
            }
        }
        StatusOverlay(
            state = state,
            onRetry = controller::retry,
            onTerminate = controller::terminateOther,
            onExit = onExit,
            onDismissNotice = controller::dismissNotice,
        )
    }
    KeepKeyboardHidden()
    LaunchedEffect(Unit) { runCatching { rootFocus.requestFocus() } }
}

@Composable
private fun Video(player: Player) {
    val presentation = rememberPresentationState(player)
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        PlayerSurface(
            player = player,
            modifier = Modifier.resizeWithContentScale(ContentScale.Fit, presentation.videoSizeDp),
        )
        if (presentation.coverSurface) Box(Modifier.fillMaxSize().background(Color.Black))
    }
}

/**
 * Media3's SubtitleView with the system caption style: text cues (SRT, WebVTT) and bitmap cues (PGS), embedded ones
 * from Media3 and those served apart from the engine's overlay.
 */
@Composable
private fun Subtitles(cues: StateFlow<CueFrame>) {
    val frame by cues.collectAsState()
    AndroidView(
        factory = { ctx ->
            SubtitleView(ctx).apply {
                setUserDefaultStyle()
                setUserDefaultTextSize()
            }
        },
        update = { it.setCues(frame.cues) },
        modifier = Modifier.fillMaxSize(),
    )
}

/**
 * The soft keyboard stays closed while the player shows: on Android 11 a keyboard closed earlier (the search field)
 * can come back at the SurfaceView's relayout, over the film and eating the D-pad (see AppNav), despite the
 * Activity's stateAlwaysHidden. Every layout pass checks the window's insets and hides it again.
 */
@Composable
private fun KeepKeyboardHidden() {
    val view = LocalView.current
    DisposableEffect(view) {
        val imm = view.context.getSystemService(InputMethodManager::class.java)
        fun hide() {
            view.windowInsetsController?.hide(WindowInsets.Type.ime())
            imm?.hideSoftInputFromWindow(view.windowToken, 0)
        }
        hide()
        val onLayout = ViewTreeObserver.OnGlobalLayoutListener {
            if (view.rootWindowInsets?.isVisible(WindowInsets.Type.ime()) == true) hide()
        }
        view.viewTreeObserver.addOnGlobalLayoutListener(onLayout)
        onDispose { view.viewTreeObserver.removeOnGlobalLayoutListener(onLayout) }
    }
}

const val SKIP_MS = 10_000L
private const val CONTROLS_TIMEOUT_MS = 5_000L
