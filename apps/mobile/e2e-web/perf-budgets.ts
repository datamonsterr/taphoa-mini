/**
 * Performance budgets for e2e-web/perf.spec.ts, the only place the numbers live.
 * Each one sits above the median measured locally (Chromium, software rendering, fake webcam,
 * mock API) with headroom for a slower CI runner, yet low enough that a real regression trips it.
 * The measured medians are in README.md "Performance budgets".
 */

/** A tap that only updates local state and re-renders: the "feels instant" threshold. */
const INSTANT_MS = 300;
/** A stack or sheet transition (slide_from_bottom, 280 ms) must finish before the content shows. */
const NAVIGATION_MS = 500;
/** Scan and search include the mock API latency (120-350 ms), and search the 250 ms debounce. */
const WITH_NETWORK_MS = 700;
/** A screen that mounts and then waits on one or two mock API calls (shop, bank, members). */
const SCREEN_DATA_MS = 1000;

/** Latency from the input event to the first frame that shows the result. */
export const interactionBudgetMs: Record<string, number> = {
  'scan-single': WITH_NETWORK_MS,
  'scan-multi': WITH_NETWORK_MS,
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
