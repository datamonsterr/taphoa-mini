import { readdirSync } from 'node:fs';
import { basename } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildCatalog,
  loadOracleCatalog,
  ORACLE_NAMES,
  OracleCatalogError,
  parseOracleSql,
  placeholdersOf,
  QUERIES_DIR,
} from './catalog.ts';

/** A file text from header lines and a SQL body. */
function sql(header: string[], body = 'SELECT 1::bigint AS n'): string {
  return `${header.join('\n')}\n${body}\n`;
}

const MINIMAL = [
  '-- oracle: demo_count',
  '-- kind: count',
  '-- uses: U2',
  '-- describe: A demo oracle.',
];

describe('parseOracleSql', () => {
  it('parses a header without args', () => {
    const entry = parseOracleSql(
      'demo_count.sql',
      sql(
        MINIMAL,
        'WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today)\nSELECT 1 FROM ctx',
      ),
    );
    expect(entry).toMatchObject({
      name: 'demo_count',
      kind: 'count',
      args: [],
      uses: ['U2'],
      describe: 'A demo oracle.',
      example: null,
      file: 'demo_count.sql',
    });
    expect(entry.sql).toContain('WITH ctx');
  });

  it('numbers the placeholders: store $1, today $2, args from $3', () => {
    const entry = parseOracleSql(
      'demo_count.sql',
      sql(
        [
          ...MINIMAL,
          '-- args: product product, period period, limit int',
          '-- example: {"product":"Coca","period":"yesterday","limit":3}',
        ],
        'SELECT $1::uuid, $2::date, $3::text, $4::date, $5::date, $6::int',
      ),
    );
    expect(entry.args).toEqual([
      { name: 'product', type: 'product', param: 3 },
      { name: 'period', type: 'period', param: 4 },
      { name: 'limit', type: 'int', param: 6 },
    ]);
    expect(entry.example).toEqual({
      product: 'Coca',
      period: 'yesterday',
      limit: 3,
    });
  });

  it('accepts every kind and use code', () => {
    for (const kind of ['names', 'number', 'money', 'percent', 'count']) {
      const text = sql([
        '-- oracle: demo_count',
        `-- kind: ${kind}`,
        '-- uses: U1, U23, PERM',
        '-- describe: x',
      ]);
      expect(
        parseOracleSql('demo_count.sql', text.replace('1::bigint', '$1, $2'))
          .kind,
      ).toBe(kind);
    }
  });

  it('ignores $n inside comments and string literals', () => {
    const entry = parseOracleSql(
      'demo_count.sql',
      sql(
        MINIMAL,
        "SELECT $1::uuid, $2::date, '$9' AS s -- uses $7 here\n, 'it''s $8' AS t",
      ),
    );
    expect(entry.name).toBe('demo_count');
  });

  it('fails on a missing or misspelled header line', () => {
    expect(() => parseOracleSql('x.sql', 'SELECT 1')).toThrow(
      /missing '-- oracle:'/,
    );
    const noKind = sql(MINIMAL.filter((l) => !l.startsWith('-- kind')));
    expect(() => parseOracleSql('demo_count.sql', noKind)).toThrow(
      /missing '-- kind:'/,
    );
    const noDescribe = sql(MINIMAL.filter((l) => !l.startsWith('-- desc')));
    expect(() => parseOracleSql('demo_count.sql', noDescribe)).toThrow(
      /missing '-- describe:'/,
    );
    const noUses = sql(MINIMAL.filter((l) => !l.startsWith('-- uses')));
    expect(() => parseOracleSql('demo_count.sql', noUses)).toThrow(
      /missing '-- uses:'/,
    );
    expect(() =>
      parseOracleSql('demo_count.sql', sql([...MINIMAL, '-- descibe: typo'])),
    ).toThrow(/unknown header 'descibe'/);
    expect(() =>
      parseOracleSql('demo_count.sql', sql([...MINIMAL, '-- kind: money'])),
    ).toThrow(/duplicate header 'kind'/);
  });

  it('fails on an invalid kind', () => {
    const text = sql([
      '-- oracle: demo_count',
      '-- kind: text',
      ...MINIMAL.slice(2),
    ]);
    expect(() => parseOracleSql('demo_count.sql', text)).toThrow(
      /unknown kind 'text'/,
    );
  });

  it('fails when the name is malformed or differs from the file name', () => {
    expect(() => parseOracleSql('other.sql', sql(MINIMAL))).toThrow(
      /does not match the file name/,
    );
    const text = sql(['-- oracle: Demo-Count', ...MINIMAL.slice(1)]);
    expect(() => parseOracleSql('Demo-Count.sql', text)).toThrow(
      /lower_snake_case/,
    );
  });

  it('fails on bad uses', () => {
    const text = sql([...MINIMAL.slice(0, 2), '-- uses: U24', MINIMAL[3]!]);
    expect(() => parseOracleSql('demo_count.sql', text)).toThrow(
      /bad use 'U24'/,
    );
  });

  it('fails on malformed args', () => {
    const base = (args: string) => sql([...MINIMAL, `-- args: ${args}`]);
    expect(() => parseOracleSql('demo_count.sql', base('product'))).toThrow(
      /bad arg 'product'/,
    );
    expect(() =>
      parseOracleSql('demo_count.sql', base('product widget')),
    ).toThrow(/unknown arg type 'widget'/);
    expect(() =>
      parseOracleSql('demo_count.sql', base('a int, a text')),
    ).toThrow(/duplicate arg 'a'/);
    expect(() =>
      parseOracleSql('demo_count.sql', base('Bad-Name int')),
    ).toThrow(/bad arg name/);
  });

  describe('placeholders and args must agree', () => {
    const header = [
      ...MINIMAL,
      '-- args: product product',
      '-- example: {"product":"Coca"}',
    ];

    it('passes when $1..$3 are all used', () => {
      expect(
        parseOracleSql(
          'demo_count.sql',
          sql(header, 'SELECT $1::uuid, $2::date, $3::text'),
        ).args,
      ).toHaveLength(1);
    });

    it('fails when SQL uses a placeholder no arg declares', () => {
      expect(() =>
        parseOracleSql(
          'demo_count.sql',
          sql(header, 'SELECT $1::uuid, $2::date, $3::text, $4::int'),
        ),
      ).toThrow(/\$4.*declares only \$1\.\.\$3/);
    });

    it('fails when a declared placeholder is never used', () => {
      expect(() =>
        parseOracleSql(
          'demo_count.sql',
          sql(header, 'SELECT $1::uuid, $3::text'),
        ),
      ).toThrow(/never uses \$2/);
      expect(() =>
        parseOracleSql(
          'demo_count.sql',
          sql(header, 'SELECT $1::uuid, $2::date'),
        ),
      ).toThrow(/never uses \$3/);
    });

    it('counts a period arg as two placeholders', () => {
      const periodHeader = [
        ...MINIMAL,
        '-- args: period period',
        '-- example: {"period":"today"}',
      ];
      expect(() =>
        parseOracleSql(
          'demo_count.sql',
          sql(periodHeader, 'SELECT $1::uuid, $2::date, $3::date'),
        ),
      ).toThrow(/never uses \$4/);
      expect(
        parseOracleSql(
          'demo_count.sql',
          sql(periodHeader, 'SELECT $1::uuid, $2::date, $3::date, $4::date'),
        ).args[0],
      ).toEqual({ name: 'period', type: 'period', param: 3 });
    });

    it('always needs the store id and today', () => {
      expect(() =>
        parseOracleSql('demo_count.sql', sql(MINIMAL, 'SELECT 1')),
      ).toThrow(/never uses \$1/);
    });
  });

  describe('example', () => {
    const args = [...MINIMAL, '-- args: product product, limit int'];
    const body = 'SELECT $1::uuid, $2::date, $3::text, $4::int';

    it('is required when the oracle has args', () => {
      expect(() => parseOracleSql('demo_count.sql', sql(args, body))).toThrow(
        /needs '-- example:'/,
      );
    });

    it('must be a JSON object naming exactly the args', () => {
      const withExample = (json: string) =>
        sql([...args, `-- example: ${json}`], body);
      expect(() =>
        parseOracleSql('demo_count.sql', withExample('not json')),
      ).toThrow(/example is not valid JSON/);
      expect(() =>
        parseOracleSql('demo_count.sql', withExample('[1]')),
      ).toThrow(/example must be a JSON object/);
      expect(() =>
        parseOracleSql('demo_count.sql', withExample('{"product":"A"}')),
      ).toThrow(/example is missing 'limit'/);
      expect(() =>
        parseOracleSql(
          'demo_count.sql',
          withExample('{"product":"A","limit":2,"extra":1}'),
        ),
      ).toThrow(/example has 'extra'/);
      expect(() =>
        parseOracleSql(
          'demo_count.sql',
          withExample('{"product":"A","limit":true}'),
        ),
      ).toThrow(/example 'limit' must be a string or a number/);
    });

    it('is not allowed without args', () => {
      expect(() =>
        parseOracleSql(
          'demo_count.sql',
          sql([...MINIMAL, '-- example: {"a":1}'], 'SELECT $1, $2'),
        ),
      ).toThrow(/example without args/);
    });
  });

  it('fails on an empty body', () => {
    expect(() => parseOracleSql('demo_count.sql', sql(MINIMAL, ''))).toThrow(
      /no SQL/,
    );
  });

  it('wraps every problem in OracleCatalogError with the file name', () => {
    try {
      parseOracleSql('demo_count.sql', 'SELECT 1');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(OracleCatalogError);
      expect((e as Error).message).toContain('demo_count.sql');
    }
  });
});

describe('placeholdersOf', () => {
  it('lists the distinct placeholders in order', () => {
    expect(placeholdersOf('SELECT $2, $1, $2, $10')).toEqual([1, 2, 10]);
  });
});

describe('buildCatalog', () => {
  const one = (name: string) =>
    sql(
      [`-- oracle: ${name}`, ...MINIMAL.slice(1)],
      'SELECT $1::uuid, $2::date',
    );

  it('keeps file order and returns every entry', () => {
    const entries = buildCatalog([
      { file: 'a_count.sql', text: one('a_count') },
      { file: 'b_count.sql', text: one('b_count') },
    ]);
    expect(entries.map((e) => e.name)).toEqual(['a_count', 'b_count']);
  });

  it('fails on duplicate oracle names', () => {
    expect(() =>
      buildCatalog([
        { file: 'a_count.sql', text: one('a_count') },
        { file: 'dir/a_count.sql', text: one('a_count') },
      ]),
    ).toThrow(/duplicate oracle 'a_count'/);
  });
});

describe('the query files', () => {
  const files = readdirSync(QUERIES_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  it('has between 50 and 100 oracles', () => {
    expect(files.length).toBeGreaterThanOrEqual(50);
    expect(files.length).toBeLessThanOrEqual(100);
  });

  it('parses every file and names each oracle after its file', () => {
    const catalog = loadOracleCatalog();
    expect(catalog.map((e) => `${e.name}.sql`).sort()).toEqual(files);
    for (const entry of catalog) {
      expect(basename(entry.file)).toBe(`${entry.name}.sql`);
    }
  });

  it('has no duplicate oracle name', () => {
    const catalog = loadOracleCatalog();
    expect(new Set(catalog.map((e) => e.name)).size).toBe(catalog.length);
  });

  it('gives every oracle with args an example', () => {
    for (const entry of loadOracleCatalog()) {
      if (entry.args.length > 0) {
        expect(entry.example, entry.name).not.toBeNull();
      }
    }
  });

  it('exports ORACLE_NAMES as a plain Set of the catalog names', () => {
    expect(ORACLE_NAMES).toBeInstanceOf(Set);
    expect([...ORACLE_NAMES].sort()).toEqual(
      loadOracleCatalog()
        .map((e) => e.name)
        .sort(),
    );
  });

  it('covers every use case U1-U22 and the permission facts', () => {
    const used = new Set(loadOracleCatalog().flatMap((e) => e.uses));
    // U12 (help articles), U15 (voice) and U23 (debts, waits for X5) have no
    // database facts.
    for (let u = 1; u <= 22; u++) {
      if (u === 12 || u === 15) continue;
      expect(used, `U${u}`).toContain(`U${u}`);
    }
    expect(used).not.toContain('U23');
    expect(used).toContain('PERM');
  });

  it('includes the oracle names the task spells out', () => {
    for (const name of [
      'sales_revenue',
      'stock_low_names',
      'supplier_cheapest_recent',
    ]) {
      expect(ORACLE_NAMES.has(name), name).toBe(true);
    }
  });

  it('is cached: the same array comes back', () => {
    expect(loadOracleCatalog()).toBe(loadOracleCatalog());
  });
});
