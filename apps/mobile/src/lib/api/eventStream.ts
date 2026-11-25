import type { MobileStoreEvent } from './events';

type Receive = (event: string, data: string, id: string) => void;

/** Incremental SSE framing, including CRLF split across network chunks. */
export class SseParser {
  private buffer = '';
  private event = '';
  private data: string[] = [];
  private id = '';
  constructor(private readonly receive: Receive) {}
  push(chunk: string) {
    this.buffer += chunk;
    let match: RegExpExecArray | null;
    while ((match = /\r\n|\r(?!$)|\n/.exec(this.buffer))) {
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      if (!line) {
        if (this.data.length)
          this.receive(this.event || 'message', this.data.join('\n'), this.id);
        this.event = '';
        this.data = [];
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') this.data.push(value);
      if (field === 'event') this.event = value;
      if (field === 'id' && !value.includes('\0')) this.id = value;
    }
  }
}

export const reconnectDelay = (attempt: number, random: number) =>
  Math.min(30000, 1000 * 2 ** Math.min(attempt, 16)) * (0.5 + random);

type Options = {
  url: string;
  storeId: string;
  token: (refresh?: boolean) => Promise<string | null>;
  transport: (
    url: string,
    init: { headers: Record<string, string>; signal: AbortSignal },
  ) => Promise<{
    status: number;
    ok: boolean;
    body: ReadableStream<Uint8Array> | null;
  }>;
  dispatch: (event: MobileStoreEvent) => void;
  connected: () => void;
  random?: () => number;
};

export class EventStream {
  private stopped = true;
  private abort?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private lastId = '';
  private attempt = 0;
  private generation = 0;
  constructor(private readonly options: Options) {}
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.generation++;
    void this.connect(this.generation);
  }
  stop() {
    this.stopped = true;
    this.generation++;
    this.abort?.abort();
    clearTimeout(this.timer);
  }
  private async connect(generation: number) {
    const inactive = () => this.stopped || generation !== this.generation;
    const abort = new AbortController();
    this.abort = abort;
    try {
      let token = await this.options.token();
      if (inactive() || !token) throw new Error('No session');
      const send = () =>
        this.options.transport(this.options.url, {
          signal: abort.signal,
          headers: {
            Accept: 'text/event-stream',
            Authorization: `Bearer ${token}`,
            'X-Store-Id': this.options.storeId,
            ...(this.lastId ? { 'Last-Event-ID': this.lastId } : {}),
          },
        });
      let response = await send();
      if (response.status === 401 && !inactive()) {
        token = await this.options.token(true);
        if (inactive() || !token) throw new Error('No session');
        response = await send();
      }
      if (!response.ok || !response.body || inactive())
        throw new Error('Stream unavailable');
      this.options.connected();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser((type, data, id) => {
        if (inactive()) return;
        try {
          const event = JSON.parse(data) as MobileStoreEvent;
          if (
            event.type !== type ||
            !event.data ||
            typeof event.occurred_at !== 'string'
          )
            return;
          this.options.dispatch(event);
          if (id) this.lastId = id;
          this.attempt = 0;
        } catch {
          /* Ignore invalid envelopes. */
        }
      });
      while (!inactive()) {
        const part = await reader.read();
        if (part.done) break;
        parser.push(decoder.decode(part.value, { stream: true }));
      }
    } catch {
      /* Retry while the session is active. */
    }
    if (!inactive()) {
      const delay = reconnectDelay(
        this.attempt++,
        (this.options.random ?? Math.random)(),
      );
      this.timer = setTimeout(() => void this.connect(generation), delay);
    }
  }
}
