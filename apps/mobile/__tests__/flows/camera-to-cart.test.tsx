import {
  act,
  fireEvent,
  renderApp,
  screen,
  testRouter,
  waitFor,
} from '@/test/router';
import {
  fireGestureHandler,
  getByGestureTestId,
} from 'react-native-gesture-handler/jest-utils';

import {
  initialQuickEnroll,
  useQuickEnrollStore,
} from '@/features/camera/quickEnroll';
import { uploadPartsAsBlobs } from '@/features/camera/testing';
import * as images from '@/lib/api/images';
import * as ledger from '@/lib/api/ledger';
import { mapBox } from '@/lib/bbox';
import { formatVnd } from '@/lib/format';
import { setMockScenario } from '@/test/mock';
import { useCartStore } from '@/stores/cart';

const IMAGE = { width: 1080, height: 1440 };
const VIEW = { width: 358, height: 358 };

const shoot = () =>
  fireEvent.press(screen.getByRole('button', { name: 'Chụp' }));

beforeEach(() => {
  uploadPartsAsBlobs();
  useQuickEnrollStore.setState(initialQuickEnroll);
});

afterEach(() => jest.restoreAllMocks());

describe('camera -> cart', () => {
  it('captures several items, deselects one, adds the rest and shows the cart pill', async () => {
    setMockScenario('multi');
    const create = jest.spyOn(images, 'createScan');
    await renderApp('/');

    await fireEvent.press(screen.getByRole('button', { name: 'Nhiều món' }));
    await shoot();
    await screen.findByRole('button', { name: 'Chụp lại' });
    await waitFor(() => expect(screen.queryByTestId('scan-busy')).toBeNull());

    const scan = await create.mock.results[0]!.value;
    expect(scan.image).toMatchObject(IMAGE);
    const boxes = screen.getAllByRole('button', { name: /đã chọn$/ });
    expect(boxes).toHaveLength(3);
    boxes.forEach((box, i) => {
      const rect = mapBox(scan.detections[i].bbox, IMAGE, VIEW, 'cover');
      expect(box).toHaveStyle({
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
      });
    });
    expect(screen.getByTestId('add-badge')).toHaveTextContent('3');

    await fireEvent.press(boxes[1]!);
    expect(screen.getByTestId('add-badge')).toHaveTextContent('2');

    await fireEvent.press(
      screen.getByRole('button', { name: 'Thêm tất cả vào giỏ' }),
    );
    const kept = [0, 2].map((i) => scan.detections[i].candidates[0]);
    const total = kept.reduce((sum, c) => sum + c.price, 0);
    expect(useCartStore.getState().lines.map((l) => l.productId)).toEqual(
      kept.map((c) => c.product_id),
    );

    const pill = screen.getByRole('button', {
      name: `Giỏ hàng: 2 món, ${formatVnd(total)}`,
    });
    expect(screen.getByTestId('cart-count')).toHaveTextContent('2');
    expect(screen.getByTestId('camera-view')).toBeOnTheScreen();

    await fireEvent.press(pill);
    expect(screen).toHavePathname('/cart');
    expect(await screen.findByTestId('cart-sheet')).toBeOnTheScreen();
  });

  it('single item: pick another chip, add, and the pill counts it', async () => {
    setMockScenario('match');
    const create = jest.spyOn(images, 'createScan');
    await renderApp('/');
    await shoot();
    await screen.findByRole('button', { name: /đã chọn$/ });
    const scan = await create.mock.results[0]!.value;
    const alt = scan.detections[0].candidates[1];

    // the strip is open under the viewfinder after a single-item scan
    await fireEvent.press(screen.getAllByRole('radio')[1]!);
    await fireEvent.press(screen.getByRole('button', { name: 'Thêm vào giỏ' }));

    expect(useCartStore.getState().lines).toMatchObject([
      { productId: alt.product_id, price: alt.price, qty: 1 },
    ]);
    expect(
      screen.getByRole('button', {
        name: `Giỏ hàng: 1 món, ${formatVnd(alt.price)}`,
      }),
    ).toBeOnTheScreen();
  });

  it('low match: + stays disabled and the ? pill opens enroll with the photo', async () => {
    setMockScenario('unknown');
    const create = jest.spyOn(images, 'createScan');
    await renderApp('/');
    await shoot();
    await screen.findByRole('button', { name: 'Chưa có trong kho, nhập giá' });
    const scan = await create.mock.results[0]!.value;

    expect(screen.getByRole('button', { name: 'Thêm vào giỏ' })).toBeDisabled();
    await fireEvent.press(screen.getByRole('button', { name: 'Thêm vào giỏ' }));
    expect(useCartStore.getState().lines).toHaveLength(0);

    await fireEvent.press(
      screen.getByRole('button', { name: 'Chưa có trong kho, nhập giá' }),
    );
    expect(screen).toHavePathname('/enroll');
    expect(screen).toHaveSearchParams({
      photoUri: 'file:///mock.jpg',
      scanId: scan.id,
      detectionId: scan.detections[0]!.id,
      crop: '297,404,486,632',
    });
    expect(await screen.findByTestId('enroll-sheet')).toBeOnTheScreen();
    // Enroll cuts the pressed box out of the photo instead of using the whole frame.
    await waitFor(() =>
      expect(
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('expo-image-manipulator').__crops,
      ).toContainEqual({
        uri: 'file:///mock.jpg',
        originX: 297,
        originY: 404,
        width: 486,
        height: 632,
      }),
    );
  });

  it('low match: the ? pill opens enroll too', async () => {
    setMockScenario('unknown');
    await renderApp('/');
    await shoot();
    await fireEvent.press(
      await screen.findByRole('button', {
        name: 'Chưa có trong kho, nhập giá',
      }),
    );
    expect(screen).toHavePathname('/enroll');
  });

  it('idle tag toggles quick enroll on the camera screen', async () => {
    await renderApp('/');
    await fireEvent.press(
      screen.getByRole('button', { name: 'Thêm vào kho với giá' }),
    );
    expect(screen).toHavePathname('/');
    expect(screen.getByText('Xoay sản phẩm')).toBeOnTheScreen();
    expect(useQuickEnrollStore.getState().active).toBe(true);
  });

  it('swipe handle opens the shop', async () => {
    await renderApp('/');
    await act(async () => {
      fireGestureHandler(getByGestureTestId('swipe-handle-pan'), [
        { state: 2 },
        { translationY: -90, velocityY: -300, state: 4 },
        { translationY: -90, velocityY: -300, state: 5 },
      ]);
    });
    await waitFor(() => expect(screen).toHavePathname('/inventory'));
    expect(
      await screen.findByRole('button', { name: 'Vuốt xuống: camera' }),
    ).toBeOnTheScreen();
  });

  it('keeps the training labels from the scan all the way to the sale body', async () => {
    setMockScenario('match');
    const create = jest.spyOn(images, 'createScan');
    const createSale = jest.spyOn(ledger, 'createSale');
    await renderApp('/');
    await shoot();
    await screen.findByRole('button', { name: 'Chụp lại' });
    await waitFor(() => expect(screen.queryByTestId('scan-busy')).toBeNull());
    const scan = await create.mock.results[0]!.value;
    const detection = scan.detections[0];

    await fireEvent.press(screen.getByRole('button', { name: 'Thêm vào giỏ' }));
    await testRouter.push('/pay');
    await screen.findByLabelText(/^Mã VietQR/);
    await fireEvent.press(screen.getByRole('button', { name: 'Đã nhận tiền' }));
    await waitFor(() => expect(createSale).toHaveBeenCalledTimes(1));

    const body = createSale.mock.calls[0]![0];
    expect(body.scan_ids).toEqual([scan.id]);
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0]).toMatchObject({
      product_id: detection.candidates[0].product_id,
      source: 'camera',
      detection_id: detection.id,
      suggested_product_id: detection.candidates[0].product_id,
    });
  });

  it('a corrected box sends the top-1 as suggested_product_id', async () => {
    setMockScenario('match');
    const create = jest.spyOn(images, 'createScan');
    const createSale = jest.spyOn(ledger, 'createSale');
    await renderApp('/');
    await shoot();
    await screen.findByRole('button', { name: 'Chụp lại' });
    await waitFor(() => expect(screen.queryByTestId('scan-busy')).toBeNull());
    const scan = await create.mock.results[0]!.value;
    const [top, second] = scan.detections[0].candidates;

    // the strip is open under the viewfinder after a single-item scan
    await fireEvent.press(
      screen.getByRole('radio', { name: new RegExp(second.name) }),
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Thêm vào giỏ' }));
    await testRouter.push('/pay');
    await screen.findByLabelText(/^Mã VietQR/);
    await fireEvent.press(screen.getByRole('button', { name: 'Đã nhận tiền' }));
    await waitFor(() => expect(createSale).toHaveBeenCalledTimes(1));
    expect(createSale.mock.calls[0]![0].lines[0]).toMatchObject({
      product_id: second.product_id,
      suggested_product_id: top.product_id,
    });
  });

  it('+ adds the matched boxes but keeps the unknown one on screen', async () => {
    setMockScenario('multi');
    const create = jest.spyOn(images, 'createScan');
    await renderApp('/');
    await fireEvent.press(screen.getByRole('button', { name: 'Nhiều món' }));
    // One of the three boxes comes back unknown.
    const real = images.createScan;
    create.mockImplementationOnce(async (input) => {
      const scan = await real(input);
      const [first, second, third] = scan.detections;
      return {
        ...scan,
        detections: [first!, second!, { ...third!, match: 'unknown' as const }],
      };
    });
    await shoot();
    await screen.findByRole('button', { name: 'Chụp lại' });
    await waitFor(() => expect(screen.queryByTestId('scan-busy')).toBeNull());
    expect(screen.getByTestId('add-badge')).toHaveTextContent('2');

    await fireEvent.press(
      screen.getByRole('button', { name: 'Thêm tất cả vào giỏ' }),
    );
    expect(useCartStore.getState().lines).toHaveLength(2);
    // The unknown box is still there to enroll; the camera did not reset.
    expect(
      screen.getByRole('button', { name: /chưa có trong kho$/ }),
    ).toBeOnTheScreen();
    expect(screen.queryAllByRole('button', { name: /đã chọn$/ })).toHaveLength(
      0,
    );
    expect(screen.getByRole('button', { name: 'Chụp lại' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Thêm vào giỏ' })).toBeDisabled();
  });
});
