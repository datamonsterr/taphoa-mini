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
import { colors, radius, space, typography } from '@/theme';

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
