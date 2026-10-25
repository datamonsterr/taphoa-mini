import { fireEvent, screen } from '@testing-library/react-native';

import { useAssistantEnabled } from '@/features/assistant/flags';
import { useSettingsStore } from '@/stores/settings';
import { renderWithProviders } from '@/test/render';

import { ChatButton } from './ChatButton';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: (...args: unknown[]) => mockPush(...args) }),
}));
jest.mock('@/features/assistant/flags', () => ({
  useAssistantEnabled: jest.fn(() => true),
}));

const flat = (node: { props: { style?: unknown } }) =>
  Object.assign({}, ...[node.props.style].flat(5).filter(Boolean));

beforeEach(() => {
  mockPush.mockReset();
  jest.mocked(useAssistantEnabled).mockReturnValue(true);
});

test('is a 56 dp round accent button with a screen-reader label', async () => {
  await renderWithProviders(<ChatButton screen="inventory" />);
  const button = screen.getByTestId('chat-button');
  expect(button).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: 'Mở trợ lý' })).toBe(button);
  expect(flat(button)).toMatchObject({ width: 56, height: 56 });
});

test.each(['inventory', 'dashboard', 'account', 'camera'] as const)(
  'opens the assistant from %s',
  async (name) => {
    await renderWithProviders(<ChatButton screen={name} />);
    await fireEvent.press(screen.getByTestId('chat-button'));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/assistant',
      params: { entry: 'button', screen: name },
    });
  },
);

test('the label follows the language', async () => {
  useSettingsStore.setState({ language: 'en' });
  await renderWithProviders(<ChatButton screen="camera" />);
  expect(
    screen.getByRole('button', { name: 'Open assistant' }),
  ).toBeOnTheScreen();
});

test('renders nothing while the assistant is off', async () => {
  jest.mocked(useAssistantEnabled).mockReturnValue(false);
  await renderWithProviders(<ChatButton screen="camera" />);
  expect(screen.queryByTestId('chat-button')).toBeNull();
});
