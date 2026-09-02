package com.videoflow.app.debug

import android.content.ContentProvider
import android.content.ContentValues
import android.content.res.AssetFileDescriptor
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import java.io.File

/**
 * Debug-only content provider used by Step 1 instrumentation tests to exercise
 * the same content:// access path as a user-selected SAF document.
 *
 * This class is excluded from release builds because it lives under src/debug.
 */
class DebugMediaProvider : ContentProvider() {
    override fun onCreate(): Boolean = true

    override fun getType(uri: Uri): String = "video/mp4"

    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?
    ): Cursor {
        val file = materialize(uri)
        val columns = projection ?: arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
        return MatrixCursor(columns).apply {
            val row = newRow()
            columns.forEach { column ->
                when (column) {
                    OpenableColumns.DISPLAY_NAME -> row.add(file.name)
                    OpenableColumns.SIZE -> row.add(file.length())
                    else -> row.add(null)
                }
            }
        }
    }

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor =
        ParcelFileDescriptor.open(materialize(uri), ParcelFileDescriptor.MODE_READ_ONLY)

    override fun openAssetFile(uri: Uri, mode: String): AssetFileDescriptor {
        val file = materialize(uri)
        val descriptor = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
        return AssetFileDescriptor(descriptor, 0L, file.length())
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? = throw UnsupportedOperationException()
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0

    private fun materialize(uri: Uri): File {
        val name = requireNotNull(uri.lastPathSegment).substringAfterLast('/')
        require(name in ALLOWED_FIXTURES) { "Unsupported fixture: $name" }
        val appContext = requireNotNull(context)
        val dir = File(appContext.cacheDir, "step1-media-fixtures").apply { mkdirs() }
        val file = File(dir, name)
        if (!file.exists()) {
            appContext.assets.open(name).use { input ->
                file.outputStream().use { output ->
                    input.copyTo(output, bufferSize = 64 * 1024)
                }
            }
        }
        return file
    }

    companion object {
        private val ALLOWED_FIXTURES = setOf(
            "sample_av.mp4",
            "sample_video_only.mp4",
            "sample_rotated.mp4",
            "malformed.mp4"
        )
    }
}
