import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GOLDEN_VOICE_DIR,
  loadVoiceCases,
  parseVoiceCase,
  smokeSubset,
  VoiceCaseError,
} from './cases.ts';

const valid = {
  id: 'x',
  source: 'synthetic',
  transcript: 'hai lon coca',
  language: 'vi',
  intent: 'sale',
  payment_method: 'cash',
  lines: [
    {
      spoken: 'coca',
      product: 'Coca-Cola lon 320ml',
      quantity: 2,
      unit_price: null,
    },
  ],
  tags: [],
};

describe('parseVoiceCase', () => {
  it('accepts a valid sidecar', () => {
    expect(parseVoiceCase(valid, 'x.json').id).toBe('x');
  });
  it.each([
    ['bad source', { source: 'tts' }],
    ['bad intent', { intent: 'buy' }],
    ['sale without lines', { lines: [] }],
    ['chat with lines', { intent: 'chat' }],
    ['none with words', { intent: 'none', lines: [] }],
    ['credit without a customer', { payment_method: 'credit' }],
    ['quantity zero', { lines: [{ ...valid.lines[0], quantity: 0 }] }],
    ['fractional price', { lines: [{ ...valid.lines[0], unit_price: 1.5 }] }],
    [
      'matched without product',
      { lines: [{ ...valid.lines[0], product: null, status: 'matched' }] },
    ],
  ])('refuses %s', (_name, over) => {
    expect(() => parseVoiceCase({ ...valid, ...over }, 'x.json')).toThrow(
      VoiceCaseError,
    );
  });
});

describe('the golden voice set', () => {
  const cases = loadVoiceCases();
  const store = readFileSync(
    join(import.meta.dirname, '..', '..', 'STORE.md'),
    'utf8',
  );

  it('holds at least 40 cases with a clip each, under 5 MB', () => {
    expect(cases.length).toBeGreaterThanOrEqual(40);
    const bytes = cases.reduce((n, c) => n + statSync(c.audio_path).size, 0);
    expect(bytes).toBeLessThan(5 * 1024 * 1024);
  });

  it('covers every required kind', () => {
    const tags = new Set(cases.flatMap((c) => c.tags));
    for (const t of [
      'single-line',
      'multi-line',
      'price-shorthand',
      'credit',
      'transfer',
      'chat',
      'silence',
      'noise',
      'unknown',
      'ambiguous',
      'two-speakers',
      'line-total',
    ])
      expect(tags, t).toContain(t);
    const phrases = [
      'hai chục',
      'hai lăm',
      'mười rưỡi',
      'trăm rưỡi',
      'hai trăm',
      'năm nghìn',
    ];
    const spoken = cases.map((c) => c.transcript).join(' | ');
    for (const p of phrases) expect(spoken, p).toContain(p);
  });

  it('has exactly ten smoke cases', () => {
    expect(smokeSubset(cases)).toHaveLength(10);
  });

  it('names real products of the eval store (STORE.md), except deliberate unknowns', () => {
    for (const c of cases)
      for (const l of c.lines) {
        if (l.product === null) {
          expect(['unknown', 'ambiguous'], c.id).toContain(l.status);
        } else {
          expect(store, `${c.id}: ${l.product}`).toContain(`| ${l.product} `);
        }
      }
  });

  it('is synthetic or recorded only', () => {
    for (const c of cases)
      expect(['synthetic', 'recorded']).toContain(c.source);
  });

  it('GOLDEN_VOICE_DIR exists', () => {
    expect(GOLDEN_VOICE_DIR).toContain('golden');
  });
});
