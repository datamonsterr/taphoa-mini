import { memo, useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { PressableScale, Text } from '@/components/ui';
import { useT } from '@/lib/i18n';
import { colors, radius, space, typography } from '@/theme';

import { voiceStrings } from './strings';

export type UnderstandingViewProps = {
  /** The words heard so far (the device transcript, when there is one). */
  transcript?: string;
  onCancel: () => void;
};

/** Board 15, understanding: "Đang hiểu…", the transcript in grey, a progress line, Hủy. */
export const UnderstandingView = memo(function UnderstandingView({
  transcript,
  onCancel,
}: UnderstandingViewProps) {
  const t = useT(voiceStrings);
  const slide = useSharedValue(0);
  useEffect(() => {
    slide.value = withRepeat(withTiming(1, { duration: 1100 }), -1, false);
  }, [slide]);
  const bar = useAnimatedStyle(() => ({
    left: `${slide.value * 70}%`,
  }));
  return (
    <View testID="voice-understanding" style={styles.root}>
      <Text
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
        style={styles.status}
      >
        {t('understanding')}
      </Text>
      {transcript ? (
        <Text testID="voice-transcript" style={styles.transcript}>
          {transcript}
        </Text>
      ) : null}
      <View
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel={t('understanding')}
        style={styles.track}
      >
        <Animated.View style={[styles.fill, bar]} />
      </View>
      <View style={styles.spacer} />
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={t('cancel')}
        onPress={onCancel}
        style={styles.cancel}
        testID="voice-cancel"
      >
        <Text style={styles.cancelText}>{t('cancel')}</Text>
      </PressableScale>
    </View>
  );
});

const styles = StyleSheet.create({
  root: { flex: 1, gap: space[6] },
  status: { ...typography.label, textAlign: 'center', color: colors.inkMuted },
  transcript: {
    ...typography.title,
    fontSize: 28,
    lineHeight: 36,
    color: colors.lineStrong,
  },
  track: {
    height: 6,
    overflow: 'hidden',
    borderRadius: radius.full,
    backgroundColor: colors.accentSoft,
  },
  fill: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: '30%',
    borderRadius: radius.full,
    backgroundColor: colors.accent,
  },
  spacer: { flex: 1 },
  cancel: {
    minHeight: 56,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: colors.surfaceSoft,
  },
  cancelText: { ...typography.label, color: colors.ink },
});
