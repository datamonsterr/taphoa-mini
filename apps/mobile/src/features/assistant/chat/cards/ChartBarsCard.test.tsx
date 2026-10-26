import { render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { ChartBarsCard } from './ChartBarsCard';

const bars = [
  { label: 'Thứ 2', value: 200000 },
  { label: 'Thứ 3', value: 100000 },
  { label: 'Thứ 4', value: 0 },
];

const width = (i: number) =>
  StyleSheet.flatten(screen.getByTestId(`chart-bar-${i}`).props.style).width;

test('dong values use formatVnd and bar widths are proportional', async () => {
  await render(
    <ChartBarsCard
      card={{ type: 'chart_bars', title_vi: 'Doanh thu', unit: 'dong', bars }}
    />,
  );
  expect(screen.getByText('Doanh thu')).toBeTruthy();
  expect(screen.getByText('200.000đ')).toBeTruthy();
  expect(width(0)).toBe('100%');
  expect(width(1)).toBe('50%');
  expect(width(2)).toBe('0%');
});

test('units values are plain numbers; an all-zero chart has empty bars', async () => {
  await render(
    <ChartBarsCard
      card={{
        type: 'chart_bars',
        title_vi: 'Số lượng',
        unit: 'units',
        bars: [{ label: 'A', value: 0 }],
      }}
    />,
  );
  expect(screen.getByText('0')).toBeTruthy();
  expect(width(0)).toBe('0%');
});
