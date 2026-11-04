package expo.modules.voicebubble

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FakeStore : FlagStore {
  val map = mutableMapOf<String, Boolean>()
  override fun getBoolean(key: String, default: Boolean) = map[key] ?: default
  override fun putBoolean(key: String, value: Boolean) {
    map[key] = value
  }
}

class VoiceBubbleLogicTest {
  @Test
  fun deepLinkForTheBubbleReturnsToPrevious() {
    assertEquals(
      "taphoa://voice?entry=bubble&returnToPrevious=1",
      VoiceDeepLink.build(VoiceDeepLink.ENTRY_BUBBLE, true),
    )
  }

  @Test
  fun deepLinkWithoutReturnHasOnlyTheEntry() {
    assertEquals("taphoa://voice?entry=tile", VoiceDeepLink.build(VoiceDeepLink.ENTRY_TILE, false))
    assertEquals("taphoa://voice?entry=shortcut", VoiceDeepLink.build(VoiceDeepLink.ENTRY_SHORTCUT, false))
  }

  @Test
  fun snapsToTheNearestEdge() {
    // 1080 wide screen, 168 px bubble, 24 px margin
    assertEquals(24, EdgeSnap.snapX(100, 168, 1080, 24))
    assertEquals(1080 - 168 - 24, EdgeSnap.snapX(700, 168, 1080, 24))
  }

  @Test
  fun exactMiddleSnapsRight() {
    // center == screen / 2 is not left of the middle
    assertEquals(1080 - 168 - 24, EdgeSnap.snapX(540 - 84, 168, 1080, 24))
  }

  @Test
  fun clampKeepsTheBubbleOnScreen() {
    assertEquals(50, EdgeSnap.clampY(-300, 168, 2400, 50, 100))
    assertEquals(2400 - 168 - 100, EdgeSnap.clampY(5000, 168, 2400, 50, 100))
    assertEquals(900, EdgeSnap.clampY(900, 168, 2400, 50, 100))
  }

  @Test
  fun clampOnATinyScreenDoesNotCrash() {
    assertEquals(50, EdgeSnap.clampY(10, 168, 100, 50, 100))
  }

  @Test
  fun dragNeedsMovementBeyondTheSlop() {
    assertFalse(TouchRules.isDrag(3f, -3f, 8))
    assertTrue(TouchRules.isDrag(9f, 0f, 8))
    assertTrue(TouchRules.isDrag(0f, -9f, 8))
  }

  @Test
  fun bubbleHidesWhileTheAppIsInFront() {
    val v = BubbleVisibility()
    assertTrue(v.visible)
    v.onAppForeground()
    assertFalse(v.visible)
    v.onAppBackground()
    assertTrue(v.visible)
  }

  @Test
  fun longPressHidesUntilTheNextAppOpen() {
    val v = BubbleVisibility()
    v.onLongPress()
    assertFalse(v.visible)
    v.onAppBackground()
    assertFalse(v.visible)
    v.onAppForeground()
    v.onAppBackground()
    assertTrue(v.visible)
  }

  @Test
  fun enabledFlagDefaultsToOffAndPersists() {
    val store = FakeStore()
    val settings = BubbleSettings(store)
    assertFalse(settings.enabled)
    settings.enabled = true
    assertTrue(BubbleSettings(store).enabled)
    settings.enabled = false
    assertFalse(BubbleSettings(store).enabled)
  }

  @Test
  fun bootRestartsOnlyWhenEnabledAndAllowed() {
    val settings = BubbleSettings(FakeStore())
    assertFalse(settings.shouldRestartOnBoot(true))
    settings.enabled = true
    assertTrue(settings.shouldRestartOnBoot(true))
    assertFalse(settings.shouldRestartOnBoot(false))
  }
}
