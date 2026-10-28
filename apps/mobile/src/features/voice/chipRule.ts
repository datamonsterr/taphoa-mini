const DAY_MS = 24 * 60 * 60 * 1000;
/** The chip teaches the feature: only for a member's first two weeks... */
export const VOICE_CHIP_DAYS = 14;
/** ...and until they have recorded three sales by voice. */
export const VOICE_CHIP_MAX_SALES = 3;

/** Rule of the `voice_sale` next-step chip. */
export function showVoiceSaleChip({
  joinedAt,
  voiceSales,
  now = Date.now(),
}: {
  joinedAt: string | undefined;
  voiceSales: number;
  now?: number;
}): boolean {
  if (!joinedAt || voiceSales >= VOICE_CHIP_MAX_SALES) return false;
  const joined = Date.parse(joinedAt);
  if (Number.isNaN(joined)) return false;
  return now - joined < VOICE_CHIP_DAYS * DAY_MS;
}
