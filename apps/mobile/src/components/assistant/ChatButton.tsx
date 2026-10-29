import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { Sparkles } from 'lucide-react-native';
import { memo, useCallback } from 'react';

import { CircleButton } from '@/components/ui/CircleButton';
import { useAssistantEnabled } from '@/features/assistant/flags';
import { assistantHref } from '@/features/assistant/route';
import { voiceHref } from '@/features/voice/route';
import { useT } from '@/lib/i18n';

import { strings } from './strings';

export type ChatButtonScreen = 'inventory' | 'dashboard' | 'account' | 'camera';

export type ChatButtonProps = { screen: ChatButtonScreen };

/** 56 dp accent circle that opens the assistant; renders nothing while the assistant is off. */
export const ChatButton = memo(function ChatButton({
  screen,
}: ChatButtonProps) {
  const t = useT(strings);
  const router = useRouter();
  const enabled = useAssistantEnabled();
  const open = useCallback(
    () => router.push(assistantHref({ entry: 'button', screen })),
    [router, screen],
  );
  const voice = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    router.push(voiceHref({ entry: 'longpress' }));
  }, [router]);
  if (!enabled) return null;
  return (
    <CircleButton
      icon={Sparkles}
      accessibilityLabel={t('open')}
      variant="accent"
      floating
      accessibilityHint={t('voiceHint')}
      onPress={open}
      onLongPress={voice}
      testID="chat-button"
    />
  );
});
