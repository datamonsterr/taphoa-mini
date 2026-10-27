import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mkCase } from '../test-helpers.ts';
import { TOOL_NAMES } from './tools.ts';
import { validateCase } from './validate.ts';

const where = 'U1.jsonl:3';

function errorsFor(over: Record<string, unknown>) {
  return validateCase({ ...mkCase(), ...over }, where);
}

describe('TOOL_NAMES', () => {
  it('lists the tool catalog', () => {
    expect(TOOL_NAMES).toContain('get_restock_plan');
    expect(TOOL_NAMES).toContain('propose_invite');
    expect(TOOL_NAMES).toContain('draft_debt_reminder');
    expect(TOOL_NAMES).toHaveLength(37);
    expect(new Set(TOOL_NAMES).size).toBe(TOOL_NAMES.length);
  });

  const spec = fileURLToPath(
    new URL('../../../../docs/specs/assistant/assistant.md', import.meta.url),
  );
  it.skipIf(!existsSync(spec))('matches the assistant.md tool catalog', () => {
    const rows = readFileSync(spec, 'utf8').matchAll(
      /^\| `([a-z_]+)`\s+\| (?:read|propose)\s+\|/gm,
    );
    expect(TOOL_NAMES).toEqual([...rows].map((m) => m[1]));
  });
});

describe('validateCase: shape', () => {
  it('accepts a valid case', () => {
    expect(validateCase(mkCase(), where)).toEqual([]);
    expect(
      validateCase(
        mkCase({
          id: 'U3-04',
          use_case: 'U3',
          language: 'en',
          kind: 'chat',
          context: { screen: 'camera' },
          expect_tools: {
            must: ['get_margin_report'],
            must_not: ['propose_price_change'],
            any_of: [['get_top_products', 'get_sales_summary']],
          },
          expect_facts: [
            { oracle: 'thin_margin_names', match: 'all_mentioned' },
            {
              oracle: 'margin_pct',
              args: { product: 'Coca', days: 30 },
              match: 'number',
              tolerance_pct: 1,
            },
          ],
          expect_action: {
            kind: 'price_change',
            fields: {
              product_id: { ref: 'product:Coca' },
              new_price: { eq: 12000 },
              'items[].quantity': { min: 1, max: 5 },
              by_oracle: { oracle: 'suggested_price', args: { p: 'Coca' } },
            },
          },
          expect_refusal: false,
          tags: ['smoke'],
        }),
        where,
      ),
    ).toEqual([]);
  });

  it('prefixes every error with the position', () => {
    const errors = validateCase({}, 'golden/U1.jsonl:7');
    expect(errors.length).toBeGreaterThan(0);
    for (const e of errors)
      expect(e.startsWith('golden/U1.jsonl:7: ')).toBe(true);
  });

  it('rejects a non-object', () => {
    for (const bad of [null, 'x', 4, [], undefined]) {
      expect(validateCase(bad, where)).toHaveLength(1);
    }
  });

  it('reports missing required fields', () => {
    const errors = validateCase({}, where).join('\n');
    for (const field of [
      'id',
      'use_case',
      'role',
      'messages',
      'expect_tools',
      'expect_facts',
      'expect_action',
      'rubric_vi',
      'tags',
    ]) {
      expect(errors, field).toContain(field);
    }
  });

  it('rejects unknown top-level keys', () => {
    expect(errorsFor({ expect_fact: [] }).join('\n')).toContain('expect_fact');
  });

  it('rejects bad enum values', () => {
    expect(errorsFor({ role: 'admin' }).join('\n')).toContain('role');
    expect(errorsFor({ language: 'fr' }).join('\n')).toContain('language');
    expect(errorsFor({ kind: 'voice' }).join('\n')).toContain('kind');
  });
});

describe('validateCase: id', () => {
  it.each(['U1-01', 'U9-06', 'U10-01', 'U19-12', 'U23-06', 'OT-02'])(
    'accepts %s',
    (id) => {
      const use_case = id.split('-')[0];
      expect(errorsFor({ id, use_case })).toEqual([]);
    },
  );

  it.each([
    'U1-1',
    'U1-001',
    'U0-01',
    'U24-01',
    'U01-01',
    'X1-01',
    'OT01',
    'u1-01',
    '',
  ])('rejects %s', (id) => {
    expect(errorsFor({ id, use_case: id.split('-')[0] }).join('\n')).toContain(
      'id',
    );
  });

  it('requires the prefix to equal use_case', () => {
    const errors = errorsFor({ id: 'U2-01', use_case: 'U1' });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('U2-01');
    expect(errors[0]).toContain('use_case');
    expect(errorsFor({ id: 'OT-01', use_case: 'U1' })).toHaveLength(1);
  });
});

describe('validateCase: tools', () => {
  it('rejects tools missing from the catalog in every list', () => {
    const errors = errorsFor({
      expect_tools: {
        must: ['get_restock_plan', 'get_nothing'],
        must_not: ['propose_nothing'],
        any_of: [['search_help', 'search_nothing']],
      },
    }).join('\n');
    expect(errors).toContain('get_nothing');
    expect(errors).toContain('propose_nothing');
    expect(errors).toContain('search_nothing');
    expect(errors).not.toContain("'get_restock_plan'");
  });

  it('requires must and must_not arrays', () => {
    expect(errorsFor({ expect_tools: {} }).join('\n')).toContain(
      'expect_tools.must',
    );
    expect(
      errorsFor({ expect_tools: { must: 'x', must_not: [] } }).join('\n'),
    ).toContain('expect_tools.must');
    expect(
      errorsFor({
        expect_tools: { must: [], must_not: [], any_of: ['x'] },
      }).join('\n'),
    ).toContain('any_of');
  });
});

describe('validateCase: messages, rubric and tags', () => {
  it('requires non-empty messages', () => {
    expect(errorsFor({ messages: [] }).join('\n')).toContain('messages');
    expect(
      errorsFor({ messages: [{ role: 'user', content: '  ' }] }).join('\n'),
    ).toContain('messages[0]');
    expect(
      errorsFor({ messages: [{ role: 'assistant', content: 'x' }] }).join('\n'),
    ).toContain('messages[0]');
    expect(errorsFor({ messages: 'hi' }).join('\n')).toContain('messages');
  });

  it('requires a non-empty rubric_vi', () => {
    expect(errorsFor({ rubric_vi: '' }).join('\n')).toContain('rubric_vi');
    expect(errorsFor({ rubric_vi: '   ' }).join('\n')).toContain('rubric_vi');
    expect(errorsFor({ rubric_vi: 4 }).join('\n')).toContain('rubric_vi');
  });

  it('accepts only the known tags', () => {
    expect(
      errorsFor({ tags: ['smoke', 'ambiguity', 'offtopic', 'voice'] }),
    ).toEqual([]);
    const errors = errorsFor({ tags: ['smoke', 'flaky'] });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('flaky');
    expect(errorsFor({ tags: 'smoke' }).join('\n')).toContain('tags');
  });
});

describe('validateCase: facts and actions', () => {
  it('checks fact shape', () => {
    expect(
      errorsFor({ expect_facts: [{ oracle: '', match: 'number' }] }).join('\n'),
    ).toContain('expect_facts[0].oracle');
    expect(
      errorsFor({ expect_facts: [{ oracle: 'x', match: 'most' }] }).join('\n'),
    ).toContain('expect_facts[0].match');
    expect(
      errorsFor({
        expect_facts: [{ oracle: 'x', match: 'number', tolerance_pct: 'a' }],
      }).join('\n'),
    ).toContain('tolerance_pct');
    expect(
      errorsFor({ denied_facts: [{ oracle: 'x', match: 'bad' }] }).join('\n'),
    ).toContain('denied_facts[0].match');
  });

  it('checks expect_action shape', () => {
    expect(errorsFor({ expect_action: 'x' }).join('\n')).toContain(
      'expect_action',
    );
    expect(errorsFor({ expect_action: { fields: {} } }).join('\n')).toContain(
      'expect_action.kind',
    );
    expect(errorsFor({ expect_action: { kind: 'a' } }).join('\n')).toContain(
      'expect_action.fields',
    );
    expect(
      errorsFor({
        expect_action: { kind: 'a', fields: { x: { nope: 1 } } },
      }).join('\n'),
    ).toContain('expect_action.fields.x');
    expect(
      errorsFor({
        expect_action: { kind: 'a', fields: { x: { min: 'a' } } },
      }).join('\n'),
    ).toContain('expect_action.fields.x');
  });
});

describe('validateCase: tag rules', () => {
  it('requires a permission case to be a seller with non-empty denied facts', () => {
    const denied = [{ oracle: 'margin', match: 'none_mentioned' }];
    expect(
      errorsFor({ tags: ['permission'], role: 'lead', denied_facts: denied }),
    ).toHaveLength(1);
    expect(errorsFor({ tags: ['permission'], role: 'seller' })).toHaveLength(1);
    expect(
      errorsFor({ tags: ['permission'], role: 'seller', denied_facts: [] }),
    ).toHaveLength(1);
    expect(
      errorsFor({
        tags: ['permission'],
        role: 'seller',
        expect_refusal: false,
      }),
    ).toHaveLength(1);
    expect(
      errorsFor({ tags: ['permission'], role: 'seller', denied_facts: denied }),
    ).toEqual([]);
    expect(
      errorsFor({ tags: ['permission'], role: 'seller', expect_refusal: true }),
    ).toHaveLength(1);
    expect(
      errorsFor({
        tags: ['permission'],
        role: 'seller',
        denied_facts: denied,
        expect_refusal: true,
      }),
    ).toEqual([]);
  });

  it('requires an injection case to define injection', () => {
    expect(errorsFor({ tags: ['injection'] }).join('\n')).toContain(
      'injection',
    );
    expect(
      errorsFor({
        tags: ['injection'],
        injection: {
          canaries: ['PWNED'],
          must_not_tools: ['propose_price_change'],
        },
      }),
    ).toEqual([]);
  });

  it('checks the injection shape', () => {
    const bad = (injection: unknown) => errorsFor({ injection }).join('\n');
    expect(bad({ canaries: [], must_not_tools: [] })).toContain(
      'injection.canaries',
    );
    expect(bad({ canaries: [''], must_not_tools: [] })).toContain(
      'injection.canaries',
    );
    expect(bad({ canaries: ['x'] })).toContain('injection.must_not_tools');
    expect(
      bad({ canaries: ['x'], must_not_tools: ['no_such_tool'] }),
    ).toContain('no_such_tool');
  });

  it('requires a multi_turn case to have 2 or more messages', () => {
    const one = [{ role: 'user', content: 'a' }];
    const two = [...one, { role: 'user', content: 'b' }];
    expect(
      errorsFor({ tags: ['multi_turn'], messages: one }).join('\n'),
    ).toContain('multi_turn');
    expect(errorsFor({ tags: ['multi_turn'], messages: two })).toEqual([]);
  });

  it('does not allow a pending case in the smoke set', () => {
    const pending = { on: 'X5', reason: 'debt tools' };
    expect(errorsFor({ tags: ['smoke'], pending }).join('\n')).toContain(
      'smoke',
    );
    expect(errorsFor({ tags: [], pending })).toEqual([]);
    expect(
      errorsFor({ pending: { on: 'X9', reason: 'r' } }).join('\n'),
    ).toContain('pending.on');
    expect(errorsFor({ pending: { on: 'X5' } }).join('\n')).toContain(
      'pending.reason',
    );
  });

  it('needs pending X8 or no messages for a digest case', () => {
    expect(errorsFor({ kind: 'digest' }).join('\n')).toContain('digest');
    expect(
      errorsFor({ kind: 'digest', pending: { on: 'X5', reason: 'r' } }).join(
        '\n',
      ),
    ).toContain('digest');
    expect(
      errorsFor({ kind: 'digest', pending: { on: 'X8', reason: 'r' } }),
    ).toEqual([]);
    expect(errorsFor({ kind: 'digest', messages: [] })).toEqual([]);
  });
});
