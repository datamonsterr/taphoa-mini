import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Camera, X } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, StyleSheet, View } from 'react-native';

import { Shutter } from '@/components/camera';
import { CircleButton, Icon, PressableScale, Text } from '@/components/ui';
import {
  isApiError,
  useAddProductImage,
  useCreateProduct,
  usePatchProduct,
  useUploadImage,
  type Candidate,
} from '@/lib/api';
import { parseCrop } from '@/lib/bbox';
import { formatVnd } from '@/lib/format';
import { newUuid } from '@/lib/uuid';
import { useCartStore } from '@/stores/cart';
import { colors, fontFamily, radius, space, typography } from '@/theme';

import { ProductForm, type ProductValues } from './ProductForm';

import { barcodeConflict } from './barcodeConflict';

import { cropPhoto } from './cropPhoto';
import { toLocalPhoto } from './localPhoto';

const MAX_PHOTOS = 5;
const FALLBACK_NAME = 'Hàng mới';

type CaptureProps = {
  visible: boolean;
  onCancel: () => void;
  onCaptured: (uri: string) => void;
};

function CaptureModal({ visible, onCancel, onCaptured }: CaptureProps) {
  const [permission, requestPermission] = useCameraPermissions();
  const camRef = useRef<CameraView>(null);
  const [busy, setBusy] = useState(false);

  const shoot = useCallback(async () => {
    setBusy(true);
    try {
      const shot = await camRef.current?.takePictureAsync({ quality: 0.8 });
      if (shot) onCaptured(shot.uri);
    } finally {
      setBusy(false);
    }
  }, [onCaptured]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
    >
      <View style={styles.captureRoot}>
        <View style={styles.captureClose}>
          <CircleButton
            icon={X}
            variant="ink"
            accessibilityLabel="Hủy chụp"
            onPress={onCancel}
          />
        </View>
        {permission?.granted ? (
          <>
            <CameraView ref={camRef} facing="back" style={styles.captureView} />
            <Shutter label="Chụp" busy={busy} onPress={shoot} />
          </>
        ) : permission ? (
          <View style={styles.captureDenied}>
            <Text style={styles.deniedText}>Cần quyền camera để chụp ảnh</Text>
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel="Cấp quyền camera"
              onPress={requestPermission}
              style={styles.grant}
            >
              <Icon icon={Camera} color={colors.ink} />
            </PressableScale>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

export function EnrollScreen() {
  const router = useRouter();
  // `scanId` and `detectionId` are the camera's hand-off; CreateProductRequest has no field for
  // them yet. `crop` ("x,y,w,h" in photo pixels) is the pressed detection's box.
  // From the dashboard, `manualLineId`, `name`, `price` and `cropUrl` prefill a sold-without-
  // catalog item; saving then resolves that line.
  const {
    photoUri,
    crop,
    manualLineId,
    name: nameParam,
    price: priceParam,
    cropUrl,
    barcode: barcodeParam,
  } = useLocalSearchParams<{
    photoUri?: string;
    scanId?: string;
    detectionId?: string;
    crop?: string;
    manualLineId?: string;
    name?: string;
    price?: string;
    cropUrl?: string;
    barcode?: string;
  }>();
  const cropRect = parseCrop(crop);
  const upload = useUploadImage();
  const createProduct = useCreateProduct();
  const addImage = useAddProductImage();
  const patchProduct = usePatchProduct();
  const addToCart = useCartStore((s) => s.add);

  // The photo list stays empty until the crop (or the downloaded manual-line crop) is ready, so
  // the whole frame is never uploaded by mistake; if cropping fails it falls back to the photo.
  const remoteCrop = !photoUri && !!cropUrl;
  const [preparing, setPreparing] = useState(
    () => (!!photoUri && !!cropRect) || remoteCrop,
  );
  const [photos, setPhotos] = useState<string[]>(() =>
    photoUri && !cropRect ? [photoUri] : [],
  );
  useEffect(() => {
    let job: Promise<string> | null = null;
    if (photoUri && cropRect) {
      job = cropPhoto(photoUri, cropRect).catch(() => photoUri);
    } else if (remoteCrop && cropUrl) {
      job = toLocalPhoto(cropUrl);
    }
    if (!job) return undefined;
    let cancelled = false;
    job
      .then((uri) => {
        if (!cancelled) setPhotos((list) => [uri, ...list]);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setPreparing(false);
      });
    return () => {
      cancelled = true;
    };
    // The route params never change while the sheet is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photoUri, crop, cropUrl]);
  const values = useRef<ProductValues>({
    name: nameParam ?? '',
    barcode: barcodeParam ?? '',
    price: Number(priceParam) || 0,
  });
  const [capturing, setCapturing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [barcodeError, setBarcodeError] = useState('');
  const [failed, setFailed] = useState(false);
  // The server found a look-alike: the person decides to merge the photos or to create anyway.
  const [duplicate, setDuplicate] = useState<Candidate | null>(null);
  const productId = useRef(newUuid()).current;
  const uploaded = useRef(new Map<string, string>()).current;

  const close = useCallback(() => router.back(), [router]);
  const openCapture = useCallback(() => setCapturing(true), []);
  const closeCapture = useCallback(() => setCapturing(false), []);
  const onCaptured = useCallback((uri: string) => {
    setPhotos((list) => (list.length < MAX_PHOTOS ? [...list, uri] : list));
    setCapturing(false);
  }, []);

  const save = useCallback(
    async (mode: 'check' | 'force' | 'merge' = 'check') => {
      const { name, price, barcode } = values.current;
      setSaving(true);
      setFailed(false);
      setBarcodeError('');
      try {
        const imageIds: string[] = [];
        for (const [index, uri] of photos.entries()) {
          let id = uploaded.get(uri);
          if (!id) {
            const image = await upload.mutateAsync({
              file: {
                uri,
                name: `enroll-${index + 1}.jpg`,
                type: 'image/jpeg',
              },
              purpose: 'enrollment',
            });
            id = image.id;
            uploaded.set(uri, id);
          }
          imageIds.push(id);
        }
        if (mode === 'merge' && duplicate) {
          if (barcode)
            await patchProduct.mutateAsync({
              id: duplicate.product_id,
              patch: { barcode },
            });
          for (const imageId of imageIds) {
            await addImage.mutateAsync({
              id: duplicate.product_id,
              image_id: imageId,
            });
          }
          addToCart({
            productId: duplicate.product_id,
            name: duplicate.name ?? FALLBACK_NAME,
            price: duplicate.price,
          });
        } else {
          const trimmed = name.trim();
          const product = await createProduct.mutateAsync({
            id: productId,
            price,
            ...(barcode ? { barcode } : {}),
            image_ids: imageIds,
            force_new: mode === 'force',
            ...(manualLineId ? { from_manual_line_id: manualLineId } : {}),
            ...(trimmed ? { name: trimmed } : {}),
          });
          // A manual line is already sold: enrolling it must not put the product in the cart.
          if (!manualLineId) {
            addToCart({
              productId: product.id,
              name: product.name ?? FALLBACK_NAME,
              price: product.price,
              imageUrl: product.images[0]?.url,
            });
          }
        }
        void Haptics.notificationAsync(
          Haptics.NotificationFeedbackType.Success,
        );
        router.back();
      } catch (error) {
        const conflict = await barcodeConflict(error, barcode ?? '');
        if (conflict) {
          setBarcodeError(conflict);
          return;
        }
        const candidate = duplicateOf(error);
        if (candidate) {
          setDuplicate(candidate);
        } else {
          setFailed(true);
        }
      } finally {
        setSaving(false);
      }
    },
    [
      photos,
      uploaded,
      upload,
      createProduct,
      addImage,
      patchProduct,
      duplicate,
      productId,
      manualLineId,
      addToCart,
      router,
    ],
  );

  const onSave = useCallback(
    (next: ProductValues) => {
      values.current = next;
      void save();
    },
    [save],
  );
  const onMerge = useCallback(() => {
    void save('merge');
  }, [save]);
  const onForce = useCallback(() => {
    setDuplicate(null);
    void save('force');
  }, [save]);

  return (
    <ProductForm
      photos={photos.map((uri) => ({ id: uri, uri }))}
      maxPhotos={MAX_PHOTOS}
      onAddPhoto={openCapture}
      onSave={onSave}
      onValuesChange={(next) => {
        values.current = next;
      }}
      saving={saving}
      disabled={preparing}
      initialName={nameParam}
      initialPrice={priceParam}
      initialBarcode={barcodeParam}
      barcodeError={barcodeError}
      onBarcodeChange={() => setBarcodeError('')}
      onClose={close}
      footer={
        <View style={styles.footer}>
          {duplicate ? (
            <View style={styles.duplicate}>
              <Text accessibilityRole="alert" style={styles.error}>
                {`Giống "${duplicate.name ?? FALLBACK_NAME}" (${formatVnd(duplicate.price)}). Gộp ảnh vào món đó?`}
              </Text>
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel="Gộp ảnh vào món có sẵn"
                disabled={saving}
                onPress={onMerge}
                style={styles.choice}
              >
                <Text style={styles.choiceText}>Gộp ảnh vào món có sẵn</Text>
              </PressableScale>
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel="Vẫn tạo món mới"
                disabled={saving}
                onPress={onForce}
                style={[styles.choice, styles.choiceAlt]}
              >
                <Text style={styles.choiceAltText}>Vẫn tạo món mới</Text>
              </PressableScale>
            </View>
          ) : null}
          {failed ? (
            <Text accessibilityRole="alert" style={styles.error}>
              Không lưu được. Bạn đã nhập vẫn còn, thử lại.
            </Text>
          ) : null}
        </View>
      }
    >
      <CaptureModal
        visible={capturing}
        onCancel={closeCapture}
        onCaptured={onCaptured}
      />
    </ProductForm>
  );
}

/** The look-alike the server reported with `409 duplicate_suspected`, if this error is one. */
function duplicateOf(error: unknown): Candidate | null {
  if (!isApiError(error) || error.code !== 'duplicate_suspected') return null;
  const candidates = error.body.details?.candidates;
  return Array.isArray(candidates)
    ? ((candidates[0] as Candidate) ?? null)
    : null;
}

const styles = StyleSheet.create({
  footer: { gap: space[2] },
  duplicate: { gap: space[2] },
  choice: {
    minHeight: 56,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: colors.ink,
  },
  choiceText: { ...typography.label, color: colors.onInk },
  choiceAlt: { backgroundColor: colors.surfaceSoft },
  choiceAltText: { ...typography.label, color: colors.ink },
  error: { ...typography.label, color: colors.danger, textAlign: 'center' },
  captureRoot: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[6],
    padding: space[4],
    backgroundColor: colors.cameraBg,
  },
  captureClose: { alignSelf: 'flex-start' },
  captureView: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: radius.lg,
    overflow: 'hidden',
  },
  captureDenied: { alignItems: 'center', gap: space[4] },
  deniedText: {
    fontFamily: fontFamily.medium,
    fontSize: 18,
    color: colors.cameraInk,
    textAlign: 'center',
  },
  grant: {
    width: 64,
    height: 64,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: colors.surface,
  },
});
