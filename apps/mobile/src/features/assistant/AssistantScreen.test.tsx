import { render, screen } from '@testing-library/react-native';

import { AssistantScreen } from './AssistantScreen';

test('placeholder screen shows the title', async () => {
  await render(<AssistantScreen />);
  expect(screen.getByText('Trợ lý')).toBeTruthy();
});
