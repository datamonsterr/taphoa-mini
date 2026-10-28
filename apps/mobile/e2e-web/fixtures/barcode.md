`barcode.jpg` is EAN-13 `4006381333931`, generated with python-barcode's EAN13 writer
(module width 0.7 mm, height 30 mm, quiet zone 12 mm, no caption) and converted to JPEG.
It contains synthetic barcode data, no product photo or personal data.

`barcode.spec.ts` loops this JPEG as Chromium's fake camera. Expo SDK 58 documents
`barcodeScannerSettings` and `onBarcodeScanned` on Android, iOS and web; expo-camera is
included in Expo Go: <https://docs.expo.dev/versions/v58.0.0/sdk/camera/>.
The installed web implementation uses the browser BarcodeDetector or barcode-detector's
fallback. The test exercises decoding, exact API lookup, enrollment, duplicate correction,
cart confirmation and the persisted sale's `barcode` source against the real local stack.

Run with the regular Playwright configuration and the E2E stack. Set `I89_SHOTS_DIR` to
save screenshots outside the test output directory. The Maestro flow uses typed digits
because the emulator's virtual camera does not show this fixture.
