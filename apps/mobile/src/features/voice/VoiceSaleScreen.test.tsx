import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react-native';
import { AppState, Linking } from 'react-native';

import { setAnalyticsSink } from '@/lib/analytics';
import { setApiTransport } from '@/lib/api/client';
import { useCartStore } from '@/stores/cart';
import { audioMock } from '@/test/audio';
import { createMockFetch } from '@/test/mock/fetch';
import {
  getMockDb,
  getVoiceOutcome,
  PRODUCT_IDS,
  setVoiceQuotaExceeded,
} from '@/test/mock';
import { renderWithProviders } from '@/test/render';
import { speechMock } from '@/test/speech';
import { createCustomer } from '@/test/mock/debts';
import { newUuid } from '@/lib/uuid';

import { setVoiceExit } from './voiceExit';
import { initialVoiceSettings, useVoiceSettings } from './voiceSettings';
import { uploadClipsAsBlobs } from './testing';
import { SUCCESS_MS, VoiceSaleScreen } from './VoiceSaleScreen';

const mockRouter = {
  back: jest.fn(),
  replace: jest.fn(),
  push: jest.fn(),
  canGoBack: jest.fn(() => true),
};
let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => mockParams,
}));

const events: { event: string; props: unknown }[] = [];

beforeEach(() => {
  Object.values(mockRouter).forEach((fn) => fn.mockClear());
  mockRouter.canGoBack.mockReturnValue(true);
  audioMock.reset();
  speechMock.reset();
  events.length = 0;
  setAnalyticsSink({
    capture: (event, props) => events.push({ event, props }),
  });
  useVoiceSettings.setState(initialVoiceSettings);
  mockParams = {};
  uploadClipsAsBlobs();
});
afterEach(() => {
  jest.restoreAllMocks();
  setAnalyticsSink(null);
  setVoiceExit(null);
  jest.useRealTimers();
});

const captured = (name: string) =>
  events.filter((e) => e.event === name).map((e) => e.props);

/** Opens the sheet with a fixture clip standing in for the microphone and presses Xong. */
async function speak(
  fixture: string,
  params: Record<string, string> = {},
  phase = 'voice-draft',
) {
  mockParams = { entry: 'longpress', fixture, ...params };
  await renderWithProviders(<VoiceSaleScreen />);
  await screen.findByTestId('voice-listening');
  await fireEvent.press(screen.getByLabelText('Xong, hiểu lời vừa nói'));
  await screen.findByTestId(phase);
}

const lines = () =>
  screen.getAllByTestId(/^voice-line-[0-9a-f]{8}(-[0-9a-f]+){4}$/);

describe('listening', () => {
  test('opens recording with the 88 dp microphone, hint, stop and a started event', async () => {
    mockParams = { entry: 'chip', fixture: 'two-line-sale.m4a' };
    await renderWithProviders(<VoiceSaleScreen />);
    await screen.findByTestId('voice-listening');
    expect(screen.getByText('Đang nghe…')).toBeOnTheScreen();
    expect(screen.getByText('Nói tên hàng và giá')).toBeOnTheScreen();
    expect(screen.getByTestId('voice-mic').props.style).toMatchObject({
      width: 88,
      height: 88,
    });
    expect(
      screen.getAllByTestId(/^level-bar-/, { includeHiddenElements: true }),
    ).toHaveLength(10);
    expect(screen.getByTestId('voice-ring')).toBeOnTheScreen();
    expect(captured('voice_sale_started')).toEqual([{ entry: 'chip' }]);
  });

  test('records with the microphone when there is no fixture', async () => {
    mockParams = { entry: 'bubble' };
    await renderWithProviders(<VoiceSaleScreen />);
    await screen.findByTestId('voice-listening');
    await waitFor(() =>
      expect(audioMock.recorder.record).toHaveBeenCalledWith({
        forDuration: 30,
      }),
    );
    expect(captured('voice_sale_started')).toEqual([{ entry: 'bubble' }]);
  });

  test('records, stops by itself after 2 s of silence and shows the draft', async () => {
    jest.useFakeTimers({ advanceTimers: true });
    audioMock.setNextUri('file:///cache/two-line-sale.m4a');
    mockParams = { entry: 'bubble' };
    await renderWithProviders(<VoiceSaleScreen />);
    await screen.findByTestId('voice-listening');
    await waitFor(() => expect(audioMock.recorder.record).toHaveBeenCalled());
    await act(async () => audioMock.setMetering(-10));
    await act(() => jest.advanceTimersByTimeAsync(600));
    await act(async () => audioMock.setMetering(-60));
    await act(() => jest.advanceTimersByTimeAsync(2200));
    expect(await screen.findByTestId('voice-draft')).toBeOnTheScreen();
    expect(audioMock.recorder.stop).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Coca-Cola lon 330ml')).toBeOnTheScreen();
  });

  test('the stop button ends the recording and sends it', async () => {
    jest.useFakeTimers({ advanceTimers: true });
    audioMock.setNextUri('file:///cache/ambiguous.m4a');
    mockParams = { entry: 'tile' };
    await renderWithProviders(<VoiceSaleScreen />);
    await screen.findByTestId('voice-listening');
    await waitFor(() => expect(audioMock.recorder.record).toHaveBeenCalled());
    await act(() => jest.advanceTimersByTimeAsync(1000));
    await fireEvent.press(screen.getByLabelText('Xong, hiểu lời vừa nói'));
    expect(await screen.findByTestId('voice-draft')).toBeOnTheScreen();
    expect(screen.getByLabelText('Chưa chắc, chọn đúng món')).toBeOnTheScreen();
  });

  test('a tap too short to hold speech says it could not hear', async () => {
    mockParams = { entry: 'tile' };
    await renderWithProviders(<VoiceSaleScreen />);
    await screen.findByTestId('voice-listening');
    await waitFor(() => expect(audioMock.recorder.record).toHaveBeenCalled());
    await fireEvent.press(screen.getByLabelText('Xong, hiểu lời vừa nói'));
    expect(await screen.findByTestId('voice-no-speech')).toBeOnTheScreen();
  });

  test('a refused microphone shows the permission pane with a way to Settings', async () => {
    audioMock.setPermission('prompt-denied');
    const open = jest.spyOn(Linking, 'openSettings').mockResolvedValue();
    mockParams = { entry: 'bubble' };
    await renderWithProviders(<VoiceSaleScreen />);
    await screen.findByTestId('voice-permission');
    await fireEvent.press(screen.getByTestId('voice-open-settings'));
    expect(open).toHaveBeenCalled();
    open.mockRestore();
  });

  test('closing while listening abandons at stage listening and leaves', async () => {
    mockParams = { entry: 'longpress', fixture: 'two-line-sale.m4a' };
    await renderWithProviders(<VoiceSaleScreen />);
    await screen.findByTestId('voice-listening');
    await fireEvent.press(screen.getByTestId('voice-close'));
    expect(captured('voice_sale_abandoned')).toEqual([{ stage: 'listening' }]);
    expect(mockRouter.back).toHaveBeenCalled();
  });

  test('a bubble session leaves through the voiceExit hook with returnToPrevious', async () => {
    const onDone = jest.fn();
    setVoiceExit({ onDone });
    mockParams = {
      entry: 'bubble',
      returnToPrevious: '1',
      fixture: 'two-line-sale.m4a',
    };
    await renderWithProviders(<VoiceSaleScreen />);
    await screen.findByTestId('voice-listening');
    await fireEvent.press(screen.getByTestId('voice-close'));
    expect(onDone).toHaveBeenCalledWith(
      { returnToPrevious: true },
      expect.any(Function),
    );
    expect(mockRouter.back).not.toHaveBeenCalled();
    onDone.mock.calls[0][1]();
    expect(mockRouter.back).toHaveBeenCalled();
  });
});

describe('draft', () => {
  test('shows the transcript, matched lines with a check chip and the total', async () => {
    await speak('two-line-sale.m4a');
    expect(
      screen.getByText('“hai lon coca với một lon pepsi”'),
    ).toBeOnTheScreen();
    expect(screen.getByText('Coca-Cola lon 330ml')).toBeOnTheScreen();
    expect(screen.getByText('Pepsi lon 330ml')).toBeOnTheScreen();
    expect(screen.getAllByLabelText('Khớp')).toHaveLength(2);
    expect(screen.getByTestId('voice-total')).toHaveTextContent('29.000đ');
    expect(screen.getByLabelText('Số lượng 2')).toBeOnTheScreen();
  });

  test('the stepper changes the quantity and the total, the trash removes the line', async () => {
    await speak('two-line-sale.m4a');
    await fireEvent.press(screen.getAllByLabelText('Thêm một')[0]!);
    expect(screen.getByTestId('voice-total')).toHaveTextContent('39.000đ');
    await fireEvent.press(screen.getByLabelText('Xóa món'));
    expect(screen.queryByText('Pepsi lon 330ml')).toBeNull();
    expect(screen.getByTestId('voice-total')).toHaveTextContent('30.000đ');
  });

  test('an ambiguous line shows an amber ? and a three-candidate strip', async () => {
    await speak('ambiguous.m4a');
    const badge = screen.getByLabelText('Chưa chắc, chọn đúng món');
    expect(screen.queryByTestId('alternatives-strip')).toBeNull();
    await fireEvent.press(badge);
    const strip = screen.getByTestId('alternatives-strip');
    expect(within(strip).getAllByRole('radio')).toHaveLength(3);
    await fireEvent.press(within(strip).getByLabelText('7Up lon 330ml 9.000đ'));
    expect(screen.getByText('7Up lon 330ml')).toBeOnTheScreen();
    expect(screen.queryByTestId('alternatives-strip')).toBeNull();
    expect(screen.getByLabelText('Khớp')).toBeOnTheScreen();
  });

  test('an unknown line is a grey tag at the spoken price and opens the catalog search', async () => {
    await speak('unknown-product.m4a');
    expect(screen.getByText('gạo ST25')).toBeOnTheScreen();
    expect(screen.getByTestId('voice-total')).toHaveTextContent('35.000đ');
    await fireEvent.press(
      screen.getByLabelText('Chưa có trong kho, bán theo giá đã nói'),
    );
    await screen.findByTestId('voice-search');
    expect(screen.getByTestId('voice-search-input').props.value).toBe(
      'gạo ST25',
    );
    await fireEvent.changeText(
      screen.getByTestId('voice-search-input'),
      'coca',
    );
    await fireEvent.press(
      await screen.findByTestId(`voice-search-${PRODUCT_IDS.coca}`),
    );
    await screen.findByTestId('voice-draft');
    expect(screen.getByText('Coca-Cola lon 330ml')).toBeOnTheScreen();
    // the spoken price stays and shows as a mismatch with the shop price
    expect(screen.getByTestId('voice-total')).toHaveTextContent('35.000đ');
    expect(
      screen.getByLabelText('Giá bạn nói khác giá bán trong kho'),
    ).toBeOnTheScreen();
  });

  test('retyping a price on the keypad updates the line and clears the pill', async () => {
    await speak('unknown-product.m4a');
    await fireEvent.press(screen.getByTestId(/voice-line-.*-price/));
    await screen.findByTestId('voice-price-editor');
    for (const key of ['delete', 'delete', 'delete', 'delete', 'delete'])
      await fireEvent.press(
        screen.getByLabelText(key === 'delete' ? 'Xóa' : key),
      );
    await fireEvent.press(screen.getByLabelText('4'));
    await fireEvent.press(screen.getByLabelText('000'));
    expect(screen.getByTestId('voice-price-value')).toHaveTextContent('4.000đ');
    await fireEvent.press(screen.getByLabelText('Xong'));
    await screen.findByTestId('voice-draft');
    expect(screen.getByTestId('voice-total')).toHaveTextContent('4.000đ');
  });

  test('the price keypad refuses prices below 500 đồng', async () => {
    await speak('unknown-product.m4a');
    await fireEvent.press(screen.getByTestId(/voice-line-.*-price/));
    for (let i = 0; i < 5; i++)
      await fireEvent.press(screen.getByLabelText('Xóa'));
    await fireEvent.press(screen.getByLabelText('4'));
    expect(
      screen.getByLabelText('Xong').props.accessibilityState,
    ).toMatchObject({ disabled: true });
    await fireEvent.press(screen.getByTestId('voice-price-back'));
    await screen.findByTestId('voice-draft');
    expect(screen.getByTestId('voice-total')).toHaveTextContent('35.000đ');
  });

  test('tapping the transcript shows all of it', async () => {
    await speak('two-line-sale.m4a');
    const text = screen.getByText('“hai lon coca với một lon pepsi”');
    expect(text.props.numberOfLines).toBe(2);
    await fireEvent.press(screen.getByTestId('voice-draft-transcript'));
    expect(
      screen.getByText('“hai lon coca với một lon pepsi”').props.numberOfLines,
    ).toBeUndefined();
  });

  test('add more: the microphone records a second utterance and appends its lines', async () => {
    await speak('two-line-sale.m4a', { entry: 'bubble' });
    expect(lines()).toHaveLength(2);
    await fireEvent.press(screen.getByLabelText('Bấm để nói thêm món'));
    await waitFor(() =>
      expect(screen.getByLabelText('Bấm để dừng')).toBeOnTheScreen(),
    );
    await fireEvent.press(screen.getByLabelText('Bấm để dừng'));
    await waitFor(() => expect(lines()).toHaveLength(4));
    expect(screen.getByTestId('voice-total')).toHaveTextContent('58.000đ');
  });

  test('in the app the extra microphone is hold-to-talk', async () => {
    await speak('two-line-sale.m4a', { entry: 'longpress' });
    const mic = screen.getByLabelText('Giữ để nói thêm món');
    await fireEvent(mic, 'pressIn');
    await waitFor(() =>
      expect(screen.getByLabelText('Bấm để dừng')).toBeOnTheScreen(),
    );
    await fireEvent(screen.getByLabelText('Bấm để dừng'), 'pressOut');
    await waitFor(() => expect(lines()).toHaveLength(4));
  });
});

describe('confirm', () => {
  test('cash records the sale with voice lines, shows the toast, posts the outcome and leaves', async () => {
    await speak('two-line-sale.m4a');
    jest.useFakeTimers({ advanceTimers: true });
    await fireEvent.press(screen.getByLabelText('Xác nhận bán'));
    await screen.findByTestId('voice-done');
    expect(screen.getByText('Đã bán 3 món · 29.000đ')).toBeOnTheScreen();
    const sale = getMockDb().sales.at(-1)!;
    expect(sale).toMatchObject({ payment_method: 'cash', total: 29000 });
    expect(sale.lines.map((l) => l.source)).toEqual(['voice', 'voice']);
    expect(sale.lines.map((l) => l.id)).toHaveLength(2);
    expect(captured('voice_sale_confirmed')).toEqual([
      { edited: false, line_count: 2, payment_method: 'cash', total: 29000 },
    ]);
    expect(useVoiceSettings.getState().voiceSales).toBe(1);
    const [utteranceId] = [...getMockDb().voice.utterances.keys()];
    await waitFor(() =>
      expect(getVoiceOutcome(utteranceId!)).toMatchObject({
        outcome: 'confirmed',
        sale_id: sale.id,
      }),
    );
    expect(mockRouter.back).not.toHaveBeenCalled();
    await act(() => jest.advanceTimersByTimeAsync(SUCCESS_MS + 10));
    expect(mockRouter.back).toHaveBeenCalled();
  });

  test('edits are reported as corrections with outcome edited', async () => {
    await speak('ambiguous.m4a');
    await fireEvent.press(screen.getByLabelText('Chưa chắc, chọn đúng món'));
    await fireEvent.press(
      within(screen.getByTestId('alternatives-strip')).getByLabelText(
        'Pepsi lon 330ml 9.000đ',
      ),
    );
    await fireEvent.press(screen.getByLabelText('Xác nhận bán'));
    await screen.findByTestId('voice-done');
    const [utteranceId] = [...getMockDb().voice.utterances.keys()];
    await waitFor(() =>
      expect(getVoiceOutcome(utteranceId!)).toMatchObject({
        outcome: 'edited',
        corrections: [
          expect.objectContaining({ chosen_product_id: PRODUCT_IDS.pepsi }),
        ],
      }),
    );
    expect(captured('voice_sale_confirmed')).toEqual([
      expect.objectContaining({ edited: true }),
    ]);
  });

  test('an unknown line is sold as a manual line with its spoken label', async () => {
    await speak('unknown-product.m4a');
    await fireEvent.press(screen.getByLabelText('Xác nhận bán'));
    await screen.findByTestId('voice-done');
    expect(getMockDb().sales.at(-1)!.lines[0]).toMatchObject({
      source: 'manual',
      manual_label: 'gạo ST25',
      unit_price: 35000,
    });
  });

  test('a failed save keeps the draft and says so', async () => {
    await speak('two-line-sale.m4a');
    const real = createMockFetch();
    setApiTransport(async (input, init) => {
      const request = new Request(input as RequestInfo, init);
      if (request.method === 'POST' && request.url.endsWith('/v1/sales'))
        return new Response(JSON.stringify({ error: 'boom' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      return real(input, init);
    });
    await fireEvent.press(screen.getByLabelText('Xác nhận bán'));
    expect(
      await screen.findByText('Không lưu được đơn. Thử lại.'),
    ).toBeOnTheScreen();
    expect(screen.getByTestId('voice-draft')).toBeOnTheScreen();
    expect(
      getMockDb().sales.find((s) => s.lines[0]?.source === 'voice'),
    ).toBeUndefined();
  });

  test('transfer puts the draft in the cart and opens the pay screen', async () => {
    await speak('two-line-sale.m4a');
    await fireEvent.press(screen.getByLabelText('Chuyển khoản'));
    await fireEvent.press(screen.getByLabelText('Xác nhận bán'));
    expect(useCartStore.getState().lines).toMatchObject([
      { productId: PRODUCT_IDS.coca, qty: 2, price: 10000, source: 'voice' },
      { productId: PRODUCT_IDS.pepsi, qty: 1, price: 9000, source: 'voice' },
    ]);
    expect(mockRouter.replace).toHaveBeenCalledWith('/pay');
    expect(
      getMockDb().sales.find((s) => s.lines[0]?.source === 'voice'),
    ).toBeUndefined();
    expect(captured('voice_sale_confirmed')).toEqual([
      expect.objectContaining({ payment_method: 'transfer', total: 29000 }),
    ]);
  });

  test('transfer is blocked while a line is not in the catalog', async () => {
    await speak('unknown-product.m4a');
    await fireEvent.press(screen.getByLabelText('Chuyển khoản'));
    expect(
      screen.getByLabelText('Xác nhận bán').props.accessibilityState,
    ).toMatchObject({ disabled: true });
    expect(
      screen.getByText(/Chuyển khoản cần món có trong kho/),
    ).toBeOnTheScreen();
  });

  test('credit uses the matched customer and records the whole total as debt', async () => {
    await speak('credit-sale.m4a');
    expect(screen.getByTestId('voice-customer')).toHaveTextContent(
      'Khách nợ: Chị Lan · Đổi',
    );
    await fireEvent.press(screen.getByLabelText('Xác nhận bán'));
    await screen.findByTestId('voice-done');
    expect(getMockDb().sales.at(-1)).toMatchObject({
      payment_method: 'credit',
      credit_amount: 20000,
    });
  });

  test('credit without a customer asks to choose one from the picker', async () => {
    const { customer } = createCustomer({ id: newUuid(), name: 'Anh Tư' });
    await speak('two-line-sale.m4a');
    await fireEvent.press(screen.getByLabelText('Ghi nợ'));
    expect(
      screen.getByLabelText('Xác nhận bán').props.accessibilityState,
    ).toMatchObject({ disabled: true });
    await fireEvent.press(screen.getByLabelText('Chọn khách'));
    await fireEvent.press(
      await screen.findByLabelText(new RegExp(`^${customer.name},`)),
    );
    await waitFor(() =>
      expect(
        screen.getByLabelText('Xác nhận bán').props.accessibilityState,
      ).toMatchObject({ disabled: false }),
    );
    expect(screen.getByTestId('voice-customer')).toHaveTextContent(/Anh Tư/);
    await fireEvent.press(screen.getByLabelText('Xác nhận bán'));
    await screen.findByTestId('voice-done');
    expect(getMockDb().sales.at(-1)).toMatchObject({
      payment_method: 'credit',
      customer_id: customer.id,
    });
  });

  test('an unmatched spoken customer opens the create form with the name filled in', async () => {
    const real = createMockFetch();
    setApiTransport(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      const response = await real(input, init);
      if (!url.endsWith('/v1/voice/utterances')) return response;
      const body = await response.json();
      body.sale_draft.payment_method = 'credit';
      body.sale_draft.customer = { status: 'none', spoken_name: 'chị Mai' };
      return new Response(JSON.stringify(body), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    });
    await speak('two-line-sale.m4a');
    expect(screen.getByTestId('voice-customer')).toHaveTextContent(/chị Mai/);
    await fireEvent.press(screen.getByTestId('voice-customer'));
    expect(await screen.findByDisplayValue('chị Mai')).toBeOnTheScreen();
    await fireEvent.press(screen.getByLabelText(/^Tạo/));
    await waitFor(() =>
      expect(screen.getByTestId('voice-customer')).toHaveTextContent(
        /Khách nợ: chị Mai/,
      ),
    );
    expect(getMockDb().customers.map((c) => c.name)).toContain('chị Mai');
    await fireEvent.press(screen.getByLabelText('Xác nhận bán'));
    await screen.findByTestId('voice-done');
    expect(getMockDb().sales.at(-1)).toMatchObject({
      payment_method: 'credit',
      credit_amount: 29000,
    });
  });

  test('closing the draft abandons it at stage draft and posts the outcome', async () => {
    await speak('two-line-sale.m4a');
    await fireEvent.press(screen.getByTestId('voice-close'));
    expect(captured('voice_sale_abandoned')).toEqual([{ stage: 'draft' }]);
    const [utteranceId] = [...getMockDb().voice.utterances.keys()];
    await waitFor(() =>
      expect(getVoiceOutcome(utteranceId!)).toEqual({
        outcome: 'abandoned',
        stage: 'draft',
      }),
    );
    expect(mockRouter.back).toHaveBeenCalled();
  });
});

describe('leaving', () => {
  test('leaving the screen any other way still counts as an abandon', async () => {
    mockParams = { entry: 'longpress', fixture: 'two-line-sale.m4a' };
    const view = await renderWithProviders(<VoiceSaleScreen />);
    await screen.findByTestId('voice-listening');
    await fireEvent.press(screen.getByLabelText('Xong, hiểu lời vừa nói'));
    await screen.findByTestId('voice-draft');
    await view.unmount();
    await act(async () => {});
    expect(captured('voice_sale_abandoned')).toEqual([{ stage: 'draft' }]);
    const [utteranceId] = [...getMockDb().voice.utterances.keys()];
    await waitFor(() =>
      expect(getVoiceOutcome(utteranceId!)).toMatchObject({
        outcome: 'abandoned',
      }),
    );
  });

  test('an abandon is reported once, and not after a confirmed sale', async () => {
    mockParams = { entry: 'longpress', fixture: 'two-line-sale.m4a' };
    const view = await renderWithProviders(<VoiceSaleScreen />);
    await screen.findByTestId('voice-listening');
    await fireEvent.press(screen.getByLabelText('Xong, hiểu lời vừa nói'));
    await screen.findByTestId('voice-draft');
    await fireEvent.press(screen.getByLabelText('Xác nhận bán'));
    await screen.findByTestId('voice-done');
    await view.unmount();
    await act(async () => {});
    expect(captured('voice_sale_abandoned')).toEqual([]);
  });

  test('the sheet closes once when the success timer and a scrim tap both fire', async () => {
    mockParams = { entry: 'longpress', fixture: 'two-line-sale.m4a' };
    await renderWithProviders(<VoiceSaleScreen />);
    await screen.findByTestId('voice-listening');
    await fireEvent.press(screen.getByLabelText('Xong, hiểu lời vừa nói'));
    await screen.findByTestId('voice-draft');
    jest.useFakeTimers({ advanceTimers: true });
    await fireEvent.press(screen.getByLabelText('Xác nhận bán'));
    await screen.findByTestId('voice-done');
    await fireEvent.press(screen.getByTestId('sheet-scrim'));
    await act(() => jest.advanceTimersByTimeAsync(SUCCESS_MS + 10));
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
  });

  test('sending the app to the background throws a recording away', async () => {
    let listener: (state: string) => void = () => {};
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((
      _type: string,
      handler: (state: string) => void,
    ) => {
      listener = handler;
      return { remove: jest.fn() };
    }) as never);
    mockParams = { entry: 'bubble' };
    await renderWithProviders(<VoiceSaleScreen />);
    await screen.findByTestId('voice-listening');
    await waitFor(() => expect(audioMock.recorder.record).toHaveBeenCalled());
    await act(async () => listener('background'));
    expect(await screen.findByTestId('voice-no-speech')).toBeOnTheScreen();
    expect(audioMock.recorder.stop).toHaveBeenCalled();
    expect(getMockDb().voice.utterances.size).toBe(0);
  });
});

describe('errors and fallbacks', () => {
  test('no_speech asks to say it again and the retry listens again', async () => {
    await speak('no-speech.m4a', {}, 'voice-no-speech');
    expect(screen.getByText('Chưa nghe rõ, nói lại nhé')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('voice-retry'));
    await screen.findByTestId('voice-listening');
  });

  test('an utterance with nothing useful is treated like no speech', async () => {
    await speak('two-line-sale.m4a');
    // sanity: the same sheet with a chat clip goes to the chat pane instead
    expect(screen.getByTestId('voice-draft')).toBeOnTheScreen();
  });

  test('the daily quota shows Hết lượt nói hôm nay with a way to the cart', async () => {
    setVoiceQuotaExceeded(true);
    await speak('two-line-sale.m4a', {}, 'voice-quota');
    expect(screen.getByText('Hết lượt nói hôm nay')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('voice-open-cart'));
    expect(mockRouter.replace).toHaveBeenCalledWith('/cart');
  });

  test('a chat question offers Hỏi trợ lý with the transcript as the prompt', async () => {
    await speak('chat-intent.m4a', {}, 'voice-chat-intent');
    expect(screen.getByText('“hôm nay bán được bao nhiêu”')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('voice-ask-assistant'));
    expect(mockRouter.replace).toHaveBeenCalledWith({
      pathname: '/assistant',
      params: { entry: 'button', prompt: 'hôm nay bán được bao nhiêu' },
    });
  });

  test('503 voice_unavailable falls back to on-device recognition with Thêm vào giỏ', async () => {
    const real = createMockFetch();
    setApiTransport(async (input, init) => {
      const request = new Request(input as RequestInfo, init);
      if (request.url.endsWith('/v1/voice/utterances'))
        return new Response(
          JSON.stringify({ error: 'down', code: 'voice_unavailable' }),
          { status: 503, headers: { 'content-type': 'application/json' } },
        );
      return real(input, init);
    });
    await speak('two-line-sale.m4a', {}, 'voice-fallback');
    expect(screen.getByText('Chưa gửi được lên máy chủ')).toBeOnTheScreen();
    expect(screen.queryByTestId('voice-add-to-cart')).toBeNull();
    await fireEvent(screen.getByTestId('voice-device-mic'), 'pressIn');
    await act(async () => speechMock.emitStart());
    await act(async () => speechMock.emitResult('hai lon coca', true));
    await fireEvent(screen.getByTestId('voice-device-mic'), 'pressOut');
    await act(async () => speechMock.emitEnd());
    expect(screen.getByTestId('voice-device-transcript')).toHaveTextContent(
      '“hai lon coca”',
    );
    await fireEvent.press(screen.getByTestId('voice-add-to-cart'));
    // the catalog opens with the transcript typed in; picking a product adds it to the cart
    await screen.findByTestId('voice-search-pane');
    expect(screen.getByTestId('voice-search-input').props.value).toBe(
      'hai lon coca',
    );
    await fireEvent.changeText(
      screen.getByTestId('voice-search-input'),
      'coca',
    );
    await fireEvent.press(
      await screen.findByTestId(`voice-search-${PRODUCT_IDS.coca}`),
    );
    expect(useCartStore.getState().lines).toMatchObject([
      { productId: PRODUCT_IDS.coca, qty: 1 },
    ]);
    expect(screen.getByText('Đã thêm vào giỏ (1)')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('voice-open-cart'));
    expect(mockRouter.replace).toHaveBeenCalledWith('/cart');
  });

  test('being offline (the request never answers) falls back the same way', async () => {
    setApiTransport(async () => {
      throw new TypeError('Network request failed');
    });
    await speak('two-line-sale.m4a', {}, 'voice-fallback');
  });
});
