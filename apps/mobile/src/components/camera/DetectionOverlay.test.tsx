import { fireEvent, screen } from '@testing-library/react-native';
import { useCallback, useState } from 'react';

import { renderWithProviders } from '@/test/render';

import { DetectionOverlay, type Detection } from './DetectionOverlay';

const mockBoxRenders = jest.fn();
jest.mock('./DetectionBox', () => {
  const actual = jest.requireActual('./DetectionBox');
  const { memo } = jest.requireActual('react');
  return {
    ...actual,
    DetectionBox: memo(function Counted(props: { id: string }) {
      mockBoxRenders(props.id);
      return <actual.DetectionBox {...props} />;
    }),
  };
});

const imageSize = { width: 1080, height: 1440 };
const viewSize = { width: 360, height: 360 };

const sting: Detection = {
  id: 'sting',
  name: 'Sting đỏ',
  price: 10000,
  bbox: [108, 360, 216, 360],
  alternatives: [
    { id: 'sting', name: 'Sting đỏ', price: 10000 },
    { id: 'stingY', name: 'Sting vàng', price: 10000 },
  ],
};
const water: Detection = {
  id: 'water',
  name: 'Aquafina',
  price: 5000,
  bbox: [540, 720, 270, 360],
};
const mystery: Detection = {
  id: 'x',
  name: 'Chưa rõ',
  price: 0,
  bbox: [0, 360, 216, 216],
  lowMatch: true,
};

const noop = jest.fn();

describe('DetectionOverlay', () => {
  it('positions the box from the cover-mapped bbox', async () => {
    await renderWithProviders(
      <DetectionOverlay
        imageSize={imageSize}
        viewSize={viewSize}
        detections={[sting]}
        selected={{ sting: true }}
        mode="one"
        onToggle={noop}
        onPricePress={noop}
        onChoose={noop}
      />,
    );
    // scale 1/3, offsetY -60 -> x 36, y 60, w 72, h 120
    expect(
      screen.getByRole('button', { name: 'Sting đỏ, đã chọn' }),
    ).toHaveStyle({
      left: 36,
      top: 60,
      width: 72,
      height: 120,
    });
  });

  it('single mode: no number badge; many mode: numbers selected boxes in order', async () => {
    const props = {
      imageSize,
      viewSize,
      detections: [sting, water],
      selected: { sting: true, water: true },
      onToggle: noop,
      onPricePress: noop,
      onChoose: noop,
    };
    const { rerender } = await renderWithProviders(
      <DetectionOverlay {...props} mode="one" />,
    );
    expect(screen.queryAllByTestId('box-badge')).toHaveLength(0);
    await rerender(<DetectionOverlay {...props} mode="many" />);
    expect(screen.getAllByTestId('box-badge')).toHaveLength(2);
    expect(screen.getByText('1')).toBeOnTheScreen();
    expect(screen.getByText('2')).toBeOnTheScreen();
  });

  it('numbers skip deselected boxes', async () => {
    await renderWithProviders(
      <DetectionOverlay
        imageSize={imageSize}
        viewSize={viewSize}
        detections={[sting, water]}
        selected={{ sting: false, water: true }}
        mode="many"
        onToggle={noop}
        onPricePress={noop}
        onChoose={noop}
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Sting đỏ, bỏ chọn' }),
    ).toBeOnTheScreen();
    expect(screen.getAllByTestId('box-badge')).toHaveLength(1);
    expect(screen.getByTestId('box-badge')).toHaveTextContent('1');
  });

  it('price pill variants follow selection and low match', async () => {
    await renderWithProviders(
      <DetectionOverlay
        imageSize={imageSize}
        viewSize={viewSize}
        detections={[sting, water, mystery]}
        selected={{ sting: true, water: false }}
        mode="many"
        onToggle={noop}
        onPricePress={noop}
        onChoose={noop}
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Sting đỏ 10.000đ, xem món khác' }),
    ).toBeOnTheScreen();
    expect(
      screen.getByRole('button', { name: 'Aquafina 5.000đ, xem món khác' }),
    ).toBeOnTheScreen();
    expect(
      screen.getByRole('button', { name: 'Chưa có trong kho, nhập giá' }),
    ).toBeOnTheScreen();
    expect(
      screen.getByRole('button', { name: 'Chưa rõ, chưa có trong kho' }),
    ).toBeOnTheScreen();
  });

  it('forwards taps', async () => {
    const onToggle = jest.fn();
    const onPricePress = jest.fn();
    await renderWithProviders(
      <DetectionOverlay
        imageSize={imageSize}
        viewSize={viewSize}
        detections={[sting, mystery]}
        selected={{ sting: true }}
        mode="many"
        onToggle={onToggle}
        onPricePress={onPricePress}
        onChoose={noop}
      />,
    );
    await fireEvent.press(
      screen.getByRole('button', { name: 'Sting đỏ, đã chọn' }),
    );
    expect(onToggle).toHaveBeenCalledWith('sting');
    await fireEvent.press(
      screen.getByRole('button', { name: 'Sting đỏ 10.000đ, xem món khác' }),
    );
    expect(onPricePress).toHaveBeenCalledWith('sting');
    await fireEvent.press(
      screen.getByRole('button', { name: 'Chưa có trong kho, nhập giá' }),
    );
    expect(onPricePress).toHaveBeenCalledWith('x');
  });

  it('many mode: floating strip below the open box', async () => {
    const onChoose = jest.fn();
    await renderWithProviders(
      <DetectionOverlay
        imageSize={imageSize}
        viewSize={viewSize}
        detections={[sting]}
        selected={{ sting: true }}
        mode="many"
        openId="sting"
        onToggle={noop}
        onPricePress={noop}
        onChoose={onChoose}
      />,
    );
    // box y 60 h 120 -> below = 206; 206 + 64 <= 352
    expect(screen.getByTestId('alternatives-strip')).toHaveStyle({
      position: 'absolute',
      top: 206,
    });
    await fireEvent.press(
      screen.getByRole('radio', { name: 'Sting vàng 10.000đ' }),
    );
    expect(onChoose).toHaveBeenCalledWith('sting', 'stingY');
  });

  it('many mode: strip goes above the box when there is no room below', async () => {
    await renderWithProviders(
      <DetectionOverlay
        imageSize={imageSize}
        viewSize={viewSize}
        detections={[{ ...sting, bbox: [108, 900, 216, 360] }]}
        selected={{ sting: true }}
        mode="many"
        openId="sting"
        onToggle={noop}
        onPricePress={noop}
        onChoose={noop}
      />,
    );
    // y = 900/3 - 60 = 240, h 120 -> below 386 no room -> 240 - 64 - 12 = 164
    expect(screen.getByTestId('alternatives-strip')).toHaveStyle({ top: 164 });
  });

  it('single mode never renders the strip (parent places it below the viewfinder)', async () => {
    await renderWithProviders(
      <DetectionOverlay
        imageSize={imageSize}
        viewSize={viewSize}
        detections={[sting]}
        selected={{ sting: true }}
        mode="one"
        openId="sting"
        onToggle={noop}
        onPricePress={noop}
        onChoose={noop}
      />,
    );
    expect(screen.queryByTestId('alternatives-strip')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Sting đỏ 10.000đ, xem món khác' }),
    ).toBeExpanded();
  });

  it('ignores an open id without alternatives', async () => {
    await renderWithProviders(
      <DetectionOverlay
        imageSize={imageSize}
        viewSize={viewSize}
        detections={[water]}
        selected={{ water: true }}
        mode="many"
        openId="water"
        onToggle={noop}
        onPricePress={noop}
        onChoose={noop}
      />,
    );
    expect(screen.queryByTestId('alternatives-strip')).toBeNull();
  });

  it('selecting one box re-renders only that box (stable ids, callbacks and rects)', async () => {
    const both = [sting, water];
    function Harness() {
      const [selected, setSelected] = useState<Record<string, boolean>>({
        sting: true,
        water: true,
      });
      const toggle = useCallback(
        (id: string) => setSelected((s) => ({ ...s, [id]: !s[id] })),
        [],
      );
      return (
        <DetectionOverlay
          imageSize={imageSize}
          viewSize={viewSize}
          detections={both}
          selected={selected}
          mode="one"
          onToggle={toggle}
          onPricePress={noop}
          onChoose={noop}
        />
      );
    }
    await renderWithProviders(<Harness />);
    mockBoxRenders.mockClear();
    await fireEvent.press(
      screen.getByRole('button', { name: 'Aquafina, đã chọn' }),
    );
    expect(mockBoxRenders.mock.calls.map(([id]) => id)).toEqual(['water']);
  });

  // #182: a box that fills the photo used to push the pill half outside the frame.
  it('keeps the price pill whole inside the viewfinder', async () => {
    const whole: Detection = { ...water, bbox: [0, 0, 1080, 1440] };
    await renderWithProviders(
      <DetectionOverlay
        imageSize={imageSize}
        viewSize={viewSize}
        detections={[whole]}
        selected={{ water: true }}
        mode="one"
        onToggle={noop}
        onPricePress={noop}
        onChoose={noop}
      />,
    );
    // 360 view - 40 pill - 12 margin.
    expect(screen.getByTestId('price-pill-anchor')).toHaveStyle({ top: 308 });
  });

  it('draws an ambiguous guess amber with a "?" price until it is selected', async () => {
    const guess: Detection = { ...sting, unsure: true };
    const props = {
      imageSize,
      viewSize,
      detections: [guess],
      mode: 'one' as const,
      onToggle: noop,
      onPricePress: noop,
      onChoose: noop,
    };
    const { rerender } = await renderWithProviders(
      <DetectionOverlay {...props} selected={{}} />,
    );
    expect(
      screen.getByRole('button', { name: 'Sting đỏ, chưa chắc, chạm để chọn' }),
    ).toBeOnTheScreen();
    expect(
      screen.getByRole('button', { name: /xem món khác$/ }),
    ).toHaveTextContent('? 10.000');
    await rerender(<DetectionOverlay {...props} selected={{ sting: true }} />);
    expect(
      screen.getByRole('button', { name: 'Sting đỏ, đã chọn' }),
    ).toBeOnTheScreen();
  });
});
