import { useState } from 'react';
import { Pressable, StyleSheet, Switch, View } from 'react-native';

import { strings as accountStrings } from '@/features/account/strings';
import { ScaledText } from '@/components/ui';
import { useT } from '@/lib/i18n';
import { useSettingsStore } from '@/stores/settings';
import { colors, radius, size, space } from '@/theme';

import { strings } from './strings';

/**
 * The one-time elder-mode question (D5). Preselected ON; hidden once this device has an answer.
 * `commit` stores the answer: call it when the form was accepted, not before.
 */
export function useElderChoice() {
  const asked = useSettingsStore((s) => s.elderAsked);
  const [on, setOn] = useState(true);
  return {
    show: !asked,
    on,
    setOn,
    commit: () => {
      if (!asked) useSettingsStore.getState().setElderMode(on);
    },
  };
}

type Props = { on: boolean; onChange: (on: boolean) => void };

/** Switch row, reusing the account screen's label. */
export function ElderChoice({ on, onChange }: Props) {
  const t = useT(strings);
  const label = useT(accountStrings)('elder');
  return (
    <Pressable
      testID="onboarding-elder-choice"
      accessible={false}
      onPress={() => onChange(!on)}
      style={styles.row}
    >
      <View style={styles.text}>
        <ScaledText variant="label">{label}</ScaledText>
        <ScaledText variant="caption" style={styles.muted}>
          {t('elder.hint')}
        </ScaledText>
      </View>
      <Switch
        value={on}
        onValueChange={onChange}
        accessibilityLabel={label}
        style={styles.switch}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: size.tapMin,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    padding: space[3],
    borderRadius: radius.md,
    backgroundColor: colors.surfaceSoft,
  },
  text: { flex: 1, gap: space[1] },
  muted: { color: colors.inkMuted },
  switch: { minHeight: 48, minWidth: 48 },
});
