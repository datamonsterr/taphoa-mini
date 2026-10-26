import { fireEvent, screen } from '@testing-library/react-native';
import { useLocalSearchParams } from 'expo-router';

import { renderWithProviders } from '@/test/render';

import { AssistantScreen } from './AssistantScreen';

// Expo Go: the speech native module does not exist, so the wrapper finds nothing.
jest.mock('./voice/speechModule', () => ({ getSpeechModule: () => null }));
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn() },
  useLocalSearchParams: jest.fn(),
}));

test('the chat still renders and the mic shows unavailable when the speech module is missing', async () => {
  jest.mocked(useLocalSearchParams).mockReturnValue({} as never);
  await renderWithProviders(<AssistantScreen />);
  expect(await screen.findByTestId('assistant-empty')).toBeTruthy();

  const mic = screen.getByTestId('voice-button');
  expect(mic.props.accessibilityState).toMatchObject({ disabled: true });
  await fireEvent.press(mic);
  expect(screen.getByTestId('voice-unavailable')).toHaveTextContent(
    'Máy này chưa hỗ trợ nói thành chữ',
  );

  // Typing and sending are untouched.
  await fireEvent.changeText(screen.getByTestId('assistant-input'), 'Xin chào');
  await fireEvent.press(screen.getByTestId('assistant-send'));
  expect(await screen.findByText('Xin chào')).toBeTruthy();
});
