import type { ComponentType } from 'react';

import { renderWithProviders } from '@/test/render';

import { AccountScreen } from './account/AccountScreen';
import { CloseScreen } from './close/CloseScreen';
import { DashboardScreen } from './dashboard/DashboardScreen';
import { ExpenseScreen } from './expense/ExpenseScreen';

const screens: [string, ComponentType][] = [
  ['Báo cáo', DashboardScreen],
  ['Thêm chi phí', ExpenseScreen],
  ['Chốt sổ', CloseScreen],
  ['Tạp hóa Cô Ba', AccountScreen],
];

test.each(screens)('screen %s has a header', async (title, Screen) => {
  const { findByRole } = await renderWithProviders(<Screen />);
  expect(await findByRole('header', { name: title })).toBeOnTheScreen();
});
