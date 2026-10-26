import type { AssistantCard } from '@taphoa/api-client';
import { memo } from 'react';
import { View } from 'react-native';

import { Text } from '@/components/ui/ScaledText';
import { formatVnd } from '@/lib/format';
import { useT } from '@/lib/i18n';

import { dict } from '../../strings';
import { CardFrame, cardStyles } from './CardFrame';

type Card = Extract<AssistantCard, { type: 'restock_list' }>;

export const RestockListCard = memo(function RestockListCard({
  card,
}: {
  card: Card;
}) {
  const t = useT(dict);
  return (
    <CardFrame title={t('cardRestockList')} testID="card-restock-list">
      {card.items.map((item) => (
        <View key={item.product_id} style={cardStyles.row}>
          <View style={cardStyles.grow}>
            <Text style={cardStyles.name}>{item.name}</Text>
            {item.unit_cost === null ? null : (
              <Text style={cardStyles.sub}>{formatVnd(item.unit_cost)}</Text>
            )}
          </View>
          <Text style={cardStyles.value}>{String(item.quantity)}</Text>
          {item.total_cost === null ? null : (
            <Text style={cardStyles.value}>{formatVnd(item.total_cost)}</Text>
          )}
        </View>
      ))}
      {card.total_cost === null ? null : (
        <View style={cardStyles.row}>
          <Text style={cardStyles.name}>{t('total')}</Text>
          <Text style={cardStyles.value}>{formatVnd(card.total_cost)}</Text>
        </View>
      )}
    </CardFrame>
  );
});
