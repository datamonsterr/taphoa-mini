import { fireEvent, screen } from '@testing-library/react-native';

import { camera, colors } from '@/theme';
import { renderWithProviders } from '@/test/render';

import { AlternativesStrip } from './AlternativesStrip';
import { StripChip } from './StripChip';

const items = [
  { id: 'a', name: 'Sting đỏ', price: 10000 },
  { id: 'b', name: 'Sting vàng', price: 10000, thumbnailUri: 'file:///b.jpg' },
  { id: 'c', name: 'Coca Zero', price: 11000 },
];

describe('StripChip', () => {
  it('current: white chip with accent ring, checked', async () => {
    await renderWithProviders(
      <StripChip name="Sting đỏ" price={10000} current onPress={jest.fn()} />,
    );
    const chip = screen.getByRole('radio', { name: 'Sting đỏ 10.000đ' });
    expect(chip).toBeChecked();
    expect(chip).toHaveStyle({
      backgroundColor: camera.white,
      borderColor: colors.accent,
      borderWidth: 3,
      height: 64,
    });
  });

  it('alternative: dark chip, unchecked, press fires', async () => {
    const onPress = jest.fn();
    await renderWithProviders(
      <StripChip
        name="Sting vàng"
        price={10000}
        thumbnailUri="file:///b.jpg"
        onPress={onPress}
      />,
    );
    const chip = screen.getByRole('radio', { name: 'Sting vàng 10.000đ' });
    expect(chip).not.toBeChecked();
    expect(chip).toHaveStyle({ backgroundColor: camera.chipDark });
    expect(screen.getByTestId('chip-thumb')).toBeOnTheScreen();
    await fireEvent.press(chip);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('falls back to a placeholder when there is no thumbnail', async () => {
    await renderWithProviders(
      <StripChip name="X" price={1000} onPress={jest.fn()} />,
    );
    expect(screen.queryByTestId('chip-thumb')).toBeNull();
    expect(screen.getByTestId('chip-placeholder')).toBeOnTheScreen();
  });
});

describe('AlternativesStrip', () => {
  it('lists chips in a labelled radio group, current checked', async () => {
    await renderWithProviders(
      <AlternativesStrip
        items={items}
        currentId="a"
        placement="below"
        onChoose={jest.fn()}
      />,
    );
    expect(screen.getByLabelText('Chọn đúng món')).toHaveProp(
      'accessibilityRole',
      'radiogroup',
    );
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    expect(
      screen.getByRole('radio', { name: 'Sting đỏ 10.000đ' }),
    ).toBeChecked();
    expect(
      screen.getByRole('radio', { name: 'Coca Zero 11.000đ' }),
    ).not.toBeChecked();
  });

  it('calls onChoose with the id', async () => {
    const onChoose = jest.fn();
    await renderWithProviders(
      <AlternativesStrip
        items={items}
        currentId="a"
        placement="below"
        onChoose={onChoose}
      />,
    );
    await fireEvent.press(
      screen.getByRole('radio', { name: 'Coca Zero 11.000đ' }),
    );
    expect(onChoose).toHaveBeenCalledWith('c');
  });

  it('below: full-width row with side padding', async () => {
    await renderWithProviders(
      <AlternativesStrip
        items={items}
        currentId="a"
        placement="below"
        onChoose={jest.fn()}
      />,
    );
    expect(screen.getByTestId('alternatives-strip')).not.toHaveStyle({
      position: 'absolute',
    });
  });

  it('floating: absolutely positioned at top', async () => {
    await renderWithProviders(
      <AlternativesStrip
        items={items}
        currentId="a"
        placement="floating"
        top={204}
        onChoose={jest.fn()}
      />,
    );
    expect(screen.getByTestId('alternatives-strip')).toHaveStyle({
      position: 'absolute',
      top: 204,
      left: 0,
    });
  });
});
