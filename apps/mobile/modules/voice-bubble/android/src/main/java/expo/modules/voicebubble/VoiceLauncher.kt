package expo.modules.voicebubble

import android.content.Context
import android.content.Intent
import android.net.Uri

object VoiceLauncher {
  /**
   * An intent that opens MainActivity on the voice route. NEW_TASK is needed because it starts
   * from a service or the tile; the launcher category is dropped so the system delivers the data
   * to a running app instead of just resuming it.
   */
  fun intent(context: Context, entry: String, returnToPrevious: Boolean): Intent? {
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
    return launch.apply {
      action = Intent.ACTION_VIEW
      removeCategory(Intent.CATEGORY_LAUNCHER)
      data = Uri.parse(VoiceDeepLink.build(entry, returnToPrevious))
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
  }
}
