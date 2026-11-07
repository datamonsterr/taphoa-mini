import { ChevronDown, X } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { KeyboardAvoidingView, StyleSheet, View } from 'react-native';

import { CircleButton, Sheet, Text } from '@/components/ui';
import { useT } from '@/lib/i18n';
import { colors, space, typography } from '@/theme';

import { debtStrings } from './strings';

/** A bottom sheet with a heading and a close circle, lifted above the keyboard. */
export function DebtSheet({
  title,
  onClose,
  footer,
  back = false,
  children,
}: {
  title: string;
  onClose: () => void;
  footer?: ReactNode;
  /** Board 07c: a chevron-down close before the title instead of an X after it. */
  back?: boolean;
  children: ReactNode;
}) {
  const t = useT(debtStrings);
  return (
    <KeyboardAvoidingView
      behavior="padding"
      pointerEvents="box-none"
      style={StyleSheet.absoluteFill}
    >
      <Sheet onClose={onClose} footer={footer}>
        <View style={styles.header}>
          {back ? (
            <CircleButton
              icon={ChevronDown}
              accessibilityLabel={t('sheet.close')}
              onPress={onClose}
            />
          ) : null}
          <Text accessibilityRole="header" style={styles.title}>
            {title}
          </Text>
          {back ? null : (
            <CircleButton
              icon={X}
              accessibilityLabel={t('sheet.close')}
              onPress={onClose}
            />
          )}
        </View>
        {children}
      </Sheet>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[3],
  },
  title: { ...typography.heading, flex: 1, color: colors.ink },
});
