import { fireEvent, screen } from '@testing-library/react-native';
import { Dimensions, StyleSheet } from 'react-native';

import { renderWithProviders } from '@/test/render';

import {
  ENROLL_SHEET_HEIGHT,
  enrollKeyDiameter,
  ProductForm,
  QUICK_ENROLL_SHEET_HEIGHT,
} from './ProductForm';

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

it('renders optional header title with header accessibility role', async () => {
  await renderWithProviders(
    <ProductForm
      photos={[{ id: 'one', uri: 'file:///one.jpg' }]}
      maxPhotos={5}
      title="Thêm hàng nhanh · 3/3"
      onAddPhoto={jest.fn()}
      onSave={jest.fn()}
      saving={false}
      onClose={jest.fn()}
    />,
  );
  expect(
    screen.getByRole('header', { name: 'Thêm hàng nhanh · 3/3' }),
  ).toBeOnTheScreen();
});

it('raises Sheet height when title is set to fit quick enroll without scrolling', async () => {
  const tallMetrics = {
    frame: { x: 0, y: 0, width: 411, height: 914 },
    insets: { top: 24, left: 0, right: 0, bottom: 0 },
  };
  const { unmount } = await renderWithProviders(
    <ProductForm
      photos={[{ id: 'one', uri: 'file:///one.jpg' }]}
      maxPhotos={5}
      onAddPhoto={jest.fn()}
      onSave={jest.fn()}
      saving={false}
      onClose={jest.fn()}
    />,
    undefined,
    tallMetrics,
  );
  expect(
    StyleSheet.flatten(screen.getByTestId('sheet-panel').props.style).height,
  ).toBe(ENROLL_SHEET_HEIGHT);
  unmount();

  await renderWithProviders(
    <ProductForm
      photos={[{ id: 'one', uri: 'file:///one.jpg' }]}
      maxPhotos={5}
      title="Thêm hàng nhanh · 3/3"
      onAddPhoto={jest.fn()}
      onSave={jest.fn()}
      saving={false}
      onClose={jest.fn()}
    />,
    undefined,
    tallMetrics,
  );
  expect(
    StyleSheet.flatten(screen.getByTestId('sheet-panel').props.style).height,
  ).toBe(QUICK_ENROLL_SHEET_HEIGHT);
});

describe('short windows', () => {
  const short = {
    frame: { x: 0, y: 0, width: 411, height: 740 },
    insets: { top: 24, left: 0, right: 0, bottom: 0 },
  };
  afterEach(() => jest.restoreAllMocks());

  it('shrinks the sheet and the keys so the last keypad row stays inside it', async () => {
    jest.spyOn(Dimensions, 'get').mockReturnValue({
      width: 411,
      height: 740,
      scale: 2,
      fontScale: 1,
    });
    await renderWithProviders(
      <ProductForm
        photos={[{ id: 'one', uri: 'file:///one.jpg' }]}
        maxPhotos={5}
        onAddPhoto={jest.fn()}
        onSave={jest.fn()}
        saving={false}
        onClose={jest.fn()}
      />,
      undefined,
      short,
    );
    const sheet = StyleSheet.flatten(
      screen.getByTestId('sheet-panel').props.style,
    ).height;
    expect(sheet).toBe(740 - 24 - 8);
    const key = StyleSheet.flatten(
      screen.getByRole('button', { name: '000' }).props.style,
    );
    // Four key rows, three gaps and the form above them must fit the sheet.
    expect(key.height * 4 + 36 + 450).toBeLessThanOrEqual(sheet);
    expect(key.height).toBeLessThan(76);
    expect(screen.getByRole('button', { name: '0' })).toBeOnTheScreen();
  });

  it('keeps board-size keys when the window is tall', () => {
    expect(enrollKeyDiameter(ENROLL_SHEET_HEIGHT, 0, false)).toBe(76);
    expect(enrollKeyDiameter(300, 0, false)).toBe(48);
  });
});
