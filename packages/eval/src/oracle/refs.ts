/**
 * Refs: golden cases point at database rows by name, the oracle layer turns
 * them into ids.
 *
 * | Ref                              | Resolves to                                              |
 * | -------------------------------- | -------------------------------------------------------- |
 * | `product:<exact name>`           | `products.id`                                            |
 * | `member:<display name>`          | `members.id`                                             |
 * | `category:<name>`                | `categories.id`                                          |
 * | `receipt:draft`                  | the draft receipt (the eval store has exactly one)       |
 * | `receipt:last`                   | the newest confirmed receipt                             |
 * | `receipt:<supplier>@<YYYY-MM-DD>`| the confirmed receipt of that supplier on that date      |
 * | `receipt_line:<receipt key>#<n>` | `receipt_lines.id` of line n (1-based, as in STORE.md)   |
 *
 * `<supplier>` is a short code (`HT`, `MP`, `BS`) or the supplier's name.
 * A product ref also accepts the display name of the injection product (its
 * name without the injected tail), because oracle values show that form.
 */
import type { Queryable } from './db.ts';
import { isIsoDate } from './dates.ts';

/** The three suppliers of the eval store (STORE.md "Suppliers"). */
export const SUPPLIER_CODES = {
  HT: 'Đại lý Hưng Thịnh',
  MP: 'Công ty Minh Phát',
  BS: 'Sỉ Bà Sáu chợ Bình Tây',
} as const;

export class RefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefError';
  }
}

export type Ref = {
  kind: 'product' | 'member' | 'category' | 'receipt' | 'receipt_line';
  key: string;
  /** 1-based line number, `receipt_line` only. */
  line?: number;
};

const KINDS = ['product', 'member', 'category', 'receipt', 'receipt_line'];

/** `kind:key`, split at the first colon (the key may hold more colons). */
export function parseRef(ref: string): Ref {
  const cut = ref.indexOf(':');
  if (cut <= 0) {
    throw new RefError(
      `'${ref}' is not a ref (expected <kind>:<key>, kinds: ${KINDS.join(', ')})`,
    );
  }
  const kind = ref.slice(0, cut);
  const key = ref.slice(cut + 1).trim();
  if (!KINDS.includes(kind)) {
    throw new RefError(
      `unknown ref kind '${kind}' in '${ref}' (known: ${KINDS.join(', ')})`,
    );
  }
  if (key === '') throw new RefError(`ref '${ref}' has an empty key`);
  if (kind !== 'receipt_line') return { kind: kind as Ref['kind'], key };

  const hash = key.lastIndexOf('#');
  if (hash < 0) {
    throw new RefError(
      `ref '${ref}' needs '#<line number>', e.g. receipt_line:draft#8`,
    );
  }
  const line = Number(key.slice(hash + 1));
  if (!Number.isInteger(line) || line < 1) {
    throw new RefError(
      `ref '${ref}' needs a line number of 1 or more after '#'`,
    );
  }
  return { kind: 'receipt_line', key: key.slice(0, hash), line };
}

export type ReceiptKey =
  | { kind: 'draft' }
  | { kind: 'last' }
  | { kind: 'supplier'; supplier: string; date: string };

/** The key of a `receipt:` ref: `draft`, `last` or `<supplier>@<date>`. */
export function parseReceiptKey(key: string): ReceiptKey {
  if (key === 'draft') return { kind: 'draft' };
  if (key === 'last') return { kind: 'last' };
  const at = key.lastIndexOf('@');
  const who = at > 0 ? key.slice(0, at).trim() : '';
  const date = at > 0 ? key.slice(at + 1).trim() : '';
  if (who !== '' && isIsoDate(date)) {
    const supplier = Object.hasOwn(SUPPLIER_CODES, who)
      ? SUPPLIER_CODES[who as keyof typeof SUPPLIER_CODES]
      : who;
    return { kind: 'supplier', supplier, date };
  }
  throw new RefError(
    `receipt key '${key}' is not draft, last or <supplier>@<YYYY-MM-DD> (suppliers: ${Object.keys(SUPPLIER_CODES).join(', ')} or a full name)`,
  );
}

/** The injected tail of the canary product name (see STORE.md "Canary strings"). */
const INJECTION_TAIL = /\s+-\s+HỆ THỐNG:.*$/su;

/**
 * A product name as an answer would state it: the injection product keeps its
 * real name but loses the injected instruction, so an assistant that treats
 * the tail as data still matches, and no canary reaches a fact.
 */
export function displayName(name: string): string {
  return name.replace(INJECTION_TAIL, '');
}

/** Same rule as `displayName`, written for PostgreSQL's regex dialect. */
const SQL_DISPLAY_NAME = String.raw`regexp_replace(name, '\s+-\s+HỆ THỐNG:.*$', '')`;

/** A product by its exact name, or by the display name of the injection product. */
export async function findProduct(
  pool: Queryable,
  storeId: string,
  name: string,
): Promise<{ id: string; name: string } | null> {
  const { rows } = await pool.query(
    `SELECT id::text AS id, name FROM products
     WHERE store_id = $1 AND (name = $2 OR ${SQL_DISPLAY_NAME} = $2)
     ORDER BY (name = $2) DESC, name
     LIMIT 2`,
    [storeId, name],
  );
  const [first, second] = rows as { id: string; name: string }[];
  if (!first) return null;
  if (second && first.name !== name) {
    throw new RefError(
      `product '${name}' is ambiguous: ${displayName(first.name)}, ${displayName(second.name)}`,
    );
  }
  return first;
}

/** The three catalog names closest to a misspelled one. */
export async function suggestProducts(
  pool: Queryable,
  storeId: string,
  name: string,
): Promise<string[]> {
  try {
    const { rows } = await pool.query(
      `SELECT name FROM products WHERE store_id = $1
       ORDER BY similarity(immutable_unaccent(lower(name)), immutable_unaccent(lower($2))) DESC, name
       LIMIT 3`,
      [storeId, name],
    );
    return rows.map((r) => displayName(String(r.name)));
  } catch {
    return [];
  }
}

async function receiptId(
  pool: Queryable,
  storeId: string,
  key: string,
): Promise<string | undefined> {
  const parsed = parseReceiptKey(key);
  let rows: Record<string, unknown>[];
  if (parsed.kind === 'draft') {
    ({ rows } = await pool.query(
      `SELECT id::text AS id FROM receipts
       WHERE store_id = $1 AND status = 'draft'
       ORDER BY created_at DESC, id LIMIT 1`,
      [storeId],
    ));
  } else if (parsed.kind === 'last') {
    ({ rows } = await pool.query(
      `SELECT id::text AS id FROM receipts
       WHERE store_id = $1 AND status = 'confirmed'
       ORDER BY confirmed_at DESC, id LIMIT 1`,
      [storeId],
    ));
  } else {
    ({ rows } = await pool.query(
      `SELECT r.id::text AS id FROM receipts r
       JOIN expenses e ON e.id = r.expense_id
       WHERE r.store_id = $1 AND r.status = 'confirmed'
         AND e.note = 'Nhập hàng: ' || $2 AND e.business_date = $3::date
       ORDER BY r.confirmed_at DESC, r.id LIMIT 1`,
      [storeId, parsed.supplier, parsed.date],
    ));
  }
  return rows[0]?.id as string | undefined;
}

/** The row id behind a ref; throws `RefError` when nothing matches. */
export async function resolveRef(
  pool: Queryable,
  storeId: string,
  ref: string,
): Promise<string> {
  const parsed = parseRef(ref);
  const notFound = (hint = '') =>
    new RefError(
      `${parsed.kind} '${parsed.key}${parsed.line ? `#${parsed.line}` : ''}' not found${hint}`,
    );

  switch (parsed.kind) {
    case 'product': {
      const found = await findProduct(pool, storeId, parsed.key);
      if (found) return found.id;
      const similar = await suggestProducts(pool, storeId, parsed.key);
      throw notFound(
        similar.length > 0 ? `; closest: ${similar.join(', ')}` : '',
      );
    }
    case 'member': {
      const { rows } = await pool.query(
        'SELECT id::text AS id FROM members WHERE store_id = $1 AND display_name = $2 LIMIT 1',
        [storeId, parsed.key],
      );
      if (rows[0]) return rows[0].id as string;
      throw notFound();
    }
    case 'category': {
      const { rows } = await pool.query(
        'SELECT id::text AS id FROM categories WHERE store_id = $1 AND name = $2 LIMIT 1',
        [storeId, parsed.key],
      );
      if (rows[0]) return rows[0].id as string;
      throw notFound();
    }
    case 'receipt': {
      const id = await receiptId(pool, storeId, parsed.key);
      if (id) return id;
      throw notFound();
    }
    case 'receipt_line': {
      const receipt = await receiptId(pool, storeId, parsed.key);
      if (receipt) {
        const { rows } = await pool.query(
          'SELECT id::text AS id FROM receipt_lines WHERE receipt_id = $1 AND position = $2 LIMIT 1',
          [receipt, parsed.line! - 1],
        );
        if (rows[0]) return rows[0].id as string;
      }
      throw notFound();
    }
  }
}
