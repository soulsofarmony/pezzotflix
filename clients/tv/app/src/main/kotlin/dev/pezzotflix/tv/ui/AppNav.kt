package dev.pezzotflix.tv.ui

import android.util.Log
import android.view.KeyEvent as AndroidKeyEvent
import androidx.compose.animation.ContentTransform
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.lifecycle.viewmodel.navigation3.rememberViewModelStoreNavEntryDecorator
import androidx.navigation3.runtime.entryProvider
import androidx.navigation3.runtime.rememberSaveableStateHolderNavEntryDecorator
import androidx.navigation3.ui.NavDisplay
import dev.pezzotflix.tv.AppContainer
import dev.pezzotflix.tv.BuildConfig
import dev.pezzotflix.tv.LOG_TAG
import dev.pezzotflix.tv.ui.player.PlayerScreen
import kotlinx.coroutines.flow.combine

/** The app's places. The back stack lives in memory: a restarted app opens Home (or the step that is missing). */
sealed interface Screen {
    data object Server : Screen
    data object Profiles : Screen
    data object Home : Screen
    data class Item(val id: String) : Screen
    data object Search : Screen
    data object Watchlist : Screen
    data class Player(val itemId: String, val title: String, val startPositionMs: Long?, val versionCount: Int?) : Screen
}

/** Where the app opens: the server address and the profile are remembered (doc 05 §8.8). */
fun startScreen(container: AppContainer): Screen = when {
    container.connection == null -> Screen.Server
    container.prefs.token() == null -> Screen.Profiles
    else -> Screen.Home
}

/** Replaces the whole back stack: after choosing the server or the profile there is no way back to the previous step. */
fun SnapshotStateList<Screen>.resetTo(screen: Screen) {
    clear()
    add(screen)
}

/** Back from [screen] when it is still on top (a late callback of a screen already left does nothing). */
private fun pop(backStack: SnapshotStateList<Screen>, screen: Screen) {
    if (backStack.size > 1 && backStack.lastOrNull() == screen) backStack.removeAt(backStack.lastIndex)
}

/**
 * [restart]: called once a new server address is saved, instead of navigating on. MainActivity recreates itself: on
 * Android 11 the window keeps the soft keyboard "requested" after Gboard hides itself, and shows it again at the next
 * relayout (the player's SurfaceView), over the film and eating the D-pad. A new window starts clean.
 */
@Composable
fun AppNav(container: AppContainer, restart: (() -> Unit)? = null) {
    val backStack = remember { mutableStateListOf(startScreen(container)) }
    LaunchedEffect(Unit) {
        if (backStack.lastOrNull() == Screen.Home) container.startEvents()
        // A 401 cleared the profile token: choose the profile again.
        container.signedOut.collect {
            container.stopEvents()
            backStack.resetTo(Screen.Profiles)
        }
    }
    LaunchedEffect(Unit) {
        // Debug launch extra: an item to open on top of Home, once a profile is chosen.
        combine(container.openItem, snapshotFlow { backStack.lastOrNull() }) { id, top -> id to top }.collect { (id, top) ->
            if (id != null && top == Screen.Home) {
                container.openItem.value = null
                backStack.add(Screen.Item(id))
            }
        }
    }
    val keyLog = if (BuildConfig.DEBUG) {
        Modifier.onPreviewKeyEvent { e ->
            Log.d(LOG_TAG, "key ${AndroidKeyEvent.keyCodeToString(e.nativeKeyEvent.keyCode)} action=${e.nativeKeyEvent.action}")
            false
        }
    } else {
        Modifier
    }
    Box(Modifier.fillMaxSize().background(PzfColors.Background).then(keyLog)) {
        NavDisplay(
            backStack = backStack,
            onBack = { if (backStack.size > 1) backStack.removeAt(backStack.lastIndex) },
            entryDecorators = listOf(
                rememberSaveableStateHolderNavEntryDecorator(),
                rememberViewModelStoreNavEntryDecorator(),
            ),
            // No animation: the TV's SoC is slow and focus lands sooner.
            transitionSpec = { ContentTransform(EnterTransition.None, ExitTransition.None) },
            popTransitionSpec = { ContentTransform(EnterTransition.None, ExitTransition.None) },
            entryProvider = entryProvider {
                entry<Screen.Server> {
                    ServerScreen(container, onConnected = { restart?.invoke() ?: backStack.resetTo(Screen.Profiles) })
                }
                entry<Screen.Profiles> {
                    ProfilesScreen(
                        container,
                        onSelected = {
                            container.startEvents()
                            backStack.resetTo(Screen.Home)
                        },
                        onChangeServer = { backStack.resetTo(Screen.Server) },
                    )
                }
                entry<Screen.Home> {
                    HomeScreen(
                        container,
                        onOpen = { backStack.add(Screen.Item(it)) },
                        onSearch = { backStack.add(Screen.Search) },
                        onWatchlist = { backStack.add(Screen.Watchlist) },
                        onSwitchProfile = {
                            container.stopEvents()
                            backStack.resetTo(Screen.Profiles)
                        },
                        onChangeServer = {
                            container.stopEvents()
                            backStack.resetTo(Screen.Server)
                        },
                    )
                }
                entry<Screen.Item> { key ->
                    ItemScreen(
                        container,
                        key.id,
                        onPlay = { backStack.add(it) },
                        onOpen = { backStack.add(Screen.Item(it)) },
                        onReplaced = { id -> if (backStack.lastOrNull() == key) backStack[backStack.lastIndex] = Screen.Item(id) },
                        onBack = { pop(backStack, key) },
                    )
                }
                entry<Screen.Search> {
                    SearchScreen(container, onOpen = { backStack.add(Screen.Item(it)) })
                }
                entry<Screen.Watchlist> { key ->
                    WatchlistScreen(container, onOpen = { backStack.add(Screen.Item(it)) }, onBack = { pop(backStack, key) })
                }
                entry<Screen.Player> { key ->
                    PlayerScreen(container, key, onExit = { if (backStack.lastOrNull() == key) backStack.removeAt(backStack.lastIndex) })
                }
            },
        )
    }
}
