package dev.pezzotflix.tv

import android.content.Intent
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import dev.pezzotflix.tv.ui.AppNav
import dev.pezzotflix.tv.ui.PzfTheme

class MainActivity : ComponentActivity() {
    private val container: AppContainer get() = (application as PezzotflixApp).container

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        readDebugExtras(intent)
        setContent {
            PzfTheme { AppNav(container, restart = ::recreate) }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        readDebugExtras(intent)
    }

    /** Debug builds, or any build on the Android emulator (to prove a release APK there): see [DebugOptions]. */
    private fun readDebugExtras(intent: Intent?) {
        if (!DebugOptions.allowed() || intent == null) return
        if (intent.hasExtra(EXTRA_SOFTWARE_DECODERS)) {
            container.debug = container.debug.copy(softwareDecoders = intent.getBooleanExtra(EXTRA_SOFTWARE_DECODERS, false))
        }
        intent.getStringExtra(EXTRA_OPEN_ITEM)?.let { container.openItem.value = it }
        Log.d(LOG_TAG, "debug options ${container.debug}, open item ${container.openItem.value}")
    }

    // Debug builds log the window focus (and AppNav the remote's keys): the first thing to look at when the remote "does nothing".
    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (BuildConfig.DEBUG) Log.d(LOG_TAG, "window focus $hasFocus")
    }

    private companion object {
        const val EXTRA_SOFTWARE_DECODERS = "pzf.softwareDecoders"
        const val EXTRA_OPEN_ITEM = "pzf.openItem"
    }
}
