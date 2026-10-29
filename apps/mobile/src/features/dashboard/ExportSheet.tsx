import { useState } from 'react';
import { Modal, View } from 'react-native';
import { Sheet, Text, PressableScale } from '@/components/ui';
import { exportTransactions } from '@/lib/api/salesActions';
import { businessDate, startOfMonth, isDateString } from '@/lib/date';
import { useT } from '@/lib/i18n';
import { Action, Field, styles } from '@/features/sales/kit';
import { transactionStrings } from './transactionStrings';
import { shareExport } from './shareExport';

export function ExportSheet({ onClose }: { onClose: () => void }) {
  const t = useT(transactionStrings);
  const today = businessDate();
  const [from, setFrom] = useState(startOfMonth(today));
  const [to, setTo] = useState(today);
  const [format, setFormat] = useState<'csv' | 'xlsx'>('csv');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const valid = isDateString(from) && isDateString(to) && from <= to;
  const download = async () => {
    if (busy || !valid) return;
    setBusy(true);
    setFailed(false);
    try {
      const bytes = await exportTransactions({ from, to, format });
      await shareExport(
        bytes,
        `giao-dich-${from}-${to}.${format}`,
        format === 'csv'
          ? 'text/csv'
          : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      onClose();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  // A Modal draws above the shop tab bar; the Sheet animates itself.
  return (
    <Modal
      transparent
      animationType="none"
      onRequestClose={() => {
        if (!busy) onClose();
      }}
    >
      <Sheet
        onClose={() => {
          if (!busy) onClose();
        }}
        testID="export-sheet"
      >
        <Text accessibilityRole="header" style={styles.heading}>
          {t('export')}
        </Text>
        <Field
          label={t('from')}
          value={from}
          onChangeText={setFrom}
          placeholder="YYYY-MM-DD"
          maxLength={10}
          editable={!busy}
        />
        <Field
          label={t('to')}
          value={to}
          onChangeText={setTo}
          placeholder="YYYY-MM-DD"
          maxLength={10}
          editable={!busy}
        />
        {!valid ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {t('invalidRange')}
          </Text>
        ) : null}
        <View
          accessibilityRole="radiogroup"
          accessibilityLabel={t('format')}
          style={{ gap: 8 }}
        >
          {(['csv', 'xlsx'] as const).map((value) => (
            <PressableScale
              key={value}
              accessibilityRole="radio"
              accessibilityLabel={value.toUpperCase()}
              accessibilityState={{ checked: format === value, disabled: busy }}
              disabled={busy}
              onPress={() => setFormat(value)}
              style={styles.card}
            >
              <Text>
                {format === value ? '● ' : '○ '}
                {value.toUpperCase()}
              </Text>
            </PressableScale>
          ))}
        </View>
        {failed ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {t('exportFailed')}
          </Text>
        ) : null}
        <Action
          label={busy ? t('loading') : t('share')}
          disabled={!valid || busy}
          onPress={() => void download()}
        />
        <Action label={t('close')} disabled={busy} onPress={onClose} />
      </Sheet>
    </Modal>
  );
}
