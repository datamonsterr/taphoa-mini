import {
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react-native';
import type { AssistantAction } from '@taphoa/api-client';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';

import { getApiClient } from '@/lib/api/client';
import { keys } from '@/lib/api/keys';
import { newUuid } from '@/lib/uuid';
import { useSettingsStore } from '@/stores/settings';
import { setNextAssistantReply, type AssistantReplyScript } from '@/test/mock';
import { registerImage } from '@/test/mock/db';
import { createReceipt, getReceipt } from '@/test/mock/stockReceipts';
import { createTestQueryClient, renderWithProviders } from '@/test/render';

import { AssistantScreen } from './AssistantScreen';
import type { AssistantRouteParams } from './route';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn() },
  useLocalSearchParams: jest.fn(),
}));

const params = (value: Partial<AssistantRouteParams> = {}) =>
  jest.mocked(useLocalSearchParams).mockReturnValue(value as never);

beforeEach(() => {
  jest.clearAllMocks();
  params();
});

const draft = () =>
  createReceipt(
    registerImage({
      contentType: 'image/jpeg',
      byteSize: 100,
      purpose: 'expense_receipt',
    }).id,
  );

const LOW_LINE = {
  line_id: newUuid(),
  name: 'Bánh Chocopie hộp',
  quantity: 5,
  cost: 66000,
  product_id: null,
  product_name: null,
  confidence: null,
};

function proposal(
  receiptId: string,
  patch: Partial<AssistantAction> = {},
): AssistantAction {
  return {
    id: newUuid(),
    thread_id: newUuid(),
    message_id: newUuid(),
    kind: 'receipt_confirm',
    status: 'proposed',
    payload: { receipt_id: receiptId },
    summary_vi: 'Nhập hóa đơn 4 dòng',
    proposed_by: newUuid(),
    decided_by: null,
    decided_at: null,
    result: null,
    error: null,
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    created_at: new Date().toISOString(),
    ...patch,
  };
}

/** The X3 reply for a receipt thread: tool line, `receipt_lines` card, text, then the proposal. */
function receiptReply(
  receiptId: string,
  action?: AssistantAction,
): AssistantReplyScript {
  const call = { call_id: newUuid(), tool: 'get_receipt' };
  return [
    {
      event: 'message.created',
      data: { message_id: newUuid(), thread_id: newUuid() },
    },
    { event: 'tool.started', data: { ...call, label_vi: 'Đang lấy hóa đơn…' } },
    {
      event: 'tool.finished',
      data: { ...call, ok: true, summary_vi: 'Hóa đơn có 4 dòng' },
    },
    {
      event: 'card',
      data: { type: 'receipt_lines', receipt_id: receiptId, lines: [LOW_LINE] },
    },
    { event: 'message.delta', data: { text: 'Còn 1 dòng chưa khớp.' } },
    ...(action ? [{ event: 'action.proposed', data: action } as const] : []),
    {
      event: 'message.completed',
      data: {
        message_id: newUuid(),
        model: 'mock/assistant',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
  ];
}

const statusText = () => within(screen.getByTestId('receipt-status'));
/** Waits for the status row to show `text`. */
const status = (text: string) =>
  waitFor(() => expect(statusText().getByText(text)).toBeTruthy());

/** Holds the next reply's request until `release` is called, so a test can see the state before it. */
function holdNextReply() {
  const client = getApiClient();
  const send = client.sendAssistantMessage.bind(client);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  jest
    .spyOn(client, 'sendAssistantMessage')
    .mockImplementationOnce(async (...args) => {
      await gate;
      return send(...args);
    });
  return release;
}

async function openReceiptChat(
  reply: AssistantReplyScript | ((id: string) => AssistantReplyScript),
) {
  const receipt = draft();
  params({ entry: 'receipt', receiptId: receipt.id, screen: 'camera' });
  setNextAssistantReply(
    typeof reply === 'function' ? reply(receipt.id) : reply,
  );
  const queryClient = createTestQueryClient();
  const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
  await renderWithProviders(<AssistantScreen />, queryClient);
  return { receipt, invalidate };
}

test('shows the reading status at once, with the table link always visible', async () => {
  const release = holdNextReply();
  const { receipt } = await openReceiptChat((id) => receiptReply(id));
  await status('Đang đọc hóa đơn…');
  await fireEvent.press(screen.getByTestId('receipt-status-table'));
  expect(router.push).toHaveBeenCalledWith(`/receipt/${receipt.id}`);
  release();
  await screen.findByText('Còn 1 dòng chưa khớp.');
  expect(screen.getByTestId('receipt-status-table')).toBeTruthy();
});

test('moves to reviewing when the lines arrive, then to awaiting confirm on the proposal', async () => {
  const { receipt } = await openReceiptChat((id) => receiptReply(id));
  await status('Đã đọc xong, xem các dòng bên dưới');
  expect(screen.queryByTestId('action-card')).toBeNull();

  setNextAssistantReply(receiptReply(receipt.id, proposal(receipt.id)));
  await fireEvent.changeText(
    screen.getByTestId('assistant-input'),
    'Dòng nào chưa khớp?',
  );
  await fireEvent.press(screen.getByTestId('assistant-send'));
  await status('Kiểm tra các dòng chưa khớp rồi bấm Xác nhận');
  expect(screen.getByTestId('action-card')).toBeTruthy();
});

test('a tap on a low-confidence line prefills the composer', async () => {
  await openReceiptChat((id) => receiptReply(id, proposal(id)));
  await status('Kiểm tra các dòng chưa khớp rồi bấm Xác nhận');
  await fireEvent.press(screen.getByLabelText('Bánh Chocopie hộp'));
  expect(screen.getByTestId('assistant-input').props.value).toBe(
    "Dòng 'Bánh Chocopie hộp': ",
  );
});

test('confirming shows Đã nhập hàng, refreshes the queries and gives one success haptic', async () => {
  const { receipt, invalidate } = await openReceiptChat((id) =>
    receiptReply(id, proposal(id)),
  );
  await status('Kiểm tra các dòng chưa khớp rồi bấm Xác nhận');
  await fireEvent.press(screen.getByTestId('action-confirm'));
  await status('Đã nhập hàng');
  expect(getReceipt(receipt.id).status).toBe('confirmed');
  await waitFor(() => {
    const invalidated = invalidate.mock.calls.map(([filters]) =>
      JSON.stringify(filters?.queryKey),
    );
    for (const key of [
      keys.receipts.all(),
      keys.stock.all(),
      keys.products.all(),
    ])
      expect(invalidated).toContain(JSON.stringify(key));
  });
  expect(Haptics.notificationAsync).toHaveBeenCalledTimes(1);
  expect(Haptics.notificationAsync).toHaveBeenCalledWith(
    Haptics.NotificationFeedbackType.Success,
  );
  // Only on the move into confirmed, not on every render after it.
  const count = invalidate.mock.calls.length;
  await screen.findByText('Nhập hóa đơn 4 dòng');
  expect(invalidate.mock.calls.length).toBe(count);
});

test('rejecting the proposal shows the skipped status', async () => {
  await openReceiptChat((id) => receiptReply(id, proposal(id)));
  await status('Kiểm tra các dòng chưa khớp rồi bấm Xác nhận');
  await fireEvent.press(screen.getByTestId('action-reject'));
  await status('Đã bỏ qua hóa đơn này');
});

test('a confirm the server refuses as stale shows the expired status', async () => {
  await openReceiptChat((id) =>
    receiptReply(
      id,
      proposal(id, { expires_at: new Date(Date.now() + 600).toISOString() }),
    ),
  );
  await status('Kiểm tra các dòng chưa khớp rồi bấm Xác nhận');
  // The proposal lapses while the card is open (the server reads it as expired on confirm).
  await new Promise((resolve) => setTimeout(resolve, 700));
  await fireEvent.press(screen.getByTestId('action-confirm'));
  await status('Hóa đơn đã thay đổi, mở lại để kiểm tra');
});

test('reopening a stored thread lands in its phase without refreshing anything', async () => {
  const receipt = draft();
  const created = await getApiClient().raw.POST('/v1/assistant/threads', {
    body: { context: { screen: 'camera', receipt_id: receipt.id } },
  });
  setNextAssistantReply(
    receiptReply(
      receipt.id,
      proposal(receipt.id, {
        expires_at: new Date(Date.now() - 1000).toISOString(),
      }),
    ),
  );
  const sent = await getApiClient().sendAssistantMessage(created.data!.id, {
    content: 'Kiểm tra hóa đơn này giúp tôi.',
    language: 'vi',
  });
  for await (const event of sent.events!) void event;

  params({ threadId: created.data!.id, entry: 'button' });
  const queryClient = createTestQueryClient();
  const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
  await renderWithProviders(<AssistantScreen />, queryClient);
  await status('Hóa đơn đã thay đổi, mở lại để kiểm tra');
  expect(Haptics.notificationAsync).not.toHaveBeenCalled();
  expect(
    invalidate.mock.calls.some(([f]) =>
      JSON.stringify(f?.queryKey).includes('stock'),
    ),
  ).toBe(false);
});

test('a new chat leaves the receipt behind', async () => {
  await openReceiptChat((id) => receiptReply(id, proposal(id)));
  await status('Kiểm tra các dòng chưa khớp rồi bấm Xác nhận');
  await fireEvent.press(screen.getByTestId('assistant-new-chat'));
  await screen.findByTestId('assistant-empty');
  expect(screen.queryByTestId('receipt-status')).toBeNull();
});

test('a plain chat has no receipt status row', async () => {
  await renderWithProviders(<AssistantScreen />);
  await screen.findByTestId('assistant-empty');
  expect(screen.queryByTestId('receipt-status')).toBeNull();
});

test('a failed stream shows the error and Retry reads the receipt again', async () => {
  const { receipt } = await openReceiptChat([
    {
      event: 'message.created',
      data: { message_id: newUuid(), thread_id: newUuid() },
    },
    { event: 'error', data: { code: 'internal', message_vi: 'Lỗi' } },
  ]);
  await status('Không đọc được hóa đơn. Hãy thử lại.');
  setNextAssistantReply(receiptReply(receipt.id));
  await fireEvent.press(screen.getByTestId('receipt-status-retry'));
  await status('Đã đọc xong, xem các dòng bên dưới');
});

test('a failed thread creation shows the error and Retry creates it again', async () => {
  const receipt = draft();
  params({ entry: 'receipt', receiptId: receipt.id });
  setNextAssistantReply(receiptReply(receipt.id));
  jest
    .spyOn(getApiClient().raw, 'POST')
    .mockRejectedValueOnce(new Error('offline'));
  await renderWithProviders(<AssistantScreen />);
  await status('Không đọc được hóa đơn. Hãy thử lại.');
  await fireEvent.press(screen.getByTestId('receipt-status-retry'));
  await status('Đã đọc xong, xem các dòng bên dưới');
});

test('a proposal that failed on the server shows the action error and Retry asks again', async () => {
  const { receipt } = await openReceiptChat((id) =>
    receiptReply(id, proposal(id, { status: 'failed' })),
  );
  await status('Không nhập hàng được. Hãy thử lại.');
  setNextAssistantReply(receiptReply(receipt.id, proposal(receipt.id)));
  await fireEvent.press(screen.getByTestId('receipt-status-retry'));
  await status('Kiểm tra các dòng chưa khớp rồi bấm Xác nhận');
});

test('Retry after a failed proposal ends in reviewing when the new reply has only lines', async () => {
  const { receipt } = await openReceiptChat((id) =>
    receiptReply(id, proposal(id, { status: 'failed' })),
  );
  await status('Không nhập hàng được. Hãy thử lại.');
  setNextAssistantReply(receiptReply(receipt.id));
  await fireEvent.press(screen.getByTestId('receipt-status-retry'));
  await status('Đã đọc xong, xem các dòng bên dưới');
});

test('the status row speaks English when the app does', async () => {
  useSettingsStore.setState({ language: 'en' });
  const release = holdNextReply();
  await openReceiptChat((id) => receiptReply(id, proposal(id)));
  await status('Reading the receipt…');
  release();
  await status('Check the unmatched lines, then tap Confirm');
  expect(statusText().getByText('View as table')).toBeTruthy();
});

test('the status controls are labelled 48 dp targets', async () => {
  await openReceiptChat((id) => receiptReply(id));
  const link = screen.getByTestId('receipt-status-table');
  expect(link.props.accessibilityRole).toBe('button');
  expect(link.props.accessibilityLabel).toBe('Xem dạng bảng');
  const style = Object.assign(
    {},
    ...[link.props.style].flat(5).filter(Boolean),
  );
  expect(style.minHeight).toBeGreaterThanOrEqual(48);
});
