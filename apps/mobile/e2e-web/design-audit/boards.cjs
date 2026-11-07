const { chromium } = require('@playwright/test');
const path = require('node:path');
const { repo, output, launchOptions } = require('./common.cjs');
const boards = require(
  path.join(repo, 'docs/design/canvas/canvas.json'),
).boards;
const base = process.env.DESIGN_AUDIT_BOARD_URL || 'http://127.0.0.1:4175';

async function main() {
  const browser = await chromium.launch(launchOptions());
  try {
    for (const [name, board] of Object.entries(boards)) {
      if (/^(Capture|Multi)/.test(name)) continue; // Pending PR #301.
      const page = await browser.newPage({
        viewport: { width: board.w, height: board.h },
      });
      try {
        await page.route('**/*', (route) =>
          route.request().url().startsWith(`${base}/`)
            ? route.continue()
            : route.abort(),
        );
        await page.goto(`${base}/docs/design/canvas/${name}`, {
          waitUntil: 'domcontentloaded',
        });
        await page.screenshot({ path: path.join(output, `${name}.png`) });
        console.log(name);
      } finally {
        await page.close();
      }
    }
    for (const [name, width, height] of [
      ['landing-desktop', 1440, 5600],
      ['landing-phone', 390, 8200],
    ]) {
      const page = await browser.newPage({ viewport: { width, height } });
      try {
        await page.route('**/*', (route) =>
          route.request().url().startsWith(`${base}/`)
            ? route.continue()
            : route.abort(),
        );
        await page.goto(`${base}/apps/landing/`, {
          waitUntil: 'domcontentloaded',
        });
        await page.screenshot({ path: path.join(output, `${name}.png`) });
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
