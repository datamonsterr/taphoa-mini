import { StyleSheet, View } from 'react-native';

import { PointOverlay } from '@/components/camera';
import type { Product } from '@/lib/api';

import { styles } from './cameraStyles';
import type { QuickPoint, Shot } from './quickEnroll';
import { QuickEnrollSheet } from './QuickEnrollSheet';

type Props = {
  currentShot: Shot | undefined;
  acceptedCount: number;
  sheetOpen: boolean;
  addingAngle: boolean;
  onTap: (point: QuickPoint) => void;
  onUndo: () => void;
  onRetake: () => void;
  onNext: () => void;
  onCloseSheet: () => void;
  onAddPhoto: () => void;
  onCreated: (product: Product) => void;
  oneTrip?: { fixture?: string };
};

/** Quick-enroll overlays on top of the board: the point prompt and the "new product" sheet. */
export function QuickEnrollLayer({
  currentShot,
  acceptedCount,
  sheetOpen,
  addingAngle,
  onTap,
  onUndo,
  onRetake,
  onNext,
  onCloseSheet,
  onAddPhoto,
  onCreated,
  oneTrip,
}: Props) {
  return (
    <>
      {currentShot ? (
        <PointOverlay
          key={currentShot.id}
          shot={currentShot}
          tapDisabled={!currentShot.imageId}
          index={acceptedCount}
          acceptedCount={acceptedCount}
          onTap={onTap}
          onUndo={onUndo}
          onRetake={onRetake}
          onNext={onNext}
        />
      ) : null}
      {sheetOpen ? (
        <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
          <View
            style={addingAngle ? styles.hidden : StyleSheet.absoluteFill}
            pointerEvents={addingAngle ? 'none' : 'auto'}
            accessibilityElementsHidden={addingAngle}
            importantForAccessibility={
              addingAngle ? 'no-hide-descendants' : 'auto'
            }
          >
            <QuickEnrollSheet
              onClose={onCloseSheet}
              onAddPhoto={onAddPhoto}
              onCreated={onCreated}
              oneTrip={oneTrip}
            />
          </View>
        </View>
      ) : null}
    </>
  );
}
