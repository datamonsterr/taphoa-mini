import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

/**
 * The app talks to the real backend only. The in-memory API under `src/test` is a Jest double:
 * no file that ships in the bundle may import it, by alias or by relative path.
 */
const SRC = resolve(__dirname, '../src');
const TEST_DIR = join(SRC, 'test') + sep;

const isTestFile = (file: string) =>
  file.startsWith(TEST_DIR) || /\.test\.[cm]?[jt]sx?$/.test(file);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

/** Every module specifier a file imports, requires or lazily imports. */
function specifiers(source: string): string[] {
  const pattern =
    /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;
  return [...source.matchAll(pattern)].map((match) => match[1]!);
}

function reachesTestDir(file: string, specifier: string): boolean {
  if (specifier === '@/test' || specifier.startsWith('@/test/')) return true;
  if (!specifier.startsWith('.')) return false;
  const target = resolve(dirname(file), specifier) + sep;
  return target.startsWith(TEST_DIR);
}

test('the double exists where tests can import it', () => {
  expect(
    sourceFiles(SRC).some((file) => file.startsWith(join(TEST_DIR, 'mock'))),
  ).toBe(true);
});

test('no runtime file under src/ imports from src/test', () => {
  const offenders = sourceFiles(SRC)
    .filter((file) => !isTestFile(file))
    .flatMap((file) =>
      specifiers(readFileSync(file, 'utf8'))
        .filter((specifier) => reachesTestDir(file, specifier))
        .map((specifier) => `${relative(SRC, file)} -> ${specifier}`),
    );
  expect(offenders).toEqual([]);
});

test('the old runtime location is gone', () => {
  expect(() => readdirSync(join(SRC, 'lib', 'mock'))).toThrow();
});

test('the matcher catches the imports it is meant to forbid', () => {
  const file = join(SRC, 'lib', 'api', 'client.ts');
  expect(reachesTestDir(file, '@/test/mock/fetch')).toBe(true);
  expect(reachesTestDir(file, '../../test/mock/fetch')).toBe(true);
  expect(reachesTestDir(file, './authFetch')).toBe(false);
  expect(
    specifiers(
      "import a from '@/test/mock/db';\nconst b = require('../test/x');\nawait import('./y');",
    ),
  ).toEqual(['@/test/mock/db', '../test/x', './y']);
});
