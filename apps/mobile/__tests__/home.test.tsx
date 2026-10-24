import { CameraScreen } from '@/features/camera/CameraScreen';

import Index from '../src/app';

test('index route is the camera screen', () => {
  expect(Index).toBe(CameraScreen);
});
