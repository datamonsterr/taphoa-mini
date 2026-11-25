import { useCameraPermissions } from 'expo-camera';
import { useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Modal,
  Platform,
  Pressable,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ModeToggle, SwipeHandle, Viewfinder } from '@/components/camera';
import { ChatButton } from '@/components/assistant/ChatButton';
import { DocumentHint } from '@/components/camera/DocumentOverlay';
import type { Product } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { useCanEnroll, useMembership } from '@/features/auth/useMembership';
import { useWarmRecognition } from '@/features/recognition/useWarmRecognition';
import { camera } from '@/theme';

import { ReceiptToast } from '../receipts/ReceiptToast';
import { CameraControls } from './CameraControls';
import { styles } from './cameraStyles';
import { confirmDiscardShots } from './quickEnrollParts';
import { CartShortcut } from './CartShortcut';
import { LivePreview, useNativeCameraEnabled } from './LivePreview';
import type { PictureTaker } from './capture';
import { selectMode, useCaptureModeStore } from './modeStore';
import {
  selectCanAdd,
  selectCanCapture,
  selectCurrent,
  useQuickEnrollStore,
} from './quickEnroll';
import { QuickEnrollLayer } from './QuickEnrollLayer';
import { StripSlot } from './StripSlot';
import { strings } from './strings';
import { useBarcodeFlow } from './useBarcodeFlow';
import { useDocumentProbe } from './useDocumentProbe';
import { useFlyVector } from './useFlyVector';
import { useQuickCapture } from './useQuickCapture';
import { useReceiptReader } from './useReceiptReader';
import { useAddToCart } from './useAddToCart';
import { useCameraActions } from './useCameraActions';
import { useScanView } from './useScanView';
import { useScanSession } from './useScanSession';
import { ViewfinderContent } from './ViewfinderContent';

/** Screens 01–04: live camera, then frozen photo with boxes, prices and the `+` batch. */
export function CameraScreen() {
  const t = useT(strings);
  const router = useRouter();
  const focused = useIsFocused();
  useWarmRecognition(focused);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [permission, requestPermission] = useCameraPermissions();

  const mode = useCaptureModeStore(selectMode);
  const setMode = useCaptureModeStore((s) => s.setMode);

  const cameraRef = useRef<PictureTaker>(null);
  const { state, capture, retry, reset, added, toggle, toggleOpen, choose } =
    useScanSession(cameraRef, mode);
  const { phase, photo, scan, selected, chosen, openId } = state;
  const [cameraReady, setCameraReady] = useState(false);
  const [codeMode, setCodeMode] = useState(false);
  const nativeCameraEnabled = useNativeCameraEnabled();
  const quickActive = useQuickEnrollStore((s) => s.active);
  const shots = useQuickEnrollStore((s) => s.shots);
  const currentShot = useQuickEnrollStore(selectCurrent);
  const canQuickAdd = useQuickEnrollStore(selectCanAdd);
  const canQuickCapture = useQuickEnrollStore(selectCanCapture);
  const dispatch = useQuickEnrollStore((s) => s.dispatch);
  const acceptedCount = shots.filter(
    (shot) => shot.status === 'accepted',
  ).length;
  const [sheetOpen, setSheetOpen] = useState(false);
  const [addingAngle, setAddingAngle] = useState(false);
  const [created, setCreated] = useState<Product[]>([]);
  const canEnroll = useCanEnroll();
  const searchParams = useLocalSearchParams<{
    entry?: string;
    mode?: string;
  }>();
  const receiptMode =
    searchParams.entry === 'receipt' || searchParams.mode === 'receipt';
  const joinedAt = useMembership()?.member.created_at;
  const { notice, setNotice, readingReceipt, readReceipt, uploadImage } =
    useReceiptReader({ t, canEnroll, scan, phase, cameraReady, capture });
  const { quickCapturing, captureQuickPhoto, segmentCurrent, cancelCapture } =
    useQuickCapture({
      cameraRef,
      canEnroll,
      cameraReady,
      focused,
      reset,
      uploadImage,
    });

  const fallbackName = t('unnamed');
  const {
    finder,
    viewSize,
    detections,
    imageSize,
    batch,
    anyLow,
    openDetection,
  } = useScanView({ scan, photo, chosen, selected, openId, fallbackName });

  const barcode = useBarcodeFlow({
    focused,
    granted: !!permission?.granted,
    cameraReady,
    idle: phase === 'idle',
    blocked: sheetOpen || readingReceipt || quickCapturing || !!currentShot,
    canEnroll,
    setNotice,
  });
  const { barcodeResult, setBarcodeResult } = barcode;
  const hasResult = phase === 'result' && !!scan;
  const busy = phase === 'capturing' || phase === 'scanning';
  const probe = useDocumentProbe(
    cameraRef,
    focused &&
      !!permission?.granted &&
      cameraReady &&
      phase === 'idle' &&
      !quickActive &&
      !sheetOpen &&
      !readingReceipt &&
      !barcode.busy &&
      !barcodeResult,
  );
  const document = hasResult ? scan.document : probe?.document;
  const documentDetected =
    !!document?.detected && !quickActive && !barcodeResult;
  const unknownProduct = hasResult && anyLow;
  const { chips, onChipPress, onPricePress } = useCameraActions({
    scan,
    photo,
    imageSize,
    detections,
    canEnroll,
    joinedAt,
    documentDetected,
    unknownProduct,
    readReceipt,
    toggleOpen,
  });
  const { onAdd, addCount } = useAddToCart({
    scan,
    selected,
    chosen,
    fallbackName,
    barcodeResult,
    clearBarcode: () => setBarcodeResult(null),
    added,
  });

  const onEnrollPress = useCallback(() => {
    if (!canEnroll) return;
    const toggleMode = () => {
      cancelCapture();
      setSheetOpen(false);
      setBarcodeResult(null);
      setAddingAngle(false);
      if (!useQuickEnrollStore.getState().active) reset();
      dispatch({ type: 'toggle' });
    };
    if (quickActive && shots.length > 0) confirmDiscardShots(toggleMode);
    else toggleMode();
  }, [
    canEnroll,
    quickActive,
    shots.length,
    dispatch,
    reset,
    cancelCapture,
    setBarcodeResult,
  ]);

  const openCart = useCallback(() => router.push('/cart'), [router]);
  const openShop = useCallback(() => router.push('/inventory'), [router]);
  const askPermission = useCallback(
    () => void requestPermission(),
    [requestPermission],
  );
  const openSettings = useCallback(() => void Linking.openSettings(), []);
  const onShutter = () => {
    if (barcodeResult) setBarcodeResult(null);
    else if (quickActive) void captureQuickPhoto();
    else if ((documentDetected || receiptMode) && canEnroll) void readReceipt();
    else if (phase === 'idle') void capture();
    else reset();
  };
  const onRetry = useCallback(() => void retry(), [retry]);
  const { fly, onControlsLayout, onAddLayout, onBottomLayout, onPillLayout } =
    useFlyVector(width);
  const alternativesOf =
    hasResult &&
    !documentDetected &&
    mode === 'one' &&
    openDetection?.alternatives
      ? openDetection
      : undefined;

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
        {nativeCameraEnabled ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Quét mã"
            accessibilityState={{ selected: codeMode }}
            onPress={() => setCodeMode((value) => !value)}
            style={styles.codeModeButton}
          >
            <Text style={styles.codeModeText}>
              {codeMode ? 'Đang quét mã' : 'Quét mã'}
            </Text>
          </Pressable>
        ) : null}
      </View>

      <View testID="camera-finder-row" style={styles.finderRow}>
        <Viewfinder
          size={finder}
          photoUri={photo?.uri}
          behind={
            focused && permission?.granted ? (
              <LivePreview
                cameraRef={cameraRef}
                codeMode={codeMode}
                onReadyChange={setCameraReady}
                onBarcodeScanned={barcode.onScan}
                scanningRef={barcode.scanningRef}
                dropHandler={Platform.OS === 'web' && !barcode.enabled}
              />
            ) : null
          }
        >
          <ViewfinderContent
            photo={photo}
            scan={scan}
            permission={permission}
            phase={phase}
            error={state.error}
            busy={busy}
            hasResult={hasResult}
            documentDetected={documentDetected}
            document={document}
            documentImageSize={
              hasResult ? imageSize : (probe?.imageSize ?? imageSize)
            }
            documentMirrored={!hasResult && !!probe?.previewMirrored}
            mode={mode}
            detections={detections}
            selected={selected}
            openId={openId}
            canEnroll={canEnroll}
            imageSize={imageSize}
            viewSize={viewSize}
            barcodeResult={barcodeResult}
            onReset={reset}
            onRetry={onRetry}
            onToggle={toggle}
            onPricePress={onPricePress}
            onChoose={choose}
            onAskPermission={askPermission}
            onOpenSettings={openSettings}
          />
        </Viewfinder>
      </View>

      <StripSlot
        quickActive={quickActive}
        hasCurrentShot={!!currentShot}
        acceptedCount={acceptedCount}
        notice={notice}
        readingReceipt={readingReceipt}
        created={created}
        chips={chips}
        onChipPress={onChipPress}
        alternatives={alternativesOf}
        onChoose={choose}
      />

      <CameraControls
        quickActive={quickActive}
        unknownProduct={unknownProduct}
        canEnroll={canEnroll}
        showQuickAdd={
          quickActive && canQuickAdd && !currentShot && !addingAngle
        }
        shutterLabel={
          (documentDetected || receiptMode) && canEnroll
            ? 'Chụp và đọc hóa đơn'
            : barcodeResult
              ? t('reshoot')
              : phase === 'idle'
                ? t('shutter')
                : t('reshoot')
        }
        shutterBusy={
          quickActive
            ? !canQuickCapture || quickCapturing || !cameraReady || !canEnroll
            : readingReceipt ||
              barcode.busy ||
              busy ||
              (phase === 'idle' && !cameraReady)
        }
        addDisabled={
          barcode.busy ||
          (barcodeResult
            ? !barcodeResult.product
            : documentDetected || !hasResult || batch === 0)
        }
        addBadge={mode === 'many' && hasResult ? batch : 0}
        addTrigger={addCount}
        fly={fly}
        onEnrollPress={onEnrollPress}
        onQuickAdd={() => setSheetOpen(true)}
        onShutter={onShutter}
        onAdd={onAdd}
        onControlsLayout={onControlsLayout}
        onAddLayout={onAddLayout}
      />

      {documentDetected ? <DocumentHint /> : null}
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
        <ChatButton screen="camera" />
      </View>
      <ReceiptToast />
      <Modal
        visible={readingReceipt}
        transparent
        animationType="fade"
        onRequestClose={() => {}}
      >
        <View
          accessibilityViewIsModal
          accessibilityLabel={t('readingReceipt')}
          style={styles.receiptBusy}
        >
          <ActivityIndicator size="large" color={camera.white} />
          <Text style={styles.quickHint}>{t('readingReceipt')}</Text>
        </View>
      </Modal>
      {quickActive ? (
        <QuickEnrollLayer
          currentShot={currentShot}
          acceptedCount={acceptedCount}
          sheetOpen={sheetOpen}
          addingAngle={addingAngle}
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
            cancelCapture();
            dispatch({ type: 'retake' });
          }}
          onNext={() => {
            dispatch({ type: 'accept' });
            if (addingAngle && !selectCurrent(useQuickEnrollStore.getState())) {
              setAddingAngle(false);
              setSheetOpen(true);
            }
          }}
          onCloseSheet={() => setSheetOpen(false)}
          onAddPhoto={() => setAddingAngle(true)}
          onCreated={(product) => {
            setCreated((products) => [...products, product]);
            setNotice(`Đã thêm ${product.name || 'Hàng mới'}`);
            setSheetOpen(false);
            setAddingAngle(false);
          }}
        />
      ) : null}
    </View>
  );
}
