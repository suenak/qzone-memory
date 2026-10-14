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

android {
    // Strip with the same NDK that builds Rust. The AGP default may not be installed
    // locally, in which case Gradle otherwise silently packages unstripped libraries.
    val nativeNdkPath = System.getenv("ANDROID_NDK_HOME") ?: System.getenv("NDK_HOME")
    if (!nativeNdkPath.isNullOrBlank()) {
        ndkPath = nativeNdkPath
        val nativeNdkProperties = Properties().apply {
            file("$nativeNdkPath/source.properties").inputStream().use { load(it) }
        }
        ndkVersion = nativeNdkProperties.getProperty("Pkg.Revision")
    }
    compileSdk = 36
    namespace = "top.ehre.qzonearchive"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "top.ehre.qzonearchive"
        // 支持 Android 8.0 及以上；发行 APK 仅包含 ARM / ARM64；x86 模拟器使用 Debug 包。
        minSdk = 26
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
        }
        getByName("release") {
            ndk { abiFilters += setOf("arm64-v8a", "armeabi-v7a") }
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

// Intel targets remain available for emulator development, never for release.
androidComponents {
    onVariants(selector().withBuildType("debug")) { variant ->
        // BuildType has no packaging block: a nested block there affects every variant.
        variant.packaging.jniLibs.keepDebugSymbols.addAll(setOf("*/arm64-v8a/*.so", "*/armeabi-v7a/*.so", "*/x86/*.so", "*/x86_64/*.so"))
    }
    onVariants(selector().withBuildType("release")) { variant ->
        // Apply exclusions per release variant; android.packaging would affect Debug too.
        variant.packaging.jniLibs.excludes.addAll(setOf("**/x86/**", "**/x86_64/**"))
        // APKs are distributed directly. Compress native libraries to reduce download size;
        // Android extracts them at installation, so installed disk use may be higher.
        variant.packaging.jniLibs.useLegacyPackaging.set(true)
    }
    beforeVariants(selector().withBuildType("release")) { variant ->
        if (variant.productFlavors.any { (dimension, flavor) -> dimension == "abi" && flavor in setOf("x86", "x86_64") }) {
            variant.enable = false
        }
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
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")
