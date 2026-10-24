import { FileText } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { CircleButton } from '@/components/ui';
import { useT } from '@/lib/i18n';
import { space } from '@/theme';
import { strings } from './strings';

/** Anchored to the captured image, whose parent already sits inside the safe areas. */
export function DocumentButton({ onPress }: { onPress: () => void }) {
  const t = useT(strings);
  return (
    <View testID="document-button-position" style={styles.position}>
      <CircleButton
        icon={FileText}
        accessibilityLabel={t('readReceipt')}
        onPress={onPress}
        variant="accent"
        floating
      />
    </View>
  );
}

const styles = StyleSheet.create({
  position: {
    position: 'absolute',
    right: space[4],
    bottom: space[4],
    zIndex: 10,
    elevation: 10,
  },
});
