import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { Platform } from 'react-native';

import { setAnalyticsSink } from '@/lib/analytics';
import { useSettingsStore } from '@/stores/settings';
import { renderWithProviders } from '@/test/render';

import { setVoiceQuickAccess } from './quickAccess';
import { VoiceSetupSection } from './VoiceSetupSection';
import { initialVoiceSettings, useVoiceSettings } from './voiceSettings';

const events: { event: string; props: unknown }[] = [];

beforeEach(() => {
  events.length = 0;
  setAnalyticsSink({
    capture: (event, props) => events.push({ event, props }),
  });
  useVoiceSettings.setState(initialVoiceSettings);
});
afterEach(() => {
  setAnalyticsSink(null);
  setVoiceQuickAccess();
  jest.restoreAllMocks();
});

const supportedBubble = (initial = false) => ({
  isSupported: () => true,
  isEnabled: jest.fn(async () => initial),
  setEnabled: jest.fn(async (on: boolean) => on),
});
const supportedTile = () => ({
  isSupported: () => true,
  requestAdd: jest.fn(async () => true),
});

describe('without a native module', () => {
  test.each(['android', 'ios', 'web'] as const)(
    'on %s only the opt-in switch shows, with no heading',
    async (os) => {
      jest.replaceProperty(Platform, 'OS', os);
      await renderWithProviders(<VoiceSetupSection />);
      expect(screen.queryByTestId('voice-bubble-row')).toBeNull();
      expect(screen.queryByTestId('voice-tile-row')).toBeNull();
      expect(screen.queryByText('Nút nói nhanh')).toBeNull();
      expect(screen.getByTestId('voice-donate-row')).toBeOnTheScreen();
    },
  );
});

describe('opt-in to share voice', () => {
  test('is off at first, stored locally, and says the upload is not part of this version', async () => {
    await renderWithProviders(<VoiceSetupSection />);
    const toggle = screen.getByRole('switch', {
      name: 'Góp giọng nói để cải thiện',
    });
    expect(toggle).not.toBeChecked();
    expect(
      screen.getByText(/Chưa gửi giọng nói đi trong bản này/),
    ).toBeOnTheScreen();
    await fireEvent.press(toggle);
    expect(useVoiceSettings.getState().donate).toBe(true);
    expect(toggle).toBeChecked();
  });

  test('follows the language', async () => {
    useSettingsStore.setState({ language: 'en' });
    await renderWithProviders(<VoiceSetupSection />);
    expect(
      screen.getByRole('switch', { name: 'Share my voice to improve it' }),
    ).toBeOnTheScreen();
  });
});

describe('Android with the native module', () => {
  beforeEach(() => jest.replaceProperty(Platform, 'OS', 'android'));

  test('shows the heading, the bubble switch and the tile row', async () => {
    setVoiceQuickAccess({
      bubble: supportedBubble(true),
      tile: supportedTile(),
    });
    await renderWithProviders(<VoiceSetupSection />);
    expect(
      screen.getByRole('header', { name: 'Nút nói nhanh' }),
    ).toBeOnTheScreen();
    expect(
      await screen.findByRole('switch', { name: 'Hiện nút nói trên màn hình' }),
    ).toBeChecked();
    expect(
      screen.getByRole('button', { name: 'Thêm ô cài đặt nhanh' }),
    ).toBeOnTheScreen();
  });

  test('turning the bubble on calls the module and reports the setup', async () => {
    const bubble = supportedBubble();
    setVoiceQuickAccess({ bubble });
    await renderWithProviders(<VoiceSetupSection />);
    const toggle = screen.getByRole('switch', {
      name: 'Hiện nút nói trên màn hình',
    });
    await fireEvent.press(toggle);
    await waitFor(() => expect(toggle).toBeChecked());
    expect(bubble.setEnabled).toHaveBeenCalledWith(true);
    expect(events).toEqual([
      {
        event: 'voice_setup_completed',
        props: { platform: 'android', kind: 'bubble' },
      },
    ]);
    await fireEvent.press(toggle);
    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(events).toHaveLength(1);
  });

  test('a refused permission leaves the switch off and says so', async () => {
    const bubble = {
      ...supportedBubble(),
      setEnabled: jest.fn(async () => false),
    };
    setVoiceQuickAccess({ bubble });
    await renderWithProviders(<VoiceSetupSection />);
    await fireEvent.press(
      screen.getByRole('switch', { name: 'Hiện nút nói trên màn hình' }),
    );
    expect(
      await screen.findByText('Chưa bật được. Thử lại.'),
    ).toBeOnTheScreen();
    expect(events).toEqual([]);
  });

  test('a module that throws is an error, not a crash', async () => {
    const bubble = {
      ...supportedBubble(),
      setEnabled: jest.fn(async () => {
        throw new Error('native');
      }),
    };
    setVoiceQuickAccess({ bubble });
    await renderWithProviders(<VoiceSetupSection />);
    await fireEvent.press(
      screen.getByRole('switch', { name: 'Hiện nút nói trên màn hình' }),
    );
    expect(
      await screen.findByText('Chưa bật được. Thử lại.'),
    ).toBeOnTheScreen();
  });

  test('the tile row asks the system once and reports the setup', async () => {
    const tile = supportedTile();
    setVoiceQuickAccess({ tile });
    await renderWithProviders(<VoiceSetupSection />);
    expect(screen.queryByTestId('voice-bubble-row')).toBeNull();
    await fireEvent.press(
      screen.getByRole('button', { name: 'Thêm ô cài đặt nhanh' }),
    );
    expect(
      await screen.findByText('Đã thêm ô cài đặt nhanh'),
    ).toBeOnTheScreen();
    expect(tile.requestAdd).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      {
        event: 'voice_setup_completed',
        props: { platform: 'android', kind: 'tile' },
      },
    ]);
  });

  test('a tile the system declines shows the error', async () => {
    setVoiceQuickAccess({
      tile: { isSupported: () => true, requestAdd: jest.fn(async () => false) },
    });
    await renderWithProviders(<VoiceSetupSection />);
    await fireEvent.press(
      screen.getByRole('button', { name: 'Thêm ô cài đặt nhanh' }),
    );
    expect(
      await screen.findByText('Chưa bật được. Thử lại.'),
    ).toBeOnTheScreen();
  });

  test('rows stay hidden on iOS even when the module says supported', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    setVoiceQuickAccess({ bubble: supportedBubble(), tile: supportedTile() });
    await renderWithProviders(<VoiceSetupSection />);
    expect(screen.queryByTestId('voice-bubble-row')).toBeNull();
    expect(screen.queryByTestId('voice-tile-row')).toBeNull();
  });
});
