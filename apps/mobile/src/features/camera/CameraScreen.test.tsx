import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react-native';
import * as Haptics from 'expo-haptics';
import { Linking } from 'react-native';
import {
  fireGestureHandler,
  getByGestureTestId,
} from 'react-native-gesture-handler/jest-utils';

import * as images from '@/lib/api/images';
import { mapBox } from '@/lib/bbox';
import { resetMockDb, setMockScenario } from '@/test/mock';
import { useCartStore } from '@/stores/cart';
import { useSessionStore } from '@/stores/session';
import { useSettingsStore } from '@/stores/settings';
import { colors } from '@/theme';
import { renderWithProviders } from '@/test/render';

import { uploadPartsAsBlobs } from './testing';
import { CameraScreen } from './CameraScreen';
import { useCaptureModeStore } from './modeStore';

const mockFeedbackProps = jest.fn();
jest.mock('./AddFeedback', () => {
  const actual = jest.requireActual('./AddFeedback');
  return {
    ...actual,
    AddFeedback: (props: Record<string, unknown>) => {
      mockFeedbackProps(props);
      return <actual.AddFeedback {...props} />;
    },
  };
});

const mockRenders = jest.fn();
jest.mock('@/components/camera', () => {
  const { memo } = jest.requireActual('react');
  const actual = jest.requireActual('@/components/camera');
  const counted = (name: string, Component: React.ComponentType<any>) =>
    // Memo-wrapped like the real components: the count moves only when the real one would render.
    memo(function Counted(props: object) {
      mockRenders(name);
      return <Component {...props} />;
    });
  return {
    ...actual,
    Viewfinder: counted('viewfinder', actual.Viewfinder),
    Shutter: counted('shutter', actual.Shutter),
  };
});
const mockBoxRenders = jest.fn();
jest.mock('@/components/camera/DetectionBox', () => {
  const { memo } = jest.requireActual('react');
  const actual = jest.requireActual('@/components/camera/DetectionBox');
  return {
    ...actual,
    DetectionBox: memo(function Counted(props: { id: string }) {
      mockBoxRenders(props.id);
      return <actual.DetectionBox {...props} />;
    }),
  };
});

const mockPush = jest.fn();
const mockTakePicture = jest.fn();
const mockRequestPermission = jest.fn();
const mockState: {
  permission: { granted: boolean; canAskAgain: boolean } | null;
  focused: boolean;
  /** Fire `onCameraReady` after mount; tests switch it off to hold the camera unready. */
  autoReady: boolean;
  /** How many times a CameraView was mounted; the preview must survive a capture. */
  mounts: number;
  listeners: Set<(focused: boolean) => void>;
} = {
  permission: { granted: true, canAskAgain: true },
  focused: true,
  autoReady: true,
  mounts: 0,
  listeners: new Set(),
};

jest.mock('expo-router', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories must require lazily
  const React = require('react');
  const router = { push: (...args: unknown[]) => mockPush(...args) };
  return {
    useRouter: () => router,
    useIsFocused: () => {
      const [focused, setFocused] = React.useState(mockState.focused);
      React.useEffect(() => {
        mockState.listeners.add(setFocused);
        return () => mockState.listeners.delete(setFocused);
      }, []);
      return focused;
    },
  };
});

/* eslint-disable @typescript-eslint/no-require-imports -- jest.mock factories must require lazily */
jest.mock('expo-camera', () => {
  const React = require('react');
  const { View } = require('react-native');
  const CameraView = React.forwardRef(function MockCameraView(
    props: Record<string, unknown>,
    ref: React.Ref<unknown>,
  ) {
    React.useImperativeHandle(ref, () => ({
      takePictureAsync: (...args: unknown[]) => mockTakePicture(...args),
    }));
    const onReady = props.onCameraReady as (() => void) | undefined;
    React.useEffect(() => {
      mockState.mounts += 1;
    }, []);
    React.useEffect(() => {
      if (mockState.autoReady) onReady?.();
    }, [onReady]);
    return React.createElement(View, { testID: 'camera-view', ...props });
  });
  return {
    CameraView,
    useCameraPermissions: () => [
      mockState.permission,
      (...args: unknown[]) => mockRequestPermission(...args),
    ],
  };
});

const setFocused = (focused: boolean) =>
  act(() => {
    mockState.focused = focused;
    mockState.listeners.forEach((listener) => listener(focused));
  });

const SIZE = { width: 358, height: 358 };
const IMAGE = { width: 1080, height: 1440 };

beforeEach(() => {
  resetMockDb();
  useCartStore.setState({ lines: [] });
  useCaptureModeStore.setState({ mode: 'one' });
  useSettingsStore.setState({ language: 'vi' });
  mockState.permission = { granted: true, canAskAgain: true };
  mockState.focused = true;
  mockState.autoReady = true;
  mockState.mounts = 0;
  mockPush.mockReset();
  mockRequestPermission.mockReset();
  mockTakePicture
    .mockReset()
    .mockResolvedValue({ uri: 'file:///shot.jpg', ...IMAGE });
  jest.clearAllMocks();
  uploadPartsAsBlobs();
});

afterEach(() => jest.restoreAllMocks());

const shutter = () => screen.getByRole('button', { name: /^Chụp/ });
async function capture() {
  await fireEvent.press(screen.getByRole('button', { name: 'Chụp' }));
  await screen.findByRole('button', { name: 'Chụp lại' });
  await waitFor(() => expect(screen.queryByTestId('scan-busy')).toBeNull());
}

describe('idle', () => {
  it('shows the live camera with every control of board 01', async () => {
    await renderWithProviders(<CameraScreen />);
    expect(screen.getByTestId('camera-view')).toBeOnTheScreen();
    expect(screen.getByTestId('viewfinder')).toHaveStyle(SIZE);
    for (const name of ['Một món', 'Nhiều món']) {
      expect(screen.getByRole('button', { name })).toBeOnTheScreen();
    }
    expect(
      screen.getByRole('button', { name: 'Thêm vào kho với giá' }),
    ).toBeOnTheScreen();
    expect(shutter()).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Thêm vào giỏ' })).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Giỏ hàng trống' }),
    ).toBeOnTheScreen();
    expect(
      screen.getByRole('button', { name: 'Vuốt lên: cửa hàng' }),
    ).toBeOnTheScreen();
    expect(screen.queryByTestId('enroll-pulse')).toBeNull();
  });

  it('keeps the shutter disabled until the camera is ready', async () => {
    mockState.autoReady = false;
    await renderWithProviders(<CameraScreen />);
    expect(shutter()).toBeDisabled();
    await fireEvent.press(shutter());
    expect(mockTakePicture).not.toHaveBeenCalled();

    await act(async () => {
      screen.getByTestId('camera-view').props.onCameraReady();
    });
    expect(shutter()).toBeEnabled();
    await fireEvent.press(shutter());
    await waitFor(() => expect(mockTakePicture).toHaveBeenCalledTimes(1));
  });

  it('keeps the live preview mounted behind the frozen photo and across retakes', async () => {
    await renderWithProviders(<CameraScreen />);
    await capture();
    expect(screen.getByTestId('camera-view')).toBeOnTheScreen();
    expect(screen.getByTestId('viewfinder-photo')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Chụp lại' }));
    expect(screen.queryByTestId('viewfinder-photo')).toBeNull();
    expect(shutter()).toBeEnabled();
    await capture();
    await fireEvent.press(screen.getByRole('button', { name: 'Chụp lại' }));
    expect(mockState.mounts).toBe(1);
  });

  it('keeps the shutter ready-gated while the camera has not started', async () => {
    mockState.autoReady = false;
    await renderWithProviders(<CameraScreen />);
    expect(shutter()).toBeDisabled();
  });

  it('shows nothing in the viewfinder while the permission is loading', async () => {
    mockState.permission = null;
    await renderWithProviders(<CameraScreen />);
    expect(screen.queryByTestId('camera-view')).toBeNull();
    expect(screen.queryByText('Cho phép máy ảnh')).toBeNull();
  });

  it('asks for the permission with a button inside the viewfinder', async () => {
    mockState.permission = { granted: false, canAskAgain: true };
    await renderWithProviders(<CameraScreen />);
    expect(screen.queryByTestId('camera-view')).toBeNull();
    await fireEvent.press(
      screen.getByRole('button', { name: 'Cho phép máy ảnh' }),
    );
    expect(mockRequestPermission).toHaveBeenCalledTimes(1);
  });

  it('opens the settings when the permission was denied for good', async () => {
    mockState.permission = { granted: false, canAskAgain: false };
    const open = jest.spyOn(Linking, 'openSettings').mockResolvedValue();
    await renderWithProviders(<CameraScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'Mở cài đặt' }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(mockRequestPermission).not.toHaveBeenCalled();
  });

  it('does not capture without a permission', async () => {
    mockState.permission = { granted: false, canAskAgain: true };
    await renderWithProviders(<CameraScreen />);
    await fireEvent.press(shutter());
    expect(mockTakePicture).not.toHaveBeenCalled();
  });

  it('keeps the camera mounted only while the screen is focused', async () => {
    await renderWithProviders(<CameraScreen />);
    await setFocused(false);
    expect(screen.queryByTestId('camera-view')).toBeNull();
    await setFocused(true);
    expect(screen.getByTestId('camera-view')).toBeOnTheScreen();
  });

  it('tag opens enroll without a photo', async () => {
    await renderWithProviders(<CameraScreen />);
    await fireEvent.press(
      screen.getByRole('button', { name: 'Thêm vào kho với giá' }),
    );
    expect(mockPush).toHaveBeenCalledWith('/enroll');
  });

  it('cart pill opens the cart with the running count and total', async () => {
    useCartStore.getState().add({ productId: 'p', name: 'A', price: 12000 });
    useCartStore.getState().add({ productId: 'q', name: 'B', price: 13000 });
    await renderWithProviders(<CameraScreen />);
    const pill = screen.getByRole('button', {
      name: 'Giỏ hàng: 2 món, 25.000đ',
    });
    expect(within(pill).getByTestId('cart-count')).toHaveTextContent('2');
    await fireEvent.press(pill);
    expect(mockPush).toHaveBeenCalledWith('/cart');
  });

  it('swipe handle opens the shop by tap and by pan up', async () => {
    await renderWithProviders(<CameraScreen />);
    fireGestureHandler(getByGestureTestId('swipe-handle-tap'), [{ state: 5 }]);
    fireGestureHandler(getByGestureTestId('swipe-handle-pan'), [
      { state: 2 },
      { translationY: -80, velocityY: -200, state: 4 },
      { translationY: -80, velocityY: -200, state: 5 },
    ]);
    expect(mockPush).toHaveBeenNthCalledWith(1, '/inventory');
    expect(mockPush).toHaveBeenNthCalledWith(2, '/inventory');
  });

  it('mode toggle switches the persisted mode', async () => {
    await renderWithProviders(<CameraScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'Nhiều món' }));
    expect(useCaptureModeStore.getState().mode).toBe('many');
    await fireEvent.press(screen.getByRole('button', { name: 'Một món' }));
    expect(useCaptureModeStore.getState().mode).toBe('one');
  });

  it('starts in the persisted mode', async () => {
    useCaptureModeStore.setState({ mode: 'many' });
    await renderWithProviders(<CameraScreen />);
    expect(screen.getByRole('button', { name: 'Nhiều món' })).toBeSelected();
  });
});

describe('single item', () => {
  beforeEach(() => setMockScenario('match'));

  it('freezes the photo at once and shows busy while the scan is pending', async () => {
    const realCreate = images.createScan;
    let release!: () => void;
    jest.spyOn(images, 'createScan').mockImplementation(
      (input) =>
        new Promise((resolve) => {
          release = () => resolve(realCreate(input));
        }),
    );
    await renderWithProviders(<CameraScreen />);
    await fireEvent.press(shutter());
    expect(mockTakePicture).toHaveBeenCalledWith({ quality: 0.6 });
    expect(await screen.findByTestId('viewfinder-photo')).toHaveProp('source', [
      { uri: 'file:///shot.jpg' },
    ]);
    expect(screen.getByTestId('camera-view')).toBeOnTheScreen();
    expect(screen.getByTestId('scan-busy')).toBeOnTheScreen();
    expect(shutter()).toBeDisabled();
    await act(async () => release());
    expect(
      await screen.findByRole('button', { name: /đã chọn$/ }),
    ).toBeOnTheScreen();
    expect(screen.queryByTestId('scan-busy')).toBeNull();
  });

  it('maps boxes with the photo size when the API omits the image size (the real backend does)', async () => {
    const realCreate = images.createScan;
    jest.spyOn(images, 'createScan').mockImplementation(async (input) => {
      const result = await realCreate(input);
      return {
        ...result,
        image: { ...result.image, width: undefined, height: undefined },
      };
    });
    await renderWithProviders(<CameraScreen />);
    await capture();
    const box = screen.getByRole('button', { name: /đã chọn$/ });
    // The camera mock takes 1080x1440 photos, the size the box coordinates are in.
    const rect = mapBox([297, 404, 486, 632], IMAGE, SIZE, 'cover');
    expect(box).toHaveStyle({ left: rect.x, top: rect.y, width: rect.width });
  });

  it('draws the box at the mapped position, with price pill and confidence', async () => {
    await renderWithProviders(<CameraScreen />);
    await capture();
    const box = screen.getByRole('button', { name: /đã chọn$/ });
    const rect = mapBox([297, 404, 486, 632], IMAGE, SIZE, 'cover');
    expect(box).toHaveStyle({
      left: rect.x,
      top: rect.y,
      width: rect.width,
      height: rect.height,
    });
    expect(
      screen.getByRole('button', { name: /xem món khác$/ }),
    ).toBeOnTheScreen();
    expect(screen.getByTestId('confidence-badge')).toHaveTextContent('94');
    expect(screen.getByRole('button', { name: 'Chụp lại' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Thêm vào giỏ' })).toBeEnabled();
    expect(screen.queryByTestId('add-badge')).toBeNull();
  });

  it('uploads the photo as scan.jpg with the single mode', async () => {
    const create = jest.spyOn(images, 'createScan');
    await renderWithProviders(<CameraScreen />);
    await capture();
    expect(create).toHaveBeenCalledWith({
      image: { uri: 'file:///shot.jpg', name: 'scan.jpg', type: 'image/jpeg' },
      mode: 'single',
    });
  });

  it('the strip sits below the viewfinder; price opens and closes it', async () => {
    await renderWithProviders(<CameraScreen />);
    await capture();
    expect(screen.queryByTestId('alternatives-strip')).toBeNull();
    const price = screen.getByRole('button', { name: /xem món khác$/ });
    await fireEvent.press(price);
    expect(screen.getByTestId('alternatives-strip')).toBeOnTheScreen();
    expect(screen.getAllByRole('radio').length).toBeGreaterThan(1);
    expect(screen.getAllByRole('radio')[0]).toBeChecked();
    expect(screen.getByTestId('viewfinder')).not.toContainElement(
      screen.getByTestId('alternatives-strip'),
    );
    await fireEvent.press(
      screen.getByRole('button', { name: /xem món khác$/ }),
    );
    expect(screen.queryByTestId('alternatives-strip')).toBeNull();
  });

  it('choosing a chip replaces the price and product, keeping the box selected', async () => {
    await renderWithProviders(<CameraScreen />);
    await capture();
    const before = screen.getByRole('button', { name: /xem món khác$/ }).props
      .accessibilityLabel as string;
    await fireEvent.press(
      screen.getByRole('button', { name: /xem món khác$/ }),
    );
    const second = screen.getAllByRole('radio')[1]!;
    const chosenLabel = second.props.accessibilityLabel as string;
    await fireEvent.press(second);
    const after = screen.getByRole('button', { name: /xem món khác$/ });
    expect(after.props.accessibilityLabel).toBe(`${chosenLabel}, xem món khác`);
    expect(after.props.accessibilityLabel).not.toBe(before);
    expect(screen.getByRole('button', { name: /đã chọn$/ })).toBeOnTheScreen();
    expect(screen.getAllByRole('radio')[0]).toBeChecked();
  });

  it('tapping a box deselects it and disables +', async () => {
    await renderWithProviders(<CameraScreen />);
    await capture();
    await fireEvent.press(screen.getByRole('button', { name: /đã chọn$/ }));
    expect(screen.getByRole('button', { name: /bỏ chọn$/ })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Thêm vào giỏ' })).toBeDisabled();
    await fireEvent.press(screen.getByRole('button', { name: /bỏ chọn$/ }));
    expect(screen.getByRole('button', { name: 'Thêm vào giỏ' })).toBeEnabled();
  });

  it('+ adds the chosen product, buzzes, flies a dot and returns to the live camera', async () => {
    await renderWithProviders(<CameraScreen />);
    await capture();
    await fireEvent.press(
      screen.getByRole('button', { name: /xem món khác$/ }),
    );
    const second = screen.getAllByRole('radio')[1]!;
    const label = second.props.accessibilityLabel as string;
    await fireEvent.press(second);
    await fireEvent.press(screen.getByRole('button', { name: 'Thêm vào giỏ' }));

    const [line] = useCartStore.getState().lines;
    expect(useCartStore.getState().lines).toHaveLength(1);
    expect(label).toContain(line!.name);
    expect(line!.qty).toBe(1);
    expect(Haptics.notificationAsync).toHaveBeenCalledWith('success');
    expect(screen.getByTestId('add-fly')).toBeOnTheScreen();
    expect(screen.getByTestId('camera-view')).toBeOnTheScreen();
    expect(screen.queryByTestId('viewfinder-photo')).toBeNull();
    expect(screen.getByRole('button', { name: 'Chụp' })).toBeEnabled();
    expect(
      screen.getByRole('button', { name: /^Giỏ hàng: 1 món/ }),
    ).toBeOnTheScreen();
  });

  it('retake (shutter) and the frozen photo both return to the live camera', async () => {
    await renderWithProviders(<CameraScreen />);
    await capture();
    await fireEvent.press(screen.getByRole('button', { name: 'Chụp lại' }));
    expect(screen.getByTestId('camera-view')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: /đã chọn$/ })).toBeNull();

    await capture();
    await fireEvent.press(
      screen.getByRole('button', { name: 'Quay lại máy ảnh' }),
    );
    expect(screen.getByTestId('camera-view')).toBeOnTheScreen();
  });

  it('tag navigates to enroll with the photo and scan id', async () => {
    const create = jest.spyOn(images, 'createScan');
    await renderWithProviders(<CameraScreen />);
    await capture();
    const scan = await create.mock.results[0]!.value;
    await fireEvent.press(
      screen.getByRole('button', { name: 'Thêm vào kho với giá' }),
    );
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/enroll',
      params: { photoUri: 'file:///shot.jpg', scanId: scan.id },
    });
  });

  it('leaving the screen drops the frozen result', async () => {
    await renderWithProviders(<CameraScreen />);
    await capture();
    await setFocused(false);
    await setFocused(true);
    expect(screen.getByTestId('camera-view')).toBeOnTheScreen();
    expect(screen.queryByTestId('viewfinder-photo')).toBeNull();
  });
});

describe('many items', () => {
  beforeEach(() => {
    setMockScenario('multi');
    useCaptureModeStore.setState({ mode: 'many' });
  });

  it('requests the multi mode and numbers three selected boxes, with the count on +', async () => {
    const create = jest.spyOn(images, 'createScan');
    await renderWithProviders(<CameraScreen />);
    await capture();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'multi' }),
    );
    expect(screen.getAllByRole('button', { name: /đã chọn$/ })).toHaveLength(3);
    expect(screen.getAllByTestId('box-badge')).toHaveLength(3);
    expect(screen.getByTestId('add-badge')).toHaveTextContent('3');
    expect(
      screen.getByRole('button', { name: 'Thêm tất cả vào giỏ' }),
    ).toBeEnabled();
    expect(screen.queryByTestId('confidence-badge')).toBeNull();
  });

  it('deselecting a box lowers the batch count', async () => {
    await renderWithProviders(<CameraScreen />);
    await capture();
    await fireEvent.press(
      screen.getAllByRole('button', { name: /đã chọn$/ })[1]!,
    );
    expect(screen.getByTestId('add-badge')).toHaveTextContent('2');
    expect(screen.getAllByRole('button', { name: /bỏ chọn$/ })).toHaveLength(1);
  });

  it('the strip floats inside the viewfinder', async () => {
    await renderWithProviders(<CameraScreen />);
    await capture();
    await fireEvent.press(
      screen.getAllByRole('button', { name: /xem món khác$/ })[0]!,
    );
    expect(screen.getByTestId('viewfinder')).toContainElement(
      screen.getByTestId('alternatives-strip'),
    );
    await fireEvent.press(
      screen.getAllByRole('button', { name: /xem món khác$/ })[1]!,
    );
    expect(screen.getAllByTestId('alternatives-strip')).toHaveLength(1);
  });

  it('choosing in a deselected box selects it again', async () => {
    await renderWithProviders(<CameraScreen />);
    await capture();
    await fireEvent.press(
      screen.getAllByRole('button', { name: /đã chọn$/ })[0]!,
    );
    expect(screen.getByTestId('add-badge')).toHaveTextContent('2');
    await fireEvent.press(
      screen.getAllByRole('button', { name: /xem món khác$/ })[0]!,
    );
    await fireEvent.press(screen.getAllByRole('radio')[1]!);
    expect(screen.getByTestId('add-badge')).toHaveTextContent('3');
  });

  it('+ adds every selected box and empties the batch', async () => {
    await renderWithProviders(<CameraScreen />);
    await capture();
    await fireEvent.press(
      screen.getAllByRole('button', { name: /đã chọn$/ })[0]!,
    );
    await fireEvent.press(
      screen.getByRole('button', { name: 'Thêm tất cả vào giỏ' }),
    );
    expect(useCartStore.getState().lines).toHaveLength(2);
    expect(screen.getByTestId('camera-view')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Thêm vào giỏ' })).toBeDisabled();
  });

  it('switching to one item after a multi scan redraws without numbers', async () => {
    await renderWithProviders(<CameraScreen />);
    await capture();
    await fireEvent.press(screen.getByRole('button', { name: 'Một món' }));
    expect(screen.queryAllByTestId('box-badge')).toHaveLength(0);
    expect(screen.queryByTestId('add-badge')).toBeNull();
  });
});

describe('low match', () => {
  beforeEach(() => setMockScenario('unknown'));

  it('draws a dashed amber box with ?, pulses the tag and disables +', async () => {
    await renderWithProviders(<CameraScreen />);
    await capture();
    expect(
      screen.getByRole('button', { name: /chưa có trong kho$/ }),
    ).toBeOnTheScreen();
    expect(screen.getByTestId('box-frame')).toHaveStyle({
      borderStyle: 'dashed',
      borderColor: colors.warningSoft,
    });
    expect(
      screen.getByRole('button', { name: 'Chưa có trong kho, nhập giá' }),
    ).toBeOnTheScreen();
    expect(screen.getByTestId('enroll-pulse')).toBeOnTheScreen();
    expect(screen.getByTestId('enroll-arrow')).toBeOnTheScreen();
    expect(screen.getByTestId('confidence-badge')).toHaveTextContent('31');
    expect(screen.getByRole('button', { name: 'Thêm vào giỏ' })).toBeDisabled();
  });

  it('ignores a tap on the low-match box itself', async () => {
    await renderWithProviders(<CameraScreen />);
    await capture();
    await fireEvent.press(
      screen.getByRole('button', { name: /chưa có trong kho$/ }),
    );
    expect(mockPush).not.toHaveBeenCalled();
    expect(screen.queryByTestId('alternatives-strip')).toBeNull();
  });

  it('the ? pill and the tag open enroll with the photo, scan, detection and its crop', async () => {
    const create = jest.spyOn(images, 'createScan');
    await renderWithProviders(<CameraScreen />);
    await capture();
    const scan = await create.mock.results[0]!.value;
    const target = scan.detections[0]!;
    const [x, y, w, h] = target.bbox as number[];
    // The mock photo (1080x1440) and the scanned image share a size, so the crop is the bbox.
    const sx = IMAGE.width / scan.image.width;
    const sy = IMAGE.height / scan.image.height;
    const crop = [x! * sx, y! * sy, w! * sx, h! * sy].map(Math.round).join(',');
    const params = {
      photoUri: 'file:///shot.jpg',
      scanId: scan.id,
      detectionId: target.id,
      crop,
    };
    await fireEvent.press(
      screen.getByRole('button', { name: 'Chưa có trong kho, nhập giá' }),
    );
    await fireEvent.press(
      screen.getByRole('button', { name: 'Thêm vào kho với giá' }),
    );
    expect(mockPush).toHaveBeenNthCalledWith(1, {
      pathname: '/enroll',
      params,
    });
    expect(mockPush).toHaveBeenNthCalledWith(2, {
      pathname: '/enroll',
      params,
    });
  });

  it('the tag with no low box sends the whole photo, no crop', async () => {
    setMockScenario('match');
    const create = jest.spyOn(images, 'createScan');
    await renderWithProviders(<CameraScreen />);
    await capture();
    const scan = await create.mock.results[0]!.value;
    await fireEvent.press(
      screen.getByRole('button', { name: 'Thêm vào kho với giá' }),
    );
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/enroll',
      params: { photoUri: 'file:///shot.jpg', scanId: scan.id },
    });
  });
});

describe('enroll permission', () => {
  beforeEach(() => setMockScenario('unknown'));
  const asSeller = (can_enroll: boolean) => {
    const { session } = useSessionStore.getState();
    useSessionStore.setState({
      session: {
        ...session!,
        member: { ...session!.member, role: 'seller', can_enroll },
      },
    });
  };

  it('a Seller without can_enroll gets disabled tag and ? pill, no pulse, no navigation', async () => {
    asSeller(false);
    await renderWithProviders(<CameraScreen />);
    await capture();
    const tag = screen.getByRole('button', { name: 'Thêm vào kho với giá' });
    const pill = screen.getByRole('button', {
      name: 'Chưa có trong kho, nhập giá',
    });
    expect(tag).toBeDisabled();
    expect(pill).toBeDisabled();
    expect(screen.queryByTestId('enroll-pulse')).toBeNull();
    expect(screen.queryByTestId('enroll-arrow')).toBeNull();
    await fireEvent.press(tag);
    await fireEvent.press(pill);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('a Seller with can_enroll keeps the enroll path', async () => {
    asSeller(true);
    await renderWithProviders(<CameraScreen />);
    await capture();
    expect(
      screen.getByRole('button', { name: 'Thêm vào kho với giá' }),
    ).toBeEnabled();
    await fireEvent.press(
      screen.getByRole('button', { name: 'Chưa có trong kho, nhập giá' }),
    );
    expect(mockPush).toHaveBeenCalledTimes(1);
  });
});

describe('errors', () => {
  it('shows a retry affordance on the frozen photo when the scan fails, then recovers', async () => {
    setMockScenario('match');
    const create = jest
      .spyOn(images, 'createScan')
      .mockRejectedValueOnce(new Error('503'));
    await renderWithProviders(<CameraScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'Chụp' }));
    expect(await screen.findByText('Chưa nhận diện được')).toBeOnTheScreen();
    expect(screen.getByTestId('viewfinder-photo')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Thêm vào giỏ' })).toBeDisabled();

    await fireEvent.press(screen.getByRole('button', { name: 'Thử lại' }));
    expect(
      await screen.findByRole('button', { name: /đã chọn$/ }),
    ).toBeOnTheScreen();
    expect(create).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Chưa nhận diện được')).toBeNull();
  });

  it('tapping the frozen photo abandons a failed scan', async () => {
    jest.spyOn(images, 'createScan').mockRejectedValue(new Error('503'));
    await renderWithProviders(<CameraScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'Chụp' }));
    await screen.findByText('Chưa nhận diện được');
    await fireEvent.press(screen.getByRole('button', { name: 'Chụp lại' }));
    expect(screen.getByTestId('camera-view')).toBeOnTheScreen();
    expect(screen.queryByText('Chưa nhận diện được')).toBeNull();
  });

  it('a camera failure shows the error on the live camera; retry clears it', async () => {
    mockTakePicture.mockRejectedValueOnce(new Error('not ready'));
    await renderWithProviders(<CameraScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'Chụp' }));
    expect(await screen.findByText('Chưa nhận diện được')).toBeOnTheScreen();
    expect(screen.getByTestId('camera-view')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Thử lại' }));
    expect(screen.queryByText('Chưa nhận diện được')).toBeNull();
    expect(screen.getByRole('button', { name: 'Chụp' })).toBeEnabled();
  });

  it('a slow answer after leaving the screen does not bring the result back', async () => {
    setMockScenario('match');
    const realCreate = images.createScan;
    let release!: () => void;
    jest.spyOn(images, 'createScan').mockImplementation(
      (input) =>
        new Promise((resolve) => {
          release = () => resolve(realCreate(input));
        }),
    );
    await renderWithProviders(<CameraScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'Chụp' }));
    await screen.findByTestId('scan-busy');
    await setFocused(false);
    await setFocused(true);
    await act(async () => release());
    expect(screen.queryByTestId('viewfinder-photo')).toBeNull();
    expect(screen.getByRole('button', { name: 'Chụp' })).toBeEnabled();
  });
});

describe('language', () => {
  it('shows the English strings when the language is English', async () => {
    useSettingsStore.setState({ language: 'en' });
    mockState.permission = { granted: false, canAskAgain: true };
    await renderWithProviders(<CameraScreen />);
    expect(screen.getByText('Allow camera')).toBeOnTheScreen();
  });
});

describe('ambiguous match', () => {
  beforeEach(() => setMockScenario('ambiguous'));

  it('is never picked for the seller: + stays off until the box is tapped', async () => {
    await renderWithProviders(<CameraScreen />);
    await capture();
    expect(screen.getByRole('button', { name: /bỏ chọn$/ })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Thêm vào giỏ' })).toBeDisabled();
    await fireEvent.press(screen.getByRole('button', { name: /bỏ chọn$/ }));
    expect(screen.getByRole('button', { name: 'Thêm vào giỏ' })).toBeEnabled();
  });
});

describe('layout', () => {
  it('puts the viewfinder 136px from the top on the 390x844 board', async () => {
    await renderWithProviders(<CameraScreen />);
    // 20 top padding + 56 mode toggle + 60 gap = 136.
    expect(screen.getByTestId('camera-finder-row')).toHaveStyle({
      marginTop: 60,
    });
    expect(screen.getByTestId('camera-screen')).toHaveStyle({ paddingTop: 20 });
  });

  it('aims the fly dot at the measured cart pill, not a fixed offset', async () => {
    await renderWithProviders(<CameraScreen />);
    const layout = (x: number, y: number, width: number, height: number) => ({
      nativeEvent: { layout: { x, y, width, height } },
    });
    await fireEvent(
      screen.getByTestId('camera-controls'),
      'layout',
      layout(0, 590, 390, 80),
    );
    await fireEvent(
      screen.getByTestId('camera-add-slot'),
      'layout',
      layout(300, 8, 64, 64),
    );
    await fireEvent(
      screen.getByTestId('camera-bottom-row'),
      'layout',
      layout(0, 700, 390, 56),
    );
    await fireEvent(
      screen.getByTestId('camera-cart-slot'),
      'layout',
      layout(16, 0, 128, 56),
    );
    // + centre (332, 630); pill centre (80, 728).
    expect(mockFeedbackProps.mock.calls.at(-1)![0]).toMatchObject({
      dx: -252,
      dy: 98,
    });
  });
});

describe('render counts', () => {
  const finderRenders = () =>
    mockRenders.mock.calls.filter(([name]) => name === 'viewfinder').length;
  const shutterRenders = () =>
    mockRenders.mock.calls.filter(([name]) => name === 'shutter').length;

  it('a cart change re-renders the pill only, never the viewfinder or the shutter', async () => {
    await renderWithProviders(<CameraScreen />);
    await capture();
    mockRenders.mockClear();
    mockBoxRenders.mockClear();
    await act(async () =>
      useCartStore.getState().add({ productId: 'p', name: 'Coca', price: 1 }),
    );
    expect(
      screen.getByRole('button', { name: 'Giỏ hàng: 1 món, 1đ' }),
    ).toBeOnTheScreen();
    expect(finderRenders()).toBe(0);
    expect(shutterRenders()).toBe(0);
    expect(mockBoxRenders).not.toHaveBeenCalled();
  });

  it('toggling one detection box re-renders only that box', async () => {
    setMockScenario('multi');
    useCaptureModeStore.setState({ mode: 'many' });
    await renderWithProviders(<CameraScreen />);
    await capture();
    const boxes = screen.getAllByRole('button', { name: /đã chọn$/ });
    mockBoxRenders.mockClear();
    await fireEvent.press(boxes[1]!);
    expect(screen.getAllByRole('button', { name: /bỏ chọn$/ })).toHaveLength(1);
    // Deselecting renumbers the later badges, so only the toggled box and those after it update.
    const rendered = mockBoxRenders.mock.calls.map(([id]) => id);
    expect(new Set(rendered).size).toBe(rendered.length);
    expect(rendered.length).toBeLessThan(3);
  });
});
