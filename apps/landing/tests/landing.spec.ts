import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const waitlist = (page: Page, index = 0) => page.locator('.wl').nth(index);
async function openWaitlist(page: Page, index = 0) {
  const widget = waitlist(page, index);
  await widget.getByRole('button', { name: 'Tham gia danh sách chờ' }).click();
  await expect(
    widget.getByRole('textbox', { name: 'Email của bạn' }),
  ).toBeFocused();
  return widget;
}
async function endpoint(page: Page) {
  const api = await page
    .locator('meta[name="taphoa-api-url"]')
    .getAttribute('content');
  expect(api).toBe('https://backend-production-5f5c.up.railway.app');
  return `${api}/v1/waitlist`;
}

test.beforeEach(async ({ page }) => {
  // Never send a test signup to the production backend.
  await page.route('**/v1/waitlist', (route) => route.abort());
  await page.clock.install({ time: new Date('2026-11-03T00:00:00Z') });
  await page.goto('/');
});

test('waitlist morph opens to the designed width and focuses the labeled email', async ({
  page,
}, info) => {
  const widget = waitlist(page);
  const closed = await widget.evaluate(
    (el) => el.getBoundingClientRect().width,
  );
  await openWaitlist(page);
  await expect(widget).toHaveClass(/is-open/);
  if (info.project.name === 'desktop') {
    expect(closed).toBe(292);
    await expect
      .poll(() => widget.evaluate((el) => el.getBoundingClientRect().width))
      .toBe(480);
  } else {
    await expect
      .poll(() => widget.evaluate((el) => el.getBoundingClientRect().width))
      .toBe(closed);
  }
});

test('Escape closes an empty input and returns focus; text keeps it open', async ({
  page,
}) => {
  const widget = await openWaitlist(page);
  const input = widget.getByRole('textbox');
  await input.fill('tiem');
  await input.press('Escape');
  await expect(widget).toHaveClass(/is-open/);
  await input.fill('');
  await input.press('Escape');
  await expect(widget).not.toHaveClass(/is-open/);
  await expect(
    widget.getByRole('button', { name: 'Tham gia danh sách chờ' }),
  ).toBeFocused();
});

test('invalid email has an inline Vietnamese error and sends no request', async ({
  page,
}) => {
  let requests = 0;
  await page.route('**/v1/waitlist', async (route) => {
    requests++;
    await route.fulfill({ json: { status: 'ok' } });
  });
  const widget = await openWaitlist(page);
  await widget.getByRole('textbox').fill('sai-email');
  await widget.getByRole('button', { name: 'Gửi email' }).click();
  await expect(page.locator('.wl-err').first()).toHaveText(
    'Email chưa đúng, bạn xem lại giúp nhé.',
  );
  await expect(widget.getByRole('textbox')).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  expect(requests).toBe(0);
});

for (const index of [0, 1]) {
  test(`CTA ${index + 1} posts exact JSON to the meta API URL and shows success`, async ({
    page,
  }) => {
    const url = await endpoint(page);
    let body: unknown;
    await page.route(url, async (route) => {
      expect(route.request().method()).toBe('POST');
      expect(route.request().headers()['content-type']).toBe(
        'application/json',
      );
      body = route.request().postDataJSON();
      await route.fulfill({ json: { status: 'ok' } });
    });
    const widget = await openWaitlist(page, index);
    await widget.getByRole('textbox').fill('chu.tiem@example.com');
    await widget.getByRole('button', { name: 'Gửi email' }).click();
    await expect(widget.getByRole('status')).toHaveText(
      'Đã ghi danh. Hẹn bạn ngày mở cửa.',
    );
    await expect(widget).toHaveClass(/is-done/);
    expect(body).toEqual({ email: 'chu.tiem@example.com' });
  });
}

for (const status of [422, 429, 500]) {
  test(`${status} shows an error and allows editing and retry`, async ({
    page,
  }) => {
    await page.route(await endpoint(page), (route) =>
      route.fulfill({
        status,
        json: {
          code: status === 422 ? 'invalid_email' : 'error',
          error: 'Server error',
        },
      }),
    );
    const widget = await openWaitlist(page);
    await widget.getByRole('textbox').fill('chu.tiem@example.com');
    await widget.getByRole('button', { name: 'Gửi email' }).click();
    await expect(page.locator('.wl-err').first()).not.toBeEmpty();
    await expect(widget).not.toHaveClass(/is-done/);
    await expect(widget.getByRole('textbox')).toBeEditable();
    await expect(
      widget.getByRole('button', { name: 'Gửi email' }),
    ).toBeEnabled();
    await widget.getByRole('textbox').fill('thu.lai@example.com');
    await page.route(await endpoint(page), (route) =>
      route.fulfill({ json: { status: 'ok' } }),
    );
    await widget.getByRole('button', { name: 'Gửi email' }).click();
    await expect(widget.getByRole('status')).toContainText('Đã ghi danh.');
  });
}

test('network failure keeps the input editable with a Vietnamese error', async ({
  page,
}) => {
  const widget = await openWaitlist(page);
  await widget.getByRole('textbox').fill('chu.tiem@example.com');
  await widget.getByRole('button', { name: 'Gửi email' }).click();
  await expect(page.locator('.wl-err').first()).toContainText('Bạn thử lại');
  await expect(widget.getByRole('textbox')).toBeEditable();
  await expect(widget.getByRole('button', { name: 'Gửi email' })).toBeEnabled();
});

test('double click sends one request and disables submit while pending', async ({
  page,
}) => {
  let requests = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(await endpoint(page), async (route) => {
    requests++;
    await pending;
    await route.fulfill({ json: { status: 'ok' } });
  });
  const widget = await openWaitlist(page);
  await widget.getByRole('textbox').fill('chu.tiem@example.com');
  await widget.getByRole('button', { name: 'Gửi email' }).dblclick();
  await expect.poll(() => requests).toBe(1);
  await expect(
    widget.getByRole('button', { name: 'Gửi email' }),
  ).toBeDisabled();
  release();
  await expect(widget.getByRole('status')).toContainText('Đã ghi danh.');
  expect(requests).toBe(1);
});

test('hero columns and phone stacking match the boards without horizontal overflow', async ({
  page,
}, info) => {
  const columns = await page
    .locator('.hero')
    .evaluate(
      (el) => getComputedStyle(el).gridTemplateColumns.split(' ').length,
    );
  expect(columns).toBe(info.project.name === 'desktop' ? 2 : 1);
  expect(
    await page.evaluate(() => document.scrollingElement!.scrollWidth),
  ).toBeLessThanOrEqual(info.project.name === 'desktop' ? 1440 : 390);
  if (info.project.name === 'phone') {
    const copy = await page.locator('.hero-copy').boundingBox();
    const stage = await page.locator('.stage').boundingBox();
    expect(stage!.y).toBeGreaterThanOrEqual(copy!.y + copy!.height);
  }
});

test('1040px and 720px breakpoints preserve the board layout changes', async ({
  page,
}) => {
  for (const width of [1041, 1040, 721, 720]) {
    await page.setViewportSize({ width, height: 900 });
    const layout = await page.evaluate(() => {
      const style = (selector: string) =>
        getComputedStyle(document.querySelector(selector)!);
      const columns = (selector: string) =>
        style(selector).gridTemplateColumns.split(' ').length;
      return {
        hero: columns('.hero'),
        specs: columns('.specs'),
        uses: columns('.uses'),
        feats: columns('.feats'),
        nav: style('.nav').height,
        links: style('.links').display,
        ring: style('.ringstage').height,
        cardColumn: style('.c7').gridColumnStart,
      };
    });
    expect(layout.hero).toBe(width <= 1040 ? 1 : 2);
    expect(layout.specs).toBe(width <= 1040 ? 2 : 4);
    expect(layout.uses).toBe(width <= 1040 ? 1 : 3);
    expect(layout.cardColumn).toBe(width <= 1040 ? 'span 12' : 'span 7');
    expect(layout.feats).toBe(width <= 720 ? 1 : 2);
    expect(layout.nav).toBe(width <= 720 ? '72px' : '88px');
    expect(layout.links).toBe(width <= 720 ? 'none' : 'flex');
    expect(layout.ring).toBe(width <= 720 ? '440px' : '560px');
  }
});

test("reduced motion preserves the board's tick-five demo states", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  await expect(page.locator('[data-frames]')).toHaveText('15');
  await expect(page.locator('.ringstage')).not.toHaveClass(/isSaved/);
  await expect(page.locator('.vtotal')).not.toHaveClass(/on/);
});

test('revenue chart description agrees with its bars', async ({ page }) => {
  const chart = page.locator('.bars');
  const label = (await chart.getAttribute('aria-label'))!;
  const heights = await chart
    .locator('.bar > div')
    .evaluateAll((bars) =>
      bars.map((bar) => Number.parseFloat(getComputedStyle(bar).height)),
    );
  const todayIsHighest = heights.at(-1)! >= Math.max(...heights.slice(0, -1));
  const descriptionClaimsTodayIsHighest = /hôm nay cao nhất tuần/i.test(label);
  expect(descriptionClaimsTodayIsHighest).toBe(todayIsHighest);
});

test('waitlist placeholders meet normal-text contrast', async ({ page }) => {
  for (const index of [0, 1]) {
    const widget = await openWaitlist(page, index);
    await expect
      .poll(() => widget.evaluate((el) => getComputedStyle(el).backgroundColor))
      .toBe('rgb(255, 255, 255)');
    const ratio = await widget.evaluate((el) => {
      const input = el.querySelector<HTMLInputElement>('.wl-in')!;
      const parse = (color: string) =>
        color
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map(Number);
      const luminance = ([r, g, b]: number[]) => {
        const linear = [r, g, b].map((channel) => {
          const value = channel / 255;
          return value <= 0.04045
            ? value / 12.92
            : ((value + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
      };
      const foreground = luminance(
        parse(getComputedStyle(input, '::placeholder').color),
      );
      const background = luminance(parse(getComputedStyle(el).backgroundColor));
      return (
        (Math.max(foreground, background) + 0.05) /
        (Math.min(foreground, background) + 0.05)
      );
    });
    expect(
      ratio,
      `waitlist ${index + 1} placeholder contrast`,
    ).toBeGreaterThanOrEqual(4.5);
  }
});

test('scan tracks three products, flags ambiguous Pringles, confirms 60.000đ, and loops', async ({
  page,
}) => {
  await page.clock.pauseAt(new Date('2026-11-03T01:00:00Z'));
  await page.reload();
  await page.clock.runFor(2 * 1150 + 600);
  await expect(page.locator('.scr')).toHaveClass(/s2/);
  await expect(page.locator('.bx')).toHaveCount(3);
  await expect(page.locator('.amb-pill')).toHaveCSS('opacity', '1');
  await expect(page.locator('.bx.amb')).toHaveCSS(
    'border-top-color',
    'rgb(226, 169, 75)',
  );
  await page.clock.runFor(2 * 1150);
  await expect(page.locator('.scr')).toHaveClass(/s4/);
  await expect(page.locator('.sheet')).toHaveCSS('transform', 'none');
  await expect(page.locator('.sheet')).toContainText('60.000đ');
  await page.clock.runFor(3 * 1150);
  await expect(page.locator('.scr')).not.toHaveClass(/s4/);
});

test('enrollment fills eight sectors, cycles prompts, and reaches the voice step', async ({
  page,
}) => {
  await page.clock.pauseAt(new Date('2026-11-03T01:00:00Z'));
  await page.reload();
  await page.clock.runFor(3 * 1150);
  await expect(page.locator('.prompt')).toContainText('Đưa ra xa');
  await expect(page.locator('.ring .seg.on')).toHaveCount(3);
  await page.clock.runFor(5 * 1150);
  await expect(page.locator('.ring .seg.on')).toHaveCount(8);
  await expect(page.locator('.prompt')).toContainText('Đủ góc rồi');
  await page.clock.runFor(1150 + 600);
  await expect(page.locator('.ringstage')).toHaveClass(/asking/);
  await expect(page.locator('.ask')).toHaveCSS('opacity', '1');
  await expect(page.locator('.askcard h4')).toHaveText('Tên và giá?');
});

test('voice transcription, cart, revenue, bars, and top items update', async ({
  page,
}) => {
  await page.clock.pauseAt(new Date('2026-11-03T01:00:00Z'));
  await page.reload();
  const initial = await page.locator('.big').innerText();
  const today = await page.locator('.bar.today div').getAttribute('style');
  const top = await page.locator('.ti b').first().innerText();
  await page.clock.runFor(8 * 1150 + 600);
  await expect(page.locator('.w.on')).toHaveCount(7);
  await expect(page.locator('.vl.on')).toHaveCount(3);
  await expect(page.locator('.vtotal')).toHaveClass(/on/);
  await expect(page.locator('.big')).not.toHaveText(initial);
  await expect(page.locator('.bar.today div')).not.toHaveAttribute(
    'style',
    today!,
  );
  await expect(page.locator('.ti b').first()).not.toHaveText(top);
  await expect(page.locator('.digest')).toContainText('Bản tin sáng');
  await expect(page.locator('.bento')).toContainText('Chốt sổ cuối ngày');
});

test('reduced motion keeps tick-five demos static and removes all animation and transitions', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.pauseAt(new Date('2026-11-03T01:00:00Z'));
  await page.reload();
  await expect(page.locator('.scr')).toHaveClass(/s5/);
  await expect(page.locator('[data-frames]')).toHaveText('15');
  await expect(page.locator('.ring .seg.on')).toHaveCount(5);
  await expect(page.locator('.ringstage')).not.toHaveClass(/isSaved/);
  await expect(page.locator('.ask')).toHaveCSS('opacity', '0');
  await expect(page.locator('.vtotal')).not.toHaveClass(/on/);
  const before = await page.locator('.lp').innerHTML();
  await page.clock.runFor(30_000);
  expect(await page.locator('.lp').innerHTML()).toBe(before);
  const animated = await page.locator('.lp').evaluate(
    (root) =>
      [...root.querySelectorAll('*')].filter((el) =>
        ['', '::before', '::after'].some((pseudo) => {
          const style = getComputedStyle(el, pseudo || null);
          return (
            style.animationName !== 'none' ||
            style.transitionDuration
              .split(',')
              .some((duration) => parseFloat(duration) > 0)
          );
        }),
      ).length,
  );
  expect(animated).toBe(0);
  const widget = await openWaitlist(page);
  await expect(widget).toHaveCSS('transition-duration', '0s');
});

test('saves a full-page visual artifact', async ({ page }, info) => {
  await page.clock.pauseAt(new Date('2026-11-03T01:00:00Z'));
  await page.reload();
  await page.clock.runFor(5 * 1150 + 700);
  await page.evaluate(() => document.fonts.ready);
  await mkdir('screenshots', { recursive: true });
  await page.screenshot({
    path: `screenshots/landing-${info.project.name}.png`,
    fullPage: true,
    animations: 'disabled',
  });
});
