import AsyncStorage from '@react-native-async-storage/async-storage';

export const PROMPT_STORAGE_KEY = 'push.prompt.v1';
export const TOKEN_STORAGE_KEY = 'push.token.v1';

export type PromptTimingParams = {
  signedInOpens: number;
  asked: boolean;
  platform: string;
};

export type PushPromptState = {
  opens: number;
  asked: boolean;
};

/**
 * Push permission prompt timing decision:
 * Prompts on the dashboard on the second signed-in open, once;
 * denied is not asked again; web is never prompted.
 */
export function shouldPromptForPush({
  signedInOpens,
  asked,
  platform,
}: PromptTimingParams): boolean {
  return platform !== 'web' && !asked && signedInOpens >= 2;
}

export async function getPromptState(): Promise<PushPromptState> {
  try {
    const raw = await AsyncStorage.getItem(PROMPT_STORAGE_KEY);
    if (!raw) return { opens: 0, asked: false };
    const parsed = JSON.parse(raw);
    return {
      opens: typeof parsed.opens === 'number' ? parsed.opens : 0,
      asked: Boolean(parsed.asked),
    };
  } catch {
    return { opens: 0, asked: false };
  }
}

export async function incrementOpens(): Promise<PushPromptState> {
  const current = await getPromptState();
  const next: PushPromptState = { ...current, opens: current.opens + 1 };
  try {
    await AsyncStorage.setItem(PROMPT_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore storage errors
  }
  return next;
}

export async function markAsked(): Promise<PushPromptState> {
  const current = await getPromptState();
  const next: PushPromptState = { ...current, asked: true };
  try {
    await AsyncStorage.setItem(PROMPT_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore storage errors
  }
  return next;
}

export async function getLastToken(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export async function setLastToken(token: string | null): Promise<void> {
  try {
    if (token) {
      await AsyncStorage.setItem(TOKEN_STORAGE_KEY, token);
    } else {
      await AsyncStorage.removeItem(TOKEN_STORAGE_KEY);
    }
  } catch {
    // ignore storage errors
  }
}

export async function clearLastToken(): Promise<void> {
  try {
    await AsyncStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // ignore storage errors
  }
}
