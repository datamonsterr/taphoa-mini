import type { AssistantCard } from '@taphoa/api-client';
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui/ScaledText';
import { formatVnd } from '@/lib/format';
import { colors, radius, space } from '@/theme';

import { CardFrame, cardStyles } from './CardFrame';

type Card = Extract<AssistantCard, { type: 'chart_bars' }>;

export const ChartBarsCard = memo(function ChartBarsCard({
  card,
}: {
  card: Card;
}) {
  const max = Math.max(0, ...card.bars.map((bar) => bar.value));
  return (
    <CardFrame title={card.title_vi} testID="card-chart-bars">
      {card.bars.map((bar, index) => (
        <View key={`${bar.label}-${index}`} style={styles.bar}>
          <View style={cardStyles.row}>
            <Text style={cardStyles.sub}>{bar.label}</Text>
            <Text style={cardStyles.value}>
              {card.unit === 'dong' ? formatVnd(bar.value) : String(bar.value)}
            </Text>
          </View>
          <View style={styles.track}>
            <View
              testID={`chart-bar-${index}`}
              style={[
                styles.fill,
                { width: `${max > 0 ? (bar.value / max) * 100 : 0}%` },
              ]}
            />
          </View>
        </View>
      ))}
    </CardFrame>
  );
});

const styles = StyleSheet.create({
  bar: { gap: space[1] },
  track: {
    height: 12,
    borderRadius: radius.full,
    backgroundColor: colors.surfacePressed,
    overflow: 'hidden',
  },
  fill: {
    height: 12,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
  },
});
