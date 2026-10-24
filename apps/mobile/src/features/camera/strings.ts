import type { Dict } from '@/lib/i18n';

/** Camera screen texts. Icon-only controls keep the board's `aria-label`s inside their components. */
export const strings: Dict = {
  vi: {
    unnamed: 'Sản phẩm',
    readReceipt: 'Đọc hóa đơn nhập',
    readingReceipt: 'Đang đọc hóa đơn…',
    receiptNoText: 'Không đọc được chữ trên hóa đơn',
    receiptPermission: 'Bạn không có quyền nhập hóa đơn',
    receiptRetry: 'Chưa đọc được hóa đơn. Thử lại.',
    permissionTitle: 'Cho phép máy ảnh để quét hàng',
    permissionAsk: 'Cho phép máy ảnh',
    permissionSettings: 'Mở cài đặt',
    scanning: 'Đang nhận diện',
    scanError: 'Chưa nhận diện được',
    retry: 'Thử lại',
    backToCamera: 'Quay lại máy ảnh',
    shutter: 'Chụp',
    reshoot: 'Chụp lại',
  },
  en: {
    unnamed: 'Product',
    readReceipt: 'Read import receipt',
    readingReceipt: 'Reading receipt…',
    receiptNoText: 'Could not read text on the receipt',
    receiptPermission: 'You do not have permission to import receipts',
    receiptRetry: 'Could not read receipt. Try again.',
    permissionTitle: 'Allow the camera to scan goods',
    permissionAsk: 'Allow camera',
    permissionSettings: 'Open settings',
    scanning: 'Recognising',
    scanError: 'Could not recognise',
    retry: 'Try again',
    backToCamera: 'Back to camera',
    shutter: 'Shoot',
    reshoot: 'Shoot again',
  },
};
