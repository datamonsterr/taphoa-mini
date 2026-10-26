import {
  clerkToken,
  currentStoreId,
  membershipRequired,
  registerAuthBridge,
  bridgeUserId,
  subscribeAuthBridge,
  serverBridgeUserId,
} from './clerkBridge';

test('provider cleanup removes its bridge and not a newer user registration', async () => {
  const listener = jest.fn();
  const unsubscribe = subscribeAuthBridge(listener);
  const removeOld = registerAuthBridge({
    userId: 'old',
    getToken: async () => 'old-token',
    getStoreId: () => 'old-store',
    membershipRequired: jest.fn(),
  });
  const invalidate = jest.fn();
  const removeCurrent = registerAuthBridge({
    userId: 'current',
    getToken: async () => 'new-token',
    getStoreId: () => 'new-store',
    membershipRequired: invalidate,
  });
  removeOld();
  expect(bridgeUserId()).toBe('current');
  expect(await clerkToken()).toBe('new-token');
  expect(currentStoreId()).toBe('new-store');
  membershipRequired();
  expect(invalidate).toHaveBeenCalledTimes(1);
  removeCurrent();
  expect(bridgeUserId()).toBeUndefined();
  expect(await clerkToken()).toBeNull();
  expect(currentStoreId()).toBeNull();
  expect(membershipRequired()).toBeUndefined();
  expect(serverBridgeUserId()).toBeUndefined();
  expect(listener).toHaveBeenCalledTimes(3);
  unsubscribe();
});
