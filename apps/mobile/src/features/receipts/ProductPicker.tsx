import { X } from 'lucide-react-native';
import { useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { CircleButton, PressableScale, Sheet, Text } from '@/components/ui';
import { useProducts, type ReceiptLine } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { colors, fontFamily, radius, space, typography } from '@/theme';
import { strings } from './strings';

export function ProductPicker({
  line,
  onChoose,
  onClose,
}: {
  line: ReceiptLine;
  onChoose: (id: string) => void;
  onClose: () => void;
}) {
  const t = useT(strings);
  const [search, setSearch] = useState('');
  const products = useProducts({ q: search, limit: 20 });
  return (
    <Modal transparent animationType="slide" onRequestClose={onClose}>
      <Sheet height={700} onClose={onClose}>
        <View style={styles.header}>
          <Text style={typography.heading} accessibilityRole="header">
            {t('picker')}
          </Text>
          <CircleButton
            icon={X}
            accessibilityLabel={t('closePicker')}
            onPress={onClose}
          />
        </View>
        <Text style={typography.label}>{t('candidates')}</Text>
        {[...line.candidates]
          .sort((a, b) => b.probability - a.probability)
          .map((candidate) => {
            const label = `${candidate.name ?? t('unnamed')} ${Math.round(candidate.probability * 100)}%`;
            return (
              <PressableScale
                key={candidate.product_id}
                accessibilityRole="button"
                accessibilityLabel={label}
                style={styles.candidate}
                onPress={() => onChoose(candidate.product_id)}
              >
                <Text style={typography.label}>{label}</Text>
              </PressableScale>
            );
          })}
        <Text style={typography.label}>{t('catalog')}</Text>
        <TextInput
          accessibilityLabel={t('search')}
          placeholder={t('search')}
          value={search}
          onChangeText={setSearch}
          style={styles.input}
        />
        {products.isFetching ? (
          <ActivityIndicator accessibilityLabel={t('loading')} />
        ) : null}
        {products.isError ? (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={t('retry')}
            style={styles.candidate}
            onPress={() => void products.refetch()}
          >
            <Text>
              {t('error')} {t('retry')}
            </Text>
          </PressableScale>
        ) : null}
        {products.data?.map((product) => (
          <PressableScale
            key={product.id}
            accessibilityRole="button"
            accessibilityLabel={product.name ?? t('unnamed')}
            disabled={products.isPlaceholderData}
            style={styles.candidate}
            onPress={() => onChoose(product.id)}
          >
            <Text style={typography.body}>{product.name ?? t('unnamed')}</Text>
          </PressableScale>
        ))}
        {!products.isPending &&
        !products.isError &&
        products.data?.length === 0 ? (
          <Text>{t('noProducts')}</Text>
        ) : null}
        {products.hasNextPage ? (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={t('more')}
            disabled={products.isFetching}
            style={styles.candidate}
            onPress={() => void products.fetchNextPage()}
          >
            <Text>{t('more')}</Text>
          </PressableScale>
        ) : null}
      </Sheet>
    </Modal>
  );
}
const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  candidate: {
    minHeight: 56,
    justifyContent: 'center',
    padding: space[3],
    borderRadius: radius.md,
    backgroundColor: colors.surfaceSoft,
  },
  input: {
    minHeight: 56,
    borderRadius: radius.md,
    padding: space[4],
    backgroundColor: colors.surfaceSoft,
    color: colors.ink,
    fontFamily: fontFamily.regular,
    fontSize: 18,
  },
});
