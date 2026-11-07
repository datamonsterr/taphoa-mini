import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build, hashedName, localReferences } from './build.mjs';

const SITE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const HASHED = /\.[0-9a-f]{8}\.[A-Za-z0-9]+$/;

async function buildInTemp(siteDir = SITE_DIR) {
  const outDir = join(await mkdtemp(join(tmpdir(), 'landing-build-')), 'dist');
  await build({ siteDir, outDir });
  return outDir;
}

test('index.html references only hashed local assets', async () => {
  const dist = await buildInTemp();
  const html = await readFile(join(dist, 'index.html'), 'utf8');
  const refs = localReferences(html);
  assert.ok(refs.length > 0, 'expected local references in index.html');
  for (const ref of refs) {
    assert.match(ref, HASHED, `${ref} is not hashed`);
  }
});

test('every local reference in dist exists in dist', async () => {
  const dist = await buildInTemp();
  const texts = [
    'index.html',
    ...(await readdir(dist)).filter(
      (f) => f.endsWith('.css') || f.endsWith('.js'),
    ),
  ];
  for (const file of texts) {
    const text = await readFile(join(dist, file), 'utf8');
    for (const ref of localReferences(text)) {
      const info = await stat(join(dist, ref));
      assert.ok(info.isFile(), `${file} references missing ${ref}`);
    }
  }
});

test('no unhashed stylesheet or script remains', async () => {
  const dist = await buildInTemp();
  const top = await readdir(dist);
  assert.deepEqual(
    top.filter((f) => /^(styles|main)\.(css|js)$/.test(f)),
    [],
  );
  const html = await readFile(join(dist, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /href="styles\.css"|src="main\.js"/);
});

test('hashes keep the directory and extension and change with content', () => {
  assert.match(
    hashedName('img/a.jpg', Buffer.from('x')),
    /^img\/a\.[0-9a-f]{8}\.jpg$/,
  );
  assert.notEqual(
    hashedName('main.js', Buffer.from('a')),
    hashedName('main.js', Buffer.from('b')),
  );
});

test('fails when index.html references a missing asset', async () => {
  const siteDir = await mkdtemp(join(tmpdir(), 'landing-site-'));
  await mkdir(join(siteDir, 'img'));
  await writeFile(
    join(siteDir, 'index.html'),
    '<img src="img/missing.jpg"><link href="styles.css">',
  );
  await writeFile(join(siteDir, 'styles.css'), 'body{}');
  await writeFile(join(siteDir, 'main.js'), '');
  await writeFile(join(siteDir, 'favicon.svg'), '<svg/>');
  await assert.rejects(
    () => buildInTemp(siteDir),
    /Missing local asset\(s\).*img\/missing\.jpg/,
  );
});
