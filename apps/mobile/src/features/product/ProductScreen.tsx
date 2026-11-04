import { router, useLocalSearchParams } from 'expo-router';
import {
  ArrowDownToLine,
  Boxes,
  ChevronLeft,
  Pencil,
} from 'lucide-react-native';
import { memo, useCallback, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CircleButton } from '@/components/ui/CircleButton';
import { Icon } from '@/components/ui/Icon';
import { PressableScale } from '@/components/ui/PressableScale';
import { MoneyText } from '@/components/ui/MoneyText';
import { strings as stockStrings } from '@/features/stock/strings';
import { useCategories, usePatchProduct, useProduct } from '@/lib/api/hooks';
import { isApiError } from '@/lib/api/errors';
import type { Category, Product } from '@/lib/api/types';
import { formatVnd } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { useIsLead } from '@/features/auth/useMembership';
import { colors, fontFamily, radius, space, typography } from '@/theme';

import { barcodeConflict } from '@/features/enroll/barcodeConflict';

import { AdjustStockSheet } from './AdjustStockSheet';
import { EditPriceSheet } from './EditPriceSheet';
import { StockMovements } from './StockMovements';
import { ProductStock } from './ProductStock';
import { PhotoCarousel } from './PhotoCarousel';
import { UnitsRow } from './UnitsEditor';
import { fill, strings } from './strings';

/** Description from the fields the API has: category and extra selling units. */
function describe(
  product: Product,
  categories: Category[] | undefined,
  unitLine: string,
): string {
  const category = categories?.find((c) => c.id === product.category_id)?.name;
  const units = product.units
    .filter((unit) => unit.quantity_in_base > 1)
    .map((unit) =>
      fill(unitLine, {
        unit: unit.name,
        quantity: unit.quantity_in_base,
        base: product.base_unit,
        price: formatVnd(unit.price),
      }),
    );
  return (
    [category, ...units].filter(Boolean).join('. ') +
    (category || units.length ? '.' : '')
  );
}

const Stat = memo(function Stat({
  icon,
  label,
  value,
  accessibleValue = value,
  color = colors.ink,
}: {
  icon: typeof ArrowDownToLine;
  label: string;
  value: string;
  accessibleValue?: string;
  color?: string;
}) {
  return (
    <View
      accessible
      accessibilityLabel={`${label} ${accessibleValue}`}
      style={styles.stat}
    >
      <Icon icon={icon} color={colors.inkMuted} />
      <Text style={[styles.statValue, { color }]}>{value}</Text>
    </View>
  );
});

function Skeleton() {
  return (
    <View style={styles.skeleton} testID="product-skeleton">
      <View style={styles.skeletonPhoto} />
      <View style={[styles.skeletonLine, { width: '60%' }]} />
      <View style={[styles.skeletonLine, { width: '35%' }]} />
    </View>
  );
}

export function ProductScreen() {
  const t = useT(strings);
  const ts = useT(stockStrings);
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: product, error, isError, refetch } = useProduct(id);
  const { data: categories } = useCategories();
  const patch = usePatchProduct();
  // Only the Lead sets prices; the server answers 403 to anyone else.
  const isLead = useIsLead();
  const [adjusting, setAdjusting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [barcodeError, setBarcodeError] = useState('');
  const [editBarcode, setEditBarcode] = useState('');
  const [editPrice, setEditPrice] = useState(0);
  const [saveFailed, setSaveFailed] = useState(false);

  const goBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/inventory');
  }, []);
  const openEdit = () => {
    setBarcodeError('');
    setEditBarcode(product?.barcode ?? '');
    setEditPrice(product?.price ?? 0);
    setEditing(true);
  };
  const closeEdit = useCallback(() => setEditing(false), []);
  const retry = useCallback(() => void refetch(), [refetch]);

  const save = (price: number, barcode = product?.barcode ?? '') => {
    setEditing(false);
    if (!product) return;
    const changedBarcode = barcode !== (product.barcode ?? '');
    if (price === product.price && !changedBarcode) return;
    setEditBarcode(barcode);
    setEditPrice(price);
    setSaveFailed(false);
    patch.mutate(
      {
        id: product.id,
        patch: {
          ...(price !== product.price ? { price } : {}),
          ...(changedBarcode ? { barcode: barcode || null } : {}),
        },
      },
      {
        onError: async (error) => {
          const conflict = await barcodeConflict(error, barcode);
          if (conflict) {
            setBarcodeError(conflict);
            setEditing(true);
          } else setSaveFailed(true);
        },
      },
    );
  };

  const notFound = isApiError(error) && error.status === 404;
  let body;
  if (product) {
    const description = describe(product, categories, t('unitLine'));
    body = (
      <>
        <PhotoCarousel images={product.images} />
        <View style={styles.titleRow}>
          <Text accessibilityRole="header" style={styles.name}>
            {product.name ?? t('unnamed')}
          </Text>
          <MoneyText amount={product.price} style={styles.price} />
        </View>
        {saveFailed ? (
          <Text accessibilityRole="alert" style={styles.saveError}>
            {t('saveError')}
          </Text>
        ) : null}
        <View style={styles.stats}>
          <Stat
            icon={Boxes}
            label={t('stock')}
            value={
              product.stock_quantity === null
                ? '–'
                : String(product.stock_quantity)
            }
            accessibleValue={
              product.stock_quantity === null
                ? t('untracked')
                : `${product.stock_quantity}, ${ts(product.stock_status)}`
            }
            color={
              product.stock_status === 'out'
                ? colors.danger
                : product.stock_status === 'low'
                  ? colors.warning
                  : colors.ink
            }
          />
          {product.cost_price != null ? (
            <Stat
              icon={ArrowDownToLine}
              label={t('cost')}
              value={formatVnd(product.cost_price)}
            />
          ) : null}
        </View>
        <UnitsRow product={product} isLead={isLead} />
        {description ? (
          <Text testID="product-description" style={styles.description}>
            {description}
          </Text>
        ) : null}
        {product.barcode ? (
          <Text style={styles.description}>Mã vạch · {product.barcode}</Text>
        ) : null}
        <ProductStock
          product={product}
          isLead={isLead}
          onAdjust={() => setAdjusting(true)}
        />
        <StockMovements productId={product.id} />
      </>
    );
  } else if (isError) {
    body = (
      <View style={styles.message}>
        <Text style={styles.messageText}>
          {t(notFound ? 'notFound' : 'error')}
        </Text>
        {notFound ? null : (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={t('retry')}
            onPress={retry}
            style={styles.retry}
          >
            <Text style={styles.retryText}>{t('retry')}</Text>
          </PressableScale>
        )}
      </View>
    );
  } else {
    body = <Skeleton />;
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top + space[4] }]}>
      <View style={styles.header}>
        <CircleButton
          icon={ChevronLeft}
          accessibilityLabel={t('back')}
          onPress={goBack}
        />
        {product && isLead ? (
          <CircleButton
            icon={Pencil}
            accessibilityLabel={t('edit')}
            onPress={openEdit}
          />
        ) : null}
      </View>
      <ScrollView
        testID="product-scroll"
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ gap: space[4], paddingBottom: space[6] }}
      >
        {body}
      </ScrollView>
      {adjusting && product && isLead ? (
        <AdjustStockSheet
          product={product}
          onClose={() => setAdjusting(false)}
        />
      ) : null}
      {editing && product ? (
        <EditPriceSheet
          price={editPrice}
          barcode={editBarcode}
          barcodeError={barcodeError}
          onBarcodeChange={() => setBarcodeError('')}
          saving={patch.isPending}
          onSave={save}
          onClose={closeEdit}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    gap: space[4],
    paddingHorizontal: space[4],
    paddingBottom: space[4],
    backgroundColor: colors.surface,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  /** Board 09: name and price share one line and wrap only when the name is long. */
  titleRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    columnGap: space[3],
  },
  name: { ...typography.heading, flexShrink: 1, color: colors.ink },
  price: { flexShrink: 0 },
  saveError: { ...typography.caption, color: colors.danger },
  stats: { flexDirection: 'row', gap: space[3] },
  /** Board 09: two equal chips, icon and figure on one row. */
  stat: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    padding: space[4],
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSoft,
  },
  statValue: {
    flexShrink: 1,
    fontFamily: fontFamily.extrabold,
    fontSize: 28,
    lineHeight: 34,
    color: colors.ink,
    fontVariant: ['tabular-nums'],
  },
  description: { ...typography.body, color: colors.inkMuted },
  skeleton: { gap: space[4] },
  skeletonPhoto: {
    height: 300,
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSoft,
  },
  skeletonLine: {
    height: 28,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceSoft,
  },
  message: { alignItems: 'center', gap: space[4], paddingTop: space[8] },
  messageText: {
    ...typography.body,
    color: colors.inkMuted,
    textAlign: 'center',
  },
  retry: {
    minHeight: 56,
    justifyContent: 'center',
    paddingHorizontal: space[6],
    borderRadius: radius.full,
    backgroundColor: colors.ink,
  },
  retryText: { ...typography.label, color: colors.onInk },
});
