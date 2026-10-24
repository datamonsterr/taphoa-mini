import type { Dict } from '@/lib/i18n';

export const strings: Dict = {
  vi: {
    back: 'Quay lại',
    edit: 'Sửa giá',
    save: 'Lưu giá',
    unnamed: 'Sản phẩm chưa đặt tên',
    cost: 'Giá nhập',
    photo: 'Ảnh {i} trên {n}',
    notFound: 'Không tìm thấy sản phẩm',
    error: 'Không tải được sản phẩm',
    retry: 'Thử lại',
    'keypad.delete': 'Xóa',
    saveError: 'Không lưu được giá. Đã khôi phục giá cũ.',
    unitLine: '1 {unit} = {quantity} {base}, {price}',
  },
  en: {
    back: 'Back',
    edit: 'Edit price',
    save: 'Save price',
    unnamed: 'Unnamed product',
    cost: 'Cost price',
    photo: 'Photo {i} of {n}',
    notFound: 'Product not found',
    error: 'Could not load the product',
    retry: 'Try again',
    'keypad.delete': 'Delete',
    saveError: 'Could not save the price. The old price is back.',
    unitLine: '1 {unit} = {quantity} {base}, {price}',
  },
};

/** Fills `{name}` placeholders. */
export const fill = (
  template: string,
  values: Record<string, string | number>,
): string =>
  template.replace(/\{(\w+)\}/g, (_match, name: string) =>
    String(values[name] ?? ''),
  );
