import { fireEvent, screen } from '@testing-library/react-native';

import { renderWithProviders } from '@/test/render';

import { ProductForm } from './ProductForm';

it('edits metadata, manages photos and saves name and keypad price', async () => {
  const onSave = jest.fn();
  const onAddPhoto = jest.fn();
  const onRemovePhoto = jest.fn();
  await renderWithProviders(
    <ProductForm
      photos={[{ id: 'one', uri: 'file:///one.jpg' }]}
      maxPhotos={5}
      onAddPhoto={onAddPhoto}
      onRemovePhoto={onRemovePhoto}
      onSave={onSave}
      saving={false}
      onClose={jest.fn()}
    />,
  );
  expect(screen.getByLabelText('Lưu vào kho và thêm vào giỏ')).toBeDisabled();
  await fireEvent.changeText(
    screen.getByLabelText('Tên (không bắt buộc)'),
    '  Sữa  ',
  );
  await fireEvent.press(screen.getByRole('button', { name: '1' }));
  await fireEvent.press(screen.getByRole('button', { name: '000' }));
  await fireEvent.press(screen.getByLabelText('Lưu vào kho và thêm vào giỏ'));
  expect(onSave).toHaveBeenCalledWith({ name: 'Sữa', price: 1000 });
  await fireEvent.press(screen.getByLabelText('Thêm ảnh góc khác'));
  expect(onAddPhoto).toHaveBeenCalledTimes(1);
  await fireEvent.press(screen.getByLabelText('Xóa ảnh 1'));
  expect(onRemovePhoto).toHaveBeenCalledWith('one');
});

it('reports edits so duplicate resolution can use the latest metadata', async () => {
  const onValuesChange = jest.fn();
  await renderWithProviders(
    <ProductForm
      photos={[{ id: 'one', uri: 'file:///one.jpg' }]}
      maxPhotos={5}
      onAddPhoto={jest.fn()}
      onSave={jest.fn()}
      saving={false}
      onClose={jest.fn()}
      onValuesChange={onValuesChange}
    />,
  );
  await fireEvent.changeText(
    screen.getByLabelText('Tên (không bắt buộc)'),
    'Bánh',
  );
  await fireEvent.press(screen.getByRole('button', { name: '5' }));
  expect(onValuesChange).toHaveBeenLastCalledWith({ name: 'Bánh', price: 5 });
});

it('hides the camera tile at capacity and blocks save while saving', async () => {
  const onSave = jest.fn();
  await renderWithProviders(
    <ProductForm
      photos={[{ id: 'one', uri: 'file:///one.jpg' }]}
      maxPhotos={1}
      onAddPhoto={jest.fn()}
      onSave={onSave}
      saving
      onClose={jest.fn()}
      initialName="Sữa"
      initialPrice="12000"
    />,
  );
  expect(screen.queryByLabelText('Thêm ảnh góc khác')).toBeNull();
  expect(screen.getByLabelText('Giá bán')).toHaveTextContent('12.000đ');
  expect(screen.getByLabelText('Lưu vào kho và thêm vào giỏ')).toBeDisabled();
  await fireEvent.press(screen.getByLabelText('Lưu vào kho và thêm vào giỏ'));
  expect(onSave).not.toHaveBeenCalled();
});
