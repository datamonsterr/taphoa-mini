import { useRouter } from 'expo-router';
import { ChevronLeft, Focus, type LucideIcon } from 'lucide-react-native';
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  ScrollView,
  StyleSheet,
  TextInput,
  type TextInputProps,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  CircleButton,
  Icon,
  PressableScale,
  ScaledText,
} from '@/components/ui';
import { useT } from '@/lib/i18n';
import {
  colors,
  fontFamily,
  radius,
  scaleText,
  size,
  space,
  useFontScale,
} from '@/theme';

import { strings } from './strings';

type FrameProps = {
  testID?: string;
  title: string;
  subtitle?: string;
  /** Shows the back arrow. The welcome screen has nowhere to go back to. */
  back?: boolean;
  /** Board 24 header: round accent logo, centered title and subtitle. */
  brand?: boolean;
  /** Fills the screen height so a `Spacer` can pin the rest to the bottom. */
  fill?: boolean;
  children: ReactNode;
};

/** Takes the free height of a `fill` Frame (the boards' `flex: 1` spacer). */
export const Spacer = () => <View style={styles.spacer} />;

/** Page shell shared by every onboarding screen: scrolls, avoids the keyboard, honours insets. */
export function Frame({
  testID,
  title,
  subtitle,
  back = true,
  brand = false,
  fill = false,
  children,
}: FrameProps) {
  const t = useT(strings);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  return (
    <KeyboardAvoidingView
      testID={testID}
      behavior="padding"
      style={styles.screen}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[
          styles.content,
          fill && styles.contentFill,
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
        {brand ? (
          <View style={styles.brand}>
            <View style={styles.logo}>
              <Icon icon={Focus} size={40} color={colors.onAccent} />
            </View>
            <ScaledText
              variant="title"
              accessibilityRole="header"
              style={styles.centered}
            >
              {title}
            </ScaledText>
            {subtitle ? (
              <ScaledText
                variant="caption"
                style={[styles.muted, styles.centered]}
              >
                {subtitle}
              </ScaledText>
            ) : null}
          </View>
        ) : (
          <>
            <ScaledText variant="title" accessibilityRole="header">
              {title}
            </ScaledText>
            {subtitle ? (
              <ScaledText variant="body" style={styles.muted}>
                {subtitle}
              </ScaledText>
            ) : null}
          </>
        )}
        {children}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

type FieldProps = {
  keyboardType?: TextInputProps['keyboardType'];
  autoComplete?: TextInputProps['autoComplete'];
  testID?: string;
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
  keyboardType,
  autoComplete,
  testID,
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
        keyboardType={keyboardType}
        autoComplete={autoComplete}
        testID={testID}
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

type PillFieldProps = FieldProps & { icon: LucideIcon; placeholder: string };

/** Board 24 input: 64 high soft pill with a leading glyph and a placeholder instead of a label. */
export function PillField({
  icon,
  placeholder,
  keyboardType,
  autoComplete,
  testID,
  label,
  value,
  onChangeText,
  autoCapitalize = 'sentences',
  onSubmitEditing,
}: PillFieldProps) {
  const scale = useFontScale();
  return (
    <View style={styles.pill}>
      <Icon icon={icon} color={colors.inkMuted} />
      <TextInput
        keyboardType={keyboardType}
        autoComplete={autoComplete}
        testID={testID}
        accessibilityLabel={label}
        placeholder={placeholder}
        placeholderTextColor={colors.inkMuted}
        value={value}
        onChangeText={onChangeText}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        onSubmitEditing={onSubmitEditing}
        returnKeyType="done"
        style={[styles.pillInput, scaleText({ fontSize: 18 }, scale)]}
      />
    </View>
  );
}

type ButtonProps = {
  testID?: string;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  variant?: 'primary' | 'secondary' | 'ghost';
  /** Leading glyph. */
  icon?: LucideIcon;
  /** Custom leading element instead of a glyph. */
  leading?: ReactNode;
  /** Board XL pill (80 high, 20 pt label). */
  xl?: boolean;
};

/** Full-width pill. `busy` swaps the label for a spinner but keeps the accessible name. */
export function ActionButton({
  testID,
  label,
  onPress,
  disabled = false,
  busy = false,
  variant = 'primary',
  icon,
  leading,
  xl = false,
}: ButtonProps) {
  const primary = variant === 'primary';
  const ghost = variant === 'ghost';
  return (
    <PressableScale
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || busy, busy }}
      disabled={disabled || busy}
      pressedScale={0.97}
      onPress={onPress}
      style={[
        styles.button,
        xl && styles.buttonXl,
        primary
          ? styles.buttonPrimary
          : ghost
            ? styles.buttonGhost
            : styles.buttonSecondary,
        (disabled || busy) && styles.disabled,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={primary ? colors.onInk : colors.ink} />
      ) : (
        <>
          {leading}
          {icon ? (
            <Icon icon={icon} color={primary ? colors.onInk : colors.ink} />
          ) : null}
          <ScaledText
            variant="label"
            style={[
              primary
                ? styles.primaryText
                : ghost
                  ? styles.ghostText
                  : styles.secondaryText,
              xl && styles.labelXl,
            ]}
          >
            {label}
          </ScaledText>
        </>
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
  content: { paddingHorizontal: space[6], gap: space[4] },
  contentFill: { flexGrow: 1 },
  spacer: { flex: 1 },
  brand: { alignItems: 'center', gap: space[3] },
  logo: {
    width: 80,
    height: 80,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: colors.accent,
  },
  centered: { textAlign: 'center' },
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
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    height: size.tapLg,
    paddingHorizontal: 20,
    borderRadius: radius.full,
    backgroundColor: colors.surfaceSoft,
  },
  pillInput: {
    flex: 1,
    minWidth: 0,
    color: colors.ink,
    fontFamily: fontFamily.regular,
  },
  error: { color: colors.danger },
  button: {
    minHeight: 64,
    paddingHorizontal: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
    flexDirection: 'row',
    gap: space[2],
  },
  buttonXl: { minHeight: size.tapXl },
  labelXl: { fontSize: 20, lineHeight: 26 },
  buttonGhost: { alignSelf: 'center', backgroundColor: 'transparent' },
  ghostText: { color: colors.inkMuted },
  buttonPrimary: { backgroundColor: colors.ink },
  buttonSecondary: { backgroundColor: colors.surfaceSoft },
  primaryText: { color: colors.onInk },
  secondaryText: { color: colors.ink },
  disabled: { opacity: 0.5 },
});
