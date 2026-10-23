import { Camera } from 'lucide-react-native';
import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon } from '@/components/ui/Icon';
import { camera, colors, radius, size, space } from '@/theme';
import { fontFamily } from '@/theme/typography';

type Props = {
  title: string;
  /** Request when the system can still ask; otherwise the settings shortcut. */
  actionLabel: string;
  onPress: () => void;
};

/** Fills the viewfinder until the camera permission is granted. */
export const PermissionPrompt = memo(function PermissionPrompt({
  title,
  actionLabel,
  onPress,
}: Props) {
  return (
    <View style={styles.wrap}>
      <Icon icon={Camera} size={40} color={colors.cameraMuted} />
      <Text style={styles.title}>{title}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={actionLabel}
        onPress={onPress}
        style={styles.button}
      >
        <Text style={styles.label}>{actionLabel}</Text>
      </Pressable>
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[4],
    padding: space[6],
  },
  title: {
    fontFamily: fontFamily.semibold,
    fontSize: 18,
    lineHeight: 24,
    textAlign: 'center',
    color: camera.white,
  },
  button: {
    height: size.tapMin,
    justifyContent: 'center',
    paddingHorizontal: space[6],
    borderRadius: radius.full,
    backgroundColor: colors.accent,
  },
  label: {
    fontFamily: fontFamily.bold,
    fontSize: 18,
    color: colors.onAccent,
  },
});
