import { Text, View } from 'react-native';

/** Metro uses this fallback for web; no camera/Nitro native imports enter that bundle. */
export default function VisionDevScreen() {
  return (
    <View>
      <Text>
        The VisionCamera object detection spike requires an Android development
        build.
      </Text>
    </View>
  );
}
