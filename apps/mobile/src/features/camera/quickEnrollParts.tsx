import { Plus } from '@/components/icons';
import { useEffect } from 'react';
import { Alert, Platform, Text } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { CircleButton } from '@/components/ui';
import {
  RATE_LIMIT_MESSAGE,
  isApiError,
  isRateLimited,
  useProduct,
} from '@/lib/api';

import { styles } from './cameraStyles';

/** Which quick-enroll step failed, and what the seller does next. */
export function quickPhotoAlert(step: 'capture' | 'upload', error: unknown) {
  if (step === 'capture')
    return {
      title: 'Chưa chụp được ảnh',
      message: 'Máy ảnh chưa chụp được. Giữ máy yên rồi bấm Chụp lần nữa.',
    };
  const title = 'Chưa tải được ảnh';
  if (isRateLimited(error)) return { title, message: RATE_LIMIT_MESSAGE };
  if (isApiError(error) && error.status === 403)
    return {
      title,
      message: 'Bạn chưa có quyền thêm hàng. Nhờ chủ cửa hàng cấp quyền.',
    };
  return {
    title,
    message: 'Ảnh chưa lên được máy chủ. Kiểm tra mạng rồi chụp lại.',
  };
}

/** A short scale morph announces the new primary action after the third angle. */
export function QuickAdd({
  onPress,
  disabled,
}: {
  onPress: () => void;
  disabled: boolean;
}) {
  const progress = useSharedValue(0);
  useEffect(() => {
    progress.value = withTiming(1, { duration: 180 });
  }, [progress]);
  const animated = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ scale: 0.95 + 0.05 * progress.value }],
  }));
  return (
    <Animated.View style={animated}>
      <CircleButton
        icon={Plus}
        large
        variant="accent"
        accessibilityLabel="Thêm sản phẩm"
        testID="quick-enroll-add"
        disabled={disabled}
        onPress={onPress}
      />
    </Animated.View>
  );
}

export function IndexingChip({ id }: { id: string }) {
  const { data } = useProduct(id);
  return !data || data.index_status === 'pending' ? (
    <Text accessibilityLiveRegion="polite" style={styles.indexChip}>
      đang học
    </Text>
  ) : null;
}

/** Ask before dropping the quick-enroll photos already taken. */
export function confirmDiscardShots(onConfirm: () => void) {
  if (Platform.OS === 'web') {
    if (window.confirm('Bỏ các ảnh đã chụp?')) onConfirm();
  } else {
    Alert.alert('Bỏ các ảnh đã chụp?', '', [
      { text: 'Hủy', style: 'cancel' },
      { text: 'Bỏ ảnh', style: 'destructive', onPress: onConfirm },
    ]);
  }
}
