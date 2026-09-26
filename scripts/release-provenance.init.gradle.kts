import java.security.MessageDigest
import org.gradle.api.artifacts.component.ModuleComponentIdentifier
import org.gradle.api.artifacts.component.ProjectComponentIdentifier
import org.gradle.api.artifacts.result.ResolvedArtifactResult
import org.gradle.api.artifacts.type.ArtifactTypeDefinition

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
                // Leave external dependencies' artifact types untouched: hash the
                // original selected AAR/JAR files, not AGP's transformed classes.
                val externalArtifacts = runtimeClasspath.map { configuration ->
                    configuration.incoming.artifactView {
                        componentFilter { it !is ProjectComponentIdentifier }
                    }.artifacts
                }
                // Android projects expose many artifact sets. Select their AAR
                // explicitly; the SDK shared module is JVM and instead needs JAR.
                val projectArtifacts = listOf("aar", ArtifactTypeDefinition.JAR_TYPE).map { type ->
                    runtimeClasspath.map { configuration ->
                        configuration.incoming.artifactView {
                            componentFilter {
                                it is ProjectComponentIdentifier && projectArtifactType(it) == type
                            }
                            attributes.attribute(ArtifactTypeDefinition.ARTIFACT_TYPE_ATTRIBUTE, type)
                        }.artifacts
                    }
                }
                val artifactCollections = listOf(externalArtifacts) + projectArtifacts
                artifactCollections.forEachIndexed { index, artifacts ->
                    val files = artifacts.map { it.artifactFiles }
                    // FileCollections retain the selected AAR/JAR producer tasks.
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
                    val artifacts = artifactCollections.flatMap { it.get().artifacts }
                        .sortedWith(compareBy({ coordinate(it) }, { it.file.name }))
                    output.bufferedWriter().use { writer ->
                        writer.appendLine("coordinate\tartifact\tsha256")
                        artifacts.forEach { artifact ->
                            check(artifact.file.isFile) { "Missing runtime artifact ${artifact.id.displayName}" }
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
                            writer.appendLine("${coordinate(artifact)}\t${artifact.file.name}\t$hash")
                        }
                    }
                }
            }
        }
    }
}
