import type { VoiceUtterance } from '@taphoa/api-client';

export type VoiceIntent = 'sale' | 'chat' | 'none';
export type LineStatus = 'matched' | 'ambiguous' | 'unknown';
export type PaymentMethod = 'cash' | 'transfer' | 'credit';

/** One line the listener should hear. */
export type ExpectedLine = {
  /** What is said, as the seller says it ("coca", "hảo hảo"). */
  spoken: string;
  /** Eval store product name, or null for a deliberate unknown. */
  product: string | null;
  /** Optional: match by product id instead of by name. */
  product_id?: string;
  /** Default: `matched` with a product, `unknown` without. */
  status?: LineStatus;
  quantity: number;
  /**
   * Expected unit price in dong: the spoken price, or null when none is spoken
   * (the line must not carry a price from speech).
   */
  unit_price: number | null;
};

/** The sidecar `<id>.json` next to `<id>.m4a`. */
export type VoiceCase = {
  id: string;
  source: 'synthetic' | 'recorded';
  /** What a listener hears. Empty for silence. */
  transcript: string;
  language: 'vi' | 'en';
  intent: VoiceIntent;
  payment_method?: PaymentMethod;
  customer_name?: string | null;
  lines: ExpectedLine[];
  tags: string[];
  /** Synthesis: the transcript is spoken as these segments, voices alternating. */
  segments?: string[];
  /** Synthesis: mix light shop noise. */
  noise?: boolean;
};

/** What came back for one clip. */
export type VoiceOutcome = {
  case_id: string;
  /** HTTP status, or 0 when the request never completed. */
  status: number;
  /** Error code of the body (`no_speech`, `voice_quota`, ...). */
  error_code?: string;
  utterance?: VoiceUtterance;
  /** Wall clock of the request in ms. */
  wall_ms: number;
  /** Cost in USD when the response carried one or PostHog gave it later. */
  cost_usd?: number | null;
};

export type CaseScore = {
  case_id: string;
  tags: string[];
  /** True when the case produced no usable reply (network, 5xx, quota). */
  error: string | null;
  intent_ok: boolean;
  wer: { edits: number; words: number } | null;
  wer_nodiac: { edits: number; words: number } | null;
  lines_expected: number;
  lines_ok: number;
  quantity_ok: number;
  price_ok: number;
  extra_lines: number;
  /** Every expected line right, no extra line, intent right, payment right. */
  exact: boolean;
  payment_ok: boolean | null;
  customer_ok: boolean | null;
};
