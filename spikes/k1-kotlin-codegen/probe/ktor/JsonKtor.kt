package probe

import kotlinx.serialization.json.Json
import kotlinx.serialization.modules.EmptySerializersModule

// The jvm-ktor client installs ContentNegotiation with no converter: the caller must add json(...).
// "generated-default" here mirrors the retrofit2 generator's Json settings, for comparison.
fun generatedJson(): Json = Json { encodeDefaults = true; ignoreUnknownKeys = true; isLenient = true }
fun fixedJson(): Json = fixedJsonBase(EmptySerializersModule())
