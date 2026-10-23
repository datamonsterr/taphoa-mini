import { selectMode, useCaptureModeStore } from './modeStore';

describe('useCaptureModeStore', () => {
  afterEach(() => useCaptureModeStore.setState({ mode: 'one' }));

  it('starts in one-item mode and switches', () => {
    expect(selectMode(useCaptureModeStore.getState())).toBe('one');
    useCaptureModeStore.getState().setMode('many');
    expect(selectMode(useCaptureModeStore.getState())).toBe('many');
  });
});
