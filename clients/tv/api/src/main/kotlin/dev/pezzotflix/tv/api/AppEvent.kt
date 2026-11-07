package dev.pezzotflix.tv.api

import dev.pezzotflix.api.models.Event
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** Event.type narrowed to what the app acts on (doc 05 §8.8, web §7.7); unknown types are kept and ignored. */
sealed interface AppEvent {
    val seq: Long

    data class ItemAdded(override val seq: Long, val itemId: String?) : AppEvent
    data class ItemUpdated(override val seq: Long, val itemId: String?, val reason: String?) : AppEvent
    data class ItemRemoved(override val seq: Long, val itemId: String?, val replacedBy: String?) : AppEvent
    data class IngestProgress(override val seq: Long, val phase: String?) : AppEvent
    data class NeedsReview(override val seq: Long) : AppEvent
    data class SessionTerminated(override val seq: Long, val sessionId: String?, val reason: String?) : AppEvent
    data class SubtitleReady(override val seq: Long, val sessionId: String?, val trackId: String?, val availability: String?) : AppEvent
    data class Other(override val seq: Long, val type: String) : AppEvent

    /** Events that change what the library screens show. */
    val touchesLibrary: Boolean
        get() = this is ItemAdded || this is ItemUpdated || this is ItemRemoved || this is IngestProgress

    companion object {
        fun of(e: Event): AppEvent {
            val p = e.payload
            fun s(key: String): String? = (p[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
            return when (e.type) {
                "library.item_added" -> ItemAdded(e.seq, s("itemId"))
                "library.item_updated" -> ItemUpdated(e.seq, s("itemId"), s("reason"))
                "library.item_removed" -> ItemRemoved(e.seq, s("itemId"), s("replacedBy"))
                "ingest.progress" -> IngestProgress(e.seq, s("phase"))
                "identification.needs_review" -> NeedsReview(e.seq)
                "playback.session_terminated" -> SessionTerminated(e.seq, s("sessionId"), s("reason"))
                "playback.subtitle_ready" -> SubtitleReady(e.seq, s("sessionId"), s("trackId"), s("availability"))
                else -> Other(e.seq, e.type)
            }
        }
    }
}
