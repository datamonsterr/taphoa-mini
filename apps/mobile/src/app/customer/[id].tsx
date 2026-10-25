import { useLocalSearchParams } from 'expo-router';

import { CustomerScreen } from '@/features/debts/CustomerScreen';

export default function CustomerRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <CustomerScreen id={id} />;
}
