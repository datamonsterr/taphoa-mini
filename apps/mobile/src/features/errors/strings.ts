import type { Dict } from '@/lib/i18n';

export const routeErrorStrings: Dict = {
  vi: {
    loadTitle: 'Không tải được màn hình',
    loadMessage: 'Không tải được màn hình. Kiểm tra mạng rồi thử lại.',
    crashTitle: 'Màn hình gặp lỗi',
    crashMessage: 'Màn hình này gặp lỗi. Thử lại, hoặc mở lại ứng dụng.',
    retry: 'Thử lại',
  },
  en: {
    loadTitle: 'Could not load the screen',
    loadMessage: 'Could not load the screen. Check your network and try again.',
    crashTitle: 'This screen hit an error',
    crashMessage: 'This screen hit an error. Try again, or reopen the app.',
    retry: 'Try again',
  },
};
