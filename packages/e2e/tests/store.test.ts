import { describe, expect, it } from 'vitest';
import {
  assertErrorResponse,
  assertStore,
  createStore,
  joinAsSeller,
  uniqueName,
} from '../src/helpers.js';

describe('Store Management Contract Specs (E1)', () => {
  it('GET /v1/store returns current store configuration with 200', async () => {
    const { client, storeName } = await createStore();

    const { data, error, response } = await client.raw.GET('/v1/store');

    expect(response.status).toBe(200);
    expect(error).toBeUndefined();
    expect(data).toBeDefined();

    assertStore(data!);
    expect(data!.name).toBe(storeName);
    expect(data!.timezone).toBe('Asia/Ho_Chi_Minh');
    expect(typeof data!.margin_threshold_pct).toBe('number');
    expect(data!.version).toBeGreaterThanOrEqual(1);
  });

  it('PATCH /v1/store updates store profile (merge-patch+json) and increments version', async () => {
    const { client } = await createStore();

    // Fetch initial version
    const initial = await client.raw.GET('/v1/store');
    const initialVersion = initial.data!.version;

    const newName = 'Tiem Tap Hoa ' + uniqueName('updated');
    const bankAccount = {
      bank_bin: '970436',
      bank_short_name: 'Vietcombank',
      account_number: '0123456789',
      account_name: 'NGUYEN THI BA',
    };

    // Lead updates store name, bank account, margin threshold, and sales memo prefix
    const patchRes = await client.raw.PATCH('/v1/store', {
      headers: {
        'content-type': 'application/merge-patch+json',
      },
      body: {
        name: newName,
        bank_account: bankAccount,
        margin_threshold_pct: 12.5,
        sales_memo_prefix: 'THBA',
      },
    });

    expect(patchRes.response.status).toBe(200);
    expect(patchRes.data).toBeDefined();
    assertStore(patchRes.data!);

    expect(patchRes.data!.name).toBe(newName);
    expect(patchRes.data!.margin_threshold_pct).toBe(12.5);
    expect(patchRes.data!.sales_memo_prefix).toBe('THBA');
    expect(patchRes.data!.bank_account).toEqual(bankAccount);
    expect(patchRes.data!.version).toBeGreaterThan(initialVersion);

    // Null clearing: clear bank account with null
    const clearRes = await client.raw.PATCH('/v1/store', {
      headers: {
        'content-type': 'application/merge-patch+json',
      },
      body: {
        bank_account: null,
      },
    });

    expect(clearRes.response.status).toBe(200);
    expect(clearRes.data!.bank_account).toBeNull();
    expect(clearRes.data!.version).toBeGreaterThan(patchRes.data!.version);
  });

  it('PATCH /v1/store returns 400 when bank_bin is invalid', async () => {
    const { client } = await createStore();

    // bank_bin must be exactly 6 digits; "123" is invalid
    const patchRes = await client.raw.PATCH('/v1/store', {
      headers: {
        'content-type': 'application/merge-patch+json',
      },
      body: {
        bank_account: {
          bank_bin: '123',
          bank_short_name: 'Invalid',
          account_number: '0123456789',
          account_name: 'NGUYEN THI BA',
        },
      },
    });

    expect(patchRes.response.status).toBe(400);
    assertErrorResponse(patchRes.error);
  });

  it('PATCH /v1/store returns 403 Forbidden when called by a Seller', async () => {
    const { client: leadClient } = await createStore();
    const { client: sellerClient } = await joinAsSeller(leadClient);

    const patchRes = await sellerClient.raw.PATCH('/v1/store', {
      headers: {
        'content-type': 'application/merge-patch+json',
      },
      body: {
        name: 'Hacked Name By Seller',
      },
    });

    expect(patchRes.response.status).toBe(403);
    assertErrorResponse(patchRes.error);
  });
});
