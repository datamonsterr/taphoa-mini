import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { dashboards } from './definitions/index.mjs';
import { llmDashboards } from './llm/index.mjs';
import { createClient } from './lib/client.mjs';
import { loadSecrets } from './lib/secrets.mjs';

const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

/** Exports saved dashboards exactly as configured (all environments). No dashboard mutations. */
export async function exportDashboards({
  client,
  outputDir,
  pollMs = 2000,
  maxPolls = 150,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  save = async (file, bytes) => {
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, file), bytes);
  },
  now = () => new Date(),
}) {
  const saved = await client.listAll('dashboards/');
  // Validate every match before starting an export.
  const selected = [...dashboards, ...llmDashboards].map(({ name }) => {
    const matches = saved.filter((item) => item.name === name && !item.deleted);
    if (matches.length !== 1)
      throw new Error(`Expected one dashboard: ${name}`);
    return matches[0];
  });
  const timestamp = now().toISOString();
  const prefix = timestamp.replace(/[:.]/g, '-');
  const result = {
    timestamp,
    scope: 'Saved dashboards: all environments',
    dashboards: [],
  };
  for (const dashboard of selected) {
    let asset = await client.post('exports/', {
      dashboard: dashboard.id,
      export_format: 'image/png',
    });
    const id = asset.id;
    if (!Number.isSafeInteger(id) || id <= 0)
      throw new Error('Invalid export ID');
    let polls = 0;
    while (!asset.has_content) {
      if (asset.exception)
        throw new Error(`Dashboard export failed: ${dashboard.name}`);
      if (polls++ >= maxPolls)
        throw new Error(`Dashboard export timed out: ${dashboard.name}`);
      await sleep(pollMs);
      asset = await client.get(`exports/${id}/`);
    }
    const bytes = await client.download(`exports/${id}/content/`);
    if (!Buffer.from(bytes).subarray(0, 8).equals(pngHeader))
      throw new Error(`Export is not PNG: ${dashboard.name}`);
    const file = `${prefix}-${slug(dashboard.name)}.png`;
    await save(file, bytes);
    result.dashboards.push({
      name: dashboard.name,
      dashboardId: dashboard.id,
      exportId: id,
      file,
    });
  }
  await save(`${prefix}-manifest.json`, JSON.stringify(result, null, 2) + '\n');
  return result;
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      'output-dir': {
        type: 'string',
        default: 'docs/specs/assistant/dod/screenshots',
      },
    },
  });
  const result = await exportDashboards({
    client: createClient(loadSecrets()),
    outputDir: values['output-dir'],
  });
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
