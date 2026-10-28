import { Check, Tag } from 'lucide-react-native';
import { memo, useCallback } from 'react';
import { StyleSheet, View } from 'react-native';

import { AlternativesStrip } from '@/components/camera/AlternativesStrip';
import {
  Icon,
  MoneyText,
  PressableScale,
  Stepper,
  Text,
  type StepperLabels,
} from '@/components/ui';
import { fill, useLabels, useT } from '@/lib/i18n';
import { colors, fontFamily, radius, space, typography } from '@/theme';

import { LineThumb } from '../checkout/LineThumb';
import type { DraftLine } from './draft';
import { voiceStrings } from './strings';

export type DraftLineRowProps = {
  line: DraftLine;
  /** Show the three-candidate strip (ambiguous lines). */
  expanded: boolean;
  onIncrement: (id: string) => void;
  onDecrement: (id: string) => void;
  onRemove: (id: string) => void;
  onToggleCandidates: (id: string) => void;
  onPick: (id: string, productId: string) => void;
  onEditPrice: (id: string) => void;
  onSearch: (id: string) => void;
};

const stepperLabels = (t: (key: string) => string): StepperLabels => ({
  remove: t('stepper.remove'),
  decrement: t('stepper.decrement'),
  increment: t('stepper.increment'),
  quantity: (n) => fill(t('stepper.quantity'), { n }),
});

/** One line of the voice draft: cart-like, with a status chip on the thumbnail. */
export const DraftLineRow = memo(function DraftLineRow({
  line,
  expanded,
  onIncrement,
  onDecrement,
  onRemove,
  onToggleCandidates,
  onPick,
  onEditPrice,
  onSearch,
}: DraftLineRowProps) {
  const t = useT(voiceStrings);
  const labels = useLabels(voiceStrings, stepperLabels);
  const { id, status } = line;
  const name = line.product?.name || line.spoken;
  const inc = useCallback(() => onIncrement(id), [onIncrement, id]);
  const dec = useCallback(() => onDecrement(id), [onDecrement, id]);
  const rm = useCallback(() => onRemove(id), [onRemove, id]);
  const price = useCallback(() => onEditPrice(id), [onEditPrice, id]);
  const choose = useCallback(
    (productId: string) => onPick(id, productId),
    [onPick, id],
  );
  const badge = useCallback(() => {
    if (status === 'ambiguous') onToggleCandidates(id);
    else if (status === 'unknown') onSearch(id);
  }, [status, onToggleCandidates, onSearch, id]);

  const badgeLabel =
    status === 'matched'
      ? t('matched')
      : status === 'ambiguous'
        ? t('ambiguous')
        : t('unknown');
  const priceLabel =
    line.unitPrice === null ? t('setPrice') : `${t('setPrice')} ${name}`;
  const hasPrice = line.unitPrice !== null;

  return (
    <View testID={`voice-line-${id}`}>
      <View style={[styles.line, status === 'ambiguous' && styles.ambiguous]}>
        <PressableScale
          testID={`voice-line-${id}-badge`}
          accessibilityRole={status === 'matched' ? 'image' : 'button'}
          accessibilityLabel={badgeLabel}
          disabled={status === 'matched'}
          onPress={badge}
          style={styles.thumbBox}
        >
          <LineThumb uri={line.product?.imageUrl} />
          <View
            style={[
              styles.badge,
              status === 'matched' && styles.badgeOk,
              status === 'ambiguous' && styles.badgeWarn,
              status === 'unknown' && styles.badgeMute,
            ]}
          >
            {status === 'matched' ? (
              <Icon icon={Check} size={14} color={colors.onInk} />
            ) : status === 'ambiguous' ? (
              <Text style={styles.badgeMark}>?</Text>
            ) : (
              <Icon icon={Tag} size={14} color={colors.onInk} />
            )}
          </View>
        </PressableScale>
        <View style={styles.body}>
          <Text numberOfLines={1} style={styles.name}>
            {name}
          </Text>
          <View style={styles.priceRow}>
            <PressableScale
              testID={`voice-line-${id}-price`}
              accessibilityRole="button"
              accessibilityLabel={priceLabel}
              onPress={price}
              style={styles.priceButton}
            >
              {hasPrice ? (
                <MoneyText
                  amount={line.unitPrice!}
                  variant="label"
                  color={line.priceMismatch ? colors.danger : colors.ink}
                />
              ) : (
                <Text style={styles.needsPrice}>{t('setPrice')}</Text>
              )}
            </PressableScale>
            {line.priceMismatch ? (
              <View
                accessible
                accessibilityLabel={t('mismatchLabel')}
                style={styles.pill}
              >
                <Text style={styles.pillText}>{t('mismatch')}</Text>
              </View>
            ) : null}
          </View>
        </View>
        <Stepper
          value={line.quantity}
          onIncrement={inc}
          onDecrement={dec}
          onRemove={rm}
          labels={labels}
        />
      </View>
      {expanded && status === 'ambiguous' ? (
        <AlternativesStrip
          items={line.candidates.map((c) => ({
            id: c.id,
            name: c.name,
            price: c.price,
            ...(c.imageUrl ? { thumbnailUri: c.imageUrl } : {}),
          }))}
          currentId={line.product?.id ?? ''}
          placement="below"
          onChoose={choose}
        />
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    padding: space[2],
    borderRadius: radius.md,
  },
  ambiguous: { backgroundColor: colors.warningSoft },
  thumbBox: { minWidth: 64, minHeight: 64 },
  badge: {
    position: 'absolute',
    right: -6,
    bottom: -6,
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
    borderWidth: 2,
    borderColor: colors.surface,
  },
  badgeOk: { backgroundColor: colors.success },
  badgeWarn: { backgroundColor: colors.warning },
  badgeMute: { backgroundColor: colors.inkMuted },
  badgeMark: {
    fontFamily: fontFamily.extrabold,
    fontSize: 14,
    lineHeight: 18,
    color: colors.onInk,
  },
  body: { flex: 1, minWidth: 0, gap: 2 },
  name: { ...typography.label, color: colors.ink },
  priceRow: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  priceButton: { minHeight: 44, justifyContent: 'center' },
  needsPrice: { ...typography.label, color: colors.accent },
  pill: {
    paddingHorizontal: space[2],
    paddingVertical: 2,
    borderRadius: radius.full,
    backgroundColor: colors.dangerSoft,
  },
  pillText: { ...typography.caption, color: colors.danger },
});
