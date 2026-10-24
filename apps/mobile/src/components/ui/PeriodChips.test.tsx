import { fireEvent, screen } from '@testing-library/react-native';

import { renderWithProviders } from '@/test/render';

import { PeriodChips } from './PeriodChips';

test('pressed chip is checked, others are not', async () => {
  await renderWithProviders(<PeriodChips value="week" onChange={jest.fn()} />);
  expect(screen.getByLabelText('Khoảng thời gian')).toHaveProp(
    'accessibilityRole',
    'radiogroup',
  );
  expect(screen.getByRole('radio', { name: 'Tuần' })).toBeChecked();
  expect(screen.getByRole('radio', { name: 'Ngày' })).not.toBeChecked();
  expect(screen.getByRole('radio', { name: 'Tháng' })).not.toBeChecked();
});

test('tapping a chip reports its period', async () => {
  const onChange = jest.fn();
  await renderWithProviders(<PeriodChips value="day" onChange={onChange} />);
  await fireEvent.press(screen.getByRole('radio', { name: 'Tháng' }));
  expect(onChange).toHaveBeenCalledWith('month');
});

test('labels override the visible words and group name', async () => {
  await renderWithProviders(
    <PeriodChips
      value="day"
      onChange={jest.fn()}
      labels={{ group: 'Range', day: 'Day', week: 'Week', month: 'Month' }}
    />,
  );
  expect(screen.getByLabelText('Range')).toBeOnTheScreen();
  expect(screen.getByRole('radio', { name: 'Week' })).toBeOnTheScreen();
  expect(screen.getByText('Month')).toBeOnTheScreen();
  expect(screen.queryByText('Tuần')).toBeNull();
});
