package dev.pezzotflix.tv.api

import io.github.optimumcode.json.schema.ErrorCollector
import io.github.optimumcode.json.schema.JsonSchema
import io.github.optimumcode.json.schema.ValidationError
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File

/** The versioned contract bundle, read where the generator reads it (system property set by the build). */
object Contract {
    val bundle: JsonObject by lazy {
        val path = System.getProperty("pzf.contractBundle") ?: error("pzf.contractBundle is not set: run the tests with Gradle")
        Json.parseToJsonElement(File(path).readText()).jsonObject
    }

    /** OpenAPI 3.1 schemas are JSON Schema 2020-12: the component schemas become $defs of a wrapper schema. */
    private val defs: String by lazy {
        bundle.getValue("components").jsonObject.getValue("schemas").toString().replace("\"#/components/schemas/", "\"#/\$defs/")
    }

    private val cache = mutableMapOf<String, JsonSchema>()

    fun schema(name: String): JsonSchema = cache.getOrPut(name) {
        JsonSchema.fromDefinition(
            """{"${'$'}schema":"https://json-schema.org/draft/2020-12/schema","${'$'}defs":$defs,"${'$'}ref":"#/${'$'}defs/$name"}""",
        )
    }

    /** Validation errors of [value] against the component schema [name]; empty when valid. */
    fun errors(name: String, value: JsonElement): List<String> {
        val out = mutableListOf<ValidationError>()
        schema(name).validate(value, ErrorCollector { out.add(it) })
        return out.map { "${it.objectPath}: ${it.message}" }
    }

    data class Operation(val method: String, val path: String, val operationId: String, val public: Boolean)

    val operations: List<Operation> by lazy {
        val globalSecurity = bundle["security"] as? JsonArray
        bundle.getValue("paths").jsonObject.flatMap { (path, item) ->
            item.jsonObject.filterKeys { it in setOf("get", "post", "put", "patch", "delete") }.map { (method, op) ->
                val o = op.jsonObject
                val security = (o["security"] as? JsonArray) ?: globalSecurity
                Operation(method.uppercase(), path, o.getValue("operationId").jsonPrimitive.content, security != null && security.isEmpty())
            }
        }
    }
}
