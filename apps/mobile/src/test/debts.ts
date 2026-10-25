import { createCustomer } from '@/lib/api/debts';
import { createSale } from '@/lib/api/ledger';
import type { Customer, Sale } from '@/lib/api/types';
import { newUuid } from '@/lib/uuid';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A sale on credit for `amount`, sold `ageDays` ago (default today). */
export function creditSale(
  customerId: string,
  amount: number,
  ageDays = 0,
): Promise<Sale> {
  return createSale({
    id: newUuid(),
    sold_at: new Date(Date.now() - ageDays * DAY_MS).toISOString(),
    payment_method: 'credit',
    total: amount,
    credit: { customer_id: customerId, amount },
    lines: [
      {
        id: newUuid(),
        product_id: null,
        source: 'manual',
        manual_label: 'Hàng ghi nợ',
        quantity: 1,
        unit_price: amount,
      },
    ],
  });
}

export type SeedCustomer = {
  name: string;
  phone?: string;
  credit_limit?: number;
  note?: string;
  /** Becomes one credit sale of this size. */
  owes?: number;
  /** How many days ago that credit sale happened (default today). */
  ageDays?: number;
};

/** A customer in the in-memory API, optionally owing money from `ageDays` ago. */
export async function seedCustomer({
  owes = 0,
  ageDays = 0,
  ...fields
}: SeedCustomer): Promise<Customer> {
  const customer = await createCustomer({ id: newUuid(), ...fields });
  if (owes > 0) await creditSale(customer.id, owes, ageDays);
  return customer;
}
