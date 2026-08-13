plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val webRoot = rootProject.projectDir.resolve("..")
val wwwDir = layout.projectDirectory.dir("src/main/assets/www")

val syncWebAssets by tasks.registering(Copy::class) {
    from(webRoot) {
        include("index.html", "favicon.svg")
    }
    from(webRoot.resolve("css")) {
        into("css")
    }
    from(webRoot.resolve("js")) {
        into("js")
    }
    into(wwwDir)
}

android {
    namespace = "com.aperture.catalog"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.aperture.catalog"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.2")
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("androidx.documentfile:documentfile:1.0.1")
}

tasks.named("preBuild").configure {
    dependsOn(syncWebAssets)
}
