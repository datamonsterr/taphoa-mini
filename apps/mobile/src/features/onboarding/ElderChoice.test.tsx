import { render, screen } from '@testing-library/react-native';
import { Switch } from 'react-native';
import { ElderChoice } from './ElderChoice';

jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  const React = jest.requireActual('react');
  const mockSwitch = jest.fn((props) =>
    React.createElement(actual.Switch, props),
  );
  return new Proxy(actual, {
    get: (target, key) => (key === 'Switch' ? mockSwitch : target[key]),
  });
});

test('the elder choice leaves switch semantics to the native control', async () => {
  await render(<ElderChoice on onChange={jest.fn()} />);
  expect(
    screen.getAllByRole('switch', { name: 'Chế độ người lớn tuổi' }),
  ).toHaveLength(1);
  expect(
    jest.mocked(Switch).mock.calls[0][0].accessibilityRole,
  ).toBeUndefined();
});
