import { Camera, ChevronDown, ShoppingCart } from 'lucide-react-native';
import { memo, useCallback } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import Animated, {
  FadeInDown,
  FadeOutDown,
  LayoutAnimationConfig,
  LinearTransition,
} from 'react-native-reanimated';
import { useShallow } from 'zustand/react/shallow';

import {
  CircleButton,
  Icon,
  MoneyText,
  QrPill,
  Sheet,
  Stepper,
  Text,
  type StepperLabels,
} from '@/components/ui';
import {
  cartLineKey,
  selectCount,
  selectLines,
  selectTotal,
  useCartStore,
} from '@/stores/cart';
import type { CartLine } from '@/stores/cart';
import {
  colors,
  fontFamily,
  radius,
  shadows,
  space,
  typography,
} from '@/theme';

import { useLabels, useT, fill } from '@/lib/i18n';

import { LineThumb } from './LineThumb';
import { UnitChooser } from './UnitChooser';
import { cartStrings } from './strings';

const SHEET_HEIGHT = 660;

type CartRowProps = {
  line: CartLine;
  first: boolean;
  onIncrement: (productId: string) => void;
  onDecrement: (productId: string) => void;
  onRemove: (productId: string) => void;
  labels: StepperLabels;
};

const CartRow = memo(function CartRow({
  line,
  first,
  onIncrement,
  onDecrement,
  onRemove,
  labels,
}: CartRowProps) {
  const productId = cartLineKey(line);
  const inc = useCallback(
    () => onIncrement(productId),
    [onIncrement, productId],
  );
  const dec = useCallback(
    () => onDecrement(productId),
    [onDecrement, productId],
  );
  const rm = useCallback(() => onRemove(productId), [onRemove, productId]);
  return (
    <Animated.View
      entering={FadeInDown}
      exiting={FadeOutDown}
      layout={LinearTransition}
      testID={`cart-line-${line.productId}${line.unitId ? `-${line.unitId}` : ''}`}
      style={[styles.line, !first && styles.divider]}
    >
      <LineThumb uri={line.imageUrl} />
      <View style={styles.lineBody}>
        <Text numberOfLines={2} ellipsizeMode="tail" style={styles.lineName}>
          {line.name}
        </Text>
        <UnitChooser line={line} />
        <MoneyText
          amount={line.price}
          variant="label"
          style={styles.linePrice}
        />
      </View>
      <Stepper
        value={line.qty}
        onIncrement={inc}
        onDecrement={dec}
        onRemove={rm}
        labels={labels}
      />
    </Animated.View>
  );
});

const stepperLabels = (t: (key: string) => string): StepperLabels => ({
  remove: t('stepper.remove'),
  decrement: t('stepper.decrement'),
  increment: t('stepper.increment'),
  quantity: (n) => fill(t('stepper.quantity'), { n }),
});

export function CartScreen() {
  const t = useT(cartStrings);
  const labels = useLabels(cartStrings, stepperLabels);
  const router = useRouter();
  const lines = useCartStore(useShallow(selectLines));
  const count = useCartStore(selectCount);
  const total = useCartStore(selectTotal);
  const { increment, decrement, remove } = useCartStore.getState();

  const close = useCallback(() => router.back(), [router]);
  const pay = useCallback(() => router.push('/pay'), [router]);

  return (
    <Sheet
      height={SHEET_HEIGHT}
      scrollable={false}
      onClose={close}
      testID="cart-sheet"
    >
      <View style={styles.header}>
        <CircleButton
          icon={ChevronDown}
          accessibilityLabel={t('close')}
          onPress={close}
        />
        <View style={styles.spacer} />
        <View
          accessible
          accessibilityLabel={fill(t('count'), { n: count })}
          style={styles.badge}
        >
          <Icon icon={ShoppingCart} size={18} color={colors.onAccent} />
          <Text style={styles.badgeText}>{count}</Text>
        </View>
      </View>
      {lines.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>{t('empty')}</Text>
          <CircleButton
            icon={Camera}
            variant="ink"
            large
            accessibilityLabel={t('backToCamera')}
            onPress={close}
          />
        </View>
      ) : (
        <>
          <ScrollView style={styles.list}>
            {/* Rows present at mount skip `entering`: on Android it can leave
                them at opacity 0 while the sheet slides in. Later additions
                and all removals still animate. */}
            <LayoutAnimationConfig skipEntering>
              {lines.map((line, index) => (
                <CartRow
                  key={cartLineKey(line)}
                  line={line}
                  first={index === 0}
                  onIncrement={increment}
                  onDecrement={decrement}
                  onRemove={remove}
                  labels={labels}
                />
              ))}
            </LayoutAnimationConfig>
          </ScrollView>
          <View style={styles.totalBar}>
            <View style={styles.totalSum}>
              <MoneyText
                amount={total}
                variant="title"
                style={styles.totalText}
              />
            </View>
            <QrPill onPress={pay} />
          </View>
        </>
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: space[3] },
  spacer: { flex: 1 },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[1],
    height: 40,
    paddingHorizontal: space[4],
    borderRadius: radius.full,
    backgroundColor: colors.accent,
  },
  badgeText: {
    ...typography.label,
    color: colors.onAccent,
    fontVariant: ['tabular-nums'],
  },
  list: { flex: 1 },
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    paddingVertical: space[3],
  },
  divider: { borderTopWidth: 1, borderTopColor: colors.surfacePressed },
  lineBody: { flex: 1, minWidth: 0 },
  lineName: { ...typography.label, flexShrink: 1, color: colors.ink },
  linePrice: {
    flexShrink: 0,
    fontFamily: fontFamily.bold,
    fontSize: 20,
    lineHeight: 26,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[4],
  },
  emptyText: { ...typography.heading, color: colors.inkMuted },
  totalBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    paddingVertical: space[2],
    paddingLeft: space[6],
    paddingRight: space[2],
    borderRadius: radius.full,
    backgroundColor: colors.surface,
    ...shadows.float,
  },
  totalSum: { flex: 1 },
  totalText: { fontSize: 34, lineHeight: 38, letterSpacing: -0.5 },
});
