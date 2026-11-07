package dev.pezzotflix.tv.api

import kotlinx.serialization.json.Json

/**
 * The one Json of the client (ADR 0008 point 4). explicitNulls = false and encodeDefaults = false keep the
 * generated models' `null` defaults out of request bodies (the server rejects `"app": null`, K1); absent nullable
 * fields decode as null; unknown fields are ignored (the contract grows additively, doc 03 P8).
 */
val ApiJson: Json = Json {
    explicitNulls = false
    encodeDefaults = false
    ignoreUnknownKeys = true
}
