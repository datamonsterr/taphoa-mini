import type { AssistantCard } from '@taphoa/api-client';
import { memo } from 'react';

import { ChartBarsCard } from './ChartBarsCard';
import { DebtListCard } from './DebtListCard';
import { ReceiptLinesCard, type ReceiptCardLine } from './ReceiptLinesCard';
import { RestockListCard } from './RestockListCard';

/** Picks the card component for a structured card. */
export const CardView = memo(function CardView({
  card,
  onLinePress,
}: {
  card: AssistantCard;
  onLinePress?: (line: ReceiptCardLine) => void;
}) {
  switch (card.type) {
    case 'receipt_lines':
      return <ReceiptLinesCard card={card} onLinePress={onLinePress} />;
    case 'restock_list':
      return <RestockListCard card={card} />;
    case 'debt_list':
      return <DebtListCard card={card} />;
    case 'chart_bars':
      return <ChartBarsCard card={card} />;
  }
});
