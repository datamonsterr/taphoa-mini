import type { ReactNode } from 'react';
import {
  Modal,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeft } from 'lucide-react-native';
import { CircleButton, PressableScale, Text } from '@/components/ui';
import { colors, fontFamily, radius, space, typography } from '@/theme';

export function Action({
  label,
  onPress,
  disabled = false,
  danger = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.action,
        danger && styles.danger,
        disabled && { opacity: 0.45 },
      ]}
    >
      <Text style={styles.actionText}>{label}</Text>
    </PressableScale>
  );
}
export function Field({ label, ...props }: TextInputProps & { label: string }) {
  return (
    <View style={{ gap: space[2] }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        {...props}
        accessibilityLabel={label}
        style={[styles.input, props.style]}
      />
    </View>
  );
}
/** Round back button plus title, like the debt and product screens. */
export function Header({
  title,
  backLabel,
  onBack,
}: {
  title: string;
  backLabel: string;
  onBack: () => void;
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
      <CircleButton
        icon={ChevronLeft}
        accessibilityLabel={backLabel}
        onPress={onBack}
      />
      <Text accessibilityRole="header" style={[styles.heading, { flex: 1 }]}>
        {title}
      </Text>
    </View>
  );
}
export function Page({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      style={styles.page}
      contentContainerStyle={{
        padding: space[4],
        paddingTop: insets.top + space[4],
        paddingBottom: insets.bottom + space[8],
        gap: space[4],
      }}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
}
export const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.surface },
  heading: { ...typography.heading, color: colors.ink },
  label: { ...typography.label, color: colors.ink },
  body: { ...typography.body, color: colors.inkMuted },
  error: { ...typography.body, color: colors.danger },
  action: {
    minHeight: 56,
    borderRadius: radius.full,
    padding: space[4],
    backgroundColor: colors.ink,
    justifyContent: 'center',
    alignItems: 'center',
  },
  danger: { backgroundColor: colors.danger },
  actionText: { ...typography.label, color: colors.onInk },
  input: {
    minHeight: 56,
    padding: space[4],
    borderWidth: 1,
    borderColor: colors.surfacePressed,
    borderRadius: radius.md,
    ...typography.body,
    color: colors.ink,
  },
  card: {
    padding: space[4],
    gap: space[2],
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSoft,
  },
});

export function ConfirmDialog({
  children,
  onClose,
}: {
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <View
        style={{
          flex: 1,
          backgroundColor: colors.scrim,
          justifyContent: 'center',
          padding: space[4],
        }}
      >
        <View accessibilityViewIsModal style={styles.card}>
          {children}
        </View>
      </View>
    </Modal>
  );
}

/** Pill link "‹ Đơn gần đây" at the top of a sales screen (boards SaleDetail and RecentSales). */
export function BackPill({
  label,
  text = label,
  onPress,
}: {
  /** Accessible name. */
  label: string;
  /** Visible words when shorter than the name. */
  text?: string;
  onPress: () => void;
}) {
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={pillStyles.back}
    >
      <ChevronLeft size={22} strokeWidth={2.25} color={colors.ink} />
      <Text style={styles.label}>{text}</Text>
    </PressableScale>
  );
}

/** Rounded status chip in the app font ("Đã thanh toán", "Đã hủy"). */
export function StatusPill({
  label,
  voided = false,
  testID,
}: {
  label: string;
  voided?: boolean;
  testID?: string;
}) {
  return (
    <View
      style={[
        pillStyles.status,
        voided && { backgroundColor: colors.dangerSoft },
      ]}
    >
      <Text
        testID={testID}
        style={[pillStyles.statusText, voided && { color: colors.danger }]}
      >
        {label}
      </Text>
    </View>
  );
}

const pillStyles = StyleSheet.create({
  back: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: space[1],
    minHeight: 56,
    paddingHorizontal: space[4],
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSoft,
  },
  status: {
    alignSelf: 'flex-start',
    paddingHorizontal: space[4],
    paddingVertical: space[2],
    borderRadius: radius.full,
    backgroundColor: colors.surfaceSoft,
  },
  statusText: {
    ...typography.label,
    fontFamily: fontFamily.semibold,
    color: colors.ink,
  },
});

const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
const two = (n: number) => String(n).padStart(2, '0');

/** "27/10 · 10:35" in Asia/Ho_Chi_Minh, the format of the boards (no browser locale involved). */
export function saleStamp(soldAt: string): string {
  const d = new Date(new Date(soldAt).getTime() + VN_OFFSET_MS);
  return `${two(d.getUTCDate())}/${two(d.getUTCMonth() + 1)} · ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}
