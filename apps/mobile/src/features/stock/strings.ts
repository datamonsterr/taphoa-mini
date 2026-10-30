import type { Dict } from '@/lib/i18n';

export const strings: Dict = {
  vi: {
    stock: 'Tồn kho',
    products: 'Sản phẩm',
    all: 'Tất cả',
    low: 'Sắp hết',
    out: 'Hết hàng',
    ok: 'Còn hàng',
    threshold: 'Ngưỡng {n}',
    summary: '{count} món sắp hết hoặc hết',
    restock: 'Nhập hàng',
    restockPrompt: 'Tôi nên nhập thêm hàng gì?',
    empty: 'Chưa có sản phẩm theo dõi tồn kho',
    error: 'Không tải được tồn kho',
    offline:
      'Không tải được tồn kho. Không có mạng, danh sách sẽ tải khi có mạng.',
    retry: 'Thử lại',
    loading: 'Đang tải',
    unnamed: 'Sản phẩm chưa đặt tên',
    back: 'Quay lại',
  },
  en: {
    stock: 'Stock',
    products: 'Products',
    all: 'All',
    low: 'Low stock',
    out: 'Out of stock',
    ok: 'In stock',
    threshold: 'Threshold {n}',
    summary: '{count} items low or out',
    restock: 'Restock',
    restockPrompt: 'What should I restock?',
    empty: 'No tracked products yet',
    error: 'Could not load stock',
    offline:
      'Could not load stock. No network; the list loads when it returns.',
    retry: 'Try again',
    loading: 'Loading',
    unnamed: 'Unnamed product',
    back: 'Back',
  },
};
