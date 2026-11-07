package dev.pezzotflix.tv.api

import okhttp3.HttpUrl
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Response
import retrofit2.Invocation
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory
import java.util.concurrent.TimeUnit

/**
 * Operations with `security: []` in the contract: no Bearer (doc 05 §8.8). A test checks this set against the bundle.
 * Retrofit's Invocation tag names the interface method, and generated methods are named after the operationId.
 * The admin and data-plane ones are listed for completeness: the TV calls neither through Retrofit.
 */
val PUBLIC_OPERATIONS: Set<String> = setOf(
    "getHealth", "getServerInfo", "listProfiles", "createProfile", "updateProfile", "deleteProfile", "selectProfile",
    "listLibraryRoots", "confirmRootContents", "forgetMissingFiles", "triggerScan", "getIngestStatus", "retryJob",
    "listIdentificationCases", "getIdentificationCase", "resolveCase", "ignoreCase", "searchProvider", "listMediaFiles",
    "getMediaFileDetails", "forgetMediaFile", "explainPlaybackDecision",
    "getMediaFile", "getHlsResource", "getSubtitle", "getImage",
)

/** Where the profile token lives (SharedPreferences in the app, a field in tests). */
interface TokenStore {
    fun token(): String?
    fun clear()
}

/**
 * Adds the profile Bearer to non-public operations and `Accept-Language: it-IT` to every control-plane call (the
 * server's reasons and problems are Italian for the viewer). A 401 on a call that carried the token clears it:
 * the app goes back to the profile choice.
 */
class AuthInterceptor(
    private val tokens: TokenStore,
    private val onUnauthorized: () -> Unit,
) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        val operation = request.tag(Invocation::class.java)?.method()?.name
        val builder = request.newBuilder().header("Accept-Language", "it-IT")
        val token = if (operation != null && operation in PUBLIC_OPERATIONS) null else tokens.token()
        if (token != null) builder.header("Authorization", "Bearer $token")
        val response = chain.proceed(builder.build())
        if (response.code == 401 && token != null) {
            // Only the token that was refused: a newer one picked meanwhile stays.
            if (tokens.token() == token) tokens.clear()
            onUnauthorized()
        }
        return response
    }
}

object HttpClients {
    /** The one base client: connection pool and dispatcher are shared by the derived ones. */
    fun base(): OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    /** Control plane: Bearer and Accept-Language. Media3 and Coil use [base] (data plane: the token is in the path). */
    fun api(base: OkHttpClient, auth: AuthInterceptor): OkHttpClient = base.newBuilder().addInterceptor(auth).build()

    fun retrofit(baseUrl: HttpUrl, client: OkHttpClient): Retrofit = Retrofit.Builder()
        .baseUrl(baseUrl)
        .client(client)
        .addConverterFactory(ApiJson.asConverterFactory("application/json".toMediaType()))
        .build()
}
