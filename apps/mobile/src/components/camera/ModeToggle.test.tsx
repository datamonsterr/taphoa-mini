import { fireEvent, screen } from '@testing-library/react-native';

import { renderWithProviders } from '@/test/render';

import { ModeToggle } from './ModeToggle';

describe('ModeToggle', () => {
  it('marks the current mode as selected', async () => {
    await renderWithProviders(
      <ModeToggle mode="object" onChange={jest.fn()} />,
    );
    expect(screen.getByRole('button', { name: 'Vật phẩm' })).toBeSelected();
    expect(
      screen.getByRole('button', { name: 'Mã vạch/QR' }),
    ).not.toBeSelected();
  });

  it('marks many as selected', async () => {
    await renderWithProviders(<ModeToggle mode="code" onChange={jest.fn()} />);
    expect(screen.getByRole('button', { name: 'Mã vạch/QR' })).toBeSelected();
  });

  it('calls onChange with the tapped mode', async () => {
    const onChange = jest.fn();
    await renderWithProviders(<ModeToggle mode="object" onChange={onChange} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Mã vạch/QR' }));
    expect(onChange).toHaveBeenCalledWith('code');
    await fireEvent.press(screen.getByRole('button', { name: 'Vật phẩm' }));
    expect(onChange).toHaveBeenCalledWith('object');
  });
});
