import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Page } from '@playwright/test';

import {
  addButton,
  button,
  cartPill,
  expect,
  goShop,
  openCamera,
  openShop,
  seedScannableProduct,
  shutter,
  test,
  type Api,
} from './fixtures';
import {
  animationBudget,
  interactionBudgetMs,
  longTaskBudgetMs,
  throttled,
} from './perf-budgets';

type Arm = { start: 'click' | 'keydown'; windowMs: number };
type Raw = {
  latencyMs: number;
  frameStamps: number[];
  longTasks: number[];
};
type Frames = {
  frames: number;
  avgFps: number;
  maxGapMs: number;
  pctOver34: number;
};
type Run = {
  interactions: Record<string, number[]>;
  animations: Record<string, Frames>;
  longTasks: Record<string, { count: number; maxMs: number }>;
};

declare global {
  interface Window {
    __perf: {
      arm: (predicate: string, options: Arm) => void;
      done: () => Promise<Raw>;
      visible: (selector: string, text?: string) => boolean;
    };
  }
}

/** In-page probe: input event -> first frame showing the result, rAF deltas and long tasks. */
function installProbe() {
  let pending: Promise<Raw> | null = null;
  window.__perf = {
    visible: (selector, text) =>
      [...document.querySelectorAll(selector)].some(
        (el) =>
          el.getClientRects().length > 0 &&
          (text === undefined || el.textContent === text),
      ),
    arm(predicateSource, { start: startEvent, windowMs }) {
      const predicate = new Function(
        `return (${predicateSource})`,
      ) as () => boolean;
      pending = new Promise<Raw>((resolve, reject) => {
        const stamps: number[] = [];
        const tasks: PerformanceEntry[] = [];
        let start: number | null = null;
        let end: number | null = null;
        let endQueued = false;
        const observer = new PerformanceObserver((list) =>
          tasks.push(...list.getEntries()),
        );
        observer.observe({ type: 'longtask' });
        const mutations = new MutationObserver(() => {
          if (start === null || end !== null || endQueued || !predicate())
            return;
          endQueued = true;
          requestAnimationFrame((ts) => (end = ts));
        });
        mutations.observe(document, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
        const guard = setTimeout(() => finish(new Error('timeout')), 10_000);
        let running = true;
        const finish = (error?: Error) => {
          running = false;
          clearTimeout(guard);
          tasks.push(...observer.takeRecords());
          observer.disconnect();
          mutations.disconnect();
          if (error || start === null || end === null) {
            reject(error ?? new Error('no result'));
            return;
          }
          // Anchor on the last frame before the input so a stall right after it shows as a gap.
          const anchor = stamps.filter((s) => s <= start!).at(-1) ?? start;
          resolve({
            latencyMs: end - start,
            frameStamps: [anchor, ...stamps.filter((s) => s > start!)],
            longTasks: tasks
              .filter((t) => t.startTime + t.duration > start!)
              .map((t) => t.duration),
          });
        };
        window.addEventListener(
          startEvent,
          (event) => (start = event.timeStamp),
          { capture: true, once: true },
        );
        const frame = (ts: number) => {
          if (!running) return;
          stamps.push(ts);
          if (start !== null && end === null && !endQueued && predicate()) {
            endQueued = true;
            requestAnimationFrame((next) => (end = next));
          }
          if (start !== null && end !== null && ts - start >= windowMs)
            finish();
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      });
    },
    done: () => pending!,
  };
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

function frameStats(stamps: number[]): Frames {
  const gaps = stamps.slice(1).map((ts, i) => ts - stamps[i]!);
  const span = stamps.at(-1)! - stamps[0]!;
  return {
    frames: gaps.length,
    avgFps: Math.round((gaps.length / span) * 1000 * 10) / 10,
    maxGapMs: Math.round(Math.max(...gaps) * 10) / 10,
    pctOver34:
      Math.round((gaps.filter((g) => g > 34).length / gaps.length) * 1000) / 10,
  };
}

const box =
  '[aria-label$=", đã chọn"],[aria-label$=", bỏ chọn"],[aria-label$=", chưa có trong kho"],[aria-label$=", chưa chắc, chạm để chọn"]';
const pillLabel = (page: Page) => cartPill(page).getAttribute('aria-label');
/** Grid tiles are named "<name>, <price>"; the camera's cart pill ("Giỏ hàng: ...đ") is not one. */
const tiles = '[role="button"][aria-label$="đ"]:not([aria-label^="Giỏ hàng"])';
/** The tab is selected and its screen's own heading is laid out (inactive screens stay mounted). */
const tabShown = (tab: string, screenHeading: string) =>
  `document.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute('aria-label') === ${JSON.stringify(tab)} && __perf.visible('[role="heading"]', ${JSON.stringify(screenHeading)})`;

class Recorder {
  readonly run: Run = { interactions: {}, animations: {}, longTasks: {} };
  constructor(private readonly page: Page) {}

  /** Arms the probe, performs the input, and waits for the first frame where `until` holds. */
  async measure(
    name: string,
    act: () => Promise<void>,
    until: string,
    options: Partial<Arm> & { frames?: boolean } = {},
  ) {
    const { frames, ...arm } = options;
    await this.page.evaluate(
      ([source, config]) => window.__perf.arm(source, config),
      [until, { start: 'click', windowMs: frames ? 900 : 0, ...arm }] as [
        string,
        Arm,
      ],
    );
    await act();
    const raw = await this.page.evaluate(() => window.__perf.done());
    (this.run.interactions[name] ??= []).push(
      Math.round(raw.latencyMs * 10) / 10,
    );
    if (frames) this.run.animations[name] = frameStats(raw.frameStamps);
    const known = this.run.longTasks[name] ?? { count: 0, maxMs: 0 };
    this.run.longTasks[name] = {
      count: known.count + raw.longTasks.length,
      maxMs: Math.max(known.maxMs, ...raw.longTasks, 0),
    };
  }
}

/** What the flow needs to know about the store it runs against. */
type Shop = { name: string; products: number };

/**
 * A store like a small shop's: one product the fake camera shows (a scan matches it), five more
 * for the stock grid and its search, and a bank account for the QR.
 */
async function seedShop(api: Api, name: string): Promise<Shop> {
  await seedScannableProduct(api);
  const others = [
    ['Pepsi lon 330ml', 9_000],
    ['Pocari Sweat 500ml', 15_000],
    ['7Up lon 330ml', 9_000],
    ['Nước mắm Nam Ngư 500ml', 35_000],
    ['Mì Hảo Hảo gói', 4_500],
  ] as const;
  for (const [productName, price] of others)
    await api.createProduct({ name: productName, price });
  await api.setBank();
  return { name, products: others.length + 1 };
}

/** One pass over every measured interaction on a fresh page. */
async function runFlow(page: Page, cpuRate: number, shop: Shop): Promise<Run> {
  await openCamera(page);
  if (cpuRate > 1) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuRate });
  }
  // Let hydration, the font swap and the video start settle so they do not leak into the samples.
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)));
  const rec = new Recorder(page);

  for (const index of [1, 2]) {
    await rec.measure(
      'scan-single',
      () => shutter(page).click(),
      `!!document.querySelector('${box}')`,
    );
    const before = await pillLabel(page);
    await rec.measure(
      'add-to-cart',
      () => addButton(page).click(),
      `document.querySelector('[aria-label^="Giỏ hàng"]')?.getAttribute('aria-label') !== ${JSON.stringify(before)}`,
    );
    expect(await pillLabel(page), `add ${index}`).not.toBe(before);
  }

  await rec.measure(
    'mode-toggle',
    () => button(page, 'Nhiều món').click(),
    `!!document.querySelector('[aria-label="Nhiều món"][aria-selected="true"]')`,
    { frames: true },
  );
  await rec.measure(
    'scan-multi',
    () => shutter(page).click(),
    `!!document.querySelector('${box}')`,
  );
  await expect(addButton(page)).toBeEnabled();

  await rec.measure(
    'cart-open',
    () => cartPill(page).click(),
    `!!document.querySelector('[data-testid^="cart-line-"]')`,
    { frames: true },
  );
  await rec.measure(
    'qr-open',
    () => button(page, 'Hiện mã QR thanh toán').click(),
    `!!document.querySelector('[role="img"][aria-label^="Mã VietQR"] svg')`,
  );

  await openShop(page, '/inventory');
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
  const tabs = [
    ['tab-kho-to-bao-cao', 'Báo cáo', 'Hôm nay'],
    ['tab-bao-cao-to-tai-khoan', 'Tài khoản', shop.name],
    ['tab-tai-khoan-to-kho', 'Kho', 'Kho'],
  ] as const;
  for (let round = 0; round < 2; round++) {
    for (const [name, tab, screenHeading] of tabs) {
      await rec.measure(
        name,
        () => goShop(page, tab),
        tabShown(tab, screenHeading),
      );
    }
  }

  await button(page, 'Tìm').click();
  const field = page.getByRole('textbox', { name: 'Tìm sản phẩm' });
  await field.focus();
  const count = `document.querySelectorAll('${tiles}').length`;
  for (let round = 0; round < 2; round++) {
    await rec.measure(
      'search-filter',
      () => page.keyboard.press('P'),
      `${count} > 0 && ${count} < ${shop.products}`,
      { start: 'keydown' },
    );
    await rec.measure(
      'search-clear',
      () => page.keyboard.press('Backspace'),
      `${count} === ${shop.products}`,
      { start: 'keydown' },
    );
  }
  return rec.run;
}

/**
 * Route chunks load lazily on the web export, a cost the native app does not have. A discarded
 * first pass loads and caches them, so the measured pass times the interactions themselves.
 */
async function warmThenMeasure(
  page: Page,
  cpuRate: number,
  shop: Shop,
): Promise<Run> {
  await page.addInitScript(installProbe);
  await runFlow(page, 1, shop);
  return runFlow(page, cpuRate, shop);
}

const results: { unthrottled?: Run; throttled?: Run } = {};

const summarise = (run: Run) => ({
  interactions: Object.fromEntries(
    Object.entries(run.interactions).map(([name, samples]) => [
      name,
      { medianMs: median(samples), maxMs: Math.max(...samples), samples },
    ]),
  ),
  animations: run.animations,
  longTasks: run.longTasks,
});

test.describe.configure({ mode: 'serial' });

test.describe('performance budgets', () => {
  // eslint-disable-next-line no-empty-pattern -- Playwright needs the destructuring to pick fixtures
  test.afterAll(async ({}, testInfo) => {
    const body = JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        unthrottled: results.unthrottled && summarise(results.unthrottled),
        throttled: results.throttled && {
          cpuRate: throttled.cpuRate,
          ...summarise(results.throttled),
        },
      },
      null,
      2,
    );
    writeFileSync(join(__dirname, 'perf-results.json'), `${body}\n`);
    await testInfo.attach('perf-results', {
      body,
      contentType: 'application/json',
    });
  });

  test('unthrottled: interactions, animations and long tasks stay in budget', async ({
    page,
    store,
  }) => {
    const shop = await seedShop(store.api, store.session.store.name);
    const run = (results.unthrottled = await warmThenMeasure(page, 1, shop));
    for (const [name, samples] of Object.entries(run.interactions)) {
      const budget = interactionBudgetMs[name];
      if (budget === undefined) continue;
      for (const sample of samples)
        expect(sample, `${name} latency (ms)`).toBeLessThanOrEqual(budget);
    }
    for (const [name, frames] of Object.entries(run.animations)) {
      expect(frames.avgFps, `${name} avg fps`).toBeGreaterThanOrEqual(
        animationBudget.minAvgFps,
      );
      expect(frames.pctOver34, `${name} % frames > 34 ms`).toBeLessThanOrEqual(
        animationBudget.maxPctFramesOver34,
      );
    }
    for (const [name, tasks] of Object.entries(run.longTasks))
      expect(tasks.maxMs, `${name} longest task (ms)`).toBeLessThanOrEqual(
        longTaskBudgetMs,
      );
  });

  test('throttled 4x CPU: looser budgets hold', async ({ page, store }) => {
    const shop = await seedShop(store.api, store.session.store.name);
    const run = (results.throttled = await warmThenMeasure(
      page,
      throttled.cpuRate,
      shop,
    ));
    for (const [name, samples] of Object.entries(run.interactions)) {
      const budget = interactionBudgetMs[name];
      if (budget === undefined) continue;
      for (const sample of samples)
        expect(sample, `${name} latency (ms)`).toBeLessThanOrEqual(
          budget * throttled.interactionFactor,
        );
    }
    for (const [name, frames] of Object.entries(run.animations)) {
      expect(frames.avgFps, `${name} avg fps`).toBeGreaterThanOrEqual(
        throttled.minAvgFps,
      );
      expect(frames.pctOver34, `${name} % frames > 34 ms`).toBeLessThanOrEqual(
        throttled.maxPctFramesOver34,
      );
    }
    for (const [name, tasks] of Object.entries(run.longTasks))
      expect(tasks.maxMs, `${name} longest task (ms)`).toBeLessThanOrEqual(
        throttled.longTaskMs,
      );
  });
});
