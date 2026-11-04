import { isApiError, listProducts } from '@/lib/api';

/** Unique-index conflicts are distinct from the visual duplicate_suspected merge prompt. */
export async function barcodeConflict(error: unknown, barcode: string) {
  if (
    !barcode ||
    !isApiError(error) ||
    error.status !== 409 ||
    error.code === 'duplicate_suspected'
  )
    return null;
  try {
    const { items } = await listProducts({
      barcode,
      include_archived: true,
      limit: 1,
    });
    return items[0]
      ? `Mã vạch đã dùng cho ${items[0].name ?? 'hàng chưa đặt tên'}`
      : 'Mã vạch đã được dùng. Nhập mã khác.';
  } catch {
    return 'Mã vạch đã được dùng. Nhập mã khác.';
  }
}
