package dev.pezzotflix.tv.api

import dev.pezzotflix.api.models.ChangeTracksRequest
import dev.pezzotflix.api.models.ClientCapabilities
import dev.pezzotflix.api.models.PlaybackSession
import dev.pezzotflix.api.models.StartPlaybackRequest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.POST
import retrofit2.http.Path

/**
 * The subtitle field of StartPlayback and ChangeTracks is tri-state (doc 05 §8.8): absent = the profile's
 * preferences (StartPlayback) or no change (ChangeTracks), null = off, a string = that track. The generated model has
 * `String? = null`, which cannot tell absent from null, so these two bodies go out as JsonObject.
 */
sealed interface SubtitleChoice {
    data object Default : SubtitleChoice
    data object Off : SubtitleChoice
    data class Track(val id: String) : SubtitleChoice
}

/**
 * StartPlayback and ChangeTracks with a JsonObject body. Same paths and operation ids as the generated PlaybackApi
 * (a test checks them against the bundle), so the Bearer interceptor treats them the same.
 */
interface PlaybackBodiesApi {
    @POST("video/api/v1/playback/sessions")
    suspend fun startPlayback(@Body body: JsonObject): Response<PlaybackSession>

    @POST("video/api/v1/playback/sessions/{sessionId}/tracks")
    suspend fun changeTracks(@Path("sessionId") sessionId: String, @Body body: JsonObject): Response<PlaybackSession>
}

/** What the player asks StartPlayback for; positions on the original timeline. */
data class StartRequest(
    val itemId: String,
    val capabilities: ClientCapabilities,
    val fileId: String? = null,
    val audioTrackId: String? = null,
    val subtitle: SubtitleChoice = SubtitleChoice.Default,
    val startPositionMs: Long? = null,
)

/** A ChangeTracks: null audio and Default subtitle leave that dimension as it is. */
data class TrackChange(
    val audioTrackId: String? = null,
    val subtitle: SubtitleChoice = SubtitleChoice.Default,
    val positionMs: Long? = null,
)

object PlaybackBodies {
    fun startPlayback(r: StartRequest): JsonObject {
        val model = StartPlaybackRequest(
            itemId = r.itemId,
            capabilities = r.capabilities,
            fileId = r.fileId,
            audioTrackId = r.audioTrackId,
            startPositionMs = r.startPositionMs?.coerceAtLeast(0),
        )
        return withSubtitle(ApiJson.encodeToJsonElement(StartPlaybackRequest.serializer(), model).jsonObject, r.subtitle)
    }

    fun changeTracks(c: TrackChange): JsonObject {
        val model = ChangeTracksRequest(audioTrackId = c.audioTrackId, positionMs = c.positionMs?.coerceAtLeast(0))
        return withSubtitle(ApiJson.encodeToJsonElement(ChangeTracksRequest.serializer(), model).jsonObject, c.subtitle)
    }

    private fun withSubtitle(body: JsonObject, choice: SubtitleChoice): JsonObject = when (choice) {
        SubtitleChoice.Default -> JsonObject(body - "subtitleTrackId")
        SubtitleChoice.Off -> JsonObject(body + ("subtitleTrackId" to JsonNull))
        is SubtitleChoice.Track -> JsonObject(body + ("subtitleTrackId" to JsonPrimitive(choice.id)))
    }
}
