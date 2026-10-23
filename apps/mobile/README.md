# Tạp Hóa Mini mobile

Minimal TypeScript + Expo Router app (Expo SDK 58). The home screen is Vietnamese,
with body text at least 18sp and a disabled 56dp sales placeholder. No prices are
shown yet; future price/total text must be at least 32sp (PRD §6).

Use Node 24 (`nvm use` from the repository root) and pnpm 11.5.0. All commands below
run from the repository root unless noted.

```sh
pnpm install
cp apps/mobile/.env.example apps/mobile/.env
pnpm --filter @taphoa/mobile start
pnpm --filter @taphoa/mobile android
pnpm --filter @taphoa/mobile ios
pnpm --filter @taphoa/mobile web
```

Set `EXPO_PUBLIC_API_URL` in `apps/mobile/.env` to the backend address reachable
from your device: `http://10.0.2.2:8080` for the Android emulator or your computer's
LAN IP for a physical phone. `localhost` refers to the phone itself. Expo embeds
`EXPO_PUBLIC_*` values in the bundle, so these must never contain secrets. Restart
or reload the app after changing them. `src/lib/api.ts` exports the typed
`getHealth()` helper for `GET /healthz`; it rejects HTTP errors and invalid payloads.

```sh
pnpm --filter @taphoa/mobile lint
pnpm --filter @taphoa/mobile typecheck
pnpm --filter @taphoa/mobile test
pnpm --filter @taphoa/mobile build # Android JS/assets export to apps/mobile/dist
pnpm format
pnpm format:check
```

Root `lint`, `typecheck`, `test`, `test:integration`, `test:e2e`, and `build` scripts
run workspace tasks through Turborepo. Missing package scripts are skipped; mobile
has no separate integration suite. Jest uses `jest-expo` and React Native Testing
Library, with fetch mocked for API tests.

## Android smoke test and EAS

With a built APK installed on a running emulator/device and the Maestro CLI on
PATH:

```sh
pnpm --filter @taphoa/mobile test:e2e
```

The smoke flow launches `com.datamonsterr.taphoamini` and checks the title.
`eas.json` defines development (dev client/internal), preview (internal APK),
production, and unsigned Android E2E profiles. `.eas/workflows/build-preview.yml`
builds a preview on push to `main`; `e2e.yml` builds an E2E APK and runs the smoke
flow on pull requests. These require an authorized EAS account and GitHub linkage
when enabled remotely. No remote build is needed for local lint/tests/export.
The Android export is a Metro JS/assets build, not an installable APK.

## Docker development server

Build using the repository root as context:

```sh
docker build -f apps/mobile/Dockerfile.dev -t taphoa-mobile-dev .
docker run --rm -it -p 8081:8081 \
  -e REACT_NATIVE_PACKAGER_HOSTNAME=192.168.1.10 \
  -e EXPO_PUBLIC_API_URL=http://192.168.1.10:8080 \
  taphoa-mobile-dev
```

Replace `192.168.1.10` with your host's LAN IP. The container runs Expo in LAN mode
on port 8081; the phone and host must share a network, with that port reachable.
The image includes workspace dependencies and the source at build time; rebuild
after editing, or mount source directories for live development. No tunnel or
Expo login is needed for LAN mode.

## Expo MCP

`expo-mcp` is installed for local capabilities. In an environment already
authenticated with Expo, start with:

```sh
EXPO_UNSTABLE_MCP_SERVER=1 pnpm --filter @taphoa/mobile start
```

See the current official docs for [Expo monorepos](https://docs.expo.dev/guides/monorepos/),
[Jest](https://docs.expo.dev/develop/unit-testing/),
[EAS Workflows](https://docs.expo.dev/eas/workflows/), and
[Expo MCP](https://docs.expo.dev/mcp/).
