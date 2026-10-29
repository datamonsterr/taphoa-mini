/**
 * Config plugin for the voice bubble: manifest entries and the static app shortcut.
 * Deliberately declares NO AccessibilityService (ADR 0008).
 */
const fs = require('node:fs');
const path = require('node:path');
const {
  withAndroidManifest,
  withDangerousMod,
} = require('expo/config-plugins');

const PKG = 'expo.modules.voicebubble';
const SUBTYPE = 'floating voice shortcut';
const SHORTCUT_RESOURCE = 'voice_shortcuts';

const PERMISSIONS = [
  'android.permission.SYSTEM_ALERT_WINDOW',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_SPECIAL_USE',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.RECEIVE_BOOT_COMPLETED',
];

function addPermissions(manifest) {
  const list = (manifest['uses-permission'] ??= []);
  for (const name of PERMISSIONS) {
    if (!list.some((p) => p.$['android:name'] === name)) {
      list.push({ $: { 'android:name': name } });
    }
  }
}

function upsert(list, name, entry) {
  const at = list.findIndex((item) => item.$['android:name'] === name);
  if (at >= 0) list[at] = entry;
  else list.push(entry);
}

function isLauncher(activity) {
  return (activity['intent-filter'] ?? []).some((f) =>
    (f.category ?? []).some(
      (c) => c.$['android:name'] === 'android.intent.category.LAUNCHER',
    ),
  );
}

/** Mutates an AndroidManifest JSON (xml2js shape). Safe to run twice. */
function applyVoiceBubbleManifest(manifest) {
  addPermissions(manifest);
  const application = manifest.application[0];

  application.service ??= [];
  upsert(application.service, `${PKG}.VoiceBubbleService`, {
    $: {
      'android:name': `${PKG}.VoiceBubbleService`,
      'android:exported': 'false',
      'android:foregroundServiceType': 'specialUse',
    },
    property: [
      {
        $: {
          'android:name': 'android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE',
          'android:value': SUBTYPE,
        },
      },
    ],
  });
  upsert(application.service, `${PKG}.VoiceTileService`, {
    $: {
      'android:name': `${PKG}.VoiceTileService`,
      'android:exported': 'true',
      'android:icon': '@drawable/ic_voice_mic',
      'android:label': '@string/voice_tile_label',
      'android:permission': 'android.permission.BIND_QUICK_SETTINGS_TILE',
    },
    'intent-filter': [
      {
        action: [
          {
            $: {
              'android:name': 'android.service.quicksettings.action.QS_TILE',
            },
          },
        ],
      },
    ],
  });

  application.receiver ??= [];
  upsert(application.receiver, `${PKG}.BootReceiver`, {
    $: { 'android:name': `${PKG}.BootReceiver`, 'android:exported': 'false' },
    'intent-filter': [
      {
        action: [
          { $: { 'android:name': 'android.intent.action.BOOT_COMPLETED' } },
        ],
      },
    ],
  });

  const main = (application.activity ?? []).find(isLauncher);
  if (main) {
    main['meta-data'] ??= [];
    upsert(main['meta-data'], 'android.app.shortcuts', {
      $: {
        'android:name': 'android.app.shortcuts',
        'android:resource': `@xml/${SHORTCUT_RESOURCE}`,
      },
    });
  }
  return manifest;
}

/** res/xml/voice_shortcuts.xml: the long-press app icon shortcut. */
function shortcutsXml(applicationId, scheme) {
  return `<?xml version="1.0" encoding="utf-8"?>
<shortcuts xmlns:android="http://schemas.android.com/apk/res/android">
  <shortcut
      android:shortcutId="voice_sale"
      android:enabled="true"
      android:icon="@drawable/ic_voice_mic"
      android:shortcutShortLabel="@string/voice_shortcut_short"
      android:shortcutLongLabel="@string/voice_shortcut_long">
    <intent
        android:action="android.intent.action.VIEW"
        android:targetPackage="${applicationId}"
        android:targetClass="${applicationId}.MainActivity"
        android:data="${scheme}://voice?entry=shortcut" />
  </shortcut>
</shortcuts>
`;
}

function withVoiceBubble(config) {
  config = withAndroidManifest(config, (c) => {
    applyVoiceBubbleManifest(c.modResults.manifest);
    return c;
  });
  return withDangerousMod(config, [
    'android',
    (c) => {
      const applicationId = c.android?.package;
      if (!applicationId) {
        throw new Error('voice-bubble: set expo.android.package in app.json');
      }
      const scheme = [].concat(c.scheme ?? 'taphoa')[0];
      const dir = path.join(
        c.modRequest.platformProjectRoot,
        'app/src/main/res/xml',
      );
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, `${SHORTCUT_RESOURCE}.xml`),
        shortcutsXml(applicationId, scheme),
      );
      return c;
    },
  ]);
}

module.exports = withVoiceBubble;
module.exports.applyVoiceBubbleManifest = applyVoiceBubbleManifest;
module.exports.shortcutsXml = shortcutsXml;
