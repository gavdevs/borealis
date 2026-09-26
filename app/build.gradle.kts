plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
    alias(libs.plugins.light.sdk)
}

val lightSdkPath = providers.gradleProperty("borealis.sdkPath").getOrElse("../light-sdk")
val releaseKeystorePath = providers.environmentVariable("BOREALIS_RELEASE_KEYSTORE").orNull

fun requiredReleaseEnvironment(name: String): String =
    providers.environmentVariable(name).orNull?.takeIf { it.isNotBlank() }
        ?: error("$name must be set when BOREALIS_RELEASE_KEYSTORE is configured")

android {
    compileSdk = 36

    signingConfigs {
        create("lightsdkDev") {
            storeFile = rootProject.file("$lightSdkPath/sdk/keys/lightsdk-dev.jks")
            storePassword = "android"
            keyAlias = "lightsdk-dev"
            keyPassword = "android"
            enableV3Signing = true
            enableV4Signing = true
        }

        if (!releaseKeystorePath.isNullOrBlank()) {
            create("release") {
                storeFile = file(releaseKeystorePath)
                storePassword = requiredReleaseEnvironment("BOREALIS_RELEASE_STORE_PASSWORD")
                keyAlias = requiredReleaseEnvironment("BOREALIS_RELEASE_KEY_ALIAS")
                keyPassword = requiredReleaseEnvironment("BOREALIS_RELEASE_KEY_PASSWORD")
                enableV3Signing = true
                enableV4Signing = true
            }
        }
    }

    defaultConfig {
        minSdk = 34
        targetSdk = 36
        manifestPlaceholders["sdkVersion"] = property("sdkVersion") as String
        buildConfigField(
            "String",
            "BOREALIS_COMPANION_URL",
            "\"${providers.gradleProperty("borealis.companionUrl").getOrElse("http://10.0.2.2:8787")}\"",
        )
        buildConfigField(
            "String",
            "BOREALIS_DISPENSER_URL",
            "\"${providers.gradleProperty("borealis.dispenserUrl").getOrElse("https://auroraoss.com/api/auth")}\"",
        )
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        getByName("debug") {
            signingConfig = signingConfigs.getByName("lightsdkDev")
        }
        getByName("release") {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
            signingConfig = if (releaseKeystorePath.isNullOrBlank()) {
                signingConfigs.getByName("lightsdkDev")
            } else {
                signingConfigs.getByName("release")
            }
        }
    }

    lint {
        warningsAsErrors = false
        error += "RestrictedApi"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    implementation(libs.sdk.client)
    implementation(libs.gplayapi) {
        exclude(group = "com.google.protobuf", module = "protobuf-javalite")
    }
    // GPlayAPI's generated lite messages run on the full protobuf runtime too.
    // The Light SDK push connector already uses the full runtime; this direct,
    // pinned dependency aligns its version so only one implementation is packaged.
    implementation(libs.protobuf.java)
    testImplementation(libs.kotlin.test)
    testImplementation(libs.kotlinx.coroutines.test)
}
