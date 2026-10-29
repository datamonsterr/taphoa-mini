import { Home } from '@/features/home/Home';

import Index from '../src/app';

test('index route is the start screen: camera, or the grid in elder mode', () => {
  expect(Index).toBe(Home);
});
