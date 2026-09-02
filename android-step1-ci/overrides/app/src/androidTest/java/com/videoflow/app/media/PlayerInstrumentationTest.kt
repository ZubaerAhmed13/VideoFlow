package com.videoflow.app.media

import android.content.Context
import android.os.Looper
import android.os.SystemClock
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.videoflow.app.test.TestMediaProvider
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

@RunWith(AndroidJUnit4::class)
class PlayerInstrumentationTest {
    @Test
    fun media3PreparesAndSeeksAcrossFixture() {
        val context: Context = ApplicationProvider.getApplicationContext()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val ready = CountDownLatch(1)
        lateinit var player: ExoPlayer

        instrumentation.runOnMainSync {
            player = ExoPlayer.Builder(context)
                .setLooper(Looper.getMainLooper())
                .build()
            player.addListener(object : Player.Listener {
                override fun onPlaybackStateChanged(playbackState: Int) {
                    if (playbackState == Player.STATE_READY) ready.countDown()
                }
            })
            player.setMediaItem(MediaItem.fromUri(TestMediaProvider.uri("sample_av.mp4")))
            player.prepare()
        }

        try {
            assertTrue("Media3 did not reach READY", ready.await(15, TimeUnit.SECONDS))

            val duration = AtomicLong()
            instrumentation.runOnMainSync { duration.set(player.duration) }
            assertTrue(duration.get() > 0L)

            val fractions = listOf(0.0, 0.25, 0.50, 0.75, 0.95)
            for (fraction in fractions) {
                val target = (duration.get() * fraction).toLong()
                instrumentation.runOnMainSync { player.seekTo(target) }
                SystemClock.sleep(350)

                val current = AtomicLong()
                instrumentation.runOnMainSync { current.set(player.currentPosition) }
                val tolerance = 1_000L
                assertTrue(
                    "Seek was too far from target $target (actual ${current.get()})",
                    kotlin.math.abs(current.get() - target) <= tolerance
                )
            }

            instrumentation.runOnMainSync { player.pause() }
            var playWhenReady = true
            instrumentation.runOnMainSync { playWhenReady = player.playWhenReady }
            assertFalse(playWhenReady)
        } finally {
            if (::player.isInitialized) {
                instrumentation.runOnMainSync { player.release() }
            }
        }
    }
}
