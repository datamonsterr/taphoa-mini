import type { QueryClient } from '@tanstack/react-query';

import { createSale } from '@/lib/api/ledger';
import { keys } from '@/lib/api/keys';
import type { CreateSaleRequest } from '@/lib/api/types';
import { decrementLocalStock } from '@/lib/offline/localStock';

import { enqueue, pendingItems, registerOutboxHandler } from './outbox';

export const SALE_KIND = 'sale';

let client: QueryClient | null = null;

/** The query client the sale handler refreshes after a replay (set by the app shell and by `enqueueSale`). */
export const bindOutboxClient = (qc: QueryClient) => {
  client = qc;
};

/** A sale changes reports, stock, debts and alerts; a failed one also undoes the local stock. */
const refresh = () => {
  const qc = client;
  if (!qc) return;
  for (const queryKey of [
    keys.sales.all(),
    keys.customers.all(),
    keys.debtEntries.all(),
    keys.debtSummary(),
    keys.stock.all(),
    [...keys.all, 'stock-movements'],
    keys.manualLines.all(),
    keys.reports.all(),
    keys.products.all(),
    keys.alerts.all(),
  ])
    void qc.invalidateQueries({ queryKey });
};

registerOutboxHandler(SALE_KIND, {
  // The sale id is the idempotency key: `createSale` sends it as `Idempotency-Key`.
  send: (payload) => createSale(payload as CreateSaleRequest),
  onSent: refresh,
  onFailed: refresh,
});

/** Records a cash, transfer or credit sale on the device and sends it as soon as the server is reachable. */
export async function enqueueSale(qc: QueryClient, body: CreateSaleRequest) {
  bindOutboxClient(qc);
  const recorded = pendingItems().some((item) => item.key === body.id);
  const item = await enqueue({ kind: SALE_KIND, payload: body, key: body.id });
  if (!recorded) decrementLocalStock(qc, body);
  return item;
}

/** Re-applies the local stock decrement of every unsent sale to the given products. */
export function reapplyPendingSales(
  qc: QueryClient,
  only: ReadonlySet<string>,
) {
  for (const item of pendingItems(SALE_KIND))
    decrementLocalStock(qc, item.payload as CreateSaleRequest, only);
}
