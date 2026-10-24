import { CameraView, useCameraPermissions } from 'expo-camera';
import { RotateCcw, X } from 'lucide-react-native';
import { memo, useCallback, useRef, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';

import { Shutter, Viewfinder } from '@/components/camera';
import { CheckButton, Icon, PressableScale } from '@/components/ui';
import { useT } from '@/lib/i18n';
import { camera, colors, radius, size, space } from '@/theme';

import { PermissionPrompt } from '../camera/PermissionPrompt';
import { expenseStrings } from './strings';

type Props = {
  /** The photo the seller accepted. */
  onUse: (uri: string) => void;
  onClose: () => void;
};

const FRAME = 358;

/** Full-sheet camera: shoot the bill, preview it, then use or retake. */
export const BillCamera = memo(function BillCamera({ onUse, onClose }: Props) {
  const t = useT(expenseStrings);
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const shoot = useCallback(async () => {
    setBusy(true);
    try {
      const picture = await cameraRef.current?.takePictureAsync({
        quality: 0.7,
      });
      if (picture) setPhotoUri(picture.uri);
    } finally {
      setBusy(false);
    }
  }, []);

  const askPermission = useCallback(
    () => void requestPermission(),
    [requestPermission],
  );
  const openSettings = useCallback(() => void Linking.openSettings(), []);

  return (
    <View testID="bill-camera" style={styles.root}>
      <View style={styles.top}>
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={t('cameraClose')}
          onPress={onClose}
          style={styles.glass}
        >
          <Icon icon={X} color={colors.cameraInk} />
        </PressableScale>
      </View>

      {permission && !permission.granted ? (
        <PermissionPrompt
          title={t('permissionTitle')}
          actionLabel={
            permission.canAskAgain ? t('allowCamera') : t('openSettings')
          }
          onPress={permission.canAskAgain ? askPermission : openSettings}
        />
      ) : (
        <>
          <Viewfinder size={FRAME} photoUri={photoUri ?? undefined}>
            {photoUri ? null : (
              <CameraView
                ref={cameraRef}
                facing="back"
                style={StyleSheet.absoluteFill}
              />
            )}
          </Viewfinder>
          {photoUri ? (
            <View style={styles.actions}>
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel={t('retake')}
                onPress={() => setPhotoUri(null)}
                style={styles.glass}
              >
                <Icon icon={RotateCcw} color={colors.cameraInk} />
              </PressableScale>
              <CheckButton
                variant="success"
                accessibilityLabel={t('usePhoto')}
                onPress={() => onUse(photoUri)}
              />
            </View>
          ) : (
            <Shutter label={t('shoot')} busy={busy} onPress={shoot} />
          )}
        </>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[6],
    backgroundColor: colors.cameraBg,
  },
  top: {
    position: 'absolute',
    top: space[6],
    left: space[4],
  },
  glass: {
    width: size.tapMin,
    height: size.tapMin,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: camera.glass,
  },
  actions: { flexDirection: 'row', alignItems: 'center', gap: space[4] },
});
