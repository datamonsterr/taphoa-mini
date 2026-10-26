import type { AssistantCard } from '@taphoa/api-client';
import { memo } from 'react';
import { View } from 'react-native';

import { Text } from '@/components/ui/ScaledText';
import { formatVnd } from '@/lib/format';
import { fill, useT } from '@/lib/i18n';
import { colors } from '@/theme';

import { dict } from '../../strings';
import { CardFrame, cardStyles } from './CardFrame';

type Card = Extract<AssistantCard, { type: 'debt_list' }>;

export const DebtListCard = memo(function DebtListCard({
  card,
}: {
  card: Card;
}) {
  const t = useT(dict);
  return (
    <CardFrame title={t('cardDebtList')} testID="card-debt-list">
      {card.items.map((item) => (
        <View key={item.customer_id} style={cardStyles.row}>
          <View style={cardStyles.grow}>
            <Text style={cardStyles.name}>{item.name}</Text>
            {item.overdue_days > 0 ? (
              <Text style={[cardStyles.sub, { color: colors.danger }]}>
                {fill(t('overdue'), { days: item.overdue_days })}
              </Text>
            ) : null}
          </View>
          <Text style={cardStyles.value}>{formatVnd(item.total)}</Text>
        </View>
      ))}
    </CardFrame>
  );
});
