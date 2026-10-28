import type { VoiceEntry } from '@/lib/analytics';

export const VOICE_ENTRIES: readonly VoiceEntry[] = [
  'bubble',
  'tile',
  'shortcut',
  'control',
  'action_button',
  'siri',
  'longpress',
  'chip',
];

export type VoiceRouteParams = {
  entry?: VoiceEntry;
  /** "1" when the Android bubble opened the app: Confirm or Close then send the app back. */
  returnToPrevious?: '1' | 'true';
  /** Debug clip name used instead of the microphone (development and e2e builds only). */
  fixture?: string;
};

/** Where a voice sheet entry comes from; anything unknown counts as the in-app long-press. */
export const parseEntry = (value: string | undefined): VoiceEntry =>
  VOICE_ENTRIES.find((entry) => entry === value) ?? 'longpress';

/** Entries that start outside the app: the phone may lie on the counter, so tap to stop. */
export const isExternalEntry = (entry: VoiceEntry) =>
  entry !== 'longpress' && entry !== 'chip';

export const parseReturnToPrevious = (value: string | undefined) =>
  value === '1' || value === 'true';

/** Expo Router href for the voice sheet; undefined params are left out. */
export function voiceHref(params: {
  entry: VoiceEntry;
  returnToPrevious?: boolean;
  fixture?: string;
}) {
  const query: Record<string, string> = { entry: params.entry };
  if (params.returnToPrevious) query.returnToPrevious = '1';
  if (params.fixture) query.fixture = params.fixture;
  return { pathname: '/voice' as const, params: query };
}
