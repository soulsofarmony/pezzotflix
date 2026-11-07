// :player — Media3, capabilities read from the platform, track matching, failure classification and the
// PlayerController state machine (doc 05 §8.9, §8.10). AGP 9 has built-in Kotlin: no kotlin-android plugin.
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.library)
}

android {
    namespace = "dev.pezzotflix.tv.player"
    // 37: OkHttp 5.5.1 (okhttp-android) requires it to compile; targetSdk stays 36.
    compileSdk = 37
    buildToolsVersion = "37.0.0"
    defaultConfig {
        minSdk = 30
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    testOptions {
        unitTests.isIncludeAndroidResources = true
    }
    lint {
        abortOnError = true
        checkDependencies = false
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
        allWarningsAsErrors.set(true)
        // Media3's @UnstableApi is a lint check, not a compiler one; opt in here for the few Kotlin-level ones.
        optIn.add("kotlinx.coroutines.ExperimentalCoroutinesApi")
    }
}

dependencies {
    api(project(":api"))
    api(libs.media3.exoplayer)
    implementation(libs.media3.exoplayer.hls)
    implementation(libs.media3.datasource.okhttp)
    implementation(libs.kotlinx.coroutines.android)

    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    testImplementation(libs.kotlinx.coroutines.test)
}

// The capability tests read the S5 snapshots where the spike left them, not a copy.
val s5Dir = rootProject.layout.projectDirectory.dir("../../docs/spikes/S5-tv-client")
tasks.withType<Test>().configureEach {
    inputs.dir(s5Dir)
    systemProperty("pzf.s5Dir", s5Dir.asFile.path)
    maxHeapSize = "1g"
}
