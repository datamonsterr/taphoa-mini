import { useLocalSearchParams } from 'expo-router';
import { ReceiptReviewScreen } from '@/features/receipts/ReceiptReviewScreen';

export default function ReceiptRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ReceiptReviewScreen id={id} />;
}
