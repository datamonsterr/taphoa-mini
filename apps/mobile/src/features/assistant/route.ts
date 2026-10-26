export type AssistantEntry = 'button' | 'chip' | 'receipt' | 'digest' | 'push';

export type AssistantRouteParams = {
  threadId?: string;
  entry: AssistantEntry;
  prompt?: string;
  screen?: string;
  nextStepId?: string;
  receiptId?: string;
};

/** Expo Router href for the assistant modal; undefined params are left out. */
export function assistantHref(params: AssistantRouteParams) {
  const defined = Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined),
  ) as Record<string, string>;
  return { pathname: '/assistant' as const, params: defined };
}
