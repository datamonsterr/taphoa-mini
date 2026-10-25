import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkFullSet } from './test-helpers.ts';

const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'golden-cli-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(...args: string[]) {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
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

describe('cli placeholder commands', () => {
  it('prints usage and exits 2', () => {
    for (const command of ['smoke', 'full', 'compare', 'calibrate', 'other']) {
      const r = run(command);
      expect(r.status, command).toBe(2);
      expect(r.stderr).toContain('usage');
    }
  });
});
