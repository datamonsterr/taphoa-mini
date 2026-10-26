import { getApiClient } from './client';
import { unwrap } from './errors';
import type { Device, RegisterDevice } from './types';

export const registerDevice = (body: RegisterDevice): Promise<Device> =>
  unwrap(getApiClient().raw.POST('/v1/devices', { body }));

export const unregisterDevice = (token: string): Promise<void> =>
  unwrap(
    getApiClient().raw.DELETE('/v1/devices/{token}', {
      params: { path: { token } },
    }),
  );
