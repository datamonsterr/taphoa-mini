package expo.modules.voicebubble

import android.app.StatusBarManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class VoiceBubbleModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("No React context")

  override fun definition() = ModuleDefinition {
    Name("VoiceBubble")

    Function("isSupported") { Build.VERSION.SDK_INT >= Build.VERSION_CODES.O }

    Function("canDrawOverlays") { Settings.canDrawOverlays(context) }

    Function("openOverlaySettings") {
      val intent = Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${context.packageName}"))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
    }

    /** The user's switch (not whether the process is alive right now). */
    Function("isEnabled") {
      BubbleSettings(AndroidFlagStore(context)).enabled && Settings.canDrawOverlays(context)
    }

    Function("isRunning") { VoiceBubbleService.instance != null }

    /** Starts the service; false when the overlay permission is missing. */
    Function("start") {
      if (!Settings.canDrawOverlays(context)) return@Function false
      BubbleSettings(AndroidFlagStore(context)).enabled = true
      VoiceBubbleService.start(context)
      true
    }

    Function("stop") {
      VoiceBubbleService.stop(context)
    }

    AsyncFunction("requestAddTile") { promise: Promise ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
        promise.resolve(false)
        return@AsyncFunction
      }
      val manager = context.getSystemService(StatusBarManager::class.java)
      manager.requestAddTileService(
        ComponentName(context, VoiceTileService::class.java),
        context.getString(R.string.voice_tile_label),
        Icon.createWithResource(context, R.drawable.ic_voice_mic),
        context.mainExecutor,
      ) { result ->
        promise.resolve(
          result == StatusBarManager.TILE_ADD_REQUEST_RESULT_TILE_ADDED ||
            result == StatusBarManager.TILE_ADD_REQUEST_RESULT_TILE_ALREADY_ADDED,
        )
      }
    }

    Function("moveTaskToBack") {
      appContext.currentActivity?.moveTaskToBack(true) ?: false
    }

    OnActivityEntersForeground {
      VoiceBubbleService.appInForeground = true
      VoiceBubbleService.instance?.onAppForeground()
    }

    OnActivityEntersBackground {
      VoiceBubbleService.appInForeground = false
      VoiceBubbleService.instance?.onAppBackground()
    }
  }
}
