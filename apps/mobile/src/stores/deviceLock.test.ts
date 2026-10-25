import AsyncStorage from '@react-native-async-storage/async-storage';

import { useDeviceLock } from './deviceLock';

const KEY = 'taphoa-device-lock';

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.mocked(AsyncStorage.setItem).mockClear();
});

test('starts unlocked, and lock / unlock flip it', () => {
  expect(useDeviceLock.getState().locked).toBe(false);
  useDeviceLock.getState().lock();
  expect(useDeviceLock.getState().locked).toBe(true);
  useDeviceLock.getState().unlock();
  expect(useDeviceLock.getState().locked).toBe(false);
});

test('persists only the lock, under taphoa-device-lock', async () => {
  useDeviceLock.getState().lock();
  await Promise.resolve();
  expect(AsyncStorage.setItem).toHaveBeenCalledWith(
    KEY,
    JSON.stringify({ state: { locked: true }, version: 0 }),
  );
  useDeviceLock.getState().unlock();
  await Promise.resolve();
  expect(AsyncStorage.setItem).toHaveBeenLastCalledWith(
    KEY,
    JSON.stringify({ state: { locked: false }, version: 0 }),
  );
});

test('a restart restores the lock', async () => {
  // The state change writes to storage too, so it goes first.
  useDeviceLock.setState({ locked: false, hydrated: false });
  await AsyncStorage.setItem(
    KEY,
    JSON.stringify({ state: { locked: true }, version: 0 }),
  );
  await useDeviceLock.persist.rehydrate();
  expect(useDeviceLock.getState()).toMatchObject({
    locked: true,
    hydrated: true,
  });
});

test.each([
  ['a string', 'true'],
  ['a number', 1],
  ['null', null],
  ['an object', {}],
])('%s in storage is not a lock', async (_name, locked) => {
  useDeviceLock.setState({ locked: true, hydrated: false });
  await AsyncStorage.setItem(
    KEY,
    JSON.stringify({ state: { locked }, version: 0 }),
  );
  await useDeviceLock.persist.rehydrate();
  expect(useDeviceLock.getState()).toMatchObject({
    locked: false,
    hydrated: true,
  });
});

test('unavailable storage still locks for this run', async () => {
  jest.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('blocked'));
  expect(() => useDeviceLock.getState().lock()).not.toThrow();
  await Promise.resolve();
  expect(useDeviceLock.getState().locked).toBe(true);
});

test('failed reads and malformed text still finish hydration, unlocked', async () => {
  jest.mocked(AsyncStorage.getItem).mockRejectedValueOnce(new Error('blocked'));
  useDeviceLock.setState({ locked: true, hydrated: false });
  await useDeviceLock.persist.rehydrate();
  expect(useDeviceLock.getState()).toMatchObject({
    locked: false,
    hydrated: true,
  });
  // Unparsable text is dropped; a fresh start has nothing locked in memory either.
  useDeviceLock.setState({ locked: false, hydrated: false });
  await AsyncStorage.setItem(KEY, 'broken');
  await useDeviceLock.persist.rehydrate();
  expect(useDeviceLock.getState()).toMatchObject({
    locked: false,
    hydrated: true,
  });
});
