import { act, fireEvent, screen } from '@testing-library/react-native';
import * as Haptics from 'expo-haptics';

import { renderWithProviders } from '@/test/render';
import { speechMock } from '@/test/speech';
import { colors } from '@/theme';

import { VoiceButton } from './VoiceButton';

const flat = (node: { props: { style?: unknown } }) =>
  Object.assign({}, ...[node.props.style].flat(5).filter(Boolean));

beforeEach(() => {
  speechMock.reset();
  jest.mocked(Haptics.impactAsync).mockClear();
});

async function renderButton(
  props: Partial<React.ComponentProps<typeof VoiceButton>> = {},
) {
  const onPartial = jest.fn();
  const onFinal = jest.fn();
  await renderWithProviders(
    <VoiceButton
      language="vi"
      onPartial={onPartial}
      onFinal={onFinal}
      {...props}
    />,
  );
  return { onPartial, onFinal };
}

test('renders a 48dp+ labelled button with a mic icon', async () => {
  await renderButton();
  const button = screen.getByTestId('voice-button');
  expect(button.props.accessibilityRole).toBe('button');
  expect(button.props.accessibilityLabel).toBe('Giữ để nói');
  const style = flat(button);
  expect(style.width).toBeGreaterThanOrEqual(48);
  expect(style.height).toBeGreaterThanOrEqual(48);
  expect(screen.getByTestId('icon-Mic')).toBeTruthy();
});

test('labels in English when the language is en', async () => {
  await renderButton({ language: 'en' });
  expect(screen.getByLabelText('Hold to talk')).toBeTruthy();
});

test('renders nothing when recognition is unavailable', async () => {
  speechMock.setAvailable(false);
  await renderButton();
  expect(screen.queryByTestId('voice-button')).toBeNull();
});

test('press in starts with haptic and shows the listening state', async () => {
  await renderButton();
  const button = screen.getByTestId('voice-button');
  await fireEvent(button, 'pressIn');
  await act(async () => {});
  expect(speechMock.module.start).toHaveBeenCalledWith(
    expect.objectContaining({ lang: 'vi-VN' }),
  );
  expect(Haptics.impactAsync).toHaveBeenCalledTimes(1);
  await act(() => speechMock.emitStart());

  const listening = screen.getByTestId('voice-button');
  expect(listening.props.accessibilityLabel).toBe('Đang nghe, thả tay để dừng');
  expect(listening.props.accessibilityState).toMatchObject({ busy: true });
  expect(flat(listening).backgroundColor).toBe(colors.accent);
  expect(screen.getByTestId('icon-Mic')).toBeTruthy();
});

test('streams partials and fills onFinal on release', async () => {
  const { onPartial, onFinal } = await renderButton();
  const button = screen.getByTestId('voice-button');
  await fireEvent(button, 'pressIn');
  await act(async () => {});
  await act(() => speechMock.emitStart());
  await act(() => speechMock.emitResult('bán hai'));
  expect(onPartial).toHaveBeenLastCalledWith('bán hai');

  await fireEvent(button, 'pressOut');
  expect(speechMock.module.stop).toHaveBeenCalledTimes(1);
  await act(() => speechMock.emitResult('bán hai chai', true));
  await act(() => speechMock.emitEnd());

  expect(onFinal).toHaveBeenCalledWith('bán hai chai');
  expect(screen.getByTestId('voice-button').props.accessibilityLabel).toBe(
    'Giữ để nói',
  );
});

test('disabled never starts', async () => {
  await renderButton({ disabled: true });
  const button = screen.getByTestId('voice-button');
  expect(button.props.accessibilityState).toMatchObject({ disabled: true });
  await fireEvent(button, 'pressIn');
  await act(async () => {});
  expect(speechMock.module.start).not.toHaveBeenCalled();
});

test('disabling mid-hold cancels without onFinal', async () => {
  const onFinal = jest.fn();
  const view = await renderWithProviders(
    <VoiceButton language="vi" onPartial={jest.fn()} onFinal={onFinal} />,
  );
  await fireEvent(screen.getByTestId('voice-button'), 'pressIn');
  await act(async () => {});
  await act(() => speechMock.emitStart());
  await view.rerender(
    <VoiceButton
      language="vi"
      onPartial={jest.fn()}
      onFinal={onFinal}
      disabled
    />,
  );
  expect(speechMock.module.abort).toHaveBeenCalled();
  await act(() => speechMock.emitEnd());
  expect(onFinal).not.toHaveBeenCalled();
});
