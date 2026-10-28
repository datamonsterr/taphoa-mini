import { useState } from 'react';
import { Modal, View } from 'react-native';
import { MoneyText, Sheet, Text } from '@/components/ui';
import type { Product, ProductUnit } from '@/lib/api/types';
import { useSaveUnit } from '@/lib/api/units';
import { useT } from '@/lib/i18n';
import { newUuid } from '@/lib/uuid';
import { Action, Field, styles } from '@/features/sales/kit';
import { unitStrings } from './unitStrings';

export function UnitsEditor({ product }: { product: Product }) {
  const t = useT(unitStrings);
  const [editing, setEditing] = useState<ProductUnit | 'new' | null>(null);
  return (
    <View style={styles.card}>
      <Text accessibilityRole="header" style={styles.heading}>
        {t('title')}
      </Text>
      <Text>
        {product.base_unit} · {t('base')}
      </Text>
      {product.units.map((unit) => (
        <View key={unit.id} style={{ gap: 8 }}>
          <Text>
            {unit.name} · {unit.quantity_in_base} {product.base_unit}
          </Text>
          <MoneyText amount={unit.price} variant="label" />
          <Action
            label={`${t('edit')} ${unit.name}`}
            onPress={() => setEditing(unit)}
          />
        </View>
      ))}
      <Action label={t('add')} onPress={() => setEditing('new')} />
      {editing ? (
        <UnitSheet
          product={product}
          unit={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </View>
  );
}

export function UnitSheet({
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
    <Modal
      transparent
      animationType="slide"
      onRequestClose={() => {
        if (!mutation.isPending) onClose();
      }}
    >
      <Sheet
        onClose={() => {
          if (!mutation.isPending) onClose();
        }}
        testID="unit-sheet"
      >
        <Text accessibilityRole="header" style={styles.heading}>
          {t(unit ? 'edit' : 'add')}
        </Text>
        <Field
          label={t('name')}
          value={name}
          onChangeText={setName}
          maxLength={20}
          editable={!mutation.isPending}
        />
        <Field
          label={`${t('quantity')} (${product.base_unit})`}
          value={quantity}
          onChangeText={setQuantity}
          keyboardType="number-pad"
          editable={!mutation.isPending}
        />
        <Field
          label={t('price')}
          value={price}
          onChangeText={setPrice}
          keyboardType="number-pad"
          editable={!mutation.isPending}
        />
        {!valid ? <Text style={styles.body}>{t('invalid')}</Text> : null}
        {mutation.isError ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {t('failed')}
          </Text>
        ) : null}
        <Action
          label={t('save')}
          disabled={!valid || mutation.isPending}
          onPress={save}
        />
        {unit && !deleting ? (
          <Action
            label={t('delete')}
            disabled={mutation.isPending}
            danger
            onPress={() => setDeleting(true)}
          />
        ) : null}
        {unit && deleting ? (
          <View accessibilityViewIsModal style={styles.card}>
            <Text>{t('deleting')}</Text>
            <Action
              label={t('confirm')}
              danger
              disabled={mutation.isPending}
              onPress={() =>
                mutation.mutate(
                  { kind: 'delete', id: unit.id },
                  { onSuccess: onClose },
                )
              }
            />
            <Action
              label={t('cancel')}
              disabled={mutation.isPending}
              onPress={() => setDeleting(false)}
            />
          </View>
        ) : null}
        <Action
          label={t('close')}
          disabled={mutation.isPending}
          onPress={onClose}
        />
      </Sheet>
    </Modal>
  );
}
