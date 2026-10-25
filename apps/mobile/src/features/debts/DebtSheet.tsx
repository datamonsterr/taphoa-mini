import { X } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native';

import { CircleButton, Sheet, Text } from '@/components/ui';
import { useT } from '@/lib/i18n';
import { colors, space, typography } from '@/theme';

import { debtStrings } from './strings';

/** A bottom sheet with a heading and a close circle, lifted above the keyboard. */
export function DebtSheet({
  title,
  onClose,
  footer,
  children,
}: {
  title: string;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const t = useT(debtStrings);
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      pointerEvents="box-none"
      style={StyleSheet.absoluteFill}
    >
      <Sheet onClose={onClose} footer={footer}>
        <View style={styles.header}>
          <Text accessibilityRole="header" style={styles.title}>
            {title}
          </Text>
          <CircleButton
            icon={X}
            accessibilityLabel={t('sheet.close')}
            onPress={onClose}
          />
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
