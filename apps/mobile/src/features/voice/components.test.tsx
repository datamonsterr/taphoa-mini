import { act, fireEvent, screen } from '@testing-library/react-native';
import * as Haptics from 'expo-haptics';
import { AccessibilityInfo } from 'react-native';

import { useSettingsStore } from '@/stores/settings';
import { renderWithProviders } from '@/test/render';
import { colors } from '@/theme';

import { LevelBars } from './LevelBars';
import { ListeningView, ringOffset } from './ListeningView';
import { StatusPanel } from './StatusPanel';
import { UnderstandingView } from './UnderstandingView';
import { VoiceMicButton } from './VoiceMicButton';

const flat = (node: { props: { style?: unknown } }) =>
  Object.assign({}, ...[node.props.style].flat(5).filter(Boolean));

describe('LevelBars', () => {
  test('ten bars that grow with the level and scroll left', async () => {
    const view = await renderWithProviders(<LevelBars level={0} />);
    const heights = () =>
      screen
        .getAllByTestId(/^level-bar-/, { includeHiddenElements: true })
        .map((bar) => flat(bar).height);
    expect(heights()).toEqual(Array(10).fill(8));
    await view.rerender(<LevelBars level={1} />);
    expect(heights().at(-1)).toBe(48);
    expect(heights().at(-2)).toBe(8);
    await view.rerender(<LevelBars level={0.5} />);
    expect(heights().slice(-2)).toEqual([48, 28]);
  });

  test('quiet bars use the soft colour and loud ones the accent', async () => {
    const view = await renderWithProviders(<LevelBars level={0} />);
    const last = () =>
      flat(
        screen.getAllByTestId(/^level-bar-/, {
          includeHiddenElements: true,
        })[9]!,
      ).backgroundColor;
    expect(last()).toBe(colors.accentSoft);
    await view.rerender(<LevelBars level={0.8} />);
    expect(last()).toBe(colors.accent);
  });
});

describe('ListeningView', () => {
  const props = {
    level: 0.4,
    elapsedMs: 7000,
    maxMs: 30000,
    onStop: jest.fn(),
    onClose: jest.fn(),
  };
  beforeEach(() => {
    props.onStop.mockClear();
    props.onClose.mockClear();
  });

  test('shows the clock, the hint and the example', async () => {
    await renderWithProviders(<ListeningView {...props} />);
    expect(screen.getByTestId('voice-clock')).toHaveTextContent('0:07');
    expect(screen.getByTestId('voice-clock').props.accessibilityLabel).toBe(
      'Còn 23 giây',
    );
    expect(screen.getByText('Nói tên hàng và giá')).toBeOnTheScreen();
    expect(screen.getByText(/một chai tương ớt/)).toBeOnTheScreen();
  });

  test('the countdown ring fills with the elapsed time', async () => {
    expect(ringOffset(0)).toBeCloseTo(2 * Math.PI * 64, 5);
    expect(ringOffset(0.5)).toBeCloseTo(Math.PI * 64, 5);
    expect(ringOffset(1)).toBe(0);
    expect(ringOffset(2)).toBe(0);
    expect(ringOffset(-1)).toBeCloseTo(2 * Math.PI * 64, 5);
    await renderWithProviders(<ListeningView {...props} />);
    expect(screen.getByTestId('voice-ring')).toBeOnTheScreen();
  });

  test('stop and close are 56 dp or larger labelled buttons', async () => {
    await renderWithProviders(<ListeningView {...props} />);
    await fireEvent.press(screen.getByLabelText('Xong, hiểu lời vừa nói'));
    await fireEvent.press(screen.getByLabelText('Đóng'));
    expect(props.onStop).toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalled();
    expect(flat(screen.getByLabelText('Đóng')).width).toBeGreaterThanOrEqual(
      56,
    );
    expect(
      flat(screen.getByLabelText('Xong, hiểu lời vừa nói')).minHeight,
    ).toBeGreaterThanOrEqual(56);
  });

  test('is in English when the language is English', async () => {
    useSettingsStore.setState({ language: 'en' });
    await renderWithProviders(<ListeningView {...props} />);
    expect(screen.getByText('Say the item and price')).toBeOnTheScreen();
    expect(
      screen.getByLabelText('Done, understand what I said'),
    ).toBeOnTheScreen();
  });
});

describe('UnderstandingView', () => {
  test('shows the status, the grey transcript and a cancel button', async () => {
    const onCancel = jest.fn();
    await renderWithProviders(
      <UnderstandingView transcript="hai lon coca" onCancel={onCancel} />,
    );
    expect(screen.getByText('Đang hiểu…')).toBeOnTheScreen();
    expect(flat(screen.getByTestId('voice-transcript')).color).toBe(
      colors.lineStrong,
    );
    await fireEvent.press(screen.getByLabelText('Hủy'));
    expect(onCancel).toHaveBeenCalled();
    expect(screen.getByRole('progressbar')).toBeOnTheScreen();
  });

  test('without a transcript there is no transcript line', async () => {
    await renderWithProviders(<UnderstandingView onCancel={jest.fn()} />);
    expect(screen.queryByTestId('voice-transcript')).toBeNull();
  });
});

describe('StatusPanel', () => {
  test('renders the message, its extra content and the actions', async () => {
    const press = jest.fn();
    const close = jest.fn();
    await renderWithProviders(
      <StatusPanel
        testID="panel"
        title="Tiêu đề"
        hint="Gợi ý"
        actions={[
          { label: 'Một', onPress: press, testID: 'a-one', primary: true },
          { label: 'Hai', onPress: jest.fn(), testID: 'a-two' },
        ]}
        closeLabel="Đóng"
        onClose={close}
      >
        <></>
      </StatusPanel>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Tiêu đề');
    expect(screen.getByText('Gợi ý')).toBeOnTheScreen();
    expect(flat(screen.getByTestId('a-one')).backgroundColor).toBe(colors.ink);
    expect(flat(screen.getByTestId('a-two')).backgroundColor).toBe(
      colors.surfaceSoft,
    );
    expect(flat(screen.getByTestId('a-one')).minHeight).toBeGreaterThanOrEqual(
      56,
    );
    await fireEvent.press(screen.getByTestId('a-one'));
    await fireEvent.press(screen.getByLabelText('Đóng'));
    expect(press).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });
});

describe('VoiceMicButton', () => {
  const setup = async (
    props: Partial<React.ComponentProps<typeof VoiceMicButton>> = {},
  ) => {
    const onStart = jest.fn();
    const onStop = jest.fn();
    await renderWithProviders(
      <VoiceMicButton
        mode="hold"
        listening={false}
        onStart={onStart}
        onStop={onStop}
        {...props}
      />,
    );
    return { onStart, onStop };
  };
  beforeEach(() => jest.mocked(Haptics.impactAsync).mockClear());

  test('hold mode starts on press in and stops on press out', async () => {
    const { onStart, onStop } = await setup();
    const mic = screen.getByTestId('voice-mic-button');
    expect(mic.props.accessibilityLabel).toBe('Giữ để nói thêm món');
    expect(flat(mic).width).toBe(56);
    await fireEvent(mic, 'pressIn');
    expect(onStart).toHaveBeenCalled();
    expect(Haptics.impactAsync).toHaveBeenCalled();
    await fireEvent(mic, 'pressOut');
    expect(onStop).toHaveBeenCalled();
  });

  test('toggle mode taps to start and taps to stop', async () => {
    const { onStart, onStop } = await setup({ mode: 'toggle' });
    expect(screen.getByLabelText('Bấm để nói thêm món')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('voice-mic-button'));
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();
  });

  test('listening shows the accent colour and stop label', async () => {
    const { onStop } = await setup({ mode: 'toggle', listening: true });
    const mic = screen.getByLabelText('Bấm để dừng');
    expect(flat(mic).backgroundColor).toBe(colors.accent);
    expect(screen.getByTestId('icon-Square')).toBeOnTheScreen();
    await fireEvent.press(mic);
    expect(onStop).toHaveBeenCalled();
  });

  test('a screen reader makes hold mode a toggle', async () => {
    jest
      .spyOn(AccessibilityInfo, 'isScreenReaderEnabled')
      .mockResolvedValue(true);
    const { onStart } = await setup();
    await act(async () => {});
    expect(screen.getByLabelText('Bấm để nói thêm món')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('voice-mic-button'));
    expect(onStart).toHaveBeenCalledTimes(1);
    jest.restoreAllMocks();
  });

  test('disabled looks dimmed and a label can be supplied', async () => {
    await setup({ disabled: true, label: 'Nói lại' });
    const mic = screen.getByLabelText('Nói lại');
    expect(mic.props.accessibilityState).toMatchObject({ disabled: true });
    expect(flat(mic).opacity).toBeLessThan(1);
  });
});
