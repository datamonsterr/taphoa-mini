import { PostHogMaskView } from 'posthog-react-native';
import { Package } from 'lucide-react-native';
import { Image } from 'expo-image';
import { memo, useCallback, useState } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { FlatList, StyleSheet, View, useWindowDimensions } from 'react-native';
import Animated, {
  useAnimatedStyle,
  withTiming,
} from 'react-native-reanimated';

import { Icon } from '@/components/ui/Icon';
import type { ProductImage } from '@/lib/api/types';
import { useT } from '@/lib/i18n';
import { colors, radius, space } from '@/theme';

import { fill, strings } from './strings';

const PHOTO_HEIGHT = 300;
const DOT = 6;
const DOT_ACTIVE = 20;

const keyExtractor = (image: ProductImage) => image.image_id;

const Dot = memo(function Dot({
  index,
  active,
}: {
  index: number;
  active: boolean;
}) {
  const animated = useAnimatedStyle(() => ({
    width: withTiming(active ? DOT_ACTIVE : DOT, { duration: 180 }),
    backgroundColor: active ? colors.ink : colors.lineStrong,
  }));
  return (
    <Animated.View testID={`dot-${index}`} style={[styles.dot, animated]} />
  );
});

export const PhotoCarousel = memo(function PhotoCarousel({
  images,
}: {
  images: ProductImage[];
}) {
  const t = useT(strings);
  const { width: windowWidth } = useWindowDimensions();
  const pageWidth = windowWidth - space[4] * 2;
  const [index, setIndex] = useState(0);

  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const next = Math.round(event.nativeEvent.contentOffset.x / pageWidth);
      setIndex((current) => (current === next ? current : next));
    },
    [pageWidth],
  );
  const renderItem = useCallback(
    ({ item }: { item: ProductImage }) => (
      <PostHogMaskView style={[styles.page, { width: pageWidth }]}>
        <Image
          source={{ uri: item.url }}
          contentFit="contain"
          cachePolicy="memory-disk"
          recyclingKey={item.image_id}
          accessibilityIgnoresInvertColors
          style={styles.image}
          testID="product-photo"
        />
      </PostHogMaskView>
    ),
    [pageWidth],
  );
  const getItemLayout = useCallback(
    (_data: unknown, i: number) => ({
      length: pageWidth,
      offset: pageWidth * i,
      index: i,
    }),
    [pageWidth],
  );

  if (images.length === 0) {
    return (
      <View style={styles.well} testID="product-photo-empty">
        <Icon icon={Package} size={64} color={colors.lineStrong} />
      </View>
    );
  }
  return (
    <View style={styles.well}>
      <FlatList
        testID="product-carousel"
        style={styles.carousel}
        data={images}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        getItemLayout={getItemLayout}
        onScroll={onScroll}
        scrollEventThrottle={16}
      />
      {images.length > 1 ? (
        <View
          accessible
          accessibilityLabel={fill(t('photo'), {
            i: index + 1,
            n: images.length,
          })}
          style={styles.dots}
        >
          {images.map((image, i) => (
            <Dot key={image.image_id} index={i} active={i === index} />
          ))}
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  well: {
    height: PHOTO_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSoft,
  },
  // The well centres its children, so without a width the list grows to all pages (716px on a
  // 390px phone) and never scrolls on web.
  carousel: { width: '100%' },
  page: {
    height: PHOTO_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  image: { width: '70%', height: '70%' },
  dots: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 14,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
  },
  dot: { height: DOT, borderRadius: radius.full },
});
