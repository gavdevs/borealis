package com.gav.borealis.delivery

import com.aurora.gplayapi.data.models.PlayFile
import com.thelightphone.sdk.install.LightPackageArtifact
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URI
import java.security.MessageDigest
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

data class DownloadedPlayArtifacts(
    val base: LightPackageArtifact,
    val splits: List<LightPackageArtifact>,
)

data class ArtifactDownloadProgress(
    val currentFile: Int,
    val totalFiles: Int,
    val downloadedBytes: Long,
    val totalBytes: Long,
)

class ExpiredDeliveryUrlException : Exception("The Google Play delivery URL expired.")

class PlayArtifactDownloader(private val filesDir: File) {
    suspend fun download(
        jobId: String,
        playFiles: List<PlayFile>,
        onProgress: (ArtifactDownloadProgress) -> Unit = {},
    ): DownloadedPlayArtifacts = withContext(Dispatchers.IO) {
        require(SAFE_ID.matches(jobId)) { "Invalid job identifier." }
        val baseFiles = playFiles.filter { it.type == PlayFile.Type.BASE }
        val splitFiles = playFiles.filter { it.type == PlayFile.Type.SPLIT }
        require(baseFiles.size == 1) { "Google Play must return exactly one base APK." }
        require(playFiles.size == baseFiles.size + splitFiles.size) {
            "This delivery contains unsupported expansion or patch files."
        }
        require(playFiles.isNotEmpty() && playFiles.size <= MAX_ARTIFACTS) {
            "The Play delivery returned an invalid number of files."
        }
        require(playFiles.map { it.name }.distinct().size == playFiles.size) {
            "The Play delivery returned duplicate file names."
        }
        val totalBytes = playFiles.sumOf { file ->
            require(file.size in 1..MAX_ARTIFACT_BYTES) { "The Play delivery contains an invalid file size." }
            require(file.sha256.matches(SHA256) || file.sha1.matches(SHA1)) {
                "The Play delivery omitted an artifact checksum."
            }
            file.size
        }
        require(totalBytes in 1..MAX_TOTAL_BYTES) { "The Play delivery is too large." }

        val relativeDirectory = "borealis/jobs/$jobId"
        val directory = resolvePrivate(relativeDirectory)
        directory.deleteRecursively()
        require(directory.mkdirs()) { "Could not create the private download directory." }

        var downloadedBytes = 0L
        try {
            val ordered = baseFiles + splitFiles
            val artifacts = ordered.mapIndexed { index, playFile ->
                val targetName = if (index == 0) "base.apk" else "split-${index.toString().padStart(3, '0')}.apk"
                val relativePath = "$relativeDirectory/$targetName"
                val target = resolvePrivate(relativePath)
                downloadOne(playFile, target) { fileBytes ->
                    onProgress(
                        ArtifactDownloadProgress(
                            currentFile = index + 1,
                            totalFiles = ordered.size,
                            downloadedBytes = downloadedBytes + fileBytes,
                            totalBytes = totalBytes,
                        ),
                    )
                }
                downloadedBytes += playFile.size
                LightPackageArtifact(name = targetName, relativePath = relativePath)
            }
            DownloadedPlayArtifacts(base = artifacts.first(), splits = artifacts.drop(1))
        } catch (error: Exception) {
            directory.deleteRecursively()
            throw error
        }
    }

    fun delete(jobId: String) {
        if (SAFE_ID.matches(jobId)) resolvePrivate("borealis/jobs/$jobId").deleteRecursively()
    }

    private fun downloadOne(playFile: PlayFile, target: File, onBytes: (Long) -> Unit) {
        val uri = runCatching { URI(playFile.url) }
            .getOrElse { throw IllegalArgumentException("Google Play returned an invalid delivery URL.") }
        require(uri.scheme == "https" && !uri.host.isNullOrBlank()) {
            "Google Play returned an unsafe delivery URL."
        }
        val connection = uri.toURL().openConnection() as HttpURLConnection
        connection.connectTimeout = 15_000
        connection.readTimeout = 60_000
        connection.instanceFollowRedirects = true
        connection.requestMethod = "GET"
        val temp = File(target.parentFile, "${target.name}.part")
        temp.delete()
        try {
            val status = connection.responseCode
            if (status == 403 || status == 410) throw ExpiredDeliveryUrlException()
            require(status in 200..299) { "Artifact download failed (HTTP $status)." }
            val declaredLength = connection.contentLengthLong
            if (declaredLength > 0L) {
                require(declaredLength == playFile.size) { "Artifact download size changed." }
            }

            val algorithm = if (playFile.sha256.matches(SHA256)) "SHA-256" else "SHA-1"
            val expected = if (algorithm == "SHA-256") playFile.sha256 else playFile.sha1
            val digest = MessageDigest.getInstance(algorithm)
            var written = 0L
            connection.inputStream.use { input ->
                FileOutputStream(temp).use { output ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        val count = input.read(buffer)
                        if (count < 0) break
                        require(written + count <= playFile.size) { "Artifact download exceeded its expected size." }
                        output.write(buffer, 0, count)
                        digest.update(buffer, 0, count)
                        written += count
                        onBytes(written)
                    }
                    output.fd.sync()
                }
            }
            require(written == playFile.size) { "Artifact download stopped before it was complete." }
            val actual = digest.digest().joinToString("") { byte -> "%02x".format(byte) }
            require(actual == expected.lowercase()) { "Artifact checksum verification failed." }
            Files.move(
                temp.toPath(),
                target.toPath(),
                StandardCopyOption.ATOMIC_MOVE,
                StandardCopyOption.REPLACE_EXISTING,
            )
        } finally {
            connection.disconnect()
            temp.delete()
        }
    }

    private fun resolvePrivate(relativePath: String): File {
        require(!relativePath.startsWith('/') && !relativePath.contains('\\')) { "Invalid private path." }
        val root = filesDir.canonicalFile
        val candidate = File(root, relativePath).canonicalFile
        require(candidate.path.startsWith(root.path + File.separator)) { "Private path escaped app storage." }
        return candidate
    }

    private companion object {
        val SAFE_ID = Regex("^[A-Za-z0-9_-]{16,128}$")
        val SHA256 = Regex("^[0-9a-fA-F]{64}$")
        val SHA1 = Regex("^[0-9a-fA-F]{40}$")
        const val MAX_ARTIFACTS = 256
        const val MAX_ARTIFACT_BYTES = 2L * 1024 * 1024 * 1024
        const val MAX_TOTAL_BYTES = 4L * 1024 * 1024 * 1024
    }
}
