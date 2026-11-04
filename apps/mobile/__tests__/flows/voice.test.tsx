import { uploadClipsAsBlobs } from '@/features/voice/testing';
import { listSales } from '@/lib/api';
import { useCartStore } from '@/stores/cart';
import { audioMock } from '@/test/audio';
import { PRODUCT_IDS } from '@/test/mock';
import {
  fireEvent,
  renderApp,
  screen,
  testRouter,
  waitFor,
} from '@/test/router';

beforeEach(() => {
  audioMock.reset();
  uploadClipsAsBlobs();
});
afterEach(() => jest.restoreAllMocks());

it('long-pressing the chat button on the camera opens /voice and starts recording', async () => {
  await renderApp('/');
  await fireEvent(await screen.findByTestId('chat-button'), 'longPress');
  expect(screen).toHavePathname('/voice');
  expect(screen).toHaveSearchParams({ entry: 'longpress' });
  expect(await screen.findByTestId('voice-listening')).toBeOnTheScreen();
  await waitFor(() => expect(audioMock.recorder.record).toHaveBeenCalled());
});

it('voice -> draft -> cash records a voice sale and returns to the camera', async () => {
  await renderApp('/');
  await testRouter.push('/voice?entry=longpress&fixture=two-line-sale.m4a');
  await fireEvent.press(await screen.findByLabelText('Xong, hiểu lời vừa nói'));
  expect(await screen.findByText('Coca-Cola lon 330ml')).toBeOnTheScreen();
  expect(screen.getByTestId('voice-total')).toHaveTextContent('29.000đ');
  await fireEvent.press(screen.getByLabelText('Xác nhận bán'));
  expect(await screen.findByText('Đã bán 3 món · 29.000đ')).toBeOnTheScreen();
  await waitFor(() => expect(screen).toHavePathname('/'), { timeout: 4000 });

  const { items } = await listSales({ limit: 200 });
  const sale = items.find((s) => s.total === 29000);
  expect(sale).toMatchObject({ payment_method: 'cash', status: 'completed' });
  expect(sale!.lines.map((l) => l.source)).toEqual(['voice', 'voice']);
  expect(useCartStore.getState().lines).toEqual([]);
});

it('transfer hands the draft to the cart and lands on the pay screen with the QR', async () => {
  await renderApp('/');
  await testRouter.push('/voice?entry=chip&fixture=two-line-sale.m4a');
  await fireEvent.press(await screen.findByLabelText('Xong, hiểu lời vừa nói'));
  await screen.findByText('Coca-Cola lon 330ml');
  await fireEvent.press(screen.getByLabelText('Chuyển khoản'));
  await fireEvent.press(screen.getByLabelText('Xác nhận bán'));
  await waitFor(() => expect(screen).toHavePathname('/pay'));
  expect(await screen.findByLabelText('Mã VietQR 29.000đ')).toBeOnTheScreen();
  expect(useCartStore.getState().lines.map((l) => l.productId)).toEqual([
    PRODUCT_IDS.coca,
    PRODUCT_IDS.pepsi,
  ]);
});

it('a chat question opens the assistant with the transcript as the first message', async () => {
  await renderApp('/');
  await testRouter.push('/voice?entry=longpress&fixture=chat-intent.m4a');
  await fireEvent.press(await screen.findByLabelText('Xong, hiểu lời vừa nói'));
  await fireEvent.press(await screen.findByTestId('voice-ask-assistant'));
  await waitFor(() => expect(screen).toHavePathname('/assistant'));
  expect(screen).toHaveSearchParams({
    entry: 'button',
    prompt: 'hôm nay bán được bao nhiêu',
  });
});

it('no speech asks to say it again', async () => {
  await renderApp('/');
  await testRouter.push('/voice?entry=longpress&fixture=no-speech.m4a');
  await fireEvent.press(await screen.findByLabelText('Xong, hiểu lời vừa nói'));
  expect(
    await screen.findByText('Chưa nghe rõ, nói lại nhé'),
  ).toBeOnTheScreen();
});
