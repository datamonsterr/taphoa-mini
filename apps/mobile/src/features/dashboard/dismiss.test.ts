import { router } from 'expo-router';

import { dismissSheet } from './dismiss';

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), replace: jest.fn(), canGoBack: jest.fn() },
}));

beforeEach(() => jest.clearAllMocks());

test('goes back when there is history', () => {
  jest.mocked(router.canGoBack).mockReturnValue(true);
  dismissSheet();
  expect(router.back).toHaveBeenCalled();
  expect(router.replace).not.toHaveBeenCalled();
});

test('replaces with the dashboard when opened directly', () => {
  jest.mocked(router.canGoBack).mockReturnValue(false);
  dismissSheet();
  expect(router.replace).toHaveBeenCalledWith('/dashboard');
});
