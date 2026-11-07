// :api — Kotlin client generated from the contract bundle at every build (ADR 0008 point 4, doc 05 §8.8), plus the
// hand-written facade the app uses. `gradlew :api:check` is the gate for every change of the contract bundle:
// it regenerates, compiles and runs the request-body tests against the bundle schema.
import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.openapitools.generator.gradle.plugin.tasks.GenerateTask

plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.openapi.generator)
}

val bundle = rootProject.layout.projectDirectory.file("../../services/video/contract/dist/openapi.json")
val generatedDir = layout.buildDirectory.dir("generated/openapi")

val generateApi = tasks.named<GenerateTask>("openApiGenerate") {
    generatorName.set("kotlin")
    library.set("jvm-retrofit2")
    // A file URI: the parser rejects the space in "Personal Repo" in a plain path.
    inputSpec.set(bundle.asFile.toURI().toString())
    outputDir.set(generatedDir)
    packageName.set("dev.pezzotflix.api")
    typeMappings.set(mapOf("AnyType" to "JsonElement", "number" to "kotlin.Double", "integer" to "kotlin.Long"))
    // The fully qualified name inside typeMappings yields a mangled type (K1): import it instead.
    importMappings.set(mapOf("JsonElement" to "kotlinx.serialization.json.JsonElement"))
    additionalProperties.set(
        mapOf(
            "serializationLibrary" to "kotlinx_serialization",
            "enumUnknownDefaultCase" to "true",
            "useCoroutines" to "true",
            "dateLibrary" to "string",
            "omitGradleWrapper" to "true",
            "sourceFolder" to "src/main/kotlin",
        ),
    )
    generateApiTests.set(false)
    generateModelTests.set(false)
    generateApiDocumentation.set(false)
    generateModelDocumentation.set(false)
    cleanupOutput.set(true)
    // Only the generated APIs and models are used: the app builds Retrofit itself (ADR 0008 point 4), and the
    // generated ApiClient would add a body-logging interceptor and two more dependencies. The generated Serializer
    // and its adapters serve only that ApiClient (one of them calls a constructor deprecated since JDK 20).
    openapiGeneratorIgnoreList.set(
        listOf(
            "build.gradle",
            "settings.gradle",
            "proguard-rules.pro",
            "README.md",
            "docs/**",
            "src/main/kotlin/dev/pezzotflix/api/infrastructure/ApiClient.kt",
            "src/main/kotlin/dev/pezzotflix/api/infrastructure/Serializer.kt",
            "src/main/kotlin/dev/pezzotflix/api/infrastructure/*Adapter.kt",
            "src/main/kotlin/dev/pezzotflix/api/auth/**",
        ),
    )
}

kotlin {
    sourceSets.named("main") { kotlin.srcDir(generatedDir.map { it.dir("src/main/kotlin") }) }
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
        allWarningsAsErrors.set(true)
    }
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

tasks.named("compileKotlin") { dependsOn(generateApi) }

dependencies {
    api(libs.retrofit)
    api(libs.okhttp)
    api(libs.kotlinx.serialization.json)
    api(libs.kotlinx.coroutines.core)
    implementation(libs.retrofit.kotlinx.serialization)

    testImplementation(libs.junit)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.json.schema.validator)
}

tasks.test {
    // The schema tests read the versioned bundle, the same file the generator reads.
    inputs.file(bundle)
    systemProperty("pzf.contractBundle", bundle.asFile.path)
    maxHeapSize = "512m"
}
