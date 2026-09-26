import java.security.MessageDigest

// Export the artifacts actually resolved for the release, not the whole cache.
allprojects {
    if (path == ":app") {
        tasks.register("writeReleaseDependencyProvenance") {
            group = "verification"
            val releaseRuntimeClasspath = providers.provider {
                configurations.getByName("releaseRuntimeClasspath")
            }
            // Let Gradle schedule included-project artifact producers before hashing.
            dependsOn(releaseRuntimeClasspath)
            doLast {
                val output = rootProject.file("release-output/runtime-dependencies.tsv")
                output.parentFile.mkdirs()
                val artifacts = releaseRuntimeClasspath.get()
                    .resolvedConfiguration.resolvedArtifacts
                    .sortedBy { "${it.moduleVersion.id}:${it.classifier.orEmpty()}:${it.extension}" }
                output.bufferedWriter().use { writer ->
                    writer.appendLine("coordinate\tartifact\tsha256")
                    artifacts.forEach { artifact ->
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
                        writer.appendLine("${artifact.moduleVersion.id}\t${artifact.file.name}\t$hash")
                    }
                }
            }
        }
    }
}
