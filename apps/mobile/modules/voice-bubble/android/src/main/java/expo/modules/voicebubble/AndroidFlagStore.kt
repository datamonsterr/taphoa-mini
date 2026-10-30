package expo.modules.voicebubble

import android.content.Context

class AndroidFlagStore(context: Context) : FlagStore {
  private val prefs = context.applicationContext
    .getSharedPreferences(BubbleSettings.PREFS_NAME, Context.MODE_PRIVATE)

  override fun getBoolean(key: String, default: Boolean) = prefs.getBoolean(key, default)

  override fun putBoolean(key: String, value: Boolean) {
    prefs.edit().putBoolean(key, value).apply()
  }
}
