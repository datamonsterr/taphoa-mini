/**
 * Performance budgets for e2e-web/perf.spec.ts, the only place the numbers live.
 * Each one sits above the median measured locally (Chromium, software rendering, fake webcam,
 * the REAL backend with the SAM + DINO models on the same machine) with headroom for a slower CI
 * runner, yet low enough that a real regression trips it. Every API call is a real HTTP request
 * to a local backend, so the budgets include its latency. The measured medians are in README.md
 * "Performance budgets".
 */

/** A tap that only updates local state and re-renders: the "feels instant" threshold. */
const INSTANT_MS = 300;
/** A stack or sheet transition (slide_from_bottom, 280 ms) must finish before the content shows. */
const NAVIGATION_MS = 500;
/** Search is the 250 ms debounce plus one local API round trip (about 280 ms measured). */
const WITH_NETWORK_MS = 700;
/** A screen that mounts and then waits on one or two API calls (reports, account, bank). */
const SCREEN_DATA_MS = 1000;
/**
 * A scan runs the real models on the backend: upload, SAM segmentation (about 1.3 s on a 12-core
 * desktop CPU), DINO embedding, vector search. Measured about 1.5 s locally; a CI runner's CPU
 * needs about 2 s, so the budget leaves room for a slower runner without hiding a model that got
 * twice as slow.
 */
const RECOGNITION_MS = 3500;

/** Latency from the input event to the first frame that shows the result. */
export const interactionBudgetMs: Record<string, number> = {
  'scan-single': RECOGNITION_MS,
  'scan-multi': RECOGNITION_MS,
  'add-to-cart': INSTANT_MS,
  'cart-open': NAVIGATION_MS,
  'qr-open': SCREEN_DATA_MS,
  'tab-kho-to-bao-cao': SCREEN_DATA_MS,
  'tab-bao-cao-to-tai-khoan': SCREEN_DATA_MS,
  /** The inventory grid is already loaded, so no API call: a pure tab switch. */
  'tab-tai-khoan-to-kho': INSTANT_MS,
  'search-filter': WITH_NETWORK_MS,
  'search-clear': WITH_NETWORK_MS,
};

/** Animations measured through requestAnimationFrame deltas. */
export const animationBudget = {
  /** Smooth enough for a 60 Hz screen to look fluid. */
  minAvgFps: 50,
  /** A frame over 34 ms (two missed 60 Hz frames) is a visible stutter; allow a few. */
  maxPctFramesOver34: 5,
};

/** No main-thread task over this blocks input long enough to feel like a freeze. */
export const longTaskBudgetMs = 200;

/**
 * Same flow with the CPU throttled 4x, a rough mid-range-phone approximation. Looser on purpose:
 * it guards against order-of-magnitude regressions, not against small drift.
 */
export const throttled = {
  cpuRate: 4,
  /** Multiplier on the unthrottled latency budgets. */
  interactionFactor: 2,
  minAvgFps: 30,
  maxPctFramesOver34: 20,
  longTaskMs: 500,
};
