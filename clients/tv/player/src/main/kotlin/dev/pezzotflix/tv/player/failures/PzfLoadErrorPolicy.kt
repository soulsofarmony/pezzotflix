package dev.pezzotflix.tv.player.failures

import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.ParserException
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.HttpDataSource
import androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy
import androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy
import dev.pezzotflix.tv.api.ApiException
import java.io.FileNotFoundException

/**
 * Load errors as doc 05 §8.10 wants them ([LoadRetry]): 503 waits for Retry-After, any other HTTP status is fatal at
 * once (the controller re-plans or restarts), no answer backs off, and nothing is excluded as a fallback (the server
 * decides what plays).
 */
@OptIn(UnstableApi::class)
class PzfLoadErrorPolicy : DefaultLoadErrorHandlingPolicy() {
    override fun getRetryDelayMsFor(loadErrorInfo: LoadErrorHandlingPolicy.LoadErrorInfo): Long {
        val e = loadErrorInfo.exception
        val http = e as? HttpDataSource.InvalidResponseCodeException
        val retryAfter = http?.headerFields?.entries?.firstOrNull { it.key.equals("Retry-After", ignoreCase = true) }?.value?.firstOrNull()
        val network = http == null && e !is ParserException && e !is FileNotFoundException &&
            e !is HttpDataSource.CleartextNotPermittedException && e !is HttpDataSource.InvalidContentTypeException
        return LoadRetry.delayMs(http?.responseCode, network, loadErrorInfo.errorCount, ApiException.parseRetryAfter(retryAfter))
            ?: C.TIME_UNSET
    }

    /** The delays above decide when a load gives up; the loader must not surface the error earlier. */
    override fun getMinimumLoadableRetryCount(dataType: Int): Int = Int.MAX_VALUE / 2

    override fun getFallbackSelectionFor(
        fallbackOptions: LoadErrorHandlingPolicy.FallbackOptions,
        loadErrorInfo: LoadErrorHandlingPolicy.LoadErrorInfo,
    ): LoadErrorHandlingPolicy.FallbackSelection? = null
}
