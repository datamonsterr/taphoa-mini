import { useSettingsStore, type Language } from '@/stores/settings';

type Texts = Record<
  | 'invalid'
  | 'session'
  | 'forbidden'
  | 'notFound'
  | 'conflict'
  | 'tooLarge'
  | 'unsupported'
  | 'rateLimit'
  | 'rateLimitWait'
  | 'server'
  | 'generic'
  | 'network',
  string
>;

const texts: Record<Language, Texts> = {
  vi: {
    invalid: 'Thông tin chưa hợp lệ. Kiểm tra lại rồi thử lại.',
    session: 'Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.',
    forbidden: 'Bạn không có quyền làm việc này.',
    notFound: 'Không tìm thấy dữ liệu này. Có thể nó đã bị xóa.',
    conflict: 'Dữ liệu đã thay đổi. Hãy tải lại rồi thử lại.',
    tooLarge: 'Ảnh quá lớn. Chụp lại ở độ phân giải thấp hơn.',
    unsupported: 'Định dạng ảnh không hỗ trợ. Dùng ảnh JPEG, PNG hoặc WebP.',
    rateLimit: 'Bạn thao tác quá nhanh. Đợi một lát rồi thử lại.',
    rateLimitWait: 'Bạn thao tác quá nhanh. Thử lại sau {n} giây.',
    server: 'Máy chủ đang lỗi. Thử lại sau ít phút.',
    generic: 'Có lỗi xảy ra. Thử lại.',
    network: 'Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.',
  },
  en: {
    invalid: 'Some details are not valid. Check them and try again.',
    session: 'Your session expired. Please log in again.',
    forbidden: 'You are not allowed to do this.',
    notFound: 'This item was not found. It may have been deleted.',
    conflict: 'The data changed. Reload and try again.',
    tooLarge: 'The photo is too large. Retake it at a lower resolution.',
    unsupported: 'Photo format not supported. Use a JPEG, PNG or WebP photo.',
    rateLimit: 'Too fast. Wait a moment and try again.',
    rateLimitWait: 'Too fast. Try again in {n} seconds.',
    server: 'The server is having trouble. Try again in a few minutes.',
    generic: 'Something went wrong. Try again.',
    network: 'Cannot reach the server. Check the network and try again.',
  },
};

/** Vietnamese (or English) sentence for an HTTP failure; never the server's own text. */
export function statusErrorText(
  status: number,
  retryAfterMs?: number,
  language: Language = useSettingsStore.getState().language,
): string {
  const t = texts[language] ?? texts.vi;
  switch (status) {
    case 400:
    case 422:
      return t.invalid;
    case 401:
      return t.session;
    case 403:
      return t.forbidden;
    case 404:
    case 410:
      return t.notFound;
    case 409:
      return t.conflict;
    case 413:
      return t.tooLarge;
    case 415:
      return t.unsupported;
    case 429:
      return retryAfterMs && retryAfterMs > 0
        ? t.rateLimitWait.replace('{n}', String(Math.ceil(retryAfterMs / 1000)))
        : t.rateLimit;
    default:
      return status >= 500 ? t.server : t.generic;
  }
}

/** Sentence for a request that never reached the server. */
export const networkErrorText = (
  language: Language = useSettingsStore.getState().language,
): string => (texts[language] ?? texts.vi).network;
