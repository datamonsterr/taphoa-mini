/* global __dirname */
const path = require('node:path');
const fs = require('node:fs');

const repo = path.resolve(__dirname, '../../../..');
const date = new Date().toISOString().slice(0, 10);
const output = path.resolve(
  process.env.DESIGN_AUDIT_OUTPUT || `/tmp/taphoa-audit-${date}`,
);
fs.mkdirSync(output, { recursive: true });

function launchOptions() {
  return {
    ...(process.env.DESIGN_AUDIT_CHROMIUM
      ? { executablePath: process.env.DESIGN_AUDIT_CHROMIUM }
      : {}),
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  };
}

module.exports = { repo, output, launchOptions };
