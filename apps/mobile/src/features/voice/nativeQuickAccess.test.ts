import type { NativeVoiceBubble } from '../../../modules/voice-bubble';
import { moveTaskToBack, nativeQuickAccess } from './nativeQuickAccess';
import { voiceBubble, voiceTile } from './quickAccess';

const fakeModule = (over: Partial<NativeVoiceBubble> = {}) =>
  ({
    isSupported: jest.fn(() => true),
    canDrawOverlays: jest.fn(() => true),
    openOverlaySettings: jest.fn(),
    isEnabled: jest.fn(() => true),
    isRunning: jest.fn(() => true),
    start: jest.fn(() => true),
    stop: jest.fn(),
    requestAddTile: jest.fn(async () => true),
    moveTaskToBack: jest.fn(() => true),
    ...over,
  }) satisfies NativeVoiceBubble;

const make = (
  module: NativeVoiceBubble | null,
  extra: Parameters<typeof nativeQuickAccess>[0] = {},
) =>
  nativeQuickAccess({
    module: () => module,
    os: () => 'android',
    sdk: () => 34,
    askNotifications: jest.fn(async () => ({ granted: true })),
    ...extra,
  });

describe('defaults in Jest (no native module)', () => {
  test('are unsupported', async () => {
    expect(voiceBubble.isSupported()).toBe(false);
    expect(voiceTile.isSupported()).toBe(false);
    expect(voiceBubble.canDrawOverlays()).toBe(false);
    voiceBubble.openOverlaySettings();
    expect(await voiceBubble.isEnabled()).toBe(false);
    expect(await voiceBubble.setEnabled(true)).toBe(false);
    expect(await voiceTile.requestAdd()).toBe(false);
    expect(moveTaskToBack()).toBe(false);
  });
});

describe('without the module or off Android', () => {
  test.each([
    ['module missing', null, 'android'],
    ['iOS', fakeModule(), 'ios'],
  ] as const)('%s is unsupported', async (_name, module, os) => {
    const { bubble, tile } = make(module, { os: () => os });
    expect(bubble.isSupported()).toBe(false);
    expect(tile.isSupported()).toBe(false);
    expect(await bubble.isEnabled()).toBe(false);
    expect(await bubble.setEnabled(true)).toBe(false);
    expect(await bubble.setEnabled(false)).toBe(false);
    expect(await tile.requestAdd()).toBe(false);
    expect(bubble.canDrawOverlays()).toBe(false);
    bubble.openOverlaySettings();
  });
});

describe('bubble', () => {
  test('reports the module state and opens the overlay settings', async () => {
    const module = fakeModule();
    const { bubble } = make(module);
    expect(bubble.isSupported()).toBe(true);
    expect(await bubble.isEnabled()).toBe(true);
    expect(bubble.canDrawOverlays()).toBe(true);
    bubble.openOverlaySettings();
    expect(module.openOverlaySettings).toHaveBeenCalledTimes(1);
  });

  test('turning on asks for notifications (Android 13+) then starts the service', async () => {
    const module = fakeModule();
    const askNotifications = jest.fn(async () => ({ granted: false }));
    const { bubble } = make(module, { askNotifications });
    expect(await bubble.setEnabled(true)).toBe(true);
    expect(askNotifications).toHaveBeenCalledTimes(1);
    expect(module.start).toHaveBeenCalledTimes(1);
  });

  test('a failing notification prompt does not block the bubble', async () => {
    const module = fakeModule();
    const { bubble } = make(module, {
      askNotifications: jest.fn(async () => {
        throw new Error('no');
      }),
    });
    expect(await bubble.setEnabled(true)).toBe(true);
  });

  test('before Android 13 there is no notification prompt', async () => {
    const askNotifications = jest.fn(async () => ({}));
    const { bubble } = make(fakeModule(), { sdk: () => 31, askNotifications });
    await bubble.setEnabled(true);
    expect(askNotifications).not.toHaveBeenCalled();
  });

  test('without the overlay permission it does not start', async () => {
    const module = fakeModule({ canDrawOverlays: jest.fn(() => false) });
    const { bubble } = make(module);
    expect(await bubble.setEnabled(true)).toBe(false);
    expect(module.start).not.toHaveBeenCalled();
  });

  test('the module refusing to start is false', async () => {
    const module = fakeModule({ start: jest.fn(() => false) });
    expect(await make(module).bubble.setEnabled(true)).toBe(false);
  });

  test('turning off stops the service', async () => {
    const module = fakeModule();
    expect(await make(module).bubble.setEnabled(false)).toBe(false);
    expect(module.stop).toHaveBeenCalledTimes(1);
  });
});

describe('tile', () => {
  test('needs Android 13 and asks the system to add it', async () => {
    const module = fakeModule();
    expect(make(module, { sdk: () => 32 }).tile.isSupported()).toBe(false);
    const { tile } = make(module);
    expect(tile.isSupported()).toBe(true);
    expect(await tile.requestAdd()).toBe(true);
    expect(module.requestAddTile).toHaveBeenCalledTimes(1);
  });
});

describe('moveTaskToBack', () => {
  test('goes through the module', () => {
    const module = fakeModule();
    expect(moveTaskToBack(() => module)).toBe(true);
    expect(module.moveTaskToBack).toHaveBeenCalledTimes(1);
  });
});
