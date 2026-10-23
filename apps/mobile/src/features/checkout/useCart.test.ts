import { act, renderHook } from '@testing-library/react-native';

import { addLine, removeLine, totalDong } from './cart';
import { useCart } from './useCart';

const tea = { productId: 'tea', name: 'Trà', unitPrice: 12000 };
const noodle = { productId: 'noodle', name: 'Mì', unitPrice: 4500 };

describe('cart math', () => {
  test('adding the same product increments quantity', () => {
    const lines = addLine(addLine([], tea), tea);
    expect(lines).toEqual([{ ...tea, quantity: 2 }]);
  });

  test('totals in whole đồng and removes lines', () => {
    const lines = addLine(addLine(addLine([], tea), tea), noodle);
    expect(totalDong(lines)).toBe(28500);
    expect(totalDong(removeLine(lines, 'tea'))).toBe(4500);
    expect(totalDong([])).toBe(0);
  });
});

describe('useCart', () => {
  test('add and remove update lines and total', async () => {
    const { result } = await renderHook(() => useCart());
    expect(result.current.total).toBe(0);

    await act(async () => {
      result.current.add(tea);
      result.current.add(noodle);
    });
    expect(result.current.lines).toHaveLength(2);
    expect(result.current.total).toBe(16500);

    await act(async () => result.current.remove('tea'));
    expect(result.current.total).toBe(4500);
  });
});
