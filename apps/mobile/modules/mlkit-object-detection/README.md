# ML Kit object detection (N1/N2 spike)

Android-only local Nitro module for VisionCamera **5.2.4**, Nitro **0.37.1**,
Worklets **0.13.0**, RN **0.88.0**, Expo SDK **58**. Android API **26+**
is required by VisionCamera Resizer; `expo-build-properties` sets the app minimum
during CNG (ADR 0010). It is linked through the
app's local package dependency and React Native autolinking; the Expo config
plugin supplies the camera permission during CNG. Do not edit the generated
`apps/mobile/android` project. iOS/web return `null` from the factory; there is
no iOS detector implementation.

## Worklet API

Create one detector on the RN thread, then capture it in `useFrameOutput`:

```ts
// `detector` is an initialized Android ObjectDetector, owned by a mount effect.
const output = useFrameOutput({
  pixelFormat: 'yuv',
  dropFramesWhileBusy: true,
  onFrame(frame) {
    'worklet';
    try {
      const metadata = detector.getFrameMetadata(frame);
      const objects = detector.detectObjects(frame);
      // Transfer plain results with scheduleOnUI, then update shared values.
    } catch (error) {
      // Report an error without terminating the frame callback.
    } finally {
      frame.dispose();
    }
  },
});
```

`detectObjects(frame)` returns `{ trackingId: number | null, x, y, width, height }[]`.
Boxes use the **raw frame buffer's pixel coordinates**. ML Kit receives the
CameraX `ImageProxy.imageInfo.rotationDegrees`; the module undoes that rotation
on returned upright boxes. `getFrameMetadata(frame)` returns buffer width/height,
the clockwise rotation in degrees, VisionCamera orientation, and mirroring.
The TS `mapBoxToPreview` function rotates, mirrors and cover-scales those boxes.
Use the same aspect ratio and `orientationSource="interface"` on the preview and
frame output, as in the dev route.

The detector uses `STREAM_MODE`, multiple objects (maximum five), and no
classification. One detector is reused across frames. `Tasks.await` synchronously
waits on the dedicated frame thread; **never call it on the UI/RN thread**. There
is no timeout, so the image stays alive until ML Kit has finished reading it.
`dropFramesWhileBusy` prevents a queue of stale frames. The native code serializes
detection/disposal, closes the detector once, and leaves frame disposal to JS.

## Exercise it

Open `taphoa://dev/vision` in an Android development build (normal app setup/auth
still applies). It is available under `__DEV__`, or in a release build explicitly
made with `EXPO_PUBLIC_VISION_DEV=1`. The production camera screen still uses
expo-camera. Web renders a static Android-only message with no Nitro imports.

The FPS counter measures completed **detection** frames. ML Kit can take 30+
frames before its first box. Tap inside a box to lock its id; overlapping boxes
choose the nearest centre. Tap outside to unlock. The fallback tracker uses
greedy global IoU matching at 0.3 and retains tracks for 15 missing processed
frames. Fallback ids are negative to avoid native tracking id collisions.
Boxes and status use Reanimated shared values; React state changes only for
initialization, permission and foreground/focus lifecycle.

VisionCamera 5.2.4 has reported Android resource leaks on repeated mounts
([FrameOutput #4213](https://github.com/margelo/react-native-vision-camera/issues/4213),
[SurfaceView #4180](https://github.com/margelo/react-native-vision-camera/issues/4180)).
This spike uses `implementationMode="compatible"` (TextureView), keeps output
identity stable while mounted, pauses in the background/on blur and disposes
the frame output on unmount. The upstream FrameOutput executor issue still
needs device soak testing; this is not a production camera migration.
Explicit YUV input avoids PRIVATE-buffer CPU access
([#4207](https://github.com/margelo/react-native-vision-camera/issues/4207)).

## Regenerate bindings

From `apps/mobile/modules/mlkit-object-detection` run:

```sh
../../node_modules/.bin/nitrogen
```

Commit `nitrogen/generated` with spec changes. The generator is pinned to the
same version as Nitro in the app's dev dependencies.

## Android compile proof

**Passed** on 2026-11-02: `:app:assembleDebug`, ARM64, `BUILD SUCCESSFUL`.
The APK is `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`
(131,770,779 bytes), SHA-256
`000a2d0ba717589373b509b6edebef07e233423fb6040a289f17495ccce1f31e`.
Its merged manifest declares minimum SDK 26. APK inspection confirmed the
`MlkitObjectDetection`, `VisionCamera`, `VisionCameraResizer`,
`VisionCameraWorklets`, `NitroModules`, and `NitroImage` ARM64 shared libraries.
This proves compilation and packaging; live inference still needs a device.

From the repository root, with dependencies installed:

```sh
(cd apps/mobile && CI=1 npx expo prebuild --platform android --clean --no-install)
docker run --rm --name taphoa-vision-android --cpus=4 --memory=12g --memory-swap=20g \
  -v "$PWD:$PWD" -v taphoa-vision-sdk:/opt/android \
  -v taphoa-vision-gradle:/opt/gradle-home \
  -w "$PWD/apps/mobile/android" \
  reactnativecommunity/react-native-android:v22.0 \
  bash -lc './gradlew :app:assembleDebug -PreactNativeArchitectures=arm64-v8a -Dorg.gradle.jvmargs=-Xmx6g --max-workers=4 --console=plain'
```

The image digest used was
`sha256:e817ea1959719c97c05adbc55348ebe21d286cec2caed1f18ad3c4b88c08cbf7`.
It contains JDK 17, SDK/build-tools 37 and NDK 28.2. Gradle can install a missing
NDK selected by Expo. The named volumes preserve the Android SDK and downloaded Gradle artifacts;
all node_modules and local-module sources stay at their absolute pnpm paths.
`android/` is ignored and must never be committed. Expo prebuild also rewrites
the existing `android`/`ios` npm scripts; review and revert those incidental
script changes before committing.

The container runs as root. Restore generated output ownership before another
clean prebuild (substitute your host uid/gid):

```sh
docker run --rm -v "$PWD:$PWD" reactnativecommunity/react-native-android:v22.0 \
  chown -R "$(id -u):$(id -g)" "$PWD/apps/mobile/android"
```

## TypeScript and bundle validation (2026-11-02)

- `npx tsc --noEmit`: passed.
- `npx expo lint`: 0 errors; one existing `VoiceSaleScreen` ref-cleanup warning.
- `npx jest --maxWorkers=2 --workerIdleMemoryLimit=512MB`: 236 suites, 2,368 tests passed.
- The same full run with `--coverage` passed all CI thresholds: 95.37% statements,
  91.36% branches, 94.62% functions, 96.35% lines.
- `node scripts/test-tz.mjs`: all four timezone/clock runs passed (47 suites each).
- `node --test 'scripts/**/*.test.mjs'`: 13 tests passed.
- `CI=1 npx expo export --platform web --output-dir dist-web --max-workers 2`: passed.
- `CI=1 npx expo export --platform android --output-dir dist --max-workers 2`: passed.
- `node scripts/bundle-budget.mjs`: Android 10,735.6 KiB / 12,089.8 KiB (89%);
  web gzip 1,243.8 KiB / 1,259.8 KiB (99%), both passed.
- `npx expo-doctor`: 19/20 checks; the only failure is the existing set of 23
  Expo/RN patch-version mismatches. No added package is flagged.

## Verified sources (2026-11-02)

- [Expo SDK 58](https://docs.expo.dev/versions/v58.0.0/)
- [VisionCamera installation](https://visioncamera.margelo.com/docs)
- [Frame output](https://visioncamera.margelo.com/docs/frame-output)
- [Nitro frame plugins](https://visioncamera.margelo.com/docs/native-frame-processor-plugins)
- [ML Kit object detection](https://developers.google.com/ml-kit/vision/object-detection/android)
- [Google Maven metadata: object-detection 17.0.2](https://dl.google.com/dl/android/maven2/com/google/mlkit/object-detection/maven-metadata.xml)
- [Reference implementation](https://github.com/pedrol2b/react-native-vision-camera-mlkit)
  (MIT; attribution in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).
