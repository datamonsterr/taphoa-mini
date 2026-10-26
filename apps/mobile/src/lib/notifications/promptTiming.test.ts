import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  clearLastToken,
  getLastToken,
  getPromptState,
  incrementOpens,
  markAsked,
  PROMPT_STORAGE_KEY,
  shouldPromptForPush,
  setLastToken,
  TOKEN_STORAGE_KEY,
} from './promptTiming';

describe('promptTiming', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  describe('shouldPromptForPush', () => {
    test('returns false on web regardless of opens and asked', () => {
      expect(
        shouldPromptForPush({
          signedInOpens: 2,
          asked: false,
          platform: 'web',
        }),
      ).toBe(false);
      expect(
        shouldPromptForPush({
          signedInOpens: 10,
          asked: false,
          platform: 'web',
        }),
      ).toBe(false);
    });

    test('returns false if already asked', () => {
      expect(
        shouldPromptForPush({
          signedInOpens: 2,
          asked: true,
          platform: 'android',
        }),
      ).toBe(false);
      expect(
        shouldPromptForPush({
          signedInOpens: 5,
          asked: true,
          platform: 'ios',
        }),
      ).toBe(false);
    });

    test('returns false on the first signed-in open (opens < 2)', () => {
      expect(
        shouldPromptForPush({
          signedInOpens: 0,
          asked: false,
          platform: 'android',
        }),
      ).toBe(false);
      expect(
        shouldPromptForPush({
          signedInOpens: 1,
          asked: false,
          platform: 'android',
        }),
      ).toBe(false);
      expect(
        shouldPromptForPush({
          signedInOpens: 1,
          asked: false,
          platform: 'ios',
        }),
      ).toBe(false);
    });

    test('returns true on second or later signed-in open if not asked and not web', () => {
      expect(
        shouldPromptForPush({
          signedInOpens: 2,
          asked: false,
          platform: 'android',
        }),
      ).toBe(true);
      expect(
        shouldPromptForPush({
          signedInOpens: 3,
          asked: false,
          platform: 'ios',
        }),
      ).toBe(true);
    });
  });

  describe('persistence helpers', () => {
    test('getPromptState returns default when empty', async () => {
      const state = await getPromptState();
      expect(state).toEqual({ opens: 0, asked: false });
    });

    test('incrementOpens increases opens count and persists to AsyncStorage', async () => {
      const state1 = await incrementOpens();
      expect(state1).toEqual({ opens: 1, asked: false });
      expect(await AsyncStorage.getItem(PROMPT_STORAGE_KEY)).toBe(
        JSON.stringify({ opens: 1, asked: false }),
      );

      const state2 = await incrementOpens();
      expect(state2).toEqual({ opens: 2, asked: false });
      expect(await AsyncStorage.getItem(PROMPT_STORAGE_KEY)).toBe(
        JSON.stringify({ opens: 2, asked: false }),
      );
    });

    test('markAsked sets asked to true and preserves opens count', async () => {
      await incrementOpens();
      await incrementOpens();
      const state = await markAsked();
      expect(state).toEqual({ opens: 2, asked: true });
      expect(await AsyncStorage.getItem(PROMPT_STORAGE_KEY)).toBe(
        JSON.stringify({ opens: 2, asked: true }),
      );
    });

    test('getPromptState handles corrupted json gracefully', async () => {
      await AsyncStorage.setItem(PROMPT_STORAGE_KEY, 'invalid-json');
      const state = await getPromptState();
      expect(state).toEqual({ opens: 0, asked: false });
    });

    test('token persistence helpers manage push.token.v1', async () => {
      expect(await getLastToken()).toBeNull();

      await setLastToken('token-123');
      expect(await getLastToken()).toBe('token-123');
      expect(await AsyncStorage.getItem(TOKEN_STORAGE_KEY)).toBe('token-123');

      await clearLastToken();
      expect(await getLastToken()).toBeNull();
      expect(await AsyncStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();

      await setLastToken('token-456');
      expect(await getLastToken()).toBe('token-456');
      await setLastToken(null);
      expect(await getLastToken()).toBeNull();
    });

    test('handles AsyncStorage errors gracefully in token helpers', async () => {
      jest
        .spyOn(AsyncStorage, 'setItem')
        .mockRejectedValueOnce(new Error('disk error'));
      await expect(setLastToken('token-fail')).resolves.toBeUndefined();

      jest
        .spyOn(AsyncStorage, 'removeItem')
        .mockRejectedValueOnce(new Error('disk error'));
      await expect(clearLastToken()).resolves.toBeUndefined();

      jest
        .spyOn(AsyncStorage, 'getItem')
        .mockRejectedValueOnce(new Error('disk error'));
      expect(await getLastToken()).toBeNull();
    });
  });
});
