import { Pool } from 'pg';
import { DEFAULT_TODAY } from '../runner/client.ts';
import { isIsoDate } from './dates.ts';
import { memoizeOracle, type OracleProvider } from './provider.ts';
import { resolveRef } from './refs.ts';
import { runOracle } from './run.ts';

/** The store id of `taphoa-seed --profile eval`. */
export const DEFAULT_STORE_ID = 'e7a10e7a-0000-4000-8000-000000000000';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The oracle database is not set up: a configuration problem, not a failed run. */
export class OracleUnavailableError extends Error {
  constructor(
    message = 'live runs need EVAL_DATABASE_URL, the database the oracle SQL reads ' +
      '(seed it with: taphoa-seed --profile eval). Use --stub for a dry run.',
  ) {
    super(message);
    this.name = 'OracleUnavailableError';
  }
}

/** An open connection pool to the eval store, with the store and date it serves. */
export type EvalDatabase = {
  pool: Pool;
  storeId: string;
  today: string;
  close(): Promise<void>;
};

/** Host, port and database of a connection string, without its credentials. */
function describeUrl(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    return `${url.hostname}${url.port ? `:${url.port}` : ''}${url.pathname}`;
  } catch {
    return 'the given URL';
  }
}

/**
 * Connects to `EVAL_DATABASE_URL` and checks that the eval store is there.
 * `EVAL_STORE_ID` defaults to the seed's store, `EVAL_TODAY` to 2026-10-20.
 * Nothing in an error message carries the URL's credentials.
 */
export async function openEvalDatabase(
  env: Record<string, string | undefined>,
): Promise<EvalDatabase> {
  const connectionString = env.EVAL_DATABASE_URL?.trim();
  if (!connectionString) throw new OracleUnavailableError();
  const storeId = env.EVAL_STORE_ID?.trim() || DEFAULT_STORE_ID;
  if (!UUID.test(storeId)) {
    throw new OracleUnavailableError(
      `EVAL_STORE_ID must be a uuid, got ${JSON.stringify(storeId)}`,
    );
  }
  const today = env.EVAL_TODAY?.trim() || DEFAULT_TODAY;
  if (!isIsoDate(today)) {
    throw new OracleUnavailableError(
      `EVAL_TODAY must look like YYYY-MM-DD, got ${JSON.stringify(today)}`,
    );
  }

  const pool = new Pool({
    connectionString,
    max: 4,
    connectionTimeoutMillis: 5000,
  });
  // An idle client that drops must not crash the run.
  pool.on('error', () => {});
  const where = describeUrl(connectionString);
  try {
    const { rows } = await pool.query(
      'SELECT 1 AS present FROM stores WHERE id = $1',
      [storeId],
    );
    if (rows.length === 0) {
      throw new OracleUnavailableError(
        `store ${storeId} is not in the database at ${where}; seed it with: taphoa-seed --profile eval`,
      );
    }
  } catch (e) {
    await pool.end().catch(() => {});
    if (e instanceof OracleUnavailableError) throw e;
    const reason = (e as Error).message || (e as Error).name;
    throw new OracleUnavailableError(
      `cannot read the eval store at ${where} (EVAL_DATABASE_URL): ${reason}`,
    );
  }
  return { pool, storeId, today, close: () => pool.end() };
}

/** The oracle provider of live runs; `close` ends its connection pool. */
export type LiveOracle = OracleProvider & { close(): Promise<void> };

/**
 * The pg-backed oracle provider: runs the catalog's SQL against
 * `EVAL_DATABASE_URL`, for the store `EVAL_STORE_ID` and the business date
 * `EVAL_TODAY`. Answers are remembered for the run, so a question asked twice
 * reaches the database once. The CLI calls it through `CliDeps.createOracle`,
 * which tests can override.
 */
export async function createLiveOracle(
  env: Record<string, string | undefined>,
): Promise<LiveOracle> {
  const db = await openEvalDatabase(env);
  const provider = memoizeOracle({
    value: (query) =>
      runOracle(db.pool, query.oracle, {
        storeId: db.storeId,
        today: db.today,
        args: query.args,
      }),
    resolveRef: (ref) => resolveRef(db.pool, db.storeId, ref),
  });
  return {
    value: (query) => provider.value(query),
    resolveRef: (ref) => provider.resolveRef(ref),
    toolEvidence: async (threadId) => {
      const { rows } = await db.pool.query<{
        transcript: { role: string; content?: string }[];
      }>(
        "SELECT transcript FROM assistant_messages WHERE store_id=$1 AND thread_id=$2 AND role='assistant' AND status='complete' ORDER BY created_at DESC,id DESC LIMIT 1",
        [db.storeId, threadId],
      );
      if (rows.length !== 1)
        throw new Error('eval turn evidence is unavailable');
      return rows[0]!.transcript
        .filter((message) => message.role === 'tool')
        .map((message) => JSON.parse(message.content ?? '{}'));
    },
    close: db.close,
  };
}
