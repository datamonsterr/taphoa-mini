import createClient, { type Middleware } from 'openapi-fetch';
import type { components, paths } from './schema';
import { readAssistantStream, type StreamOptions } from './sse';
export {
  parseSseStream,
  readAssistantStream,
  AssistantStreamInterruptedError,
  AssistantStreamProtocolError,
  type SseFrame,
  type StreamOptions,
  type AssistantStreamEvent,
} from './sse';

export type { components, paths };
export type Image = components['schemas']['Image'];
export type ImagePurpose = components['schemas']['ImagePurpose'];

export interface ApiClientOptions {
  /** API origin, e.g. https://api.example.com. Trailing slashes are ignored. */
  baseUrl: string;
  /** Returns the bearer access token, or null when signed out. */
  getToken?: () => string | null | Promise<string | null>;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

export function createApiClient(options: ApiClientOptions) {
  const client = createClient<paths>({
    baseUrl: options.baseUrl.replace(/\/+$/, ''),
    ...(options.fetch ? { fetch: options.fetch } : {}),
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
      const bodyStream =
        result.data ??
        new ReadableStream<Uint8Array>({
          start(c) {
            c.close();
          },
        });
      return {
        events: readAssistantStream(bodyStream, streamOptions),
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
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

export type AssistantAction = components['schemas']['AssistantAction'];

export type AssistantMessage = components['schemas']['AssistantMessage'];

export type AssistantThread = components['schemas']['AssistantThread'];

export type AssistantCard = components['schemas']['AssistantCard'];

export type NextStep = components['schemas']['NextStep'];

export type Digest = components['schemas']['Digest'];

export type Device = components['schemas']['Device'];
