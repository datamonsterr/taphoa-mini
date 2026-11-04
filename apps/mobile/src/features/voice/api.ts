import { useMutation } from '@tanstack/react-query';

import type { VoiceOutcomeRequest, VoiceUtterance } from '@taphoa/api-client';

import { getApiClient } from '@/lib/api/client';
import { isApiError, unwrap } from '@/lib/api/errors';
import type { VoiceEntry } from '@/lib/analytics';

import { clipToUpload, type VoiceClip } from './fixture';

export type VoiceContextEntry = VoiceEntry | 'chat';

export type UtteranceInput = {
  clip: VoiceClip;
  mode: 'sale' | 'transcribe';
  language: 'vi' | 'en';
  entry: VoiceContextEntry;
  screen: string;
  threadId?: string;
};

/** POST /v1/voice/utterances: the clip goes up, the transcript (and the draft in sale mode) comes back. */
export async function uploadUtterance(
  input: UtteranceInput,
): Promise<VoiceUtterance> {
  const { audio, filename } = await clipToUpload(input.clip);
  return unwrap(
    getApiClient().createVoiceUtterance({
      audio,
      filename,
      mode: input.mode,
      language: input.language,
      context: {
        entry: input.entry,
        screen: input.screen,
        ...(input.threadId ? { thread_id: input.threadId } : {}),
      },
    }),
  );
}

/**
 * `networkMode: 'always'`: offline the upload must fail so the sheet can fall back to on-device
 * recognition; with the default it waits for the network and "Đang hiểu…" never ends.
 */
export const useVoiceUtterance = () =>
  useMutation({ mutationFn: uploadUtterance, networkMode: 'always' });

/** POST /v1/voice/utterances/{id}/outcome. Best effort: the sale never waits for it. */
export async function postOutcome(
  utteranceId: string,
  body: VoiceOutcomeRequest,
): Promise<void> {
  try {
    await unwrap(getApiClient().postVoiceOutcome(utteranceId, body));
  } catch {
    // Alias learning only; losing one outcome costs nothing the seller sees.
  }
}

export const usePostVoiceOutcome = () =>
  useMutation({
    mutationFn: (input: { utteranceId: string; body: VoiceOutcomeRequest }) =>
      postOutcome(input.utteranceId, input.body),
  });

export type VoiceFailure =
  | 'no_speech'
  | 'quota'
  /** The server could not parse it, or the phone is offline: fall back to on-device recognition. */
  | 'unavailable'
  | 'other';

/** Maps an upload failure to what the sheet shows. A non-API error is a network failure. */
export function classifyFailure(error: unknown): VoiceFailure {
  if (!isApiError(error)) return 'unavailable';
  if (error.status === 422 && error.code === 'no_speech') return 'no_speech';
  if (error.status === 429) return 'quota';
  if (error.status === 503 || error.code === 'voice_unavailable')
    return 'unavailable';
  return 'other';
}
