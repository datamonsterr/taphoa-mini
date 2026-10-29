import { fireEvent, screen, within } from '@testing-library/react-native';

import { renderWithProviders } from '@/test/render';
import { colors } from '@/theme';

import { DraftLineRow } from './DraftLineRow';
import type { DraftLine } from './draft';

const flat = (node: { props: { style?: unknown } }) =>
  Object.assign({}, ...[node.props.style].flat(5).filter(Boolean));

const coca = { id: 'p1', name: 'Coca', price: 10000 };
const pepsi = { id: 'p2', name: 'Pepsi', price: 9000 };
const base: DraftLine = {
  id: 'l1',
  utteranceId: 'u1',
  spoken: 'coca',
  status: 'matched',
  product: coca,
  candidates: [],
  unitId: null,
  quantity: 2,
  unitPrice: 10000,
  priceSource: 'catalog',
  priceMismatch: false,
  removed: false,
  original: { productId: 'p1', quantity: 2, unitPrice: 10000 },
};

const handlers = () => ({
  onIncrement: jest.fn(),
  onDecrement: jest.fn(),
  onRemove: jest.fn(),
  onToggleCandidates: jest.fn(),
  onPick: jest.fn(),
  onEditPrice: jest.fn(),
  onSearch: jest.fn(),
});

async function row(line: Partial<DraftLine>, expanded = false) {
  const h = handlers();
  await renderWithProviders(
    <DraftLineRow line={{ ...base, ...line }} expanded={expanded} {...h} />,
  );
  return h;
}

test('a matched line shows the product, price, quantity and a green check', async () => {
  await row({});
  expect(screen.getByText('Coca')).toBeOnTheScreen();
  expect(screen.getByText('10.000đ')).toBeOnTheScreen();
  expect(screen.getByLabelText('Số lượng 2')).toBeOnTheScreen();
  expect(screen.getByLabelText('Khớp')).toBeOnTheScreen();
  expect(screen.getByTestId('icon-Check')).toBeOnTheScreen();
});

test('the stepper, trash and price call back with the line id', async () => {
  const h = await row({});
  await fireEvent.press(screen.getByLabelText('Thêm một'));
  await fireEvent.press(screen.getByLabelText('Bớt một'));
  await fireEvent.press(screen.getByTestId('voice-line-l1-price'));
  expect(h.onIncrement).toHaveBeenCalledWith('l1');
  expect(h.onDecrement).toHaveBeenCalledWith('l1');
  expect(h.onEditPrice).toHaveBeenCalledWith('l1');
});

test('quantity 1 turns the minus into the trash', async () => {
  const h = await row({ quantity: 1 });
  await fireEvent.press(screen.getByLabelText('Xóa món'));
  expect(h.onRemove).toHaveBeenCalledWith('l1');
});

test('a price mismatch is red with a pill', async () => {
  await row({ unitPrice: 12000, priceMismatch: true });
  expect(flat(screen.getByText('12.000đ')).color).toBe(colors.danger);
  expect(
    screen.getByLabelText('Giá bạn nói khác giá bán trong kho'),
  ).toBeOnTheScreen();
  expect(screen.getByText('Giá khác giá bán')).toBeOnTheScreen();
});

test('a line without a price asks for one', async () => {
  const h = await row({ unitPrice: null, priceSource: 'none' });
  await fireEvent.press(screen.getAllByText('Nhập giá')[0]!);
  expect(h.onEditPrice).toHaveBeenCalledWith('l1');
});

test('an ambiguous line is amber, its ? opens the candidates and a pick calls back', async () => {
  const h = await row(
    { status: 'ambiguous', product: pepsi, candidates: [pepsi, coca] },
    true,
  );
  expect(screen.getByText('?')).toBeOnTheScreen();
  expect(
    flat(screen.getByTestId('voice-line-l1').children[0] as never)
      .backgroundColor,
  ).toBe(colors.warningSoft);
  await fireEvent.press(screen.getByLabelText('Chưa chắc, chọn đúng món'));
  expect(h.onToggleCandidates).toHaveBeenCalledWith('l1');
  const strip = screen.getByTestId('alternatives-strip');
  await fireEvent.press(within(strip).getByLabelText('Coca 10.000đ'));
  expect(h.onPick).toHaveBeenCalledWith('l1', 'p1');
});

test('the candidate strip stays closed until expanded', async () => {
  await row({ status: 'ambiguous', product: pepsi, candidates: [pepsi, coca] });
  expect(screen.queryByTestId('alternatives-strip')).toBeNull();
});

test('an unknown line shows the spoken words and a tag that opens the catalog search', async () => {
  const h = await row({
    status: 'unknown',
    product: null,
    spoken: 'gạo ST25',
    unitPrice: 35000,
  });
  expect(screen.getByText('gạo ST25')).toBeOnTheScreen();
  expect(screen.getByTestId('icon-Tag')).toBeOnTheScreen();
  await fireEvent.press(
    screen.getByLabelText('Chưa có trong kho, bán theo giá đã nói'),
  );
  expect(h.onSearch).toHaveBeenCalledWith('l1');
});
