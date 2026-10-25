export type NextStepKind =
  | 'receipt_detected'
  | 'unknown_product'
  | 'restock'
  | 'draft_receipts'
  | 'overdue_debts'
  | 'day_close'
  | 'review_queue'
  | 'digest'
  | 'setup'
  | 'margin_alert';

export type SignInMethod = 'email_code' | 'google';

/**
 * Product event properties supplied by the app. The PostHog sink in X6 adds
 * common properties (member_id, role, environment, app_version, language) and
 * the store group. Props must never carry names, emails, phone numbers, bank
 * numbers, tokens, or OCR text.
 */
export type AppEventProps = {
  $screen: { $screen_name: string };
  signed_in: { method: SignInMethod };
  signed_out: { method: SignInMethod };
  account_switched: { with_pin: boolean };
  assistant_opened: {
    entry: 'button' | 'chip' | 'receipt' | 'digest' | 'push';
  };
  assistant_message_sent: { input: 'text' | 'voice'; thread_turn: number };
  assistant_reply_received: {
    latency_ms: number;
    tools_count: number;
    error_code: string | null;
  };
  assistant_feedback_given: { rating: 'up' | 'down' };
  next_step_shown: { kind: NextStepKind; position: number };
  next_step_tapped: { kind: NextStepKind; position: number };
  digest_opened: { entry: 'card' | 'push' };
  voice_input_used: {
    duration_ms: number;
    language: 'vi-VN' | 'en-US';
    ok: boolean;
  };
};

export type AppEventName = keyof AppEventProps;

export interface AnalyticsSink {
  capture<E extends AppEventName>(event: E, props: AppEventProps[E]): void;
}

const noopSink: AnalyticsSink = { capture: () => {} };
let currentSink: AnalyticsSink = noopSink;

export function setAnalyticsSink(sink: AnalyticsSink | null): void {
  currentSink = sink ?? noopSink;
}

export function capture<E extends AppEventName>(
  event: E,
  props: AppEventProps[E],
): void {
  try {
    currentSink.capture(event, props);
  } catch {
    // Analytics must never interrupt the app's user-facing flow.
  }
}
