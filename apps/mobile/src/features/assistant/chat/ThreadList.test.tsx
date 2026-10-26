import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { getApiClient } from '@/lib/api/client';
import { useSettingsStore } from '@/stores/settings';
import { renderWithProviders } from '@/test/render';

import { ThreadList } from './ThreadList';

const make = (title?: string) =>
  getApiClient().raw.POST('/v1/assistant/threads', {
    body: title ? { title } : {},
  });

const props = {
  activeId: undefined,
  onOpen: jest.fn(),
  onNew: jest.fn(),
  onDeleted: jest.fn(),
};
beforeEach(() => jest.clearAllMocks());

test('empty state and the new chat action', async () => {
  await renderWithProviders(<ThreadList {...props} />);
  await waitFor(() =>
    expect(screen.getByText('Chưa có cuộc trò chuyện nào.')).toBeTruthy(),
  );
  await fireEvent.press(screen.getByTestId('thread-list-new'));
  expect(props.onNew).toHaveBeenCalled();
});

test('lists threads by title or the default name and opens one', async () => {
  const a = await make('Nhập hàng');
  await make();
  await renderWithProviders(<ThreadList {...props} activeId={a.data!.id} />);
  await waitFor(() => expect(screen.getByText('Nhập hàng')).toBeTruthy());
  expect(screen.getByText('Cuộc trò chuyện')).toBeTruthy();
  await fireEvent.press(screen.getByText('Nhập hàng'));
  expect(props.onOpen).toHaveBeenCalledWith(a.data!.id);
});

test('English default title', async () => {
  useSettingsStore.setState({ language: 'en' });
  await make();
  await renderWithProviders(<ThreadList {...props} />);
  await waitFor(() => expect(screen.getByText('Conversation')).toBeTruthy());
});

test('delete asks for confirmation, can be cancelled, then deletes', async () => {
  const a = await make('Nhập hàng');
  await renderWithProviders(<ThreadList {...props} />);
  await waitFor(() => expect(screen.getByText('Nhập hàng')).toBeTruthy());
  await fireEvent.press(screen.getByLabelText('Xóa cuộc trò chuyện'));
  expect(screen.getByText('Xóa cuộc trò chuyện này?')).toBeTruthy();
  await fireEvent.press(screen.getByText('Hủy'));
  expect(screen.queryByText('Xóa cuộc trò chuyện này?')).toBeNull();
  await fireEvent.press(screen.getByLabelText('Xóa cuộc trò chuyện'));
  await fireEvent.press(screen.getByTestId('thread-delete-confirm'));
  await waitFor(() => expect(props.onDeleted).toHaveBeenCalledWith(a.data!.id));
  await waitFor(() => expect(screen.queryByText('Nhập hàng')).toBeNull());
});
