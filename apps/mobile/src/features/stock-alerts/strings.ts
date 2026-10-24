import type { Dict } from '@/lib/i18n';

export const stockAlertStrings: Dict = {
  vi: {
    single: 'Sắp hết hàng: {name} ({quantity} còn lại)',
    multiple: '{count} sản phẩm sắp hết hàng',
    unnamed: 'Sản phẩm chưa đặt tên',
    dismiss: 'Đóng cảnh báo tồn kho',
    openStock: 'Xem tồn kho',
  },
  en: {
    single: 'Low stock: {name} ({quantity} remaining)',
    multiple: '{count} products low on stock',
    unnamed: 'Unnamed product',
    dismiss: 'Dismiss stock alert',
    openStock: 'View stock',
  },
};
