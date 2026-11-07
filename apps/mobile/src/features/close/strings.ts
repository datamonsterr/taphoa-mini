import type { Dict } from '@/lib/i18n';

export const closeStrings: Dict = {
  vi: {
    screen: 'Chốt sổ',
    close: 'Đóng',
    expected: 'Tiền mặt dự kiến',
    counted: 'Tiền đếm được',
    cashRepayments: 'Thu nợ tiền mặt',
    creditSales: 'Bán ghi nợ',
    save: 'Chốt sổ hôm nay',
    closed: 'Đã chốt sổ',
    resave: 'Chốt sổ lại',
    lateNotice:
      'Có {n} giao dịch phát sinh sau khi chốt sổ. Đếm lại tiền và chốt sổ lại.',
    dateError:
      'Ngày trên điện thoại không khớp với ngày của cửa hàng. Kiểm tra ngày giờ của máy rồi thử lại.',
    error: 'Không tải được số liệu',
    forbidden: 'Chỉ chủ tiệm mới xem và chốt sổ được.',
    saveError: 'Không chốt được sổ. Thử lại.',
    offlineError:
      'Không có mạng nên chưa chốt được sổ. Tiền đếm được vẫn còn, thử lại khi có mạng.',
    'diff.match': 'Khớp',
    'diff.short': 'Thiếu',
    'diff.extra': 'Dư',
    'keypad.delete': 'Xóa',
    retry: 'Thử lại',
    loading: 'Đang tải',
  },
  en: {
    screen: 'Close the day',
    close: 'Close',
    expected: 'Expected cash',
    counted: 'Cash counted',
    cashRepayments: 'Cash debt collected',
    creditSales: 'Credit sales',
    save: 'Close today',
    closed: 'Day closed',
    resave: 'Close the day again',
    lateNotice:
      '{n} transactions arrived after the close. Count the cash again and close again.',
    dateError:
      "The phone's date does not match the store's date. Check the phone's date and time, then try again.",
    error: 'Could not load the figures',
    forbidden: 'Only the store owner can view and close the day.',
    saveError: 'Could not close the day. Try again.',
    offlineError:
      'No network, so the day was not closed. The counted cash is kept; try again when you are online.',
    'diff.match': 'Matches',
    'diff.short': 'Short',
    'diff.extra': 'Over',
    'keypad.delete': 'Delete',
    retry: 'Retry',
    loading: 'Loading',
  },
};
