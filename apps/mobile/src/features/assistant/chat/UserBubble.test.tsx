import { render, screen } from '@testing-library/react-native';

import { useSettingsStore } from '@/stores/settings';

import type { UserChatMessage } from '../chatReducer';
import { UserBubble } from './UserBubble';

const message: UserChatMessage = {
  kind: 'user',
  id: 'u1',
  content: 'Doanh thu hôm nay?',
  attachments: [],
  status: 'sent',
};

test('shows the user text', async () => {
  await render(<UserBubble message={message} />);
  expect(screen.getByText('Doanh thu hôm nay?')).toBeTruthy();
  expect(screen.queryByText('Không gửi được')).toBeNull();
});

test('marks a message that failed to send', async () => {
  await render(<UserBubble message={{ ...message, status: 'failed' }} />);
  expect(screen.getByText('Không gửi được')).toBeTruthy();
});

test('marks a failed message in English', async () => {
  useSettingsStore.setState({ language: 'en' });
  await render(<UserBubble message={{ ...message, status: 'failed' }} />);
  expect(screen.getByText('Not sent')).toBeTruthy();
});
