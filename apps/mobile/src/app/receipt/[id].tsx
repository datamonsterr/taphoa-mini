import { Redirect, useLocalSearchParams } from 'expo-router';

/** Compatibility alias for old links: replaces into the unified receipts flow. */
export default function ReceiptAlias() {
  const { id, ...rest } = useLocalSearchParams<{
    id?: string;
    [key: string]: string | undefined;
  }>();
  return (
    <Redirect
      href={{
        pathname: '/receipts',
        params: { ...(id ? { receiptId: id } : {}), ...rest },
      }}
    />
  );
}
