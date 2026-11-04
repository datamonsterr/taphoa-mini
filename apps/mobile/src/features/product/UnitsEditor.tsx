import { ChevronLeft } from 'lucide-react-native';
import { useState, type ReactNode } from 'react';
import { Modal, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon, PressableScale, Text } from '@/components/ui';
import { Field } from '@/features/sales/kit';
import type { Product, ProductUnit } from '@/lib/api/types';
import { useSaveUnit } from '@/lib/api/units';
import { formatVnd } from '@/lib/format';
import { fill, useT } from '@/lib/i18n';
import { newUuid } from '@/lib/uuid';
import { colors, radius, space, typography } from '@/theme';

import { unitStrings } from './unitStrings';

type Tone = 'soft' | 'ink' | 'danger';

/** Board 09b "pill": a 56 px row, radius 28, text on the left. */
function Pill({
  tone = 'soft',
  label,
  onPress,
  disabled = false,
  children,
}: {
  tone?: Tone;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.pill,
        tone === 'ink' && styles.pillInk,
        tone === 'danger' && styles.pillDanger,
        disabled && styles.disabled,
      ]}
    >
      <Text style={[styles.pillText, tone !== 'soft' && styles.pillTextOn]}>
        {children}
      </Text>
    </PressableScale>
  );
}

/** Names of the units the product sells in, the base unit first ("chai / lốc"). */
export const unitNames = (product: Product, separator = ' / ') =>
  [product.base_unit, ...product.units.map((unit) => unit.name)].join(
    separator,
  );

/**
 * Board 09: one compact row under the stats. The Lead opens the editor from it; a seller only
 * reads the units, because the server answers 403 to anyone else who edits them.
 */
export function UnitsRow({
  product,
  isLead,
}: {
  product: Product;
  isLead: boolean;
}) {
  const t = useT(unitStrings);
  const [open, setOpen] = useState(false);
  const text = `${t('title')} · ${unitNames(product)}`;
  return (
    <>
      {isLead ? (
        <Pill
          label={`${t('editUnits')}: ${unitNames(product)}`}
          onPress={() => setOpen(true)}
        >
          {`${text} · ${t('editShort')}`}
        </Pill>
      ) : (
        <View testID="units-readonly" style={styles.pill}>
          <Text style={styles.pillText}>{text}</Text>
        </View>
      )}
      {open ? (
        <UnitsEditor product={product} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

/** Board 09b: the units page. Opens over the product; the form shows under the unit it edits. */
export function UnitsEditor({
  product,
  onClose,
}: {
  product: Product;
  onClose: () => void;
}) {
  const t = useT(unitStrings);
  const insets = useSafeAreaInsets();
  const [editing, setEditing] = useState<ProductUnit | 'new' | null>(null);
  const name = product.name ?? '';
  return (
    <Modal animationType="slide" onRequestClose={onClose}>
      <ScrollView
        testID="units-page"
        style={styles.page}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[
          styles.content,
          {
            paddingTop: insets.top + space[4],
            paddingBottom: insets.bottom + space[8],
          },
        ]}
      >
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={fill(t('back'), { name })}
          onPress={onClose}
          style={[styles.pill, styles.back]}
        >
          <Icon icon={ChevronLeft} color={colors.ink} />
          <Text numberOfLines={1} style={styles.pillText}>
            {name}
          </Text>
        </PressableScale>
        <Text accessibilityRole="header" style={styles.heading}>
          {t('title')}
        </Text>
        <View style={styles.baseRow}>
          <Text style={styles.body}>
            {product.base_unit} · {formatVnd(product.price)}
          </Text>
          <Text style={styles.body}>{t('base')}</Text>
        </View>
        {product.units.map((unit) => (
          <View key={unit.id} style={styles.unit}>
            <Pill
              label={`${t('edit')} ${unit.name}`}
              onPress={() => setEditing(unit)}
            >
              {`${unit.name} · ${unit.quantity_in_base} ${product.base_unit} · ${formatVnd(unit.price)} · ${t('editShort')}`}
            </Pill>
            {editing !== 'new' && editing?.id === unit.id ? (
              <UnitForm
                key={unit.id}
                product={product}
                unit={unit}
                onClose={() => setEditing(null)}
              />
            ) : null}
          </View>
        ))}
        <Pill label={t('add')} onPress={() => setEditing('new')}>
          {t('add')}
        </Pill>
        {editing === 'new' ? (
          <UnitForm
            key="new"
            product={product}
            onClose={() => setEditing(null)}
          />
        ) : null}
        <Text style={styles.footnote}>
          {fill(t('footnote'), {
            choices: unitNames(product, ` ${t('or')} `),
          })}
        </Text>
      </ScrollView>
    </Modal>
  );
}

/** The add / edit form of a selling unit. */
export function UnitForm({
  product,
  unit,
  onClose,
}: {
  product: Product;
  unit?: ProductUnit;
  onClose: () => void;
}) {
  const t = useT(unitStrings);
  const [name, setName] = useState(unit?.name ?? '');
  const [quantity, setQuantity] = useState(
    unit ? String(unit.quantity_in_base) : '',
  );
  const [price, setPrice] = useState(unit ? String(unit.price) : '');
  const [deleting, setDeleting] = useState(false);
  const mutation = useSaveUnit(product);
  const count = Number(quantity),
    amount = Number(price);
  const valid =
    Boolean(name.trim()) &&
    name.trim().length <= 20 &&
    /^\d+$/.test(quantity) &&
    count >= 2 &&
    count <= 1000 &&
    /^\d+$/.test(price) &&
    Number.isSafeInteger(amount) &&
    amount >= 0 &&
    amount <= 1_000_000_000_000;
  const save = () => {
    if (!valid) return;
    mutation.mutate(
      {
        kind: unit ? 'update' : 'create',
        unit: {
          ...unit,
          id: unit?.id ?? newUuid(),
          name: name.trim(),
          quantity_in_base: count,
          price: amount,
        },
      },
      { onSuccess: onClose },
    );
  };
  return (
    <View testID="unit-form" style={styles.form}>
      <Field
        label={t('name')}
        value={name}
        onChangeText={setName}
        maxLength={20}
        editable={!mutation.isPending}
        style={styles.input}
      />
      <Field
        label={fill(t('quantity'), { base: product.base_unit })}
        value={quantity}
        onChangeText={setQuantity}
        keyboardType="number-pad"
        editable={!mutation.isPending}
        style={styles.input}
      />
      <Field
        label={t('price')}
        value={price}
        onChangeText={setPrice}
        keyboardType="number-pad"
        editable={!mutation.isPending}
        style={styles.input}
      />
      {!valid ? <Text style={styles.body}>{t('invalid')}</Text> : null}
      {mutation.isError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {t('failed')}
        </Text>
      ) : null}
      <Pill
        tone="ink"
        label={t('save')}
        disabled={!valid || mutation.isPending}
        onPress={save}
      >
        {t('save')}
      </Pill>
      {unit && !deleting ? (
        <Pill
          tone="danger"
          label={t('delete')}
          disabled={mutation.isPending}
          onPress={() => setDeleting(true)}
        >
          {t('delete')}
        </Pill>
      ) : null}
      {unit && deleting ? (
        <View accessibilityViewIsModal style={styles.confirm}>
          <Text style={styles.body}>{t('deleting')}</Text>
          <Pill
            tone="danger"
            label={t('confirm')}
            disabled={mutation.isPending}
            onPress={() =>
              mutation.mutate(
                { kind: 'delete', id: unit.id },
                { onSuccess: onClose },
              )
            }
          >
            {t('confirm')}
          </Pill>
          <Pill
            label={t('cancel')}
            disabled={mutation.isPending}
            onPress={() => setDeleting(false)}
          >
            {t('cancel')}
          </Pill>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.surface },
  content: { paddingHorizontal: space[4], gap: 20 },
  pill: {
    minHeight: 56,
    justifyContent: 'center',
    padding: space[4],
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSoft,
  },
  pillInk: { backgroundColor: colors.ink },
  pillDanger: { backgroundColor: colors.danger },
  pillText: { ...typography.body, flexShrink: 1, color: colors.ink },
  pillTextOn: { color: colors.onInk },
  disabled: { opacity: 0.45 },
  back: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  heading: { ...typography.heading, color: colors.ink },
  baseRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: space[3],
  },
  body: { ...typography.body, color: colors.ink },
  unit: { gap: 20 },
  form: { gap: 20 },
  confirm: { gap: space[3] },
  input: { borderColor: colors.lineStrong, borderRadius: radius.sm },
  error: { ...typography.body, color: colors.danger },
  footnote: { ...typography.caption, color: colors.ink },
});
