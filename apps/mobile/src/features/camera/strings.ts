import type { Dict } from '@/lib/i18n';

/** Camera screen texts. Icon-only controls keep the board's `aria-label`s inside their components. */
export const strings: Dict = {
  vi: {
    unnamed: 'Sản phẩm',
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
