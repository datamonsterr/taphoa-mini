import { memo } from 'react';
import { StyleSheet, View } from 'react-native';

import { PressableScale } from '@/components/ui/PressableScale';
import { Text } from '@/components/ui/ScaledText';
import { camera, colors, radius, size, space } from '@/theme';
import { fontFamily } from '@/theme/typography';

import type { NextStepChipData } from './chip';

/** Fixed width, so the strip snaps to one chip per step. */
export const CHIP_WIDTH = 240;

export type NextStepChipProps = {
  chip: NextStepChipData;
  onPress: () => void;
};

/** One suggestion: title, optional subtitle. On-device chips are filled with the accent colour. */
export const NextStepChip = memo(function NextStepChip({
  chip,
  onPress,
}: NextStepChipProps) {
  const device = chip.tone ? chip.tone === 'accent' : chip.source === 'device';
  return (
    <PressableScale
      testID={`next-step-chip-${chip.id}`}
      accessibilityRole="button"
      accessibilityLabel={
        chip.subtitle ? `${chip.title}. ${chip.subtitle}` : chip.title
      }
      onPress={onPress}
      pressedScale={0.96}
      style={[styles.chip, device ? styles.device : styles.server]}
    >
      <View style={styles.text}>
        <Text numberOfLines={1} style={styles.title}>
          {chip.title}
        </Text>
        {chip.subtitle ? (
          <Text
            numberOfLines={1}
            style={[styles.subtitle, device && styles.subtitleDevice]}
          >
            {chip.subtitle}
          </Text>
        ) : null}
      </View>
    </PressableScale>
  );
});

const styles = StyleSheet.create({
  chip: {
    width: CHIP_WIDTH,
    minHeight: size.tapMin,
    justifyContent: 'center',
    paddingVertical: space[2],
    paddingHorizontal: space[4],
    borderRadius: radius.full,
  },
  device: { backgroundColor: colors.accent },
  server: { backgroundColor: camera.glass },
  text: { gap: 0 },
  title: {
    fontFamily: fontFamily.bold,
    fontSize: 17,
    lineHeight: 22,
    color: camera.white,
  },
  subtitle: {
    fontFamily: fontFamily.medium,
    fontSize: 13,
    lineHeight: 18,
    color: colors.cameraMuted,
  },
  subtitleDevice: { color: colors.onAccent },
});
