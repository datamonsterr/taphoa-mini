# Play Console texts and Android test script (epic V3)

Status: Draft for owner review · Epic: V3 (issue #73) · Spec: [voice.md](voice.md) "Entry points" and
"Privacy and policy" · ADR: [0008](../../adr/0008-voice-audio-native-model.md)

The owner approves these texts before they go into the Play Console (App content). Nothing here
is submitted by the repository.

## What the app declares

| Item                                                                                                    | Where                                                        |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `SYSTEM_ALERT_WINDOW`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_SPECIAL_USE`, `RECEIVE_BOOT_COMPLETED` | `apps/mobile/modules/voice-bubble/plugin/withVoiceBubble.js` |
| `POST_NOTIFICATIONS` (also from `expo-notifications`)                                                   | same plugin, asked when the bubble is turned on              |
| `VoiceBubbleService`, `foregroundServiceType="specialUse"`, subtype property `floating voice shortcut`  | same plugin                                                  |
| `VoiceTileService` (Quick Settings tile "Bán hàng"), `BootReceiver`, static shortcut                    | same plugin                                                  |
| No `AccessibilityService`, no `BIND_ACCESSIBILITY_SERVICE`                                              | asserted by `withVoiceBubble.test.ts`                        |

## Data safety form

**Data type: Audio, "Voice or sound recordings".**

- Collected: yes. Shared: no (the speech model runs through our backend; processors acting on our behalf are not "sharing").
- Processed ephemerally: yes. Audio is held in memory on the server during the model call and discarded afterwards. It is not stored, unless the member turns on "Góp giọng nói để cải thiện" (off by default, not uploaded in the V2/V3 builds).
- Required or optional: optional (a seller can type the sale by hand).
- Purpose: App functionality (turn a spoken sale into a draft).
- Encrypted in transit: yes (HTTPS). Deletion: transcripts and drafts are deleted after 30 days; the member can delete the account data from the app.

Entry text (English): _"Audio: voice recordings, processed, not stored. The app records up to 30 seconds only after you open the voice sale sheet, sends it over HTTPS to our server to be turned into a sale draft, and the audio is discarded after processing. Transcripts of what you said are kept for 30 days."_

Entry text (Vietnamese): _"Âm thanh: ghi âm giọng nói, chỉ xử lý, không lưu. Ứng dụng chỉ ghi tối đa 30 giây sau khi bạn mở màn hình bán bằng giọng nói, gửi qua HTTPS lên máy chủ để thành đơn nháp, rồi bỏ đoạn ghi âm sau khi xử lý. Lời bạn nói (dạng chữ) được giữ 30 ngày."_

## Foreground service declaration (`specialUse`)

Type: `specialUse`. Subtype (manifest property): `floating voice shortcut`.

Declaration text: _"The app shows a floating microphone button over the home screen and other apps so a shop owner can start a voice sale with one tap while serving a customer. The user turns it on in Account settings, grants 'Display over other apps', and sees a persistent notification 'Nút nói đang bật' with a 'Tắt' action. The foreground service only keeps the overlay button alive; it never records audio, reads the screen or uses the network. Tapping the button opens the app's voice sale screen, which records in the foreground. No existing foreground service type describes a user-initiated overlay shortcut."_

Video for review: screen recording of steps 1-6 of the manual script below.

## "Display over other apps" rationale (in-app explainer)

Shown in Account before the Settings jump (strings `quick.explainTitle` and `quick.explainBody` in `strings.ts`):

> **Hiện trên ứng dụng khác.** Để nút nói nổi trên màn hình chính và các ứng dụng khác, Tạp Hóa Mini cần quyền "Hiện trên ứng dụng khác". Nút chỉ mở ứng dụng để bạn nói. Ứng dụng không đọc màn hình và không tự ghi âm. Bạn có thể tắt bất cứ lúc nào.

Play Console permission-declaration text: _"SYSTEM_ALERT_WINDOW draws one 56 dp button the user turned on. It has no other content, does not read or modify other apps, and the user can hide it (long-press) or switch it off (notification 'Tắt' or Account settings)."_

## Manual test script (real device, Android 13 or newer, plus one run on Android 15 and one on 8-12 if available)

Prepare: install the preview/dev build, sign in, create or open a store with a few products. Screen record the whole run (`adb shell screenrecord /sdcard/voice-v3.mp4`, or the system recorder).

| #   | Do                                                                  | Expect                                                                                                                                                         |
| --- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Tài khoản > "Hiện nút nói trên màn hình" (off)                      | The switch shows the explainer card, nothing else happens                                                                                                      |
| 2   | Tap "Để sau"                                                        | Card closes, switch is off                                                                                                                                     |
| 3   | Turn the switch on again, tap "Mở cài đặt"                          | System screen "Hiện trên ứng dụng khác" for Tạp Hóa Mini opens                                                                                                 |
| 4   | Allow it and go back                                                | App asks for the notification permission once (Android 13+), the switch is on, the bubble appears, notification "Nút nói đang bật" with "Tắt" shows            |
| 5   | Press Home                                                          | A 56 dp purple circle with a microphone sits at the right edge; TalkBack reads "Bán hàng bằng giọng nói"                                                       |
| 6   | Drag it to the left half and let go                                 | It snaps to the left edge; never leaves the screen; rotate the phone: it stays on an edge                                                                      |
| 7   | Open another app (Chrome, Zalo), tap the bubble                     | The voice sale sheet is up in under 500 ms (note the time from the recording), listening starts, the bubble is hidden while the app is in front                |
| 8   | Say "một chai tương ớt hai mươi nghìn", tap Xong, then Xác nhận bán | Sale recorded, toast shows, the previous app (Chrome/Zalo) is in front again                                                                                   |
| 9   | Repeat step 7 from the home screen, then tap Đóng                   | The home screen returns                                                                                                                                        |
| 10  | Long-press the bubble                                               | It hides. It stays hidden on Home. Open Tạp Hóa Mini and leave it: the bubble is back                                                                          |
| 11  | Pull down the notification, tap "Tắt"                               | Bubble and notification go; Tài khoản shows the switch off after reopening                                                                                     |
| 12  | Turn the switch on, restart the phone                               | After boot and unlock the bubble and notification are back (switch was on)                                                                                     |
| 13  | Turn the switch off, restart the phone                              | Nothing starts after boot                                                                                                                                      |
| 14  | Revoke "Hiện trên ứng dụng khác" in Settings, restart               | The service does not start; Tài khoản shows the switch off                                                                                                     |
| 15  | Tài khoản > "Thêm ô cài đặt nhanh" (Android 13+)                    | System dialog to add the tile; accept; the row reads "Đã thêm ô cài đặt nhanh"                                                                                 |
| 16  | Open Quick Settings, tap "Bán hàng"                                 | Panel collapses, the voice sale sheet opens (`entry=tile`)                                                                                                     |
| 17  | Long-press the app icon, tap "Bán hàng bằng giọng nói"              | The voice sale sheet opens (`entry=shortcut`)                                                                                                                  |
| 18  | Lock the phone with the bubble on, unlock                           | Bubble still shows; tapping it still opens the sheet                                                                                                           |
| 19  | Android 15 only: with the app swiped away, tap the bubble           | The sheet still opens (overlay holder is allowed to start from the background); no "Background activity launch blocked" in `adb logcat -s ActivityTaskManager` |

### Screen recording checklist

- Show the device model and Android version (Settings > About phone) at the start.
- Steps 1-6 uninterrupted (the Play review video).
- Step 7 with the on-screen touch indicator on (Developer options) so the 500 ms is visible.
- Step 8 to the moment the previous app is in front.
- Steps 11, 12, 16, 17.
- Save as `voice-v3-<device>-android<version>.mp4`, attach to the V3 PR and the DoD report (row 1 and row 7).

### Optional adb helpers

```bash
adb shell appops set com.datamonsterr.taphoamini SYSTEM_ALERT_WINDOW allow   # grant without the Settings trip
adb shell am start -a android.intent.action.VIEW -d 'taphoa://voice?entry=bubble\&returnToPrevious=1'
adb logcat -s ActivityTaskManager | grep -i "background activity"
adb shell dumpsys activity services expo.modules.voicebubble | head -30
```

## Needs the owner

- Approve the data-safety, `specialUse` and overlay texts above.
- Run the manual script on the real phone and attach the recordings.
- Enter the declarations in Play Console (App content > Data safety, Foreground service permissions) when a Play build exists.
