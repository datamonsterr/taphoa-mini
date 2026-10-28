import { View, type ViewProps } from 'react-native';

/** RN Web turns dataSet into DOM attributes; the browser recorder blocks this subtree. */
export function PostHogMaskView(props: ViewProps) {
  const webProps = { ...props, dataSet: { phNoCapture: 'true' } };
  return <View {...webProps} collapsable={false} />;
}
