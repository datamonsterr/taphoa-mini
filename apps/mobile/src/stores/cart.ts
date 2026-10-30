import { create } from 'zustand';

export type CartLine = {
  productId: string;
  unitId?: string;
  unitName?: string;
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
  /** How the line entered the cart (S1 `camera`, S8 `multi_photo`, S2 `barcode`, S3 `grid`, `voice`); sent as the sale line `source`. */
  source?: 'camera' | 'multi_photo' | 'barcode' | 'grid' | 'voice';
};

export type NewCartLine = Omit<CartLine, 'qty' | 'manual'> & {
  manual?: boolean;
};

export const cartLineKey = (line: Pick<CartLine, 'productId' | 'unitId'>) =>
  `${line.productId}:${line.unitId ?? 'base'}`;

type CartState = {
  lines: CartLine[];
  add: (line: NewCartLine) => void;
  increment: (productId: string) => void;
  decrement: (productId: string) => void;
  remove: (productId: string) => void;
  setUnit: (
    key: string,
    unit: { id?: string; name: string; price: number },
  ) => void;
  clear: () => void;
  /** Merges lines at their own quantity and price (a voice draft handed to the pay screen). */
  addMany: (lines: (NewCartLine & { qty: number })[]) => void;
};

export const useCartStore = create<CartState>()((set) => ({
  lines: [],
  add: (line) =>
    set((s) => {
      const exists = s.lines.some((l) => cartLineKey(l) === cartLineKey(line));
      if (exists) {
        const { detectionId, suggestedProductId, scanId } = line;
        return {
          lines: s.lines.map((l) =>
            cartLineKey(l) === cartLineKey(line)
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
        cartLineKey(l) === productId || (!l.unitId && l.productId === productId)
          ? { ...l, qty: l.qty + 1 }
          : l,
      ),
    })),
  /** Quantity never drops below 1; use `remove` to delete the line. */
  decrement: (productId) =>
    set((s) => ({
      lines: s.lines.map((l) =>
        (cartLineKey(l) === productId ||
          (!l.unitId && l.productId === productId)) &&
        l.qty > 1
          ? { ...l, qty: l.qty - 1 }
          : l,
      ),
    })),
  remove: (productId) =>
    set((s) => ({
      lines: s.lines.filter(
        (l) =>
          !(
            cartLineKey(l) === productId ||
            (!l.unitId && l.productId === productId)
          ),
      ),
    })),
  setUnit: (key, unit) =>
    set((s) => {
      const line = s.lines.find((l) => cartLineKey(l) === key);
      if (!line) return s;
      const changed = {
        ...line,
        unitId: unit.id,
        unitName: unit.name,
        price: unit.price,
      };
      const existing = s.lines.find(
        (l) =>
          cartLineKey(l) !== key && cartLineKey(l) === cartLineKey(changed),
      );
      return {
        lines: existing
          ? s.lines
              .filter((l) => cartLineKey(l) !== key)
              .map((l) =>
                l === existing ? { ...l, qty: l.qty + line.qty } : l,
              )
          : s.lines.map((l) => (l === line ? changed : l)),
      };
    }),
  clear: () => set({ lines: [] }),
  addMany: (added) =>
    set((s) => {
      const lines = [...s.lines];
      for (const line of added) {
        const index = lines.findIndex((l) => l.productId === line.productId);
        const current = lines[index];
        if (current) lines[index] = { ...current, qty: current.qty + line.qty };
        else lines.push({ ...line, manual: line.manual ?? false });
      }
      return { lines };
    }),
}));

export const selectLines = (s: CartState) => s.lines;
export const selectCount = (s: CartState) =>
  s.lines.reduce((n, l) => n + l.qty, 0);
export const selectTotal = (s: CartState) =>
  s.lines.reduce((sum, l) => sum + l.price * l.qty, 0);
