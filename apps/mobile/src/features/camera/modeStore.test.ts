import AsyncStorage from '@react-native-async-storage/async-storage';
import { migrateMode, selectMode, useCaptureModeStore } from './modeStore';

describe('capture modes', () => {
  afterEach(() => useCaptureModeStore.setState({ mode: 'object' }));
  it('defaults to object and switches to code', () => {
    expect(selectMode(useCaptureModeStore.getState())).toBe('object');
    useCaptureModeStore.getState().setMode('code');
    expect(selectMode(useCaptureModeStore.getState())).toBe('code');
  });
  it.each(['one', 'many'])(
    'migrates stored legacy %s to object',
    async (mode) => {
      await AsyncStorage.setItem(
        'taphoa-camera-mode',
        JSON.stringify({ state: { mode }, version: 0 }),
      );
      await useCaptureModeStore.persist.rehydrate();
      expect(useCaptureModeStore.getState().mode).toBe('object');
      expect(migrateMode(mode)).toBe('object');
    },
  );
});
