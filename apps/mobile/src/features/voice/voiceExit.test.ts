import { moveTaskToBack } from './nativeQuickAccess';
import { setVoiceExit, voiceExit } from './voiceExit';

jest.mock('./nativeQuickAccess', () => ({
  ...jest.requireActual('./nativeQuickAccess'),
  moveTaskToBack: jest.fn(() => true),
}));

afterEach(() => {
  setVoiceExit(null);
  jest.clearAllMocks();
});

describe('default exit', () => {
  test('from the bubble: closes the sheet, then sends the app to the back', () => {
    const order: string[] = [];
    (moveTaskToBack as jest.Mock).mockImplementationOnce(() => {
      order.push('back');
      return true;
    });
    voiceExit.onDone({ returnToPrevious: true }, () => order.push('close'));
    expect(order).toEqual(['close', 'back']);
  });

  test('inside the app: only closes the sheet', () => {
    const close = jest.fn();
    voiceExit.onDone({ returnToPrevious: false }, close);
    expect(close).toHaveBeenCalledTimes(1);
    expect(moveTaskToBack).not.toHaveBeenCalled();
  });
});
