import type { components } from '@taphoa/api-client';
import { newUuid } from '@/lib/uuid';
import { businessDate } from '@/lib/date';
import { getMockDb, nowIso } from './db';
import { badRequest, conflict, notFound } from './errors';
import { PRODUCT_IDS } from './fixtures';
import { adjustStock } from './stockReceipts';
import { asObject, isUuid, paginate, parseDate } from './validate';

type S = components['schemas'];
export type AssistantReplyScript = S['AssistantStreamEvent'][];
type ThreadRecord = { owner: string; detail: S['AssistantThreadDetail'] };
const threads = new Map<string, ThreadRecord>();
const devices = new Map<string, S['Device']>();
const confirmations = new Map<string, S['AssistantAction']>();
let nextReply: AssistantReplyScript | undefined;

export function resetAssistantMock() {
  threads.clear();
  devices.clear();
  confirmations.clear();
  nextReply = undefined;
}
/** One-shot script. IDs are bound to the receiving thread/message when sent. */
export function setNextAssistantReply(script: AssistantReplyScript) {
  nextReply = JSON.parse(JSON.stringify(script)) as AssistantReplyScript;
}
export function quotaReply(): AssistantReplyScript {
  return [
    {
      event: 'error',
      data: { code: 'quota', message_vi: 'Bạn đã hết lượt trợ lý hôm nay.' },
    },
  ];
}
const complete = (messageId: string): S['AssistantStreamEvent'] => ({
  event: 'message.completed',
  data: {
    message_id: messageId,
    model: 'mock/assistant',
    usage: { input_tokens: 12, output_tokens: 18 },
  },
});
export function proposalReply(): AssistantReplyScript {
  const created = nowIso();
  const action: S['AssistantAction'] = {
    id: newUuid(),
    thread_id: newUuid(),
    message_id: newUuid(),
    kind: 'stock_adjustment',
    status: 'proposed',
    payload: { product_id: PRODUCT_IDS.haohao, delta: 12 },
    summary_vi: 'Thêm 12 gói mì vào kho',
    proposed_by: getMockDb().currentMemberId,
    decided_by: null,
    decided_at: null,
    result: null,
    error: null,
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    created_at: created,
  };
  const card: S['AssistantCard'] = {
    type: 'restock_list',
    items: [
      {
        product_id: PRODUCT_IDS.haohao,
        name: 'Mì Hảo Hảo',
        quantity: 12,
        unit_cost: null,
        total_cost: null,
      },
    ],
    total_cost: null,
  };
  return [
    {
      event: 'message.created',
      data: { message_id: action.message_id, thread_id: action.thread_id },
    },
    {
      event: 'message.delta',
      data: { text: 'Bạn có thể nhập thêm 12 gói mì Hảo Hảo.' },
    },
    { event: 'action.proposed', data: action },
    { event: 'card', data: card },
    complete(action.message_id),
  ];
}
function defaultReply(
  threadId: string,
  messageId: string,
): AssistantReplyScript {
  const call = { call_id: newUuid(), tool: 'get_sales_summary' };
  return [
    {
      event: 'message.created',
      data: { thread_id: threadId, message_id: messageId },
    },
    {
      event: 'tool.started',
      data: { ...call, label_vi: 'Đang xem doanh thu…' },
    },
    {
      event: 'tool.finished',
      data: { ...call, ok: true, summary_vi: 'Doanh thu hôm nay: 1.234.000 ₫' },
    },
    ...['Hôm nay cửa hàng ', 'có doanh thu ', '1.234.000 ₫.'].map(
      (text): S['AssistantStreamEvent'] => ({
        event: 'message.delta',
        data: { text },
      }),
    ),
    complete(messageId),
  ];
}

function string(value: unknown, field: string, max = Infinity): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max)
    throw badRequest(`${field}: invalid string`);
  return value;
}
function keys(body: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(body).some((key) => !allowed.includes(key)))
    throw badRequest('Unexpected property');
}
function uuid(value: unknown, field: string): string {
  if (!isUuid(value)) throw badRequest(`${field}: must be a UUID`);
  return value;
}
function language(value: unknown): S['AssistantLanguage'] {
  if (value !== 'vi' && value !== 'en')
    throw badRequest('language: must be vi or en');
  return value;
}
function context(value: unknown): S['AssistantThreadContext'] {
  const o = asObject(value);
  keys(o, ['screen', 'next_step_id', 'receipt_id', 'image_id']);
  return {
    screen: string(o.screen, 'screen'),
    ...(o.next_step_id === undefined
      ? {}
      : {
          next_step_id:
            typeof o.next_step_id === 'string'
              ? o.next_step_id
              : string(o.next_step_id, 'next_step_id'),
        }),
    ...(o.receipt_id === undefined
      ? {}
      : { receipt_id: uuid(o.receipt_id, 'receipt_id') }),
    ...(o.image_id === undefined
      ? {}
      : { image_id: uuid(o.image_id, 'image_id') }),
  };
}
export function createThread(value: unknown): S['AssistantThread'] {
  const o = asObject(value);
  keys(o, ['title', 'context']);
  const thread: S['AssistantThread'] = {
    id: newUuid(),
    title: o.title === undefined ? null : string(o.title, 'title'),
    context: o.context === undefined ? null : context(o.context),
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  threads.set(thread.id, {
    owner: getMockDb().currentMemberId,
    detail: { thread, messages: [], actions: [] },
  });
  return thread;
}
export function getThread(id: string): S['AssistantThreadDetail'] {
  uuid(id, 'threadId');
  const record = threads.get(id);
  if (!record || record.owner !== getMockDb().currentMemberId)
    throw notFound('Thread');
  return record.detail;
}
export function listThreads(query: URLSearchParams): S['AssistantThreadPage'] {
  const items = [...threads.values()]
    .reverse()
    .filter((r) => r.owner === getMockDb().currentMemberId)
    .map((r) => r.detail.thread)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return paginate(items, query);
}
export function deleteThread(id: string) {
  getThread(id);
  threads.delete(id);
}

export function sendMessage(id: string, value: unknown): AssistantReplyScript {
  const detail = getThread(id);
  const o = asObject(value);
  keys(o, ['content', 'language', 'attachments']);
  const content = string(o.content, 'content', 4000);
  language(o.language);
  let attachments: S['AssistantAttachment'][] = [];
  if (o.attachments !== undefined) {
    if (!Array.isArray(o.attachments))
      throw badRequest('attachments: must be an array');
    attachments = o.attachments.map((value) => {
      const a = asObject(value);
      keys(a, ['image_id', 'receipt_id']);
      if (Object.keys(a).length !== 1)
        throw badRequest(
          'attachment requires exactly one image_id or receipt_id',
        );
      return 'image_id' in a
        ? { image_id: uuid(a.image_id, 'image_id') }
        : { receipt_id: uuid(a.receipt_id, 'receipt_id') };
    });
  }
  const makeMessage = (
    role: S['AssistantMessage']['role'],
  ): S['AssistantMessage'] => ({
    id: newUuid(),
    thread_id: id,
    role,
    content: '',
    attachments: [],
    tool_calls: [],
    cards: [],
    model: null,
    feedback: null,
    created_at: nowIso(),
  });
  const user = { ...makeMessage('user'), content, attachments };
  const assistant = makeMessage('assistant');
  const script = nextReply ?? defaultReply(id, assistant.id);
  nextReply = undefined;
  const events: AssistantReplyScript = [];
  for (const original of script) {
    let event = original;
    if (event.event === 'message.created')
      event = { ...event, data: { thread_id: id, message_id: assistant.id } };
    if (event.event === 'message.completed') {
      event = { ...event, data: { ...event.data, message_id: assistant.id } };
      assistant.model = event.data.model;
    }
    if (event.event === 'message.delta') assistant.content += event.data.text;
    if (event.event === 'tool.finished') assistant.tool_calls.push(event.data);
    if (event.event === 'card') assistant.cards.push(event.data);
    if (event.event === 'action.proposed') {
      const action: S['AssistantAction'] = {
        ...event.data,
        thread_id: id,
        message_id: assistant.id,
        proposed_by: getMockDb().currentMemberId,
      };
      detail.actions.push(action);
      event = { event: 'action.proposed', data: action };
    }
    events.push(event);
    if (event.event === 'message.completed' || event.event === 'error') break;
  }
  detail.messages.push(user);
  if (events.some((e) => e.event === 'message.completed'))
    detail.messages.push(assistant);
  detail.thread.updated_at = nowIso();
  return events;
}
function findAction(id: string): S['AssistantAction'] {
  uuid(id, 'actionId');
  for (const { owner, detail } of threads.values()) {
    if (owner !== getMockDb().currentMemberId) continue;
    const action = detail.actions.find((a) => a.id === id);
    if (action) return action;
  }
  throw notFound('Action');
}
export function decideAction(
  id: string,
  confirm: boolean,
  key?: string | null,
): S['AssistantAction'] {
  if (confirm && !key) throw badRequest('Idempotency-Key is required');
  const action = findAction(id);
  const replayKey = `${getMockDb().currentMemberId}:${id}:${key}`;
  if (confirm && confirmations.has(replayKey))
    return confirmations.get(replayKey)!;
  if (action.status !== 'proposed' && action.status !== 'expired')
    throw conflict('already_decided', 'Action is already decided');
  if (
    action.status === 'expired' ||
    Date.parse(action.expires_at) <= Date.now()
  )
    throw conflict('action_stale', 'Action has expired');
  const result: S['AssistantAction']['result'] = confirm ? { ok: true } : null;
  if (confirm && action.kind === 'stock_adjustment') {
    const productId = uuid(action.payload.product_id, 'product_id');
    const delta = action.payload.delta;
    if (
      typeof delta !== 'number' ||
      !Number.isSafeInteger(delta) ||
      delta === 0
    )
      throw badRequest('Invalid stock adjustment');
    const movement = adjustStock(productId, { delta });
    result!.movement_id = movement.id;
  }
  Object.assign(action, {
    status: confirm ? 'done' : 'rejected',
    decided_by: getMockDb().currentMemberId,
    decided_at: nowIso(),
    result,
  });
  if (confirm)
    confirmations.set(
      replayKey,
      JSON.parse(JSON.stringify(action)) as S['AssistantAction'],
    );
  return action;
}
export function saveFeedback(id: string, value: unknown) {
  uuid(id, 'messageId');
  const o = asObject(value);
  keys(o, ['rating', 'comment']);
  if (o.rating !== 'up' && o.rating !== 'down')
    throw badRequest('Invalid rating');
  if (o.comment !== undefined && typeof o.comment !== 'string')
    throw badRequest('Invalid comment');
  const feedback: S['AssistantFeedback'] = {
    rating: o.rating,
    ...(typeof o.comment === 'string' ? { comment: o.comment } : {}),
  };
  for (const { owner, detail } of threads.values()) {
    const message = detail.messages.find(
      (m) => m.id === id && m.role === 'assistant',
    );
    if (owner === getMockDb().currentMemberId && message) {
      message.feedback = feedback;
      return;
    }
  }
  throw notFound('Message');
}
export function nextSteps(query: URLSearchParams): S['NextStepList'] {
  string(query.get('screen'), 'screen');
  for (const key of ['document_detected', 'unknown_product'])
    if (query.has(key) && !['true', 'false'].includes(query.get(key)!))
      throw badRequest(`Invalid ${key}`);
  return {
    items: [
      {
        id: 'restock',
        kind: 'restock',
        title_vi: 'Cần nhập hàng',
        subtitle_vi: null,
        priority: 1,
        action: {
          type: 'chat',
          prompt_vi: 'Tôi nên nhập thêm hàng gì?',
          context: { screen: query.get('screen')!, next_step_id: 'restock' },
        },
      },
      {
        id: 'draft_receipts',
        kind: 'draft_receipts',
        title_vi: 'Hóa đơn nháp',
        subtitle_vi: null,
        priority: 2,
        action: { type: 'navigate', route: '/receipts' },
      },
    ],
  };
}
export function getDigest(query: URLSearchParams): S['Digest'] {
  const date = query.has('business_date')
    ? parseDate(query.get('business_date')!, 'business_date')
    : businessDate();
  if (date !== businessDate()) throw notFound('Digest');
  return {
    business_date: date,
    generated_at: nowIso(),
    source: 'template',
    summary_vi: 'Doanh thu hôm nay là 1.234.000 ₫.',
    sales: {
      revenue: 1234000,
      sale_count: 24,
      gross_profit: null,
      change_pct: null,
    },
    restock: [],
    overdue_debts: { count: 0, total: 0 },
    open_drafts: { count: 1 },
    read_at: null,
  };
}
export function registerDevice(value: unknown): S['Device'] {
  const o = asObject(value);
  keys(o, ['token', 'platform', 'app_version', 'language']);
  if (o.platform !== 'android' && o.platform !== 'ios')
    throw badRequest('Invalid platform');
  const input: S['RegisterDevice'] = {
    token: string(o.token, 'token'),
    platform: o.platform,
    app_version: string(o.app_version, 'app_version'),
    language: language(o.language),
  };
  const device: S['Device'] = {
    ...input,
    created_at: devices.get(input.token)?.created_at ?? nowIso(),
    updated_at: nowIso(),
  };
  devices.set(input.token, device);
  return device;
}
export function deleteDevice(token: string) {
  devices.delete(token);
}
