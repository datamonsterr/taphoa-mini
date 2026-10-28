import createClient, { type Middleware } from 'openapi-fetch';
import type { components, paths } from './schema';
import {
  AssistantStreamInterruptedError,
  readAssistantStream,
  type AssistantStreamEvent,
  type StreamOptions,
} from './sse.ts';
export {
  parseSseStream,
  readAssistantStream,
  AssistantStreamInterruptedError,
  AssistantStreamProtocolError,
  type SseFrame,
  type StreamOptions,
  type AssistantStreamEvent,
} from './sse.ts';

export type { components, paths };
export type Image = components['schemas']['Image'];
export type ImagePurpose = components['schemas']['ImagePurpose'];

export interface ApiClientOptions {
  /** API origin, e.g. https://api.example.com. Trailing slashes are ignored. */
  baseUrl: string;
  /** Returns the bearer access token, or null when signed out. */
  getToken?: () => string | null | Promise<string | null>;
  /** Current PostHog replay session, if analytics is enabled. */
  getSessionId?: () => string | null | undefined;
  /** Returns the selected store id, or null/undefined when no store is selected. */
  getStoreId?: () =>
    string | null | undefined | Promise<string | null | undefined>;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

/** W3C ids must be lowercase hex and contain at least one nonzero byte. */
function randomId(bytes: number): string {
  const values = new Uint8Array(bytes);
  if (globalThis.crypto?.getRandomValues)
    globalThis.crypto.getRandomValues(values);
  else
    for (let i = 0; i < bytes; i++) values[i] = Math.floor(Math.random() * 256);
  if (values.every((value) => value === 0)) values[bytes - 1] = 1;
  return Array.from(values, (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('');
}

/** Fails on first read; avoids a ReadableStream constructor, absent in React Native. */
async function* interruptedStream(): AsyncGenerator<AssistantStreamEvent> {
  throw new AssistantStreamInterruptedError();
}

export function createApiClient(options: ApiClientOptions) {
  const client = createClient<paths>({
    baseUrl: options.baseUrl.replace(/\/+$/, ''),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  client.use({
    onRequest({ request }) {
      const sessionId = options.getSessionId?.();
      if (sessionId) request.headers.set('X-POSTHOG-SESSION-ID', sessionId);
      if (!request.headers.has('traceparent')) {
        request.headers.set(
          'traceparent',
          `00-${randomId(16)}-${randomId(8)}-01`,
        );
      }
      return request;
    },
  });

  if (options.getToken) {
    const getToken = options.getToken;
    const auth: Middleware = {
      async onRequest({ request }) {
        const token = await getToken();
        if (token) request.headers.set('Authorization', `Bearer ${token}`);
        return request;
      },
    };
    client.use(auth);
  }

  if (options.getStoreId) {
    const getStoreId = options.getStoreId;
    const store: Middleware = {
      async onRequest({ request }) {
        const storeId = await getStoreId();
        if (storeId) request.headers.set('X-Store-Id', storeId);
        return request;
      },
    };
    client.use(store);
  }

  return {
    raw: client,
    sendAssistantMessage: async (
      threadId: string,
      body: components['schemas']['SendAssistantMessage'],
      streamOptions: StreamOptions = {},
    ) => {
      const result = await client.POST(
        '/v1/assistant/threads/{threadId}/messages',
        {
          params: { path: { threadId } },
          body,
          headers: { Accept: 'text/event-stream' },
          parseAs: 'stream',
          signal: streamOptions.signal,
        },
      );
      if (!result.response.ok)
        return { error: result.error, response: result.response };
      // A successful empty response still represents an interrupted assistant stream.
      return {
        events:
          result.data == null
            ? interruptedStream()
            : readAssistantStream(result.data, streamOptions),
        response: result.response,
      };
    },
    getHealth: () => client.GET('/healthz'),
    getImage: (imageId: string) =>
      client.GET('/v1/images/{imageId}', {
        params: { path: { imageId } },
      }),
    uploadImage: (file: Blob, purpose?: ImagePurpose) =>
      client.POST('/v1/images', {
        // The generated type models a binary part as string; the serializer sends a real file part.
        body: { image: file as unknown as string, purpose },
        bodySerializer: () => {
          const form = new FormData();
          form.append('image', file);
          if (purpose) form.append('purpose', purpose);
          return form;
        },
      }),
    createVoiceUtterance: (input: CreateVoiceUtteranceInput) =>
      client.POST('/v1/voice/utterances', {
        // The generated type models a binary part as string; the serializer sends a real file part.
        body: {
          audio: input.audio as unknown as string,
          mode: input.mode,
          language: input.language,
          context: JSON.stringify(input.context),
        },
        bodySerializer: () => {
          const form = new FormData();
          const { audio } = input;
          if (isReactNativeFile(audio)) {
            // React Native FormData reads {uri, name, type} objects as file parts.
            form.append('audio', audio as unknown as Blob);
          } else {
            form.append('audio', audio, input.filename ?? 'utterance.m4a');
          }
          form.append('mode', input.mode);
          form.append('language', input.language ?? 'vi');
          form.append('context', JSON.stringify(input.context));
          return form;
        },
      }),
    postVoiceOutcome: (utteranceId: string, body: VoiceOutcomeRequest) =>
      client.POST('/v1/voice/utterances/{utteranceId}/outcome', {
        params: { path: { utteranceId } },
        body,
      }),
  };
}

/** React Native file part: `FormData` accepts this object in place of a Blob. */
export type ReactNativeFile = { uri: string; name: string; type: string };

export type CreateVoiceUtteranceInput = {
  audio: Blob | ReactNativeFile;
  /** File name for a web Blob part; ignored for React Native files (they carry `name`). */
  filename?: string;
  mode: 'sale' | 'transcribe';
  language?: 'vi' | 'en';
  context: components['schemas']['VoiceUtteranceContext'];
};

function isReactNativeFile(
  value: Blob | ReactNativeFile,
): value is ReactNativeFile {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ReactNativeFile).uri === 'string' &&
    typeof Blob !== 'undefined' &&
    !(value instanceof Blob)
  );
}

export type VoiceUtterance = components['schemas']['VoiceUtterance'];

export type VoiceSaleDraft = components['schemas']['VoiceSaleDraft'];

export type VoiceDraftLine = components['schemas']['VoiceDraftLine'];

export type CustomerMatch = components['schemas']['CustomerMatch'];

export type VoiceOutcomeRequest = components['schemas']['VoiceOutcomeRequest'];

export type ApiClient = ReturnType<typeof createApiClient>;

export type AssistantAction = components['schemas']['AssistantAction'];

export type AssistantMessage = components['schemas']['AssistantMessage'];

export type AssistantThread = components['schemas']['AssistantThread'];

export type AssistantCard = components['schemas']['AssistantCard'];

export type NextStep = components['schemas']['NextStep'];

export type Digest = components['schemas']['Digest'];

export type Device = components['schemas']['Device'];
