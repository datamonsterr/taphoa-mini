import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Receipt } from '../src/lib/api';
import { mapBox } from '../src/lib/bbox';
import {
  API_URL,
  button,
  callApi,
  expect,
  keypad,
  openCamera,
  recordApi,
  test,
  withScanSlot,
} from './fixtures';

const RECEIPT_DIR = path.join(
  __dirname,
  '../../backend/crates/recognition/tests/fixtures/receipts',
);
const fixture = JSON.parse(
  readFileSync(path.join(RECEIPT_DIR, 'receipt-1.json'), 'utf8'),
) as { lines: { product_name: string; quantity: number; cost: number }[] };

// Chromium loops concatenated JPEG frames as a webcam. No ffmpeg or CI clip-cache
// change is needed, and the product camera used by the other specs stays intact.
test.use({
  launchOptions: async ({}, use) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'g1-receipt-camera-'));
    const video = path.join(dir, 'receipt.mjpeg');
    const photo = readFileSync(path.join(RECEIPT_DIR, 'receipt-1.jpg'));
    writeFileSync(
      video,
      Buffer.concat(Array.from({ length: 10 }, () => photo)),
    );
    try {
      await use({
        args: [
          '--use-fake-device-for-media-stream',
          '--use-fake-ui-for-media-stream',
          `--use-file-for-fake-video-capture=${video}`,
        ],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
});

// This suite uses the real API, as do the other web specs. Older deployed backends
// may not have the receipts routes yet; all other response errors fail the test.
test.beforeEach(async ({ request, store }) => {
  const response = await request.get(`${API_URL}/v1/receipts`, {
    headers: {
      authorization: `Bearer ${store.api.token}`,
      'x-store-id': String(store.session.store.id),
    },
  });
  test.skip(
    response.status() === 404 ||
      response.status() === 405 ||
      response.status() === 501,
    'Backend lacks /v1/receipts',
  );
  expect(response.ok(), `Receipt preflight returned ${response.status()}`).toBe(
    true,
  );
});

test('receipt camera → edit 19b → summary 19 → confirmed stock', async ({
  page,
  store,
}, testInfo) => {
  test.setTimeout(180_000);
  // Leave the live camera while catalog indexing owns the inference slot.
  await page.goto('/expense');
  const products = [];
  // Leave the last product out until OCR has run, guaranteeing an unmatched line
  // even when CI's deterministic mapping recognizes all existing catalog names.
  for (const line of fixture.lines.slice(0, -1)) {
    const product = await store.api.createProduct({
      name: line.product_name,
      price: 15_000,
    });
    await store.api.waitForIndex(product.id);
    products.push(product);
  }
  const before = await store.api.get('/v1/stock');
  const shots =
    process.env.G1_SCREENSHOT_DIR ?? testInfo.outputPath('screenshots');
  const screenshot = async (name: string) => {
    const file = path.join(shots, `${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    await testInfo.attach(name, { path: file, contentType: 'image/png' });
  };

  // stack.sh and CI load real OCR_* models. This covers the live document-probe
  // path and the document-state shutter (upload → receipt), with no API mocks.
  // shoot() is intentionally unused: it assumes product detection boxes.
  const created = await withScanSlot(async () => {
    const probes = recordApi(page, 'POST', '/v1/recognition/document-probes');
    await openCamera(page);
    await expect(page.getByText(/^Hóa đơn · \d+ dòng chữ$/)).toBeVisible({
      timeout: 45_000,
    });
    await expect(page.getByTestId('document-line-0')).toBeVisible();
    await expect(button(page, 'Đọc hóa đơn nhập')).toBeVisible();
    await expect(button(page, 'Nhập trong trợ lý')).toBeVisible();
    await expect(
      page.getByText('Giữ máy thẳng, đủ sáng · chụp để đọc chữ'),
    ).toBeVisible();
    // Check alignment against the actual web video transform. Desktop/fake
    // streams omit facingMode, which Expo 58 treats as a mirrored front camera.
    const video = await page
      .locator('video')
      .evaluate((element: HTMLVideoElement) => ({
        width: element.videoWidth,
        height: element.videoHeight,
        mirrored:
          new DOMMatrixReadOnly(getComputedStyle(element).transform).a < 0,
        facingMode: (element.srcObject as MediaStream)
          .getVideoTracks()[0]
          .getSettings().facingMode,
      }));
    expect(video.mirrored).toBe((video.facingMode ?? 'user') === 'user');
    const signal = (await probes.stop()).at(-1)!.body;
    expect(signal.detected).toBe(true);
    const frame = (await page.getByTestId('viewfinder').boundingBox())!;
    for (const [index, line] of (signal.line_boxes as number[][]).entries()) {
      const x = video.mirrored ? 1 - line[0] - line[2] : line[0];
      const expected = mapBox(
        [
          x * video.width,
          line[1] * video.height,
          line[2] * video.width,
          line[3] * video.height,
        ],
        video,
        frame,
        'cover',
      );
      const box = (await page
        .getByTestId(`document-line-${index}`)
        .boundingBox())!;
      // Probe resizing rounds to whole pixels; allow its subpixel fit difference.
      expect(Math.abs(box.x - frame.x - expected.x)).toBeLessThan(1);
      expect(Math.abs(box.width - expected.width)).toBeLessThan(1);
    }
    await screenshot('receipts-01-camera');
    return callApi<Receipt>(page, 'POST', '/v1/receipts', () =>
      button(page, 'Chụp và đọc hóa đơn').click(),
    );
  });
  const receipt = created.body;
  expect(receipt.status).toBe('draft');
  expect(receipt.lines).toHaveLength(fixture.lines.length);
  await expect(page).toHaveURL(new RegExp(`/receipt/${receipt.id}$`));
  await expect(
    page.getByRole('heading', { name: 'Kiểm tra hóa đơn' }),
  ).toBeVisible();
  await expect(button(page, 'Xác nhận nhập kho')).toHaveCount(0);
  expect(receipt.lines.at(-1)?.product_id).toBeNull();
  // Fallback mapping is deliberately strict, so more than one line may still need a pick.
  await expect(
    page.getByText('Chọn sản phẩm', { exact: true }).first(),
  ).toBeVisible();
  products.push(
    await store.api.createProduct({
      name: fixture.lines.at(-1)!.product_name,
      price: 15_000,
    }),
  );
  await store.api.waitForIndex(products.at(-1)!.id);

  for (const [index, line] of receipt.lines.entries()) {
    await expect(page.getByText(`Đọc được: “${line.raw_text}”`)).toBeVisible();
    if (line.product_id !== products[index].id) {
      await button(page, `${line.product_name}, chạm để đổi sản phẩm`).click();
      await button(page, products[index].name).click();
    }
  }
  const first = receipt.lines[0];
  await button(page, `Thêm một: ${first.product_name}`).click();
  await expect(
    page.getByLabel(`Số lượng: ${first.product_name}`, { exact: true }),
  ).toHaveText(String(first.quantity + 1));
  await button(page, `Bớt một: ${first.product_name}`).click();
  await button(page, `Thêm một: ${first.product_name}`).click();
  await button(page, /^Giá nhập:/)
    .first()
    .click();
  await keypad(
    page,
    Array.from({ length: 9 }, () => 'Xóa'),
  );
  await keypad(page, ['9', '000']);
  await button(page, 'Xong').click();
  await expect(
    page.getByLabel(`Thành tiền: ${first.product_name}`, { exact: true }),
  ).toHaveText(`${((first.quantity + 1) * 9000).toLocaleString('vi-VN')}đ`);
  // Scroll the edited card into view for the 19b evidence, after mapping all lines.
  await button(page, /^Giá nhập:/)
    .first()
    .scrollIntoViewIfNeeded();
  await screenshot('receipts-02-review');
  await button(page, 'Xong, xem lại').click();
  await expect(
    page.getByRole('heading', { name: 'Hóa đơn nhập' }),
  ).toBeVisible();
  await expect(button(page, /^Thêm một:/)).toHaveCount(0);
  await expect(page.getByText(`${first.quantity + 1} × 9.000đ`)).toBeVisible();
  await screenshot('receipts-03-summary');
  const confirmed = await callApi<Receipt>(
    page,
    'POST',
    `/v1/receipts/${receipt.id}/confirm`,
    () => button(page, 'Xác nhận nhập kho').click(),
  );
  expect(confirmed.body.status).toBe('confirmed');
  expect(confirmed.requestBody.lines[0]).toMatchObject({
    line_id: first.id,
    product_id: products[0].id,
    quantity: first.quantity + 1,
    cost: (first.quantity + 1) * 9000,
  });
  const after = await store.api.get('/v1/stock');
  for (const [index, product] of products.entries()) {
    const initial = before.items.find(
      (row: { product_id: string }) => row.product_id === product.id,
    );
    expect(
      after.items.find(
        (row: { product_id: string }) => row.product_id === product.id,
      ),
    ).toMatchObject({
      stock_quantity:
        (initial?.stock_quantity ?? 0) +
        receipt.lines[index].quantity +
        (index === 0 ? 1 : 0),
    });
  }
});

test('Expense opens receipt history and shows the real empty list', async ({
  page,
}) => {
  await page.goto('/expense');
  const history = await callApi(page, 'GET', '/v1/receipts', () =>
    button(page, 'Hóa đơn nhập').click(),
  );
  expect(history.body.items).toEqual([]);
  await expect(page).toHaveURL(/\/receipts$/);
  await expect(page.getByText('Chưa có hóa đơn nhập')).toBeVisible();
});
