import type { OracleProvider } from './provider.ts';

/** A live run needs an oracle provider and this build has none. */
export class OracleUnavailableError extends Error {
  constructor() {
    super(
      'live runs need the oracle provider that reads EVAL_DATABASE_URL (task T3 adds it); ' +
        'it is not part of this build yet. Use --stub for a dry run.',
    );
    this.name = 'OracleUnavailableError';
  }
}

/**
 * The oracle provider of live runs: task T3 replaces this body with the
 * pg-backed provider built from `env.EVAL_DATABASE_URL`. The CLI calls it
 * through `CliDeps.createOracle`, which tests can override.
 */
export async function createLiveOracle(
  _env: Record<string, string | undefined>,
): Promise<OracleProvider> {
  throw new OracleUnavailableError();
}
