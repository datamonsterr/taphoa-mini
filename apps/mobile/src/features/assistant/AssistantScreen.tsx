import { Text, View } from 'react-native';

import { useT } from '@/lib/i18n';

import { dict } from './strings';

/** Placeholder: the chat UI is built on top of `useAssistantChat` in a later task. */
export function AssistantScreen() {
  const t = useT(dict);
  return (
    <View testID="assistant-screen">
      <Text accessibilityRole="header">{t('title')}</Text>
    </View>
  );
}
