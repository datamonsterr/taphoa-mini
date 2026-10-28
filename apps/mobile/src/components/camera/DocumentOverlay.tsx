import { StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui/ScaledText';
import type { ScanDocument } from '@/lib/api';
import { mapBox, type BBox, type Size } from '@/lib/bbox';
import { colors, radius, space } from '@/theme';
import { fontFamily } from '@/theme/typography';

export function DocumentOverlay({
  document,
  imageSize,
  viewSize,
}: {
  document: ScanDocument;
  imageSize: Size;
  viewSize: Size;
}) {
  if (!document.detected) return null;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {(document.line_boxes ?? []).slice(0, 40).map((line, index) => {
        const box = mapBox(
          [
            line[0] * imageSize.width,
            line[1] * imageSize.height,
            line[2] * imageSize.width,
            line[3] * imageSize.height,
          ] as BBox,
          imageSize,
          viewSize,
          'cover',
        );
        return (
          <View
            key={index}
            testID={`document-line-${index}`}
            style={[
              styles.line,
              {
                left: box.x,
                top: box.y,
                width: box.width,
                height: box.height,
              },
            ]}
          />
        );
      })}
      <Text style={styles.badge}>Hóa đơn · {document.text_lines} dòng chữ</Text>
    </View>
  );
}

export function DocumentHint() {
  return (
    <Text style={styles.hint}>Giữ máy thẳng, đủ sáng · chụp để đọc chữ</Text>
  );
}

const styles = StyleSheet.create({
  line: {
    position: 'absolute',
    borderColor: colors.accent,
    borderWidth: 1.5,
    borderRadius: 3,
  },
  badge: {
    alignSelf: 'center',
    backgroundColor: colors.accent,
    color: colors.onAccent,
    borderRadius: radius.full,
    paddingHorizontal: space[3],
    paddingVertical: space[1],
    fontFamily: fontFamily.bold,
    fontSize: 14,
    lineHeight: 20,
  },
  hint: {
    color: colors.cameraMuted,
    textAlign: 'center',
    fontSize: 15,
    lineHeight: 20,
    marginTop: space[2],
  },
});
