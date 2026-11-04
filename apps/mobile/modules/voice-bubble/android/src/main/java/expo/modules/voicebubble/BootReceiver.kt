package expo.modules.voicebubble

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Settings

/** Restarts the bubble after a reboot, only if the user left the switch on and still allows it. */
class BootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent?) {
    if (intent?.action != Intent.ACTION_BOOT_COMPLETED) return
    val settings = BubbleSettings(AndroidFlagStore(context))
    if (settings.shouldRestartOnBoot(Settings.canDrawOverlays(context))) {
      VoiceBubbleService.start(context)
    }
  }
}
