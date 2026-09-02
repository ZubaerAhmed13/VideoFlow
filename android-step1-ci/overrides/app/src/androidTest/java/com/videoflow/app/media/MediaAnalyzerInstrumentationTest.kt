package com.videoflow.app.media

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.videoflow.app.data.media.CorruptedMediaException
import com.videoflow.app.data.media.MediaAnalyzer
import com.videoflow.app.data.media.UnsupportedMediaException
import com.videoflow.app.test.TestMediaProvider
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class MediaAnalyzerInstrumentationTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val analyzer = MediaAnalyzer(context)

    @Test
    fun contentUriVideoAndAudioMetadataIsRead() = runBlocking {
        val result = analyzer.analyze(TestMediaProvider.uri("sample_av.mp4"))
        assertEquals("video/mp4", result.mimeType)
        assertEquals(320, result.metadata.width)
        assertEquals(240, result.metadata.height)
        assertTrue(result.metadata.videoTracks.isNotEmpty())
        assertTrue(result.metadata.audioTracks.isNotEmpty())
        assertNotNull(result.metadata.durationUs)
        assertTrue((result.metadata.frameRate ?: 0.0) > 20.0)
    }

    @Test
    fun videoWithoutAudioDoesNotCrash() = runBlocking {
        val result = analyzer.analyze(TestMediaProvider.uri("sample_video_only.mp4"))
        assertTrue(result.metadata.videoTracks.isNotEmpty())
        assertTrue(result.metadata.audioTracks.isEmpty())
    }

    @Test
    fun malformedMediaProducesControlledFailure() = runBlocking {
        val failure = runCatching { analyzer.analyze(TestMediaProvider.uri("malformed.mp4")) }.exceptionOrNull()
        assertTrue(failure is CorruptedMediaException || failure is UnsupportedMediaException)
    }

    @Test
    fun rotatedFixtureIsReadableAndRotationIsNeverFabricated() {
        runBlocking {
            val result = analyzer.analyze(TestMediaProvider.uri("sample_rotated.mp4"))
            assertTrue(result.metadata.videoTracks.isNotEmpty())
            result.metadata.rotationDegrees?.let { rotation ->
                assertTrue(rotation in setOf(0, 90, 180, 270))
            }
        }
    }
}
