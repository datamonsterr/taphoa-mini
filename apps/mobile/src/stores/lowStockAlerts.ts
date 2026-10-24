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
  push: (alert: LowStockAlert) => void;
  dismiss: (id: string) => void;
};

export const useLowStockAlerts = create<LowStockAlerts>((set) => ({
  alerts: [],
  push: (alert) =>
    set((state) => ({
      alerts: [
        alert,
        ...state.alerts.filter((a) => a.product_id !== alert.product_id),
      ],
    })),
  dismiss: (id) =>
    set((state) => ({
      alerts: state.alerts.filter((a) => a.product_id !== id),
    })),
}));
