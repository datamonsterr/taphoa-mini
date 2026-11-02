# PR 301 E2E failure triage

Scope: CI run [41494882346, web job 125448853631](https://github.com/datamonsterr/taphoa-mini/actions/runs/41494882346/job/125448853631)
and Android run [41494882237](https://github.com/datamonsterr/taphoa-mini/actions/runs/41494882237).
These are results observed before the local fixes. This report does not claim a green rerun of hosted E2E.

## Compared baselines

| Run                                                                                                           | Result and implication                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Head web 41494882346](https://github.com/datamonsterr/taphoa-mini/actions/runs/41494882346)                  | 62 failed, 65 passed, 2 skipped, 2 dependent perf tests did not run. Every failing functional test first fails on a product or scan HTTP 503.                                                                                                   |
| [Before SigLIP2, web 41490933901](https://github.com/datamonsterr/taphoa-mini/actions/runs/41490933901)       | 19 failed, 108 passed. 18 failures use single-result locators/cart assumptions with three actual detections; barcode waits for enrollment without selecting Code. These are earlier regressions within this PR, not pre-existing main failures. |
| [Green main CI 41363065687](https://github.com/datamonsterr/taphoa-mini/actions/runs/41363065687)             | Commit 4994256, 128 passed, 2 skipped.                                                                                                                                                                                                          |
| [Before SigLIP2, Android 41490933940](https://github.com/datamonsterr/taphoa-mini/actions/runs/41490933940)   | Cancelled. Completed flows already fail multi-session/onboarding at PIN; inventory/debts/checkout/barcode pass. Unfinished receipts/grid-sale/voice-bubble cannot be classified from the cancellation.                                          |
| [Latest green main Android 40789824892](https://github.com/datamonsterr/taphoa-mini/actions/runs/40789824892) | Commit c8a4c27. Both shards pass, including PIN, receipt, inventory, debts, checkout and barcode. Its older flow matrix does not include current grid-sale or voice-bubble coverage.                                                            |

## Root causes and evidence

1. **Selected embedder never configured in the E2E launcher.** `scripts/e2e/stack.sh`
   fetches and checksum-verifies the SigLIP2 artifact, but originally exported only
   `DINO_MODEL_PATH`. `Config::embedder` now selects SigLIP2 by default and returns
   `None` without `SIGLIP2_MODEL_PATH`. This leaves `/readyz` healthy but product
   creation and scans unavailable. Web log lines 996 and 1232 show respectively
   `POST /v1/products answered 503` and `POST /v1/recognition/scans answered 503`
   with `no model loaded`. Android backend artifacts show scan 503 at line 133
   (`maestro-backend-log-a/backend.log`) and lines 62, 97, 105, 113 (shard b).
   Receipt setup's `logs/maestro.log` says `Receipt setup POST /v1/products failed: HTTP 503`.
   The E2E jobs use the downloaded host binary, not the `SKIP_MODELS=1` Docker smoke
   image. No embedder load exception or missing-model download caused these failures.
   Fix: export both real model paths and exercise default/custom model directories in a
   launcher contract test, run by CI whenever `scripts/e2e/**` changes.

2. **Tests retained the old single-result and implicit-barcode behavior.** Before
   SigLIP2, `web-e2e-report` traces and error contexts show three boxes and three
   identically named pills. `camera.spec.ts:38` expected one; the checkout helper's
   locator matched all three. The backend returned real successful matches.
   `object-capture.md` intentionally replaces One/Many with Object/Code and always
   submits `multi`. Tests now validate every returned box and pill, explicitly select
   one crop for tests requiring one cart item, and separately verify batch addition at
   server prices. Multiple-result alternatives open by choosing the desired price pill.
   Unknown enrollment chooses a crop explicitly. Barcode now explicitly selects Code.
   Recognition tests assert the default SigLIP2 model identity. No endpoint is mocked,
   threshold lowered, error ignored, or assertion retried conditionally on failure.

3. **Added Account setting moved controls below the viewport.** Head Android screenshots
   `onboarding/screenshots/step-047-assertCondition-Đặt_mã_PIN.png` and
   `multi-session/screenshots/step-043-tapOnElement-Đặt_mã_PIN.png` show a working Account
   screen with the new `Tự nhận diện` row; PIN is below the fold. The voice-bubble failure
   screenshot `voice-bubble/screenshots/step-044-assertCondition-Ô_cài_đặt_nhanh.png`
   shows only the top of the voice section near the floating navigation bar. These are
   viewport assertions, not startup crashes. The spec intentionally adds the setting.
   Fix: scroll to PIN and to the quick-settings tile before asserting or interacting.
   All original PIN and voice permission assertions remain.

4. **Native frame worker called an RN-only scheduler.** Device logcat repeatedly reports
   `[Worklets] Tried to synchronously call a Remote Function` on the camera runtime.
   There are no `FATAL EXCEPTION` records in the downloaded flow logcats. In installed
   Worklets 0.13 legacy mode, `scheduleOnUI` is RN-only, matching its
   [official call table](https://docs.swmansion.com/react-native-worklets/docs/threading/scheduleOnUI/).
   Both successful frame processing and its catch path called it from the camera worker.
   Fix: use `scheduleOnRuntimeWithId(UIRuntimeId, ...)` with worklet callbacks in the
   production preview and native developer screen; this scheduler explicitly supports
   workers and the UI target in the
   [0.13 documentation](https://docs.swmansion.com/react-native-worklets/docs/threading/scheduleOnRuntimeWithId/).
   The runtime-aware Jest reproduction fails 6 native tests before the fix and passes
   all 12 native tests after it. Native scans reached the backend even with these errors;
   their observed HTTP 503 is caused by item 1. This fixes the accompanying preview/box
   runtime regression as well, without substituting expo-camera in the release APK.

Artifacts are kept locally under the gitignored `.ci-cache/triage/`: `web-head/`,
`web-before/`, `android-head/a/`, `android-head/b/`, and `android-before/a/`.
The reports contain disposable test identities; raw traces/logs are not committed.
Screenshots live under each artifact's `work/taphoa-mini/taphoa-mini/apps/mobile/maestro-debug/`.
Logs were fetched using `gh api .../actions/jobs/<id>/logs --allow-escape-sequences`;
artifacts were downloaded with `gh run download <run> -n <name>`.

## Every failing head web test

Each row is a **PR regression**, with HTTP evidence from the head job log at the listed
line. `Product 503` means failure during API seeding/creation, before the screen under
assertion. `Scan 503` includes the backend's `no model loaded` response. Fix **E** exports
`SIGLIP2_MODEL_PATH`; **O** adapts the intentional Object/multi flow; **C** selects Code.
The earlier-run column records additional failures that would otherwise reappear after E.

| Test at failing revision                                                                                                                                                      | Immediate cause; head log line | Class         | Fix  | Earlier-run evidence                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------- | ---- | -------------------------------------------------------------------- |
| `assistant.spec.ts:220` — chat looks like board 17: sheet, header, bubble, tool row, thumbs, composer                                                                         | Product 503; 994               | PR regression | E    | Passed before SigLIP2                                                |
| `assistant.spec.ts:360` — stock adjustment: tool line, action card, confirm changes the stock once                                                                            | Product 503; 1042              | PR regression | E    | Passed before SigLIP2                                                |
| `assistant.spec.ts:419` — receipt chat: lines card, table view and back, confirm imports the receipt                                                                          | Product 503; 1090              | PR regression | E    | Passed before SigLIP2                                                |
| `barcode.spec.ts:54` — unknown scan → enroll with duplicate correction → known scan → barcode sale; edit barcode                                                              | Product 503; 1136              | PR regression | E, C | Code mode was not selected                                           |
| `camera.spec.ts:38` — camera › a matched item: the price pill is the server candidate; the strip lists the candidates                                                         | Product 503; 1182              | PR regression | E, O | Single-result locator/cart assumption after Object switched to multi |
| `camera.spec.ts:68` — camera › retake returns to the live preview and a second shot is scanned again                                                                          | Scan 503; 1230                 | PR regression | E    | Passed before SigLIP2                                                |
| `camera.spec.ts:85` — camera › + adds the matched item: the cart pill count and total follow, the camera is live again                                                        | Product 503; 1336              | PR regression | E, O | Single-result locator/cart assumption after Object switched to multi |
| `cart-picker.spec.ts:46` — cart row and customer picker match boards 06 and 07c                                                                                               | Product 503; 1384              | PR regression | E, O | Single-result locator/cart assumption after Object switched to multi |
| `checkout.spec.ts:26` — cart sheet › stepper, remove and close change the cart the camera shows                                                                               | Product 503; 1432              | PR regression | E, O | Single-result locator/cart assumption after Object switched to multi |
| `checkout.spec.ts:73` — checkout and payment › transfer: the QR shows the store bank; "Đã nhận tiền" posts the sale and the dashboard counts it                               | Product 503; 1480              | PR regression | E, O | Single-result locator/cart assumption after Object switched to multi |
| `checkout.spec.ts:152` — checkout and payment › cash: every quick note shows its change; the sale records what was handed over                                                | Product 503; 1528              | PR regression | E, O | Single-result locator/cart assumption after Object switched to multi |
| `checkout.spec.ts:209` — checkout and payment › without a bank account the QR says so; cash still works                                                                       | Product 503; 1576              | PR regression | E, O | Single-result locator/cart assumption after Object switched to multi |
| `close.spec.ts:64` — close the day › the expected cash is the server figure; save stays disabled until digits                                                                 | Product 503; 1624              | PR regression | E    | Passed before SigLIP2                                                |
| `close.spec.ts:85` — close the day › the difference pill follows the typed count: short, match, extra                                                                         | Product 503; 1674              | PR regression | E    | Passed before SigLIP2                                                |
| `close.spec.ts:109` — close the day › save puts the count; the server difference is what reopening shows, read-only                                                           | Product 503; 1724              | PR regression | E    | Passed before SigLIP2                                                |
| `debts.spec.ts:25` — debt book › sell on credit, repay, see zero balance                                                                                                      | Product 503; 1774              | PR regression | E, O | Single-result locator/cart assumption after Object switched to multi |
| `error-states.spec.ts:474` — offline › #205 closing the day offline is refused with a message and sends nothing                                                               | Product 503; 1822              | PR regression | E    | Passed before SigLIP2                                                |
| `error-states.spec.ts:575` — offline › #243 confirming a receipt offline says so and keeps the draft                                                                          | Product 503; 1870              | PR regression | E    | Passed before SigLIP2                                                |
| `expense.spec.ts:66` — add expense › save posts the expense; the dashboard shows the server totals                                                                            | Product 503; 1916              | PR regression | E    | Passed before SigLIP2                                                |
| `inventory.spec.ts:63` — inventory › lists what GET /v1/products returned                                                                                                     | Product 503; 1964              | PR regression | E    | Passed before SigLIP2                                                |
| `inventory.spec.ts:93` — inventory › search sends q to the server; the grid is its answer; clear restores it                                                                  | Product 503; 2012              | PR regression | E    | Passed before SigLIP2                                                |
| `inventory.spec.ts:149` — product › detail shows the product the server returns; back returns to the grid                                                                     | Product 503; 2060              | PR regression | E    | Passed before SigLIP2                                                |
| `inventory.spec.ts:185` — product › edit price: PATCH answers with the new price, detail and grid show it, the history records it                                             | Product 503; 2108              | PR regression | E    | Passed before SigLIP2                                                |
| `offline.spec.ts:27` — offline sale › network off: sell from the grid in cash; network on: the sale posts once and the reports count it                                       | Product 503; 2156              | PR regression | E    | Passed before SigLIP2                                                |
| `offline.spec.ts:100` — offline sale › network off: the camera strip hides the server suggestion chips; network on: they return                                               | Product 503; 2202              | PR regression | E    | Passed before SigLIP2                                                |
| `quick-enroll.spec.ts:20` — quick enroll (real SAM and DINO models) › three accepted photos enroll asynchronously, then checkout matches the product and adds it to the cart  | Product 503; 2248              | PR regression | E, O | Single-result locator/cart assumption after Object switched to multi |
| `receipts.spec.ts:72` — receipt camera → edit 19b → summary 19 → confirmed stock                                                                                              | Product 503; 2352              | PR regression | E    | Passed before SigLIP2                                                |
| `recognition.spec.ts:51` — recognition and enroll (real models) › an empty store sees the item as unknown; enrolling it makes the next shot a match that goes to the cart     | Scan 503; 2398                 | PR regression | E, O | Single-result locator/cart assumption after Object switched to multi |
| `recognition.spec.ts:152` — recognition and enroll (real models) › object mode sends mode=multi; every detection the server returns gets a box                                | Scan 503; 2504                 | PR regression | E    | Passed before SigLIP2                                                |
| `recognition.spec.ts:164` — recognition and enroll (real models) › enroll with an extra angle uploads both photos and creates one product                                     | Scan 503; 2610                 | PR regression | E, O | Single-result locator/cart assumption after Object switched to multi |
| `recognition.spec.ts:179` — recognition and enroll (real models) › enrolling the same item again: the server suspects a duplicate; merge adds a photo to the existing product | Scan 503; 2716                 | PR regression | E, O | Single-result locator/cart assumption after Object switched to multi |
| `recognition.spec.ts:213` — recognition and enroll (real models) › enrolling the same item again: "create anyway" sends force_new and makes a second product                  | Scan 503; 2778                 | PR regression | E, O | Single-result locator/cart assumption after Object switched to multi |
| `reports.spec.ts:35` — dashboard › day: the tiles are GET /v1/reports/today; the chart is the summary, one bar per day                                                        | Product 503; 2840              | PR regression | E    | Passed before SigLIP2                                                |
| `reports.spec.ts:82` — dashboard › week and month chips ask for their own summary and sales and show those figures; Ngày goes back                                            | Product 503; 2888              | PR regression | E    | Passed before SigLIP2                                                |
| `reports.spec.ts:150` — dashboard alerts and review › pills count what the server holds; the below-cost row is the alert and opens the product                                | Product 503; 2936              | PR regression | E    | Passed before SigLIP2                                                |
| `reports.spec.ts:192` — dashboard alerts and review › a loose item sold at a typed price: enroll it from the review list and the line is resolved                             | Product 503; 2984              | PR regression | E    | Passed before SigLIP2                                                |
| `screens.spec.ts:73` — board screenshots › Match: one item recognised                                                                                                         | Product 503; 3032              | PR regression | E, O | Single-result locator/cart assumption after Object switched to multi |
| `screens.spec.ts:81` — board screenshots › Multi: every detection boxed                                                                                                       | Product 503; 3080              | PR regression | E    | Passed before SigLIP2                                                |
| `screens.spec.ts:88` — board screenshots › Unknown: nothing in the catalog matches                                                                                            | Scan 503; 3128                 | PR regression | E, O | Single-result locator/cart assumption after Object switched to multi |
| `screens.spec.ts:97` — board screenshots › Enroll: price a new product                                                                                                        | Scan 503; 3234                 | PR regression | E, O | Single-result locator/cart assumption after Object switched to multi |
| `screens.spec.ts:105` — board screenshots › Cart: lines and QR button                                                                                                         | Product 503; 3340              | PR regression | E, O | Single-result locator/cart assumption after Object switched to multi |
| `screens.spec.ts:115` — board screenshots › Pay: VietQR                                                                                                                       | Product 503; 3388              | PR regression | E, O | Single-result locator/cart assumption after Object switched to multi |
| `screens.spec.ts:128` — board screenshots › Inventory: stock grid                                                                                                             | Product 503; 3436              | PR regression | E    | Passed before SigLIP2                                                |
| `screens.spec.ts:135` — board screenshots › Stock: tồn kho list                                                                                                               | Product 503; 3484              | PR regression | E    | Passed before SigLIP2                                                |
| `screens.spec.ts:157` — board screenshots › Product: detail                                                                                                                   | Product 503; 3532              | PR regression | E    | Passed before SigLIP2                                                |
| `screens.spec.ts:167` — board screenshots › Dashboard: reports (390x1080)                                                                                                     | Product 503; 3580              | PR regression | E    | Passed before SigLIP2                                                |
| `screens.spec.ts:196` — board screenshots › Close: close the day                                                                                                              | Product 503; 3628              | PR regression | E    | Passed before SigLIP2                                                |
| `screens.spec.ts:207` — issue #88 screenshots › RecentSales and SaleDetail                                                                                                    | Product 503; 3676              | PR regression | E    | Passed before SigLIP2                                                |
| `screens.spec.ts:231` — issue #88 screenshots › ExportSheet                                                                                                                   | Product 503; 3724              | PR regression | E    | Passed before SigLIP2                                                |
| `screens.spec.ts:243` — issue #88 screenshots › ProductUnits                                                                                                                  | Product 503; 3772              | PR regression | E    | Passed before SigLIP2                                                |
| `screens.spec.ts:369` — issue #78 screenshots › PayToggleWords: three worded segments                                                                                         | Product 503; 3820              | PR regression | E    | Passed before SigLIP2                                                |
| `screens.spec.ts:383` — issue #78 screenshots › PayCredit: credit with a customer                                                                                             | Product 503; 3868              | PR regression | E    | Passed before SigLIP2                                                |
| `screens.spec.ts:402` — issue #78 screenshots › CustomerPickerCreate: add sheet from the debt book                                                                            | Product 503; 3916              | PR regression | E    | Passed before SigLIP2                                                |
| `screens.spec.ts:423` — issue #78 screenshots › DebtBookAdd: debt book header with the add circle                                                                             | Product 503; 3964              | PR regression | E    | Passed before SigLIP2                                                |
| `screens.spec.ts:439` — issue #78 screenshots › DuplicateGuard: same name asks before creating                                                                                | Product 503; 4012              | PR regression | E    | Passed before SigLIP2                                                |
| `screens.spec.ts:458` — issue #86 screenshots › GridSell: tiles with + and the cart pill                                                                                      | Product 503; 4060              | PR regression | E    | Passed before SigLIP2                                                |
| `screens.spec.ts:477` — issue #86 screenshots › ElderGrid: elder mode on, bigger tiles                                                                                        | Product 503; 4108              | PR regression | E    | Passed before SigLIP2                                                |
| `screens.spec.ts:512` — issue #87 screenshots › OfflineHint: camera says to sell from the grid                                                                                | Product 503; 4156              | PR regression | E    | Passed before SigLIP2                                                |
| `screens.spec.ts:525` — issue #87 screenshots › OfflineGridSale, OfflineSynced: offline sale, outbox, replay                                                                  | Product 503; 4204              | PR regression | E    | Passed before SigLIP2                                                |
| `voice.spec.ts:91` — fixture clip: listening, draft with two lines, cash confirm records a voice sale                                                                         | Product 503; 4252              | PR regression | E    | Passed before SigLIP2                                                |
| `voice.spec.ts:160` — fixture clip: a credit draft shows the customer card and the pill footer                                                                                | Product 503; 4300              | PR regression | E    | Passed before SigLIP2                                                |
| `void.spec.ts:10` — void a sale › void a sale and see the report change                                                                                                       | Product 503; 4348              | PR regression | E    | Passed before SigLIP2                                                |

## Every failing head Android flow

| Test                       | Cause and artifact evidence                                                                      | Class                                          | Fix                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------ |
| maestro (a): multi-session | PIN below Account viewport; screenshot step 043; already fails before SigLIP2, passes green main | PR regression from the new settings row        | Scroll to PIN; preserve wrong/right PIN and multi-session checks               |
| maestro (a): onboarding    | PIN below Account viewport; screenshot step 047; same baseline distinction                       | PR regression from the new settings row        | Scroll to PIN; preserve sign-out/re-entry checks                               |
| maestro (a): receipts      | `Receipt setup POST /v1/products failed: HTTP 503` in flow log                                   | PR regression from missing selected-model path | E                                                                              |
| maestro (a): grid-sale     | Frozen photo shows `Chưa nhận diện được`; backend scan 503, shard a line 133                     | PR regression from missing selected-model path | E                                                                              |
| maestro (b): inventory     | Unknown pill absent because scan is HTTP 503, shard b line 62                                    | PR regression from missing selected-model path | E                                                                              |
| maestro (b): debts         | Same scan 503, shard b line 97                                                                   | PR regression from missing selected-model path | E                                                                              |
| maestro (b): checkout      | Same scan 503, shard b line 105                                                                  | PR regression from missing selected-model path | E                                                                              |
| maestro (b): barcode       | Fails in its initial visual-enrollment setup, before barcode mode; scan 503, shard b line 113    | PR regression from missing selected-model path | E; retain explicit Code transition already in this native flow                 |
| maestro (b): voice-bubble  | Screenshot step 044 shows the voice section only partly scrolled into view                       | PR regression from added settings-row height   | Scroll the tile itself into view; preserve overlay-explainer/permission checks |

No observed head E2E failure is classified as a pre-existing main failure or a flake.
The native scheduler bug is a separate confirmed PR regression present throughout
these flow logcats, including passing flows. Head flow assertion failures above have
more specific direct causes.

## Local validation

Node 24.21.0 was used for mobile checks. All final checks below pass:

- Mobile TypeScript, Expo lint, and full Jest: **246 suites / 2,435 tests**.
  Lint retains the existing `VoiceSaleScreen.tsx:282` effect-cleanup warning.
  The full Jest rerun reports an existing worker-teardown/timer warning after passing.
- Native preview/screen regression checks: **12 tests**. The red test commit precedes
  implementation: `b545a47` (6 native failures and the two missing-model-path subcases).
- Mobile script tests: **13**. Maestro flow lint and the three changed flow YAML files parse.
  `ci.yml` parses; changed-file Prettier and `git diff --check` pass.
- Android Expo export succeeds with the changed worker scheduler.
- Backend `cargo fmt --all --check`, `cargo clippy --all-targets -- -D warnings`.
- Affected backend tests: API configuration **19**, API recognition **16**, recognition
  crate **46**. All use an isolated `CARGO_TARGET_DIR` inside this worktree.
- Real SigLIP2 model test: **1**, verifying successful ONNX loading, deterministic
  768-dimensional finite normalized vectors and distinct products. The cached FP32
  artifact SHA-256 matches `fetch-models.sh`:
  `1a9a53cfdf5409f64cd02b9b8b4cea9aad2366576d63acf30cff412cbfcea6db`.
  This is real model inference evidence, not authenticated full-stack E2E.
- Existing CI Python script tests: **76**; new stack launcher test: **1**, covering
  both default and custom model directories.

The first full Jest run had one unrelated timing failure in
`ProductScreen.test.tsx:127`: the threshold placeholder was read before its store
query populated it. That source and test are identical to the green main revision.
All **34** ProductScreen tests pass in isolation; the unchanged full suite passes on
rerun. This is classified as a **pre-existing flaky unit test**, not a PR regression;
no ProductScreen code or assertion was changed.

Local Playwright global setup was executed and stops with
`CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY are not set`. The functional specs enumerate
successfully, but authenticated browser E2E against compose cannot run without those
keys. No secrets are recovered from downloaded artifacts. Android emulator/device E2E
was not run locally. A hosted web/Android rerun after parent integration is still
required to establish end-to-end success. Native runtime tests simulate the documented
runtime restrictions; an Expo export proves bundling, not camera operation on a device.

The branch remains local for parent integration. No push, PR update, merge, deployment,
or worktree removal is performed. The PR is still open; its worktrees must remain.
Only this task's isolated Cargo target is deleted after the checks. Never run `cargo clean`.
