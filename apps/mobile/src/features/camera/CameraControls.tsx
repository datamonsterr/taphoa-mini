import { ArrowDown } from '@/components/icons';
import { View, type LayoutChangeEvent } from 'react-native';

import { AddButton, EnrollButton, Shutter } from '@/components/camera';
import { Icon } from '@/components/ui/Icon';
import { colors } from '@/theme';

import { AddFeedback } from './AddFeedback';
import { styles } from './cameraStyles';
import { QuickAdd } from './quickEnrollParts';

type Props = {
  quickActive: boolean;
  /** Pulse the enroll button and point at it: the scan has an unknown product. */
  unknownProduct: boolean;
  canEnroll: boolean;
  showQuickAdd: boolean;
  shutterLabel: string;
  shutterBusy: boolean;
  addDisabled: boolean;
  addBadge: number;
  fly: { dx: number; dy: number };
  onEnrollPress: () => void;
  onQuickAdd: () => void;
  onShutter: () => void;
  onAdd: () => void;
  addTrigger: number;
  onControlsLayout: (e: LayoutChangeEvent) => void;
  onAddLayout: (e: LayoutChangeEvent) => void;
};

/** Enroll, shutter (or quick-enroll "+") and add-to-cart: the row under the viewfinder. */
export function CameraControls({
  quickActive,
  unknownProduct,
  canEnroll,
  showQuickAdd,
  shutterLabel,
  shutterBusy,
  addDisabled,
  addBadge,
  fly,
  onEnrollPress,
  onQuickAdd,
  onShutter,
  onAdd,
  addTrigger,
  onControlsLayout,
  onAddLayout,
}: Props) {
  return (
    <View
      testID="camera-controls"
      style={styles.controls}
      onLayout={onControlsLayout}
    >
      <View>
        <EnrollButton
          active={quickActive}
          pulse={unknownProduct}
          disabled={!canEnroll}
          onPress={onEnrollPress}
        />
        {unknownProduct && canEnroll ? (
          <View testID="enroll-arrow" pointerEvents="none" style={styles.arrow}>
            <Icon
              icon={ArrowDown}
              size={26}
              color={colors.warningSoft}
              strokeWidth={2.5}
            />
          </View>
        ) : null}
      </View>
      {showQuickAdd ? (
        <QuickAdd onPress={onQuickAdd} disabled={!canEnroll} />
      ) : (
        <Shutter label={shutterLabel} busy={shutterBusy} onPress={onShutter} />
      )}
      <View testID="camera-add-slot" onLayout={onAddLayout}>
        <AddButton disabled={addDisabled} count={addBadge} onPress={onAdd} />
        <AddFeedback trigger={addTrigger} dx={fly.dx} dy={fly.dy} />
      </View>
    </View>
  );
}
