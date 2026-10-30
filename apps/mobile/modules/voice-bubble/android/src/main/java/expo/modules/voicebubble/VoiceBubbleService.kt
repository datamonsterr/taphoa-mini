package expo.modules.voicebubble

import android.animation.ValueAnimator
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageView
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * Foreground service (type specialUse) that draws the floating voice button with
 * TYPE_APPLICATION_OVERLAY. It only launches the app; recording happens in the /voice route.
 */
class VoiceBubbleService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  private var windowManager: WindowManager? = null
  private var bubble: View? = null
  private var params: WindowManager.LayoutParams? = null
  private var animator: ValueAnimator? = null
  private val visibility = BubbleVisibility(appInForeground)

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    instance = this
    windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      BubbleSettings(AndroidFlagStore(this)).enabled = false
      stopForegroundCompat()
      stopSelf()
      return START_NOT_STICKY
    }
    startAsForeground()
    if (!Settings.canDrawOverlays(this)) {
      stopForegroundCompat()
      stopSelf()
      return START_NOT_STICKY
    }
    if (bubble == null) attachBubble()
    applyVisibility()
    return START_STICKY
  }

  override fun onDestroy() {
    instance = null
    animator?.cancel()
    handler.removeCallbacksAndMessages(null)
    bubble?.let { runCatching { windowManager?.removeView(it) } }
    bubble = null
    super.onDestroy()
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    val lp = params ?: return
    val view = bubble ?: return
    lp.x = EdgeSnap.snapX(lp.x, sizePx(), screenWidth(), marginPx())
    lp.y = EdgeSnap.clampY(lp.y, sizePx(), screenHeight(), 0, 0)
    runCatching { windowManager?.updateViewLayout(view, lp) }
  }

  /** Called by the module (same process) when the app comes to the front or leaves it. */
  fun onAppForeground() {
    visibility.onAppForeground()
    handler.post { applyVisibility() }
  }

  fun onAppBackground() {
    visibility.onAppBackground()
    handler.post { applyVisibility() }
  }

  private fun applyVisibility() {
    bubble?.visibility = if (visibility.visible) View.VISIBLE else View.GONE
  }

  private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
  private fun sizePx() = dp(BUBBLE_DP)
  private fun marginPx() = dp(MARGIN_DP)
  private fun screenWidth() = resources.displayMetrics.widthPixels
  private fun screenHeight() = resources.displayMetrics.heightPixels

  private fun attachBubble() {
    val size = sizePx()
    val circle = GradientDrawable().apply {
      shape = GradientDrawable.OVAL
      setColor(ACCENT)
    }
    val icon = ImageView(this).apply {
      setImageResource(R.drawable.ic_voice_mic)
      importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    }
    val view = FrameLayout(this).apply {
      background = circle
      elevation = dp(6).toFloat()
      contentDescription = getString(R.string.voice_bubble_description)
      isClickable = true
      addView(icon, FrameLayout.LayoutParams(dp(28), dp(28), Gravity.CENTER))
      setOnClickListener { launchVoice() }
    }
    val lp = WindowManager.LayoutParams(
      size,
      size,
      WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
      PixelFormat.TRANSLUCENT,
    ).apply {
      gravity = Gravity.TOP or Gravity.START
      x = screenWidth() - size - marginPx()
      y = (screenHeight() * 0.4f).toInt()
    }
    view.setOnTouchListener(dragListener(view, lp))
    params = lp
    bubble = view
    windowManager?.addView(view, lp)
  }

  private fun dragListener(view: View, lp: WindowManager.LayoutParams): View.OnTouchListener {
    val slop = ViewConfiguration.get(this).scaledTouchSlop
    var downX = 0f
    var downY = 0f
    var startX = 0
    var startY = 0
    var dragging = false
    var longPressed = false
    val longPress = Runnable {
      longPressed = true
      visibility.onLongPress()
      applyVisibility()
    }
    return View.OnTouchListener { v, event ->
      when (event.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          downX = event.rawX
          downY = event.rawY
          startX = lp.x
          startY = lp.y
          dragging = false
          longPressed = false
          animator?.cancel()
          handler.postDelayed(longPress, ViewConfiguration.getLongPressTimeout().toLong())
          true
        }
        MotionEvent.ACTION_MOVE -> {
          val dx = event.rawX - downX
          val dy = event.rawY - downY
          if (!dragging && TouchRules.isDrag(dx, dy, slop)) {
            dragging = true
            handler.removeCallbacks(longPress)
          }
          if (dragging) {
            lp.x = startX + dx.toInt()
            lp.y = EdgeSnap.clampY(startY + dy.toInt(), sizePx(), screenHeight(), 0, 0)
            runCatching { windowManager?.updateViewLayout(view, lp) }
          }
          true
        }
        MotionEvent.ACTION_UP -> {
          handler.removeCallbacks(longPress)
          if (dragging) snapToEdge(view, lp)
          else if (!longPressed) v.performClick()
          true
        }
        MotionEvent.ACTION_CANCEL -> {
          handler.removeCallbacks(longPress)
          if (dragging) snapToEdge(view, lp)
          true
        }
        else -> false
      }
    }
  }

  private fun snapToEdge(view: View, lp: WindowManager.LayoutParams) {
    val target = EdgeSnap.snapX(lp.x, sizePx(), screenWidth(), marginPx())
    animator = ValueAnimator.ofInt(lp.x, target).apply {
      duration = 180
      addUpdateListener {
        lp.x = it.animatedValue as Int
        runCatching { windowManager?.updateViewLayout(view, lp) }
      }
      start()
    }
  }

  private fun launchVoice() {
    val intent = VoiceLauncher.intent(this, VoiceDeepLink.ENTRY_BUBBLE, returnToPrevious = true) ?: return
    // Allowed from the background: the app holds SYSTEM_ALERT_WINDOW and this overlay is visible.
    startActivity(intent)
  }

  private fun startAsForeground() {
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, getString(R.string.voice_bubble_channel_name), NotificationManager.IMPORTANCE_LOW),
      )
    }
    val stop = PendingIntent.getService(
      this,
      0,
      Intent(this, VoiceBubbleService::class.java).setAction(ACTION_STOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_voice_mic)
      .setContentTitle(getString(R.string.voice_bubble_notification_title))
      .setContentText(getString(R.string.voice_bubble_notification_text))
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .addAction(0, getString(R.string.voice_bubble_notification_stop), stop)
      .build()
    if (Build.VERSION.SDK_INT >= 34) {
      startForeground(
        NOTIFICATION_ID,
        notification,
        android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
      )
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  @Suppress("DEPRECATION")
  private fun stopForegroundCompat() {
    if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE) else stopForeground(true)
  }

  companion object {
    const val ACTION_STOP = "expo.modules.voicebubble.STOP"
    private const val CHANNEL_ID = "voice_bubble"
    private const val NOTIFICATION_ID = 7301
    private const val BUBBLE_DP = 56
    private const val MARGIN_DP = 8
    private val ACCENT = Color.parseColor("#5a43e8")

    @Volatile
    var instance: VoiceBubbleService? = null
      private set

    /** Whether the app UI is in front; read when the service starts. */
    @Volatile
    var appInForeground: Boolean = false

    fun start(context: Context) {
      ContextCompat.startForegroundService(context, Intent(context, VoiceBubbleService::class.java))
    }

    fun stop(context: Context) {
      BubbleSettings(AndroidFlagStore(context)).enabled = false
      context.stopService(Intent(context, VoiceBubbleService::class.java))
    }
  }
}
