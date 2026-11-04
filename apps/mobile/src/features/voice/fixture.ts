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

/** A few bytes of fake m4a: the header the backend's format sniffing wants. */
const M4A_HEADER = new Uint8Array([
  0, 0, 0, 24, 102, 116, 121, 112, 77, 52, 65, 32, 0, 0, 0, 0, 77, 52, 65, 32,
  105, 115, 111, 109,
]);

type Line = {
  spoken: string;
  query: string;
  quantity: number;
  unit_price?: number;
  price_spoken?: string;
};
type Answer = {
  transcript: string;
  intent: 'sale' | 'chat';
  payment_method?: 'cash' | 'transfer' | 'credit';
  customer_name?: string;
  lines: Line[];
};
const line = (spoken: string, quantity: number, extra: Partial<Line> = {}) => ({
  spoken,
  query: spoken,
  quantity,
  ...extra,
});

/**
 * What the scripted voice model (`VOICE_MODEL_PROVIDER=scripted`) hears in a fixture clip: it reads
 * `VOICE_PARSE=<json>` out of the bytes, so each fixture embeds its answer (the sidecars of
 * `packages/e2e/fixtures/voice`). A name without an entry carries no marker, which the backend
 * answers as silence (422 `no_speech`).
 */
const ANSWERS: Record<string, Answer> = {
  'two-line-sale.m4a': {
    transcript: 'hai lon coca với một lon pepsi',
    intent: 'sale',
    payment_method: 'cash',
    lines: [line('coca', 2), line('pepsi', 1)],
  },
  'noisy-sale.m4a': {
    transcript: 'hai lon coca với một lon pepsi',
    intent: 'sale',
    payment_method: 'cash',
    lines: [line('coca', 2), line('pepsi', 1)],
  },
  'single-sale.m4a': {
    transcript: 'một chai tương ớt chin su',
    intent: 'sale',
    payment_method: 'cash',
    lines: [line('tương ớt chin su', 1)],
  },
  'transfer-sale.m4a': {
    transcript: 'hai lon coca chuyển khoản',
    intent: 'sale',
    payment_method: 'transfer',
    lines: [line('coca', 2)],
  },
  'credit-sale.m4a': {
    transcript: 'hai lon coca ghi nợ chị Lan',
    intent: 'sale',
    payment_method: 'credit',
    customer_name: 'chị Lan',
    lines: [line('coca', 2)],
  },
  'ambiguous.m4a': {
    transcript: 'ba lon nước ngọt',
    intent: 'sale',
    payment_method: 'cash',
    lines: [line('nước ngọt', 3)],
  },
  'unknown-product.m4a': {
    transcript: 'một gói bánh bi mười lăm nghìn',
    intent: 'sale',
    payment_method: 'cash',
    lines: [
      line('bánh bi', 1, { unit_price: 15000, price_spoken: 'mười lăm nghìn' }),
    ],
  },
  'price-shorthand.m4a': {
    transcript: 'ba gói mì hảo hảo hai chục',
    intent: 'sale',
    payment_method: 'cash',
    lines: [
      line('mì hảo hảo', 3, { unit_price: 20000, price_spoken: 'hai chục' }),
    ],
  },
  'chat-intent.m4a': {
    transcript: 'hôm nay bán được bao nhiêu',
    intent: 'chat',
    lines: [],
  },
};

const encoder = new TextEncoder();

/** The fixture's fake m4a: header plus the embedded `VOICE_PARSE=` answer, when it has one. */
export function fixtureBytes(name: string): Uint8Array {
  const answer = ANSWERS[name];
  if (!answer) return M4A_HEADER;
  const marker = encoder.encode(
    `VOICE_PARSE=${JSON.stringify({ language: 'vi', confidence: 0.9, ...answer })}`,
  );
  const bytes = new Uint8Array(M4A_HEADER.length + marker.length);
  bytes.set(M4A_HEADER);
  bytes.set(marker, M4A_HEADER.length);
  return bytes;
}

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
        audio: new Blob([fixtureBytes(clip.name) as BlobPart], {
          type: clip.type,
        }),
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
        clip.fixture ? fixtureBytes(clip.name) : new File(clip.uri).bytes(),
    },
    filename: clip.name,
  };
}
