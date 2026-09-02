package com.videoflow.app.media

import android.content.Context
import android.os.Looper
import android.os.SystemClock
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.videoflow.app.test.TestMediaProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

@RunWith(AndroidJUnit4::class)
class PlayerInstrumentationTest {
    @Test
    fun media3PreparesAndSeeksAcrossFixture() {
        val context: Context = ApplicationProvider.getApplicationContext()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val fixtureUri = TestMediaProvider.uri("sample_av.mp4")

        context.contentResolver.openAssetFileDescriptor(fixtureUri, "r").use { descriptor ->
            requireNotNull(descriptor) { "ContentResolver did not return an AssetFileDescriptor" }
            assertTrue("Media fixture must have a positive declared length", descriptor.length > 0L)
        }

        val terminal = CountDownLatch(1)
        val playbackError = AtomicReference<PlaybackException?>(null)
        var player: ExoPlayer? = null

        instrumentation.runOnMainSync {
            val createdPlayer = ExoPlayer.Builder(context)
                .setLooper(Looper.getMainLooper())
                .build()
            createdPlayer.addListener(object : Player.Listener {
                override fun onPlaybackStateChanged(playbackState: Int) {
                    if (playbackState == Player.STATE_READY) terminal.countDown()
                }

                override fun onPlayerError(error: PlaybackException) {
                    playbackError.set(error)
                    terminal.countDown()
                }
            })
            createdPlayer.setMediaItem(MediaItem.fromUri(fixtureUri))
            createdPlayer.prepare()
            player = createdPlayer
        }

        val activePlayer = requireNotNull(player) { "ExoPlayer was not created on the main thread" }
        try {
            assertTrue("Media3 neither reached READY nor reported an error", terminal.await(30, TimeUnit.SECONDS))

            val error = playbackError.get()
            assertNull(
                "Media3 playback failed: ${error?.errorCodeName}; cause=${error?.cause?.javaClass?.name}: ${error?.cause?.message}",
                error
            )

            val playbackState = java.util.concurrent.atomic.AtomicInteger()
            val duration = AtomicLong()
            instrumentation.runOnMainSync {
                playbackState.set(activePlayer.playbackState)
                duration.set(activePlayer.duration)
            }
            assertEquals(Player.STATE_READY, playbackState.get())
            assertTrue("Media3 reported a non-positive duration", duration.get() > 0L)

            val fractions = listOf(0.0, 0.25, 0.50, 0.75, 0.95)
            for (fraction in fractions) {
                val target = (duration.get() * fraction).toLong()
                instrumentation.runOnMainSync { activePlayer.seekTo(target) }
                SystemClock.sleep(350)

                val current = AtomicLong()
                instrumentation.runOnMainSync { current.set(activePlayer.currentPosition) }
                val tolerance = 1_000L
                assertTrue(
                    "Seek was too far from target $target (actual ${current.get()})",
                    kotlin.math.abs(current.get() - target) <= tolerance
                )
            }

            instrumentation.runOnMainSync { activePlayer.pause() }
            var playWhenReady = true
            instrumentation.runOnMainSync { playWhenReady = activePlayer.playWhenReady }
            assertFalse(playWhenReady)
        } finally {
            instrumentation.runOnMainSync { activePlayer.release() }
        }
    }
}
