import { render, screen } from '@testing-library/react-native';

import { CardView } from './CardView';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

test('dispatches every card type', async () => {
  await render(
    <>
      <CardView card={{ type: 'restock_list', items: [], total_cost: null }} />
      <CardView card={{ type: 'debt_list', items: [] }} />
      <CardView
        card={{
          type: 'chart_bars',
          title_vi: 'Biểu đồ X',
          unit: 'units',
          bars: [],
        }}
      />
      <CardView
        card={{
          type: 'receipt_lines',
          receipt_id: '11111111-1111-4111-8111-111111111111',
          lines: [],
        }}
      />
    </>,
  );
  expect(screen.getByText('Danh sách nhập hàng')).toBeTruthy();
  expect(screen.getByText('Khách còn nợ')).toBeTruthy();
  expect(screen.getByText('Biểu đồ X')).toBeTruthy();
  expect(screen.getByText('Các dòng trên hóa đơn')).toBeTruthy();
});
