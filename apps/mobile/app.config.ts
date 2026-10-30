import type { ConfigContext, ExpoConfig } from 'expo/config';

/** EAS profiles whose build is installed on real phones, where localhost is never a backend. */
const RELEASE_PROFILES = ['preview', 'production', 'test'];

/**
 * Static config stays in `app.json`; this only guards it and stamps CI versions. A release build
 * without `EXPO_PUBLIC_API_URL` would silently talk to `http://localhost:8080` and never get past
 * sign-in, so it fails here instead of shipping.
 */
export default ({ config }: ConfigContext): ExpoConfig => {
  const profile = process.env.EAS_BUILD_PROFILE;
  if (
    profile &&
    RELEASE_PROFILES.includes(profile) &&
    !process.env.EXPO_PUBLIC_API_URL?.trim()
  )
    throw new Error(
      `EXPO_PUBLIC_API_URL is not set for the "${profile}" EAS build profile. Set it in the profile "env" in eas.json.`,
    );
  return withCiVersion(config as ExpoConfig);
};

/**
 * The Android APK workflow sets `APP_VERSION_CODE` (the run number, so every build installs over
 * the previous one) and `APP_VERSION_NAME` (shown in the phone's app info). Unset, app.json wins.
 */
function withCiVersion(config: ExpoConfig): ExpoConfig {
  const name = process.env.APP_VERSION_NAME?.trim();
  const rawCode = process.env.APP_VERSION_CODE?.trim();
  if (!name && !rawCode) return config;
  const code = rawCode ? Number(rawCode) : undefined;
  if (code !== undefined && !(Number.isInteger(code) && code > 0))
    throw new Error(
      `APP_VERSION_CODE must be a positive integer, got "${rawCode}".`,
    );
  return {
    ...config,
    ...(name && { version: name }),
    ...(code && { android: { ...config.android, versionCode: code } }),
  };
}
