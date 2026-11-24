import { useLocalSearchParams } from 'expo-router';

import { ReceiptHistoryScreen } from '@/features/receipts/ReceiptHistoryScreen';
import { ReceiptReviewScreen } from '@/features/receipts/ReceiptReviewScreen';

/** Unified Nhập hàng flow: history and drafts when no receiptId, or review screen for the given receipt. */
export default function ReceiptsRoute() {
  const { receiptId } = useLocalSearchParams<{ receiptId?: string }>();
  if (receiptId) {
    return <ReceiptReviewScreen id={receiptId} />;
  }
  return <ReceiptHistoryScreen />;
}
