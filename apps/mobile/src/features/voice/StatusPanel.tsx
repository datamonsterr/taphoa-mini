import { memo, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { CircleButton, PressableScale, Text } from '@/components/ui';
import { ChevronDown } from 'lucide-react-native';
import { colors, radius, size, space, typography } from '@/theme';

export type StatusAction = {
  label: string;
  onPress: () => void;
  testID: string;
  /** The filled primary button; the others are soft. */
  primary?: boolean;
};

export type StatusPanelProps = {
  testID: string;
  title: string;
  hint?: string;
  /** Extra content between the text and the buttons (for example a device transcript). */
  children?: ReactNode;
  actions: StatusAction[];
  closeLabel: string;
  onClose: () => void;
};

/** The error and hand-off panes of the voice sheet: a message, optional content, buttons. */
export const StatusPanel = memo(function StatusPanel({
  testID,
  title,
  hint,
  children,
  actions,
  closeLabel,
  onClose,
}: StatusPanelProps) {
  return (
    <View testID={testID} style={styles.root}>
      <View style={styles.header}>
        <CircleButton
          icon={ChevronDown}
          accessibilityLabel={closeLabel}
          onPress={onClose}
          testID="voice-close"
        />
      </View>
      <View style={styles.body}>
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          style={styles.title}
        >
          {title}
        </Text>
        {hint ? <Text style={styles.hint}>{hint}</Text> : null}
        {children}
      </View>
      <View style={styles.actions}>
        {actions.map((action) => (
          <PressableScale
            key={action.testID}
            testID={action.testID}
            accessibilityRole="button"
            accessibilityLabel={action.label}
            onPress={action.onPress}
            style={[styles.button, action.primary && styles.primary]}
          >
            <Text
              style={[styles.buttonText, action.primary && styles.primaryText]}
            >
              {action.label}
            </Text>
          </PressableScale>
        ))}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  root: { flex: 1, gap: space[3] },
  header: { flexDirection: 'row' },
  body: { flex: 1, gap: space[3], justifyContent: 'center' },
  title: { ...typography.heading, textAlign: 'center', color: colors.ink },
  hint: { ...typography.body, textAlign: 'center', color: colors.inkMuted },
  actions: { gap: space[2] },
  button: {
    minHeight: size.tapLg,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: colors.surfaceSoft,
  },
  primary: { backgroundColor: colors.ink },
  buttonText: { ...typography.label, color: colors.ink },
  primaryText: { color: colors.onInk },
});
