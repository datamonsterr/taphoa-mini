import { PostHogMaskView } from '@/components/ui/ReplayMask';
import { Image } from 'expo-image';
import { imageCacheKey } from '@/lib/imageCache';
import { Package } from 'lucide-react-native';
import { memo, useState } from 'react';
import { StyleSheet } from 'react-native';

import { Icon } from '@/components/ui';
import { colors, radius } from '@/theme';

export type LineThumbProps = {
  uri?: string;
  /** Edge length; boards use 64 for cart and pay thumbnails. */
  dimension?: number;
};

/** Cart / pay line thumbnail: product photo; a package glyph shows when there is none and until the photo has loaded. */
export const LineThumb = memo(function LineThumb({
  uri,
  dimension = 64,
}: LineThumbProps) {
  const [loaded, setLoaded] = useState(false);
  return (
    <PostHogMaskView
      style={[styles.box, { width: dimension, height: dimension }]}
    >
      {!uri || !loaded ? <Icon icon={Package} color={colors.inkMuted} /> : null}
      {uri ? (
        <Image
          testID="line-photo"
          onLoad={() => setLoaded(true)}
          source={{ uri, cacheKey: imageCacheKey(uri) }}
          cachePolicy="memory-disk"
          contentFit="cover"
          style={StyleSheet.absoluteFill}
          accessibilityIgnoresInvertColors
        />
      ) : null}
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
