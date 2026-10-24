import { act, fireEvent, screen } from '@testing-library/react-native';
import type { ComponentProps } from 'react';
import { processColor } from 'react-native';

import {
  initialQuickEnroll,
  selectCurrent,
  useQuickEnrollStore,
  type Shot,
} from '@/features/camera/quickEnroll';
import { colors } from '@/theme';
import { renderWithProviders } from '@/test/render';

import { PointOverlay, viewToPhoto } from './index';

const view = { width: 400, height: 800 };
const photo = { width: 1024, height: 768 };

describe('viewToPhoto', () => {
  it.each([
    [
      { x: 200, y: 400 },
      { x: 512, y: 384 },
    ],
    [
      { x: 0, y: 250 },
      { x: 0, y: 0 },
    ],
    [
      { x: 400, y: 550 },
      { x: 1024, y: 768 },
    ],
  ])('maps contained photo centre and corners: %j', (tap, expected) => {
    expect(viewToPhoto(tap, view, photo, 'contain')).toEqual(expected);
  });

  it.each([
    { x: NaN, y: 400 },
    { x: 200, y: NaN },
    { x: Infinity, y: 400 },
    { x: 200, y: 249 },
    { x: 200, y: 551 },
    { x: -1, y: 400 },
    { x: 401, y: 400 },
  ])('ignores taps outside the contained photo: %j', (tap) => {
    expect(viewToPhoto(tap, view, photo, 'contain')).toBeNull();
  });
});

describe('viewToPhoto additional layouts', () => {
  it('maps a portrait photo with horizontal letterboxing', () => {
    const portrait = { width: 768, height: 1024 };
    expect(
      viewToPhoto(
        { x: 250, y: 0 },
        { width: 800, height: 400 },
        portrait,
        'contain',
      ),
    ).toEqual({ x: 0, y: 0 });
    expect(
      viewToPhoto(
        { x: 249, y: 200 },
        { width: 800, height: 400 },
        portrait,
        'contain',
      ),
    ).toBeNull();
  });

  it('accounts for centre cropping with cover', () => {
    expect(viewToPhoto({ x: 200, y: 400 }, view, photo, 'cover')).toEqual({
      x: 512,
      y: 384,
    });
    expect(viewToPhoto({ x: 0, y: 0 }, view, photo, 'cover')).toEqual({
      x: 320,
      y: 0,
    });
    expect(viewToPhoto({ x: 400, y: 800 }, view, photo, 'cover')).toEqual({
      x: 704,
      y: 768,
    });
    expect(viewToPhoto({ x: -1, y: 400 }, view, photo, 'cover')).toBeNull();
  });

  it.each([
    [{ width: 0, height: 800 }, photo],
    [view, { width: 1024, height: 0 }],
    [view, { width: -1, height: 768 }],
  ])(
    'ignores taps before a valid layout or photo size: %j %j',
    (layout, dimensions) => {
      expect(
        viewToPhoto({ x: 0, y: 0 }, layout, dimensions, 'contain'),
      ).toBeNull();
    },
  );
});

const shot: Shot = {
  id: 'shot-1',
  uri: 'file:///product.jpg',
  width: 1024,
  height: 768,
  points: [],
  status: 'pointing',
};

function props(overrides: Partial<ComponentProps<typeof PointOverlay>> = {}) {
  return {
    shot,
    index: 0,
    acceptedCount: 0,
    onTap: jest.fn(),
    onUndo: jest.fn(),
    onRetake: jest.fn(),
    onNext: jest.fn(),
    ...overrides,
  };
}

async function measure(width = 400, height = 800) {
  await fireEvent(screen.getByTestId('point-overlay-canvas'), 'layout', {
    nativeEvent: { layout: { x: 0, y: 0, width, height } },
  });
}

async function tap(x: number, y: number) {
  await fireEvent.press(screen.getByTestId('point-overlay-canvas'), {
    nativeEvent: { locationX: x, locationY: y },
  });
}

describe('PointOverlay', () => {
  it('shows the frozen photo and emits foreground points in photo pixels', async () => {
    const callbacks = props();
    await renderWithProviders(<PointOverlay {...callbacks} />);
    expect(screen.getByTestId('point-overlay-photo')).toHaveProp('source', [
      { uri: shot.uri },
    ]);
    expect(screen.getByTestId('point-overlay-photo')).toHaveProp(
      'contentFit',
      'contain',
    );
    await tap(200, 400);
    expect(callbacks.onTap).not.toHaveBeenCalled();
    await measure();
    await tap(100, 325);
    expect(callbacks.onTap).toHaveBeenCalledWith({ x: 256, y: 192, label: 1 });
    await tap(200, 249);
    await tap(200, 551);
    expect(callbacks.onTap).toHaveBeenCalledTimes(1);
  });
});

describe('PointOverlay points', () => {
  it('uses the real store to replace the second marker on the third tap', async () => {
    useQuickEnrollStore.setState(initialQuickEnroll);
    const dispatch = useQuickEnrollStore.getState().dispatch;
    dispatch({ type: 'toggle' });
    dispatch({
      type: 'captured',
      id: shot.id,
      uri: shot.uri,
      width: shot.width,
      height: shot.height,
    });
    dispatch({ type: 'uploaded', id: shot.id, imageId: 'uploaded-image' });
    function Harness() {
      const current = useQuickEnrollStore(selectCurrent);
      return current ? (
        <PointOverlay
          {...props()}
          shot={current}
          onTap={(point) => dispatch({ type: 'addPoint', point })}
        />
      ) : null;
    }
    try {
      await renderWithProviders(<Harness />);
      await measure();
      await tap(100, 325);
      await tap(200, 400);
      expect(screen.getAllByTestId('point-marker')).toHaveLength(2);
      expect(screen.getByLabelText('Điểm 1')).toHaveStyle({
        left: 88,
        top: 313,
      });
      expect(screen.getByLabelText('Điểm 2')).toHaveStyle({
        left: 188,
        top: 388,
      });
      await tap(300, 475);
      expect(screen.getAllByTestId('point-marker')).toHaveLength(2);
      expect(screen.getByLabelText('Điểm 1')).toHaveStyle({
        left: 88,
        top: 313,
      });
      expect(screen.getByLabelText('Điểm 2')).toHaveStyle({
        left: 288,
        top: 463,
      });
      await measure(800, 1600);
      expect(screen.getByLabelText('Điểm 1')).toHaveStyle({
        left: 188,
        top: 638,
      });
    } finally {
      await act(() => useQuickEnrollStore.setState(initialQuickEnroll));
    }
  });
});

describe('PointOverlay mask', () => {
  it('stretches the PNG mask over the photo rectangle with a translucent accent tint', async () => {
    const callbacks = props();
    const { rerender } = await renderWithProviders(
      <PointOverlay {...callbacks} />,
    );
    await measure();
    expect(screen.queryByTestId('point-overlay-mask')).toBeNull();
    await rerender(
      <PointOverlay
        {...callbacks}
        shot={{
          ...shot,
          mask: { width: 256, height: 256, pngBase64: 'mask-png' },
        }}
      />,
    );
    await measure();
    const mask = screen.getByTestId('point-overlay-mask');
    expect(mask).toHaveProp('source', [
      { uri: 'data:image/png;base64,mask-png' },
    ]);
    expect(mask).toHaveProp('contentFit', 'fill');
    expect(mask).toHaveProp('tintColor', processColor(colors.accent));
    expect(mask).toHaveProp('pointerEvents', 'none');
    expect(mask).toHaveStyle({
      left: 0,
      top: 250,
      width: 400,
      height: 300,
      opacity: 0.35,
    });
  });
});

describe('PointOverlay controls', () => {
  const mask = { width: 256, height: 256, pngBase64: 'mask' };

  it.each<Shot['status']>([
    'uploading',
    'pointing',
    'segmenting',
    'error',
    'accepted',
  ])('disables Next without a mask while %s', async (status) => {
    const callbacks = props({ shot: { ...shot, status } });
    await renderWithProviders(<PointOverlay {...callbacks} />);
    const next = screen.getByRole('button', { name: 'Tiếp' });
    expect(next).toBeDisabled();
    await fireEvent.press(next);
    expect(callbacks.onNext).not.toHaveBeenCalled();
  });

  it.each<Shot['status']>(['uploading', 'segmenting', 'error', 'accepted'])(
    'disables Next with a mask while %s',
    async (status) => {
      await renderWithProviders(
        <PointOverlay {...props({ shot: { ...shot, mask, status } })} />,
      );
      expect(screen.getByRole('button', { name: 'Tiếp' })).toBeDisabled();
    },
  );

  it('disables Undo without points and still allows Retake', async () => {
    const callbacks = props();
    await renderWithProviders(<PointOverlay {...callbacks} />);
    const undo = screen.getByRole('button', { name: 'Hoàn tác điểm' });
    expect(undo).toBeDisabled();
    await fireEvent.press(undo);
    expect(callbacks.onUndo).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'Chụp lại' }));
    expect(callbacks.onRetake).toHaveBeenCalledTimes(1);
  });

  it('calls Undo, Retake and Next when enabled', async () => {
    const callbacks = props({
      shot: { ...shot, mask, points: [{ x: 512, y: 384, label: 1 }] },
    });
    await renderWithProviders(<PointOverlay {...callbacks} />);
    for (const name of ['Hoàn tác điểm', 'Chụp lại', 'Tiếp']) {
      const button = screen.getByRole('button', { name });
      expect(button).toBeEnabled();
      await fireEvent.press(button);
    }
    expect(callbacks.onUndo).toHaveBeenCalledTimes(1);
    expect(callbacks.onRetake).toHaveBeenCalledTimes(1);
    expect(callbacks.onNext).toHaveBeenCalledTimes(1);
  });
});

describe('PointOverlay feedback', () => {
  it('shows the segmentation spinner and waiting text', async () => {
    await renderWithProviders(
      <PointOverlay {...props({ shot: { ...shot, status: 'segmenting' } })} />,
    );
    expect(screen.getByText('Đang tách...')).toBeOnTheScreen();
    expect(screen.getByRole('progressbar')).toBeOnTheScreen();
  });

  it('shows the error and a hint to retry by tapping the product', async () => {
    const callbacks = props({
      shot: { ...shot, status: 'error', error: 'Không thể tách sản phẩm' },
    });
    await renderWithProviders(<PointOverlay {...callbacks} />);
    expect(screen.getByRole('alert')).toHaveTextContent(
      /Không thể tách sản phẩm/,
    );
    expect(
      screen.getByText('Chạm lại vào sản phẩm để thử lại.'),
    ).toBeOnTheScreen();
    await measure();
    await tap(200, 400);
    expect(callbacks.onTap).toHaveBeenCalledWith({ x: 512, y: 384, label: 1 });
  });

  it.each([
    { acceptedCount: 0, index: 0, filled: 0, current: 0 },
    { acceptedCount: 1, index: 1, filled: 1, current: 1 },
    { acceptedCount: 2, index: 2, filled: 2, current: 2 },
    { acceptedCount: 3, index: 3, filled: 3, current: 2 },
    { acceptedCount: 7, index: 7, filled: 3, current: 2 },
  ])(
    'shows accepted and current angle progress: %j',
    async ({ acceptedCount, index, filled, current }) => {
      await renderWithProviders(
        <PointOverlay {...props({ acceptedCount, index })} />,
      );
      expect(screen.getByText('Xoay sản phẩm')).toBeOnTheScreen();
      const dots = screen.getAllByTestId('angle-dot');
      expect(dots).toHaveLength(3);
      dots.forEach((dot, i) => {
        expect(dot).toHaveProp(
          'accessibilityLabel',
          `Góc ${i + 1}: ${i < filled ? 'đã chụp' : 'chưa chụp'}`,
        );
        expect(dot).toHaveProp('accessibilityState', {
          selected: i === current,
        });
        expect(dot).toHaveStyle({
          backgroundColor: i < filled ? colors.accent : 'transparent',
        });
      });
      expect(dots[current]).toHaveStyle({ borderColor: colors.accent });
    },
  );
});
