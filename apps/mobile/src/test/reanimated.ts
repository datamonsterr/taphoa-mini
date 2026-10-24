/* eslint-disable @typescript-eslint/no-require-imports -- loaded lazily from a jest.mock factory */

/** Synchronous Reanimated stand-in: animated values apply their final value at once. */
export function createReanimatedMock() {
  const React = require('react');
  const { View, Text } = require('react-native');
  const layout: Record<string, unknown> = {};
  const layoutAnimation = new Proxy(layout, {
    get: (_target, key) =>
      key === 'duration' ? () => layoutAnimation : undefined,
  });
  const last = (...values: unknown[]) => values[values.length - 1];
  const Animated = { View, Text, createAnimatedComponent: (c: unknown) => c };
  return {
    __esModule: true,
    default: Animated,
    ...Animated,
    useSharedValue: (initial: unknown) =>
      React.useRef({ value: initial }).current,
    useAnimatedStyle: (updater: () => unknown) => updater(),
    withTiming: (value: unknown) => value,
    withSpring: (value: unknown) => value,
    withRepeat: (value: unknown) => value,
    withSequence: last,
    isSharedValue: (value: unknown) =>
      typeof value === 'object' && value !== null && 'value' in value,
    cancelAnimation: jest.fn(),
    useEvent: () => jest.fn(),
    useHandler: () => ({ context: {}, doDependenciesDiffer: false }),
    FadeInDown: layoutAnimation,
    FadeOutDown: layoutAnimation,
    ZoomIn: layoutAnimation,
    LinearTransition: layoutAnimation,
    LayoutAnimationConfig: jest.fn(
      ({ children }: { children: unknown }) => children,
    ),
  };
}
