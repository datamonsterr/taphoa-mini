import { Image } from 'expo-image';
import { memo, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { camera, radius } from '@/theme';

type Props = {
  /** Edge length of the square. */
  size: number;
  /** Frozen photo after capture. Without it, children are the live camera. */
  photoUri?: string;
  /** Drawn under the frozen photo, e.g. a live preview that stays mounted. */
  behind?: ReactNode;
  /** Live camera, or detection overlay on top of the photo. */
  children?: ReactNode;
};

const corners = ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'] as const;

/** Square, rounded camera window with corner marks. */
export const Viewfinder = memo(function Viewfinder({
  size,
  photoUri,
  behind,
  children,
}: Props) {
  return (
    <View
      testID="viewfinder"
      style={[styles.frame, { width: size, height: size }]}
    >
      {behind}
      {photoUri ? (
        <Image
          testID="viewfinder-photo"
          source={{ uri: photoUri }}
          contentFit="cover"
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      {children}
      {corners.map((corner) => (
        <View
          key={corner}
          testID="viewfinder-corner"
          pointerEvents="none"
          style={[styles.corner, styles[corner]]}
        />
      ))}
    </View>
  );
});

const INSET = 14;
const MARK = 3;

const styles = StyleSheet.create({
  frame: {
    overflow: 'hidden',
    borderRadius: radius.lg,
    backgroundColor: camera.viewfinderBg,
  },
  corner: {
    position: 'absolute',
    width: 22,
    height: 22,
    borderColor: camera.cornerMark,
  },
  topLeft: {
    top: INSET,
    left: INSET,
    borderTopWidth: MARK,
    borderLeftWidth: MARK,
    borderTopLeftRadius: 6,
  },
  topRight: {
    top: INSET,
    right: INSET,
    borderTopWidth: MARK,
    borderRightWidth: MARK,
    borderTopRightRadius: 6,
  },
  bottomLeft: {
    bottom: INSET,
    left: INSET,
    borderBottomWidth: MARK,
    borderLeftWidth: MARK,
    borderBottomLeftRadius: 6,
  },
  bottomRight: {
    bottom: INSET,
    right: INSET,
    borderBottomWidth: MARK,
    borderRightWidth: MARK,
    borderBottomRightRadius: 6,
  },
});
