import { fireEvent, screen } from '@testing-library/react-native';

import { renderWithProviders } from '@/test/render';

import type { AssistantChatMessage } from '../chatReducer';
import { AssistantMessageView } from './AssistantMessageView';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

const base: AssistantChatMessage = {
  kind: 'assistant',
  id: '11111111-1111-4111-8111-111111111111',
  text: '',
  tools: [],
  cards: [],
  actions: [],
  status: 'done',
  feedback: null,
  remote: true,
};

const props = {
  onRetry: jest.fn(),
  onLinePress: jest.fn(),
  onActionUpdate: jest.fn(),
  onFeedback: jest.fn(),
};

const view = (message: Partial<AssistantChatMessage>) =>
  renderWithProviders(
    <AssistantMessageView message={{ ...base, ...message }} {...props} />,
  );

test('streaming with no text shows the typing indicator and no feedback', async () => {
  await view({ status: 'streaming', remote: false });
  expect(screen.getByTestId('assistant-typing')).toBeTruthy();
  expect(screen.queryByTestId('feedback-up')).toBeNull();
});

test('streamed text hides the typing indicator once there is text', async () => {
  await view({ status: 'streaming', text: 'Xin chào' });
  expect(screen.getByText('Xin chào')).toBeTruthy();
  expect(screen.queryByTestId('assistant-typing')).toBeNull();
});

test('tool lines: running, ok with summary, failed with and without summary', async () => {
  await view({
    tools: [
      {
        call_id: 'a',
        tool: 't',
        label: 'Đang xem doanh thu…',
        status: 'running',
      },
      {
        call_id: 'b',
        tool: 't',
        label: 'x',
        status: 'ok',
        summary: 'Doanh thu: 1.000đ',
      },
      { call_id: 'c', tool: 't', label: 'y', status: 'ok' },
      {
        call_id: 'd',
        tool: 't',
        label: 'z',
        status: 'failed',
        summary: 'Hỏng',
      },
      { call_id: 'e', tool: 't', label: 'w', status: 'failed' },
    ],
  });
  expect(screen.getByText('Đang xem doanh thu…')).toBeTruthy();
  expect(screen.getByTestId('tool-line-a-running')).toBeTruthy();
  expect(screen.getByText('Doanh thu: 1.000đ')).toBeTruthy();
  expect(screen.getByTestId('tool-line-b-ok')).toBeTruthy();
  expect(screen.getByText('y')).toBeTruthy();
  expect(screen.getByText('Hỏng')).toBeTruthy();
  expect(screen.getByTestId('tool-line-d-failed')).toBeTruthy();
  expect(screen.getByText('Không lấy được dữ liệu')).toBeTruthy();
});

test('renders cards and forwards line presses', async () => {
  const line = {
    line_id: 'l1',
    name: 'Sting đỏ',
    quantity: 1,
    cost: 1000,
    product_id: null,
    product_name: null,
    confidence: null,
  };
  await view({
    text: 'Đây là hóa đơn',
    cards: [
      { type: 'receipt_lines', receipt_id: 'r1', lines: [line] },
      { type: 'debt_list', items: [] },
    ],
  });
  expect(screen.getByText('Khách còn nợ')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText(/Sting đỏ/));
  expect(props.onLinePress).toHaveBeenCalledWith(line);
});

test('done messages with a server id show feedback buttons', async () => {
  await view({ text: 'Xong' });
  await fireEvent.press(screen.getByTestId('feedback-up'));
  expect(props.onFeedback).toHaveBeenCalledWith(base.id, 'up');
});

test('messages not stored by the server have no feedback buttons', async () => {
  await view({ text: 'Xong', remote: false });
  expect(screen.queryByTestId('feedback-up')).toBeNull();
});

test('errors show the notice with Retry and no feedback', async () => {
  await view({ status: 'error', error: { code: 'network' } });
  await fireEvent.press(screen.getByTestId('assistant-retry'));
  expect(props.onRetry).toHaveBeenCalled();
  expect(screen.queryByTestId('feedback-up')).toBeNull();
});
