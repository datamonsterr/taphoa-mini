import { create } from 'zustand';

export type CartLine = {
  productId: string;
  name: string;
  /** Unit price in whole đồng. */
  price: number;
  qty: number;
  imageUrl?: string;
  /** True when the seller typed the price by hand. */
  manual: boolean;
  /** Training labels from the scan that produced the line; sent back with the sale. */
  detectionId?: string;
  /** Top-1 candidate shown for the detection; differs from `productId` after a correction. */
  suggestedProductId?: string;
  scanId?: string;
};

export type NewCartLine = Omit<CartLine, 'qty' | 'manual'> & {
  manual?: boolean;
};

type CartState = {
  lines: CartLine[];
  add: (line: NewCartLine) => void;
  increment: (productId: string) => void;
  decrement: (productId: string) => void;
  remove: (productId: string) => void;
  clear: () => void;
};

export const useCartStore = create<CartState>()((set) => ({
  lines: [],
  add: (line) =>
    set((s) => {
      const exists = s.lines.some((l) => l.productId === line.productId);
      if (exists) {
        const { detectionId, suggestedProductId, scanId } = line;
        return {
          lines: s.lines.map((l) =>
            l.productId === line.productId
              ? {
                  ...l,
                  qty: l.qty + 1,
                  // One sale line carries one label: the first scan's wins.
                  ...(l.detectionId === undefined && detectionId
                    ? { detectionId, suggestedProductId, scanId }
                    : {}),
                }
              : l,
          ),
        };
      }
      return {
        lines: [...s.lines, { ...line, manual: line.manual ?? false, qty: 1 }],
      };
    }),
  increment: (productId) =>
    set((s) => ({
      lines: s.lines.map((l) =>
        l.productId === productId ? { ...l, qty: l.qty + 1 } : l,
      ),
    })),
  /** Quantity never drops below 1; use `remove` to delete the line. */
  decrement: (productId) =>
    set((s) => ({
      lines: s.lines.map((l) =>
        l.productId === productId && l.qty > 1 ? { ...l, qty: l.qty - 1 } : l,
      ),
    })),
  remove: (productId) =>
    set((s) => ({ lines: s.lines.filter((l) => l.productId !== productId) })),
  clear: () => set({ lines: [] }),
}));

export const selectLines = (s: CartState) => s.lines;
export const selectCount = (s: CartState) =>
  s.lines.reduce((n, l) => n + l.qty, 0);
export const selectTotal = (s: CartState) =>
  s.lines.reduce((sum, l) => sum + l.price * l.qty, 0);
