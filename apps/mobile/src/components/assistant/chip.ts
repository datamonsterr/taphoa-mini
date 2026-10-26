import type { components } from '@taphoa/api-client';

import type { NextStepKind } from '@/lib/analytics';

/** What a chip does when tapped; the server actions come through untouched. */
export type NextStepChipAction =
  | { type: 'receipt' }
  | { type: 'enroll' }
  | components['schemas']['NextStep']['action'];

/** A chip as the strip shows it: text already in the app language. */
export type NextStepChipData = {
  id: string;
  kind: NextStepKind;
  title: string;
  subtitle?: string;
  /** `device` chips come from the current camera frame and look different. */
  source: 'device' | 'server';
  action: NextStepChipAction;
};
