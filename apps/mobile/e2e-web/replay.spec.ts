import { expect, test } from '@playwright/test';
import { gunzipSync } from 'node:zlib';

// Opt in so ordinary functional runs don't require PostHog or create proof recordings.
test('web replay sends masked sign-in interactions without assistant traffic', async ({
  page,
}, testInfo) => {
  test.skip(
    process.env.POSTHOG_REPLAY_SMOKE !== '1',
    'Set POSTHOG_REPLAY_SMOKE=1 and embed the PostHog key + environment=test at export.',
  );
  const snapshots: { properties: Record<string, unknown> }[] = [];
  const events: { event: string; properties: Record<string, unknown> }[] = [];
  const uploads: Promise<void>[] = [];
  let assistantRequests = 0;
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.includes('/v1/assistant')) assistantRequests++;
    if (
      !url.hostname.endsWith('.posthog.com') ||
      !['/s/', '/e/'].includes(url.pathname)
    )
      return;
    uploads.push(
      (async () => {
        const body = request.postDataBuffer();
        if (!body) return;
        const json =
          body[0] === 0x1f && body[1] === 0x8b
            ? gunzipSync(body).toString()
            : body.toString();
        const parsed = JSON.parse(json);
        const batch = Array.isArray(parsed)
          ? parsed
          : (parsed.batch ?? [parsed]);
        if (url.pathname === '/s/') snapshots.push(...batch);
        else events.push(...batch);
        const response = await request.response();
        expect(response?.ok()).toBe(true);
      })(),
    );
  });
  await page.goto('/sign-in');
  const email = page.getByRole('textbox', {
    name: 'Địa chỉ email',
    exact: true,
  });
  await expect(email).toBeVisible();
  // Wait for the recorder's full snapshot before exercising the real input.
  await page.waitForTimeout(3000);
  const probe = 'replay-mask-probe@example.invalid';
  await page.evaluate(() => {
    const maskedCamera = document.createElement('div');
    maskedCamera.dataset.phNoCapture = 'true';
    maskedCamera.textContent = 'replay-camera-private-canary';
    maskedCamera.style.cssText = 'width:80px;height:60px';
    const image = document.createElement('img');
    image.alt = 'replay-image-private-canary';
    image.src =
      'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>';
    document.body.append(maskedCamera, image);
  });
  await email.fill(probe);
  await email.blur();
  // No submission, sign-in, or model call. Keep the session above PostHog's 10s guidance.
  for (let i = 0; i < 3; i++) {
    await page.waitForTimeout(4000);
    await email.click();
    await email.blur();
  }
  await page.waitForTimeout(3000);

  await expect
    .poll(() => snapshots.length, { timeout: 20000 })
    .toBeGreaterThan(0);
  await Promise.all(uploads);
  // The SDK gzip-compresses full snapshots and nested mutation fields. Decode
  // recursively and inspect only recorder data, never the ingestion envelope/token.
  const decode = (value: unknown): unknown => {
    if (
      typeof value === 'string' &&
      value.charCodeAt(0) === 0x1f &&
      value.charCodeAt(1) === 0x8b
    )
      return decode(
        JSON.parse(gunzipSync(Buffer.from(value, 'latin1')).toString()),
      );
    if (Array.isArray(value)) return value.map(decode);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, decode(child)]),
      );
    return value;
  };
  const recordingEvents = decode(
    snapshots.map(({ properties }) => properties.$snapshot_data),
  );
  const payload = JSON.stringify(recordingEvents);
  expect(payload.includes(probe)).toBe(false);
  expect(payload.includes('replay-camera-private-canary')).toBe(false);
  expect(payload.includes('replay-image-private-canary')).toBe(false);
  const blocked: { tagName?: string; width: unknown; height: unknown }[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const object = value as Record<string, unknown>;
    const attrs = object.attributes as Record<string, unknown> | undefined;
    if (
      attrs &&
      typeof attrs === 'object' &&
      ('rr_width' in attrs || 'rr_height' in attrs)
    )
      blocked.push({
        tagName: object.tagName as string,
        width: attrs.rr_width,
        height: attrs.rr_height,
      });
    Object.values(object).forEach(visit);
  };
  visit(recordingEvents);
  expect(
    blocked.some(
      (node) =>
        node.tagName === 'div' &&
        node.width === '80px' &&
        node.height === '60px',
    ),
  ).toBe(true);
  expect(
    blocked.some(
      (node) =>
        node.tagName === 'img' &&
        node.width === '10px' &&
        node.height === '10px',
    ),
  ).toBe(true);

  expect(payload.includes('*'.repeat(probe.length))).toBe(true);
  expect(assistantRequests).toBe(0);
  const sessionId = snapshots[0].properties.$session_id;
  expect(sessionId).toEqual(expect.any(String));
  expect(
    events.some(
      (event) =>
        event.properties.$session_id === sessionId &&
        event.properties.environment === 'test',
    ),
  ).toBe(true);
  const evidence = {
    sessionId,
    environment: 'test',
    snapshotUploads: snapshots.length,
    inputMasked: true,
    mediaBlocked: true,
    mediaBlocks: blocked.length,
    assistantRequests,
  };
  console.log(JSON.stringify(evidence));
  await testInfo.attach('masked-replay-evidence', {
    body: JSON.stringify(evidence),
    contentType: 'application/json',
  });
});
