import type { Page } from '@playwright/test';
import {
  addButton,
  backToLive,
  button,
  callInference,
  cartPill,
  detectionBoxes,
  enrollFromCamera,
  expect,
  expectLiveVideo,
  fillEnroll,
  formatVnd,
  openCamera,
  pricePill,
  reshoot,
  saveEnroll,
  shoot,
  test,
  unknownPill,
} from './fixtures';

/**
 * The camera plays one product photo (e2e-web/fixtures/make-video.sh). The scan goes to the real
 * backend with the real SAM + DINO models: a store with no products sees an unknown item, the
 * product enrolled from that crop is matched on the next shot.
 */

const PRODUCT = { name: 'Kẹo dừa E2E', price: 15_000 };

async function addAngle(page: Page) {
  await button(page, 'Thêm ảnh góc khác').click();
  const dialog = page.getByRole('dialog');
  await expectLiveVideo(dialog);
  await button(dialog, 'Chụp').click();
  await expect(dialog).toHaveCount(0);
}

/** Another checkout scan can become stale while this device enrolls the item. */
async function duplicateEnroll(camera: Page) {
  const page = await camera.context().newPage();
  await openCamera(page);
  await shoot(page);
  await unknownPill(page).click();
  await fillEnroll(page, { name: 'Bản sao', price: 9000 });
  const { product } = await enrollFromCamera(camera, PRODUCT);
  return { page, product };
}

test.describe('recognition and enroll (real models)', () => {
  test('an empty store sees the item as unknown; enrolling it makes the next shot a match that goes to the cart', async ({
    page,
    store,
  }) => {
    await openCamera(page);

    // 1. shoot: nothing in the catalog, so the server answers "unknown"
    const first = await shoot(page);
    expect(first.status).toBe(201);
    expect(first.body.detections.length).toBeGreaterThan(0);
    expect(first.body.detections[0]).toMatchObject({
      match: 'unknown',
      candidates: [],
    });
    expect(first.body.pipeline.segmenter).toContain('sam');
    expect(first.body.pipeline.embedder).toContain('dino');
    await expect(page.getByTestId('viewfinder-photo')).toBeVisible();
    await expect(detectionBoxes(page)).toHaveCount(
      first.body.detections.length,
    );
    await expect(unknownPill(page)).toBeVisible();
    await expect(addButton(page)).toBeDisabled();

    // the box the server found lies inside the frozen photo
    const finder = (await page.getByTestId('viewfinder').boundingBox())!;
    const box = (await detectionBoxes(page).first().boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(finder.x - 1);
    expect(box.y).toBeGreaterThanOrEqual(finder.y - 1);
    expect(box.x + box.width).toBeLessThanOrEqual(finder.x + finder.width + 1);
    expect(box.y + box.height).toBeLessThanOrEqual(
      finder.y + finder.height + 1,
    );

    // 2. enroll it from the "?" pill: the sheet opens with the cut-out photo
    await unknownPill(page).click();
    await expect(page).toHaveURL(/\/enroll\?.*detectionId=/);
    await expect(page.getByLabel('1 trên 5 ảnh')).toBeVisible();
    await expect(button(page, 'Lưu vào kho và thêm vào giỏ')).toBeDisabled();
    await fillEnroll(page, PRODUCT);
    const { images, product } = await saveEnroll(page);

    expect(images).toHaveLength(1);
    expect(images[0]!.status).toBe(201);
    expect(images[0]!.requestBody.multipart).toMatchObject({
      purpose: 'enrollment',
    });
    expect(product.status).toBe(201);
    expect(product.requestBody).toMatchObject({
      name: PRODUCT.name,
      price: PRODUCT.price,
      image_ids: [images[0]!.body.id],
      force_new: false,
    });
    expect(product.body).toMatchObject({
      name: PRODUCT.name,
      price: PRODUCT.price,
    });
    // saving also put it in the cart, priced as the server stored it
    await expect(cartPill(page)).toHaveAccessibleName(
      `Giỏ hàng: 1 món, ${formatVnd(product.body.price)}`,
    );

    // 3. shoot again: the same product is now a confident match
    await backToLive(page);
    const second = await shoot(page);
    const detection = second.body.detections[0];
    expect(detection.match).toBe('matched');
    expect(detection.candidates[0]).toMatchObject({
      product_id: product.body.id,
      name: PRODUCT.name,
      price: PRODUCT.price,
    });
    // above the backend's match threshold (DEFAULT_MATCH_THRESHOLD in classify.rs)
    expect(detection.candidates[0].similarity).toBeGreaterThanOrEqual(0.8);
    await expect(unknownPill(page)).toHaveCount(0);
    await expect(pricePill(page)).toHaveAccessibleName(
      `${PRODUCT.name} ${formatVnd(PRODUCT.price)}, xem món khác`,
    );
    await expect(pricePill(page)).toContainText(
      formatVnd(PRODUCT.price).replace('đ', ''),
    );
    await expect(addButton(page)).toBeEnabled();

    // 4. add: the cart pill total is two items of the enrolled price
    await addButton(page).click();
    await expect(button(page, 'Chụp')).toBeVisible();
    await expect(cartPill(page)).toHaveAccessibleName(
      `Giỏ hàng: 2 món, ${formatVnd(2 * PRODUCT.price)}`,
    );
    await expect(page.getByTestId('cart-count')).toHaveText('2');

    // the catalog the server holds is the one just enrolled
    const catalog = await store.api.get('/v1/products');
    expect(catalog.items).toHaveLength(1);
    expect(catalog.items[0]).toMatchObject({
      id: product.body.id,
      name: PRODUCT.name,
      price: PRODUCT.price,
    });
  });

  test('multi mode sends mode=multi; every detection the server returns gets a box', async ({
    page,
  }) => {
    await openCamera(page);
    await button(page, 'Nhiều món').click();
    const scan = await shoot(page, 'multi');
    expect(scan.requestBody.multipart.mode).toBe('multi');
    expect(scan.body.mode).toBe('multi');
    expect(scan.body.detections.length).toBeGreaterThan(0);
    await expect(detectionBoxes(page)).toHaveCount(scan.body.detections.length);
    await expect(page.getByTestId('box-badge')).toHaveCount(0);
    await button(page, 'Một món').click();
    await reshoot(page).click();
    const single = await shoot(page);
    expect(single.requestBody.multipart.mode).toBe('single');
    await expect(detectionBoxes(page)).toHaveCount(1);
  });

  test('enroll with an extra angle uploads both photos and creates one product', async ({
    page,
  }) => {
    await openCamera(page);
    await shoot(page);
    await unknownPill(page).click();
    await fillEnroll(page, { name: 'Hai góc', price: 7000 });
    await addAngle(page);
    await expect(page.getByText('2/5')).toBeVisible();
    const { images, product } = await saveEnroll(page, 2);
    expect(images.map((i) => i.status)).toEqual([201, 201]);
    expect(product.requestBody.image_ids).toEqual(images.map((i) => i.body.id));
    expect(product.body.images).toHaveLength(2);
  });

  test('enrolling the same item again: the server suspects a duplicate; merge adds a photo to the existing product', async ({
    page: camera,
    store,
  }) => {
    await openCamera(camera);
    const { page, product } = await duplicateEnroll(camera);

    const duplicate = await callInference(
      page,
      'POST',
      '/v1/products',
      () => button(page, 'Lưu vào kho và thêm vào giỏ').click(),
      409,
    );
    expect(duplicate.body.code).toBe('duplicate_suspected');
    await expect(page.getByText(`Giống "${PRODUCT.name}"`)).toContainText(
      formatVnd(PRODUCT.price),
    );

    // merge: the photo is attached to the existing product, no second product appears
    const merged = await callInference(
      page,
      'POST',
      `/v1/products/${product.body.id}/images`,
      () => button(page, 'Gộp ảnh vào món có sẵn').click(),
    );
    expect(merged.status).toBeLessThan(300);
    await expect(page).not.toHaveURL(/\/enroll/);
    const catalog = await store.api.get('/v1/products');
    expect(catalog.items).toHaveLength(1);
    const detail = await store.api.get(`/v1/products/${product.body.id}`);
    expect(detail.images).toHaveLength(2);
  });

  test('enrolling the same item again: "create anyway" sends force_new and makes a second product', async ({
    page: camera,
    store,
  }) => {
    await openCamera(camera);
    const { page } = await duplicateEnroll(camera);
    await callInference(
      page,
      'POST',
      '/v1/products',
      () => button(page, 'Lưu vào kho và thêm vào giỏ').click(),
      409,
    );
    const forced = await callInference(page, 'POST', '/v1/products', () =>
      button(page, 'Vẫn tạo món mới').click(),
    );
    expect(forced.status).toBe(201);
    expect(forced.requestBody.force_new).toBe(true);
    expect(forced.body).toMatchObject({ name: 'Bản sao', price: 9000 });
    await expect(page).not.toHaveURL(/\/enroll/);
    const catalog = await store.api.get('/v1/products');
    expect(catalog.items.map((p: any) => p.name).sort()).toEqual(
      ['Bản sao', PRODUCT.name].sort(),
    );
  });
});
