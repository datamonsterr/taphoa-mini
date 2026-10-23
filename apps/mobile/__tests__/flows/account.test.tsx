import { fireEvent, renderApp, screen } from '@/test/router';
import { typography } from '@/theme';

test('account: elder mode, text size, language and invite QR', async () => {
  await renderApp('/account');
  expect(screen).toHavePathname('/account');

  const title = await screen.findByRole('header', { name: 'Tạp hóa Cô Ba' });

  await fireEvent.press(
    screen.getByRole('switch', { name: 'Chế độ người lớn tuổi' }),
  );
  expect(
    screen.getByRole('switch', { name: 'Chế độ người lớn tuổi' }),
  ).toBeChecked();

  // Elder mode floors the text size at 125 %.
  expect(screen.getByText('125%')).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: 'Chữ nhỏ hơn' })).toBeDisabled();

  await fireEvent.press(screen.getByRole('button', { name: 'Chữ to hơn' }));
  expect(screen.getByText('150%')).toBeOnTheScreen();
  expect(title).toHaveStyle({ fontSize: typography.heading.fontSize! * 1.5 });

  await fireEvent.press(screen.getByRole('radio', { name: 'EN' }));
  expect(screen.getByText('Owner')).toBeOnTheScreen();
  expect(screen.getByRole('switch', { name: 'Elder mode' })).toBeChecked();

  await fireEvent.press(
    screen.getByRole('button', { name: 'Invite with QR code' }),
  );
  expect(await screen.findByTestId('qr-code')).toBeOnTheScreen();
  expect(screen.getByText(/Expires at \d{2}:\d{2}/)).toBeOnTheScreen();
});

test('account sheets hide the tab bar so the save button is reachable', async () => {
  await renderApp('/account');
  await screen.findByRole('header', { name: 'Tạp hóa Cô Ba' });
  expect(screen.getByTestId('shop-tab-bar')).toBeOnTheScreen();

  await fireEvent.press(
    screen.getByRole('button', { name: 'Tài khoản ngân hàng VietQR' }),
  );
  const saveButton = await screen.findByRole('button', { name: 'Lưu' });
  expect(screen.queryByTestId('shop-tab-bar')).toBeNull();
  expect(saveButton).toBeEnabled();

  await fireEvent.press(screen.getByTestId('sheet-scrim'));
  expect(screen.getByTestId('shop-tab-bar')).toBeOnTheScreen();

  await fireEvent.press(screen.getByRole('button', { name: 'Mời bằng mã QR' }));
  await screen.findByTestId('qr-code');
  expect(screen.queryByTestId('shop-tab-bar')).toBeNull();
});
