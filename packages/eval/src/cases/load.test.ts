import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkCase } from '../test-helpers.ts';
import { loadGolden } from './load.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'golden-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const line = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ ...mkCase(), ...over });

function write(name: string, ...lines: string[]) {
  writeFileSync(join(dir, name), lines.join('\n') + '\n');
}

describe('loadGolden', () => {
  it('returns no cases and no errors for an empty directory', () => {
    expect(loadGolden(dir)).toEqual({ cases: [], errors: [] });
  });

  it('loads every jsonl file in natural order and ignores other files', () => {
    write('U2.jsonl', line({ id: 'U2-01', use_case: 'U2' }));
    write('U10.jsonl', line({ id: 'U10-01', use_case: 'U10' }));
    write('OT.jsonl', line({ id: 'OT-01', use_case: 'OT' }));
    write('U1.jsonl', line({ id: 'U1-01' }), line({ id: 'U1-02' }));
    writeFileSync(join(dir, '.gitkeep'), '');
    writeFileSync(join(dir, 'notes.md'), '# not a case file\n');
    mkdirSync(join(dir, 'sub.jsonl'));
    const { cases, errors } = loadGolden(dir);
    expect(errors).toEqual([]);
    expect(cases.map((c) => c.id)).toEqual([
      'U1-01',
      'U1-02',
      'U2-01',
      'U10-01',
      'OT-01',
    ]);
  });

  it('skips blank lines but keeps real line numbers in errors', () => {
    write('U1.jsonl', line({ id: 'U1-01' }), '', '   ', '{not json');
    const { cases, errors } = loadGolden(dir);
    expect(cases.map((c) => c.id)).toEqual(['U1-01']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('U1.jsonl:4');
    expect(errors[0]).toContain('JSON');
  });

  it('reports validation errors with file:line', () => {
    write(
      'U1.jsonl',
      line({ id: 'U1-01' }),
      line({ id: 'U1-02', rubric_vi: '' }),
    );
    const { cases, errors } = loadGolden(dir);
    expect(cases.map((c) => c.id)).toEqual(['U1-01']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('U1.jsonl:2');
    expect(errors[0]).toContain('rubric_vi');
  });

  it('reports a duplicate id within and across files', () => {
    write('U1.jsonl', line({ id: 'U1-01' }), line({ id: 'U1-01' }));
    write('U2.jsonl', line({ id: 'U2-01', use_case: 'U2' }));
    write('U3.jsonl', line({ id: 'U3-01', use_case: 'U3' }));
    const { cases, errors } = loadGolden(dir);
    expect(cases.map((c) => c.id)).toEqual(['U1-01', 'U2-01', 'U3-01']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('U1.jsonl:2');
    expect(errors[0]).toContain('duplicate');
    expect(errors[0]).toContain('U1.jsonl:1');
  });

  it('reports a case in the wrong file', () => {
    write(
      'U3.jsonl',
      line({ id: 'U3-01', use_case: 'U3' }),
      line({ id: 'U4-01', use_case: 'U4' }),
    );
    write('OT.jsonl', line({ id: 'U5-01', use_case: 'U5' }));
    const { errors } = loadGolden(dir);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('U3.jsonl:2');
    expect(errors[0]).toContain('U3');
    expect(errors[0]).toContain('U4');
    expect(errors[1]).toContain('OT.jsonl:1');
  });

  it('reports an unreadable directory', () => {
    const { cases, errors } = loadGolden(join(dir, 'missing'));
    expect(cases).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('missing');
  });

  it('reports several problems at once', () => {
    write(
      'U1.jsonl',
      '{bad',
      line({ id: 'U1-01', messages: [] }),
      line({ id: 'U2-01', use_case: 'U2' }),
      line({ id: 'U1-02' }),
    );
    const { cases, errors } = loadGolden(dir);
    expect(cases.map((c) => c.id)).toEqual(['U2-01', 'U1-02']);
    expect(errors).toHaveLength(3);
    expect(errors[0]).toContain('U1.jsonl:1');
    expect(errors[1]).toContain('U1.jsonl:2');
    expect(errors[2]).toContain('U1.jsonl:3');
  });

  it('loads Vietnamese text as written', () => {
    write(
      'U1.jsonl',
      line({ id: 'U1-01', rubric_vi: 'Liệt kê sản phẩm cần nhập' }),
    );
    expect(loadGolden(dir).cases[0]!.rubric_vi).toBe(
      'Liệt kê sản phẩm cần nhập',
    );
  });
});
