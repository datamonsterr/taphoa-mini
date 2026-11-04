import type { Dict } from '@/lib/i18n';

/** Words of the pay screen that follow the app language. */
export const payStrings: Dict = {
  vi: {
    title: 'Thanh toán',
    'credit.confirm': 'Ghi nợ {amount}',
    'credit.currentDebt': 'Đang nợ {amount}',
    'credit.change': 'Đổi',
    'credit.newDebt': 'Nợ mới của khách {amount}',
    'credit.other': 'Khác',
    'credit.applyPaid': 'Xong',
    'toggle.group': 'Cách trả',
    'toggle.transfer': 'Chuyển khoản',
    'toggle.cash': 'Tiền mặt',
    'toggle.credit': 'Ghi nợ',
  },
  en: {
    title: 'Payment',
    'credit.confirm': 'Credit {amount}',
    'credit.currentDebt': 'Currently owes {amount}',
    'credit.change': 'Change',
    'credit.newDebt': 'Customer’s new balance {amount}',
    'credit.other': 'Other',
    'credit.applyPaid': 'Done',
    'toggle.group': 'Payment method',
    'toggle.transfer': 'Bank transfer',
    'toggle.cash': 'Cash',
    'toggle.credit': 'Credit',
  },
};
