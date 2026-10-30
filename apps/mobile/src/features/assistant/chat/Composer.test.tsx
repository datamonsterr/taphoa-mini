import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { useSettingsStore } from '@/stores/settings';
import { speechMock } from '@/test/speech';

import { Composer } from './Composer';

beforeEach(() => speechMock.reset());

const input = () => screen.getByTestId('assistant-input');
const send = () => screen.getByTestId('assistant-send');
const disabled = (node: {
  props: { accessibilityState?: { disabled?: boolean } };
}) => node.props.accessibilityState?.disabled === true;

test('send is disabled when empty and sends typed text as text', async () => {
  const onSend = jest.fn();
  await render(<Composer streaming={false} onSend={onSend} />);
  expect(input().props.placeholder).toBe('Hỏi trợ lý về cửa hàng…');
  expect(disabled(send())).toBe(true);
  await fireEvent.changeText(input(), '  Doanh thu?  ');
  expect(disabled(send())).toBe(false);
  await fireEvent.press(send());
  expect(onSend).toHaveBeenCalledWith('Doanh thu?', 'text');
  expect(input().props.value).toBe('');
});

test('the text stays when the send was refused and clears when it was accepted', async () => {
  const onSend = jest.fn(() => false);
  await render(<Composer streaming={false} onSend={onSend} />);
  await fireEvent.changeText(input(), 'Doanh thu?');
  await fireEvent.press(send());
  expect(onSend).toHaveBeenCalledTimes(1);
  expect(input().props.value).toBe('Doanh thu?');
  onSend.mockReturnValue(true);
  await fireEvent.press(send());
  expect(input().props.value).toBe('');
});

test('whitespace only cannot be sent', async () => {
  const onSend = jest.fn();
  await render(<Composer streaming={false} onSend={onSend} />);
  await fireEvent.changeText(input(), '   ');
  expect(disabled(send())).toBe(true);
  await fireEvent.press(send());
  expect(onSend).not.toHaveBeenCalled();
});

test('send is disabled while streaming', async () => {
  const onSend = jest.fn();
  await render(<Composer streaming onSend={onSend} />);
  await fireEvent.changeText(input(), 'abc');
  expect(disabled(send())).toBe(true);
  await fireEvent.press(send());
  expect(onSend).not.toHaveBeenCalled();
});

test('voice shows the live transcript after typed text and fills the input, sending nothing', async () => {
  const onSend = jest.fn();
  await render(<Composer streaming={false} onSend={onSend} />);
  await fireEvent.changeText(input(), 'Cho tôi biết');
  await fireEvent(screen.getByTestId('voice-button'), 'pressIn');
  await act(async () => speechMock.emitStart());
  await act(async () => speechMock.emitResult('doanh thu', false));
  expect(input().props.value).toBe('Cho tôi biết doanh thu');
  await act(async () => speechMock.emitResult('doanh thu hôm nay', true));
  await act(async () => speechMock.emitEnd());
  expect(input().props.value).toBe('Cho tôi biết doanh thu hôm nay');
  expect(onSend).not.toHaveBeenCalled();
  await fireEvent.press(send());
  expect(onSend).toHaveBeenCalledWith(
    'Cho tôi biết doanh thu hôm nay',
    'voice',
  );
});

test('editing a voice transcript sends it as text', async () => {
  const onSend = jest.fn();
  await render(<Composer streaming={false} onSend={onSend} />);
  await fireEvent(screen.getByTestId('voice-button'), 'pressIn');
  await act(async () => speechMock.emitStart());
  await act(async () => speechMock.emitResult('doanh thu', true));
  await act(async () => speechMock.emitEnd());
  await fireEvent.changeText(input(), 'doanh thu hôm qua');
  await fireEvent.press(send());
  expect(onSend).toHaveBeenCalledWith('doanh thu hôm qua', 'text');
});

test('a prefill replaces the text and can repeat', async () => {
  const { rerender } = await render(
    <Composer streaming={false} onSend={jest.fn()} />,
  );
  await rerender(
    <Composer
      streaming={false}
      onSend={jest.fn()}
      prefill={{ id: 1, text: "Dòng 'Sting đỏ': " }}
    />,
  );
  expect(input().props.value).toBe("Dòng 'Sting đỏ': ");
  await fireEvent.changeText(input(), 'x');
  await rerender(
    <Composer
      streaming={false}
      onSend={jest.fn()}
      prefill={{ id: 2, text: "Dòng 'Sting đỏ': " }}
    />,
  );
  expect(input().props.value).toBe("Dòng 'Sting đỏ': ");
});

test('English placeholder and send label', async () => {
  useSettingsStore.setState({ language: 'en' });
  await render(<Composer streaming={false} onSend={jest.fn()} />);
  expect(input().props.placeholder).toBe('Ask the assistant about your shop…');
  expect(send().props.accessibilityLabel).toBe('Send');
});

describe('board 17b: the microphone held', () => {
  test('idle: no hint, no meter, no halo', async () => {
    await render(<Composer streaming={false} onSend={jest.fn()} />);
    expect(screen.queryByTestId('assistant-listening')).toBeNull();
    expect(screen.queryByTestId('assistant-listening-hint')).toBeNull();
    expect(screen.queryByTestId('voice-halo')).toBeNull();
  });

  test('held: hint above the composer, level bars with a timer, halo on the mic', async () => {
    jest.useFakeTimers();
    try {
      await render(<Composer streaming={false} onSend={jest.fn()} />);
      await fireEvent(screen.getByTestId('voice-button'), 'pressIn');
      await act(async () => speechMock.emitStart());
      expect(screen.getByTestId('assistant-listening-hint')).toHaveTextContent(
        'Đang nghe, thả tay để dừng',
      );
      expect(screen.getByLabelText('Ô nhập, đang nghe')).toBeTruthy();
      expect(screen.getByTestId('assistant-listening-time')).toHaveTextContent(
        '0:00',
      );
      expect(screen.getByTestId('voice-halo')).toBeTruthy();
      await act(async () => {
        jest.advanceTimersByTime(4000);
      });
      expect(screen.getByTestId('assistant-listening-time')).toHaveTextContent(
        '0:04',
      );
      await fireEvent(screen.getByTestId('voice-button'), 'pressOut');
      await act(async () => speechMock.emitEnd());
      expect(screen.queryByTestId('assistant-listening')).toBeNull();
      expect(screen.queryByTestId('assistant-listening-hint')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});
