package dev.pezzotflix.tv.player.caps

import org.robolectric.RuntimeEnvironment
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The platform reader on Robolectric (SDK 30, a TV): it reads without failing and maps to a valid declaration. */
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "television")
class PlatformFactsTest {
    @Test
    fun readsTheDeviceAsATv() {
        val facts = PlatformFacts.read(RuntimeEnvironment.getApplication(), "0.1.0")
        assertTrue(facts.isTelevision)
        assertEquals(30, facts.sdk)
        val caps = CapabilityMapper.map(facts)
        assertEquals("tv", caps.device.propertyClass.value)
        assertTrue(caps.device.model!!.endsWith("Android 11 (API 30)"))
        assertEquals("pezzotflix-tv 0.1.0", caps.device.app)
        assertTrue(caps.audio.any { it.codec == "pcm" })
    }
}
