import {
  useDefaultOnFlag,
  VOICE_SERVER_CHAT_FLAG,
} from '@/lib/analyticsPostHog';

/** Whether the assistant is on for this member: the PostHog `assistant_enabled` kill switch. */
export {
  useAssistantEnabled,
  ASSISTANT_ENABLED_FLAG,
} from '@/lib/analyticsPostHog';

export { VOICE_SERVER_CHAT_FLAG };

/** `EXPO_PUBLIC_VOICE_SERVER_CHAT` forces the chat microphone mode: 1/true on, 0/false off. */
export function voiceServerChatOverride(): boolean | undefined {
  const value = process.env.EXPO_PUBLIC_VOICE_SERVER_CHAT?.trim().toLowerCase();
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  return undefined;
}

/**
 * Whether the chat microphone transcribes on the server (`voice_server_chat`, default on). The
 * env override wins over the PostHog flag; off means the on-device recognizer, as before.
 */
export function useVoiceServerChat(): boolean {
  const flag = useDefaultOnFlag(VOICE_SERVER_CHAT_FLAG);
  return voiceServerChatOverride() ?? flag;
}
