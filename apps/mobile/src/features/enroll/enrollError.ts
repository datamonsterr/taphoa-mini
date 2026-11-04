import { isApiError } from '@/lib/api';

export type EnrollFailure = 'forbidden' | 'tooLarge' | 'generic';

/** The save messages of the enroll form, one per cause the seller can act on. */
export const enrollFailureText: Record<EnrollFailure, string> = {
  forbidden: 'Bạn chưa có quyền thêm hàng. Nhờ chủ tiệm cấp quyền.',
  tooLarge: 'Ảnh quá lớn. Chụp lại ảnh khác rồi lưu.',
  generic: 'Không lưu được. Bạn đã nhập vẫn còn, thử lại.',
};

/**
 * Why a save failed: 403 means this seller may not enroll products, 413 means a photo is over
 * the upload limit (its body is plain text, so only the status is reliable).
 */
export function enrollFailure(error: unknown): EnrollFailure {
  if (isApiError(error)) {
    if (error.status === 403) return 'forbidden';
    if (error.status === 413) return 'tooLarge';
  }
  return 'generic';
}
