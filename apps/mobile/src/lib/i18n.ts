import { useMemo } from 'react';

import { useSettingsStore, type Language } from '@/stores/settings';

export type Dict = Record<Language, Record<string, string>>;

/** Look up `key` in `dict[language]`; fall back to Vietnamese, then to the key itself. */
export function t(dict: Dict, key: string, language: Language = 'vi'): string {
  return dict[language][key] ?? dict.vi[key] ?? key;
}

/** Replace `{name}` placeholders in a translated template. */
export const fill = (
  template: string,
  values: Record<string, string | number>,
): string =>
  template.replace(/\{(\w+)\}/g, (_match, name: string) =>
    String(values[name] ?? ''),
  );

/**
 * Builds a stable labels object (for memoised components) from `dict`; it changes only with the
 * language. `build` must be a module-level function.
 */
export function useLabels<T>(
  dict: Dict,
  build: (translate: (key: string) => string) => T,
): T {
  const language = useSettingsStore((s) => s.language);
  return useMemo(
    () => build((key) => t(dict, key, language)),
    [dict, build, language],
  );
}

/** Hook form: reads the language from the settings store. */
export function useT(dict: Dict): (key: string) => string {
  const language = useSettingsStore((s) => s.language);
  return (key) => t(dict, key, language);
}
