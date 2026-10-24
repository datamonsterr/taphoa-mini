/* eslint-disable @typescript-eslint/no-require-imports -- jest.mock factories require lazily */
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import * as Haptics from 'expo-haptics';

import { listProducts } from '@/lib/api';
import * as imagesApi from '@/lib/api/images';
import * as productsApi from '@/lib/api/products';
import * as reviewApi from '@/lib/api/review';
import { resetMockDb } from '@/test/mock/db';
import { useCartStore } from '@/stores/cart';
import { renderWithProviders } from '@/test/render';

import { EnrollScreen } from './EnrollScreen';

const mockRouter = { back: jest.fn(), push: jest.fn(), replace: jest.fn() };
let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => mockParams,
}));

let mockPermission: { granted: boolean } | null = { granted: true };
const mockRequestPermission = jest.fn();
let mockShot = 0;
jest.mock('expo-camera', () => {
  const React = require('react');
  const { View } = require('react-native');
  const CameraView = React.forwardRef(
    (props: Record<string, unknown>, ref: React.Ref<unknown>) => {
      React.useImperativeHandle(ref, () => ({
        takePictureAsync: async () => ({
          uri: `file:///angle-${++mockShot}.jpg`,
          width: 1080,
          height: 1440,
        }),
      }));
      return React.createElement(View, { testID: 'camera-view', ...props });
    },
  );
  CameraView.displayName = 'CameraView';
  return {
    CameraView,
    useCameraPermissions: () => [mockPermission, mockRequestPermission],
  };
});

const PHOTO = 'file:///captured.jpg';

async function typePrice(...keys: string[]) {
  for (const key of keys) {
    await fireEvent.press(screen.getByRole('button', { name: key }));
  }
}

const save = () =>
  screen.getByRole('button', { name: 'Lưu vào kho và thêm vào giỏ' });

/** Node's FormData rejects RN `{ uri }` file parts, so tests send a Blob instead. */
function stubUploadAsBlob() {
  const real = imagesApi.uploadImage;
  return jest
    .spyOn(imagesApi, 'uploadImage')
    .mockImplementation((_file, purpose) =>
      real(new Blob(['x'], { type: 'image/jpeg' }), purpose),
    );
}

beforeEach(() => {
  jest.restoreAllMocks();
  stubUploadAsBlob();
  jest.clearAllMocks();
  mockShot = 0;
  mockPermission = { granted: true };
  mockParams = { photoUri: PHOTO };
  resetMockDb();
  useCartStore.setState({ lines: [] });
});

describe('EnrollScreen layout', () => {
  it('starts with the captured photo, empty price and save disabled', async () => {
    await renderWithProviders(<EnrollScreen />);
    expect(screen.getByLabelText('1 trên 5 ảnh')).toHaveTextContent('1/5');
    expect(screen.getByLabelText('Giá bán')).toHaveTextContent('0đ');
    expect(save()).toBeDisabled();
    expect(screen.getByLabelText('Tên (không bắt buộc)')).toBeOnTheScreen();
  });

  it('closes back to the camera', async () => {
    await renderWithProviders(<EnrollScreen />);
    await fireEvent.press(screen.getAllByLabelText('Đóng').at(-1)!);
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
  });
});

describe('EnrollScreen keypad', () => {
  it('builds the price from digits and 000', async () => {
    await renderWithProviders(<EnrollScreen />);
    await typePrice('1', '5', '000');
    expect(screen.getByLabelText('Giá bán')).toHaveTextContent('15.000đ');
    expect(save()).toBeEnabled();
  });

  it('deletes the last digit', async () => {
    await renderWithProviders(<EnrollScreen />);
    await typePrice('1', '2', 'Xóa');
    expect(screen.getByLabelText('Giá bán')).toHaveTextContent('1đ');
    await typePrice('Xóa');
    expect(screen.getByLabelText('Giá bán')).toHaveTextContent('0đ');
    expect(save()).toBeDisabled();
  });

  it('ignores digits past nine', async () => {
    await renderWithProviders(<EnrollScreen />);
    await typePrice('1', '000', '000', '5', '5', '5');
    expect(screen.getByLabelText('Giá bán')).toHaveTextContent('100.000.055đ');
  });

  it('keeps save disabled without a photo', async () => {
    mockParams = {};
    await renderWithProviders(<EnrollScreen />);
    expect(screen.getByLabelText('0 trên 5 ảnh')).toBeOnTheScreen();
    await typePrice('5');
    expect(save()).toBeDisabled();
  });
});

describe('EnrollScreen add angle', () => {
  async function openCapture() {
    await fireEvent.press(screen.getByLabelText('Thêm ảnh góc khác'));
  }

  it('opens the camera, takes a photo and appends it', async () => {
    await renderWithProviders(<EnrollScreen />);
    await openCapture();
    expect(screen.getByTestId('camera-view')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Chụp' }));
    await waitFor(() =>
      expect(screen.getByLabelText('2 trên 5 ảnh')).toHaveTextContent('2/5'),
    );
    expect(screen.queryByTestId('camera-view')).toBeNull();
  });

  it('cancels capture without adding', async () => {
    await renderWithProviders(<EnrollScreen />);
    await openCapture();
    await fireEvent.press(screen.getByLabelText('Hủy chụp'));
    expect(screen.queryByTestId('camera-view')).toBeNull();
    expect(screen.getByLabelText('1 trên 5 ảnh')).toBeOnTheScreen();
  });

  it('hides the slot at five photos', async () => {
    await renderWithProviders(<EnrollScreen />);
    for (let i = 0; i < 4; i += 1) {
      await openCapture();
      await fireEvent.press(screen.getByRole('button', { name: 'Chụp' }));
      await waitFor(() =>
        expect(screen.queryByTestId('camera-view')).toBeNull(),
      );
    }
    expect(screen.getByLabelText('5 trên 5 ảnh')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Thêm ảnh góc khác')).toBeNull();
  });

  it('asks for camera permission when it is not granted', async () => {
    mockPermission = { granted: false };
    await renderWithProviders(<EnrollScreen />);
    await openCapture();
    expect(screen.queryByTestId('camera-view')).toBeNull();
    await fireEvent.press(screen.getByLabelText('Cấp quyền camera'));
    expect(mockRequestPermission).toHaveBeenCalledTimes(1);
  });

  it('waits while permission is still loading', async () => {
    mockPermission = null;
    await renderWithProviders(<EnrollScreen />);
    await openCapture();
    expect(screen.queryByTestId('camera-view')).toBeNull();
    expect(screen.getByLabelText('Hủy chụp')).toBeOnTheScreen();
  });
});

describe('EnrollScreen save', () => {
  it('creates the product, adds it to the cart and goes back', async () => {
    await renderWithProviders(<EnrollScreen />);
    await fireEvent.changeText(
      screen.getByLabelText('Tên (không bắt buộc)'),
      'Bánh quy bơ',
    );
    await fireEvent.press(screen.getByLabelText('Thêm ảnh góc khác'));
    await fireEvent.press(screen.getByRole('button', { name: 'Chụp' }));
    await waitFor(() => expect(screen.queryByTestId('camera-view')).toBeNull());
    await typePrice('1', '5', '000');
    await fireEvent.press(save());
    await waitFor(() => expect(mockRouter.back).toHaveBeenCalledTimes(1));
    expect(Haptics.notificationAsync).toHaveBeenCalledWith('success');

    const { items } = await listProducts({ q: 'Bánh quy bơ' });
    expect(items).toHaveLength(1);
    expect(items[0].price).toBe(15000);
    expect(items[0].images).toHaveLength(2);

    const [line] = useCartStore.getState().lines;
    expect(line).toMatchObject({
      productId: items[0].id,
      name: 'Bánh quy bơ',
      price: 15000,
      qty: 1,
      manual: false,
    });
    expect(line.imageUrl).toBe(items[0].images[0].url);
  });

  it('falls back to a placeholder name when none is typed', async () => {
    await renderWithProviders(<EnrollScreen />);
    await typePrice('7', '000');
    await fireEvent.press(save());
    await waitFor(() => expect(mockRouter.back).toHaveBeenCalled());
    expect(useCartStore.getState().lines[0].name).toBe('Hàng mới');
  });

  it('shows an upload error inline and keeps the entered data', async () => {
    (imagesApi.uploadImage as jest.Mock).mockRejectedValueOnce(
      new Error('network'),
    );
    await renderWithProviders(<EnrollScreen />);
    await typePrice('9', '000');
    await fireEvent.press(save());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Không lưu được/,
    );
    expect(screen.getByLabelText('Giá bán')).toHaveTextContent('9.000đ');
    expect(mockRouter.back).not.toHaveBeenCalled();
    expect(useCartStore.getState().lines).toHaveLength(0);
    await waitFor(() => expect(save()).toBeEnabled());

    await fireEvent.press(save());
    await waitFor(() => expect(mockRouter.back).toHaveBeenCalledTimes(1));
    expect(useCartStore.getState().lines).toHaveLength(1);
  });

  it('does not upload twice on retry after the product call fails', async () => {
    const upload = imagesApi.uploadImage as jest.Mock;
    jest
      .spyOn(productsApi, 'createProduct')
      .mockRejectedValueOnce(new Error('boom'));
    await renderWithProviders(<EnrollScreen />);
    await typePrice('9', '000');
    await fireEvent.press(save());
    await screen.findByRole('alert');
    await waitFor(() => expect(save()).toBeEnabled());
    await fireEvent.press(save());
    await waitFor(() => expect(mockRouter.back).toHaveBeenCalledTimes(1));
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('disables save while pending', async () => {
    let release: (value: never) => void = () => {};
    (imagesApi.uploadImage as jest.Mock).mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve as never;
      }),
    );
    await renderWithProviders(<EnrollScreen />);
    await typePrice('9');
    await fireEvent.press(save());
    await waitFor(() => expect(save()).toBeDisabled());
    release(undefined as never);
  });
});

describe('EnrollScreen detection crop', () => {
  const crops = () => require('expo-image-manipulator').__crops as unknown[];
  beforeEach(() => {
    crops().length = 0;
  });

  it('crops the photo to the pressed detection and uploads only the crop', async () => {
    mockParams = {
      photoUri: PHOTO,
      scanId: 'scan-1',
      detectionId: 'det-1',
      crop: '50,100,150,200',
    };
    await renderWithProviders(<EnrollScreen />);
    await typePrice('5', '000');
    await waitFor(() => expect(save()).toBeEnabled());
    expect(crops()).toEqual([
      { uri: PHOTO, originX: 50, originY: 100, width: 150, height: 200 },
    ]);
    await fireEvent.press(save());
    await waitFor(() => expect(mockRouter.back).toHaveBeenCalled());
    const upload = imagesApi.uploadImage as jest.Mock;
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0][0]).toMatchObject({
      uri: 'file:///crop-1.jpg',
    });
  });

  it('holds save until the crop is ready', async () => {
    const manipulator = require('expo-image-manipulator');
    let finish: () => void = () => {};
    const context = {
      crop: () => context,
      renderAsync: () =>
        new Promise((resolve) => {
          finish = () =>
            resolve({ saveAsync: async () => ({ uri: 'file:///late.jpg' }) });
        }),
    };
    jest
      .spyOn(manipulator.ImageManipulator, 'manipulate')
      .mockImplementationOnce(() => context);
    mockParams = { photoUri: PHOTO, crop: '1,2,3,4' };
    await renderWithProviders(<EnrollScreen />);
    await typePrice('5');
    expect(save()).toBeDisabled();
    expect(screen.queryByLabelText('0 trên 5 ảnh')).toBeOnTheScreen();
    await act(async () => finish());
    await waitFor(() => expect(save()).toBeEnabled());
    expect(screen.getByLabelText('1 trên 5 ảnh')).toBeOnTheScreen();
  });

  it('falls back to the whole photo when cropping fails', async () => {
    const manipulator = require('expo-image-manipulator');
    jest
      .spyOn(manipulator.ImageManipulator, 'manipulate')
      .mockImplementationOnce(() => {
        throw new Error('no native module');
      });
    mockParams = { photoUri: PHOTO, crop: '1,2,3,4' };
    await renderWithProviders(<EnrollScreen />);
    await typePrice('5');
    await waitFor(() => expect(save()).toBeEnabled());
    await fireEvent.press(save());
    await waitFor(() => expect(mockRouter.back).toHaveBeenCalled());
    expect((imagesApi.uploadImage as jest.Mock).mock.calls[0][0]).toMatchObject(
      {
        uri: PHOTO,
      },
    );
  });

  it('uploads the whole photo when there is no box', async () => {
    await renderWithProviders(<EnrollScreen />);
    await typePrice('5');
    await fireEvent.press(save());
    await waitFor(() => expect(mockRouter.back).toHaveBeenCalled());
    expect(crops()).toHaveLength(0);
    expect((imagesApi.uploadImage as jest.Mock).mock.calls[0][0]).toMatchObject(
      {
        uri: PHOTO,
      },
    );
  });
});

describe('EnrollScreen from a sold-without-catalog line', () => {
  let LINE = '';
  beforeEach(async () => {
    LINE = (await reviewApi.listManualLines({ status: 'open' })).items[0]!
      .line_id;
    mockParams = {
      manualLineId: LINE,
      name: 'Bánh mì',
      price: '15000',
      cropUrl: 'https://mock.local/assets/crop-1.jpg',
    };
  });

  it('prefills name and price and downloads the crop as the photo', async () => {
    await renderWithProviders(<EnrollScreen />);
    expect(screen.getByDisplayValue('Bánh mì')).toBeOnTheScreen();
    expect(screen.getByLabelText('Giá bán')).toHaveTextContent('15.000đ');
    await waitFor(() => expect(save()).toBeEnabled());
    expect(screen.getByLabelText('1 trên 5 ảnh')).toBeOnTheScreen();
  });

  it('saves with from_manual_line_id, keeps the cart empty and goes back', async () => {
    const create = jest.spyOn(productsApi, 'createProduct');
    await renderWithProviders(<EnrollScreen />);
    await waitFor(() => expect(save()).toBeEnabled());
    await fireEvent.press(save());
    await waitFor(() => expect(mockRouter.back).toHaveBeenCalled());
    expect(create.mock.calls[0]![0]).toMatchObject({
      from_manual_line_id: LINE,
      name: 'Bánh mì',
      price: 15000,
    });
    expect((imagesApi.uploadImage as jest.Mock).mock.calls[0][0]).toMatchObject(
      { uri: 'file:///cache/crop-1.jpg' },
    );
    expect(useCartStore.getState().lines).toHaveLength(0);
    expect(
      (await reviewApi.listManualLines({ status: 'resolved' })).items[0],
    ).toMatchObject({ line_id: LINE, resolution: { action: 'enrolled' } });
  });
});
