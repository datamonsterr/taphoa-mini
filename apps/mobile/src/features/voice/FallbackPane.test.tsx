import { act, fireEvent, screen } from '@testing-library/react-native';

import { useSettingsStore } from '@/stores/settings';
import { renderWithProviders } from '@/test/render';
import { speechMock } from '@/test/speech';

import { FallbackPane } from './FallbackPane';

beforeEach(() => speechMock.reset());

async function pane(reason: 'server' | 'device' = 'server') {
  const onAddToCart = jest.fn();
  const onOpenCart = jest.fn();
  const onClose = jest.fn();
  await renderWithProviders(
    <FallbackPane
      reason={reason}
      onAddToCart={onAddToCart}
      onOpenCart={onOpenCart}
      onClose={onClose}
    />,
  );
  return { onAddToCart, onOpenCart, onClose };
}

const speak = async (text: string) => {
  await fireEvent(screen.getByTestId('voice-device-mic'), 'pressIn');
  await act(async () => speechMock.emitStart());
  expect(screen.getByText('Đang nghe trên máy…')).toBeOnTheScreen();
  await act(async () => speechMock.emitResult(text, true));
  await fireEvent(screen.getByTestId('voice-device-mic'), 'pressOut');
  await act(async () => speechMock.emitEnd());
};

test('after a server failure it explains and offers the cart', async () => {
  const { onOpenCart } = await pane('server');
  expect(screen.getByText('Chưa gửi được lên máy chủ')).toBeOnTheScreen();
  expect(screen.getByText(/điện thoại sẽ tự chuyển/)).toBeOnTheScreen();
  expect(screen.queryByTestId('voice-add-to-cart')).toBeNull();
  await fireEvent.press(screen.getByTestId('voice-open-cart'));
  expect(onOpenCart).toHaveBeenCalled();
});

test('on a device that cannot record m4a it just asks for the items', async () => {
  await pane('device');
  expect(screen.getByText('Nói tên hàng và giá')).toBeOnTheScreen();
  expect(screen.queryByText('Chưa gửi được lên máy chủ')).toBeNull();
});

test('the transcript appears and Thêm vào giỏ passes it on', async () => {
  const { onAddToCart } = await pane();
  await speak('hai lon coca');
  expect(screen.getByTestId('voice-device-transcript')).toHaveTextContent(
    '“hai lon coca”',
  );
  await fireEvent.press(screen.getByTestId('voice-add-to-cart'));
  expect(onAddToCart).toHaveBeenCalledWith('hai lon coca');
});

test('without speech recognition it says so and hides the microphone', async () => {
  speechMock.setAvailable(false);
  await pane();
  expect(
    screen.getByText('Máy này chưa hỗ trợ nói thành chữ'),
  ).toBeOnTheScreen();
  expect(screen.queryByTestId('voice-device-mic')).toBeNull();
});

test('a refused speech permission asks for the microphone', async () => {
  speechMock.setPermission(false);
  await pane();
  await fireEvent(screen.getByTestId('voice-device-mic'), 'pressIn');
  await act(async () => {});
  expect(
    screen.getByText('Cho phép micro để ghi bán hàng bằng giọng nói.'),
  ).toBeOnTheScreen();
});

test('is in English when the language is English', async () => {
  useSettingsStore.setState({ language: 'en' });
  await pane();
  expect(screen.getByText("Couldn't reach the server")).toBeOnTheScreen();
});
