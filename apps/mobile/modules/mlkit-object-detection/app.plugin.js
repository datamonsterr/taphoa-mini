const { AndroidConfig, createRunOncePlugin } = require('expo/config-plugins');

// Nitro is linked as a local React Native package. Permissions are CNG-owned.
const withObjectDetection = (config) =>
  AndroidConfig.Permissions.withPermissions(config, [
    'android.permission.CAMERA',
  ]);

module.exports = createRunOncePlugin(
  withObjectDetection,
  '@taphoa/mlkit-object-detection',
  '0.1.0',
);
