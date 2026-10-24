import { useRouter } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CircleButton, PressableScale, ScaledText } from '@/components/ui';
import { useT } from '@/lib/i18n';
import {
  colors,
  fontFamily,
  radius,
  scaleText,
  space,
  useFontScale,
} from '@/theme';

import { strings } from './strings';

type FrameProps = {
  title: string;
  subtitle?: string;
  /** Shows the back arrow. The welcome screen has nowhere to go back to. */
  back?: boolean;
  children: ReactNode;
};

/** Page shell shared by every onboarding screen: scrolls, avoids the keyboard, honours insets. */
export function Frame({ title, subtitle, back = true, children }: FrameProps) {
  const t = useT(strings);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.screen}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[
          styles.content,
          {
            paddingTop: space[4] + insets.top,
            paddingBottom: space[6] + insets.bottom,
          },
        ]}
      >
        {back ? (
          <View style={styles.backRow}>
            <CircleButton
              icon={ChevronLeft}
              accessibilityLabel={t('back')}
              onPress={() => router.back()}
            />
          </View>
        ) : null}
        <ScaledText variant="title" accessibilityRole="header">
          {title}
        </ScaledText>
        {subtitle ? (
          <ScaledText variant="body" style={styles.muted}>
            {subtitle}
          </ScaledText>
        ) : null}
        {children}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

type FieldProps = {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  error?: string;
  maxLength?: number;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  onSubmitEditing?: () => void;
};

/** Labelled text input; the label doubles as the accessible name (`getByLabel`, Playwright role+name). */
export function Field({
  label,
  value,
  onChangeText,
  error,
  maxLength,
  autoCapitalize = 'sentences',
  onSubmitEditing,
}: FieldProps) {
  const scale = useFontScale();
  return (
    <View style={styles.field}>
      <ScaledText variant="caption" style={styles.muted}>
        {label}
      </ScaledText>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        maxLength={maxLength}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        onSubmitEditing={onSubmitEditing}
        returnKeyType="done"
        style={[
          styles.input,
          scaleText({ fontSize: 18 }, scale),
          error ? styles.invalid : null,
        ]}
        placeholderTextColor={colors.inkMuted}
      />
      {error ? (
        <ScaledText
          variant="caption"
          accessibilityRole="alert"
          style={styles.error}
        >
          {error}
        </ScaledText>
      ) : null}
    </View>
  );
}

type ButtonProps = {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  variant?: 'primary' | 'secondary';
};

/** Full-width pill. `busy` swaps the label for a spinner but keeps the accessible name. */
export function ActionButton({
  label,
  onPress,
  disabled = false,
  busy = false,
  variant = 'primary',
}: ButtonProps) {
  const primary = variant === 'primary';
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || busy, busy }}
      disabled={disabled || busy}
      pressedScale={0.97}
      onPress={onPress}
      style={[
        styles.button,
        primary ? styles.buttonPrimary : styles.buttonSecondary,
        (disabled || busy) && styles.disabled,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={primary ? colors.onInk : colors.ink} />
      ) : (
        <ScaledText
          variant="label"
          style={primary ? styles.primaryText : styles.secondaryText}
        >
          {label}
        </ScaledText>
      )}
    </PressableScale>
  );
}

/** Inline error under a form, announced to screen readers. */
export function FormError({ message }: { message: string | null }) {
  return message ? (
    <ScaledText variant="body" accessibilityRole="alert" style={styles.error}>
      {message}
    </ScaledText>
  ) : null;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.surface },
  content: { paddingHorizontal: space[4], gap: space[4] },
  backRow: { alignItems: 'flex-start' },
  muted: { color: colors.inkMuted },
  field: { gap: space[1] },
  input: {
    minHeight: 56,
    paddingHorizontal: space[4],
    borderRadius: radius.md,
    backgroundColor: colors.surfaceSoft,
    color: colors.ink,
    fontFamily: fontFamily.semibold,
  },
  invalid: { borderWidth: 2, borderColor: colors.danger },
  error: { color: colors.danger },
  button: {
    minHeight: 64,
    paddingHorizontal: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
  },
  buttonPrimary: { backgroundColor: colors.ink },
  buttonSecondary: { backgroundColor: colors.surfaceSoft },
  primaryText: { color: colors.onInk },
  secondaryText: { color: colors.ink },
  disabled: { opacity: 0.5 },
});
