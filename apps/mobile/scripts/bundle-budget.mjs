// Fails when an exported JS bundle outgrows its budget. Run after `pnpm build:all`.
// Budgets are today's measured size plus about 15%, so an accidental heavy import trips CI
// while normal feature work does not. Raise a budget on purpose, in the same commit as the cause.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = resolve(fileURLToPath(import.meta.url), '../..');

/**
 * `android`: Hermes bytecode is already dense and does not gzip further, so the raw size counts.
 * `web`: served compressed, so the gzip size of all chunks counts.
 */
export const TARGETS = [
  {
    name: 'android (hbc, raw)',
    dir: 'dist/_expo/static/js/android',
    gzip: false,
    budget: 12_380_000, // measured 10_765_824 after voice V2 and the offline outbox (#87)
  },
  {
    name: 'web (js, gzip)',
    dir: 'dist-web/_expo/static/js/web',
    gzip: true,
    budget: 1_290_000, // measured ~1_081_754 + Clerk/assistant delta; posthog-react-native on web
  },
];

const BUNDLE = /\.(hbc|js)$/;

/** Sums the size of every bundle file in `dir`; gzip level 9 matches a static host's best case. */
export function measure(dir, { gzip }) {
  const files = readdirSync(dir).filter((file) => BUNDLE.test(file));
  if (files.length === 0) throw new Error(`no bundle files in ${dir}`);
  let bytes = 0;
  for (const file of files) {
    const path = join(dir, file);
    bytes += gzip
      ? gzipSync(readFileSync(path), { level: 9 }).length
      : statSync(path).size;
  }
  return { files: files.length, bytes };
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;

/** Renders the rows as an aligned text table. */
export function table(rows) {
  const header = ['bundle', 'files', 'size', 'budget', 'used', 'status'];
  const body = rows.map((row) => [
    row.name,
    String(row.files),
    kb(row.bytes),
    kb(row.budget),
    `${Math.round((row.bytes / row.budget) * 100)}%`,
    row.bytes <= row.budget ? 'ok' : 'OVER',
  ]);
  const widths = header.map((_, i) =>
    Math.max(...[header, ...body].map((r) => r[i].length)),
  );
  return [header, ...body]
    .map((r) => r.map((cell, i) => cell.padEnd(widths[i])).join('  '))
    .join('\n');
}

/** Measures every target under `base`; returns the rows and whether all are within budget. */
export function run(targets = TARGETS, base = root) {
  const rows = targets.map((target) => ({
    name: target.name,
    budget: target.budget,
    ...measure(join(base, target.dir), target),
  }));
  return { rows, ok: rows.every((row) => row.bytes <= row.budget) };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { rows, ok } = run();
  console.log(table(rows));
  if (!ok) {
    console.error('Bundle budget exceeded.');
    process.exit(1);
  }
}
