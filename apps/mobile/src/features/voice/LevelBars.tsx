import { memo, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { colors, radius } from '@/theme';

const BARS = 10;
const MIN = 8;
const MAX = 48;

export type LevelBarsProps = {
  /** 0..1 input level from the recorder metering. */
  level: number;
  testID?: string;
};

/** Ten bars that scroll left as new levels arrive; decorative, hidden from screen readers. */
export const LevelBars = memo(function LevelBars({
  level,
  testID,
}: LevelBarsProps) {
  const [levels, setLevels] = useState<number[]>(() => Array(BARS).fill(0));
  const latest = useRef(level);
  useEffect(() => {
    latest.current = level;
    setLevels((current) => [...current.slice(1), level]);
  }, [level]);
  return (
    <View
      testID={testID}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={styles.row}
    >
      {levels.map((value, index) => (
        <View
          key={index}
          testID={`level-bar-${index}`}
          style={[
            styles.bar,
            {
              height: MIN + (MAX - MIN) * value,
              backgroundColor: value > 0.05 ? colors.accent : colors.accentSoft,
            },
          ]}
        />
      ))}
    </View>
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 6, height: MAX },
  bar: { width: 6, borderRadius: radius.sm / 4 },
});
