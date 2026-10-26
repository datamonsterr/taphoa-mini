import type { AssistantAction, AssistantCard } from '@taphoa/api-client';

import type { AssistantChatMessage, ChatMessage } from './chatReducer';
import {
  deriveReceiptPhase,
  latestReceiptAction,
  initialReceiptChatState,
  receiptChatReducer,
  receiptEventFor,
  type ReceiptChatEvent,
  type ReceiptChatState,
} from './receiptChat';

const RECEIPT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const state = (
  phase: ReceiptChatState['phase'],
  failure: ReceiptChatState['failure'] = null,
): ReceiptChatState => ({ phase, failure });

const run = (from: ReceiptChatState, ...events: ReceiptChatEvent[]) =>
  events.reduce(receiptChatReducer, from);

const EVENT_TYPES = [
  'threadCreated',
  'threadFailed',
  'linesArrived',
  'actionProposed',
  'confirmStarted',
  'confirmed',
  'rejected',
  'expired',
  'actionFailed',
  'streamFailed',
  'retry',
] as const;

describe('receiptChatReducer', () => {
  test('starts in creating_thread', () => {
    expect(initialReceiptChatState).toEqual(state('creating_thread'));
  });

  test('walks the happy path', () => {
    let s = initialReceiptChatState;
    const seen: string[] = [];
    for (const type of [
      'threadCreated',
      'linesArrived',
      'actionProposed',
      'confirmStarted',
      'confirmed',
    ] as const) {
      s = receiptChatReducer(s, { type });
      seen.push(s.phase);
    }
    expect(seen).toEqual([
      'sending',
      'reviewing',
      'awaiting_confirm',
      'confirming',
      'confirmed',
    ]);
  });

  test.each([
    ['sending', 'actionProposed', 'awaiting_confirm'],
    ['awaiting_confirm', 'confirmed', 'confirmed'],
    ['awaiting_confirm', 'rejected', 'rejected'],
    ['confirming', 'rejected', 'rejected'],
    ['awaiting_confirm', 'expired', 'expired'],
    ['confirming', 'expired', 'expired'],
    ['rejected', 'actionProposed', 'awaiting_confirm'],
    ['expired', 'actionProposed', 'awaiting_confirm'],
  ] as const)('%s + %s -> %s', (from, type, to) => {
    expect(run(state(from), { type }).phase).toBe(to);
  });

  test('failures carry their source', () => {
    expect(run(state('creating_thread'), { type: 'threadFailed' })).toEqual(
      state('failed', 'thread'),
    );
    expect(run(state('sending'), { type: 'streamFailed' })).toEqual(
      state('failed', 'stream'),
    );
    expect(run(state('reviewing'), { type: 'streamFailed' })).toEqual(
      state('failed', 'stream'),
    );
    expect(run(state('awaiting_confirm'), { type: 'actionFailed' })).toEqual(
      state('failed', 'action'),
    );
    expect(run(state('confirming'), { type: 'actionFailed' })).toEqual(
      state('failed', 'action'),
    );
  });

  test('retry leaves each failure for the step that failed', () => {
    expect(run(state('failed', 'thread'), { type: 'retry' })).toEqual(
      state('creating_thread'),
    );
    expect(run(state('failed', 'stream'), { type: 'retry' })).toEqual(
      state('sending'),
    );
    expect(run(state('failed', 'action'), { type: 'retry' })).toEqual(
      state('sending'),
    );
  });

  test('a failed confirm can be confirmed again from the card', () => {
    expect(
      run(state('failed', 'action'), { type: 'confirmStarted' }).phase,
    ).toBe('confirming');
    expect(run(state('failed', 'action'), { type: 'confirmed' }).phase).toBe(
      'confirmed',
    );
  });

  test('a reopened thread starts from the derived state, only once', () => {
    const derived = state('awaiting_confirm');
    expect(
      run(initialReceiptChatState, { type: 'reopened', state: derived }),
    ).toEqual(derived);
    expect(run(state('sending'), { type: 'reopened', state: derived })).toEqual(
      state('sending'),
    );
  });

  test('confirmed is final', () => {
    const done = state('confirmed');
    for (const type of EVENT_TYPES) expect(run(done, { type })).toBe(done);
  });

  test.each([
    [
      'creating_thread',
      [
        'linesArrived',
        'actionProposed',
        'confirmStarted',
        'confirmed',
        'rejected',
        'expired',
        'actionFailed',
        'streamFailed',
        'retry',
      ],
    ],
    [
      'sending',
      [
        'threadCreated',
        'threadFailed',
        'confirmStarted',
        'confirmed',
        'rejected',
        'expired',
        'actionFailed',
        'retry',
      ],
    ],
    [
      'reviewing',
      [
        'threadCreated',
        'threadFailed',
        'linesArrived',
        'confirmStarted',
        'confirmed',
        'rejected',
        'expired',
        'actionFailed',
        'retry',
      ],
    ],
    [
      'awaiting_confirm',
      [
        'threadCreated',
        'threadFailed',
        'linesArrived',
        'streamFailed',
        'retry',
      ],
    ],
    [
      'confirming',
      [
        'threadCreated',
        'threadFailed',
        'linesArrived',
        'actionProposed',
        'confirmStarted',
        'streamFailed',
        'retry',
      ],
    ],
    [
      'rejected',
      [
        'threadCreated',
        'confirmStarted',
        'confirmed',
        'expired',
        'actionFailed',
        'retry',
      ],
    ],
    [
      'expired',
      [
        'threadCreated',
        'confirmStarted',
        'confirmed',
        'rejected',
        'actionFailed',
        'retry',
      ],
    ],
    [
      'failed',
      [
        'threadCreated',
        'threadFailed',
        'linesArrived',
        'actionProposed',
        'rejected',
        'expired',
        'actionFailed',
        'streamFailed',
      ],
    ],
  ] as const)('%s ignores illegal events', (phase, types) => {
    const from = phase === 'failed' ? state('failed', 'stream') : state(phase);
    for (const type of types) expect(run(from, { type })).toBe(from);
  });
});

const assistant = (
  patch: Partial<AssistantChatMessage> = {},
): AssistantChatMessage => ({
  kind: 'assistant',
  id: 'a1',
  text: '',
  tools: [],
  cards: [],
  actions: [],
  status: 'done',
  feedback: null,
  remote: true,
  ...patch,
});
const user = (): ChatMessage => ({
  kind: 'user',
  id: 'u1',
  content: 'hi',
  attachments: [],
  status: 'sent',
});
const lines = (receiptId = RECEIPT): AssistantCard => ({
  type: 'receipt_lines',
  receipt_id: receiptId,
  lines: [],
});
const action = (
  status: AssistantAction['status'],
  patch: Partial<AssistantAction> = {},
): AssistantAction => ({
  id: 'act-1',
  thread_id: 't',
  message_id: 'a1',
  kind: 'receipt_confirm',
  status,
  payload: { receipt_id: RECEIPT },
  summary_vi: 'Nhập hóa đơn',
  proposed_by: 'm',
  decided_by: null,
  decided_at: null,
  result: null,
  error: null,
  expires_at: '2030-01-01T00:00:00Z',
  created_at: '2026-01-01T00:00:00Z',
  ...patch,
});

describe('deriveReceiptPhase', () => {
  test('a retired failed action no longer decides the phase', () => {
    const old = assistant({ actions: [action('failed')], cards: [lines()] });
    expect(
      deriveReceiptPhase([old], RECEIPT, {
        retiredActionIds: new Set(['act-1']),
      }),
    ).toEqual(state('reviewing'));
    expect(latestReceiptAction([old], RECEIPT)?.id).toBe('act-1');
    expect(latestReceiptAction([user()], RECEIPT)).toBeUndefined();
  });

  test('while sending, an older failed action does not count', () => {
    const old = assistant({
      id: 'a-old',
      actions: [action('failed')],
      cards: [lines()],
    });
    const retried = [old, user(), assistant({ id: 'a-new', cards: [lines()] })];
    expect(deriveReceiptPhase(retried, RECEIPT)).toEqual(
      state('failed', 'action'),
    );
    expect(deriveReceiptPhase(retried, RECEIPT, { sending: true })).toEqual(
      state('reviewing'),
    );
    expect(
      deriveReceiptPhase(
        [old, user(), assistant({ status: 'streaming' })],
        RECEIPT,
        { sending: true },
      ),
    ).toEqual(state('sending'));
    expect(
      deriveReceiptPhase(
        [
          old,
          user(),
          assistant({
            id: 'a-new',
            actions: [action('proposed', { id: 'n' })],
          }),
        ],
        RECEIPT,
        { sending: true },
      ),
    ).toEqual(state('awaiting_confirm'));
  });

  test('no messages: still sending', () => {
    expect(deriveReceiptPhase([], RECEIPT)).toEqual(state('sending'));
  });

  test('a user message and a streaming reply: sending', () => {
    expect(
      deriveReceiptPhase([user(), assistant({ status: 'streaming' })], RECEIPT),
    ).toEqual(state('sending'));
  });

  test('a lines card for this receipt: reviewing', () => {
    expect(
      deriveReceiptPhase([user(), assistant({ cards: [lines()] })], RECEIPT),
    ).toEqual(state('reviewing'));
  });

  test('a lines card of another receipt does not count', () => {
    expect(
      deriveReceiptPhase(
        [user(), assistant({ status: 'streaming', cards: [lines(OTHER)] })],
        RECEIPT,
      ),
    ).toEqual(state('sending'));
  });

  test('a finished reply without lines is a stream failure', () => {
    expect(deriveReceiptPhase([user(), assistant()], RECEIPT)).toEqual(
      state('failed', 'stream'),
    );
  });

  test('an errored last reply is a stream failure', () => {
    expect(
      deriveReceiptPhase(
        [user(), assistant({ status: 'error', cards: [lines()] })],
        RECEIPT,
      ),
    ).toEqual(state('failed', 'stream'));
  });

  test.each([
    ['proposed', state('awaiting_confirm')],
    ['executing', state('confirming')],
    ['done', state('confirmed')],
    ['rejected', state('rejected')],
    ['expired', state('expired')],
    ['failed', state('failed', 'action')],
  ] as const)('a %s receipt_confirm action', (status, expected) => {
    expect(
      deriveReceiptPhase(
        [user(), assistant({ cards: [lines()], actions: [action(status)] })],
        RECEIPT,
      ),
    ).toEqual(expected);
  });

  test('the latest action wins and an errored follow-up does not hide it', () => {
    const older = assistant({
      id: 'a1',
      cards: [lines()],
      actions: [action('rejected')],
    });
    const newer = assistant({
      id: 'a2',
      actions: [action('proposed', { id: 'act-2' })],
    });
    expect(
      deriveReceiptPhase(
        [user(), older, user(), newer, user(), assistant({ status: 'error' })],
        RECEIPT,
      ),
    ).toEqual(state('awaiting_confirm'));
  });

  test('ignores other kinds and other receipts', () => {
    const other = action('proposed', { payload: { receipt_id: OTHER } });
    const adjust = action('proposed', { kind: 'stock_adjustment', id: 'x' });
    expect(
      deriveReceiptPhase(
        [user(), assistant({ cards: [lines()], actions: [other, adjust] })],
        RECEIPT,
      ),
    ).toEqual(state('reviewing'));
  });

  test('an action without a receipt id in its payload belongs to the thread receipt', () => {
    expect(
      deriveReceiptPhase(
        [
          user(),
          assistant({
            cards: [lines()],
            actions: [action('proposed', { payload: {} })],
          }),
        ],
        RECEIPT,
      ),
    ).toEqual(state('awaiting_confirm'));
  });

  test('a stale action id turns a proposal into expired', () => {
    expect(
      deriveReceiptPhase(
        [
          user(),
          assistant({ cards: [lines()], actions: [action('proposed')] }),
        ],
        RECEIPT,
        { staleActionIds: new Set(['act-1']) },
      ),
    ).toEqual(state('expired'));
  });
});

describe('receiptEventFor', () => {
  test.each([
    [state('creating_thread'), null],
    [state('sending'), null],
    [state('failed', 'thread'), null],
    [state('reviewing'), 'linesArrived'],
    [state('awaiting_confirm'), 'actionProposed'],
    [state('confirming'), 'confirmStarted'],
    [state('confirmed'), 'confirmed'],
    [state('rejected'), 'rejected'],
    [state('expired'), 'expired'],
    [state('failed', 'stream'), 'streamFailed'],
    [state('failed', 'action'), 'actionFailed'],
  ] as const)('%j', (derived, type) => {
    expect(receiptEventFor(derived)?.type ?? null).toBe(type);
  });
});
