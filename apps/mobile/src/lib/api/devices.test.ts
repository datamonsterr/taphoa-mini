import { createMockFetch } from '@/test/mock/fetch';
import { setApiTransport } from './client';
import { registerDevice, unregisterDevice } from './devices';
import type { RegisterDevice } from './types';

describe('devices API', () => {
  test('registerDevice sends POST /v1/devices and returns Device', async () => {
    const transport = createMockFetch();
    const requests: Request[] = [];
    setApiTransport((async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      requests.push(req.clone());
      return transport(req);
    }) as typeof fetch);

    const input: RegisterDevice = {
      token: 'ExponentPushToken[mock-device-token]',
      platform: 'android',
      app_version: '1.0.0',
      language: 'vi',
    };

    const device = await registerDevice(input);
    expect(device).toMatchObject({
      token: input.token,
      platform: 'android',
      app_version: '1.0.0',
      language: 'vi',
    });
    expect(device.created_at).toBeDefined();
    expect(device.updated_at).toBeDefined();

    const postReq = requests.find((r) => r.method === 'POST');
    expect(postReq).toBeDefined();
    expect(new URL(postReq!.url).pathname).toBe('/v1/devices');
    const body = await postReq!.json();
    expect(body).toEqual(input);
  });

  test('unregisterDevice sends DELETE /v1/devices/{token}', async () => {
    const transport = createMockFetch();
    const requests: Request[] = [];
    setApiTransport((async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      requests.push(req.clone());
      return transport(req);
    }) as typeof fetch);

    const token = 'ExponentPushToken[mock-device-token]';
    await unregisterDevice(token);

    const deleteReq = requests.find((r) => r.method === 'DELETE');
    expect(deleteReq).toBeDefined();
    expect(new URL(deleteReq!.url).pathname).toBe(
      `/v1/devices/${encodeURIComponent(token)}`,
    );
  });
});
