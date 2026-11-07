// Root build: plugin versions only. Kotlin 2.4.21 on the classpath is also what AGP 9's built-in Kotlin uses.
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.android.library) apply false
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.openapi.generator) apply false
}

// Windows path length: `-PpzfBuildRoot=C:/pzf-build` moves every build directory to a short path.
providers.gradleProperty("pzfBuildRoot").orNull?.let { root ->
    allprojects {
        layout.buildDirectory.set(file("$root/${if (path == ":") "root" else name}"))
    }
}
