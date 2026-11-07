import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';

const require = createRequire(new URL('../package.json', import.meta.url));
const facade = readFileSync(
  new URL('../src/components/icons.ts', import.meta.url),
  'utf8',
);
const packageRoot = resolve(
  dirname(require.resolve('lucide-react-native')),
  '../..',
);
const barrel = readFileSync(
  resolve(packageRoot, 'dist/esm/lucide-react-native.mjs'),
  'utf8',
);
const barrelPaths = new Map();
for (const match of barrel.matchAll(
  /export \{ ([^}]+) \} from '\.\/icons\/([^']+)\.mjs';/g,
)) {
  for (const alias of match[1].matchAll(/default as (\w+)/g)) {
    barrelPaths.set(alias[1], match[2]);
  }
}

const exports = [
  ...facade.matchAll(
    /^export \{ default as (\w+) \} from 'lucide-react-native\/icons\/([^']+)';$/gm,
  ),
];

test('every facade icon resolves and matches its lucide barrel alias', () => {
  assert.ok(exports.length > 0, 'no facade icon exports found');
  assert.equal(
    exports.length,
    (facade.match(/^export \{/gm) ?? []).length,
    'unrecognized facade export',
  );
  const errors = [];
  for (const [, name, path] of exports) {
    try {
      require.resolve(`lucide-react-native/icons/${path}`);
    } catch {
      errors.push(`${name}: cannot resolve icons/${path}`);
    }
    if (barrelPaths.get(name) !== path) {
      errors.push(
        `${name}: icons/${path} differs from barrel icons/${barrelPaths.get(name) ?? '<missing>'}`,
      );
    }
  }
  assert.deepEqual(errors, []);
});
