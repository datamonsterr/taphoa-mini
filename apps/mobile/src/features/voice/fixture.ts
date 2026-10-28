import { File } from 'expo-file-system';
import { Platform } from 'react-native';

/** Clips the mock backend and the e2e backend know by name (`packages/e2e/fixtures/voice`). */
const FIXTURE_NAME = /^[a-z0-9][a-z0-9-]*\.m4a$/;

/**
 * Debug fixtures stand in for the microphone: `/voice?fixture=two-line-sale.m4a` uploads that
 * clip name. Only development and e2e builds (`EXPO_PUBLIC_VOICE_FIXTURES=1`) honour the param;
 * a production build ignores it.
 */
export const voiceFixturesEnabled = (): boolean =>
  __DEV__ || process.env.EXPO_PUBLIC_VOICE_FIXTURES === '1';

/** The fixture clip name to use, or undefined when fixtures are off or the name is not a clip. */
export function fixtureName(param: string | undefined): string | undefined {
  if (!param || !voiceFixturesEnabled() || !FIXTURE_NAME.test(param))
    return undefined;
  return param;
}

/** A few bytes of fake m4a: the fixture backends decide by the file name, not by the bytes. */
const FIXTURE_BYTES = new Uint8Array([
  0, 0, 0, 24, 102, 116, 121, 112, 77, 52, 65, 32, 0, 0, 0, 0, 77, 52, 65, 32,
  105, 115, 111, 109,
]);

export type VoiceClip = {
  uri: string;
  name: string;
  type: string;
  /** Recorded length in milliseconds. */
  durationMs: number;
  fixture?: boolean;
};

export const fixtureClip = (name: string): VoiceClip => ({
  uri: `fixture://${name}`,
  name,
  type: 'audio/mp4',
  durationMs: 1500,
  fixture: true,
});

/** The multipart audio part for a clip. Native sends a lazily read file part; the web a Blob. */
export async function clipToUpload(clip: VoiceClip) {
  if (Platform.OS === 'web') {
    if (clip.fixture)
      return {
        audio: new Blob([FIXTURE_BYTES], { type: clip.type }),
        filename: clip.name,
      };
    const blob = await (await fetch(clip.uri)).blob();
    return {
      audio: blob.type ? blob : new Blob([blob], { type: clip.type }),
      filename: clip.name,
    };
  }
  return {
    // `uri` makes the api-client treat it as a React Native file part; `bytes` is what Expo's
    // native fetch reads (same shape as the image uploads in lib/api/multipart.ts).
    audio: {
      uri: clip.uri,
      name: clip.name,
      type: clip.type,
      bytes: async () =>
        clip.fixture ? FIXTURE_BYTES : new File(clip.uri).bytes(),
    },
    filename: clip.name,
  };
}
