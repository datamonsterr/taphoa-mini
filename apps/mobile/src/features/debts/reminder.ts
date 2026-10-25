import type { Customer, Store } from '@/lib/api/types';
import { formatVnd } from '@/lib/format';

import { vietQrMemo } from '../pay/vietqr';

/** The note the customer types with the transfer: "TRA NO" plus the name, as VietQR allows. */
const transferNote = (name: string) =>
  vietQrMemo(`TRA NO ${name}`.toUpperCase()).trim();

/**
 * The Vietnamese payment reminder the shopkeeper sends through the system share sheet. It names
 * the customer, the store and the balance, and adds the store's bank account with a transfer
 * note when it has one. Returns `null` when the customer owes nothing: there is nothing to chase.
 */
export function buildReminderText(
  customer: Pick<Customer, 'name' | 'balance'>,
  store: Pick<Store, 'name' | 'bank_account'>,
): string | null {
  if (customer.balance <= 0) return null;
  const bank = store.bank_account;
  return [
    `Chào ${customer.name}, ${store.name} xin nhắc khoản nợ còn lại của bạn là ${formatVnd(customer.balance)}.`,
    ...(bank
      ? [
          `Bạn có thể chuyển khoản: ${bank.bank_short_name ?? bank.bank_bin} - ${bank.account_number} - ${bank.account_name}`,
          `Nội dung chuyển khoản: ${transferNote(customer.name)}`,
        ]
      : []),
    'Cảm ơn bạn!',
  ].join('\n');
}
