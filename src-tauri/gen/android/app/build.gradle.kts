import java.io.File
import java.io.FileInputStream
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

val keystoreProperties = Properties()
val keystorePropertiesFile = rootProject.file("keystore.properties")
if (keystorePropertiesFile.exists()) {
    FileInputStream(keystorePropertiesFile).use { keystoreProperties.load(it) }
}

fun signingValue(key: String, envVar: String): String? {
    val prop = keystoreProperties.getProperty(key)
    if (!prop.isNullOrBlank()) return prop
    val env = System.getenv(envVar)
    return if (env.isNullOrBlank()) null else env
}

val signingStoreFile = signingValue("storeFile", "ANDROID_KEYSTORE_FILE")
val signingAlias = signingValue("keyAlias", "ANDROID_KEY_ALIAS")
val signingStorePassword = signingValue("storePassword", "ANDROID_STORE_PASSWORD")
    ?: signingValue("password", "ANDROID_KEYSTORE_PASSWORD")
val signingKeyPassword = signingValue("keyPassword", "ANDROID_KEY_PASSWORD")
    ?: signingValue("password", "ANDROID_KEYSTORE_PASSWORD")
val hasReleaseSigning = !signingStoreFile.isNullOrBlank()
    && !signingAlias.isNullOrBlank()
    && !signingStorePassword.isNullOrBlank()
    && !signingKeyPassword.isNullOrBlank()

val resolvedSigningStoreFile = signingStoreFile?.let {
    val candidate = File(it)
    if (candidate.isAbsolute) candidate else rootProject.file(it)
}

android {
    compileSdk = 36
    namespace = "com.birdscounter.app"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "com.birdscounter.app"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                keyAlias = signingAlias
                keyPassword = signingKeyPassword
                storeFile = resolvedSigningStoreFile
                storePassword = signingStorePassword
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            isMinifyEnabled = true
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("release")
            } else {
                logger.warn(
                    "Release signing is not configured. " +
                        "Set src-tauri/gen/android/keystore.properties or ANDROID_* env vars."
                )
            }
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
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
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")
