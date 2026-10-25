import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react-native';
import { router, useLocalSearchParams } from 'expo-router';

import { setAnalyticsSink } from '@/lib/analytics';
import { getApiClient } from '@/lib/api/client';
import { listStockMovements } from '@/lib/api/stock';
import { newUuid } from '@/lib/uuid';
import { useSettingsStore } from '@/stores/settings';
import {
  PRODUCT_IDS,
  proposalReply,
  quotaReply,
  setNextAssistantReply,
} from '@/test/mock';
import { createTestQueryClient, renderWithProviders } from '@/test/render';

import { AssistantScreen } from './AssistantScreen';
import type { AssistantRouteParams } from './route';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn() },
  useLocalSearchParams: jest.fn(),
}));

const sink = { capture: jest.fn() };
const params = (value: Partial<AssistantRouteParams> = {}) =>
  jest.mocked(useLocalSearchParams).mockReturnValue(value as never);

beforeEach(() => {
  jest.clearAllMocks();
  sink.capture.mockClear();
  setAnalyticsSink(sink);
  params();
});
afterEach(() => setAnalyticsSink(null));

const client = () => getApiClient();
const input = () => screen.getByTestId('assistant-input');

async function seedThread(title: string, content: string) {
  const thread = await client().raw.POST('/v1/assistant/threads', {
    body: { title },
  });
  const sent = await client().sendAssistantMessage(thread.data!.id, {
    content,
    language: 'vi',
  });
  for await (const event of sent.events!) void event;
  return thread.data!.id;
}

async function threads() {
  const page = await client().raw.GET('/v1/assistant/threads', {
    params: { query: {} },
  });
  return page.data!.items;
}

async function detail(id: string) {
  const res = await client().raw.GET('/v1/assistant/threads/{threadId}', {
    params: { path: { threadId: id } },
  });
  return res.data!;
}

async function typeAndSend(text: string) {
  await fireEvent.changeText(input(), text);
  await fireEvent.press(screen.getByTestId('assistant-send'));
}

test('opens an empty new chat, captures the open event and closes', async () => {
  await renderWithProviders(<AssistantScreen />);
  expect(screen.getByTestId('assistant-screen')).toBeTruthy();
  expect(screen.getByRole('header', { name: 'Trợ lý' })).toBeTruthy();
  await waitFor(() =>
    expect(screen.getByTestId('assistant-empty')).toBeTruthy(),
  );
  expect(sink.capture).toHaveBeenCalledWith('assistant_opened', {
    entry: 'button',
  });
  expect(
    sink.capture.mock.calls.filter(([name]) => name === 'assistant_opened'),
  ).toHaveLength(1);
  await fireEvent.press(screen.getByTestId('assistant-close'));
  expect(router.back).toHaveBeenCalled();
  expect(await threads()).toHaveLength(0);
});

test('the first send creates a thread, then streams the text and the tool line', async () => {
  await renderWithProviders(<AssistantScreen />);
  await waitFor(() =>
    expect(screen.getByTestId('assistant-empty')).toBeTruthy(),
  );
  await typeAndSend('Doanh thu hôm nay?');
  expect(await screen.findByText('Doanh thu hôm nay?')).toBeTruthy();
  expect(
    await screen.findByText('Hôm nay cửa hàng có doanh thu 1.234.000 ₫.'),
  ).toBeTruthy();
  expect(screen.getByText('Doanh thu hôm nay: 1.234.000 ₫')).toBeTruthy();
  const [thread] = await threads();
  expect(thread.context).toEqual({ screen: 'chat' });
  expect(sink.capture).toHaveBeenCalledWith('assistant_message_sent', {
    input: 'text',
    thread_turn: 1,
  });
  await waitFor(() => expect(screen.getByTestId('feedback-up')).toBeTruthy());
});

test('passes the screen and next step of the entry into the new thread context', async () => {
  params({ entry: 'chip', screen: 'camera', nextStepId: 'restock' });
  await renderWithProviders(<AssistantScreen />);
  await waitFor(() =>
    expect(screen.getByTestId('assistant-empty')).toBeTruthy(),
  );
  await typeAndSend('Cần nhập gì?');
  await screen.findByText(/Hôm nay cửa hàng/);
  const [thread] = await threads();
  expect(thread.context).toEqual({ screen: 'camera', next_step_id: 'restock' });
});

test('a proposed action is confirmed: stock moves and the card shows done', async () => {
  await renderWithProviders(<AssistantScreen />);
  await waitFor(() =>
    expect(screen.getByTestId('assistant-empty')).toBeTruthy(),
  );
  setNextAssistantReply(proposalReply());
  await typeAndSend('nhập thêm mì');
  expect(await screen.findByText('Thêm 12 gói mì vào kho')).toBeTruthy();
  expect(screen.getByText('Mì Hảo Hảo')).toBeTruthy();
  const before = (await listStockMovements(PRODUCT_IDS.haohao)).items.length;
  await fireEvent.press(await screen.findByTestId('action-confirm'));
  await waitFor(() => expect(screen.getByText('Đã thực hiện')).toBeTruthy());
  expect(screen.queryByTestId('action-confirm')).toBeNull();
  expect((await listStockMovements(PRODUCT_IDS.haohao)).items).toHaveLength(
    before + 1,
  );
});

test('rejecting a proposal shows it as rejected', async () => {
  await renderWithProviders(<AssistantScreen />);
  await waitFor(() =>
    expect(screen.getByTestId('assistant-empty')).toBeTruthy(),
  );
  setNextAssistantReply(proposalReply());
  await typeAndSend('nhập thêm mì');
  await fireEvent.press(await screen.findByTestId('action-reject'));
  await waitFor(() => expect(screen.getByText('Đã từ chối')).toBeTruthy());
});

test('a quota error shows the server message and no Retry', async () => {
  await renderWithProviders(<AssistantScreen />);
  await waitFor(() =>
    expect(screen.getByTestId('assistant-empty')).toBeTruthy(),
  );
  setNextAssistantReply(quotaReply());
  await typeAndSend('Xin chào');
  expect(
    await screen.findByText('Bạn đã hết lượt trợ lý hôm nay.'),
  ).toBeTruthy();
  expect(screen.queryByTestId('assistant-retry')).toBeNull();
});

test('Retry after an interrupted stream sends the message again', async () => {
  await renderWithProviders(<AssistantScreen />);
  await waitFor(() =>
    expect(screen.getByTestId('assistant-empty')).toBeTruthy(),
  );
  setNextAssistantReply([
    { event: 'message.delta', data: { text: 'Hôm nay' } },
  ]);
  await typeAndSend('Doanh thu?');
  const retry = await screen.findByTestId('assistant-retry');
  await fireEvent.press(retry);
  expect(
    await screen.findByText('Hôm nay cửa hàng có doanh thu 1.234.000 ₫.'),
  ).toBeTruthy();
  expect(screen.queryByTestId('assistant-retry')).toBeNull();
  // The list shows what the server stores (it keeps the user message of the cut turn too),
  // never more than that.
  const [thread] = await threads();
  const stored = (await detail(thread.id)).messages.filter(
    (m) => m.role === 'user',
  );
  expect(screen.getAllByText('Doanh thu?')).toHaveLength(stored.length);
});

test('opens the newest thread when there is no thread id', async () => {
  await seedThread('Cũ', 'câu hỏi cũ');
  await seedThread('Mới', 'câu hỏi mới');
  await renderWithProviders(<AssistantScreen />);
  expect(await screen.findByText('câu hỏi mới')).toBeTruthy();
  expect(screen.getByRole('header', { name: 'Mới' })).toBeTruthy();
  expect(screen.queryByText('câu hỏi cũ')).toBeNull();
});

test('opens the thread of the threadId param', async () => {
  const old = await seedThread('Cũ', 'câu hỏi cũ');
  await seedThread('Mới', 'câu hỏi mới');
  params({ entry: 'push', threadId: old });
  await renderWithProviders(<AssistantScreen />);
  expect(await screen.findByText('câu hỏi cũ')).toBeTruthy();
  expect(screen.queryByText('câu hỏi mới')).toBeNull();
  expect(sink.capture).toHaveBeenCalledWith('assistant_opened', {
    entry: 'push',
  });
});

test('switches threads from the list, starts a new chat and deletes a thread', async () => {
  const old = await seedThread('Cũ', 'câu hỏi cũ');
  await seedThread('Mới', 'câu hỏi mới');
  await renderWithProviders(<AssistantScreen />);
  await screen.findByText('câu hỏi mới');

  await fireEvent.press(screen.getByTestId('assistant-threads'));
  expect(screen.getByTestId('assistant-thread-list')).toBeTruthy();
  await fireEvent.press(await screen.findByLabelText('Cũ'));
  expect(await screen.findByText('câu hỏi cũ')).toBeTruthy();
  expect(screen.queryByTestId('assistant-thread-list')).toBeNull();
  expect(screen.queryByText('câu hỏi mới')).toBeNull();

  // Deleting the open thread leaves a fresh chat.
  await fireEvent.press(screen.getByTestId('assistant-threads'));
  await screen.findByLabelText('Mới');
  await fireEvent.press(screen.getAllByLabelText('Xóa cuộc trò chuyện')[1]);
  await fireEvent.press(screen.getByTestId('thread-delete-confirm'));
  await waitFor(async () => expect(await threads()).toHaveLength(1));
  expect((await threads())[0].id).not.toBe(old);

  await fireEvent.press(screen.getByTestId('assistant-new-chat'));
  expect(screen.getByTestId('assistant-empty')).toBeTruthy();
  expect(screen.queryByTestId('assistant-thread-list')).toBeNull();
});

test('a prompt from a next-step chip creates a thread and sends it once', async () => {
  params({
    entry: 'chip',
    prompt: 'Tôi nên nhập thêm hàng gì?',
    screen: 'camera',
    nextStepId: 'restock',
  });
  await renderWithProviders(<AssistantScreen />);
  expect(await screen.findByText('Tôi nên nhập thêm hàng gì?')).toBeTruthy();
  await screen.findByText(/Hôm nay cửa hàng/);
  const [thread] = await threads();
  expect(thread.context).toEqual({ screen: 'camera', next_step_id: 'restock' });
  const stored = await detail(thread.id);
  expect(stored.messages.filter((m) => m.role === 'user')).toHaveLength(1);
});

test('a receipt entry sends the fixed first message with the receipt attached, and a line press prefills the input', async () => {
  const receiptId = newUuid();
  params({ entry: 'receipt', receiptId, screen: 'camera' });
  setNextAssistantReply([
    {
      event: 'message.created',
      data: { message_id: newUuid(), thread_id: newUuid() },
    },
    { event: 'message.delta', data: { text: 'Đây là hóa đơn.' } },
    {
      event: 'card',
      data: {
        type: 'receipt_lines',
        receipt_id: receiptId,
        lines: [
          {
            line_id: newUuid(),
            name: 'Sting đỏ',
            quantity: 6,
            cost: 90000,
            product_id: null,
            product_name: null,
            confidence: null,
          },
        ],
      },
    },
    {
      event: 'message.completed',
      data: {
        message_id: newUuid(),
        model: 'mock/assistant',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
  ]);
  await renderWithProviders(<AssistantScreen />);
  expect(
    await screen.findByText('Kiểm tra hóa đơn này giúp tôi.'),
  ).toBeTruthy();
  const [thread] = await threads();
  expect(thread.context).toEqual({ screen: 'camera', receipt_id: receiptId });
  await screen.findByText('Đây là hóa đơn.');
  const stored = await detail(thread.id);
  expect(stored.messages[0].attachments).toEqual([{ receipt_id: receiptId }]);

  await fireEvent.press(screen.getByLabelText(/Sting đỏ/));
  expect(input().props.value).toBe("Dòng 'Sting đỏ': ");
  await fireEvent.press(
    within(screen.getByTestId('card-receipt-lines')).getByText('Xem dạng bảng'),
  );
  expect(router.push).toHaveBeenCalledWith(`/receipt/${receiptId}`);
});

test('the receipt first message is in English when the app is', async () => {
  useSettingsStore.setState({ language: 'en' });
  params({ entry: 'receipt', receiptId: newUuid() });
  await renderWithProviders(<AssistantScreen />);
  expect(await screen.findByText('Please check this receipt.')).toBeTruthy();
});

test('the list follows new content while streaming', async () => {
  await renderWithProviders(<AssistantScreen />);
  await waitFor(() =>
    expect(screen.getByTestId('assistant-empty')).toBeTruthy(),
  );
  await typeAndSend('Doanh thu?');
  await screen.findByText(/Hôm nay cửa hàng/);
  await fireEvent(
    screen.getByTestId('assistant-messages'),
    'contentSizeChange',
    0,
    900,
  );
});

test('a failed thread creation shows a Retry that sends again', async () => {
  await renderWithProviders(<AssistantScreen />);
  await waitFor(() =>
    expect(screen.getByTestId('assistant-empty')).toBeTruthy(),
  );
  jest
    .spyOn(getApiClient().raw, 'POST')
    .mockRejectedValueOnce(new Error('offline'));
  await typeAndSend('Doanh thu?');
  await fireEvent.press(await screen.findByTestId('assistant-retry'));
  expect(
    await screen.findByText('Hôm nay cửa hàng có doanh thu 1.234.000 ₫.'),
  ).toBeTruthy();
  jest.restoreAllMocks();
});

/** Holds the threads list request until `release` is called. */
function holdThreadsList() {
  const raw = client().raw;
  const real = raw.GET.bind(raw) as (...args: unknown[]) => Promise<unknown>;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  jest
    .spyOn(raw, 'GET')
    .mockImplementation(((path: string, ...rest: unknown[]) =>
      path === '/v1/assistant/threads'
        ? gate.then(() => real(path, ...rest))
        : real(path, ...rest)) as never);
  return release;
}

const sendDisabled = () =>
  screen.getByTestId('assistant-send').props.accessibilityState.disabled;

test('a failed threads query leaves the spinner for an empty new chat', async () => {
  const raw = client().raw;
  const real = raw.GET.bind(raw) as (...args: unknown[]) => Promise<unknown>;
  jest
    .spyOn(raw, 'GET')
    .mockImplementation(((path: string, ...rest: unknown[]) =>
      path === '/v1/assistant/threads'
        ? Promise.reject(new Error('offline'))
        : real(path, ...rest)) as never);
  await renderWithProviders(<AssistantScreen />);
  expect(await screen.findByTestId('assistant-empty')).toBeTruthy();
  await fireEvent.changeText(input(), 'Doanh thu?');
  expect(sendDisabled()).toBe(false);
  jest.restoreAllMocks();
});

test('the composer is off while the newest thread is being looked up, and a new chat is not overwritten when the list lands', async () => {
  await seedThread('Cũ', 'câu hỏi cũ');
  const release = holdThreadsList();
  await renderWithProviders(<AssistantScreen />);
  await fireEvent.changeText(input(), 'Doanh thu?');
  expect(sendDisabled()).toBe(true);
  await fireEvent.press(screen.getByTestId('assistant-new-chat'));
  expect(await screen.findByTestId('assistant-empty')).toBeTruthy();
  expect(sendDisabled()).toBe(false);
  release();
  await waitFor(() =>
    expect(screen.getByTestId('assistant-empty')).toBeTruthy(),
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(screen.queryByText('câu hỏi cũ')).toBeNull();
  expect(screen.getByTestId('assistant-empty')).toBeTruthy();
  jest.restoreAllMocks();
});

test('two rapid presses of Send create one thread and one turn', async () => {
  await renderWithProviders(<AssistantScreen />);
  await waitFor(() =>
    expect(screen.getByTestId('assistant-empty')).toBeTruthy(),
  );
  await fireEvent.changeText(input(), 'Doanh thu?');
  // Two taps in one frame: both run before React re-renders the Composer.
  const press = screen.getByTestId('assistant-send').props
    .onClick as () => void;
  await act(async () => {
    press();
    press();
  });
  expect(
    await screen.findByText('Hôm nay cửa hàng có doanh thu 1.234.000 ₫.'),
  ).toBeTruthy();
  const all = await threads();
  expect(all).toHaveLength(1);
  expect((await detail(all[0].id)).messages).toHaveLength(2);
  expect(screen.getAllByText('Doanh thu?')).toHaveLength(1);
});

test('reopening the sheet shows the turns of the thread created in the last visit', async () => {
  const queryClient = createTestQueryClient();
  const first = await renderWithProviders(<AssistantScreen />, queryClient);
  await waitFor(() =>
    expect(screen.getByTestId('assistant-empty')).toBeTruthy(),
  );
  await typeAndSend('Doanh thu?');
  await screen.findByText('Hôm nay cửa hàng có doanh thu 1.234.000 ₫.');
  await waitFor(() => expect(screen.getByTestId('feedback-up')).toBeTruthy());
  await first.unmount();
  await renderWithProviders(<AssistantScreen />, queryClient);
  expect(await screen.findByText('Doanh thu?')).toBeTruthy();
  expect(
    await screen.findByText('Hôm nay cửa hàng có doanh thu 1.234.000 ₫.'),
  ).toBeTruthy();
});

test('Retry after a failure mid-reply keeps the stored turn without a second Retry button', async () => {
  await renderWithProviders(<AssistantScreen />);
  await waitFor(() =>
    expect(screen.getByTestId('assistant-empty')).toBeTruthy(),
  );
  setNextAssistantReply([
    {
      event: 'message.created',
      data: { message_id: newUuid(), thread_id: 't' },
    },
    { event: 'message.delta', data: { text: 'Hôm nay' } },
    {
      event: 'error',
      data: { code: 'internal', message_vi: 'Lỗi giữa chừng' },
    },
  ]);
  await typeAndSend('Doanh thu?');
  await fireEvent.press(await screen.findByTestId('assistant-retry'));
  expect(
    await screen.findByText('Hôm nay cửa hàng có doanh thu 1.234.000 ₫.'),
  ).toBeTruthy();
  expect(screen.getAllByText('Doanh thu?')).toHaveLength(2);
  expect(screen.getByText('Lỗi giữa chừng')).toBeTruthy();
  expect(screen.queryByTestId('assistant-retry')).toBeNull();
});
