import type { VoiceUtterance } from '@taphoa/api-client';
import * as Haptics from 'expo-haptics';
import { onlineManager } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { Check } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking, StyleSheet, View } from 'react-native';

import { Icon, Sheet, Text } from '@/components/ui';
import { capture } from '@/lib/analytics';
import { useCreateSale } from '@/lib/api';
import { formatVnd } from '@/lib/format';
import { fill, useT } from '@/lib/i18n';
import { newUuid } from '@/lib/uuid';
import { useCartStore } from '@/stores/cart';
import { useSettingsStore } from '@/stores/settings';
import { colors, radius, space, typography } from '@/theme';

import { assistantHref } from '../assistant/route';
import { CustomerPicker } from '../debts/CustomerPicker';
import { classifyFailure, postOutcome, useVoiceUtterance } from './api';
import { CatalogSearch } from './CatalogSearch';
import {
  activeLines,
  cartLines,
  correctionsByUtterance,
  draftReducer,
  draftTotal,
  fromServerDraft,
  isEdited,
  itemCount,
  saleRequest,
  type Draft,
  type DraftAction,
  type DraftProduct,
} from './draft';
import { DraftView } from './DraftView';
import { FallbackPane } from './FallbackPane';
import { fixtureName, type VoiceClip } from './fixture';
import { ListeningView } from './ListeningView';
import { PriceEditor } from './PriceEditor';
import {
  isExternalEntry,
  parseEntry,
  parseReturnToPrevious,
  type VoiceRouteParams,
} from './route';
import { StatusPanel } from './StatusPanel';
import { voiceStrings } from './strings';
import { UnderstandingView } from './UnderstandingView';
import { recorderAvailable, useVoiceRecorder } from './useVoiceRecorder';
import { useVoiceSettings } from './voiceSettings';
import { voiceExit } from './voiceExit';

/** How long the green "sold" state shows before the sheet leaves. */
export const SUCCESS_MS = 900;

type Phase =
  | 'listening'
  | 'understanding'
  | 'draft'
  | 'noSpeech'
  | 'quota'
  | 'fallback'
  | 'chat'
  | 'permission'
  | 'error'
  | 'search'
  | 'done';

/** Which sub-view of the draft is open: a price keypad, or the catalog search for one line. */
type Editing = { kind: 'price' | 'search'; id: string } | null;

const HEIGHTS: Record<Phase, number> = {
  listening: 488,
  understanding: 420,
  draft: 724,
  noSpeech: 420,
  quota: 420,
  fallback: 520,
  chat: 420,
  permission: 420,
  error: 420,
  search: 620,
  done: 420,
};

const join = (a: string, b: string) => [a, b].filter(Boolean).join(' ');

/**
 * `/voice`: the voice sale sheet. It records on open, uploads the clip, shows the draft and
 * records the sale on the green check. Nothing is written before that tap.
 */
export function VoiceSaleScreen() {
  const t = useT(voiceStrings);
  const router = useRouter();
  const language = useSettingsStore((s) => s.language);
  const params = useLocalSearchParams() as VoiceRouteParams;
  const entry = parseEntry(params.entry);
  const returnToPrevious = parseReturnToPrevious(params.returnToPrevious);
  const fixture = fixtureName(params.fixture);

  const available = recorderAvailable(fixture);
  const [phase, setPhase] = useState<Phase>(
    available ? 'listening' : 'fallback',
  );
  const [draft, setDraft] = useState<Draft | null>(null);
  const [transcript, setTranscript] = useState('');
  const [editing, setEditing] = useState<Editing>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [addedToCart, setAddedToCart] = useState(0);
  const [soldMessage, setSoldMessage] = useState('');

  /** Utterance ids that reached the server, for the outcome calls. */
  const utteranceIds = useRef<string[]>([]);
  /** Bumped by cancel and close, so a late upload answer is dropped. */
  const attempt = useRef(0);
  const settled = useRef(false);
  const saleId = useRef(newUuid()).current;
  const soldAt = useRef<string | null>(null);
  const upload = useVoiceUtterance();
  const { mutate: uploadClip, isPending: uploading } = upload;
  const sale = useCreateSale();

  const draftRef = useRef<Draft | null>(null);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  const dispatch = useCallback(
    (action: DraftAction) =>
      setDraft((current) =>
        current ? draftReducer(current, action) : current,
      ),
    [],
  );

  /** The sheet leaves once, whichever of close, the success timer or a scrim tap comes first. */
  const closed = useRef(false);
  const close = useCallback(() => {
    if (closed.current) return;
    closed.current = true;
    voiceExit.onDone({ returnToPrevious }, () => {
      if (router.canGoBack()) router.back();
      else router.replace('/');
    });
  }, [returnToPrevious, router]);

  const handleResult = useCallback(
    (mine: number, utterance: VoiceUtterance) => {
      if (mine !== attempt.current) return;
      utteranceIds.current.push(utterance.id);
      const current = draftRef.current;
      if (utterance.intent === 'sale' && utterance.sale_draft) {
        const next = fromServerDraft(utterance.sale_draft, utterance.id);
        setDraft((d) =>
          d ? draftReducer(d, { type: 'append', draft: next }) : next,
        );
        setTranscript((text) => join(text, utterance.transcript));
        setError(null);
        setPhase('draft');
      } else if (current) {
        setError(t('noSpeech'));
      } else if (utterance.intent === 'chat') {
        setTranscript(utterance.transcript);
        setPhase('chat');
      } else {
        setPhase('noSpeech');
      }
    },
    [t],
  );

  const handleError = useCallback(
    (mine: number, failure: unknown) => {
      if (mine !== attempt.current) return;
      const kind = classifyFailure(failure);
      if (draftRef.current) {
        setError(t(kind === 'no_speech' ? 'noSpeech' : 'genericError'));
        return;
      }
      setPhase(
        kind === 'no_speech'
          ? 'noSpeech'
          : kind === 'quota'
            ? 'quota'
            : kind === 'unavailable'
              ? 'fallback'
              : 'error',
      );
    },
    [t],
  );

  const sendClip = useCallback(
    (clip: VoiceClip) => {
      const mine = ++attempt.current;
      setError(null);
      if (!draftRef.current) setPhase('understanding');
      // Offline there is nothing to wait for: go straight to on-device recognition.
      if (!onlineManager.isOnline()) {
        handleError(mine, new TypeError('Network request failed'));
        return;
      }
      uploadClip(
        {
          clip,
          mode: 'sale',
          language,
          entry,
          screen: 'voice',
        },
        {
          onSuccess: (utterance) => handleResult(mine, utterance),
          onError: (failure) => handleError(mine, failure),
        },
      );
    },
    [uploadClip, language, entry, handleResult, handleError],
  );

  const recorder = useVoiceRecorder({ fixture, onFinished: sendClip });
  const { status, start, stop, cancel } = recorder;

  const listen = useCallback(async () => {
    setError(null);
    if (!draftRef.current) setPhase('listening');
    await start();
  }, [start]);

  // Open: count the start once and begin recording (or go straight to on-device recognition).
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    capture('voice_sale_started', { entry });
    if (available) void start();
  }, [entry, available, start]);

  const postOutcomes = useCallback(
    (current: Draft, saleIdOrNull: string | null) => {
      const edited = isEdited(current);
      for (const [id, corrections] of correctionsByUtterance(current))
        void postOutcome(id, {
          outcome: edited ? 'edited' : 'confirmed',
          ...(saleIdOrNull ? { sale_id: saleIdOrNull } : {}),
          ...(corrections.length > 0 ? { corrections } : {}),
        });
    },
    [],
  );

  /** Leaves without a sale: the seller closed the sheet or cancelled. */
  const abandon = useCallback(() => {
    attempt.current++;
    void cancel();
    if (!settled.current) {
      settled.current = true;
      const stage = draftRef.current ? 'draft' : 'listening';
      capture('voice_sale_abandoned', { stage });
      for (const id of utteranceIds.current)
        void postOutcome(id, { outcome: 'abandoned', stage });
    }
    close();
  }, [cancel, close]);

  // Leaving by the system back gesture (or any other way) without a sale is an abandon too. The
  // microtask lets a StrictMode remount cancel the report.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      queueMicrotask(() => {
        if (alive.current || settled.current) return;
        settled.current = true;
        const stage = draftRef.current ? 'draft' : 'listening';
        capture('voice_sale_abandoned', { stage });
        for (const id of utteranceIds.current)
          void postOutcome(id, { outcome: 'abandoned', stage });
      });
    };
  }, []);

  // The microphone only runs in the foreground: a recording the app leaves is thrown away.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') return;
      attempt.current++;
      void cancel();
      if (!draftRef.current) setPhase('noSpeech');
    });
    return () => subscription.remove();
  }, [cancel]);

  const confirm = useCallback(() => {
    if (!draft || sale.isPending) return;
    const total = draftTotal(draft);
    const count = activeLines(draft).length;
    const finish = () => {
      settled.current = true;
      capture('voice_sale_confirmed', {
        edited: isEdited(draft),
        line_count: count,
        payment_method: draft.paymentMethod,
        total,
      });
    };
    if (draft.paymentMethod === 'transfer') {
      useCartStore.getState().addMany(cartLines(draft));
      finish();
      postOutcomes(draft, null);
      router.replace('/pay');
      return;
    }
    setError(null);
    sale.mutate(
      saleRequest(draft, saleId, (soldAt.current ??= new Date().toISOString())),
      {
        onSuccess: () => {
          void Haptics.notificationAsync(
            Haptics.NotificationFeedbackType.Success,
          );
          useVoiceSettings.getState().countVoiceSale();
          finish();
          postOutcomes(draft, saleId);
          setSoldMessage(
            fill(t('sold'), { n: itemCount(draft), total: formatVnd(total) }),
          );
          setPhase('done');
        },
        onError: () => setError(t('saveError')),
      },
    );
  }, [draft, sale, saleId, postOutcomes, router, t]);

  useEffect(() => {
    if (phase !== 'done') return undefined;
    const timer = setTimeout(close, SUCCESS_MS);
    return () => clearTimeout(timer);
  }, [phase, close]);

  const retry = useCallback(() => void listen(), [listen]);
  const openCart = useCallback(() => router.replace('/cart'), [router]);
  const askAssistant = useCallback(
    () =>
      router.replace(
        assistantHref({ entry: 'button', prompt: transcript }) as Href,
      ),
    [router, transcript],
  );
  const addToCart = useCallback((text: string) => {
    setSearchQuery(text);
    setPhase('search');
  }, []);
  const putInCart = useCallback((product: DraftProduct) => {
    useCartStore.getState().add({
      productId: product.id,
      name: product.name,
      price: product.price,
      ...(product.imageUrl ? { imageUrl: product.imageUrl } : {}),
    });
    setAddedToCart((n) => n + 1);
  }, []);

  const editedLine = editing
    ? draft?.lines.find((l) => l.id === editing.id)
    : undefined;
  const micMode = isExternalEntry(entry) ? 'toggle' : 'hold';
  const adding = draft
    ? status === 'recording' || status === 'starting'
      ? 'listening'
      : uploading
        ? 'understanding'
        : 'idle'
    : 'idle';

  // A refused microphone or a recorder that failed to start shows before any answer exists.
  const shown: Phase =
    phase === 'listening' && status === 'denied'
      ? 'permission'
      : phase === 'listening' && status === 'error'
        ? 'error'
        : phase;

  let body;
  if (shown === 'listening')
    body = (
      <ListeningView
        level={recorder.level}
        elapsedMs={recorder.elapsedMs}
        maxMs={recorder.maxMs}
        onStop={() => {
          void stop().then((clip) => {
            if (!clip) setPhase('noSpeech');
          });
        }}
        onClose={abandon}
      />
    );
  else if (shown === 'understanding')
    body = <UnderstandingView onCancel={abandon} />;
  else if (
    shown === 'draft' &&
    draft &&
    editing?.kind === 'price' &&
    editedLine
  )
    body = (
      <PriceEditor
        name={editedLine.product?.name || editedLine.spoken}
        initial={editedLine.unitPrice}
        onCancel={() => setEditing(null)}
        onSave={(price) => {
          dispatch({ type: 'price', id: editedLine.id, price });
          setEditing(null);
        }}
      />
    );
  else if (
    shown === 'draft' &&
    draft &&
    editing?.kind === 'search' &&
    editedLine
  )
    body = (
      <CatalogSearch
        initialQuery={editedLine.spoken}
        onPick={(product) => {
          dispatch({ type: 'resolve', id: editedLine.id, product });
          setEditing(null);
        }}
      />
    );
  else if (shown === 'draft' && draft)
    body = (
      <DraftView
        draft={draft}
        transcript={transcript}
        dispatch={dispatch}
        expandedId={expanded}
        onToggleCandidates={(id) =>
          setExpanded((open) => (open === id ? null : id))
        }
        onEditPrice={(id) => setEditing({ kind: 'price', id })}
        onSearch={(id) => setEditing({ kind: 'search', id })}
        onChooseCustomer={() => setPicker(true)}
        adding={adding}
        micMode={micMode}
        onMicStart={() => void listen()}
        onMicStop={() => void stop()}
        saving={sale.isPending}
        error={error}
        onConfirm={confirm}
        onClose={abandon}
      />
    );
  else if (shown === 'noSpeech')
    body = (
      <StatusPanel
        testID="voice-no-speech"
        title={t('noSpeech')}
        actions={[
          {
            label: t('retry'),
            onPress: retry,
            testID: 'voice-retry',
            primary: true,
          },
        ]}
        closeLabel={t('close')}
        onClose={abandon}
      />
    );
  else if (shown === 'quota')
    body = (
      <StatusPanel
        testID="voice-quota"
        title={t('quota')}
        hint={t('quotaHint')}
        actions={[
          {
            label: t('openCart'),
            onPress: openCart,
            testID: 'voice-open-cart',
            primary: true,
          },
        ]}
        closeLabel={t('close')}
        onClose={abandon}
      />
    );
  else if (shown === 'fallback')
    body = (
      <FallbackPane
        reason={available ? 'server' : 'device'}
        onAddToCart={addToCart}
        onOpenCart={openCart}
        onClose={abandon}
      />
    );
  else if (shown === 'chat')
    body = (
      <StatusPanel
        testID="voice-chat-intent"
        title={t('chatTitle')}
        hint={t('chatHint')}
        actions={[
          {
            label: t('askAssistant'),
            onPress: askAssistant,
            testID: 'voice-ask-assistant',
            primary: true,
          },
        ]}
        closeLabel={t('close')}
        onClose={abandon}
      >
        <Text style={styles.quote}>{`“${transcript}”`}</Text>
      </StatusPanel>
    );
  else if (shown === 'permission')
    body = (
      <StatusPanel
        testID="voice-permission"
        title={t('permissionTitle')}
        hint={t('permissionHint')}
        actions={[
          {
            label: t('openSettings'),
            onPress: () => void Linking.openSettings(),
            testID: 'voice-open-settings',
            primary: true,
          },
        ]}
        closeLabel={t('close')}
        onClose={abandon}
      />
    );
  else if (shown === 'search')
    body = (
      <StatusPanel
        testID="voice-search-pane"
        title={t('search')}
        actions={[
          {
            label: t('openCart'),
            onPress: openCart,
            testID: 'voice-open-cart',
            primary: addedToCart > 0,
          },
        ]}
        closeLabel={t('close')}
        onClose={abandon}
      >
        <CatalogSearch
          initialQuery={searchQuery}
          onPick={putInCart}
          notice={
            addedToCart > 0 ? `${t('addedToCart')} (${addedToCart})` : undefined
          }
        />
      </StatusPanel>
    );
  else if (shown === 'done')
    body = (
      <View testID="voice-done" style={styles.done}>
        <View style={styles.disc}>
          <Icon icon={Check} size={64} color={colors.onInk} />
        </View>
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          style={styles.sold}
        >
          {soldMessage}
        </Text>
      </View>
    );
  else
    body = (
      <StatusPanel
        testID="voice-error"
        title={t('genericError')}
        actions={[
          {
            label: t('retry'),
            onPress: retry,
            testID: 'voice-retry',
            primary: true,
          },
        ]}
        closeLabel={t('close')}
        onClose={abandon}
      />
    );

  return (
    <>
      <Sheet
        testID="voice-sheet"
        height={HEIGHTS[shown]}
        scrollable={false}
        onClose={abandon}
      >
        {body}
      </Sheet>
      {picker ? (
        <CustomerPicker
          // An unmatched spoken name opens the create form with it filled in; the picker still
          // lists existing customers, and a created or picked one becomes the debtor.
          mode={!draft?.customer && draft?.spokenCustomer ? 'create' : 'select'}
          initialName={draft?.customer ? '' : (draft?.spokenCustomer ?? '')}
          onClose={() => setPicker(false)}
          onSelect={(customer) => {
            dispatch({ type: 'customer', customer });
            setPicker(false);
          }}
        />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  quote: { ...typography.heading, textAlign: 'center', color: colors.ink },
  done: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[4],
  },
  disc: {
    width: 128,
    height: 128,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: colors.success,
  },
  sold: { ...typography.heading, textAlign: 'center', color: colors.success },
});
