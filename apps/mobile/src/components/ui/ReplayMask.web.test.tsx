import { render } from '@testing-library/react-native';
import { Text } from 'react-native';
import { PostHogMaskView } from './ReplayMask.web';

test('web mask blocks the whole media subtree without changing its layout', async () => {
  const style = { width: 80, height: 60 };
  const view = await render(
    <PostHogMaskView testID="mask" pointerEvents="none" style={style}>
      <Text>camera</Text>
    </PostHogMaskView>,
  );
  expect(view.getByTestId('mask').props).toMatchObject({
    style,
    pointerEvents: 'none',
    collapsable: false,
    dataSet: { phNoCapture: 'true' },
  });
  expect(view.getByText('camera')).toBeTruthy();
});
