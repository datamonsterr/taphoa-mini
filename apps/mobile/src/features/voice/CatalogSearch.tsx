import { Search } from 'lucide-react-native';
import { memo, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { Icon, MoneyText, PressableScale, Text } from '@/components/ui';
import { useProducts } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { colors, radius, size, space, typography } from '@/theme';

import { LineThumb } from '../checkout/LineThumb';
import { useDebouncedValue } from '../inventory/useDebouncedValue';
import type { DraftProduct } from './draft';
import { voiceStrings } from './strings';

const SEARCH_DEBOUNCE_MS = 250;

export type CatalogSearchProps = {
  initialQuery: string;
  onPick: (product: DraftProduct) => void;
  /** Rendered under the results (for example the "open cart" button). */
  footer?: React.ReactNode;
  /** Short status line above the list (for example "Added to the cart"). */
  notice?: string;
};

/** Searches the store catalog; a tap on a result hands the product to the caller. */
export const CatalogSearch = memo(function CatalogSearch({
  initialQuery,
  onPick,
  footer,
  notice,
}: CatalogSearchProps) {
  const t = useT(voiceStrings);
  const [query, setQuery] = useState(initialQuery);
  const q = useDebouncedValue(query.trim(), SEARCH_DEBOUNCE_MS);
  const { data, isError, isPending, refetch } = useProducts({
    q: q || undefined,
    limit: 20,
  });
  return (
    <View testID="voice-search" style={styles.root}>
      <View style={styles.field}>
        <Icon icon={Search} color={colors.inkMuted} />
        <TextInput
          testID="voice-search-input"
          accessibilityLabel={t('search')}
          placeholder={t('search')}
          placeholderTextColor={colors.inkMuted}
          value={query}
          onChangeText={setQuery}
          returnKeyType="search"
          style={styles.input}
        />
      </View>
      {notice ? (
        <Text accessibilityLiveRegion="polite" style={styles.notice}>
          {notice}
        </Text>
      ) : null}
      <ScrollView
        style={styles.list}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.listContent}
      >
        {isPending ? (
          <ActivityIndicator accessibilityLabel={t('searchLoading')} />
        ) : null}
        {isError ? (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={t('searchError')}
            onPress={() => void refetch()}
            style={styles.row}
          >
            <Text style={styles.name}>{t('searchError')}</Text>
          </PressableScale>
        ) : null}
        {data?.length === 0 ? (
          <Text style={styles.empty}>{t('searchEmpty')}</Text>
        ) : null}
        {data?.map((product) => (
          <PressableScale
            key={product.id}
            testID={`voice-search-${product.id}`}
            accessibilityRole="button"
            accessibilityLabel={`${product.name ?? ''} ${product.price}`}
            onPress={() =>
              onPick({
                id: product.id,
                name: product.name ?? '',
                price: product.price,
                ...(product.images[0]?.url
                  ? { imageUrl: product.images[0].url }
                  : {}),
              })
            }
            style={styles.row}
          >
            <LineThumb uri={product.images[0]?.url} dimension={48} />
            <Text numberOfLines={1} style={styles.name}>
              {product.name}
            </Text>
            <MoneyText amount={product.price} variant="label" />
          </PressableScale>
        ))}
      </ScrollView>
      {footer}
    </View>
  );
});

const styles = StyleSheet.create({
  root: { flex: 1, gap: space[3] },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    minHeight: size.tapMin,
    paddingHorizontal: space[4],
    borderRadius: radius.full,
    backgroundColor: colors.surfaceSoft,
  },
  input: { ...typography.body, flex: 1, color: colors.ink },
  notice: { ...typography.caption, color: colors.success },
  list: { flex: 1 },
  listContent: { gap: space[1] },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    minHeight: size.tapMin,
    padding: space[2],
    borderRadius: radius.md,
  },
  name: { ...typography.label, flex: 1, color: colors.ink },
  empty: { ...typography.body, color: colors.inkMuted, textAlign: 'center' },
});
