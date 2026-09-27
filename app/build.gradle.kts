import java.net.URI
import java.security.KeyStore
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.cert.X509Certificate

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
val companionUrl = providers.gradleProperty("borealis.companionUrl").getOrElse("http://10.0.2.2:8787")
val fastPrerelease = providers.gradleProperty("borealis.fastPrerelease").map {
    require(it == "true" || it == "false") { "borealis.fastPrerelease must be true or false" }
    it == "true"
}.getOrElse(false)
val prereleaseVersionPattern = Regex("""(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)-(alpha|beta|rc)\.[1-9][0-9]*""")
require(!fastPrerelease || prereleaseVersionPattern.matches(android.defaultConfig.versionName.orEmpty())) {
    "Fast prerelease builds require an alpha.N, beta.N, or rc.N version in lighttool.toml"
}

fun buildConfigUrl(value: String): String {
    require(value.none { it == '"' || it == '\\' || it.isISOControl() }) { "Build URL contains unsafe characters" }
    return "\"$value\""
}

fun requiredReleaseEnvironment(name: String): String =
    providers.environmentVariable(name).orNull?.takeIf { it.isNotBlank() }
        ?: error("$name must be set when BOREALIS_RELEASE_KEYSTORE is configured")

val validateReleaseConfiguration = tasks.register("validateReleaseConfiguration") {
    group = "verification"
    description = "Reject missing/development signing keys and nonproduction companion URLs."
    doLast {
        check(System.getProperty("lightSdk.unsigned") != "true") { "Borealis releases must be signed; lightSdk.unsigned is forbidden" }
        val service = URI(companionUrl)
        check(service.scheme == "https" && service.host == "borealis.loosewire.dev" &&
            service.port == -1 && service.userInfo == null && service.query == null && service.fragment == null &&
            (service.path.isNullOrEmpty() || service.path == "/")) {
            "Release companion URL must be https://borealis.loosewire.dev without credentials, port, query, or fragment"
        }
        val keystorePath = releaseKeystorePath?.takeIf { it.isNotBlank() }
            ?: error("BOREALIS_RELEASE_KEYSTORE is required for release builds; development-key fallback is disabled")
        check(fastPrerelease == prereleaseVersionPattern.matches(android.defaultConfig.versionName.orEmpty())) {
            "Prerelease versions require borealis.fastPrerelease=true; stable versions must use the minified release lane"
        }
        val releaseBuild = android.buildTypes.getByName("release")
        check(!releaseBuild.isDebuggable && releaseBuild.isMinifyEnabled == !fastPrerelease &&
            releaseBuild.isShrinkResources == !fastPrerelease) {
            "Release build flags do not match the stable/fast-prerelease policy"
        }
        val keystoreFile = file(keystorePath)
        check(keystoreFile.isFile) { "Release keystore does not exist" }
        val devFile = rootProject.file("$lightSdkPath/sdk/keys/lightsdk-dev.jks")
        check(keystoreFile.canonicalFile != devFile.canonicalFile) { "The public Light SDK development keystore cannot sign a release" }
        val alias = requiredReleaseEnvironment("BOREALIS_RELEASE_KEY_ALIAS")
        check(!alias.contains("debug", ignoreCase = true) && !alias.contains("lightsdk-dev", ignoreCase = true)) {
            "A dedicated Borealis release key alias is required"
        }
        val store = KeyStore.getInstance(keystoreFile, requiredReleaseEnvironment("BOREALIS_RELEASE_STORE_PASSWORD").toCharArray())
        check(store.getKey(alias, requiredReleaseEnvironment("BOREALIS_RELEASE_KEY_PASSWORD").toCharArray()) is PrivateKey) {
            "The release alias must contain a private key"
        }
        val certificate = store.getCertificate(alias) as? X509Certificate ?: error("Release signing certificate is missing")
        certificate.checkValidity()
        check(!certificate.subjectX500Principal.name.contains("Android Debug", ignoreCase = true)) {
            "Android debug certificates cannot sign a release"
        }
        if (devFile.isFile) {
            val devStore = KeyStore.getInstance(devFile, "android".toCharArray())
            check(!certificate.encoded.contentEquals(devStore.getCertificate("lightsdk-dev").encoded)) {
                "The public Light SDK development certificate cannot sign a release, even under a different alias"
            }
        }
        val expected = requiredReleaseEnvironment("BOREALIS_RELEASE_CERT_SHA256").replace(":", "").lowercase()
        check(expected.matches(Regex("[0-9a-f]{64}"))) { "BOREALIS_RELEASE_CERT_SHA256 must be the dedicated certificate SHA-256 fingerprint" }
        val actual = MessageDigest.getInstance("SHA-256").digest(certificate.encoded).joinToString("") { "%02x".format(it) }
        check(actual == expected) { "Release certificate does not match the pinned signing identity" }
    }
}

// Guard every release variant entry point, including direct packaging tasks.
tasks.configureEach {
    if (name.contains("Release", ignoreCase = true) && name != "validateReleaseConfiguration") {
        dependsOn(validateReleaseConfiguration)
    }
}

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
            buildConfigUrl(companionUrl),
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
            isDebuggable = false
            isMinifyEnabled = !fastPrerelease
            isShrinkResources = !fastPrerelease
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
            signingConfig = signingConfigs.findByName("release")
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

tasks.register("writeReleaseBuildMetadata") {
    group = "verification"
    description = "Record the actual release build flags for artifact verification."
    dependsOn("assembleRelease")
    val report = layout.buildDirectory.file("reports/release-build.json")
    outputs.file(report)
    // Always regenerate alongside the APK, including a rerun with different flags.
    outputs.upToDateWhen { false }
    doLast {
        val releaseBuild = android.buildTypes.getByName("release")
        val target = report.get().asFile
        target.parentFile.mkdirs()
        target.writeText("""
            {
              "schemaVersion": 1,
              "variant": "release",
              "versionName": ${buildConfigUrl(android.defaultConfig.versionName.orEmpty())},
              "versionCode": ${android.defaultConfig.versionCode},
              "companionUrl": ${buildConfigUrl(companionUrl)},
              "fastPrerelease": $fastPrerelease,
              "minified": ${releaseBuild.isMinifyEnabled},
              "shrinkResources": ${releaseBuild.isShrinkResources},
              "debuggable": ${releaseBuild.isDebuggable}
            }
        """.trimIndent() + "\n")
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
    // LP3 cannot import Ed25519 keys through JCA; verify jobs with Tink directly.
    implementation(libs.tink)
    testImplementation(libs.kotlin.test)
    testImplementation(libs.kotlinx.coroutines.test)
}
