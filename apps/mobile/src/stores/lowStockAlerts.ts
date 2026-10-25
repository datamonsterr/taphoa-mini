import { create } from 'zustand';

export type LowStockAlert = {
  product_id: string;
  name: string | null;
  stock_quantity: number;
  threshold: number;
  at: string;
};

type LowStockAlerts = {
  alerts: LowStockAlert[];
  /** Retained when the banner is dismissed; only recovery re-arms a product. */
  seenProductIds: string[];
  push: (alert: LowStockAlert) => void;
  dismiss: (id: string) => void;
  clear: () => void;
  reset: () => void;
  reconcile: (alerts: LowStockAlert[], complete: boolean) => void;
};

export const useLowStockAlerts = create<LowStockAlerts>((set) => ({
  alerts: [],
  seenProductIds: [],
  push: (alert) =>
    set((state) => ({
      seenProductIds: [...new Set([...state.seenProductIds, alert.product_id])],
      alerts: [
        alert,
        ...state.alerts.filter((a) => a.product_id !== alert.product_id),
      ],
    })),
  dismiss: (id) =>
    set((state) => ({
      alerts: state.alerts.filter((a) => a.product_id !== id),
    })),
  clear: () => set({ alerts: [] }),
  reset: () => set({ alerts: [], seenProductIds: [] }),
  reconcile: (incoming, complete) =>
    set((state) => {
      const current = new Map(incoming.map((a) => [a.product_id, a]));
      const seen = new Set(state.seenProductIds);
      return {
        seenProductIds: complete
          ? [...current.keys()]
          : [...new Set([...seen, ...current.keys()])],
        alerts: [
          ...incoming.filter((a) => !seen.has(a.product_id)),
          ...state.alerts.flatMap((a) => {
            const updated = current.get(a.product_id);
            return updated ? [{ ...updated, at: a.at }] : complete ? [] : [a];
          }),
        ],
      };
    }),
}));
