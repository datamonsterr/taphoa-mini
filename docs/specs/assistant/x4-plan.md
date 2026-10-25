# X4 plan: assistant mobile

Status: In progress · Date: 2026-10-25 · Epic brief: [epics.md](epics.md) "X4" · UI spec:
[assistant.md](assistant.md) "Mobile UI", "Next-step strip", U14, U15 · Events:
[telemetry-contract.md](telemetry-contract.md) "Product events" (app rows).

## Decisions

- **Streaming transport.** No new fetch layer. On SDK 58 `expo/fetch` is installed as the global
  `fetch` on Android and iOS (docs: `versions/v58.0.0/sdk/expo`, "expo/fetch API"), so the existing
  auth fetch already returns a streaming `response.body`; the web uses the browser fetch. The chat
  reads replies with `getApiClient().sendAssistantMessage(...)` from `@taphoa/api-client` (X0) and an
  `AbortController` per turn. The stream is never re-sent automatically; Retry sends the user
  message again as a new turn.
- **Speech recognition.** `expo-speech-recognition@~58.0.0` (versioned for SDK 58, published
  2026-10-16; `@react-native-voice/voice` has had no release since 2022; `expo-speech` is
  text-to-speech only). Config plugin in `app.json` with Vietnamese permission texts. Start options:
  `lang` `vi-VN` or `en-US` from the app language, `interimResults: true`, `continuous: true` while
  the button is held, `requiresOnDeviceRecognition` when `supportsOnDeviceRecognition()` is true.
  Release calls `stop()`; the final transcript fills the input and is never sent automatically. Web
  uses the library's Web Speech API path and hides the button when `isRecognitionAvailable()` is
  false. On Android and iOS the button is always visible: without recognition it looks disabled and
  a press says "Máy này chưa hỗ trợ nói thành chữ". If an on-device start fails before any result
  (for example `language-not-supported`), the hold restarts once with
  `requiresOnDeviceRecognition: false`. Expo Go does not ship the native module, so
  `voice/speechModule.ts` loads the package lazily after checking
  `requireOptionalNativeModule('ExpoSpeechRecognition')`; without the module the mic shows the
  unavailable state and the app still starts.
  Native module, so it needs a new development or preview build (fingerprint changes).
- **Route.** `src/app/assistant.tsx` renders `features/assistant/AssistantScreen`, registered in the
  root stack inside the signed-in guard as a `transparentModal` that slides from the bottom (one
  line in X1's root layout). Params: `threadId?`, `entry` (`button`, `chip`, `receipt`, `digest`,
  `push`), `prompt?`, `screen?`, `nextStepId?`, `receiptId?`. X8 reuses it for push and digest.
- **Chat button.** `components/assistant/ChatButton` (56 dp accent circle, screen-reader label). In
  the shop tabs it sits in the `ShopTabBar` row to the right of the tab pill, so it covers no
  content and no tab target; when the window is too narrow for the pill to keep its three 56 dp
  tabs, it moves above the right end of the bar (same right inset, one gap above). On the camera
  screen it sits at the right end of the bottom row (cart pill left, swipe handle centre), below
  the shutter row.
- **Next-step strip.** `components/assistant/NextStepStrip`: one horizontal `ScrollView` of chips
  with snapping, haptic on tap, hidden when empty, inside the existing 80 dp strip slot under the
  viewfinder, so the viewfinder size does not change. It yields the slot to the quick-enroll hints,
  notices and the alternatives strip while those show. On-device chips go first:
  `receipt_detected` (the current scan has `document.detected` and the member can enroll) and
  `unknown_product` (a low-match detection; opens `/enroll` like the enroll button). Server chips
  come from `GET /v1/assistant/next-steps?screen=camera&document_detected=&unknown_product=`,
  de-duplicated by kind. Server chips show `title_vi`, or an `en` title by kind when the app is in
  English. Analytics: `next_step_shown` once per chip per screen visit, `next_step_tapped`.
- **Receipt in chat (U14).** The camera does the first half: the `receipt_detected` chip creates
  the receipt from the current scan image (`POST /v1/receipts`, the existing `readReceipt` with its
  notices) and opens `/assistant?entry=receipt&screen=camera&receiptId=<id>`. A pure state machine
  in the chat (`features/assistant/receiptChat.ts`) drives the rest:
  `creating_thread → sending → reviewing → awaiting_confirm → confirming → confirmed`, plus
  `rejected`, `expired` and `failed` (`thread`, `stream`, `action`; Retry goes back to the step that
  failed). The chat creates the thread with `context: {screen: camera, next_step_id:
receipt_detected, receipt_id}`, sends the first message with `attachments: [{receipt_id}]`,
  and the reply (`get_receipt` tool line, `receipt_lines` card, short text, `receipt_confirm`
  action) moves the machine. `deriveReceiptPhase(messages, receiptId)` reads the same phase from the
  messages, so a reopened thread (its context has `receipt_id`) lands in the right place.
  `useReceiptChat` feeds the machine, hears a `409 action_stale` from the mutation cache, and on
  `confirmed` invalidates the receipt, receipts list, stock and product queries. A status row above
  the messages shows the phase with an always-visible "Xem dạng bảng" link to `/receipt/{id}` (back
  returns to the chat); the success haptic comes from the action card that confirms. Tapping a
  card line prefills the input with that line. The existing document button and receipt form are
  unchanged.
- **Actions.** Confirm calls `POST /v1/assistant/actions/{id}/confirm` with
  `Idempotency-Key: <action id>`; Reject calls `/reject`. `409 action_stale` shows "expired",
  `already_decided` refetches the thread.
- **Feature flag.** `useAssistantEnabled()` returns true until X6 maps it to a PostHog flag; the chat
  button and the strip render nothing when it is false.
- **Files.** All new code lives in `features/assistant/**` and `components/assistant/**`; assistant
  query hooks and keys live in `features/assistant/api.ts` (not `lib/api/hooks.ts`, which X1 and X5
  edit). Integration edits are limited to `ShopTabBar.tsx`, `CameraScreen.tsx`, the root layout
  line, `app.json`, `package.json` and a root `__mocks__/expo-speech-recognition.ts` for Jest.

## Tasks (tests first in each)

| #   | Task                                                                                                                     | Tests written first                                                                                    | Depends | Worker     |
| --- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ------- | ---------- |
| A1  | Core: query hooks, stream reducer and `useAssistantChat`, strings, flag hook, route param types                          | `api.test.tsx`, `chatReducer.test.ts`, `useAssistantChat.test.tsx`                                     | none    | sonnet     |
| A2  | Voice: install library, plugin, Jest mock, `useVoiceInput`, `VoiceButton`                                                | `useVoiceInput.test.tsx`, `VoiceButton.test.tsx`                                                       | none    | sonnet     |
| B1  | Chat UI: message view, tool lines, four cards, action card, feedback, retry, quota; screen, thread list, composer, route | one test file per component, `AssistantScreen.test.tsx`                                                | A1, A2  | sonnet     |
| B2  | Entry points: `ChatButton` in shop tabs and camera; `NextStepStrip` with on-device chips in the camera strip slot        | `ChatButton.test.tsx`, `NextStepStrip.test.tsx`, `useNextStepChips.test.tsx`, camera and tab bar tests | A1      | sonnet     |
| C1  | Receipt in chat: state machine and wiring (chip, auto-send, line tap, confirm, "Xem dạng bảng")                          | `receiptChat.test.ts`, `ReceiptChat.test.tsx`                                                          | B1, B2  | sonnet     |
| C2  | E2E: Playwright `e2e-web/assistant.spec.ts`, Maestro `.maestro/assistant.yaml`                                           | the specs themselves                                                                                   | C1      | sonnet     |
| D   | Review, `pnpm turbo run lint typecheck test`, bundle budget, PR, `ci-ok`, merge, cleanup                                 | none                                                                                                   | all     | controller |

A1 and A2 run in parallel; B1 and B2 run in parallel after A1 (B1 also after A2).

## Acceptance

- Jest covers every new component, the chat reducer and the receipt-chat state machine against the
  mock API; the mobile coverage thresholds stay green.
- Playwright web: open chat from the tab bar, ask, see the streamed answer, confirm an action.
- Maestro Android: a chip opens the chat, the voice button is visible, the receipt chat confirms.
- E2E runs against the real backend. In CI the local stack runs X3's scripted model mode (no
  OpenRouter): "nhập hàng" streams a `get_restock_plan` status, a reply and a
  `propose_reorder_list` card; "điều chỉnh" proposes `propose_stock_adjustment`; a thread with
  `context.receipt_id` gets a `receipt_lines` card, then a `propose_receipt_confirm` card; anything
  else gets a fixed short reply (exact strings in `x3-plan.md`). One smoke spec runs only against
  Railway `test` with the real free model. Until X3 is on `main` the specs run locally against X3's
  branch.
- All assistant calls, including the SSE stream, go through the shared API client
  (`getApiClient()`), so headers added by X1 (`X-Store-Id`) apply without X4 changes.
- DoD rows 1 and 3; `npx expo lint`, `npx tsc --noEmit`, `ci-ok` green.

## Version pins

- `expo-speech-recognition` ~58.0.0 (Expo SDK 58.0.17).
- Streaming: SDK 58 global `fetch` (`expo/fetch`) on native, browser fetch on web; `openapi-fetch`
  0.17 `parseAs: "stream"` (X0).
