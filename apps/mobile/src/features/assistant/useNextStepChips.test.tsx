import { act, renderHook } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';

import type { NextStepChipData } from '@/components/assistant/chip';
import { setAnalyticsSink } from '@/lib/analytics';
import { useSettingsStore } from '@/stores/settings';
import {
  initialVoiceSettings,
  useVoiceSettings,
} from '@/features/voice/voiceSettings';
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
  useVoiceSettings.setState(initialVoiceSettings);
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

test('a detected receipt owns the strip with two different actions', async () => {
  const { result } = await render({
    documentDetected: true,
    unknownProduct: true,
  });
  expect(result.current.chips).toMatchObject([
    {
      title: 'Đọc hóa đơn nhập',
      source: 'device',
      tone: 'accent',
      action: { type: 'receipt', destination: 'review' },
    },
    {
      title: 'Nhập trong trợ lý',
      source: 'device',
      tone: 'neutral',
      action: { type: 'receipt', destination: 'assistant' },
    },
  ]);
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
  expect(kinds(result.current.chips)).toEqual([
    'receipt_detected',
    'receipt_detected',
  ]);
});

test('English shows a title per kind and drops the Vietnamese subtitle', async () => {
  useSettingsStore.setState({ language: 'en' });
  const { result } = await render({ documentDetected: true });
  expect(result.current.chips.map((c) => c.title)).toEqual([
    'Read import receipt',
    'Import in assistant',
  ]);
  expect(result.current.chips[0]!.subtitle).toBeUndefined();
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

test('keeps the direct receipt action available while the assistant is off', async () => {
  const { result } = await render({ enabled: false, documentDetected: true });
  expect(result.current.chips).toMatchObject([
    {
      title: 'Đọc hóa đơn nhập',
      action: { type: 'receipt', destination: 'review' },
    },
  ]);
});

test('captures next_step_shown once per chip with its position', async () => {
  const { rerender } = await render({ documentDetected: true });
  expect(shown()).toEqual([
    ['next_step_shown', { kind: 'receipt_detected', position: 0 }],
    ['next_step_shown', { kind: 'receipt_detected', position: 1 }],
  ]);
  await rerender({ documentDetected: true });
  expect(shown()).toHaveLength(2);
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
    { kind: 'receipt_detected', position: 1 },
  ]);
});

describe('voice_sale chip', () => {
  const joined = (days: number) =>
    new Date(Date.now() - days * 86_400_000).toISOString();

  test('shows after the device chips and before the server chips for a new member', async () => {
    const { result } = await render({
      joinedAt: joined(2),
      unknownProduct: true,
    });
    expect(kinds(result.current.chips)).toEqual([
      'unknown_product',
      'voice_sale',
      'restock',
      'draft_receipts',
    ]);
    expect(result.current.chips[1]).toEqual({
      id: 'voice_sale',
      kind: 'voice_sale',
      title: 'Bán bằng giọng nói',
      subtitle: 'Nói “hai chai coca” là xong',
      source: 'app',
      action: { type: 'voice' },
    });
  });

  test('is in English when the language is English', async () => {
    useSettingsStore.setState({ language: 'en' });
    const { result } = await render({ joinedAt: joined(1) });
    expect(result.current.chips[0]).toMatchObject({
      title: 'Sell by voice',
      subtitle: 'Say “two cokes” and you are done',
    });
  });

  test('is gone after 14 days', async () => {
    const { result } = await render({ joinedAt: joined(15) });
    expect(kinds(result.current.chips)).not.toContain('voice_sale');
  });

  test('is gone after three voice sales and without a join date', async () => {
    useVoiceSettings.setState({ voiceSales: 3 });
    expect(
      kinds((await render({ joinedAt: joined(1) })).result.current.chips),
    ).not.toContain('voice_sale');
    useVoiceSettings.setState({ voiceSales: 2 });
    expect(
      kinds((await render({ joinedAt: joined(1) })).result.current.chips),
    ).toContain('voice_sale');
    expect(kinds((await render()).result.current.chips)).not.toContain(
      'voice_sale',
    );
  });

  test('is hidden with the rest of the strip while the assistant is off', async () => {
    const { result } = await render({ joinedAt: joined(1), enabled: false });
    expect(result.current.chips).toEqual([]);
  });

  test('is counted as shown and tapped like any chip', async () => {
    const { result } = await render({ joinedAt: joined(1) });
    expect(shown()).toContainEqual([
      'next_step_shown',
      { kind: 'voice_sale', position: 0 },
    ]);
    await act(async () => result.current.tap(result.current.chips[0]!, 0));
    expect(events).toContainEqual([
      'next_step_tapped',
      { kind: 'voice_sale', position: 0 },
    ]);
  });
});
