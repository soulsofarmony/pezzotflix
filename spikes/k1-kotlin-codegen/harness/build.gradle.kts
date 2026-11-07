// K1 (throwaway): compiles each generated Kotlin client with the probe and runs it.
// Subproject name = generated variant under /gen (see run.sh).
plugins {
    kotlin("jvm") version "2.4.21" apply false
    kotlin("plugin.serialization") version "2.4.21" apply false
}

subprojects {
    apply(plugin = "org.jetbrains.kotlin.jvm")
    apply(plugin = "org.jetbrains.kotlin.plugin.serialization")
    apply(plugin = "application")

    val variant = name
    val ktor = variant.startsWith("ktor")

    extensions.configure<org.jetbrains.kotlin.gradle.dsl.KotlinJvmProjectExtension> {
        jvmToolchain(21)
        sourceSets["main"].kotlin.srcDir("/gen/$variant/src/main/kotlin")
        sourceSets["main"].kotlin.srcDir(if (ktor) "/probe/ktor" else "/probe/retrofit")
        sourceSets["main"].kotlin.srcDir("/probe/common")
    }
    extensions.configure<JavaApplication> { mainClass.set("probe.ProbeKt") }

    dependencies {
        "implementation"("org.jetbrains.kotlinx:kotlinx-serialization-json:1.12.0")
        "implementation"("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.11.0")
        if (ktor) {
            "implementation"("io.ktor:ktor-client-core:3.6.1")
            "implementation"("io.ktor:ktor-client-content-negotiation:3.6.1")
            "implementation"("io.ktor:ktor-serialization-kotlinx-json:3.6.1")
            "implementation"("io.ktor:ktor-client-okhttp:3.6.1")
        } else {
            "implementation"("com.squareup.retrofit2:retrofit:3.0.0")
            "implementation"("com.squareup.retrofit2:converter-kotlinx-serialization:3.0.0")
            "implementation"("com.squareup.retrofit2:converter-scalars:3.0.0")
            "implementation"("com.squareup.okhttp3:okhttp:5.5.1")
            "implementation"("com.squareup.okhttp3:logging-interceptor:5.5.1")
        }
    }
}
