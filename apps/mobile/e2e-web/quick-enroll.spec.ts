import {
  acceptQuickAngle,
  addButton,
  button,
  callInference,
  cartPill,
  enrollTag,
  expect,
  formatVnd,
  openCamera,
  pricePill,
  shoot,
  shutter,
  test,
  typeAmount,
  unknownPill,
} from './fixtures';

test.describe('quick enroll (real SAM and DINO models)', () => {
  test('three accepted photos enroll asynchronously, then checkout matches the product and adds it to the cart', async ({
    page,
    store,
  }) => {
    test.setTimeout(120_000);
    const product = { name: 'Bánh đỏ nhanh E2E', price: 17_000 };
    // The fixture creates a fresh store through the real API, with an empty catalog.
    await openCamera(page);
    await enrollTag(page).click();
    await expect(enrollTag(page)).toHaveAttribute('aria-selected', 'true');
    await expect(enrollTag(page)).toHaveCSS(
      'background-color',
      'rgb(90, 67, 232)',
    );
    const add = page.getByTestId('quick-enroll-add');
    const references = [];
    for (let angle = 0; angle < 3; angle++) {
      await expect(add).toHaveCount(0);
      references.push(await acceptQuickAngle(page));
      if (angle < 2) {
        await expect(page.getByText('Xoay sản phẩm')).toBeVisible();
        await expect(add).toHaveCount(0);
        await expect(shutter(page)).toBeEnabled();
      }
    }
    await expect(shutter(page)).toHaveCount(0);
    await expect(add).toHaveAccessibleName('Thêm sản phẩm');
    await add.click();
    await expect(
      page.getByRole('heading', { name: 'Thêm hàng nhanh · 3/3' }),
    ).toBeVisible();
    await expect(page.getByLabel('3 trên 8 ảnh')).toBeVisible();
    await expect(button(page, 'Lưu sản phẩm')).toBeDisabled();
    await page
      .getByRole('textbox', { name: 'Tên (không bắt buộc)' })
      .fill(product.name);
    await typeAmount(page, product.price);
    const created = await callInference(page, 'POST', '/v1/products', () =>
      button(page, 'Lưu sản phẩm').click(),
    );
    expect(created.status).toBe(201);
    expect(created.requestBody).toMatchObject({
      ...product,
      references,
      force_new: false,
    });
    expect(created.body).toMatchObject({ ...product, index_status: 'pending' });
    await expect(page.getByRole('alert')).toHaveText(`Đã thêm ${product.name}`);
    await expect(page.getByTestId('quick-enroll-sheet')).toHaveCount(0);
    await store.api.waitForIndex(created.body.id);
    await expect(page.getByText('đang học', { exact: true })).toHaveCount(0);
    // Saving completes the quick session and switches the tag off automatically.
    await expect(enrollTag(page)).toHaveAttribute('aria-selected', 'false');
    const scan = await shoot(page);
    expect(scan.body.pipeline.segmenter).toContain('sam');
    expect(scan.body.pipeline.embedder).toContain('dino');
    expect(scan.body.detections[0]).toMatchObject({
      match: 'matched',
      candidates: [
        expect.objectContaining({ product_id: created.body.id, ...product }),
      ],
    });
    await expect(unknownPill(page)).toHaveCount(0);
    await expect(pricePill(page)).toHaveAccessibleName(
      `${product.name} ${formatVnd(product.price)}, xem món khác`,
    );
    await expect(pricePill(page)).toContainText(
      formatVnd(product.price).replace('đ', ''),
    );
    await addButton(page).click();
    await expect(cartPill(page)).toHaveAccessibleName(
      `Giỏ hàng: 1 món, ${formatVnd(product.price)}`,
    );
    await cartPill(page).click();
    await expect(page).toHaveURL(/\/cart/);
    await expect(page.getByText(product.name, { exact: true })).toBeVisible();
  });

  test('switching off with an accepted photo asks first; cancel preserves it and confirm discards it', async ({
    page,
  }) => {
    await openCamera(page);
    await enrollTag(page).click();
    await acceptQuickAngle(page);
    for (const discard of [false, true]) {
      await Promise.all([
        page.waitForEvent('dialog', { timeout: 5000 }).then(async (dialog) => {
          expect(dialog.type()).toBe('confirm');
          expect(dialog.message()).toBe('Bỏ các ảnh đã chụp?');
          if (discard) await dialog.accept();
          else await dialog.dismiss();
        }),
        enrollTag(page).click(),
      ]);
      await expect(enrollTag(page)).toHaveAttribute(
        'aria-selected',
        String(!discard),
      );
      if (!discard) await expect(page.getByText('Xoay sản phẩm')).toBeVisible();
    }
    await expect(page.getByText('Xoay sản phẩm')).toHaveCount(0);
    await enrollTag(page).click();
    await expect(page.getByText('Xoay sản phẩm')).toBeVisible();
    await expect(page.getByTestId('quick-enroll-add')).toHaveCount(0);
  });
});
