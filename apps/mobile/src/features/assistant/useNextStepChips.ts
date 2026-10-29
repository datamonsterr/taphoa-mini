import { useIsFocused } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef } from 'react';

import type { NextStepChipData } from '@/components/assistant/chip';
import { strings } from '@/components/assistant/strings';
import { capture } from '@/lib/analytics';
import { t } from '@/lib/i18n';
import { useSettingsStore } from '@/stores/settings';
import { useVoiceSettings } from '@/features/voice/voiceSettings';
import { showVoiceSaleChip } from '@/features/voice/chipRule';

import { useNextSteps } from './api';

export type UseNextStepChipsOptions = {
  screen: 'camera';
  documentDetected: boolean;
  unknownProduct: boolean;
  /** On-device chips lead to flows only a member who can enroll may start. */
  canEnroll: boolean;
  /** The assistant flag; off hides assistant suggestions, keeping direct receipt review. */
  enabled: boolean;
  /** When the member joined (ISO); the `voice_sale` chip shows for their first 14 days. */
  joinedAt?: string;
};

/**
 * The receipt state owns the strip with review and assistant actions. Otherwise the unknown
 * product chip precedes server suggestions, one per kind. `next_step_shown` is captured once per
 * chip per screen visit; a visit ends when the screen loses focus.
 */
export function useNextStepChips({
  screen,
  documentDetected,
  unknownProduct,
  canEnroll,
  enabled,
  joinedAt,
}: UseNextStepChipsOptions) {
  const voiceSales = useVoiceSettings((s) => s.voiceSales);
  const language = useSettingsStore((s) => s.language);
  const focused = useIsFocused();
  const { data } = useNextSteps(
    { screen, documentDetected, unknownProduct },
    { enabled: enabled && focused },
  );

  const chips = useMemo<NextStepChipData[]>(() => {
    if (documentDetected && canEnroll) {
      const receipts: NextStepChipData[] = [
        {
          id: 'receipt_detected',
          kind: 'receipt_detected',
          title: t(strings, 'readReceipt', language),
          source: 'device',
          tone: 'accent',
          action: { type: 'receipt', destination: 'review' },
        },
      ];
      if (enabled)
        receipts.push({
          id: 'receipt_assistant',
          kind: 'receipt_detected',
          title: t(strings, 'receiptAssistant', language),
          source: 'device',
          tone: 'neutral',
          action: { type: 'receipt', destination: 'assistant' },
        });
      return receipts;
    }
    if (!enabled) return [];
    const list: NextStepChipData[] = [];
    const device = (kind: 'unknown_product') =>
      list.push({
        id: kind,
        kind,
        title: t(strings, `kind.${kind}`, language),
        subtitle: t(strings, `sub.${kind}`, language),
        source: 'device',
        action: { type: 'enroll' },
      });

    if (unknownProduct && canEnroll) device('unknown_product');
    if (showVoiceSaleChip({ joinedAt, voiceSales }))
      list.push({
        id: 'voice_sale',
        kind: 'voice_sale',
        title: t(strings, 'kind.voice_sale', language),
        subtitle: t(strings, 'sub.voice_sale', language),
        source: 'app',
        action: { type: 'voice' },
      });
    for (const item of data?.items ?? []) {
      if (list.some((chip) => chip.kind === item.kind)) continue;
      const english = language === 'en' && strings.en[`kind.${item.kind}`];
      list.push({
        id: item.id,
        kind: item.kind,
        title: english || item.title_vi,
        ...(!english && item.subtitle_vi ? { subtitle: item.subtitle_vi } : {}),
        source: 'server',
        action: item.action,
      });
    }
    return list;
  }, [
    enabled,
    documentDetected,
    unknownProduct,
    canEnroll,
    data,
    language,
    joinedAt,
    voiceSales,
  ]);

  const shown = useRef(new Set<string>());
  useEffect(() => {
    if (!focused) {
      shown.current.clear();
      return;
    }
    chips.forEach((chip, position) => {
      if (shown.current.has(chip.id)) return;
      shown.current.add(chip.id);
      capture('next_step_shown', { kind: chip.kind, position });
    });
  }, [focused, chips]);

  const tap = useCallback((chip: NextStepChipData, position: number) => {
    capture('next_step_tapped', { kind: chip.kind, position });
  }, []);

  return { chips, tap };
}
