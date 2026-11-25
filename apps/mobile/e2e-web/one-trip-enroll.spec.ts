import {
  button,
  callApi,
  enrollTag,
  expect,
  expectLiveVideo,
  formatVnd,
  hydrate,
  recordApi,
  shoot,
  shutter,
  test,
  withScanSlot,
} from './fixtures';

/**
 * One-trip enrollment (roadmap R4, `EXPO_PUBLIC_ONE_TRIP_ENROLL`, default off). E2e builds honour
 * the camera route param `one_trip=1`, and the voice fixture stands in for the microphone: the
 * scripted voice model transcribes it as "mì hảo hảo năm nghìn".
 */
test.describe('one-trip enroll (real SAM and DINO models)', () => {
  test('one shutter press takes three angles, voice fills name and price, save enrolls', async ({
    page,
    store,
  }) => {
    test.setTimeout(150_000);
    const timings: unknown[] = [];
    page.on('console', (message) => {
      if (
        message.type() === 'info' &&
        /^(enroll\.one_trip_completed|scan\.tap_to_result)/.test(message.text())
      )
        timings.push(message.text());
    });
    await page.goto('/?one_trip=1&fixture=product-name-price.m4a');
    await hydrate(page, shutter(page));
    await expect(shutter(page)).toBeEnabled();
    await expectLiveVideo(page);
    await enrollTag(page).click();
    await expect(enrollTag(page)).toHaveAttribute('aria-selected', 'true');

    // The single inference slot is shared with the other workers' scans: hold it for the cut-outs.
    const { uploads, segments } = await withScanSlot(async () => {
      const uploads = recordApi(page, 'POST', '/v1/images');
      const segments = recordApi(page, 'POST', '/v1/segment/points');
      await shutter(page).click();
      await expect(page.getByTestId('quick-enroll-sheet')).toBeVisible();
      await expect(
        page.getByRole('heading', { name: 'Thêm hàng nhanh · 3/3' }),
      ).toBeVisible({ timeout: 60_000 });
      return { uploads: await uploads.stop(), segments: await segments.stop() };
    });
    expect(uploads).toHaveLength(3);
    for (const upload of uploads)
      expect(upload.requestBody.multipart.purpose).toBe('enrollment');
    expect(segments).toHaveLength(3);
    for (const segment of segments) {
      expect(segment.status).toBe(200);
      expect(segment.requestBody.points).toEqual([
        { x: expect.any(Number), y: expect.any(Number), label: 1 },
      ]);
    }
    // The seller never taps a point.
    await expect(page.getByTestId('point-overlay-canvas')).toHaveCount(0);

    const utterance = await callApi(page, 'POST', '/v1/voice/utterances', () =>
      button(page, 'Nói tên và giá').click(),
    );
    expect(utterance.requestBody.multipart.mode).toBe('transcribe');
    const name = page.getByRole('textbox', { name: 'Tên (không bắt buộc)' });
    await expect(name).toHaveValue('Mì hảo hảo');
    await expect(page.getByLabel('Giá bán')).toHaveText(formatVnd(5000));

    const created = await withScanSlot(() =>
      callApi(page, 'POST', '/v1/products', () =>
        button(page, 'Lưu sản phẩm').click(),
      ),
    );
    expect(created.status).toBe(201);
    expect(created.requestBody).toMatchObject({
      name: 'Mì hảo hảo',
      price: 5000,
      force_new: false,
    });
    expect(created.requestBody.references).toHaveLength(3);
    expect(created.requestBody.references).toEqual(
      segments.map((segment) =>
        expect.objectContaining({
          cutout_image_id: segment.body.cutout_image_id,
        }),
      ),
    );
    await expect(page.getByRole('alert')).toHaveText('Đã thêm Mì hảo hảo');
    await expect(enrollTag(page)).toHaveAttribute('aria-selected', 'false');
    await expect
      .poll(() =>
        timings.some((t) => String(t).startsWith('enroll.one_trip_completed')),
      )
      .toBe(true);

    // Gate C3 instrumentation: a checkout scan logs shutter-to-result latency.
    await store.api.waitForIndex(created.body.id);
    await shoot(page);
    await expect
      .poll(() =>
        timings.some((t) => String(t).startsWith('scan.tap_to_result')),
      )
      .toBe(true);
  });
});
