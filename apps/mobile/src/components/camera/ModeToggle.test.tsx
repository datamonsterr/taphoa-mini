import { fireEvent, screen } from '@testing-library/react-native';

import { renderWithProviders } from '@/test/render';

import { ModeToggle } from './ModeToggle';

describe('ModeToggle', () => {
  it('marks the current mode as selected', async () => {
    await renderWithProviders(<ModeToggle mode="one" onChange={jest.fn()} />);
    expect(screen.getByRole('button', { name: 'Một món' })).toBeSelected();
    expect(
      screen.getByRole('button', { name: 'Nhiều món' }),
    ).not.toBeSelected();
  });

  it('marks many as selected', async () => {
    await renderWithProviders(<ModeToggle mode="many" onChange={jest.fn()} />);
    expect(screen.getByRole('button', { name: 'Nhiều món' })).toBeSelected();
  });

  it('calls onChange with the tapped mode', async () => {
    const onChange = jest.fn();
    await renderWithProviders(<ModeToggle mode="one" onChange={onChange} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Nhiều món' }));
    expect(onChange).toHaveBeenCalledWith('many');
    await fireEvent.press(screen.getByRole('button', { name: 'Một món' }));
    expect(onChange).toHaveBeenCalledWith('one');
  });
});
