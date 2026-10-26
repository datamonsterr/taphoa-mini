import { fireEvent, render, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import { StyleSheet } from 'react-native';

import { useSettingsStore } from '@/stores/settings';
import { colors } from '@/theme';

import { ReceiptLinesCard, confidenceColor } from './ReceiptLinesCard';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

const RECEIPT = '11111111-1111-4111-8111-111111111111';
const card = {
  type: 'receipt_lines' as const,
  receipt_id: RECEIPT,
  lines: [
    {
      line_id: 'l1',
      name: 'Sting đỏ',
      quantity: 6,
      cost: 90000,
      product_id: 'p1',
      product_name: 'Sting dâu 330ml',
      confidence: 0.9,
    },
    {
      line_id: 'l2',
      name: 'Mì lạ',
      quantity: null,
      cost: null,
      product_id: null,
      product_name: null,
      confidence: null,
    },
    {
      line_id: 'l3',
      name: 'Bánh',
      quantity: 2,
      cost: 12000,
      product_id: 'p3',
      product_name: 'Bánh quy',
      confidence: 0.6,
    },
  ],
};

const colorOf = (id: string) =>
  StyleSheet.flatten(screen.getByTestId(id).props.style).backgroundColor;

test('confidence thresholds map to theme colours', () => {
  expect(confidenceColor(0.8)).toBe(colors.success);
  expect(confidenceColor(0.5)).toBe(colors.warning);
  expect(confidenceColor(0.49)).toBe(colors.danger);
  expect(confidenceColor(null)).toBe(colors.danger);
});

test('renders each line with cost, match and confidence colour', async () => {
  await render(<ReceiptLinesCard card={card} />);
  expect(screen.getByText('Sting đỏ')).toBeTruthy();
  expect(screen.getByText('90.000đ')).toBeTruthy();
  expect(screen.getByText('Sting dâu 330ml')).toBeTruthy();
  expect(screen.getByText('Chưa khớp')).toBeTruthy();
  expect(colorOf('receipt-line-l1-confidence')).toBe(colors.success);
  expect(colorOf('receipt-line-l2-confidence')).toBe(colors.danger);
  expect(colorOf('receipt-line-l3-confidence')).toBe(colors.warning);
});

test('shows Unmatched in English', async () => {
  useSettingsStore.setState({ language: 'en' });
  await render(<ReceiptLinesCard card={card} />);
  expect(screen.getByText('Unmatched')).toBeTruthy();
  expect(screen.getByText('View as table')).toBeTruthy();
});

test('pressing a line reports it', async () => {
  const onLinePress = jest.fn();
  await render(<ReceiptLinesCard card={card} onLinePress={onLinePress} />);
  await fireEvent.press(screen.getByLabelText(/Mì lạ/));
  expect(onLinePress).toHaveBeenCalledWith(card.lines[1]);
});

test('lines can be pressed without a handler', async () => {
  await render(<ReceiptLinesCard card={card} />);
  await fireEvent.press(screen.getByLabelText(/Sting đỏ/));
});

test('View as table opens the receipt screen', async () => {
  await render(<ReceiptLinesCard card={card} />);
  await fireEvent.press(screen.getByText('Xem dạng bảng'));
  expect(router.push).toHaveBeenCalledWith(`/receipt/${RECEIPT}`);
});
