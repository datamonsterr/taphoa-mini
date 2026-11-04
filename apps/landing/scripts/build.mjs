// Copies the landing site into dist/ with content-hashed asset names. The Caddy image caches
// hashed files for a year (apps/landing/Caddyfile), so every change to a file must change its
// name. index.html keeps its name and is served with no-cache.
//
// Usage: node scripts/build.mjs [outDir]   (default: dist/ next to this directory's parent)
import { createHash } from 'node:crypto';
import { readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SITE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = 'index.html';
const TEXT_EXTENSIONS = new Set(['.html', '.css', '.js']);

// A local reference is a relative path ending in a known asset extension. Absolute URLs
// (https://...), query strings and dotted hosts do not match: the character before the name
// must not be a word character, `.`, `/` or `:`.
const REFERENCE =
  /(?<![\w./:-])((?:[\w-]+\/)*\w[\w.-]*\.(?:css|js|svg|jpe?g|png|webp|gif))(?![\w-])/g;

export function localReferences(text) {
  return [...text.matchAll(REFERENCE)].map((match) => match[1]);
}

export function hashedName(name, content) {
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 8);
  const ext = extname(name);
  return `${name.slice(0, -ext.length)}.${hash}${ext}`;
}

async function siteFiles(siteDir) {
  const images = (await readdir(join(siteDir, 'img'))).map(
    (file) => `img/${file}`,
  );
  return [ENTRY, 'styles.css', 'main.js', 'favicon.svg', ...images];
}

export async function build({
  siteDir = SITE_DIR,
  outDir = join(SITE_DIR, 'dist'),
} = {}) {
  const files = await siteFiles(siteDir);
  const sources = new Map();
  for (const file of files) {
    sources.set(file, await readFile(join(siteDir, file)));
  }

  // Output names. The entry point keeps its name, so references to it are left alone.
  const names = new Map([[ENTRY, ENTRY]]);
  const outputs = new Map();
  const missing = new Set();

  // Binary assets first (their hashes feed the stylesheets), then stylesheets and scripts
  // (their hashed content feeds index.html). The entry point comes last.
  const order = [...files].sort((a, b) => rank(a) - rank(b));
  for (const file of order) {
    if (file === ENTRY) continue;
    const source = sources.get(file);
    let content = source;
    if (TEXT_EXTENSIONS.has(extname(file))) {
      content = Buffer.from(
        rewrite(file, source.toString('utf8'), sources, names, missing),
      );
    }
    names.set(file, hashedName(file, content));
    outputs.set(names.get(file), content);
  }
  outputs.set(
    ENTRY,
    Buffer.from(
      rewrite(
        ENTRY,
        sources.get(ENTRY).toString('utf8'),
        sources,
        names,
        missing,
      ),
    ),
  );
  if (missing.size > 0) {
    throw new Error(
      `Missing local asset(s) referenced by the site: ${[...missing].join(', ')}`,
    );
  }

  await rm(outDir, { recursive: true, force: true });
  for (const [name, content] of outputs) {
    const target = join(outDir, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return { outDir, files: [...outputs.keys()].sort() };
}

function rank(file) {
  if (file === ENTRY) return 2;
  return TEXT_EXTENSIONS.has(extname(file)) ? 1 : 0;
}

function rewrite(file, text, sources, names, missing) {
  return text.replace(REFERENCE, (_, ref) => {
    if (names.has(ref)) return names.get(ref);
    if (!sources.has(ref)) {
      missing.add(`${file} -> ${ref}`);
      return ref;
    }
    throw new Error(
      `${file} references ${ref} before it is hashed (reorder the build)`,
    );
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const outDir = process.argv[2] ? resolve(process.argv[2]) : undefined;
    const result = await build(outDir ? { outDir } : {});
    console.log(`Built ${result.files.length} files into ${result.outDir}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
