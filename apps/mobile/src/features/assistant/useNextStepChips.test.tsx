import { act, renderHook } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';

import type { NextStepChipData } from '@/components/assistant/chip';
import { setAnalyticsSink } from '@/lib/analytics';
import { useSettingsStore } from '@/stores/settings';
import { createTestQueryClient } from '@/test/render';

import { useNextSteps } from './api';
import { useNextStepChips } from './useNextStepChips';

const mockFocus = {
  focused: true,
  listeners: new Set<(focused: boolean) => void>(),
};
jest.mock('expo-router', () => ({
  useIsFocused: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories must require lazily
    const React = require('react');
    const [focused, setFocused] = React.useState(mockFocus.focused);
    React.useEffect(() => {
      mockFocus.listeners.add(setFocused);
      return () => mockFocus.listeners.delete(setFocused);
    }, []);
    return focused;
  },
}));
jest.mock('./api', () => ({ useNextSteps: jest.fn() }));

const setFocused = (focused: boolean) =>
  act(async () => {
    mockFocus.focused = focused;
    mockFocus.listeners.forEach((listener) => listener(focused));
  });

type Item = {
  id: string;
  kind: string;
  title_vi: string;
  subtitle_vi: string | null;
  priority: number;
  action: unknown;
};
const restock: Item = {
  id: 'restock',
  kind: 'restock',
  title_vi: 'Cần nhập hàng',
  subtitle_vi: '3 mặt hàng sắp hết',
  priority: 1,
  action: {
    type: 'chat',
    prompt_vi: 'Lên danh sách nhập hàng',
    context: { screen: 'camera', next_step_id: 'restock' },
  },
};
const drafts: Item = {
  id: 'draft_receipts',
  kind: 'draft_receipts',
  title_vi: 'Hóa đơn nháp',
  subtitle_vi: null,
  priority: 2,
  action: { type: 'navigate', route: '/receipts' },
};
const serverReceipt: Item = {
  id: 'srv-receipt',
  kind: 'receipt_detected',
  title_vi: 'Hóa đơn (server)',
  subtitle_vi: null,
  priority: 0,
  action: { type: 'navigate', route: '/receipts' },
};

const events: [string, unknown][] = [];
const mockSteps = (items: Item[]) =>
  jest
    .mocked(useNextSteps)
    .mockReturnValue({ data: { items } } as unknown as ReturnType<
      typeof useNextSteps
    >);

type Options = Parameters<typeof useNextStepChips>[0];
const base: Options = {
  screen: 'camera',
  documentDetected: false,
  unknownProduct: false,
  canEnroll: true,
  enabled: true,
};
const render = (options: Partial<Options> = {}) => {
  const queryClient = createTestQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(
    (props: Partial<Options>) => useNextStepChips({ ...base, ...props }),
    {
      initialProps: options,
      wrapper,
    },
  );
};
const shown = () => events.filter(([name]) => name === 'next_step_shown');

beforeEach(() => {
  events.length = 0;
  mockFocus.focused = true;
  setAnalyticsSink({ capture: (name, props) => events.push([name, props]) });
  useSettingsStore.setState({ language: 'vi' });
  mockSteps([restock, drafts]);
  jest.mocked(useNextSteps).mockClear();
});
afterEach(() => setAnalyticsSink(null));

const kinds = (chips: NextStepChipData[]) => chips.map((c) => c.kind);

test('server chips alone, in server order, with Vietnamese text and their actions', async () => {
  const { result } = await render();
  expect(kinds(result.current.chips)).toEqual(['restock', 'draft_receipts']);
  expect(result.current.chips[0]).toEqual({
    id: 'restock',
    kind: 'restock',
    title: 'Cần nhập hàng',
    subtitle: '3 mặt hàng sắp hết',
    source: 'server',
    action: restock.action,
  });
  expect(result.current.chips[1]!.subtitle).toBeUndefined();
});

test('on-device chips come first: receipt, then unknown product', async () => {
  const { result } = await render({
    documentDetected: true,
    unknownProduct: true,
  });
  expect(kinds(result.current.chips)).toEqual([
    'receipt_detected',
    'unknown_product',
    'restock',
    'draft_receipts',
  ]);
  expect(result.current.chips[0]).toMatchObject({
    source: 'device',
    title: 'Hóa đơn nhập hàng',
    subtitle: 'Trợ lý đọc từng dòng',
    action: { type: 'receipt' },
  });
  expect(result.current.chips[1]).toMatchObject({
    source: 'device',
    title: 'Hàng chưa có trong kho',
    action: { type: 'enroll' },
  });
});

test('on-device chips need the member to be able to enroll', async () => {
  const { result } = await render({
    documentDetected: true,
    unknownProduct: true,
    canEnroll: false,
  });
  expect(kinds(result.current.chips)).toEqual(['restock', 'draft_receipts']);
});

test('only the signals that are on produce a chip', async () => {
  const { result } = await render({ unknownProduct: true });
  expect(kinds(result.current.chips).slice(0, 2)).toEqual([
    'unknown_product',
    'restock',
  ]);
});

test('server chips of a kind already shown are skipped', async () => {
  mockSteps([serverReceipt, restock]);
  const { result } = await render({ documentDetected: true });
  expect(kinds(result.current.chips)).toEqual(['receipt_detected', 'restock']);
});

test('English shows a title per kind and drops the Vietnamese subtitle', async () => {
  useSettingsStore.setState({ language: 'en' });
  const { result } = await render({ documentDetected: true });
  expect(result.current.chips.map((c) => c.title)).toEqual([
    'Supplier receipt',
    'Restock',
    'Draft receipts',
  ]);
  expect(result.current.chips[0]!.subtitle).toBe(
    'The assistant reads each line',
  );
  expect(result.current.chips[1]!.subtitle).toBeUndefined();
});

test('an English chip of an unknown kind falls back to the server title', async () => {
  useSettingsStore.setState({ language: 'en' });
  mockSteps([{ ...restock, kind: 'digest_v2', title_vi: 'Bản tin mới' }]);
  const { result } = await render();
  expect(result.current.chips[0]!.title).toBe('Bản tin mới');
});

test('asks the server only while focused and enabled, with the scan signals', async () => {
  await render({ documentDetected: true, unknownProduct: false });
  expect(useNextSteps).toHaveBeenLastCalledWith(
    { screen: 'camera', documentDetected: true, unknownProduct: false },
    { enabled: true },
  );
  mockFocus.focused = false;
  await render({ enabled: true });
  expect(useNextSteps).toHaveBeenLastCalledWith(expect.anything(), {
    enabled: false,
  });
  mockFocus.focused = true;
  await render({ enabled: false });
  expect(useNextSteps).toHaveBeenLastCalledWith(expect.anything(), {
    enabled: false,
  });
});

test('shows nothing and records nothing while the assistant is off', async () => {
  const { result } = await render({ enabled: false, documentDetected: true });
  expect(result.current.chips).toEqual([]);
  expect(events).toEqual([]);
});

test('captures next_step_shown once per chip with its position', async () => {
  const { rerender } = await render({ documentDetected: true });
  expect(shown()).toEqual([
    ['next_step_shown', { kind: 'receipt_detected', position: 0 }],
    ['next_step_shown', { kind: 'restock', position: 1 }],
    ['next_step_shown', { kind: 'draft_receipts', position: 2 }],
  ]);
  await rerender({ documentDetected: true });
  expect(shown()).toHaveLength(3);
});

test('a chip that appears later is captured alone', async () => {
  const { rerender } = await render();
  expect(shown()).toHaveLength(2);
  await rerender({ unknownProduct: true });
  expect(shown().slice(2)).toEqual([
    ['next_step_shown', { kind: 'unknown_product', position: 0 }],
  ]);
});

test('a new screen visit captures every chip again; leaving does not', async () => {
  await render();
  await setFocused(false);
  expect(shown()).toHaveLength(2);
  await setFocused(true);
  expect(shown()).toHaveLength(4);
});

test('props never carry titles or prompts', async () => {
  await render({ documentDetected: true });
  for (const [, props] of events)
    expect(Object.keys(props as object).sort()).toEqual(['kind', 'position']);
});

test('tap captures next_step_tapped with kind and position', async () => {
  const { result } = await render({ documentDetected: true });
  await act(async () => result.current.tap(result.current.chips[1]!, 1));
  expect(events.at(-1)).toEqual([
    'next_step_tapped',
    { kind: 'restock', position: 1 },
  ]);
});
