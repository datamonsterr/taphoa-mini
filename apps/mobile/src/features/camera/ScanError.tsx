import { RefreshCw } from 'lucide-react-native';
import { memo } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';

import { Icon } from '@/components/ui/Icon';
import { camera, colors, radius, size, space } from '@/theme';
import { fontFamily } from '@/theme/typography';

type Props = {
  message: string;
  retryLabel: string;
  onRetry: () => void;
};

/** Small pill at the bottom of the viewfinder: what failed, and a way to try again. */
export const ScanError = memo(function ScanError({
  message,
  retryLabel,
  onRetry,
}: Props) {
  return (
    <Animated.View
      accessibilityRole="alert"
      entering={FadeInDown.duration(160)}
      exiting={FadeOutDown.duration(120)}
      style={styles.pill}
    >
      <Text style={styles.message}>{message}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={retryLabel}
        onPress={onRetry}
        style={styles.retry}
      >
        <Icon icon={RefreshCw} size={20} color={colors.ink} />
      </Pressable>
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  pill: {
    position: 'absolute',
    left: space[4],
    right: space[4],
    bottom: space[6],
    height: size.tapMin,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: space[4],
    paddingRight: space[2],
    borderRadius: radius.full,
    backgroundColor: camera.chipDark,
  },
  message: {
    flex: 1,
    fontFamily: fontFamily.semibold,
    fontSize: 16,
    color: camera.white,
  },
  retry: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: camera.white,
  },
});
