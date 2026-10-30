import { fireEvent, screen } from '@testing-library/react-native';
import { ApiError } from '@/lib/api/errors';
import * as storeApi from '@/lib/api/store';
import { CreateStoreScreen } from './CreateStoreScreen';
import { renderWithProviders } from '@/test/render';
import { setApiTransport } from '@/lib/api/client';
import { testSession } from '@/test/session';
import { useCurrentStore } from '@/stores/currentStore';

jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: jest.fn(), back: jest.fn() }),
}));

test('creates with a Clerk bearer, defaults the profile name, and selects the new store', async () => {
  const membership = testSession();
  const sent: Request[] = [];
  setApiTransport((async (r: Request) => {
    if (r.method === 'POST') {
      sent.push(r);
      return Response.json(membership, { status: 201 });
    }
    return Response.json({
      clerk_user_id: 'user_test',
      profile: { display_name: 'Mẹ', email: 'me@example.com' },
      memberships: [],
    });
  }) as typeof fetch);
  await renderWithProviders(<CreateStoreScreen />);
  await fireEvent.changeText(
    await screen.findByTestId('create-store-name'),
    '  Tạp hóa Mẹ  ',
  );
  await fireEvent.press(screen.getByTestId('create-store-submit'));
  expect(await screen.findByTestId('create-store-submit')).toBeOnTheScreen();
  expect(sent).toHaveLength(1);
  expect(await sent[0]!.json()).toEqual({
    store_name: 'Tạp hóa Mẹ',
    display_name: 'Mẹ',
  });
  expect(sent[0]!.headers.get('authorization')).toBe('Bearer test-clerk-token');
  expect(useCurrentStore.getState().storeIds.user_test).toBe(
    membership.store.id,
  );
});

test('includes an optional VietQR account when creating the store', async () => {
  const membership = testSession();
  const create = jest
    .spyOn(storeApi, 'createStore')
    .mockResolvedValue(membership);
  await renderWithProviders(<CreateStoreScreen />);
  await fireEvent.changeText(
    await screen.findByTestId('create-store-name'),
    'Tạp hóa',
  );
  await fireEvent.changeText(screen.getByTestId('create-display-name'), 'Mẹ');
  await fireEvent.changeText(screen.getByTestId('create-bank-name'), 'vietcom');
  await fireEvent.press(screen.getByRole('button', { name: 'Vietcombank' }));
  await fireEvent.changeText(
    screen.getByTestId('create-bank-number'),
    '0123456789',
  );
  await fireEvent.changeText(
    screen.getByTestId('create-bank-holder'),
    'Nguyễn Thị Ba',
  );
  await fireEvent.press(screen.getByTestId('create-store-submit'));
  expect(create).toHaveBeenCalledWith({
    store_name: 'Tạp hóa',
    display_name: 'Mẹ',
    bank_account: {
      bank_bin: '970436',
      bank_short_name: 'VCB',
      account_number: '0123456789',
      account_name: 'NGUYEN THI BA',
    },
  });
  create.mockRestore();
});

afterEach(() => jest.restoreAllMocks());

test('validates required names and a partial optional bank account before posting', async () => {
  const create = jest.spyOn(storeApi, 'createStore');
  await renderWithProviders(<CreateStoreScreen />);
  await fireEvent.changeText(screen.getByTestId('create-display-name'), '');
  await fireEvent.press(screen.getByTestId('create-store-submit'));
  expect(
    screen.getByText('Nhập tên cửa hàng (tối đa 80 ký tự)'),
  ).toBeOnTheScreen();
  expect(
    screen.getByText('Nhập tên của bạn (tối đa 40 ký tự)'),
  ).toBeOnTheScreen();
  expect(create).not.toHaveBeenCalled();
  await fireEvent.changeText(
    screen.getByTestId('create-store-name'),
    'Tạp hóa',
  );
  await fireEvent.changeText(screen.getByTestId('create-display-name'), 'Mẹ');
  await fireEvent.changeText(
    screen.getByTestId('create-bank-number'),
    '0123456789',
  );
  await fireEvent.press(screen.getByTestId('create-store-submit'));
  expect(
    screen.getByText(
      'Chọn ngân hàng, nhập số tài khoản 4–19 ký tự và chủ tài khoản.',
    ),
  ).toBeOnTheScreen();
  expect(create).not.toHaveBeenCalled();
});
test.each([
  [400, 'Thông tin chưa hợp lệ.'],
  [401, 'Phiên đăng nhập đã hết hạn. Hãy đăng xuất rồi đăng nhập lại.'],
  [403, 'Tài khoản này không có quyền làm việc này.'],
  [409, 'Có lỗi xảy ra. Thử lại.'],
  [429, 'Thử quá nhiều lần. Đợi một lúc rồi thử lại.'],
  [503, 'Máy chủ đang bận. Thử lại sau.'],
])(
  'keeps create form and allows retry after HTTP %s',
  async (status, message) => {
    const create = jest
      .spyOn(storeApi, 'createStore')
      .mockRejectedValueOnce(
        new ApiError(status as number, { error: 'failure' }),
      );
    await renderWithProviders(<CreateStoreScreen />);
    await fireEvent.changeText(
      screen.getByTestId('create-store-name'),
      'Tạp hóa',
    );
    await fireEvent(screen.getByTestId('create-display-name'), 'submitEditing');
    expect(await screen.findByText(message)).toBeOnTheScreen();
    expect(screen.getByTestId('create-store-submit')).toBeEnabled();
    expect(screen.getByTestId('create-store-name')).toHaveProp(
      'value',
      'Tạp hóa',
    );
    create.mockRestore();
  },
);
test('a network failure keeps the create draft', async () => {
  jest
    .spyOn(storeApi, 'createStore')
    .mockRejectedValueOnce(new TypeError('offline'));
  await renderWithProviders(<CreateStoreScreen />);
  await fireEvent.changeText(
    screen.getByTestId('create-store-name'),
    'Tạp hóa',
  );
  await fireEvent.press(screen.getByTestId('create-store-submit'));
  expect(
    await screen.findByText(
      'Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.',
    ),
  ).toBeOnTheScreen();
});
