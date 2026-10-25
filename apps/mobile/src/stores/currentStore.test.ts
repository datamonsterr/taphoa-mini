import AsyncStorage from '@react-native-async-storage/async-storage';
import { resolveMembership, useCurrentStore } from './currentStore';
import { testSession } from '@/test/session';

test('falls back to the first membership when the remembered store was removed', () => {
  const { store, member } = testSession();
  expect(resolveMembership([{ store, member }], 'removed-store')).toEqual({
    store,
    member,
  });
  expect(resolveMembership([], store.id)).toBeNull();
});

test('remembers each Clerk user independently and persists only store ids', async () => {
  useCurrentStore.getState().selectStore('user_a', 'store_a');
  useCurrentStore.getState().selectStore('user_b', 'store_b');
  expect(useCurrentStore.getState().storeIds).toEqual({
    user_a: 'store_a',
    user_b: 'store_b',
  });
  await Promise.resolve();
  expect(AsyncStorage.setItem).toHaveBeenCalledWith(
    'taphoa-current-store',
    expect.stringContaining('store_a'),
  );
});

test('a malformed stored preference cannot replace the store id map', async () => {
  await AsyncStorage.setItem(
    'taphoa-current-store',
    JSON.stringify({ state: { storeIds: null }, version: 0 }),
  );
  await useCurrentStore.persist.rehydrate();
  expect(useCurrentStore.getState().storeIds).toEqual({});
});

test('unavailable preference storage still selects the store for this run', async () => {
  jest.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('blocked'));
  await expect(
    Promise.resolve(
      useCurrentStore.getState().selectStore('user_test', 'new-store'),
    ),
  ).resolves.toBeUndefined();
  expect(useCurrentStore.getState().storeIds.user_test).toBe('new-store');
});

test('failed reads and malformed JSON still complete preference hydration', async () => {
  jest.mocked(AsyncStorage.getItem).mockRejectedValueOnce(new Error('blocked'));
  useCurrentStore.setState({ hydrated: false });
  await useCurrentStore.persist.rehydrate();
  expect(useCurrentStore.getState().hydrated).toBe(true);
  useCurrentStore.setState({ hydrated: false });
  await AsyncStorage.setItem('taphoa-current-store', '{broken-json');
  await useCurrentStore.persist.rehydrate();
  expect(useCurrentStore.getState().hydrated).toBe(true);
});
