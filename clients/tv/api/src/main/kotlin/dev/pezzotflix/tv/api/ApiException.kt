package dev.pezzotflix.tv.api

import dev.pezzotflix.api.models.ActiveSession
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter

/**
 * A failed control-plane call: the RFC 9457 problem by code and status (ADR 0004 point 8), or NETWORK (status 0)
 * when no answer came. Codes are an open set: unknown ones are kept as strings.
 */
class ApiException(
    val status: Int,
    val code: String,
    val title: String? = null,
    val detail: String? = null,
    /** From Retry-After (seconds or HTTP date), in ms; null when absent. */
    val retryAfterMs: Long? = null,
    /** Problem extension: the error also closed the session (ChangeTracks 422, reportPlaybackFailure 503). */
    val sessionClosed: Boolean = false,
    /** SESSION_EXPIRED (410): why the session closed (expired, terminated, failed, item_removed, stopped, shutdown). */
    val reason: String? = null,
    val activeSessions: List<ActiveSession> = emptyList(),
    cause: Throwable? = null,
) : Exception("$status $code${detail?.let { ": $it" } ?: ""}", cause) {

    /** 404 or 410 on a session call: the session is closed. */
    val isClosed: Boolean get() = status == 404 || status == 410

    /** 503 STREAM_PREPARING or MEDIA_UNAVAILABLE that did not close the session: the same call again later. */
    val isRetryLater: Boolean
        get() = status == 503 && !sessionClosed && (code == "STREAM_PREPARING" || code == "MEDIA_UNAVAILABLE")

    /** A 422 on ChangeTracks/ChangeVersion that closed the session (sessionClosed, or the detail text of older servers). */
    val isClosedRefusal: Boolean
        get() = status == 422 && (sessionClosed || CLOSED_REFUSAL.containsMatchIn(detail.orEmpty()))

    companion object {
        private val CLOSED_REFUSAL = Regex("the session was closed|la sessione è stata chiusa", RegexOption.IGNORE_CASE)
        private val DEFAULT_CODES = mapOf(400 to "VALIDATION_FAILED", 401 to "UNAUTHORIZED", 404 to "NOT_FOUND", 409 to "CONFLICT", 500 to "INTERNAL")

        fun network(cause: Throwable): ApiException = ApiException(status = 0, code = "NETWORK", detail = cause.message, cause = cause)

        /** Builds the exception from a failed answer; the body is parsed leniently, as a problem or as nothing. */
        fun fromResponse(status: Int, body: String?, retryAfter: String?, nowMs: Long = System.currentTimeMillis()): ApiException {
            val problem = body?.takeIf { it.isNotBlank() }?.let { runCatching { ApiJson.parseToJsonElement(it).jsonObject }.getOrNull() }
            val code = problem.string("code") ?: DEFAULT_CODES[status] ?: "UNEXPECTED"
            val sessions = problem?.get("activeSessions")?.let { el ->
                runCatching { ApiJson.decodeFromJsonElement(ActiveSessionList, el) }.getOrNull()
            } ?: emptyList()
            return ApiException(
                status = status,
                code = code,
                title = problem.string("title"),
                detail = problem.string("detail"),
                retryAfterMs = parseRetryAfter(retryAfter, nowMs),
                sessionClosed = (problem?.get("sessionClosed") as? JsonPrimitive)?.booleanOrNull == true,
                reason = problem.string("reason")?.takeIf { it.isNotEmpty() },
                activeSessions = sessions,
            )
        }

        fun parseRetryAfter(value: String?, nowMs: Long = System.currentTimeMillis()): Long? {
            val s = value?.trim().orEmpty()
            if (s.isEmpty()) return null
            s.toLongOrNull()?.let { return if (it >= 0) it * 1000 else null }
            return runCatching {
                val at = ZonedDateTime.parse(s, DateTimeFormatter.RFC_1123_DATE_TIME).toInstant().toEpochMilli()
                (at - nowMs).coerceAtLeast(0)
            }.getOrNull()
        }

        private fun JsonObject?.string(key: String): String? = (this?.get(key) as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

        private val ActiveSessionList = kotlinx.serialization.builtins.ListSerializer(ActiveSession.serializer())
    }
}
