import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

import * as pushNotifications from '@/lib/notifications/push';
import { clerkMock } from '@/test/clerk';
import * as storeApi from '@/lib/api/store';
import { useSettingsStore } from '@/stores/settings';
import { renderWithProviders } from '@/test/render';
import { typography } from '@/theme';

import { AccountScreen } from './AccountScreen';

afterEach(() => jest.restoreAllMocks());

const open = async () => {
  await renderWithProviders(<AccountScreen />);
  return screen.findByRole('header', { name: 'Tạp hóa Cô Ba' });
};

test('shows a loading indicator under the title', async () => {
  // Hold the store request open: with zero mock latency it would otherwise settle during render.
  jest.spyOn(storeApi, 'getStore').mockReturnValue(new Promise(() => {}));
  await renderWithProviders(<AccountScreen />);
  expect(screen.getByRole('header', { name: 'Tài khoản' })).toBeOnTheScreen();
  expect(screen.getByLabelText('Đang tải')).toBeOnTheScreen();
});

test('shows store name, role, members and bank account', async () => {
  await open();
  expect(screen.getByText('Chủ')).toBeOnTheScreen();
  const count = await screen.findByLabelText('3 thành viên');
  expect(count).toBeOnTheScreen();
  // Android only exposes a labelled View to accessibility services (and Maestro) when it is accessible.
  expect(count.props.accessible).toBe(true);
  expect(screen.getByLabelText('Cô Ba, Chủ')).toBeOnTheScreen();
  expect(screen.getByLabelText('Bà nội, Người bán')).toBeOnTheScreen();
  expect(
    screen.getByRole('button', { name: 'Tài khoản ngân hàng VietQR' }),
  ).toHaveTextContent('VCB · 0123 456 789');
  expect(
    screen.getByRole('switch', { name: 'Chế độ người lớn tuổi' }),
  ).not.toBeChecked();
  expect(screen.getByRole('radio', { name: 'VI' })).toBeChecked();
  expect(screen.getByRole('radio', { name: 'EN' })).not.toBeChecked();
});

test('shows an error with retry when the account cannot load', async () => {
  const spy = jest
    .spyOn(storeApi, 'getMe')
    .mockRejectedValueOnce(new Error('boom'));
  await renderWithProviders(<AccountScreen />);
  expect(await screen.findByText('Không tải được tài khoản')).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: 'Thử lại' }));
  expect(
    await screen.findByRole('header', { name: 'Tạp hóa Cô Ba' }),
  ).toBeOnTheScreen();
  expect(spy).toHaveBeenCalledTimes(2);
});

test('shows a members error without hiding the rest', async () => {
  jest.spyOn(storeApi, 'listMembers').mockRejectedValue(new Error('boom'));
  await open();
  expect(
    await screen.findByText('Không tải được thành viên'),
  ).toBeOnTheScreen();
  expect(
    screen.getByRole('switch', { name: 'Chế độ người lớn tuổi' }),
  ).toBeOnTheScreen();
});

test('shows a placeholder when there is no bank account', async () => {
  jest.spyOn(storeApi, 'getStore').mockResolvedValue({
    ...(await storeApi.getStore()),
    bank_account: null,
  });
  await renderWithProviders(<AccountScreen />);
  expect(await screen.findByText('Thêm tài khoản ngân hàng')).toBeOnTheScreen();
});

test('elder-mode switch updates the settings store', async () => {
  await open();
  await fireEvent.press(
    screen.getByRole('switch', { name: 'Chế độ người lớn tuổi' }),
  );
  expect(useSettingsStore.getState().elderMode).toBe(true);
  expect(
    screen.getByRole('switch', { name: 'Chế độ người lớn tuổi' }),
  ).toBeChecked();
  await fireEvent.press(
    screen.getByRole('switch', { name: 'Chế độ người lớn tuổi' }),
  );
  expect(useSettingsStore.getState().elderMode).toBe(false);
});

test('text size steps 100 to 200 % and scales this screen', async () => {
  await open();
  const title = screen.getByRole('header', { name: 'Tạp hóa Cô Ba' });
  expect(screen.getByText('100%')).toBeOnTheScreen();
  expect(title).toHaveStyle({ fontSize: typography.heading.fontSize });

  await fireEvent.press(screen.getByRole('button', { name: 'Chữ to hơn' }));
  expect(useSettingsStore.getState().fontScale).toBe(1.25);
  expect(screen.getByText('125%')).toBeOnTheScreen();
  expect(title).toHaveStyle({ fontSize: typography.heading.fontSize! * 1.25 });

  await fireEvent.press(screen.getByRole('button', { name: 'Chữ nhỏ hơn' }));
  expect(useSettingsStore.getState().fontScale).toBe(1);
});

test('text size stops at the bounds', async () => {
  await open();
  const smaller = screen.getByRole('button', { name: 'Chữ nhỏ hơn' });
  expect(smaller).toBeDisabled();
  await act(async () => useSettingsStore.setState({ fontScale: 2 }));
  expect(screen.getByRole('button', { name: 'Chữ to hơn' })).toBeDisabled();
});

test('language toggle switches this screen to English and back', async () => {
  await open();
  await fireEvent.press(screen.getByRole('radio', { name: 'EN' }));
  expect(useSettingsStore.getState().language).toBe('en');
  expect(screen.getByText('Owner')).toBeOnTheScreen();
  expect(screen.getByRole('switch', { name: 'Elder mode' })).toBeOnTheScreen();
  expect(screen.getByLabelText('3 members')).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: 'Larger text' })).toBeOnTheScreen();
  expect(screen.getByRole('radio', { name: 'EN' })).toBeChecked();
  await fireEvent.press(screen.getByRole('radio', { name: 'VI' }));
  expect(screen.getByText('Chủ')).toBeOnTheScreen();
});

test('invite button creates an invite and shows its QR, code and expiry', async () => {
  await open();
  await fireEvent.press(screen.getByRole('button', { name: 'Mời bằng mã QR' }));
  const qr = await screen.findByTestId('qr-code');
  expect(qr.props.accessibilityLabel).toMatch(/^taphoa:\/\/join\?token=/);
  const token = qr.props.accessibilityLabel.split('token=')[1] as string;
  expect(screen.getByText(token.match(/.{1,4}/g)!.join(' '))).toBeOnTheScreen();
  expect(screen.getByText(/Hết hạn lúc \d{2}:\d{2}/)).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('sheet-scrim'));
  expect(screen.queryByTestId('qr-code')).toBeNull();
});

test('invite failure shows an error and can be retried', async () => {
  await open();
  jest.spyOn(storeApi, 'createInvite').mockRejectedValueOnce(new Error('x'));
  await fireEvent.press(screen.getByRole('button', { name: 'Mời bằng mã QR' }));
  expect(await screen.findByText('Không tạo được mã mời')).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: 'Thử lại' }));
  expect(await screen.findByTestId('qr-code')).toBeOnTheScreen();
});

test('a seller cannot invite or edit the bank account', async () => {
  const me = await storeApi.getMe();
  jest.spyOn(storeApi, 'getMe').mockResolvedValue({
    ...me,
    memberships: me.memberships.map((membership) => ({
      ...membership,
      member: { ...membership.member, role: 'seller' },
    })),
  });
  await open();
  expect(screen.getByText('Người bán')).toBeOnTheScreen();
  expect(screen.queryByRole('button', { name: 'Mời bằng mã QR' })).toBeNull();
  expect(
    screen.getByRole('button', { name: 'Tài khoản ngân hàng VietQR' }),
  ).toBeDisabled();
});

describe('bank account sheet', () => {
  const openSheet = async () => {
    await open();
    await fireEvent.press(
      screen.getByRole('button', { name: 'Tài khoản ngân hàng VietQR' }),
    );
    return screen.findByLabelText('Số tài khoản');
  };

  test('prefills the stored account', async () => {
    const field = await openSheet();
    expect(field.props.value).toBe('0123456789');
    expect(screen.getByLabelText('Ngân hàng').props.value).toBe('VCB');
    expect(screen.getByLabelText('Mã BIN ngân hàng').props.value).toBe(
      '970436',
    );
    expect(screen.getByLabelText('Chủ tài khoản').props.value).toBe(
      'NGUYEN THI BA',
    );
  });

  test('saves a new account through the API and updates the row', async () => {
    await openSheet();
    await fireEvent.changeText(
      screen.getByLabelText('Ngân hàng'),
      'Techcombank',
    );
    await fireEvent.changeText(
      screen.getByLabelText('Mã BIN ngân hàng'),
      '970407',
    );
    await fireEvent.changeText(
      screen.getByLabelText('Số tài khoản'),
      '19036666888',
    );
    await fireEvent.changeText(
      screen.getByLabelText('Chủ tài khoản'),
      'Trần Văn Đức',
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Lưu' }));
    await waitFor(() =>
      expect(screen.queryByLabelText('Số tài khoản')).toBeNull(),
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Tài khoản ngân hàng VietQR' }),
      ).toHaveTextContent('Techcombank · 1903 666 688 8'),
    );
    expect((await storeApi.getStore()).bank_account).toEqual({
      bank_bin: '970407',
      bank_short_name: 'Techcombank',
      account_number: '19036666888',
      account_name: 'TRAN VAN DUC',
    });
  });

  test('validates BIN, number and holder before saving', async () => {
    const patch = jest.spyOn(storeApi, 'patchStore');
    await openSheet();
    await fireEvent.changeText(screen.getByLabelText('Mã BIN ngân hàng'), '12');
    await fireEvent.changeText(screen.getByLabelText('Số tài khoản'), '1');
    await fireEvent.changeText(screen.getByLabelText('Chủ tài khoản'), '');
    await fireEvent.press(screen.getByRole('button', { name: 'Lưu' }));
    expect(screen.getByText('Mã BIN gồm 6 chữ số')).toBeOnTheScreen();
    expect(screen.getByText('Số tài khoản gồm 4–19 ký tự')).toBeOnTheScreen();
    expect(screen.getByText('Nhập tên chủ tài khoản')).toBeOnTheScreen();
    expect(patch).not.toHaveBeenCalled();
  });

  test('shows the save error and keeps the sheet open', async () => {
    jest.spyOn(storeApi, 'patchStore').mockRejectedValueOnce(new Error('x'));
    await openSheet();
    await fireEvent.press(screen.getByRole('button', { name: 'Lưu' }));
    expect(await screen.findByText('Không lưu được')).toBeOnTheScreen();
    expect(screen.getByLabelText('Số tài khoản')).toBeOnTheScreen();
  });

  test('closes without saving', async () => {
    await openSheet();
    await fireEvent.press(screen.getByTestId('sheet-scrim'));
    expect(screen.queryByLabelText('Số tài khoản')).toBeNull();
  });

  test('can add an account when none is set', async () => {
    jest.spyOn(storeApi, 'getStore').mockResolvedValue({
      ...(await storeApi.getStore()),
      bank_account: null,
    });
    await renderWithProviders(<AccountScreen />);
    await fireEvent.press(
      await screen.findByRole('button', { name: 'Tài khoản ngân hàng VietQR' }),
    );
    expect((await screen.findByLabelText('Số tài khoản')).props.value).toBe('');
  });
});

test('bottom padding clears the floating tab bar at 150% text', async () => {
  useSettingsStore.setState({ elderMode: true });
  await open();
  const scroll = screen.getByTestId('account-scroll');
  const { paddingBottom } = Object.assign(
    {},
    ...[scroll.props.contentContainerStyle].flat(5).filter(Boolean),
  );
  // tab bar: 64 tall, floating 16 above the bottom inset
  expect(paddingBottom).toBeGreaterThanOrEqual(64 + 16);
});

test('sign out removes only the active Clerk session', async () => {
  await open();
  await fireEvent.press(screen.getByRole('button', { name: 'Đăng xuất' }));
  expect(clerkMock.signOut).toHaveBeenCalledWith({ sessionId: 'sess_test' });
});

describe('setting a PIN', () => {
  const type = async (digits: string) => {
    for (const digit of digits) {
      await fireEvent.press(screen.getByRole('button', { name: digit }));
    }
  };
  const openSheet = async () => {
    await open();
    await fireEvent.press(screen.getByRole('button', { name: 'Đặt mã PIN' }));
  };

  test('asks twice, saves through the API and confirms', async () => {
    const spy = jest.spyOn(storeApi, 'setPin').mockResolvedValue();
    await openSheet();
    expect(
      await screen.findByRole('header', { name: 'Mã PIN mới (4–6 chữ số)' }),
    ).toBeOnTheScreen();
    await type('4821');
    await fireEvent.press(screen.getByRole('button', { name: 'Tiếp' }));
    expect(
      await screen.findByRole('header', { name: 'Nhập lại mã PIN' }),
    ).toBeOnTheScreen();
    await type('4821');
    await fireEvent.press(screen.getByRole('button', { name: 'Xác nhận' }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith('4821'));
    expect(await screen.findByText('Đã đặt mã PIN')).toBeOnTheScreen();
    expect(screen.queryByTestId('sheet-panel')).toBeNull();
  });

  test('needs 4 digits before it goes on', async () => {
    await openSheet();
    await type('123');
    expect(screen.getByRole('button', { name: 'Tiếp' })).toBeDisabled();
  });

  test('two different PINs start over with a message and save nothing', async () => {
    const spy = jest.spyOn(storeApi, 'setPin').mockResolvedValue();
    await openSheet();
    await type('4821');
    await fireEvent.press(screen.getByRole('button', { name: 'Tiếp' }));
    await type('4822');
    await fireEvent.press(screen.getByRole('button', { name: 'Xác nhận' }));
    expect(await screen.findByText('Hai mã PIN không khớp')).toBeOnTheScreen();
    expect(
      screen.getByRole('header', { name: 'Mã PIN mới (4–6 chữ số)' }),
    ).toBeOnTheScreen();
    expect(spy).not.toHaveBeenCalled();
  });

  test('a server failure keeps the sheet open with an error', async () => {
    jest.spyOn(storeApi, 'setPin').mockRejectedValue(new Error('offline'));
    await openSheet();
    await type('4821');
    await fireEvent.press(screen.getByRole('button', { name: 'Tiếp' }));
    await type('4821');
    await fireEvent.press(screen.getByRole('button', { name: 'Xác nhận' }));
    expect(await screen.findByText('Không đặt được mã PIN')).toBeOnTheScreen();
    expect(screen.getByTestId('sheet-panel')).toBeOnTheScreen();
  });
});

describe('low stock threshold', () => {
  test('Lead steps the store threshold up and down through the patch API', async () => {
    const patch = jest.spyOn(storeApi, 'patchStore');
    await open();
    expect(screen.getByText('Ngưỡng sắp hết hàng')).toBeOnTheScreen();
    expect(screen.getByLabelText('Ngưỡng sắp hết hàng 5')).toBeOnTheScreen();
    await fireEvent.press(
      screen.getByRole('button', { name: 'Tăng ngưỡng sắp hết' }),
    );
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith({ low_stock_threshold: 6 }),
    );
    await screen.findByLabelText('Ngưỡng sắp hết hàng 6');
    await fireEvent.press(
      screen.getByRole('button', { name: 'Giảm ngưỡng sắp hết' }),
    );
    await waitFor(() =>
      expect(patch).toHaveBeenLastCalledWith({ low_stock_threshold: 5 }),
    );
    expect(
      await screen.findByLabelText('Ngưỡng sắp hết hàng 5'),
    ).toBeOnTheScreen();
  });

  test.each([0, 100000])(
    'threshold %s disables its boundary button',
    async (value) => {
      jest.spyOn(storeApi, 'getStore').mockResolvedValue({
        ...(await storeApi.getStore()),
        low_stock_threshold: value,
      });
      await open();
      expect(
        screen.getByRole('button', {
          name: value === 0 ? 'Giảm ngưỡng sắp hết' : 'Tăng ngưỡng sắp hết',
        }),
      ).toBeDisabled();
    },
  );

  test('failed patch preserves the store value and can be retried', async () => {
    jest
      .spyOn(storeApi, 'patchStore')
      .mockRejectedValueOnce(new Error('offline'));
    await open();
    await fireEvent.press(
      screen.getByRole('button', { name: 'Tăng ngưỡng sắp hết' }),
    );
    expect(
      await screen.findByText('Không lưu được ngưỡng sắp hết'),
    ).toBeOnTheScreen();
    expect(screen.getByLabelText('Ngưỡng sắp hết hàng 5')).toBeOnTheScreen();
    await fireEvent.press(
      screen.getByRole('button', { name: 'Tăng ngưỡng sắp hết' }),
    );
    expect(
      await screen.findByLabelText('Ngưỡng sắp hết hàng 6'),
    ).toBeOnTheScreen();
  });

  test('Seller cannot see the threshold control', async () => {
    const me = await storeApi.getMe();
    jest.spyOn(storeApi, 'getMe').mockResolvedValue({
      ...me,
      memberships: me.memberships.map((m) => ({
        ...m,
        member: { ...m.member, role: 'seller' },
      })),
    });
    await open();
    expect(screen.queryByText('Ngưỡng sắp hết hàng')).toBeNull();
  });
});

test('failed Clerk sign-out keeps the screen and allows retry', async () => {
  clerkMock.signOut.mockRejectedValueOnce(new Error('offline'));
  await open();
  await fireEvent.press(screen.getByRole('button', { name: 'Đăng xuất' }));
  expect(
    await screen.findByText('Không đăng xuất được. Vui lòng thử lại.'),
  ).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: 'Đăng xuất' }));
  expect(clerkMock.signOut).toHaveBeenCalledTimes(2);
});

test('sign-out calls unregisterPush before Clerk signOut', async () => {
  const unregisterSpy = jest
    .spyOn(pushNotifications, 'unregisterPush')
    .mockResolvedValueOnce();
  await open();
  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name: 'Đăng xuất' }));
  });
  expect(unregisterSpy).toHaveBeenCalledTimes(1);
  expect(clerkMock.signOut).toHaveBeenCalledWith({ sessionId: 'sess_test' });
});

test('sign-out proceeds even if unregisterPush fails', async () => {
  jest
    .spyOn(pushNotifications, 'unregisterPush')
    .mockRejectedValueOnce(new Error('push unregister network error'));
  await open();
  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name: 'Đăng xuất' }));
  });
  expect(clerkMock.signOut).toHaveBeenCalledWith({ sessionId: 'sess_test' });
});

test('has the opt-in voice switch below the language row, and no system rows without the module', async () => {
  await open();
  expect(
    screen.getByRole('switch', { name: 'Góp giọng nói để cải thiện' }),
  ).not.toBeChecked();
  expect(screen.queryByTestId('voice-bubble-row')).toBeNull();
  expect(screen.queryByTestId('voice-tile-row')).toBeNull();
});
