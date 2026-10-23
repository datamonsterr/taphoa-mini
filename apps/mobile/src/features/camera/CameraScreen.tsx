import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { useIsFocused, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ArrowDown } from 'lucide-react-native';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  type LayoutChangeEvent,
  Linking,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  AddButton,
  AlternativesStrip,
  CartPill,
  DetectionOverlay,
  EnrollButton,
  ModeToggle,
  Shutter,
  SwipeHandle,
  Viewfinder,
} from '@/components/camera';
import { Icon } from '@/components/ui/Icon';
import { useT } from '@/lib/i18n';
import { cropRect, formatCrop, mapBox, type BBox } from '@/lib/bbox';
import { selectCount, selectTotal, useCartStore } from '@/stores/cart';
import { camera, colors, size, space } from '@/theme';

import {
  AddFeedback,
  CartPop,
  flyVector,
  measuredFlyVector,
  type Layout,
} from './AddFeedback';
import { ConfidenceBadge } from './ConfidenceBadge';
import {
  confidencePercent,
  toCartLines,
  toOverlayDetections,
} from './detections';
import { isLowMatch } from './matching';
import { selectMode, useCaptureModeStore } from './modeStore';
import { PermissionPrompt } from './PermissionPrompt';
import { ScanError } from './ScanError';
import { strings } from './strings';
import { useScanSession } from './useScanSession';

const BOARD_VIEWFINDER = 358;
const STRIP_SLOT = 80;
/** Everything on the board except the viewfinder, so small phones can shrink the square. */
/** Gap between the mode toggle and the viewfinder on the board (76 -> 136). */
const FINDER_GAP = 60;
const FIXED_HEIGHT =
  20 + 56 + FINDER_GAP + 8 + STRIP_SLOT + 8 + 64 + 16 + 56 + 32;

/**
 * The live preview. It reports readiness once `expo-camera` has started, and not-ready when it
 * unmounts (behind a frozen photo, off screen), so the shutter never fires into a cold camera.
 */
function LivePreview({
  cameraRef,
  onReadyChange,
}: {
  cameraRef: React.RefObject<CameraView | null>;
  onReadyChange: (ready: boolean) => void;
}) {
  useEffect(() => () => onReadyChange(false), [onReadyChange]);
  const onCameraReady = useCallback(() => onReadyChange(true), [onReadyChange]);
  return (
    <CameraView
      ref={cameraRef}
      facing="back"
      onCameraReady={onCameraReady}
      style={StyleSheet.absoluteFill}
    />
  );
}

/**
 * Owns the cart subscription so an add or a quantity change re-renders only the pill, never the
 * viewfinder, the shutter or the detection boxes in `CameraScreen`.
 */
const CartShortcut = memo(function CartShortcut({
  onPress,
}: {
  onPress: () => void;
}) {
  const count = useCartStore(selectCount);
  const total = useCartStore(selectTotal);
  return (
    <CartPop count={count}>
      <CartPill count={count} total={total} onPress={onPress} />
    </CartPop>
  );
});

/** Screens 01–04: live camera, then frozen photo with boxes, prices and the `+` batch. */
export function CameraScreen() {
  const t = useT(strings);
  const router = useRouter();
  const focused = useIsFocused();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [permission, requestPermission] = useCameraPermissions();

  const mode = useCaptureModeStore(selectMode);
  const setMode = useCaptureModeStore((s) => s.setMode);
  const addLine = useCartStore((s) => s.add);

  const cameraRef = useRef<CameraView>(null);
  const { state, capture, retry, reset, added, toggle, toggleOpen, choose } =
    useScanSession(cameraRef, mode);
  const { phase, photo, scan, selected, chosen, openId } = state;
  const [addCount, setAddCount] = useState(0);
  const [cameraReady, setCameraReady] = useState(false);

  // A frozen result means nothing once the seller leaves the screen.
  useEffect(() => {
    if (!focused) reset();
  }, [focused, reset]);

  const finder = Math.max(
    0,
    Math.min(
      BOARD_VIEWFINDER,
      width - 32,
      height -
        FIXED_HEIGHT -
        Math.max(insets.top, 0) -
        Math.max(insets.bottom - 32, 0),
    ),
  );
  const viewSize = useMemo(() => ({ width: finder, height: finder }), [finder]);

  const fallbackName = t('unnamed');
  const detections = useMemo(
    () => (scan ? toOverlayDetections(scan, chosen, fallbackName) : []),
    [scan, chosen, fallbackName],
  );
  const imageSize = useMemo(
    () => ({ width: scan?.image.width ?? 0, height: scan?.image.height ?? 0 }),
    [scan],
  );
  const batch = useMemo(
    () => detections.filter((d) => selected[d.id] && !d.lowMatch).length,
    [detections, selected],
  );
  const anyLow = useMemo(
    () => !!scan && scan.detections.some(isLowMatch),
    [scan],
  );
  const openDetection = detections.find((d) => d.id === openId);

  const hasResult = phase === 'result' && !!scan;
  const busy = phase === 'capturing' || phase === 'scanning';

  /** Enroll the pressed detection: its id and box (cropped to the photo) go with the photo. */
  const goEnroll = useCallback(
    (detectionId?: string) => {
      if (!photo || !scan) {
        router.push('/enroll');
        return;
      }
      const target = scan.detections.find((d) => d.id === detectionId);
      const rect = target
        ? cropRect(target.bbox as unknown as BBox, imageSize, photo)
        : null;
      router.push({
        pathname: '/enroll',
        params: {
          photoUri: photo.uri,
          scanId: scan.id,
          ...(target && rect
            ? { detectionId: target.id, crop: formatCrop(rect) }
            : {}),
        },
      });
    },
    [router, photo, scan, imageSize],
  );
  const onEnrollPress = useCallback(() => {
    const unknown = scan?.detections.find(isLowMatch);
    goEnroll(unknown?.id);
  }, [scan, goEnroll]);

  const onPricePress = useCallback(
    (id: string) => {
      if (detections.find((d) => d.id === id)?.lowMatch) goEnroll(id);
      else toggleOpen(id);
    },
    [detections, goEnroll, toggleOpen],
  );

  const onAdd = useCallback(() => {
    if (!scan) return;
    for (const line of toCartLines(scan, selected, chosen, fallbackName)) {
      addLine(line);
    }
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setAddCount((n) => n + 1);
    added();
  }, [scan, selected, chosen, fallbackName, addLine, added]);

  const openCart = useCallback(() => router.push('/cart'), [router]);
  const openShop = useCallback(() => router.push('/inventory'), [router]);
  const askPermission = useCallback(
    () => void requestPermission(),
    [requestPermission],
  );
  const openSettings = useCallback(() => void Linking.openSettings(), []);
  const onShutter = useCallback(() => {
    if (phase === 'idle') void capture();
    else reset();
  }, [phase, capture, reset]);
  const onRetry = useCallback(() => void retry(), [retry]);

  const [rects, setRects] = useState<{
    controlsY?: number;
    add?: Layout;
    bottomY?: number;
    pill?: Layout;
  }>({});
  const onControlsLayout = useCallback((e: LayoutChangeEvent) => {
    const controlsY = e.nativeEvent.layout.y;
    setRects((r) => ({ ...r, controlsY }));
  }, []);
  const onAddLayout = useCallback((e: LayoutChangeEvent) => {
    const add = e.nativeEvent.layout;
    setRects((r) => ({ ...r, add }));
  }, []);
  const onBottomLayout = useCallback((e: LayoutChangeEvent) => {
    const bottomY = e.nativeEvent.layout.y;
    setRects((r) => ({ ...r, bottomY }));
  }, []);
  const onPillLayout = useCallback((e: LayoutChangeEvent) => {
    const pill = e.nativeEvent.layout;
    setRects((r) => ({ ...r, pill }));
  }, []);
  // The fly dot aims at the measured cart pill; the board's row positions are only the fallback.
  const fly =
    rects.add &&
    rects.pill &&
    rects.controlsY !== undefined &&
    rects.bottomY !== undefined
      ? measuredFlyVector(rects.add, rects.controlsY, rects.pill, rects.bottomY)
      : flyVector(width);

  return (
    <View
      testID="camera-screen"
      style={[
        styles.screen,
        {
          paddingTop: Math.max(insets.top, 0) + 20,
          paddingBottom: Math.max(insets.bottom, 32),
        },
      ]}
    >
      {focused ? <StatusBar style="light" /> : null}
      <View style={styles.modeRow}>
        <ModeToggle mode={mode} onChange={setMode} />
      </View>

      <View testID="camera-finder-row" style={styles.finderRow}>
        <Viewfinder
          size={finder}
          photoUri={photo?.uri}
          behind={
            focused && permission?.granted ? (
              <LivePreview
                cameraRef={cameraRef}
                onReadyChange={setCameraReady}
              />
            ) : null
          }
        >
          {photo ? (
            <>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('backToCamera')}
                onPress={reset}
                style={StyleSheet.absoluteFill}
              />
              {busy ? (
                <View
                  testID="scan-busy"
                  accessibilityLabel={t('scanning')}
                  pointerEvents="none"
                  style={styles.busy}
                >
                  <ActivityIndicator size="large" color={camera.white} />
                </View>
              ) : null}
              {hasResult ? (
                <>
                  <DetectionOverlay
                    imageSize={imageSize}
                    viewSize={viewSize}
                    detections={detections}
                    selected={selected}
                    mode={mode}
                    openId={openId}
                    onToggle={toggle}
                    onPricePress={onPricePress}
                    onChoose={choose}
                  />
                  {mode === 'one'
                    ? detections.map((d) => (
                        <ConfidenceBadge
                          key={d.id}
                          box={mapBox(d.bbox, imageSize, viewSize, 'cover')}
                          percent={confidencePercent(
                            scan.detections.find((x) => x.id === d.id)!,
                          )}
                          low={!!d.lowMatch}
                        />
                      ))
                    : null}
                </>
              ) : null}
            </>
          ) : permission && !permission.granted ? (
            <PermissionPrompt
              title={t('permissionTitle')}
              actionLabel={
                permission.canAskAgain
                  ? t('permissionAsk')
                  : t('permissionSettings')
              }
              onPress={permission.canAskAgain ? askPermission : openSettings}
            />
          ) : null}
          {phase === 'error' ? (
            <ScanError
              message={t('scanError')}
              retryLabel={t('retry')}
              onRetry={onRetry}
            />
          ) : null}
        </Viewfinder>
      </View>

      <View style={styles.stripSlot}>
        {hasResult && mode === 'one' && openDetection?.alternatives ? (
          <AlternativesStrip
            items={openDetection.alternatives}
            currentId={openDetection.alternatives[0]!.id}
            placement="below"
            onChoose={(productId) => choose(openDetection.id, productId)}
          />
        ) : null}
      </View>

      <View
        testID="camera-controls"
        style={styles.controls}
        onLayout={onControlsLayout}
      >
        <View>
          <EnrollButton pulse={hasResult && anyLow} onPress={onEnrollPress} />
          {hasResult && anyLow ? (
            <View
              testID="enroll-arrow"
              pointerEvents="none"
              style={styles.arrow}
            >
              <Icon
                icon={ArrowDown}
                size={26}
                color={colors.warningSoft}
                strokeWidth={2.5}
              />
            </View>
          ) : null}
        </View>
        <Shutter
          label={phase === 'idle' ? t('shutter') : t('reshoot')}
          busy={busy || (phase === 'idle' && !cameraReady)}
          onPress={onShutter}
        />
        <View testID="camera-add-slot" onLayout={onAddLayout}>
          <AddButton
            disabled={!hasResult || batch === 0}
            count={mode === 'many' && hasResult ? batch : 0}
            onPress={onAdd}
          />
          <AddFeedback trigger={addCount} dx={fly.dx} dy={fly.dy} />
        </View>
      </View>

      <View style={styles.spacer} />

      <View
        testID="camera-bottom-row"
        style={styles.bottomRow}
        onLayout={onBottomLayout}
      >
        <View testID="camera-cart-slot" onLayout={onPillLayout}>
          <CartShortcut onPress={openCart} />
        </View>
        <View pointerEvents="box-none" style={styles.handle}>
          <SwipeHandle onOpen={openShop} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.cameraBg },
  modeRow: { alignItems: 'center' },
  finderRow: { alignItems: 'center', marginTop: FINDER_GAP },
  stripSlot: {
    height: STRIP_SLOT,
    marginTop: space[2],
    justifyContent: 'center',
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    marginTop: space[2],
  },
  arrow: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: -38,
    alignItems: 'center',
  },
  spacer: { flex: 1, minHeight: 16 },
  bottomRow: {
    height: size.tapMin,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space[4],
  },
  handle: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  busy: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: camera.pillDark,
  },
});
