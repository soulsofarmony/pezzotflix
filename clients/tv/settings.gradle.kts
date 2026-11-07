// Pezzotflix TV client (ADR 0008, doc 07 F3a): :app (UI), :player (Media3, capabilities, re-planning),
// :api (client generated from the contract bundle, plus a hand-written facade).
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "pezzotflix-tv"
include(":app", ":player", ":api")
