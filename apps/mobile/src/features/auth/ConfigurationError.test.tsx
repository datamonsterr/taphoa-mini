import { render } from '@testing-library/react-native';

import { ConfigurationError } from './ConfigurationError';

test('names the missing Clerk key by default', async () => {
  const view = await render(<ConfigurationError />);
  expect(view.getByText(/EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY/)).toBeTruthy();
});

test('tells the person to install a new build when the backend URL is missing', async () => {
  const view = await render(<ConfigurationError missing="api" />);
  expect(view.getByTestId('auth-configuration-error')).toBeTruthy();
  expect(
    view.getByText('Ứng dụng chưa được cấu hình máy chủ. Hãy cài bản mới.'),
  ).toBeTruthy();
});
