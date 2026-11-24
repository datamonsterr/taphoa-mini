import { fireEvent, renderApp, screen } from '@/test/router';
import { setTestMembership, testSession } from '@/test/session';

afterEach(() => jest.restoreAllMocks());

test('dashboard renders daily actions row with Chi, Chốt sổ, and Công nợ', async () => {
  await renderApp('/dashboard');
  expect(await screen.findByTestId('dashboard-add-expense')).toBeOnTheScreen();
  expect(screen.getByTestId('dashboard-close-day')).toBeOnTheScreen();
  expect(screen.getByTestId('dashboard-debts')).toBeOnTheScreen();

  await fireEvent.press(screen.getByTestId('dashboard-add-expense'));
  expect(screen).toHavePathname('/expense');

  await renderApp('/dashboard');
  await fireEvent.press(screen.getByTestId('dashboard-close-day'));
  expect(screen).toHavePathname('/close');

  await renderApp('/dashboard');
  await fireEvent.press(screen.getByTestId('dashboard-debts'));
  expect(screen).toHavePathname('/debts');
});

test('dashboard hides Chốt sổ for seller role (non-lead)', async () => {
  const session = testSession();
  setTestMembership({
    ...session!,
    member: { ...session!.member, role: 'seller' },
  });
  await renderApp('/dashboard');
  expect(await screen.findByTestId('dashboard-add-expense')).toBeOnTheScreen();
  expect(screen.getByTestId('dashboard-debts')).toBeOnTheScreen();
  expect(screen.queryByTestId('dashboard-close-day')).toBeNull();
});

test('dashboard does not show old Hóa đơn nhập chip', async () => {
  await renderApp('/dashboard');
  await screen.findByTestId('dashboard-add-expense');
  expect(screen.queryByTestId('dashboard-receipts-chip')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Hóa đơn nhập' })).toBeNull();
});
