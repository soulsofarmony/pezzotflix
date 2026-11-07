package dev.pezzotflix.tv

import android.app.Application
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import coil3.ImageLoader
import coil3.PlatformContext
import coil3.SingletonImageLoader
import coil3.memory.MemoryCache
import coil3.network.okhttp.OkHttpNetworkFetcherFactory

class PezzotflixApp : Application(), SingletonImageLoader.Factory {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
        // Events: polled in the foreground only (doc 05 §8.8).
        ProcessLifecycleOwner.get().lifecycle.addObserver(
            object : DefaultLifecycleObserver {
                override fun onStart(owner: LifecycleOwner) = container.setForeground(true)
                override fun onStop(owner: LifecycleOwner) = container.setForeground(false)
            },
        )
    }

    /** Coil with an explicit memory cap: with largeHeap its default would take about a quarter of 512 MB (doc 05 §8.10). */
    override fun newImageLoader(context: PlatformContext): ImageLoader = ImageLoader.Builder(context)
        .memoryCache { MemoryCache.Builder().maxSizeBytes(IMAGE_CACHE_BYTES).build() }
        .components { add(OkHttpNetworkFetcherFactory(callFactory = { container.http })) }
        .build()

    companion object {
        const val IMAGE_CACHE_BYTES = 64L * 1024 * 1024
    }
}
