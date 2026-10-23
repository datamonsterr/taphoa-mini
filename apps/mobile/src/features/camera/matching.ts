import type { Detection as ApiDetection } from '@/lib/api/types';

/**
 * The server found nothing it trusts: `unknown` or no candidate. The server's `match` field is
 * the only verdict; `ambiguous` boxes are not low, but they are never picked for the seller.
 */
export function isLowMatch(detection: ApiDetection): boolean {
  return detection.match === 'unknown' || detection.candidates.length === 0;
}
