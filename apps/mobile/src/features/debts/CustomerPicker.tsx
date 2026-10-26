import { useState } from 'react';
import { ActivityIndicator, StyleSheet, TextInput, View } from 'react-native';
import { PressableScale, Sheet, Text, MoneyText } from '@/components/ui';
import { useCreateCustomer, useCustomers, type Customer } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { formatVnd } from '@/lib/format';
import { newUuid } from '@/lib/uuid';
import { colors, radius, space, typography } from '@/theme';
import { debtStrings } from './strings';

export function CustomerPicker({
  onSelect,
  onClose,
}: {
  onSelect: (customer: Customer) => void;
  onClose: () => void;
}) {
  const t = useT(debtStrings);
  const [query, setQuery] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [id, setId] = useState(newUuid);
  const customers = useCustomers({ sort: 'recent', query });
  const create = useCreateCustomer();
  const add = () =>
    create.mutate(
      {
        id,
        name: name.trim(),
        ...(phone.trim() ? { phone: phone.trim() } : {}),
      },
      { onSuccess: (customer) => onSelect(customer) },
    );
  return (
    <Sheet onClose={onClose} height={620}>
      <TextInput
        accessibilityLabel={t('search')}
        placeholder={t('search')}
        value={query}
        onChangeText={setQuery}
        style={styles.input}
      />
      <Text>{t('recent')}</Text>
      {customers.isPending ? (
        <ActivityIndicator accessibilityLabel={t('loading')} />
      ) : null}
      {customers.isError ? (
        <View>
          <Text accessibilityRole="alert">{t('error')}</Text>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={t('retry')}
            onPress={() => void customers.refetch()}
            style={styles.row}
          >
            <Text>{t('retry')}</Text>
          </PressableScale>
        </View>
      ) : null}
      {customers.data?.length === 0 ? <Text>{t('empty')}</Text> : null}
      {customers.data?.map((customer) => (
        <PressableScale
          key={customer.id}
          accessibilityRole="button"
          accessibilityLabel={`${customer.name}, ${formatVnd(customer.balance)}`}
          onPress={() => onSelect(customer)}
          style={styles.row}
        >
          <Text style={styles.name}>{customer.name}</Text>
          <MoneyText amount={customer.balance} />
        </PressableScale>
      ))}
      {customers.hasNextPage ? (
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={t('more')}
          onPress={() => void customers.fetchNextPage()}
          disabled={customers.isFetchingNextPage}
          style={styles.row}
        >
          <Text>{t('more')}</Text>
        </PressableScale>
      ) : null}
      <TextInput
        accessibilityLabel={t('name')}
        placeholder={t('name')}
        maxLength={80}
        value={name}
        onChangeText={(value) => {
          setName(value);
          setId(newUuid());
        }}
        style={styles.input}
      />
      <TextInput
        accessibilityLabel={t('phone')}
        placeholder={t('phone')}
        maxLength={20}
        keyboardType="phone-pad"
        value={phone}
        onChangeText={(value) => {
          setPhone(value);
          setId(newUuid());
        }}
        style={styles.input}
      />
      {create.isError ? (
        <Text accessibilityRole="alert">{t('createError')}</Text>
      ) : null}
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={t('create')}
        disabled={!name.trim() || create.isPending}
        onPress={add}
        style={styles.row}
      >
        <Text>{t('create')}</Text>
      </PressableScale>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={t('close')}
        onPress={onClose}
        style={styles.row}
      >
        <Text>{t('close')}</Text>
      </PressableScale>
    </Sheet>
  );
}
const styles = StyleSheet.create({
  input: {
    ...typography.body,
    color: colors.ink,
    minHeight: 48,
    borderWidth: 1,
    borderColor: colors.inkMuted,
    borderRadius: radius.md,
    padding: space[3],
  },
  row: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[3],
    paddingVertical: space[2],
  },
  name: { flex: 1 },
});
