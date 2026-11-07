import type { Dict } from '@/lib/i18n';

export const syncStrings: Dict = {
  vi: {
    offline: 'Không có mạng. Bán bằng Kho: giá và đơn vẫn lưu được.',
    openGrid: 'Mở Kho để bán',
    pending: '{n} đơn chờ gửi khi có mạng',
    serverDown: 'Máy chủ đang lỗi. {n} đơn sẽ tự gửi lại sau.',
    failed: 'Có {n} đơn không gửi được',
    failedDetail: 'Đơn {code}: {message}',
    discard: 'Bỏ đơn này',
    retry: 'Gửi lại',
  },
  en: {
    offline:
      'No network. Sell from the grid: prices and sales are still saved.',
    openGrid: 'Open the grid to sell',
    pending: '{n} sales waiting to send',
    serverDown: 'The server is having trouble. {n} sales will be sent again.',
    failed: '{n} sales could not be sent',
    failedDetail: 'Sale {code}: {message}',
    discard: 'Discard this sale',
    retry: 'Send again',
  },
};
