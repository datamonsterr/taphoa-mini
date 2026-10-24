import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { useIsFocused, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ArrowDown, Plus } from 'lucide-react-native';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  type LayoutChangeEvent,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  AddButton,
  AlternativesStrip,
  CartPill,
  DetectionOverlay,
  EnrollButton,
  ModeToggle,
  PointOverlay,
  Shutter,
  SwipeHandle,
  Viewfinder,
} from '@/components/camera';
import { Icon } from '@/components/ui/Icon';
import { CircleButton } from '@/components/ui';
import {
  useProduct,
  useSegmentPoints,
  useUploadImage,
  type Product,
} from '@/lib/api';
import { downsizeForUpload } from '@/lib/api/downsize';
import { newUuid } from '@/lib/uuid';
import { useT } from '@/lib/i18n';
import { cropRect, formatCrop, mapBox, type BBox } from '@/lib/bbox';
import { selectCount, selectTotal, useCartStore } from '@/stores/cart';
import { selectCanEnroll, useSessionStore } from '@/stores/session';
import { camera, colors, size, space } from '@/theme';

import {
  AddFeedback,
  CartPop,
  flyVector,
  measuredFlyVector,
  type Layout,
} from './AddFeedback';
import { takePhoto } from './capture';
import {
  MIN_SHOTS,
  selectCanCapture,
  selectCanAdd,
  selectCurrent,
  useQuickEnrollStore,
} from './quickEnroll';
import { QuickEnrollSheet } from './QuickEnrollSheet';
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

/** A short scale morph announces the new primary action after the third angle. */
function QuickAdd({
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

function IndexingChip({ id }: { id: string }) {
  const { data } = useProduct(id);
  return !data || data.index_status === 'pending' ? (
    <Text accessibilityLiveRegion="polite" style={styles.indexChip}>
      đang học
    </Text>
  ) : null;
}

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
  const quickActive = useQuickEnrollStore((s) => s.active);
  const shots = useQuickEnrollStore((s) => s.shots);
  const currentShot = useQuickEnrollStore(selectCurrent);
  const canQuickAdd = useQuickEnrollStore(selectCanAdd);
  const acceptedCount = shots.filter(
    (shot) => shot.status === 'accepted',
  ).length;
  const { mutateAsync: segmentPoints } = useSegmentPoints();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [addingAngle, setAddingAngle] = useState(false);
  const [created, setCreated] = useState<Product[]>([]);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(timer);
  }, [notice]);
  const canQuickCapture = useQuickEnrollStore(selectCanCapture);
  const dispatch = useQuickEnrollStore((s) => s.dispatch);
  const { mutateAsync: uploadImage } = useUploadImage();
  const [quickCapturing, setQuickCapturing] = useState(false);
  const quickCaptureToken = useRef(0);
  const quickCapturePending = useRef(false);

  // Invalidate unfinished captures when this screen unmounts.
  useEffect(
    () => () => {
      quickCaptureToken.current += 1;
    },
    [],
  );

  // A frozen result means nothing once the seller leaves the screen.
  useEffect(() => {
    if (!focused) {
      reset();
      quickCaptureToken.current += 1;
      quickCapturePending.current = false;
      // Focus loss cancels camera work and releases its local busy indicator.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setQuickCapturing(false);
    }
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
  // `Image.width/height` are optional in the API and the backend omits them: the boxes are in
  // pixels of the uploaded photo, whose size the camera reported.
  const imageSize = useMemo(
    () => ({
      width: scan?.image.width ?? photo?.width ?? 0,
      height: scan?.image.height ?? photo?.height ?? 0,
    }),
    [scan, photo],
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
  const canEnroll = useSessionStore(selectCanEnroll);
  const goEnroll = useCallback(
    (detectionId?: string) => {
      if (!canEnroll) return;
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
    [router, photo, scan, imageSize, canEnroll],
  );
  const onEnrollPress = useCallback(() => {
    if (!canEnroll) return;
    const toggleMode = () => {
      quickCaptureToken.current += 1;
      quickCapturePending.current = false;
      setQuickCapturing(false);
      setSheetOpen(false);
      setAddingAngle(false);
      if (!useQuickEnrollStore.getState().active) reset();
      dispatch({ type: 'toggle' });
    };
    if (quickActive && shots.length > 0) {
      if (Platform.OS === 'web') {
        if (window.confirm('Bỏ các ảnh đã chụp?')) toggleMode();
      } else {
        Alert.alert('Bỏ các ảnh đã chụp?', '', [
          { text: 'Hủy', style: 'cancel' },
          { text: 'Bỏ ảnh', style: 'destructive', onPress: toggleMode },
        ]);
      }
    } else toggleMode();
  }, [canEnroll, quickActive, shots.length, dispatch, reset]);

  const segmentCurrent = useCallback(async () => {
    const shot = selectCurrent(useQuickEnrollStore.getState());
    if (!shot?.imageId || shot.points.length === 0) return;
    const points = shot.points;
    // Reducer updates replace the points array; undo/re-tap invalidates this request,
    // including when a later prompt has the same coordinates.
    const stillCurrent = () => {
      const current = selectCurrent(useQuickEnrollStore.getState());
      return current?.id === shot.id && current.points === points;
    };
    dispatch({ type: 'segmenting' });
    try {
      const result = await segmentPoints({ image_id: shot.imageId, points });
      if (!stillCurrent()) return;
      dispatch({
        type: 'segmented',
        id: shot.id,
        mask: {
          width: result.mask.width,
          height: result.mask.height,
          pngBase64: result.mask.png_base64,
        },
        bbox: result.bbox as [number, number, number, number],
        cutoutImageId: result.cutout_image_id,
      });
    } catch (error) {
      if (!stillCurrent()) return;
      dispatch({
        type: 'failed',
        id: shot.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [dispatch, segmentPoints]);

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
  const captureQuickPhoto = useCallback(async () => {
    if (
      !canEnroll ||
      !cameraReady ||
      !focused ||
      quickCapturePending.current ||
      !selectCanCapture(useQuickEnrollStore.getState())
    )
      return;
    quickCapturePending.current = true;
    setQuickCapturing(true);
    const token = ++quickCaptureToken.current;
    const id = newUuid();
    try {
      const photo = await takePhoto(cameraRef.current);
      const downsized = await downsizeForUpload(
        photo.uri,
        photo.width,
        photo.height,
      );
      if (token !== quickCaptureToken.current) return;
      dispatch({ type: 'captured', id, ...downsized });
      const image = await uploadImage({
        file: {
          uri: downsized.uri,
          name: 'enrollment.jpg',
          type: 'image/jpeg',
        },
        purpose: 'enrollment',
      });
      if (token !== quickCaptureToken.current) return;
      dispatch({ type: 'uploaded', id, imageId: image.id });
    } catch (error) {
      if (token !== quickCaptureToken.current) return;
      const message = error instanceof Error ? error.message : String(error);
      dispatch({ type: 'failed', id, error: message });
      Alert.alert('Chưa tải được ảnh', message);
    } finally {
      if (token === quickCaptureToken.current) {
        quickCapturePending.current = false;
        setQuickCapturing(false);
      }
    }
  }, [canEnroll, cameraReady, focused, dispatch, uploadImage]);
  const onShutter = useCallback(() => {
    if (quickActive) void captureQuickPhoto();
    else if (phase === 'idle') void capture();
    else reset();
  }, [quickActive, captureQuickPhoto, phase, capture, reset]);
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
                    canEnroll={canEnroll}
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
        {quickActive ? (
          <Text style={styles.quickHint}>
            Thêm hàng nhanh · {acceptedCount}/{MIN_SHOTS}
          </Text>
        ) : null}
        {quickActive && acceptedCount < MIN_SHOTS ? (
          <Text style={styles.quickHint}>Xoay sản phẩm</Text>
        ) : null}
        {notice ? (
          <Text accessibilityRole="alert" style={styles.quickHint}>
            {notice}
          </Text>
        ) : null}
        {created.map((product) => (
          <IndexingChip key={product.id} id={product.id} />
        ))}
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
          <EnrollButton
            active={quickActive}
            pulse={hasResult && anyLow}
            disabled={!canEnroll}
            onPress={onEnrollPress}
          />
          {hasResult && anyLow && canEnroll ? (
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
        {quickActive && canQuickAdd && !currentShot && !addingAngle ? (
          <QuickAdd onPress={() => setSheetOpen(true)} disabled={!canEnroll} />
        ) : (
          <Shutter
            label={phase === 'idle' ? t('shutter') : t('reshoot')}
            busy={
              quickActive
                ? !canQuickCapture ||
                  quickCapturing ||
                  !cameraReady ||
                  !canEnroll
                : busy || (phase === 'idle' && !cameraReady)
            }
            onPress={onShutter}
          />
        )}
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
      {quickActive && currentShot ? (
        <PointOverlay
          key={currentShot.id}
          shot={currentShot}
          tapDisabled={!currentShot.imageId}
          index={acceptedCount}
          acceptedCount={acceptedCount}
          onTap={(point) => {
            if (!selectCurrent(useQuickEnrollStore.getState())?.imageId) return;
            dispatch({ type: 'addPoint', point });
            void segmentCurrent();
          }}
          onUndo={() => {
            dispatch({ type: 'undoPoint' });
            void segmentCurrent();
          }}
          onRetake={() => {
            quickCaptureToken.current += 1;
            quickCapturePending.current = false;
            setQuickCapturing(false);
            dispatch({ type: 'retake' });
          }}
          onNext={() => {
            dispatch({ type: 'accept' });
            if (addingAngle && !selectCurrent(useQuickEnrollStore.getState())) {
              setAddingAngle(false);
              setSheetOpen(true);
            }
          }}
        />
      ) : null}
      {quickActive && sheetOpen ? (
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
              onClose={() => setSheetOpen(false)}
              onAddPhoto={() => setAddingAngle(true)}
              onCreated={(product) => {
                setCreated((products) => [...products, product]);
                setNotice(`Đã thêm ${product.name || 'Hàng mới'}`);
                setSheetOpen(false);
                setAddingAngle(false);
              }}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  hidden: { display: 'none' },
  screen: { flex: 1, backgroundColor: colors.cameraBg },
  modeRow: { alignItems: 'center' },
  finderRow: { alignItems: 'center', marginTop: FINDER_GAP },
  stripSlot: {
    height: STRIP_SLOT,
    marginTop: space[2],
    justifyContent: 'center',
  },
  indexChip: {
    color: colors.accent,
    backgroundColor: camera.glass,
    alignSelf: 'center',
    paddingHorizontal: space[3],
    paddingVertical: space[1],
    borderRadius: 999,
  },
  quickHint: { color: colors.accent, textAlign: 'center' },
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
