/* eslint-disable @typescript-eslint/no-require-imports -- the plugin is CommonJS */
const { applyVoiceBubbleManifest, shortcutsXml } = require('./withVoiceBubble');

type Item = { $: Record<string, string> } & Record<string, unknown>;

const sample = () => ({
  manifest: {
    'uses-permission': [
      { $: { 'android:name': 'android.permission.POST_NOTIFICATIONS' } },
    ],
    application: [
      {
        activity: [
          {
            $: { 'android:name': '.MainActivity' },
            'intent-filter': [
              {
                action: [
                  { $: { 'android:name': 'android.intent.action.MAIN' } },
                ],
                category: [
                  { $: { 'android:name': 'android.intent.category.LAUNCHER' } },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
});

const run = () => {
  const m = sample();
  applyVoiceBubbleManifest(m.manifest);
  return m.manifest;
};
const names = (list: Item[]) => list.map((i) => i.$['android:name']);

describe('voice bubble manifest plugin', () => {
  test('adds each permission once, keeping one that already exists', () => {
    const permissions = names(run()['uses-permission'] as Item[]);
    for (const p of [
      'SYSTEM_ALERT_WINDOW',
      'FOREGROUND_SERVICE',
      'FOREGROUND_SERVICE_SPECIAL_USE',
      'POST_NOTIFICATIONS',
      'RECEIVE_BOOT_COMPLETED',
    ]) {
      expect(
        permissions.filter((n) => n === `android.permission.${p}`),
      ).toHaveLength(1);
    }
  });

  test('declares the specialUse service with the subtype property', () => {
    const [app] = run().application as Record<string, Item[]>[];
    const service = app.service.find(
      (s) =>
        s.$['android:name'] === 'expo.modules.voicebubble.VoiceBubbleService',
    ) as Item & { property: Item[] };
    expect(service.$['android:foregroundServiceType']).toBe('specialUse');
    expect(service.$['android:exported']).toBe('false');
    expect(service.property[0].$).toEqual({
      'android:name': 'android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE',
      'android:value': 'floating voice shortcut',
    });
  });

  test('declares the tile, the boot receiver and the shortcut meta-data', () => {
    const [app] = run().application as Record<string, Item[]>[];
    const tile = app.service.find((s) =>
      s.$['android:name'].endsWith('VoiceTileService'),
    );
    expect(tile?.$['android:permission']).toBe(
      'android.permission.BIND_QUICK_SETTINGS_TILE',
    );
    expect(tile?.$['android:exported']).toBe('true');
    const receiver = app.receiver[0] as Item & {
      'intent-filter': { action: Item[] }[];
    };
    expect(receiver.$['android:name']).toBe(
      'expo.modules.voicebubble.BootReceiver',
    );
    expect(receiver['intent-filter'][0].action[0].$['android:name']).toBe(
      'android.intent.action.BOOT_COMPLETED',
    );
    const main = app.activity[0] as Item & { 'meta-data': Item[] };
    expect(main['meta-data'][0].$['android:resource']).toBe(
      '@xml/voice_shortcuts',
    );
  });

  test('never declares an AccessibilityService', () => {
    const json = JSON.stringify(run());
    expect(json).not.toMatch(/accessibilityservice/i);
    expect(json).not.toContain('BIND_ACCESSIBILITY_SERVICE');
  });

  test('running twice does not duplicate anything', () => {
    const m = sample();
    applyVoiceBubbleManifest(m.manifest);
    const once = JSON.stringify(m.manifest);
    applyVoiceBubbleManifest(m.manifest);
    expect(JSON.stringify(m.manifest)).toBe(once);
  });

  test('the shortcut opens the voice route with entry=shortcut', () => {
    const xml = shortcutsXml('com.example.app', 'taphoa');
    expect(xml).toContain('android:data="taphoa://voice?entry=shortcut"');
    expect(xml).toContain('android:targetClass="com.example.app.MainActivity"');
  });
});
