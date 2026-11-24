import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

import { resetMockDb } from '@/test/mock';
import { useCartStore } from '@/stores/cart';
import {
  createTestQueryClient,
  renderWithProviders as render,
} from '@/test/render';

import { CameraScreen } from './CameraScreen';
import { uploadPartsAsBlobs } from './testing';

jest.mock('./useDocumentProbe', () => ({
  useDocumentProbe: jest.fn(() => null),
}));
jest.mock('@/features/assistant/flags', () => ({
  useAssistantEnabled: jest.fn(() => true),
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn() }),
  useLocalSearchParams: () => ({}),
  useIsFocused: () => true,
}));

const mockPreviewRenders = jest.fn();
/* eslint-disable @typescript-eslint/no-require-imports -- jest.mock factories must require lazily */
jest.mock('expo-camera', () => {
  const React = require('react');
  const { View } = require('react-native');
  const CameraView = React.forwardRef(function MockCameraView(
    props: Record<string, unknown>,
    ref: React.Ref<unknown>,
  ) {
    mockPreviewRenders();
    React.useImperativeHandle(ref, () => ({
      takePictureAsync: () =>
        Promise.resolve({ uri: 'file:///shot.jpg', width: 1080, height: 1440 }),
    }));
    const onReady = props.onCameraReady as (() => void) | undefined;
    React.useEffect(() => onReady?.(), [onReady]);
    return React.createElement(View, { testID: 'camera-view' });
  });
  const granted = { granted: true, canAskAgain: true };
  return { CameraView, useCameraPermissions: () => [granted, jest.fn()] };
});
/* eslint-enable @typescript-eslint/no-require-imports */

beforeEach(() => {
  resetMockDb();
  useCartStore.setState({ lines: [] });
  mockPreviewRenders.mockClear();
  uploadPartsAsBlobs();
});

describe('viewfinder isolation', () => {
  it('cart adds and edits never re-render the live camera preview', async () => {
    const queryClient = createTestQueryClient();
    await render(<CameraScreen />, queryClient);
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await fireEvent.press(screen.getByRole('button', { name: 'Chụp' }));
    await screen.findByRole('button', { name: /Chụp lại/ });
    await waitFor(() => expect(screen.queryByTestId('scan-busy')).toBeNull());

    mockPreviewRenders.mockClear();
    // The "add" button: lands in the cart and bumps the screen's own add counter.
    await fireEvent.press(screen.getByRole('button', { name: 'Thêm vào giỏ' }));
    expect(useCartStore.getState().lines.length).toBeGreaterThan(0);
    const { productId } = useCartStore.getState().lines[0]!;
    await act(async () => useCartStore.getState().increment(productId));
    await act(async () => useCartStore.getState().decrement(productId));
    await act(async () =>
      useCartStore.getState().add({ productId: 'x', name: 'Coca', price: 1 }),
    );
    await act(async () => useCartStore.getState().remove('x'));

    expect(mockPreviewRenders).not.toHaveBeenCalled();
  });
});
