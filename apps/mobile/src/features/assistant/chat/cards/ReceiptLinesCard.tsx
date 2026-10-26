import type { AssistantCard } from '@taphoa/api-client';
import { router } from 'expo-router';
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';

import { PressableScale } from '@/components/ui/PressableScale';
import { Text } from '@/components/ui/ScaledText';
import { formatVnd } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { colors, radius, size, space, typography } from '@/theme';

import { dict } from '../../strings';
import { CardFrame, cardStyles } from './CardFrame';

type Card = Extract<AssistantCard, { type: 'receipt_lines' }>;
export type ReceiptCardLine = Card['lines'][number];

/** High at 0.8 and above, medium from 0.5, low (or no match) otherwise. */
export function confidenceColor(confidence: number | null): string {
  if (confidence !== null && confidence >= 0.8) return colors.success;
  if (confidence !== null && confidence >= 0.5) return colors.warning;
  return colors.danger;
}

export const ReceiptLinesCard = memo(function ReceiptLinesCard({
  card,
  onLinePress,
}: {
  card: Card;
  onLinePress?: (line: ReceiptCardLine) => void;
}) {
  const t = useT(dict);
  return (
    <CardFrame title={t('cardReceiptLines')} testID="card-receipt-lines">
      {card.lines.map((line) => (
        <PressableScale
          key={line.line_id}
          accessibilityRole="button"
          accessibilityLabel={line.name}
          pressedScale={0.98}
          onPress={() => onLinePress?.(line)}
          style={styles.line}
        >
          <View
            testID={`receipt-line-${line.line_id}-confidence`}
            style={[
              styles.dot,
              {
                backgroundColor: confidenceColor(
                  line.product_id === null ? null : line.confidence,
                ),
              },
            ]}
          />
          <View style={cardStyles.grow}>
            <Text style={cardStyles.name}>{line.name}</Text>
            <Text style={cardStyles.sub}>
              {line.product_name ?? t('unmatched')}
            </Text>
          </View>
          {line.quantity === null ? null : (
            <Text style={cardStyles.value}>{`×${line.quantity}`}</Text>
          )}
          {line.cost === null ? null : (
            <Text style={cardStyles.value}>{formatVnd(line.cost)}</Text>
          )}
        </PressableScale>
      ))}
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={t('viewAsTable')}
        onPress={() => router.push(`/receipt/${card.receipt_id}`)}
        style={styles.table}
      >
        <Text style={styles.tableText}>{t('viewAsTable')}</Text>
      </PressableScale>
    </CardFrame>
  );
});

const styles = StyleSheet.create({
  line: {
    minHeight: size.tapMin,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
  },
  dot: { width: 12, height: 12, borderRadius: radius.full },
  table: {
    minHeight: size.tapMin,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: colors.accentSoft,
  },
  tableText: { ...typography.label, color: colors.accent },
});
