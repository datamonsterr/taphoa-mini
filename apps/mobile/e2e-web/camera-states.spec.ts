import { mkdirSync } from 'node:fs';
import path from 'node:path';

import type { Page, Route, TestInfo } from '@playwright/test';

import {
  detectionBoxes,
  expect,
  openCamera,
  pricePill,
  reshoot,
  seedScannableProduct,
  shoot,
  shutter,
  test,
  withScanSlot,
} from './fixtures';

/** Board-vs-real evidence for #182; CI keeps it in the report, `E2E_EVIDENCE_DIR` collects it. */
async function shot(page: Page, testInfo: TestInfo, name: string) {
  const dir = process.env.E2E_EVIDENCE_DIR ?? testInfo.outputDir;
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.png`);
  await page.screenshot({ path: file });
  await testInfo.attach(name, { path: file, contentType: 'image/png' });
}

type ScanBody = {
  image: { width?: number; height?: number };
  detections: { match: string; bbox: number[] }[];
};

/** Real scan from the backend, edited the way the issue saw it: a box that fills the photo. */
async function editScan(page: Page, edit: (body: ScanBody) => void) {
  await page.route('**/v1/recognition/scans', async (route: Route) => {
    const response = await route.fetch();
    const body = (await response.json()) as ScanBody;
    edit(body);
    await route.fulfill({ response, json: body });
  });
}

const fillPhoto = (body: ScanBody) => {
  const width = body.image.width ?? 1280;
  const height = body.image.height ?? 720;
  for (const d of body.detections) d.bbox = [0, 0, width, height];
};

/** The element's box lies wholly inside the viewfinder's box. */
async function expectInsideViewfinder(page: Page, name: RegExp) {
  const finder = (await page.getByTestId('viewfinder').boundingBox())!;
  const pill = (await page.getByRole('button', { name }).boundingBox())!;
  expect(pill.y).toBeGreaterThanOrEqual(finder.y);
  expect(pill.y + pill.height).toBeLessThanOrEqual(finder.y + finder.height);
}

test.describe('#182 camera states match the boards', () => {
  test('02 match: the pill stays inside the frame and the strip shows', async ({
    page,
    store,
  }, testInfo) => {
    await seedScannableProduct(store.api);
    await editScan(page, fillPhoto);
    await openCamera(page);
    await shoot(page);
    await expect(
      page.getByRole('radiogroup', { name: 'Chọn đúng món' }),
    ).toBeVisible();
    await expectInsideViewfinder(page, /xem món khác$/);
    await shot(page, testInfo, 'fix-camera-match');
  });

  test('04 ambiguous: amber badge, dashed box and "?" price, never a green check', async ({
    page,
    store,
  }, testInfo) => {
    await seedScannableProduct(store.api);
    await editScan(page, (body) => {
      fillPhoto(body);
      for (const d of body.detections) d.match = 'ambiguous';
    });
    await openCamera(page);
    await shoot(page);
    await expect(
      page.getByRole('button', { name: /chưa chắc, chạm để chọn$/ }),
    ).toBeVisible();
    await expect(pricePill(page)).toHaveText(/^\? /);
    await expectInsideViewfinder(page, /xem món khác$/);
    await expect(
      page.getByRole('button', { name: 'Thêm vào giỏ' }),
    ).toBeDisabled();
    await shot(page, testInfo, 'fix-camera-ambiguous');
  });

  test('04 unknown with an empty catalog: "?" pill inside the frame, no "0" score', async ({
    page,
  }, testInfo) => {
    await editScan(page, fillPhoto);
    await openCamera(page);
    await shoot(page);
    await expect(
      page.getByRole('button', { name: /chưa có trong kho$/ }),
    ).toBeVisible();
    await expectInsideViewfinder(page, /^Chưa có trong kho, nhập giá$/);
    await expect(page.getByLabel('Chưa nhận ra món này')).toBeVisible();
    await shot(page, testInfo, 'fix-camera-unknown');
  });
});

test.describe('#180 scan without an answer', () => {
  test('gives up after 20 s with a Vietnamese message and a working retry', async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    await openCamera(page);
    await page.route('**/v1/recognition/scans', () => {});
    await shutter(page).click();
    await expect(page.getByTestId('scan-busy')).toBeVisible();
    await expect(
      page.getByText('Mạng chậm, chưa nhận diện được. Thử lại.'),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('scan-busy')).toHaveCount(0);
    await shot(page, testInfo, 'fix-camera-scan-timeout');
    await page.unroute('**/v1/recognition/scans');
    await withScanSlot(async () => {
      await page.getByRole('button', { name: 'Thử lại' }).click();
      await expect(detectionBoxes(page).first()).toBeVisible({
        timeout: 30_000,
      });
    });
    await expect(reshoot(page)).toBeEnabled();
  });
});
