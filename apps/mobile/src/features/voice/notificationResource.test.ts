import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('Android notification body matches VoiceSystem board', () => {
  const xml = readFileSync(
    join(
      __dirname,
      '../../../modules/voice-bubble/android/src/main/res/values/strings.xml',
    ),
    'utf8',
  );
  expect(xml).toContain(
    '<string name="voice_bubble_notification_text">Chạm nút nói trên màn hình để bán hàng.</string>',
  );
});
