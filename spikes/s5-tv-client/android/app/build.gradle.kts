// S5 throwaway probe app. AGP 9 has built-in Kotlin: no kotlin-android plugin.
plugins {
    id("com.android.application")
}

val media3 = "1.11.1"

android {
    namespace = "dev.pezzotflix.s5probe"
    compileSdk = 36
    buildToolsVersion = "37.0.0"
    defaultConfig {
        applicationId = "dev.pezzotflix.s5probe"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1-s5"
        // Q6: -PlargeHeap=false gives the default 192 MB Java heap; the installed APK keeps largeHeap (512 MB).
        manifestPlaceholders["largeHeap"] = (project.findProperty("largeHeap") ?: "true").toString()
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            // Throwaway: release build (not debuggable, like a product build) signed with the debug key.
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    lint {
        checkReleaseBuilds = false
        abortOnError = false
    }
}

dependencies {
    implementation("androidx.media3:media3-exoplayer:$media3")
    implementation("androidx.media3:media3-exoplayer-hls:$media3")
    implementation("androidx.media3:media3-ui:$media3")
    // FFmpeg audio decoder extension, prebuilt by Jellyfin (GPL-3.0, built against Media3 1.9.0).
    implementation("org.jellyfin.media3:media3-ffmpeg-decoder:1.9.0+1")
}
