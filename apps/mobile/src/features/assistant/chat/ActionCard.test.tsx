import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import * as Haptics from 'expo-haptics';
import type { AssistantAction } from '@taphoa/api-client';

import { getApiClient } from '@/lib/api/client';
import { newUuid } from '@/lib/uuid';
import { useSettingsStore } from '@/stores/settings';
import { proposalReply, setNextAssistantReply } from '@/test/mock';
import { renderWithProviders } from '@/test/render';

import { ActionCard } from './ActionCard';

afterEach(() => jest.restoreAllMocks());

/** A real stored proposal: a thread, a scripted reply, then the action read back. */
async function proposed(): Promise<AssistantAction> {
  const client = getApiClient();
  const thread = await client.raw.POST('/v1/assistant/threads', { body: {} });
  setNextAssistantReply(proposalReply());
  const sent = await client.sendAssistantMessage(thread.data!.id, {
    content: 'nhập mì',
    language: 'vi',
  });
  for await (const event of sent.events!) void event;
  const detail = await client.raw.GET('/v1/assistant/threads/{threadId}', {
    params: { path: { threadId: thread.data!.id } },
  });
  return detail.data!.actions[0];
}

test('shows the summary and status, and Confirm completes the action', async () => {
  const action = await proposed();
  const onUpdate = jest.fn();
  await renderWithProviders(<ActionCard action={action} onUpdate={onUpdate} />);
  expect(screen.getByText('Thêm 12 gói mì vào kho')).toBeTruthy();
  expect(screen.getByText('Chờ xác nhận')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('action-confirm'));
  await waitFor(() =>
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: action.id, status: 'done' }),
    ),
  );
  expect(Haptics.notificationAsync).toHaveBeenCalledWith('success');
});

test('Reject marks the action rejected', async () => {
  const action = await proposed();
  const onUpdate = jest.fn();
  await renderWithProviders(<ActionCard action={action} onUpdate={onUpdate} />);
  await fireEvent.press(screen.getByTestId('action-reject'));
  await waitFor(() =>
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'rejected' }),
    ),
  );
});

test.each([
  ['done', 'Đã thực hiện'],
  ['rejected', 'Đã từ chối'],
  ['expired', 'Đã hết hạn'],
  ['failed', 'Không thực hiện được'],
  ['executing', 'Đang thực hiện…'],
] as const)('%s shows its badge and no buttons', async (status, label) => {
  const action = { ...(await proposed()), status };
  await renderWithProviders(
    <ActionCard action={action} onUpdate={jest.fn()} />,
  );
  expect(screen.getByText(label)).toBeTruthy();
  expect(screen.queryByTestId('action-confirm')).toBeNull();
  expect(screen.queryByTestId('action-reject')).toBeNull();
});

test('badge in English', async () => {
  useSettingsStore.setState({ language: 'en' });
  const action = { ...(await proposed()), status: 'done' as const };
  await renderWithProviders(
    <ActionCard action={action} onUpdate={jest.fn()} />,
  );
  expect(screen.getByText('Done')).toBeTruthy();
});

test('a stale action (409 action_stale) shows as expired', async () => {
  const action = await proposed();
  jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 86400000);
  const onUpdate = jest.fn();
  await renderWithProviders(<ActionCard action={action} onUpdate={onUpdate} />);
  await fireEvent.press(screen.getByTestId('action-confirm'));
  await waitFor(() => expect(screen.getByText('Đã hết hạn')).toBeTruthy());
  expect(screen.queryByTestId('action-confirm')).toBeNull();
  expect(onUpdate).not.toHaveBeenCalled();
});

test('other errors show an inline message and keep the buttons', async () => {
  const action = { ...(await proposed()), id: newUuid() };
  await renderWithProviders(
    <ActionCard action={action} onUpdate={jest.fn()} />,
  );
  await fireEvent.press(screen.getByTestId('action-confirm'));
  await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  expect(screen.getByText('Không thực hiện được. Thử lại sau.')).toBeTruthy();
  expect(screen.getByTestId('action-confirm')).toBeTruthy();
});

test('buttons are disabled while a decision is pending', async () => {
  const action = await proposed();
  jest
    .spyOn(getApiClient().raw, 'POST')
    .mockImplementationOnce(() => new Promise(() => {}));
  await renderWithProviders(
    <ActionCard action={action} onUpdate={jest.fn()} />,
  );
  await fireEvent.press(screen.getByTestId('action-confirm'));
  await waitFor(() =>
    expect(
      screen.getByTestId('action-confirm').props.accessibilityState,
    ).toMatchObject({ disabled: true }),
  );
  expect(
    screen.getByTestId('action-reject').props.accessibilityState,
  ).toMatchObject({ disabled: true });
});

const rejectOnServer = (action: AssistantAction) =>
  getApiClient().raw.POST('/v1/assistant/actions/{actionId}/reject', {
    params: { path: { actionId: action.id } },
  });

test('a decision made elsewhere (409 already_decided) shows the stored state', async () => {
  const action = await proposed();
  await rejectOnServer(action);
  const onUpdate = jest.fn();
  await renderWithProviders(<ActionCard action={action} onUpdate={onUpdate} />);
  await fireEvent.press(screen.getByTestId('action-confirm'));
  await waitFor(() =>
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: action.id, status: 'rejected' }),
    ),
  );
});

test('already_decided with an unreadable thread shows the inline error', async () => {
  const action = await proposed();
  await rejectOnServer(action);
  const gone = { ...action, thread_id: newUuid() };
  await renderWithProviders(<ActionCard action={gone} onUpdate={jest.fn()} />);
  await fireEvent.press(screen.getByTestId('action-confirm'));
  await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
});
