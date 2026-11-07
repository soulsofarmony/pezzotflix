package probe

import dev.pezzotflix.api.infrastructure.Serializer
import kotlinx.serialization.json.Json

fun generatedJson(): Json = Serializer.kotlinxSerializationJson
fun fixedJson(): Json = fixedJsonBase(Serializer.kotlinxSerializationAdapters)
