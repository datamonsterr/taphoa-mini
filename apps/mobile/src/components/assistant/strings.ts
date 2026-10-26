import type { Dict } from '@/lib/i18n';

/** Texts of the assistant entry points: chat button and next-step strip. */
export const strings: Dict = {
  vi: {
    open: 'Mở trợ lý',
    strip: 'Gợi ý bước tiếp theo',
    'kind.receipt_detected': 'Hóa đơn nhập hàng',
    'sub.receipt_detected': 'Trợ lý đọc từng dòng',
    'kind.unknown_product': 'Hàng chưa có trong kho',
    'sub.unknown_product': 'Thêm vào kho',
  },
  en: {
    open: 'Open assistant',
    strip: 'Suggested next steps',
    'kind.receipt_detected': 'Supplier receipt',
    'sub.receipt_detected': 'The assistant reads each line',
    'kind.unknown_product': 'Product not in stock',
    'sub.unknown_product': 'Add it to your stock',
    'kind.restock': 'Restock',
    'kind.draft_receipts': 'Draft receipts',
    'kind.overdue_debts': 'Overdue debts',
    'kind.day_close': 'Close the day',
    'kind.review_queue': 'Review queue',
    'kind.digest': 'Daily digest',
    'kind.setup': 'Finish setup',
    'kind.margin_alert': 'Margin alert',
  },
};
