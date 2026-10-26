import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { setAnalyticsSink } from '@/lib/analytics';
import { getApiClient } from '@/lib/api/client';
import { renderWithProviders } from '@/test/render';

import { FeedbackButtons } from './FeedbackButtons';

const sink = { capture: jest.fn() };
beforeEach(() => {
  sink.capture.mockClear();
  setAnalyticsSink(sink);
});
afterEach(() => {
  setAnalyticsSink(null);
  jest.restoreAllMocks();
});

async function storedMessageId() {
  const client = getApiClient();
  const thread = await client.raw.POST('/v1/assistant/threads', { body: {} });
  const sent = await client.sendAssistantMessage(thread.data!.id, {
    content: 'hi',
    language: 'vi',
  });
  for await (const event of sent.events!) void event;
  const detail = await client.raw.GET('/v1/assistant/threads/{threadId}', {
    params: { path: { threadId: thread.data!.id } },
  });
  return detail.data!.messages[1].id;
}

test('thumbs up posts feedback and reports the rating', async () => {
  const id = await storedMessageId();
  const onChange = jest.fn();
  await renderWithProviders(
    <FeedbackButtons messageId={id} rating={null} onChange={onChange} />,
  );
  await fireEvent.press(screen.getByTestId('feedback-up'));
  expect(onChange).toHaveBeenCalledWith('up');
  await waitFor(() =>
    expect(sink.capture).toHaveBeenCalledWith('assistant_feedback_given', {
      rating: 'up',
    }),
  );
});

test('thumbs down reports down and shows the selected state', async () => {
  const id = await storedMessageId();
  const onChange = jest.fn();
  await renderWithProviders(
    <FeedbackButtons messageId={id} rating="up" onChange={onChange} />,
  );
  expect(
    screen.getByTestId('feedback-up').props.accessibilityState,
  ).toMatchObject({ selected: true });
  await fireEvent.press(screen.getByTestId('feedback-down'));
  expect(onChange).toHaveBeenCalledWith('down');
});

test('pressing the selected thumb clears it locally without a request', async () => {
  const post = jest.spyOn(getApiClient().raw, 'POST');
  const onChange = jest.fn();
  await renderWithProviders(
    <FeedbackButtons messageId="m1" rating="down" onChange={onChange} />,
  );
  await fireEvent.press(screen.getByTestId('feedback-down'));
  expect(onChange).toHaveBeenCalledWith(null);
  expect(post).not.toHaveBeenCalled();
});

test('a failed request restores the previous rating', async () => {
  const onChange = jest.fn();
  await renderWithProviders(
    <FeedbackButtons
      messageId="00000000-0000-4000-8000-000000000000"
      rating={null}
      onChange={onChange}
    />,
  );
  await fireEvent.press(screen.getByTestId('feedback-up'));
  await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(null));
  expect(onChange).toHaveBeenCalledWith('up');
});
