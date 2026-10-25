import { capture, setAnalyticsSink } from './analytics';
import type { AppEventName } from './analytics';

describe('product analytics', () => {
  afterEach(() => setAnalyticsSink(null));

  test('default sink does nothing and does not throw', () => {
    expect(() => capture('signed_out', { method: 'email_code' })).not.toThrow();
  });

  test('forwards event name and props exactly', () => {
    const sink = { capture: jest.fn() };
    const props = { entry: 'button' as const };
    setAnalyticsSink(sink);

    capture('assistant_opened', props);

    expect(sink.capture).toHaveBeenCalledWith('assistant_opened', props);
  });

  test('null restores the no-op sink', () => {
    const sink = { capture: jest.fn() };
    setAnalyticsSink(sink);
    setAnalyticsSink(null);

    capture('signed_out', { method: 'google' });

    expect(sink.capture).not.toHaveBeenCalled();
  });

  test('drops sink errors', () => {
    setAnalyticsSink({
      capture: () => {
        throw new Error('sink failure');
      },
    });

    expect(() => capture('signed_out', { method: 'email_code' })).not.toThrow();
  });

  test('event names and props are checked at compile time', () => {
    const event: AppEventName = 'voice_input_used';
    expect(event).toBe('voice_input_used');

    // @ts-expect-error unknown event name
    capture('unknown_event', {});
    // @ts-expect-error assistant_opened requires entry
    capture('assistant_opened', {});
    // @ts-expect-error entry must be one of the declared values
    capture('assistant_opened', { entry: 'menu' });
    // @ts-expect-error signed_out method must be a declared sign-in method
    capture('signed_out', { method: 'password' });
  });
});
