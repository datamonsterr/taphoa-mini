import { renderHook } from '@testing-library/react-native';

import { useAssistantEnabled } from './flags';

test('assistant is enabled until a remote flag overrides it', async () => {
  const { result } = await renderHook(() => useAssistantEnabled());
  expect(result.current).toBe(true);
});
