package dev.pezzotflix.tv.api

import dev.pezzotflix.api.apis.CatalogApi
import dev.pezzotflix.api.apis.PlaybackApi
import dev.pezzotflix.api.apis.ProfilesApi
import dev.pezzotflix.api.apis.SystemApi
import dev.pezzotflix.api.models.EventPage
import dev.pezzotflix.api.models.FallbackRequest
import dev.pezzotflix.api.models.Home
import dev.pezzotflix.api.models.ItemDetail
import dev.pezzotflix.api.models.ItemSummary
import dev.pezzotflix.api.models.PlaybackSession
import dev.pezzotflix.api.models.Profile
import dev.pezzotflix.api.models.ProfileSelection
import dev.pezzotflix.api.models.ProgressReport
import dev.pezzotflix.api.models.ServerInfo
import dev.pezzotflix.api.models.StopRequest
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.SerializationException
import retrofit2.Response
import retrofit2.Retrofit
import java.io.IOException

/**
 * The facade the app sees (doc 05 §8.8): generated interfaces underneath, every failure as an [ApiException]
 * (RFC 9457 problem by code and status; NETWORK when nothing answered; UNEXPECTED for a body that does not decode).
 */
class VideoApi(retrofit: Retrofit) : PlaybackPort {
    private val system = retrofit.create(SystemApi::class.java)
    private val profiles = retrofit.create(ProfilesApi::class.java)
    private val catalog = retrofit.create(CatalogApi::class.java)
    private val playback = retrofit.create(PlaybackApi::class.java)
    private val bodies = retrofit.create(PlaybackBodiesApi::class.java)

    suspend fun serverInfo(): ServerInfo = body { system.getServerInfo() }
    suspend fun listProfiles(): List<Profile> = body { profiles.listProfiles() }.profiles
    suspend fun selectProfile(profileId: String): ProfileSelection = body { profiles.selectProfile(profileId) }
    suspend fun home(): Home = body { catalog.getHome() }
    suspend fun item(itemId: String): ItemDetail = body { catalog.getItem(itemId) }
    suspend fun nextUp(seriesId: String): ItemSummary? = body { catalog.getNextUp(seriesId) }.item
    suspend fun listEvents(cursor: String?, limit: Long): EventPage = body { system.listEvents(cursor, limit) }

    override suspend fun startPlayback(request: StartRequest): PlaybackSession =
        body { bodies.startPlayback(PlaybackBodies.startPlayback(request)) }

    override suspend fun reportProgress(sessionId: String, report: ProgressReport) =
        noContent { playback.reportProgress(sessionId, report) }

    override suspend fun stopPlayback(sessionId: String, positionMs: Long) =
        noContent { playback.stopPlayback(sessionId, StopRequest(positionMs.coerceAtLeast(0))) }

    override suspend fun changeTracks(sessionId: String, change: TrackChange): PlaybackSession =
        body { bodies.changeTracks(sessionId, PlaybackBodies.changeTracks(change)) }

    override suspend fun reportPlaybackFailure(sessionId: String, request: FallbackRequest): PlaybackSession =
        body { playback.reportPlaybackFailure(sessionId, request) }

    override suspend fun terminateSession(sessionId: String) = noContent { playback.terminateSession(sessionId) }

    private suspend fun <T : Any> body(call: suspend () -> Response<T>): T {
        val r = send(call)
        return r.body() ?: throw ApiException(status = r.code(), code = "UNEXPECTED", detail = "empty body")
    }

    private suspend fun noContent(call: suspend () -> Response<Unit>) {
        send(call)
    }

    private suspend fun <T> send(call: suspend () -> Response<T>): Response<T> {
        val r = try {
            call()
        } catch (e: CancellationException) {
            throw e
        } catch (e: IOException) {
            throw ApiException.network(e)
        } catch (e: SerializationException) {
            throw ApiException(status = -1, code = "UNEXPECTED", detail = e.message, cause = e)
        }
        if (r.isSuccessful) return r
        val text = try {
            r.errorBody()?.string()
        } catch (_: IOException) {
            null
        }
        throw ApiException.fromResponse(r.code(), text, r.headers()["Retry-After"])
    }
}
