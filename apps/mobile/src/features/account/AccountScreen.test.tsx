import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

import * as authApi from '@/lib/api/auth';
import { ApiError } from '@/lib/api/errors';
import * as storeApi from '@/lib/api/store';
import { useSettingsStore } from '@/stores/settings';
import { SELLER_IDS } from '@/test/mock/fixtures';
import { renderWithProviders } from '@/test/render';
import { typography } from '@/theme';

import { AccountScreen } from './AccountScreen';

const SELLER_ID = SELLER_IDS[0];

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
  expect(screen.getByRole('switch')).toBeOnTheScreen();
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
    member: { ...me.member, role: 'seller' },
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

describe('switching the acting member', () => {
  const withPin = async () => {
    const members = await storeApi.listMembers();
    jest
      .spyOn(storeApi, 'listMembers')
      .mockResolvedValue(
        members.map((m) =>
          m.display_name === 'Bà nội' ? { ...m, has_pin: true } : m,
        ),
      );
  };
  const type = async (digits: string) => {
    for (const digit of digits) {
      await fireEvent.press(screen.getByRole('button', { name: digit }));
    }
  };
  const SWITCH = 'Chuyển sang Bà nội';

  test('shows who is acting and a switch action for each other member only', async () => {
    await open();
    expect(screen.getByText('Đang dùng: Cô Ba')).toBeOnTheScreen();
    expect(
      await screen.findByRole('button', { name: SWITCH }),
    ).toBeOnTheScreen();
    expect(
      screen.getByRole('button', { name: 'Chuyển sang Chú Tư' }),
    ).toBeOnTheScreen();
    expect(
      screen.queryByRole('button', { name: 'Chuyển sang Cô Ba' }),
    ).toBeNull();
  });

  test('a member without a PIN is switched to at once', async () => {
    const spy = jest.spyOn(authApi, 'switchMember').mockResolvedValue();
    await open();
    await fireEvent.press(await screen.findByRole('button', { name: SWITCH }));
    expect(spy).toHaveBeenCalledWith({ member_id: SELLER_ID });
    expect(screen.queryByTestId('sheet-panel')).toBeNull();
  });

  test('a member with a PIN asks for it on a keypad, then switches and closes', async () => {
    await withPin();
    const spy = jest.spyOn(authApi, 'switchMember').mockResolvedValue();
    await open();
    await fireEvent.press(await screen.findByRole('button', { name: SWITCH }));
    expect(spy).not.toHaveBeenCalled();
    expect(
      await screen.findByRole('header', { name: 'Mã PIN của Bà nội' }),
    ).toBeOnTheScreen();
    // 4 digits needed before the check button works; the digits are never shown.
    expect(screen.getByRole('button', { name: 'Xác nhận' })).toBeDisabled();
    await type('0123');
    expect(screen.getByLabelText('4 chữ số đã nhập')).toBeOnTheScreen();
    expect(screen.queryByText(/^0123$/)).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Xác nhận' }));
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith({ member_id: SELLER_ID, pin: '0123' }),
    );
    await waitFor(() => expect(screen.queryByTestId('sheet-panel')).toBeNull());
  });

  test('delete removes a digit and a PIN holds at most 6', async () => {
    await withPin();
    await open();
    await fireEvent.press(await screen.findByRole('button', { name: SWITCH }));
    await type('12345678');
    expect(screen.getByLabelText('6 chữ số đã nhập')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Xóa' }));
    expect(screen.getByLabelText('5 chữ số đã nhập')).toBeOnTheScreen();
  });

  test('a wrong PIN (401) is explained and the sheet stays open', async () => {
    await withPin();
    jest
      .spyOn(authApi, 'switchMember')
      .mockRejectedValue(
        new ApiError(401, { error: 'bad', code: 'invalid_pin' }),
      );
    await open();
    await fireEvent.press(await screen.findByRole('button', { name: SWITCH }));
    await type('9999');
    await fireEvent.press(screen.getByRole('button', { name: 'Xác nhận' }));
    expect(await screen.findByText('Mã PIN không đúng')).toBeOnTheScreen();
    expect(screen.getByTestId('sheet-panel')).toBeOnTheScreen();
  });

  test('too many tries (429) tells how long to wait', async () => {
    await withPin();
    jest
      .spyOn(authApi, 'switchMember')
      .mockRejectedValue(
        new ApiError(
          429,
          { error: 'slow down', code: 'rate_limited' },
          240_000,
        ),
      );
    await open();
    await fireEvent.press(await screen.findByRole('button', { name: SWITCH }));
    await type('9999');
    await fireEvent.press(screen.getByRole('button', { name: 'Xác nhận' }));
    expect(
      await screen.findByText('Nhập sai quá nhiều lần. Thử lại sau 4 phút'),
    ).toBeOnTheScreen();
  });

  test('any other failure of a PIN-less switch shows a message under the members', async () => {
    jest.spyOn(authApi, 'switchMember').mockRejectedValue(new Error('offline'));
    await open();
    await fireEvent.press(await screen.findByRole('button', { name: SWITCH }));
    expect(await screen.findByText('Không chuyển được')).toBeOnTheScreen();
  });

  test('closing the PIN sheet forgets the error', async () => {
    await withPin();
    jest
      .spyOn(authApi, 'switchMember')
      .mockRejectedValue(new ApiError(401, { error: 'bad' }));
    await open();
    await fireEvent.press(await screen.findByRole('button', { name: SWITCH }));
    await type('1111');
    await fireEvent.press(screen.getByRole('button', { name: 'Xác nhận' }));
    await screen.findByText('Mã PIN không đúng');
    await fireEvent.press(screen.getByTestId('sheet-scrim'));
    expect(screen.queryByText('Mã PIN không đúng')).toBeNull();
  });
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
    const spy = jest.spyOn(authApi, 'setPin').mockResolvedValue();
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
    const spy = jest.spyOn(authApi, 'setPin').mockResolvedValue();
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
    jest.spyOn(authApi, 'setPin').mockRejectedValue(new Error('offline'));
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
    jest
      .spyOn(storeApi, 'getMe')
      .mockResolvedValue({ ...me, member: { ...me.member, role: 'seller' } });
    await open();
    expect(screen.queryByText('Ngưỡng sắp hết hàng')).toBeNull();
  });
});
