import * as storeApi from '@/lib/api/store';
import { ApiError } from '@/lib/api/errors';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { JoinStoreScreen } from './JoinStoreScreen';
import { renderWithProviders } from '@/test/render';
import { setApiTransport } from '@/lib/api/client';
import { testSession } from '@/test/session';
import { useCurrentStore } from '@/stores/currentStore';

jest.mock('expo-router', () => ({
  useRouter: () => ({ back: jest.fn() }),
  useLocalSearchParams: () => ({ token: 'K7Q4MZ2P9HXDT3VA' }),
}));

test('joins from the deep-link token with the Clerk bearer and selects the membership', async () => {
  const membership = testSession();
  const sent: Request[] = [];
  setApiTransport((async (r: Request) => {
    if (r.method === 'POST') {
      sent.push(r);
      return Response.json(membership, { status: 201 });
    }
    return Response.json({
      clerk_user_id: 'user_test',
      profile: { display_name: 'Mẹ', email: null },
      memberships: [],
    });
  }) as typeof fetch);
  await renderWithProviders(<JoinStoreScreen />);
  await waitFor(() =>
    expect(screen.getByTestId('join-display-name')).toHaveProp('value', 'Mẹ'),
  );
  await fireEvent.press(screen.getByTestId('join-store-submit'));
  expect(sent).toHaveLength(1);
  expect(await sent[0]!.json()).toEqual({
    invite_token: 'K7Q4MZ2P9HXDT3VA',
    display_name: 'Mẹ',
  });
  expect(sent[0]!.headers.get('authorization')).toBe('Bearer test-clerk-token');
  expect(useCurrentStore.getState().storeIds.user_test).toBe(
    membership.store.id,
  );
});

afterEach(() => jest.restoreAllMocks());
test('requires the invite and name before posting', async () => {
  const join = jest.spyOn(storeApi, 'joinStore');
  await renderWithProviders(<JoinStoreScreen />);
  await fireEvent.changeText(screen.getByTestId('join-invite-token'), '');
  await fireEvent.changeText(screen.getByTestId('join-display-name'), '');
  await fireEvent.press(screen.getByTestId('join-store-submit'));
  expect(screen.getByText('Nhập mã mời')).toBeOnTheScreen();
  expect(
    screen.getByText('Nhập tên của bạn (tối đa 40 ký tự)'),
  ).toBeOnTheScreen();
  expect(join).not.toHaveBeenCalled();
});
test('a pasted QR link is reduced to the invite token', async () => {
  const join = jest
    .spyOn(storeApi, 'joinStore')
    .mockResolvedValue(testSession());
  await renderWithProviders(<JoinStoreScreen />);
  await fireEvent.changeText(
    screen.getByTestId('join-invite-token'),
    'taphoa://join?token=k7q4%20mz2p',
  );
  await fireEvent(screen.getByTestId('join-display-name'), 'submitEditing');
  expect(join).toHaveBeenCalledWith({
    invite_token: 'K7Q4MZ2P',
    display_name: 'Cô Ba',
  });
});
test('an expired invite is explained and retains the form for retry', async () => {
  jest
    .spyOn(storeApi, 'joinStore')
    .mockRejectedValueOnce(
      new ApiError(410, { error: 'expired', code: 'invite_unavailable' }),
    );
  await renderWithProviders(<JoinStoreScreen />);
  await fireEvent.press(screen.getByTestId('join-store-submit'));
  expect(
    await screen.findByText('Mã mời đã hết hạn hoặc đã được dùng.'),
  ).toBeOnTheScreen();
  expect(screen.getByTestId('join-store-submit')).toBeEnabled();
});
