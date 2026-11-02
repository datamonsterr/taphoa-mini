package com.margelo.nitro.objectdetection

import android.graphics.ImageFormat
import android.os.Looper
import androidx.annotation.Keep
import androidx.camera.core.ExperimentalGetImage
import com.facebook.proguard.annotations.DoNotStrip
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.objects.ObjectDetection
import com.google.mlkit.vision.objects.defaults.ObjectDetectorOptions
import com.margelo.nitro.camera.HybridFrameSpec
import com.margelo.nitro.camera.public.NativeFrame

@Keep
@DoNotStrip
class HybridObjectDetector : HybridObjectDetectorSpec() {
  private val detector = ObjectDetection.getClient(
    ObjectDetectorOptions.Builder()
      .setDetectorMode(ObjectDetectorOptions.STREAM_MODE)
      .enableMultipleObjects()
      .build(),
  )
  private var closed = false

  @OptIn(ExperimentalGetImage::class)
  @Synchronized
  override fun detectObjects(frame: HybridFrameSpec): Array<DetectedObject> {
    check(!closed) { "Object detector is disposed" }
    check(Looper.myLooper() != Looper.getMainLooper()) { "detectObjects must run on the frame worklet thread" }
    val image = (frame as? NativeFrame)?.image
      ?: error("Expected a VisionCamera v5 NativeFrame")
    check(frame.isValid) { "Frame is disposed" }
    check(image.format == ImageFormat.YUV_420_888) { "Object detection requires pixelFormat: 'yuv'" }
    val mediaImage = image.image ?: error("Frame has no media image")
    val rotation = image.imageInfo.rotationDegrees
    // NativeFrame -> ImageProxy -> InputImage pattern adapted from Pedro Bueno's MIT
    // react-native-vision-camera-mlkit 2.0.1; see THIRD_PARTY_NOTICES.md.
    val input = InputImage.fromMediaImage(mediaImage, rotation)
    // No timeout: ML Kit must finish reading the image before JS disposes the frame.
    // Only this dedicated frame thread blocks; dropFramesWhileBusy prevents queues.
    return Tasks.await(detector.process(input)).map { detected ->
      val b = detected.boundingBox
      // ML Kit returns upright coordinates. Undo input rotation so the public
      // contract always uses the original frame's pixel dimensions.
      val left: Int
      val top: Int
      val width: Int
      val height: Int
      when (rotation) {
        90 -> { left = b.top; top = image.height - b.right; width = b.height(); height = b.width() }
        180 -> { left = image.width - b.right; top = image.height - b.bottom; width = b.width(); height = b.height() }
        270 -> { left = image.width - b.bottom; top = b.left; width = b.height(); height = b.width() }
        else -> { left = b.left; top = b.top; width = b.width(); height = b.height() }
      }
      DetectedObject(
        // Nitrogen represents `number | null` as a tagged nullable variant.
        trackingId = detected.trackingId?.let { Variant_NullType_Double.Second(it.toDouble()) }
          ?: Variant_NullType_Double.First(com.margelo.nitro.core.NullType.NULL),
        x = left.toDouble(), y = top.toDouble(),
        width = width.toDouble(), height = height.toDouble(),
      )
    }.toTypedArray()
  }

  override fun getFrameMetadata(frame: HybridFrameSpec): FrameMetadata {
    val image = (frame as? NativeFrame)?.image ?: error("Expected a VisionCamera v5 NativeFrame")
    return FrameMetadata(
      width = image.width.toDouble(), height = image.height.toDouble(),
      rotation = image.imageInfo.rotationDegrees.toDouble(),
      orientation = frame.orientation.name.lowercase(), isMirrored = frame.isMirrored,
    )
  }

  @Synchronized
  override fun dispose() {
    if (!closed) {
      closed = true
      detector.close()
    }
    super.dispose()
  }
}
