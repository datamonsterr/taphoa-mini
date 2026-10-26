import { button, expect, hydrate, openShop, test } from './fixtures';

/**
 * One smoke test of the assistant with the REAL free model, for Railway `test`:
 *
 *   E2E_ASSISTANT_REAL_MODEL=1 EXPO_PUBLIC_API_URL=<railway test api> pnpm exec playwright test e2e-web/assistant-real.spec.ts
 *
 * Skipped by default and in CI (CI runs the scripted model: assistant.spec.ts). It sends ONE
 * message, so the model sees at most two requests (the answer, plus one tool round when it asks
 * for data). The answer is not asserted beyond "something non-empty streamed to the end": a free
 * model's wording is not stable.
 */
test.skip(
  !process.env.E2E_ASSISTANT_REAL_MODEL || !!process.env.CI,
  'Set E2E_ASSISTANT_REAL_MODEL=1 (outside CI) to run the real-model smoke test',
);

test('real model: asks about today sales and a non-empty answer streams to the end', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openShop(page, '/inventory');
  await button(page, 'Mở trợ lý').click();
  await hydrate(page, page.getByTestId('assistant-screen'));

  await page.getByTestId('assistant-input').fill('Hôm nay bán được bao nhiêu?');
  await page.getByTestId('assistant-send').click();

  const reply = page.getByTestId('assistant-message').last();
  // the feedback thumbs appear only once the stream completed (status done)
  await expect(page.getByTestId('feedback-up')).toBeVisible({
    timeout: 90_000,
  });
  await expect(reply).toBeVisible();
  const text = (await reply.innerText()).trim();
  expect(text.length, 'the reply is not empty').toBeGreaterThan(0);
  // no error notice: the retry button only exists on a failed turn
  await expect(button(page, 'Thử lại')).toHaveCount(0);
});
