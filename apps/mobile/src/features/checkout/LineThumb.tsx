import { PostHogMaskView } from 'posthog-react-native';
import { Image } from 'expo-image';
import { Package } from 'lucide-react-native';
import { memo } from 'react';
import { StyleSheet } from 'react-native';

import { Icon } from '@/components/ui';
import { colors, radius } from '@/theme';

export type LineThumbProps = {
  uri?: string;
  /** Edge length; boards use 64 for cart and pay thumbnails. */
  dimension?: number;
};

/** Cart / pay line thumbnail: product photo, or a package glyph when there is none. */
export const LineThumb = memo(function LineThumb({
  uri,
  dimension = 64,
}: LineThumbProps) {
  return (
    <PostHogMaskView
      style={[styles.box, { width: dimension, height: dimension }]}
    >
      {uri ? (
        <Image
          source={{ uri }}
          cachePolicy="memory-disk"
          contentFit="cover"
          style={StyleSheet.absoluteFill}
          accessibilityIgnoresInvertColors
        />
      ) : (
        <Icon icon={Package} color={colors.inkMuted} />
      )}
    </PostHogMaskView>
  );
});

const styles = StyleSheet.create({
  box: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceSoft,
  },
});
