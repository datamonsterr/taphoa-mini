# 0003 — Mobile frontend stack and in-app mock API

Status: Accepted · Date: 2026-10-23

## Context

The design (docs/design) covers 13 screens. The backend implements only health, readiness, images and
segmentation. The app must be previewable in Expo Go and fully clickable before the backend exists.

## Decision

- Expo SDK 58 + Expo Router, only Expo Go–compatible libraries: expo-camera, Reanimated, Gesture
  Handler, lucide-react-native over react-native-svg, expo-image, TanStack Query, zustand.
- All data goes through `@taphoa/api-client` (openapi-fetch over `docs/api/openapi.yaml`). By default
  the mobile app injects an in-app mock `fetch` that serves schema-valid responses from an in-memory
  DB. `EXPO_PUBLIC_API_MODE=live` switches to the real API with no screen changes.
- A contract test validates every mock response against the OpenAPI schemas, so the mock cannot
  drift from the spec.

## Consequences

- Screens are real API consumers from day one; switching to the backend is a config change.
- The mock must be kept in step with the spec; the contract test enforces it in CI.
- Prism (`pnpm mock:api`) remains available for testing the live client path against the spec.
