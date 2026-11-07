import { act, fireEvent, screen } from '@testing-library/react-native';
import { Dimensions } from 'react-native';
import { LayoutAnimationConfig } from 'react-native-reanimated';

import { useCartStore } from '@/stores/cart';
import { useSettingsStore } from '@/stores/settings';
import { renderWithProviders } from '@/test/render';

import { CartScreen } from './CartScreen';

const mockThumbRenders = jest.fn();
jest.mock('./LineThumb', () => ({
  // A plain wrapper runs on every render of its CartRow, so it counts row renders.
  LineThumb: (props: { uri?: string }) => {
    mockThumbRenders(props.uri);
    return null;
  },
}));

const mockRouter = {
  back: jest.fn(),
  push: jest.fn(),
  replace: jest.fn(),
  dismissAll: jest.fn(),
};
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

const sting = { productId: 'p-sting', name: 'Sting đỏ', price: 10000 };
const noodle = { productId: 'p-noodle', name: 'Hảo Hảo', price: 4500 };

function seed() {
  const { add } = useCartStore.getState();
  add(sting);
  add(sting);
  add(noodle);
}

beforeEach(() => {
  jest.clearAllMocks();
  useCartStore.setState({ lines: [] });
});

describe('CartScreen with items', () => {
  beforeEach(seed);

  it('renders every line at mount without an entering animation', async () => {
    await renderWithProviders(<CartScreen />);
    expect(screen.getByTestId('cart-line-p-sting')).toBeOnTheScreen();
    expect(screen.getByTestId('cart-line-p-noodle')).toBeOnTheScreen();
    expect(screen.getAllByLabelText('Thêm một')).toHaveLength(2);
    const calls = (LayoutAnimationConfig as unknown as jest.Mock).mock.calls;
    expect(calls[0][0]).toMatchObject({ skipEntering: true });
  });

  it('incrementing one line re-renders only that row', async () => {
    useCartStore.getState().add({
      productId: 'p-tea',
      name: 'Trà xanh',
      price: 8000,
      imageUrl: 'tea.png',
    });
    await renderWithProviders(<CartScreen />);
    mockThumbRenders.mockClear();
    await act(async () => useCartStore.getState().increment('p-tea'));
    expect(screen.getAllByLabelText('Số lượng 2')).toHaveLength(2);
    expect(mockThumbRenders.mock.calls).toEqual([['tea.png']]);
  });

  it('shows each line with name, price and quantity', async () => {
    await renderWithProviders(<CartScreen />);
    expect(screen.getByText('Sting đỏ')).toBeOnTheScreen();
    expect(screen.getByText('Hảo Hảo')).toBeOnTheScreen();
    expect(screen.getByText('10.000đ')).toBeOnTheScreen();
    expect(screen.getByText('4.500đ')).toBeOnTheScreen();
    expect(screen.getByLabelText('Số lượng 2')).toBeOnTheScreen();
  });

  it('shows the item count badge and the total', async () => {
    await renderWithProviders(<CartScreen />);
    expect(screen.getByLabelText('3 món')).toBeOnTheScreen();
    expect(screen.getByText('24.500đ')).toBeOnTheScreen();
  });

  it('increments a line', async () => {
    await renderWithProviders(<CartScreen />);
    await fireEvent.press(screen.getAllByLabelText('Thêm một')[1]);
    expect(screen.getByLabelText('4 món')).toBeOnTheScreen();
    expect(screen.getByText('29.000đ')).toBeOnTheScreen();
  });

  it('decrements a line with quantity above 1', async () => {
    await renderWithProviders(<CartScreen />);
    await fireEvent.press(screen.getByLabelText('Bớt một'));
    expect(useCartStore.getState().lines[0].qty).toBe(1);
    expect(screen.queryByLabelText('Bớt một')).not.toBeOnTheScreen();
  });

  it('removes a line from the trash at quantity 1', async () => {
    await renderWithProviders(<CartScreen />);
    await fireEvent.press(screen.getByLabelText('Xóa'));
    expect(screen.queryByText('Hảo Hảo')).not.toBeOnTheScreen();
    expect(useCartStore.getState().lines).toHaveLength(1);
    expect(screen.getByText('20.000đ')).toBeOnTheScreen();
  });

  it('collapses back to the camera', async () => {
    await renderWithProviders(<CartScreen />);
    await fireEvent.press(screen.getAllByLabelText('Đóng').at(-1)!);
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
  });

  it('opens the payment screen from the QR pill', async () => {
    await renderWithProviders(<CartScreen />);
    await fireEvent.press(screen.getByLabelText('Hiện mã QR thanh toán'));
    expect(mockRouter.push).toHaveBeenCalledWith('/pay');
  });
});

describe('CartScreen empty', () => {
  it('shows the empty message and no total or QR pill', async () => {
    await renderWithProviders(<CartScreen />);
    expect(screen.getByText('Giỏ hàng trống')).toBeOnTheScreen();
    expect(screen.getByLabelText('0 món')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Hiện mã QR thanh toán')).toBeNull();
  });

  it('returns to the camera from the empty state', async () => {
    await renderWithProviders(<CartScreen />);
    await fireEvent.press(screen.getByLabelText('Về máy ảnh'));
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
  });
});

describe('CartScreen in English', () => {
  beforeEach(() => useSettingsStore.setState({ language: 'en' }));

  it('translates the stepper, badge and close labels', async () => {
    seed();
    await renderWithProviders(<CartScreen />);
    expect(screen.getByLabelText('3 items')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Close' })).toBeOnTheScreen();
    expect(screen.getAllByLabelText('One more')).toHaveLength(2);
    expect(screen.getByLabelText('Quantity 2')).toBeOnTheScreen();
    expect(screen.getByLabelText('Remove')).toBeOnTheScreen();
  });

  it('translates the empty state', async () => {
    await renderWithProviders(<CartScreen />);
    expect(screen.getByText('Cart is empty')).toBeOnTheScreen();
    expect(
      screen.getByRole('button', { name: 'Back to camera' }),
    ).toBeOnTheScreen();
  });
});

describe('CartScreen on a narrow window', () => {
  const flat = (node: { props: { style?: unknown } }) =>
    Object.assign({}, ...[node.props.style].flat(5).filter(Boolean));

  beforeEach(() => {
    jest
      .spyOn(Dimensions, 'get')
      .mockReturnValue({ width: 320, height: 640, scale: 2, fontScale: 1 });
    useCartStore.getState().add({
      productId: 'p-long',
      name: 'Nước ngọt có ga hương cam Sting đỏ chai lớn',
      price: 100000,
    });
  });
  afterEach(() => jest.restoreAllMocks());

  it('shows the name on at most two lines and never wraps the price', async () => {
    await renderWithProviders(<CartScreen />);
    const name = screen.getByText(/Sting đỏ chai lớn/);
    expect(name.props.numberOfLines).toBe(2);
    expect(flat(name as never).flexShrink).toBe(1);
    const price = screen.getAllByText('100.000đ')[0];
    expect(price.props.numberOfLines).toBe(1);
    expect(flat(price as never).flexShrink).toBe(0);
  });

  it('uses a compact fixed-width stepper', async () => {
    await renderWithProviders(<CartScreen />);
    const button = screen.getByRole('button', { name: 'Xóa' });
    expect(flat(button as never)).toMatchObject({ width: 44, height: 44 });
  });
});
