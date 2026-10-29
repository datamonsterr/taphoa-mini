import type { ConfigContext, ExpoConfig } from 'expo/config';

/** EAS profiles whose build is installed on real phones, where localhost is never a backend. */
const RELEASE_PROFILES = ['preview', 'production', 'test'];

/**
 * Static config stays in `app.json`; this only guards it. A release build without
 * `EXPO_PUBLIC_API_URL` would silently talk to `http://localhost:8080` and never get past
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
  return config as ExpoConfig;
};
