import { screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { renderWithProviders } from '@/test/render';
import { Frame } from './kit';

jest.mock('expo-router', () => ({ useRouter: () => ({ back: jest.fn() }) }));
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: jest.fn(),
}));

test.each([0, 47])(
  'sign-in starts 33 px below the 47 px status bar with inset %i',
  async (top) => {
    jest
      .mocked(useSafeAreaInsets)
      .mockReturnValue({ top, bottom: 0, left: 0, right: 0 });
    await renderWithProviders(
      <Frame title="Sign in" back={false} brand fill>
        {null}
      </Frame>,
    );
    let node = screen.getByRole('header', { name: 'Sign in' }).parent;
    while (node && !node.props.contentContainerStyle) node = node.parent;
    expect(node).toBeTruthy();
    expect(
      StyleSheet.flatten(node!.props.contentContainerStyle).paddingTop,
    ).toBe(80);
  },
);
