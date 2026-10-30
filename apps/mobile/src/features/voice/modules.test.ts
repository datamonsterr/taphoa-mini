import { ApiError } from '@/lib/api';

import { classifyFailure } from './api';
import {
  isExternalEntry,
  parseEntry,
  parseReturnToPrevious,
  voiceHref,
} from './route';
import { setVoiceExit, voiceExit } from './voiceExit';
import { setVoiceQuickAccess, voiceBubble, voiceTile } from './quickAccess';
import { initialVoiceSettings, useVoiceSettings } from './voiceSettings';

describe('route params', () => {
  test.each([
    ['bubble', 'bubble'],
    ['tile', 'tile'],
    ['shortcut', 'shortcut'],
    ['control', 'control'],
    ['action_button', 'action_button'],
    ['siri', 'siri'],
    ['longpress', 'longpress'],
    ['chip', 'chip'],
    ['nonsense', 'longpress'],
    [undefined, 'longpress'],
  ])('entry %p -> %p', (value, expected) => {
    expect(parseEntry(value)).toBe(expected);
  });

  test('outside entries tap to stop, in-app entries hold to talk', () => {
    expect(isExternalEntry('bubble')).toBe(true);
    expect(isExternalEntry('siri')).toBe(true);
    expect(isExternalEntry('longpress')).toBe(false);
    expect(isExternalEntry('chip')).toBe(false);
  });

  test('returnToPrevious reads 1 and true only', () => {
    expect(parseReturnToPrevious('1')).toBe(true);
    expect(parseReturnToPrevious('true')).toBe(true);
    expect(parseReturnToPrevious('0')).toBe(false);
    expect(parseReturnToPrevious(undefined)).toBe(false);
  });

  test('voiceHref leaves out what is not set', () => {
    expect(voiceHref({ entry: 'chip' })).toEqual({
      pathname: '/voice',
      params: { entry: 'chip' },
    });
    expect(
      voiceHref({ entry: 'bubble', returnToPrevious: true, fixture: 'a.m4a' }),
    ).toEqual({
      pathname: '/voice',
      params: { entry: 'bubble', returnToPrevious: '1', fixture: 'a.m4a' },
    });
  });
});

describe('voiceExit', () => {
  afterEach(() => setVoiceExit(null));

  test('the default just closes', () => {
    const close = jest.fn();
    voiceExit.onDone({ returnToPrevious: true }, close);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test('V3 can replace it and restore the default', () => {
    const onDone = jest.fn();
    setVoiceExit({ onDone });
    const close = jest.fn();
    voiceExit.onDone({ returnToPrevious: true }, close);
    expect(onDone).toHaveBeenCalledWith({ returnToPrevious: true }, close);
    expect(close).not.toHaveBeenCalled();
    setVoiceExit(null);
    voiceExit.onDone({ returnToPrevious: false }, close);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('quick access capabilities', () => {
  afterEach(() => setVoiceQuickAccess());

  test('everything is unsupported until the native module registers', async () => {
    expect(voiceBubble.isSupported()).toBe(false);
    expect(await voiceBubble.isEnabled()).toBe(false);
    expect(await voiceBubble.setEnabled(true)).toBe(false);
    expect(voiceTile.isSupported()).toBe(false);
    expect(await voiceTile.requestAdd()).toBe(false);
  });

  test('a registered module replaces the defaults, and clearing restores them', async () => {
    setVoiceQuickAccess({
      bubble: {
        isSupported: () => true,
        isEnabled: async () => true,
        canDrawOverlays: () => true,
        openOverlaySettings: () => undefined,
        setEnabled: async (on) => on,
      },
    });
    expect(voiceBubble.isSupported()).toBe(true);
    expect(voiceTile.isSupported()).toBe(false);
    setVoiceQuickAccess();
    expect(voiceBubble.isSupported()).toBe(false);
  });
});

describe('voice settings', () => {
  beforeEach(() => useVoiceSettings.setState(initialVoiceSettings));

  test('count voice sales and remember the opt-in', () => {
    useVoiceSettings.getState().countVoiceSale();
    useVoiceSettings.getState().countVoiceSale();
    useVoiceSettings.getState().setDonate(true);
    expect(useVoiceSettings.getState()).toMatchObject({
      voiceSales: 2,
      donate: true,
    });
  });
});

describe('classifyFailure', () => {
  const api = (status: number, code?: string) =>
    new ApiError(status, { error: 'x', ...(code ? { code } : {}) });

  test.each([
    [api(422, 'no_speech'), 'no_speech'],
    [api(429, 'voice_quota'), 'quota'],
    [api(503, 'voice_unavailable'), 'unavailable'],
    [api(503), 'unavailable'],
    [new TypeError('Network request failed'), 'unavailable'],
    [api(400, 'audio_too_long'), 'other'],
    [api(500), 'other'],
  ])('%p -> %s', (error, expected) => {
    expect(classifyFailure(error)).toBe(expected);
  });
});
