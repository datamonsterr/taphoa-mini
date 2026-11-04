package expo.modules.voicebubble

import kotlin.math.abs

/** Pure helpers: no Android classes, so they run as plain JUnit tests. */

object VoiceDeepLink {
  /** The scheme in app.json (`expo.scheme`). */
  const val SCHEME = "taphoa"
  const val ENTRY_BUBBLE = "bubble"
  const val ENTRY_TILE = "tile"
  const val ENTRY_SHORTCUT = "shortcut"

  /** `taphoa://voice?entry=bubble&returnToPrevious=1`; the route reads both params. */
  fun build(entry: String, returnToPrevious: Boolean): String {
    val base = "$SCHEME://voice?entry=$entry"
    return if (returnToPrevious) "$base&returnToPrevious=1" else base
  }
}

object EdgeSnap {
  /** Left x of the bubble after a drop: the nearest screen edge, `margin` px from it. */
  fun snapX(x: Int, size: Int, screenWidth: Int, margin: Int): Int {
    val center = x + size / 2
    val left = margin
    val right = screenWidth - size - margin
    return if (center < screenWidth / 2) left else right
  }

  /** Keeps the bubble between the insets, never off screen. */
  fun clampY(y: Int, size: Int, screenHeight: Int, insetTop: Int, insetBottom: Int): Int {
    val min = insetTop
    val max = (screenHeight - size - insetBottom).coerceAtLeast(min)
    return y.coerceIn(min, max)
  }
}

object TouchRules {
  /** A gesture is a drag once it moved farther than the slop on either axis. */
  fun isDrag(dx: Float, dy: Float, slop: Int): Boolean = abs(dx) > slop || abs(dy) > slop
}

/**
 * Whether the bubble shows. It hides while the app itself is in front (the voice sheet must not
 * be covered) and after a long-press, until the next time the app opens.
 */
class BubbleVisibility(appInForeground: Boolean = false) {
  var appInForeground: Boolean = appInForeground
    private set
  var hiddenByUser: Boolean = false
    private set

  val visible: Boolean get() = !appInForeground && !hiddenByUser

  fun onAppForeground() {
    appInForeground = true
    hiddenByUser = false
  }

  fun onAppBackground() {
    appInForeground = false
  }

  fun onLongPress() {
    hiddenByUser = true
  }
}

/** Where the "switch is on" flag lives; SharedPreferences in production, a map in tests. */
interface FlagStore {
  fun getBoolean(key: String, default: Boolean): Boolean
  fun putBoolean(key: String, value: Boolean)
}

class BubbleSettings(private val store: FlagStore) {
  var enabled: Boolean
    get() = store.getBoolean(KEY_ENABLED, false)
    set(value) = store.putBoolean(KEY_ENABLED, value)

  /** The boot receiver restarts the service only when the user left the switch on. */
  fun shouldRestartOnBoot(canDrawOverlays: Boolean): Boolean = enabled && canDrawOverlays

  companion object {
    const val KEY_ENABLED = "enabled"
    const val PREFS_NAME = "taphoa_voice_bubble"
  }
}
