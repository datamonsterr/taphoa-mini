import * as Haptics from 'expo-haptics';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';

import type { CreateSaleRequest, Customer } from '@/lib/api';
import { enqueueSale } from '@/lib/outbox';
import { newUuid } from '@/lib/uuid';
import { cartLineKey, useCartStore, type CartLine } from '@/stores/cart';
import type { PayMethod } from '@/components/ui';

export type SaleInput = {
  lines: CartLine[];
  total: number;
  method: PayMethod;
  customer: Customer | null;
  paidNow: number;
  cashGiven: number;
  memo: string;
};

/** Saves the sale to the device outbox on "Đã nhận". One id per screen, so a retry is idempotent. */
export function useSaleSubmit() {
  const qc = useQueryClient();
  const clearCart = useCartStore((s) => s.clear);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [done, setDone] = useState(false);
  const [saleId] = useState(newUuid);
  const lineIds = useRef(new Map<string, string>()).current;
  // The device time of the first "Đã nhận": a retry must resend it, or the server sees another body.
  const soldAt = useRef<string | null>(null);

  const submit = useCallback(
    ({
      lines,
      total,
      method,
      customer,
      paidNow,
      cashGiven,
      memo,
    }: SaleInput) => {
      if (lines.length === 0) return;
      const scanIds = [
        ...new Set(lines.flatMap((l) => (l.scanId ? [l.scanId] : []))),
      ];
      const body: CreateSaleRequest = {
        id: saleId,
        sold_at: (soldAt.current ??= new Date().toISOString()),
        payment_method:
          method === 'credit' ? (paidNow === 0 ? 'credit' : 'cash') : method,
        ...(method === 'credit' && customer && paidNow < total
          ? { credit: { customer_id: customer.id, amount: total - paidNow } }
          : {}),
        total,
        ...(method === 'credit'
          ? paidNow > 0
            ? { cash_received: paidNow }
            : {}
          : method === 'cash'
            ? { cash_received: cashGiven }
            : { vietqr_memo: memo }),
        lines: lines.map((line) => {
          let id = lineIds.get(cartLineKey(line));
          if (!id) {
            id = newUuid();
            lineIds.set(cartLineKey(line), id);
          }
          return {
            id,
            product_id: line.productId,
            ...(line.unitId ? { unit_id: line.unitId } : {}),
            source: line.manual ? 'manual' : (line.source ?? 'camera'),
            quantity: line.qty,
            unit_price: line.price,
            ...(line.manual ? { manual_label: line.name.slice(0, 80) } : {}),
            ...(line.detectionId ? { detection_id: line.detectionId } : {}),
            ...(line.suggestedProductId
              ? { suggested_product_id: line.suggestedProductId }
              : {}),
          };
        }),
        ...(scanIds.length > 0 ? { scan_ids: scanIds } : {}),
      };
      // Recorded on the device first: the sale is safe even with no network, and the outbox sends
      // it (idempotent on `saleId`) as soon as the server answers.
      setSaving(true);
      setSaveError(false);
      enqueueSale(qc, body).then(
        () => {
          void Haptics.notificationAsync(
            Haptics.NotificationFeedbackType.Success,
          );
          clearCart();
          setDone(true);
        },
        () => {
          setSaving(false);
          setSaveError(true);
        },
      );
    },
    [saleId, lineIds, qc, clearCart],
  );
  return { saleId, saving, saveError, done, submit };
}
