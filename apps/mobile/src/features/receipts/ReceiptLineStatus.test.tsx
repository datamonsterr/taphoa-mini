import { screen } from '@testing-library/react-native';
import { renderWithProviders } from '@/test/render';
import { ReceiptLineStatus, receiptLineStatus } from './ReceiptLineStatus';

test.each([
  [null, 0, 'pick', 'Chọn sản phẩm'],
  [null, 5000, 'pick', 'Chọn sản phẩm'],
  ['product', 0, 'price', 'Giá chưa rõ'],
  ['product', undefined, 'price', 'Giá chưa rõ'],
  ['product', 5000, 'matched', 'Khớp'],
] as const)(
  'status for product %s and price %s',
  async (productId, price, status, label) => {
    expect(receiptLineStatus(productId, price)).toBe(status);
    await renderWithProviders(
      <ReceiptLineStatus productId={productId} price={price} />,
    );
    expect(screen.getByText(label)).toBeOnTheScreen();
  },
);
