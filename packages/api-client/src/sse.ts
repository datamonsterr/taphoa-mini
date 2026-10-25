export type SseFrame = { event: string; data: string; id?: string };
export type StreamOptions = { signal?: AbortSignal };

function abortError() {
  return Object.assign(new Error('Aborted'), { name: 'AbortError' });
}

/** AbortSignal.throwIfAborted is missing from React Native's polyfill. */
function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? abortError();
}

/** Decode WHATWG event-stream framing without connecting or reconnecting. */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  options: StreamOptions = {},
): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let line = '';
  let skipLf = false;
  let data: string[] = [];
  let event = '';
  let id: string | undefined;
  let ended = false;
  const abort = () => {
    void reader.cancel(options.signal?.reason).catch(() => {});
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    throwIfAborted(options.signal);
    while (true) {
      const chunk = await reader.read();
      throwIfAborted(options.signal);
      if (chunk.done) {
        ended = true;
        return;
      }
      const text = decoder.decode(chunk.value, { stream: true });
      for (const char of text) {
        throwIfAborted(options.signal);
        if (skipLf) {
          skipLf = false;
          if (char === '\n') continue;
        }
        if (char !== '\r' && char !== '\n') {
          line += char;
          continue;
        }
        skipLf = char === '\r';
        if (line === '') {
          const frame = data.length
            ? {
                event: event || 'message',
                data: data.join('\n'),
                ...(id === undefined ? {} : { id }),
              }
            : undefined;
          data = [];
          event = '';
          if (frame) yield frame;
        } else if (!line.startsWith(':')) {
          const colon = line.indexOf(':');
          const field = colon < 0 ? line : line.slice(0, colon);
          let value = colon < 0 ? '' : line.slice(colon + 1);
          if (value.startsWith(' ')) value = value.slice(1);
          if (field === 'data') data.push(value);
          else if (field === 'event') event = value;
          else if (field === 'id' && !value.includes('\0')) id = value;
        }
        line = '';
      }
    }
  } finally {
    options.signal?.removeEventListener('abort', abort);
    try {
      if (!ended) await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}

export type AssistantStreamEvent =
  import('./schema').components['schemas']['AssistantStreamEvent'];

export class AssistantStreamInterruptedError extends Error {
  constructor() {
    super('Assistant stream ended before a terminal event');
    this.name = 'AssistantStreamInterruptedError';
  }
}
export class AssistantStreamProtocolError extends Error {
  constructor(cause: unknown) {
    super('Assistant stream contains malformed JSON', { cause });
    this.name = 'AssistantStreamProtocolError';
  }
}

const assistantEvents = new Set<AssistantStreamEvent['event']>([
  'message.created',
  'message.delta',
  'tool.started',
  'tool.finished',
  'action.proposed',
  'card',
  'message.completed',
  'error',
]);

/** Read one assistant response. Never reconnect or resend the message POST. */
export async function* readAssistantStream(
  body: ReadableStream<Uint8Array>,
  options: StreamOptions = {},
): AsyncGenerator<AssistantStreamEvent> {
  const frames = parseSseStream(body, options);
  for await (const frame of frames) {
    if (!assistantEvents.has(frame.event as AssistantStreamEvent['event']))
      continue;
    let data: unknown;
    try {
      data = JSON.parse(frame.data);
    } catch (cause) {
      throw new AssistantStreamProtocolError(cause);
    }
    const event = { event: frame.event, data } as AssistantStreamEvent;
    if (event.event === 'message.completed' || event.event === 'error') {
      await frames.return(undefined);
      yield event;
      return;
    }
    yield event;
  }
  throw new AssistantStreamInterruptedError();
}
