import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkCase, mkFullSet } from './test-helpers.ts';

const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'golden-cli-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Variables the CLI reads; tests start from a clean slate. */
const CLI_ENV = [
  'BACKEND_URL',
  'EVAL_DATABASE_URL',
  'OPENROUTER_EVAL_API_KEY',
  'EVAL_JUDGE_MODELS',
  'POSTHOG_PROJECT_TOKEN',
  'POSTHOG_HOST',
  'EVAL_TODAY',
  'EVAL_STORE_ID',
  'EVAL_LEAD_TOKEN',
  'EVAL_SELLER_TOKEN',
];

function cleanEnv(extra: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of CLI_ENV) delete env[key];
  return { ...env, ...extra };
}

function run(...args: string[]) {
  return runWithEnv({}, ...args);
}

function runWithEnv(extra: Record<string, string>, ...args: string[]) {
  const r = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: cleanEnv(extra),
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('cli validate', () => {
  it('exits 1 and prints the coverage problems for an empty directory', () => {
    const r = run('validate', '--dir', dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('U1: 0 cases, need at least 6');
    expect(r.stdout).toContain('U23: 0 cases, need at least 6');
    expect(r.stdout).toContain('OT: 0 cases, need at least 6');
    expect(r.stdout).toContain('smoke: 0 cases, need exactly 25');
  });

  it('exits 0 for a complete golden set', () => {
    const byFile = new Map<string, string[]>();
    for (const c of mkFullSet()) {
      const lines = byFile.get(c.use_case) ?? [];
      lines.push(JSON.stringify(c));
      byFile.set(c.use_case, lines);
    }
    for (const [name, lines] of byFile) {
      writeFileSync(join(dir, `${name}.jsonl`), lines.join('\n') + '\n');
    }
    const r = run('validate', `--dir=${dir}`);
    expect(r.stdout).toContain('ok: 144 golden cases');
    expect(r.status).toBe(0);
  });

  it('prints loader errors with file:line', () => {
    writeFileSync(join(dir, 'U1.jsonl'), '{not json\n');
    const r = run('validate', '--dir', dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('U1.jsonl:1: invalid JSON');
  });

  it('defaults to the golden directory of the package', () => {
    const r = run('validate');
    expect(r.status === 0 || r.status === 1).toBe(true);
    expect(r.stderr).toBe('');
  });

  it('rejects unknown options with usage and exit 2', () => {
    const r = run('validate', '--nope');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('usage');
  });
});

describe('cli usage', () => {
  it('prints usage and exits 2 for an unknown command', () => {
    for (const command of ['other', '--help']) {
      const r = run(command);
      expect(r.status, command).toBe(2);
      expect(r.stderr).toContain('usage');
    }
  });

  it('rejects unknown options and bad values with exit 2', () => {
    expect(run('smoke', '--stub', '--nope').status).toBe(2);
    const r = run('smoke', '--stub', '--concurrency', 'abc');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--concurrency');
  });

  it('asks for --models on compare', () => {
    const r = run('compare', '--stub');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--models');
  });
});

describe('cli dry runs against the stub assistant', () => {
  const resultFiles = () => readdirSync(dir).filter((f) => f.endsWith('.md'));

  it('smoke --stub exits 0 and writes a results file', () => {
    const r = run('smoke', '--stub', '--out', dir);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const files = resultFiles();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}-.*-smoke\.md$/);
    const md = readFileSync(join(dir, files[0]!), 'utf8');
    expect(md).toContain('## Pass bars');
    expect(r.stdout).toContain('tool_selection');
    expect(r.stdout).toContain(files[0]!);
  });

  it('ignores the lone -- that pnpm passes on', () => {
    const r = run('smoke', '--', '--stub', '--out', dir);
    expect(r.status).toBe(0);
    expect(resultFiles()).toHaveLength(1);
  });

  it('smoke --bad-stub exits 1 and still writes a results file', () => {
    const r = run('smoke', '--bad-stub', '--out', dir);
    expect(r.status).toBe(1);
    expect(resultFiles()).toHaveLength(1);
    expect(r.stdout).toContain('FAIL');
  });

  it('uses the fixture cases when the golden directory is empty', () => {
    const golden = mkdtempSync(join(tmpdir(), 'golden-empty-'));
    try {
      const r = run('smoke', '--stub', '--dir', golden, '--out', dir);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('fixtures');
    } finally {
      rmSync(golden, { recursive: true, force: true });
    }
  });

  it('fails fast on invalid golden cases', () => {
    writeFileSync(join(dir, 'U1.jsonl'), '{not json\n');
    const out = mkdtempSync(join(tmpdir(), 'out-'));
    try {
      const r = run('smoke', '--stub', '--dir', dir, '--out', out);
      expect(r.status).toBe(1);
      expect(r.stdout + r.stderr).toContain('U1.jsonl:1: invalid JSON');
      expect(readdirSync(out)).toEqual([]);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('full --stub refuses a second run the same day unless --force', () => {
    expect(run('full', '--stub', '--out', dir).status).toBe(0);
    const again = run('full', '--stub', '--out', dir);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain('--force');
    expect(run('full', '--stub', '--force', '--out', dir).status).toBe(0);
  });

  it('filters with --ids and --tags', () => {
    const byId = run('smoke', '--stub', '--ids', 'U1-01,OT-01', '--out', dir);
    expect(byId.status).toBe(0);
    expect(resultFiles()[0]).toMatch(/-partial\.md$/);
    const byTag = run('smoke', '--stub', '--tags', 'permission', '--out', dir);
    expect(byTag.status).toBe(0);
  });

  it('accepts --no-judge, --no-posthog and --concurrency', () => {
    const r = run(
      'smoke',
      '--stub',
      '--no-judge',
      '--no-posthog',
      '--concurrency',
      '2',
      '--out',
      dir,
    );
    expect(r.status).toBe(0);
  });

  it('requires a token for --posthog', () => {
    const r = run('smoke', '--stub', '--posthog', '--out', dir);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('POSTHOG_PROJECT_TOKEN');
  });

  it('compare --stub ranks the models and writes model-choice.md', () => {
    const r = run(
      'compare',
      '--stub',
      '--models',
      'a/one:free,b/two:free',
      '--out',
      dir,
    );
    expect(r.status).toBe(0);
    const md = readFileSync(join(dir, 'model-choice.md'), 'utf8');
    expect(md).toContain('Winner: a/one:free');
    expect(md).toContain('b/two:free');
    expect(r.stdout).toContain('model-choice.md');
  });

  it('compare --bad-stub exits 1 because no model passes', () => {
    const r = run(
      'compare',
      '--bad-stub',
      '--models',
      'a/one:free',
      '--out',
      dir,
    );
    expect(r.status).toBe(1);
    expect(readFileSync(join(dir, 'model-choice.md'), 'utf8')).toContain(
      'No candidate met every bar',
    );
  });
});

describe('cli live runs', () => {
  const live = {
    BACKEND_URL: 'http://127.0.0.1:9',
    EVAL_LEAD_TOKEN: 'lead-secret-token',
    EVAL_SELLER_TOKEN: 'seller-secret-token',
    OPENROUTER_EVAL_API_KEY: 'sk-or-secret-key',
  };

  it('needs a backend', () => {
    const r = run('smoke');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('BACKEND_URL');
  });

  /** A golden directory with one valid case, so a live run gets past loading. */
  function goldenWithOneCase() {
    const golden = mkdtempSync(join(tmpdir(), 'golden-one-'));
    writeFileSync(
      join(golden, 'U1.jsonl'),
      JSON.stringify(mkCase({ tags: ['smoke'] })) + '\n',
    );
    return golden;
  }

  it('says when there are no golden cases to run', () => {
    const golden = mkdtempSync(join(tmpdir(), 'golden-none-'));
    try {
      const r = runWithEnv(live, 'smoke', '--dir', golden, '--out', dir);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('no golden cases');
    } finally {
      rmSync(golden, { recursive: true, force: true });
    }
  });

  it('names EVAL_DATABASE_URL and T3 while the pg oracle is missing', () => {
    const golden = goldenWithOneCase();
    const r = runWithEnv(live, 'smoke', '--dir', golden, '--out', dir);
    rmSync(golden, { recursive: true, force: true });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('EVAL_DATABASE_URL');
    expect(r.stderr).toContain('T3');
  });

  it('never prints a secret value', () => {
    const golden = goldenWithOneCase();
    const r = runWithEnv(
      { ...live, EVAL_DATABASE_URL: 'postgres://user:pw-secret@localhost/db' },
      'smoke',
      '--dir',
      golden,
      '--out',
      dir,
    );
    rmSync(golden, { recursive: true, force: true });
    const text = r.stdout + r.stderr;
    for (const secret of [
      'lead-secret-token',
      'seller-secret-token',
      'sk-or-secret-key',
      'pw-secret',
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it('needs the OpenRouter key for the quota guard', () => {
    const { OPENROUTER_EVAL_API_KEY: _drop, ...noKey } = live;
    const r = runWithEnv(
      { ...noKey, EVAL_DATABASE_URL: 'postgres://x' },
      'smoke',
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('OPENROUTER_EVAL_API_KEY');
  });
});

describe('cli calibrate', () => {
  it('needs the OpenRouter key', () => {
    const r = run('calibrate');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('OPENROUTER_EVAL_API_KEY');
  });

  it('says what is missing when the calibration file is absent', () => {
    const r = runWithEnv(
      { OPENROUTER_EVAL_API_KEY: 'k' },
      'calibrate',
      '--file',
      join(dir, 'nope.jsonl'),
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('nope.jsonl');
  });
});
