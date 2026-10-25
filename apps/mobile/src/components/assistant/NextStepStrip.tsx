import * as Haptics from 'expo-haptics';
import { memo } from 'react';
import { ScrollView, StyleSheet } from 'react-native';

import { useT } from '@/lib/i18n';
import { space } from '@/theme';

import type { NextStepChipData } from './chip';
import { CHIP_WIDTH, NextStepChip } from './NextStepChip';
import { strings } from './strings';

export type NextStepStripProps = {
  chips: readonly NextStepChipData[];
  onPress: (chip: NextStepChipData, position: number) => void;
};

/** One horizontal row of suggestion chips, snapping per chip; renders nothing when empty. */
export const NextStepStrip = memo(function NextStepStrip({
  chips,
  onPress,
}: NextStepStripProps) {
  const t = useT(strings);
  if (chips.length === 0) return null;
  return (
    <ScrollView
      testID="next-step-strip"
      accessibilityLabel={t('strip')}
      horizontal
      showsHorizontalScrollIndicator={false}
      snapToInterval={CHIP_WIDTH + space[2]}
      snapToAlignment="start"
      decelerationRate="fast"
      disableIntervalMomentum
      contentContainerStyle={styles.content}
    >
      {chips.map((chip, position) => (
        <NextStepChip
          key={chip.id}
          chip={chip}
          onPress={() => {
            void Haptics.selectionAsync();
            onPress(chip, position);
          }}
        />
      ))}
    </ScrollView>
  );
});

const styles = StyleSheet.create({
  content: {
    gap: space[2],
    paddingHorizontal: space[4],
    paddingVertical: space[1],
  },
});
