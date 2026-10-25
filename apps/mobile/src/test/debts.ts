import { createCustomer } from '@/lib/api/debts';
import { createSale } from '@/lib/api/ledger';
import type { Customer } from '@/lib/api/types';
import { newUuid } from '@/lib/uuid';

const DAY_MS = 24 * 60 * 60 * 1000;

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
  if (owes > 0) {
    await createSale({
      id: newUuid(),
      sold_at: new Date(Date.now() - ageDays * DAY_MS).toISOString(),
      payment_method: 'credit',
      total: owes,
      credit: { customer_id: customer.id, amount: owes },
      lines: [
        {
          id: newUuid(),
          product_id: null,
          source: 'manual',
          manual_label: 'Hàng ghi nợ',
          quantity: 1,
          unit_price: owes,
        },
      ],
    });
  }
  return customer;
}
