import * as imagesApi from '@/lib/api/images';
import { listProducts } from '@/lib/api';
import { useCartStore } from '@/stores/cart';
import {
  fireEvent,
  renderApp,
  screen,
  testRouter,
  waitFor,
} from '@/test/router';

beforeEach(() => {
  // Node's FormData rejects RN `{ uri }` file parts, so send a Blob instead.
  const real = imagesApi.uploadImage;
  jest
    .spyOn(imagesApi, 'uploadImage')
    .mockImplementation((_file, purpose) =>
      real(new Blob(['x'], { type: 'image/jpeg' }), purpose),
    );
});

it('enrolls a captured photo: price on the keypad, save, product exists and is in the cart', async () => {
  await renderApp('/');
  await testRouter.push(
    `/enroll?photoUri=${encodeURIComponent('file:///captured.jpg')}`,
  );
  expect(screen).toHavePathname('/enroll');

  const save = () =>
    screen.getByRole('button', { name: 'Lưu vào kho và thêm vào giỏ' });
  expect(save()).toBeDisabled();

  await fireEvent.changeText(
    screen.getByLabelText('Tên (không bắt buộc)'),
    'Kẹo dừa',
  );
  for (const key of ['2', '5', '000']) {
    await fireEvent.press(screen.getByRole('button', { name: key }));
  }
  expect(screen.getByLabelText('Giá bán')).toHaveTextContent('25.000đ');
  await fireEvent.press(save());

  await waitFor(() => expect(screen).toHavePathname('/'));

  const { items } = await listProducts({ q: 'Kẹo dừa' });
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ name: 'Kẹo dừa', price: 25000 });
  expect(useCartStore.getState().lines).toEqual([
    expect.objectContaining({
      productId: items[0].id,
      name: 'Kẹo dừa',
      price: 25000,
      qty: 1,
    }),
  ]);
});
