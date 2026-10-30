import { colors } from '@/theme';

/** Negative balance: the store holds the customer money, shown as Trả dư, never a bare minus. */
export const balanceColor = (balance: number) =>
  balance < 0 ? colors.success : balance === 0 ? colors.inkMuted : colors.ink;

const AVATAR_TONES = [
  { background: colors.accentSoft, color: colors.accent },
  { background: colors.successSoft, color: colors.success },
  { background: colors.warningSoft, color: colors.warning },
  { background: colors.surfaceSoft, color: colors.ink },
] as const;

/** Stable tone per customer so a row keeps its colour between visits. */
export const avatarTone = (id: string) => {
  let sum = 0;
  for (const char of id) sum += char.charCodeAt(0);
  return AVATAR_TONES[sum % AVATAR_TONES.length]!;
};

export const initialOf = (name: string) =>
  (Array.from(name.trim())[0] ?? '?').toUpperCase();
