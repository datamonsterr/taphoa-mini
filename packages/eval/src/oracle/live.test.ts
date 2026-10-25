import { describe, expect, it } from 'vitest';
import {
  createLiveOracle,
  DEFAULT_STORE_ID,
  openEvalDatabase,
  OracleUnavailableError,
} from './live.ts';

describe('openEvalDatabase configuration', () => {
  it('names EVAL_DATABASE_URL when it is not set', async () => {
    for (const env of [
      {},
      { EVAL_DATABASE_URL: '' },
      { EVAL_DATABASE_URL: ' ' },
    ]) {
      await expect(openEvalDatabase(env)).rejects.toThrow(
        OracleUnavailableError,
      );
      await expect(openEvalDatabase(env)).rejects.toThrow(/EVAL_DATABASE_URL/);
    }
  });

  it('rejects a store id that is not a uuid, before connecting', async () => {
    await expect(
      openEvalDatabase({
        EVAL_DATABASE_URL: 'postgres://user:pw-secret@127.0.0.1:1/db',
        EVAL_STORE_ID: 'store-9',
      }),
    ).rejects.toThrow(/EVAL_STORE_ID must be a uuid/);
  });

  it('rejects a bad EVAL_TODAY, before connecting', async () => {
    await expect(
      openEvalDatabase({
        EVAL_DATABASE_URL: 'postgres://user:pw-secret@127.0.0.1:1/db',
        EVAL_TODAY: '20/10/2026',
      }),
    ).rejects.toThrow(/EVAL_TODAY must look like YYYY-MM-DD/);
  });

  it('says where it could not connect, without the password', async () => {
    const attempt = openEvalDatabase({
      EVAL_DATABASE_URL: 'postgres://user:pw-secret@127.0.0.1:1/eval',
    });
    await expect(attempt).rejects.toThrow(OracleUnavailableError);
    await expect(attempt).rejects.toThrow(/127\.0\.0\.1:1\/eval/);
    await expect(attempt).rejects.not.toThrow(/pw-secret/);
  });

  it('defaults to the store the seed creates', () => {
    expect(DEFAULT_STORE_ID).toBe('e7a10e7a-0000-4000-8000-000000000000');
  });
});

describe('createLiveOracle', () => {
  it('fails with the same configuration errors', async () => {
    await expect(createLiveOracle({})).rejects.toThrow(/EVAL_DATABASE_URL/);
  });
});
