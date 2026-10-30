import { ChevronDown } from 'lucide-react-native';
import { memo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import {
  CheckButton,
  CircleButton,
  MoneyText,
  PayToggle,
  PressableScale,
  Text,
  type PayMethod,
} from '@/components/ui';
import { fill, useLabels, useT } from '@/lib/i18n';
import { colors, radius, size, space, typography } from '@/theme';

import { DraftLineRow } from './DraftLineRow';
import {
  activeLines,
  blocker,
  draftTotal,
  type Draft,
  type DraftAction,
} from './draft';
import { voiceStrings } from './strings';
import { VoiceMicButton } from './VoiceMicButton';

export type DraftViewProps = {
  draft: Draft;
  transcript: string;
  dispatch: (action: DraftAction) => void;
  expandedId: string | null;
  onToggleCandidates: (id: string) => void;
  onEditPrice: (id: string) => void;
  onSearch: (id: string) => void;
  onAddNew: (id: string) => void;
  onChooseCustomer: () => void;
  /** A second utterance is being recorded or parsed. */
  adding: 'idle' | 'listening' | 'understanding';
  micMode: 'hold' | 'toggle';
  onMicStart: () => void;
  onMicStop: () => void;
  saving: boolean;
  /** A message under the draft (a failed save or a failed extra utterance). */
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
};

const payLabels = (t: (key: string) => string) => ({
  group: t('pay.group'),
  transfer: t('pay.transfer'),
  cash: t('pay.cash'),
  credit: t('pay.credit'),
});

/** Board 16: transcript, lines, total, payment, microphone and the green check. */
export const DraftView = memo(function DraftView({
  draft,
  transcript,
  dispatch,
  expandedId,
  onToggleCandidates,
  onEditPrice,
  onSearch,
  onAddNew,
  onChooseCustomer,
  adding,
  micMode,
  onMicStart,
  onMicStop,
  saving,
  error,
  onConfirm,
  onClose,
}: DraftViewProps) {
  const t = useT(voiceStrings);
  const pay = useLabels(voiceStrings, payLabels);
  const [fullTranscript, setFullTranscript] = useState(false);
  const lines = activeLines(draft);
  const reason = blocker(draft);
  const disabled = reason !== null || saving || adding !== 'idle';
  return (
    <View testID="voice-draft" style={styles.root}>
      <View style={styles.header}>
        <CircleButton
          icon={ChevronDown}
          accessibilityLabel={t('close')}
          onPress={onClose}
          testID="voice-close"
        />
        <PressableScale
          testID="voice-draft-transcript"
          accessibilityRole="button"
          accessibilityLabel={`${t('transcript')}: ${transcript}`}
          accessibilityHint={t('transcriptFull')}
          onPress={() => setFullTranscript((open) => !open)}
          style={styles.transcriptBox}
        >
          <Text
            numberOfLines={fullTranscript ? undefined : 2}
            style={styles.transcript}
          >
            {`“${transcript}”`}
          </Text>
        </PressableScale>
      </View>
      <ScrollView
        style={styles.list}
        contentContainerStyle={styles.listContent}
        keyboardShouldPersistTaps="handled"
      >
        {lines.map((line) => (
          <DraftLineRow
            key={line.id}
            line={line}
            expanded={expandedId === line.id}
            onIncrement={(id) => dispatch({ type: 'increment', id })}
            onDecrement={(id) => dispatch({ type: 'decrement', id })}
            onRemove={(id) => dispatch({ type: 'remove', id })}
            onToggleCandidates={onToggleCandidates}
            onPick={(id, productId) => {
              dispatch({ type: 'pick', id, productId });
              onToggleCandidates(id);
            }}
            onEditPrice={onEditPrice}
            onSearch={onSearch}
            onAddNew={onAddNew}
          />
        ))}
      </ScrollView>
      <View style={styles.footer}>
        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>{t('total')}</Text>
          <MoneyText
            testID="voice-total"
            amount={draftTotal(draft)}
            variant="price"
          />
        </View>
        <View style={styles.toggle}>
          <PayToggle
            value={draft.paymentMethod as PayMethod}
            onChange={(method) => dispatch({ type: 'payment', method })}
            labels={pay}
          />
        </View>
        {draft.paymentMethod === 'credit' ? (
          <PressableScale
            testID="voice-customer"
            accessibilityRole="button"
            accessibilityLabel={
              draft.customer ? t('customer.change') : t('customer.choose')
            }
            onPress={onChooseCustomer}
            style={styles.customer}
          >
            <Text numberOfLines={1} style={styles.customerText}>
              {draft.customer
                ? `${fill(t('customer.named'), { name: draft.customer.name })} · ${t('customer.change')}`
                : draft.spokenCustomer
                  ? `${t('customer.choose')} (${fill(t('customer.spoken'), { name: draft.spokenCustomer })})`
                  : t('customer.choose')}
            </Text>
          </PressableScale>
        ) : null}
        {reason && reason !== 'empty' ? (
          <Text accessibilityRole="alert" style={styles.blocker}>
            {t(`blocker.${reason}`)}
          </Text>
        ) : null}
        {error ? (
          <Text accessibilityRole="alert" style={styles.blocker}>
            {error}
          </Text>
        ) : null}
        <View style={styles.actions}>
          <VoiceMicButton
            mode={micMode}
            listening={adding === 'listening'}
            disabled={adding === 'understanding' || saving}
            onStart={onMicStart}
            onStop={onMicStop}
          />
          {adding === 'understanding' ? (
            <Text accessibilityLiveRegion="polite" style={styles.adding}>
              {t('understanding')}
            </Text>
          ) : (
            <View style={styles.grow}>
              <CheckButton
                variant="success"
                accessibilityLabel={t('confirm')}
                onPress={onConfirm}
                disabled={disabled}
                block
              />
            </View>
          )}
        </View>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  root: { flex: 1, gap: space[2] },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: space[3] },
  transcriptBox: { flex: 1, minHeight: size.tapMin, justifyContent: 'center' },
  transcript: {
    ...typography.caption,
    fontStyle: 'italic',
    color: colors.inkMuted,
  },
  list: { flex: 1 },
  listContent: { gap: space[1] },
  footer: { gap: space[2] },
  totalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  toggle: { alignItems: 'center' },
  totalLabel: { ...typography.label, color: colors.inkMuted },
  customer: {
    minHeight: size.tapMin,
    justifyContent: 'center',
    paddingHorizontal: space[4],
    borderRadius: radius.full,
    backgroundColor: colors.surfaceSoft,
  },
  customerText: { ...typography.label, color: colors.ink },
  blocker: { ...typography.caption, color: colors.danger },
  actions: { flexDirection: 'row', alignItems: 'center', gap: space[3] },
  grow: { flex: 1 },
  adding: { ...typography.label, flex: 1, color: colors.inkMuted },
});
