import { fireEvent, renderApp, screen, testRouter } from '@/test/router';

test('shop tabs show the stock banner and returning to the camera hides it', async () => {
  await renderApp('/');
  expect(screen.queryByRole('alert', { name: /sắp hết hàng/i })).toBeNull();
  await testRouter.push('/inventory');
  expect(
    await screen.findByRole('alert', { name: /sắp hết hàng/i }),
  ).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('tab', { name: 'Báo cáo' }));
  expect(
    screen.getByRole('alert', { name: /sắp hết hàng/i }),
  ).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('tab', { name: 'Tài khoản' }));
  expect(
    screen.getByRole('alert', { name: /sắp hết hàng/i }),
  ).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: 'Mở camera' }));
  expect(screen).toHavePathname('/');
  expect(screen.queryByRole('alert', { name: /sắp hết hàng/i })).toBeNull();
});
