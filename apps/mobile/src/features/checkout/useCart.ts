import { useCallback, useMemo, useState } from 'react';

import {
  addLine,
  removeLine,
  totalDong,
  type CartLine,
  type NewCartLine,
} from './cart';

/** Skeleton hook: template for feature hooks (pure logic in cart.ts, React state here). */
export function useCart() {
  const [lines, setLines] = useState<CartLine[]>([]);
  const add = useCallback(
    (item: NewCartLine) => setLines((prev) => addLine(prev, item)),
    [],
  );
  const remove = useCallback(
    (productId: string) => setLines((prev) => removeLine(prev, productId)),
    [],
  );
  const total = useMemo(() => totalDong(lines), [lines]);
  return { lines, add, remove, total };
}
