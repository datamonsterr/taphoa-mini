import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { CheckButton, Switch, Text } from '@/components/ui';
import {
  useUpdateCustomer,
  type Customer,
  type UpdateCustomerRequest,
} from '@/lib/api';
import { useT } from '@/lib/i18n';
import { colors, space, typography } from '@/theme';

import { digitsOnly } from './amount';
import { DebtInput } from './DebtInput';
import { DebtSheet } from './DebtSheet';
import { debtStrings } from './strings';

/** Only the fields that changed, as a merge patch; empty optional fields become `null`. */
function buildPatch(
  customer: Customer,
  next: {
    name: string;
    phone: string;
    note: string;
    limit: string;
    archived: boolean;
  },
  canArchive: boolean,
): UpdateCustomerRequest {
  const patch: UpdateCustomerRequest = {};
  const name = next.name.trim();
  if (name !== customer.name) patch.name = name;
  const phone = next.phone.trim() || null;
  if (phone !== customer.phone) patch.phone = phone;
  const note = next.note.trim() || null;
  if (note !== customer.note) patch.note = note;
  const limit = next.limit === '' ? null : Number(next.limit);
  if (limit !== customer.credit_limit) patch.credit_limit = limit;
  if (canArchive && next.archived !== customer.archived)
    patch.archived = next.archived;
  return patch;
}

/**
 * Profile edit for every member: name, phone, note and credit limit. The Lead also sees the
 * archive switch (`archived` is a Lead-only field on the server).
 */
export function EditCustomerSheet({
  customer,
  canArchive,
  onClose,
}: {
  customer: Customer;
  canArchive: boolean;
  onClose: () => void;
}) {
  const t = useT(debtStrings);
  const update = useUpdateCustomer(customer.id);
  const [name, setName] = useState(customer.name);
  const [phone, setPhone] = useState(customer.phone ?? '');
  const [note, setNote] = useState(customer.note ?? '');
  const [limit, setLimit] = useState(
    customer.credit_limit === null ? '' : String(customer.credit_limit),
  );
  const [archived, setArchived] = useState(customer.archived);
  const patch = buildPatch(
    customer,
    { name, phone, note, limit, archived },
    canArchive,
  );
  const canSave =
    name.trim().length > 0 &&
    Object.keys(patch).length > 0 &&
    !update.isPending;

  return (
    <DebtSheet
      title={t('edit.title')}
      onClose={onClose}
      footer={
        <CheckButton
          variant="ink"
          block
          accessibilityLabel={t('edit.save')}
          disabled={!canSave}
          onPress={() => update.mutate(patch, { onSuccess: onClose })}
        />
      }
    >
      <DebtInput
        label={t('name')}
        maxLength={80}
        value={name}
        onChangeText={setName}
      />
      <DebtInput
        label={t('phone')}
        maxLength={20}
        keyboardType="phone-pad"
        value={phone}
        onChangeText={setPhone}
      />
      <DebtInput
        label={t('edit.note')}
        maxLength={200}
        multiline
        value={note}
        onChangeText={setNote}
      />
      <DebtInput
        label={t('edit.limit')}
        keyboardType="number-pad"
        value={limit}
        onChangeText={(text) => setLimit(digitsOnly(text))}
      />
      {canArchive ? (
        <View style={styles.archive}>
          <Text style={styles.archiveLabel}>{t('edit.archive')}</Text>
          <Switch
            accessibilityLabel={t('edit.archive')}
            value={archived}
            onValueChange={setArchived}
          />
        </View>
      ) : null}
      {update.isError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {t('edit.error')}
        </Text>
      ) : null}
    </DebtSheet>
  );
}

const styles = StyleSheet.create({
  archive: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[3],
  },
  archiveLabel: { ...typography.label, flex: 1, color: colors.ink },
  error: { ...typography.caption, color: colors.danger },
});
