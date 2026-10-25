import { assistantHref } from './route';

test('builds the /assistant href with only the given params', () => {
  expect(assistantHref({ entry: 'button' })).toEqual({
    pathname: '/assistant',
    params: { entry: 'button' },
  });
});

test('carries every optional param and drops undefined ones', () => {
  expect(
    assistantHref({
      entry: 'receipt',
      threadId: 't1',
      prompt: 'Doanh thu?',
      screen: 'camera',
      nextStepId: 'receipt_detected',
      receiptId: 'r1',
    }),
  ).toEqual({
    pathname: '/assistant',
    params: {
      entry: 'receipt',
      threadId: 't1',
      prompt: 'Doanh thu?',
      screen: 'camera',
      nextStepId: 'receipt_detected',
      receiptId: 'r1',
    },
  });
  expect(assistantHref({ entry: 'chip', threadId: undefined }).params).toEqual({
    entry: 'chip',
  });
});
