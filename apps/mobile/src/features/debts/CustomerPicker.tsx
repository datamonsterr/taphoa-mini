import { Contact } from 'expo-contacts';
import { ContactRound } from 'lucide-react-native';
import { useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, TextInput, View } from 'react-native';

import { CircleButton, MoneyText, PressableScale, Text } from '@/components/ui';
import { useCreateCustomer, useCustomers, type Customer } from '@/lib/api';
import { listCustomers } from '@/lib/api/debts';
import { formatVnd } from '@/lib/format';
import { fill, useT } from '@/lib/i18n';
import { newUuid } from '@/lib/uuid';
import { colors, radius, size, space, typography } from '@/theme';

import { useInputStyle } from './DebtInput';
import { DebtSheet } from './DebtSheet';
import { debtStrings } from './strings';

export type CustomerPickerProps = {
  /** Create mode focuses on the form; both modes still check existing profiles. */
  mode?: 'select' | 'create';
  onSelect: (customer: Customer) => void;
  /** Called for a newly created profile; defaults to onSelect. */
  onCreate?: (customer: Customer) => void;
  onClose: () => void;
  initialName?: string;
  createLabel?: string;
};

const normalizeName = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd');
const normalizePhone = (value: string) =>
  value.replace(/\D/g, '').replace(/^(?:0084|84)(?=\d{9}$)/, '0');

export function CustomerPicker({
  mode = 'select',
  onSelect,
  onCreate = onSelect,
  onClose,
  initialName = '',
  createLabel,
}: CustomerPickerProps) {
  const t = useT(debtStrings);
  const inputStyle = useInputStyle();
  const [query, setQuery] = useState('');
  const [name, setName] = useState(initialName);
  const [phone, setPhone] = useState('');
  const [id, setId] = useState(newUuid);
  const [duplicates, setDuplicates] = useState<Customer[]>([]);
  const [checking, setChecking] = useState(false);
  const checkingRef = useRef(false);
  const [checkError, setCheckError] = useState(false);
  const [contactError, setContactError] = useState(false);
  const [picking, setPicking] = useState(false);
  const customers = useCustomers({ sort: 'recent', query });
  const create = useCreateCustomer();
  const busy = checking || create.isPending || picking;
  const label =
    createLabel ?? t(mode === 'create' ? 'create' : 'picker.creditCreate');

  const edit = () => {
    setId(newUuid());
    setDuplicates([]);
    setCheckError(false);
    create.reset();
  };
  const save = () =>
    create.mutate(
      {
        id,
        name: name.trim(),
        ...(phone.trim() ? { phone: phone.trim() } : {}),
      },
      { onSuccess: (customer) => onCreate(customer) },
    );

  const add = async () => {
    if (checkingRef.current || create.isPending || !name.trim()) return;
    checkingRef.current = true;
    setChecking(true);
    setCheckError(false);
    try {
      // Search is accent-sensitive on the server. Inspect every page so a normalized
      // match outside the recent/search results cannot silently create a duplicate.
      const matches: Customer[] = [];
      let cursor: string | null = null;
      do {
        const page = await listCustomers(cursor ? { cursor } : {});
        matches.push(
          ...(page.items ?? []).filter(
            (customer) =>
              customer.id !== id &&
              (normalizeName(customer.name) === normalizeName(name) ||
                (normalizePhone(phone) !== '' &&
                  normalizePhone(customer.phone ?? '') ===
                    normalizePhone(phone))),
          ),
        );
        cursor = page.next_cursor ?? null;
      } while (cursor);
      if (matches.length) setDuplicates(matches);
      else save();
    } catch {
      setCheckError(true);
    } finally {
      checkingRef.current = false;
      setChecking(false);
    }
  };

  const pickContact = async () => {
    setPicking(true);
    setContactError(false);
    try {
      // SDK 58: pick just one contact. No permission request or address-book listing.
      const contact = await Contact.presentPicker();
      if (contact) {
        const [fullName, phones] = await Promise.all([
          contact.getFullName(),
          contact.getPhones(),
        ]);
        edit();
        setName(fullName.slice(0, 80));
        setPhone((phones[0]?.number ?? '').slice(0, 20));
      }
    } catch {
      setContactError(true);
    } finally {
      setPicking(false);
    }
  };

  const customerRow = (customer: Customer, duplicate = false) => (
    <PressableScale
      key={customer.id}
      accessibilityRole="button"
      accessibilityLabel={`${duplicate ? `${t('picker.useExisting')}: ` : ''}${customer.name}, ${formatVnd(customer.balance)}`}
      onPress={() => onSelect(customer)}
      style={styles.row}
      disabled={busy}
    >
      <View style={styles.customerText}>
        <Text style={styles.label}>{customer.name}</Text>
        {customer.phone ? (
          <Text style={styles.caption}>{customer.phone}</Text>
        ) : null}
        <Text style={styles.caption}>
          {fill(t('picker.updated'), {
            date: new Date(customer.updated_at).toLocaleDateString('vi-VN', {
              timeZone: 'Asia/Ho_Chi_Minh',
            }),
          })}
        </Text>
      </View>
      <MoneyText amount={customer.balance} variant="label" />
    </PressableScale>
  );

  return (
    <DebtSheet
      title={t(mode === 'create' ? 'book.add' : 'picker.title')}
      onClose={onClose}
      footer={
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={label}
          disabled={!name.trim() || busy || duplicates.length > 0}
          onPress={() => void add()}
          style={[
            styles.primary,
            (!name.trim() || busy || duplicates.length > 0) && styles.disabled,
          ]}
        >
          {busy ? (
            <ActivityIndicator color={colors.onInk} />
          ) : (
            <Text style={styles.primaryText}>{label}</Text>
          )}
        </PressableScale>
      }
    >
      {mode === 'select' ? (
        <>
          <TextInput
            accessibilityLabel={t('search')}
            placeholder={t('search')}
            value={query}
            onChangeText={setQuery}
            style={inputStyle}
          />
          <Text style={styles.label}>{t('recent')}</Text>
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
          {customers.data?.map((customer) => customerRow(customer))}
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
        </>
      ) : null}
      <Text accessibilityRole="header" style={styles.label}>
        {t('picker.new')}
      </Text>
      <View style={styles.nameRow}>
        <TextInput
          accessibilityLabel={t('name')}
          placeholder={t('name')}
          maxLength={80}
          value={name}
          editable={!busy}
          onChangeText={(value) => {
            edit();
            setName(value);
          }}
          style={[inputStyle, styles.nameInput]}
        />
        <CircleButton
          icon={ContactRound}
          accessibilityLabel={t('picker.contact')}
          onPress={() => void pickContact()}
          disabled={busy}
        />
      </View>
      <TextInput
        accessibilityLabel={t('phone')}
        placeholder={t('phone')}
        maxLength={20}
        keyboardType="phone-pad"
        value={phone}
        editable={!busy}
        onChangeText={(value) => {
          edit();
          setPhone(value);
        }}
        style={inputStyle}
      />
      {contactError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {t('picker.contactError')}
        </Text>
      ) : null}
      {checkError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {t('picker.checkError')}
        </Text>
      ) : null}
      {create.isError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {t('createError')}
        </Text>
      ) : null}
      {duplicates.length ? (
        <View style={styles.duplicates}>
          <Text accessibilityRole="alert" style={styles.label}>
            {t('picker.duplicate')}
          </Text>
          {duplicates.map((customer) => customerRow(customer, true))}
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={t('picker.createAnyway')}
            onPress={save}
            disabled={busy}
            style={styles.row}
          >
            <Text>{t('picker.createAnyway')}</Text>
          </PressableScale>
        </View>
      ) : null}
    </DebtSheet>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: size.tapMin,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[3],
    paddingVertical: space[2],
  },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  nameInput: { flex: 1 },
  customerText: { flex: 1, gap: space[1] },
  label: { ...typography.label, color: colors.ink },
  caption: { ...typography.caption, color: colors.inkMuted },
  primary: {
    minHeight: size.tapLg,
    borderRadius: radius.full,
    backgroundColor: colors.ink,
    justifyContent: 'center',
    alignItems: 'center',
    padding: space[3],
  },
  primaryText: { ...typography.label, color: colors.onInk },
  disabled: { opacity: 0.4 },
  error: { ...typography.caption, color: colors.danger },
  duplicates: {
    padding: space[3],
    borderRadius: radius.md,
    backgroundColor: colors.surfaceSoft,
  },
});
