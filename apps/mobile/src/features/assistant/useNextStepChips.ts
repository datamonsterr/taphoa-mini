import { useIsFocused } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef } from 'react';

import type { NextStepChipData } from '@/components/assistant/chip';
import { strings } from '@/components/assistant/strings';
import { capture } from '@/lib/analytics';
import { t } from '@/lib/i18n';
import { useSettingsStore } from '@/stores/settings';

import { useNextSteps } from './api';

export type UseNextStepChipsOptions = {
  screen: 'camera';
  documentDetected: boolean;
  unknownProduct: boolean;
  /** On-device chips lead to flows only a member who can enroll may start. */
  canEnroll: boolean;
  /** The assistant flag; off means no chips and no request. */
  enabled: boolean;
};

/**
 * The chips of the next-step strip: on-device chips first (receipt, unknown product), then the
 * server chips of the screen, one per kind. `next_step_shown` is captured once per chip per screen
 * visit; a visit ends when the screen loses focus.
 */
export function useNextStepChips({
  screen,
  documentDetected,
  unknownProduct,
  canEnroll,
  enabled,
}: UseNextStepChipsOptions) {
  const language = useSettingsStore((s) => s.language);
  const focused = useIsFocused();
  const { data } = useNextSteps(
    { screen, documentDetected, unknownProduct },
    { enabled: enabled && focused },
  );

  const chips = useMemo<NextStepChipData[]>(() => {
    if (!enabled) return [];
    const list: NextStepChipData[] = [];
    const device = (kind: 'receipt_detected' | 'unknown_product') =>
      list.push({
        id: kind,
        kind,
        title: t(strings, `kind.${kind}`, language),
        subtitle: t(strings, `sub.${kind}`, language),
        source: 'device',
        action: { type: kind === 'receipt_detected' ? 'receipt' : 'enroll' },
      });
    if (documentDetected && canEnroll) device('receipt_detected');
    if (unknownProduct && canEnroll) device('unknown_product');
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
  }, [enabled, documentDetected, unknownProduct, canEnroll, data, language]);

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
