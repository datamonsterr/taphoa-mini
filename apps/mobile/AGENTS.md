This is an Expo/React Native mobile application. Prioritize mobile-first patterns, performance, and cross-platform compatibility.

## Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. APIs you remember are likely renamed, moved, or removed. Before writing any code that touches an Expo, EAS, or React Native API:

1. Read the major version of the `expo` package in `package.json`.
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, fetch https://docs.expo.dev/llms.txt — an index of all Expo docs with corrections to common LLM misconceptions. Follow its links to the specific page you need; never answer from memory.

## Commands

Use `bunx` instead of `npx` if the project uses bun (`bun.lock` present).

```bash
npx expo install <package>  # ALWAYS use instead of npm/yarn/pnpm/bun add — resolves SDK-compatible versions
npx expo start              # start the dev server
npx expo lint               # lint
npx tsc --noEmit            # typecheck
npx expo-doctor             # diagnose dependency and config issues
npx expo install --fix      # fix incompatible package versions
```

Run lint and typecheck before declaring any task done.

## Navigation & Routing

- Use **Expo Router** for all navigation. Routes live in `src/app/` — every file there is a screen, `_layout.tsx` files define navigators. Keep non-route code (components, hooks, utils) outside `src/app/`.
- Import `Link`, `router`, and `useLocalSearchParams` from `expo-router`.
- Docs: https://docs.expo.dev/router/introduction.md

## Building with EAS

Use EAS to build, sign, and submit the app in the cloud (`eas build`, `eas submit`) and to ship over-the-air updates (`eas update`) — no local Xcode or Android Studio required. Run EAS CLI as `bunx eas-cli <command>` in Bun projects, or `npx eas-cli@latest <command>` otherwise; substitute that for bare `eas` in docs examples.
Docs: https://docs.expo.dev/eas/index.md

## Rules

- If `ios/` and `android/` directories do not exist, they are generated (Continuous Native Generation). Never create or edit them by hand — configure native behavior in `app.json` and config plugins.
- Expo Go only includes its bundled native modules. After adding a library with native code, the app needs a development build: `npx expo run:ios|android` locally, or `eas build --profile development`.
- Prefer recommended Expo modules over third-party libraries, and check your available skills before adding dependencies. Docs: https://docs.expo.dev/versions/latest/index.md

## CI/CD

The GitHub repo is linked to the Expo project, so every file in `.eas/workflows/` runs on EAS automatically. EAS minutes and builds count against the plan quota; keep triggers narrow.

- `build-preview.yml`: on push to `main` touching the app. Computes the Android fingerprint and reuses the last preview build with the same fingerprint; it builds only when native code changed.
- `deploy-web.yml`: on push to `main` touching the app. Exports and deploys web to EAS Hosting.
- No EAS e2e workflow: EAS Maestro jobs need a paid plan, and `workflow:validate` rejects them on the current plan. The Maestro suite runs on GitHub Actions (`.github/workflows/android-e2e.yml`).
- GitHub Actions (`.github/workflows/ci.yml`) owns lint, typecheck, jest, bundle budget, `expo-doctor` and web e2e. Do not duplicate these checks in EAS workflows.
- Add `[eas skip]` to a commit message to skip EAS runs for that push.
- Validate every edited workflow: `npx -y eas-cli@latest workflow:validate .eas/workflows/<file>.yml --non-interactive`.

## Finishing a task

A task is done when its PR is merged. Then clean up the worktree it ran in. Follow the repo-root `CLAUDE.md` section "Finishing a task".
