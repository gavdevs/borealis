import java.security.MessageDigest
import org.gradle.api.artifacts.component.ModuleComponentIdentifier
import org.gradle.api.artifacts.component.ProjectComponentIdentifier
import org.gradle.api.artifacts.result.ResolvedArtifactResult
import org.gradle.api.artifacts.result.UnresolvedDependencyResult
import org.gradle.api.artifacts.type.ArtifactTypeDefinition

data class ProvenanceArtifact(val coordinate: String, val file: File)
data class SdkArchive(val component: ProjectComponentIdentifier, val file: File)

fun projectArtifactType(component: ProjectComponentIdentifier): String =
    when (component.projectPath) {
        ":sdk:client", ":sdk:ui", ":sdk:server" -> "aar"
        ":sdk:shared" -> ArtifactTypeDefinition.JAR_TYPE
        else -> error("Unrecognized runtime project ${component.buildTreePath}; declare its provenance artifact type")
    }

fun coordinate(artifact: ResolvedArtifactResult): String =
    when (val component = artifact.id.componentIdentifier) {
        is ModuleComponentIdentifier -> "${component.group}:${component.module}:${component.version}"
        is ProjectComponentIdentifier -> "project${component.buildTreePath}"
        else -> error("Unsupported runtime component ${component.displayName}")
    }

// Both variants exercise the same strict selection logic. CI can verify Debug
// without release credentials; Release retains the app's signing guard.
allprojects {
    if (path == ":app") {
        for (variant in listOf("debug", "release")) {
            val taskVariant = variant.replaceFirstChar { it.uppercaseChar() }
            tasks.register("write${taskVariant}DependencyProvenance") {
                group = "verification"
                val runtimeClasspath = providers.provider {
                    configurations.getByName("${variant}RuntimeClasspath")
                }
                val sdkBuild = gradle.includedBuild("light-sdk")
                val selectedSdkProjects = runtimeClasspath.map { configuration ->
                    val expectedSdkDirectory = rootProject.file(
                        providers.gradleProperty("borealis.sdkPath").getOrElse("../light-sdk"),
                    ).canonicalFile
                    check(sdkBuild.projectDir.canonicalFile == expectedSdkDirectory) {
                        "Included Light SDK directory does not match borealis.sdkPath"
                    }
                    val resolution = configuration.incoming.resolutionResult
                    resolution.allDependencies.filterIsInstance<UnresolvedDependencyResult>()
                        .firstOrNull()?.let {
                            throw GradleException("Unresolved runtime dependency ${it.attempted.displayName}", it.failure)
                        }
                    val rootId = resolution.rootComponent.get().id
                    resolution.allComponents.map { it.id }
                        .filterIsInstance<ProjectComponentIdentifier>()
                        .filter { it != rootId }
                        .onEach { component ->
                            check(component.build.buildPath == ":${sdkBuild.name}") {
                                "Unexpected runtime build ${component.build.buildPath}"
                            }
                            projectArtifactType(component) // Reject unrecognized project paths.
                        }
                }
                // Leave external dependencies' artifact types untouched: hash the
                // original selected AAR/JAR files, not AGP's transformed classes.
                val externalArtifacts = runtimeClasspath.map { configuration ->
                    configuration.incoming.artifactView {
                        componentFilter { it !is ProjectComponentIdentifier }
                    }.artifacts
                }
                // The shared module is JVM: select its actual JAR instead of its
                // classes directory. Keep artifact resolution strict.
                val sharedArtifacts = runtimeClasspath.map { configuration ->
                    configuration.incoming.artifactView {
                        componentFilter {
                            it is ProjectComponentIdentifier &&
                                projectArtifactType(it) == ArtifactTypeDefinition.JAR_TYPE
                        }
                        attributes.attribute(ArtifactTypeDefinition.ARTIFACT_TYPE_ATTRIBUTE, ArtifactTypeDefinition.JAR_TYPE)
                    }.artifacts
                }
                // AGP 8.12.3 does not expose normal AARs on local runtimeElements.
                // Select Android projects from the dependency graph, then build
                // their normal bundles explicitly (not the different lint AARs).
                val sdkArchives = selectedSdkProjects.map { components ->
                    components.filter { projectArtifactType(it) == "aar" }.map { component ->
                        val module = component.projectPath.substringAfterLast(':')
                        val archive = File(sdkBuild.projectDir, "sdk/$module/build/outputs/aar/$module-$variant.aar")
                        check(archive.canonicalFile.toPath().startsWith(sdkBuild.projectDir.canonicalFile.toPath())) {
                            "SDK archive escapes the included build directory"
                        }
                        SdkArchive(component, archive)
                    }
                }
                dependsOn(sdkArchives.map { archives ->
                    archives.map { sdkBuild.task("${it.component.projectPath}:bundle${taskVariant}Aar") }
                })
                inputs.files(sdkArchives.map { archives -> archives.map { it.file } })
                    .withPropertyName("sdkArchives")
                val artifactCollections = listOf(externalArtifacts, sharedArtifacts)
                artifactCollections.forEachIndexed { index, artifacts ->
                    val files = artifacts.map { it.artifactFiles }
                    // FileCollections retain the selected JAR producer tasks.
                    // Never depend on the unqualified runtime configuration itself.
                    inputs.files(files).withPropertyName("runtimeArtifacts$index")
                    dependsOn(files)
                }
                doLast {
                    val output = if (variant == "release") {
                        rootProject.file("release-output/runtime-dependencies.tsv")
                    } else {
                        layout.buildDirectory.file("reports/dependency-provenance/debug.tsv").get().asFile
                    }
                    output.parentFile.mkdirs()
                    val artifacts = (artifactCollections.flatMap { it.get().artifacts }
                        .map { ProvenanceArtifact(coordinate(it), it.file) } +
                        sdkArchives.get().map { ProvenanceArtifact("project${it.component.buildTreePath}", it.file) })
                        .sortedWith(compareBy({ it.coordinate }, { it.file.name }))
                    output.bufferedWriter().use { writer ->
                        writer.appendLine("coordinate\tartifact\tsha256")
                        artifacts.forEach { artifact ->
                            check(artifact.file.isFile) { "Missing runtime artifact ${artifact.coordinate}: ${artifact.file.name}" }
                            val digest = MessageDigest.getInstance("SHA-256")
                            artifact.file.inputStream().use { input ->
                                val buffer = ByteArray(65536)
                                while (true) {
                                    val size = input.read(buffer)
                                    if (size < 0) break
                                    digest.update(buffer, 0, size)
                                }
                            }
                            val hash = digest.digest().joinToString("") { "%02x".format(it) }
                            writer.appendLine("${artifact.coordinate}\t${artifact.file.name}\t$hash")
                        }
                    }
                }
            }
        }
    }
}
