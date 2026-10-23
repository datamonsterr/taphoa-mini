import { memo } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';

import { space } from '@/theme';

import { StripChip } from './StripChip';

export type StripItem = {
  id: string;
  name: string;
  price: number;
  thumbnailUri?: string;
};

type Props = {
  items: readonly StripItem[];
  /** Id of the current top-1 match. */
  currentId: string;
  /** `below`: row between viewfinder and controls. `floating`: inside the viewfinder at `top`. */
  placement: 'below' | 'floating';
  top?: number;
  onChoose: (id: string) => void;
};

/** Horizontal swipe list of look-alike products. */
export const AlternativesStrip = memo(function AlternativesStrip({
  items,
  currentId,
  placement,
  top,
  onChoose,
}: Props) {
  const floating = placement === 'floating';
  return (
    <Animated.View
      testID="alternatives-strip"
      accessibilityRole="radiogroup"
      accessibilityLabel="Chọn đúng món"
      entering={FadeInDown.duration(160)}
      exiting={FadeOutDown.duration(120)}
      style={floating ? [styles.floating, { top }] : styles.below}
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.content}
      >
        {items.map((item) => (
          <StripChip
            key={item.id}
            name={item.name}
            price={item.price}
            thumbnailUri={item.thumbnailUri}
            current={item.id === currentId}
            onPress={() => onChoose(item.id)}
          />
        ))}
      </ScrollView>
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  below: { width: '100%' },
  floating: { position: 'absolute', left: 0, right: 0 },
  content: {
    gap: space[2],
    paddingHorizontal: space[4],
    paddingVertical: space[1],
  },
});
