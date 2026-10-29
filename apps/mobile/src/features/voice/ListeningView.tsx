import { ChevronDown, Mic } from 'lucide-react-native';
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

import { CheckButton, CircleButton, Icon, Text } from '@/components/ui';
import { fill, useT } from '@/lib/i18n';
import { colors, radius, space, typography } from '@/theme';

import { LevelBars } from './LevelBars';
import { voiceStrings } from './strings';

const MIC = 88;
const RING = 132;
const STROKE = 4;
const RADIUS = (RING - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export type ListeningViewProps = {
  level: number;
  elapsedMs: number;
  maxMs: number;
  onStop: () => void;
  onClose: () => void;
};

/** Dash offset of the countdown ring: the full circle at 0, nothing left at 1. */
export const ringOffset = (progress: number) =>
  CIRCUMFERENCE * (1 - Math.min(1, Math.max(0, progress)));

const clock = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

/** Board 15, listening: level bars, the 88 dp microphone inside the 30 s ring, the hint, stop. */
export const ListeningView = memo(function ListeningView({
  level,
  elapsedMs,
  maxMs,
  onStop,
  onClose,
}: ListeningViewProps) {
  const t = useT(voiceStrings);
  const left = Math.max(0, Math.ceil((maxMs - elapsedMs) / 1000));
  const progress = Math.min(1, elapsedMs / maxMs);
  return (
    <View testID="voice-listening" style={styles.root}>
      <View style={styles.header}>
        <CircleButton
          icon={ChevronDown}
          accessibilityLabel={t('close')}
          onPress={onClose}
          testID="voice-close"
        />
        <Text style={styles.status} accessibilityLiveRegion="polite">
          {t('listening')}
        </Text>
        <Text
          testID="voice-clock"
          accessibilityLabel={fill(t('countdown'), { s: left })}
          style={styles.clock}
        >
          {clock(elapsedMs)}
        </Text>
      </View>
      <LevelBars level={level} testID="voice-level" />
      <View style={styles.micWrap}>
        <View style={styles.pulse} />
        <Svg
          testID="voice-ring"
          width={RING}
          height={RING}
          viewBox={`0 0 ${RING} ${RING}`}
          style={StyleSheet.absoluteFill}
        >
          <Circle
            cx={RING / 2}
            cy={RING / 2}
            r={RADIUS}
            stroke={colors.accentSoft}
            strokeWidth={STROKE}
            fill="none"
          />
          <Circle
            cx={RING / 2}
            cy={RING / 2}
            r={RADIUS}
            stroke={colors.accent}
            strokeWidth={STROKE}
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={ringOffset(progress)}
            rotation={-90}
            origin={`${RING / 2}, ${RING / 2}`}
            fill="none"
          />
        </Svg>
        <View testID="voice-mic" style={styles.mic}>
          <Icon icon={Mic} size={40} color={colors.onAccent} />
        </View>
      </View>
      <Text style={styles.hint}>{t('hint')}</Text>
      <Text style={styles.example}>{t('example')}</Text>
      <View style={styles.spacer} />
      <CheckButton
        variant="ink"
        accessibilityLabel={t('stopLabel')}
        onPress={onStop}
        block
        xl
      />
    </View>
  );
});

const styles = StyleSheet.create({
  root: { alignItems: 'center', gap: space[3], flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', width: '100%' },
  status: {
    ...typography.label,
    flex: 1,
    textAlign: 'center',
    color: colors.inkMuted,
  },
  clock: {
    ...typography.caption,
    width: 56,
    textAlign: 'right',
    color: colors.inkMuted,
    fontVariant: ['tabular-nums'],
  },
  micWrap: {
    width: RING,
    height: RING,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pulse: {
    ...StyleSheet.absoluteFill,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    opacity: 0.16,
  },
  mic: {
    width: MIC,
    height: MIC,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: colors.accent,
  },
  hint: { ...typography.heading, textAlign: 'center', color: colors.ink },
  example: {
    ...typography.caption,
    textAlign: 'center',
    color: colors.inkMuted,
  },
  spacer: { flex: 1 },
});
