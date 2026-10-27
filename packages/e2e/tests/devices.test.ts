import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assertErrorResponse, createStore, newClient } from '../src/helpers.js';

function fields(value: unknown, shape: Record<string, string>) {
  expect(value).toBeTypeOf('object');
  expect(value).not.toBeNull();
  const object = value as Record<string, unknown>;
  expect(Object.keys(object).sort()).toEqual(Object.keys(shape).sort());
  for (const [key, type] of Object.entries(shape)) {
    if (type.endsWith('?') && object[key] === null) continue;
    const base = type.replace(/\?$/, '');
    if (base === 'date') {
      expect(object[key]).toBeTypeOf('string');
      expect(Number.isNaN(Date.parse(object[key] as string))).toBe(false);
    } else if (base === 'integer') {
      expect(Number.isInteger(object[key])).toBe(true);
    } else if (base === 'array') {
      expect(Array.isArray(object[key])).toBe(true);
    } else {
      expect(typeof object[key]).toBe(base);
      if (base === 'object') expect(object[key]).not.toBeNull();
    }
  }
}

describe('devices against the deployed backend', () => {
  it('registers, updates, and deletes an Expo push token idempotently', async () => {
    const { client } = await createStore();
    const token = `ExponentPushToken[e2e-${randomUUID()}]`;

    // 1. Register device
    const registerRes = await client.raw.POST('/v1/devices', {
      body: {
        token,
        platform: 'android',
        app_version: '1.0.0',
        language: 'vi',
      },
    });

    expect(registerRes.response.status).toBe(200);
    expect(registerRes.data).toBeDefined();
    fields(registerRes.data, {
      token: 'string',
      platform: 'string',
      app_version: 'string',
      language: 'string',
      created_at: 'date',
      updated_at: 'date',
    });
    expect(registerRes.data!.token).toBe(token);
    expect(registerRes.data!.platform).toBe('android');
    expect(registerRes.data!.app_version).toBe('1.0.0');
    expect(registerRes.data!.language).toBe('vi');

    // 2. Re-register same token with updated app_version and language
    const updateRes = await client.raw.POST('/v1/devices', {
      body: {
        token,
        platform: 'android',
        app_version: '1.0.1',
        language: 'en',
      },
    });

    expect(updateRes.response.status).toBe(200);
    expect(updateRes.data).toBeDefined();
    fields(updateRes.data, {
      token: 'string',
      platform: 'string',
      app_version: 'string',
      language: 'string',
      created_at: 'date',
      updated_at: 'date',
    });
    expect(updateRes.data!.token).toBe(token);
    expect(updateRes.data!.platform).toBe('android');
    expect(updateRes.data!.app_version).toBe('1.0.1');
    expect(updateRes.data!.language).toBe('en');
    expect(updateRes.data!.created_at).toBe(registerRes.data!.created_at);
    expect(Date.parse(updateRes.data!.updated_at)).toBeGreaterThanOrEqual(
      Date.parse(registerRes.data!.updated_at),
    );

    // 3. DELETE /v1/devices/{token} (pass token in params.path) -> 204
    const deleteRes1 = await client.raw.DELETE('/v1/devices/{token}', {
      params: { path: { token } },
    });
    expect(deleteRes1.response.status).toBe(204);

    // 4. DELETE again -> 204
    const deleteRes2 = await client.raw.DELETE('/v1/devices/{token}', {
      params: { path: { token } },
    });
    expect(deleteRes2.response.status).toBe(204);
  });

  it('rejects unsupported platform with 400 validation error', async () => {
    const { client } = await createStore();
    const token = `ExponentPushToken[e2e-${randomUUID()}]`;

    const invalidRes = await client.raw.POST('/v1/devices', {
      body: {
        token,
        // @ts-expect-error platform 'web' is not supported by OpenAPI schema
        platform: 'web',
        app_version: '1.0.0',
        language: 'vi',
      },
    });

    expect(invalidRes.response.status).toBe(400);
    assertErrorResponse(invalidRes.error, 'validation_failed');
  });

  it('rejects unauthenticated device registration with 401', async () => {
    const unauthClient = newClient();
    const token = `ExponentPushToken[e2e-${randomUUID()}]`;

    const unauthRes = await unauthClient.raw.POST('/v1/devices', {
      body: {
        token,
        platform: 'android',
        app_version: '1.0.0',
        language: 'vi',
      },
    });

    expect(unauthRes.response.status).toBe(401);
    assertErrorResponse(unauthRes.error, 'unauthorized');
  });
});
