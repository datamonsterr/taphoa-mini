import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Camera, Pencil, X } from 'lucide-react-native';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Modal, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { Shutter } from '@/components/camera';
import {
  CheckButton,
  CircleButton,
  Icon,
  Keypad,
  useKeypadDiameter,
  PressableScale,
  Sheet,
  applyKey,
  Text,
} from '@/components/ui';
import type { KeypadKeyId } from '@/components/ui';
import {
  isApiError,
  useAddProductImage,
  useCreateProduct,
  useUploadImage,
  type Candidate,
} from '@/lib/api';
import { parseCrop } from '@/lib/bbox';
import { formatVnd } from '@/lib/format';
import { newUuid } from '@/lib/uuid';
import { useCartStore } from '@/stores/cart';
import { colors, fontFamily, radius, space, typography } from '@/theme';

import { cropPhoto } from './cropPhoto';
import { toLocalPhoto } from './localPhoto';

const MAX_PHOTOS = 5;
const MAX_DIGITS = 9;
const SHEET_HEIGHT = 740;
const PHOTO = 72;
const FALLBACK_NAME = 'Hàng mới';

const Thumb = memo(function Thumb({
  uri,
  primary,
}: {
  uri: string;
  primary: boolean;
}) {
  return (
    <View style={[styles.photo, primary && styles.photoPrimary]}>
      <Image
        source={{ uri }}
        cachePolicy="memory-disk"
        contentFit="cover"
        style={StyleSheet.absoluteFill}
        accessibilityIgnoresInvertColors
      />
    </View>
  );
});

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
  } = useLocalSearchParams<{
    photoUri?: string;
    scanId?: string;
    detectionId?: string;
    crop?: string;
    manualLineId?: string;
    name?: string;
    price?: string;
    cropUrl?: string;
  }>();
  const cropRect = parseCrop(crop);
  const upload = useUploadImage();
  const createProduct = useCreateProduct();
  const addImage = useAddProductImage();
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
  const [name, setName] = useState(nameParam ?? '');
  const [digits, setDigits] = useState(() =>
    priceParam
      ? String(Math.min(Number(priceParam) || 0, 10 ** MAX_DIGITS - 1) || '')
      : '',
  );
  const [capturing, setCapturing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  // The server found a look-alike: the person decides to merge the photos or to create anyway.
  const [duplicate, setDuplicate] = useState<Candidate | null>(null);
  const keyDiameter = useKeypadDiameter(76);
  const productId = useRef(newUuid()).current;
  const uploaded = useRef(new Map<string, string>()).current;

  const price = Number(digits || '0');
  const canSave = price > 0 && photos.length > 0 && !saving && !preparing;

  const close = useCallback(() => router.back(), [router]);
  const onKey = useCallback(
    (key: KeypadKeyId) => setDigits((d) => applyKey(d, key, MAX_DIGITS)),
    [],
  );
  const openCapture = useCallback(() => setCapturing(true), []);
  const closeCapture = useCallback(() => setCapturing(false), []);
  const onCaptured = useCallback((uri: string) => {
    setPhotos((list) => (list.length < MAX_PHOTOS ? [...list, uri] : list));
    setCapturing(false);
  }, []);

  const save = useCallback(
    async (mode: 'check' | 'force' | 'merge' = 'check') => {
      setSaving(true);
      setFailed(false);
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
      name,
      createProduct,
      addImage,
      duplicate,
      productId,
      price,
      manualLineId,
      addToCart,
      router,
    ],
  );

  const onSave = useCallback(() => {
    void save();
  }, [save]);
  const onMerge = useCallback(() => {
    void save('merge');
  }, [save]);
  const onForce = useCallback(() => {
    setDuplicate(null);
    void save('force');
  }, [save]);

  return (
    <Sheet
      height={SHEET_HEIGHT}
      onClose={close}
      testID="enroll-sheet"
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
          <CheckButton
            variant="ink"
            accessibilityLabel="Lưu vào kho và thêm vào giỏ"
            onPress={onSave}
            disabled={!canSave}
            block
          />
        </View>
      }
    >
      <View style={styles.header}>
        <CircleButton icon={X} accessibilityLabel="Đóng" onPress={close} />
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.photos}
          contentContainerStyle={styles.photosContent}
        >
          {photos.map((uri, index) => (
            <Thumb key={uri} uri={uri} primary={index === 0} />
          ))}
          {photos.length < MAX_PHOTOS ? (
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel="Thêm ảnh góc khác"
              onPress={openCapture}
              style={styles.slot}
            >
              <Icon icon={Camera} color={colors.inkMuted} />
            </PressableScale>
          ) : null}
        </ScrollView>
        <Text
          accessibilityLabel={`${photos.length} trên ${MAX_PHOTOS} ảnh`}
          style={styles.count}
        >
          {`${photos.length}/${MAX_PHOTOS}`}
        </Text>
      </View>

      <View style={styles.nameField}>
        <Icon icon={Pencil} color={colors.inkMuted} />
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Tên"
          placeholderTextColor={colors.inkMuted}
          accessibilityLabel="Tên (không bắt buộc)"
          maxLength={120}
          style={styles.nameInput}
        />
      </View>

      <Text
        accessibilityLiveRegion="polite"
        accessibilityLabel="Giá bán"
        style={styles.price}
      >
        {formatVnd(price)}
      </Text>

      <View style={styles.keypad}>
        <Keypad onKey={onKey} diameter={keyDiameter} />
      </View>

      <CaptureModal
        visible={capturing}
        onCancel={closeCapture}
        onCaptured={onCaptured}
      />
    </Sheet>
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
  header: { flexDirection: 'row', alignItems: 'center', gap: space[3] },
  photos: { flex: 1 },
  photosContent: {
    flexGrow: 1,
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: space[2],
  },
  photo: {
    width: PHOTO,
    height: PHOTO,
    overflow: 'hidden',
    borderRadius: radius.md,
    backgroundColor: colors.surfaceSoft,
  },
  photoPrimary: { borderWidth: 3, borderColor: colors.accent },
  slot: {
    width: PHOTO,
    height: PHOTO,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: colors.lineStrong,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  count: {
    ...typography.caption,
    alignSelf: 'flex-end',
    color: colors.inkMuted,
    fontVariant: ['tabular-nums'],
  },
  nameField: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    height: 56,
    paddingHorizontal: 20,
    borderRadius: radius.full,
    backgroundColor: colors.surfaceSoft,
  },
  nameInput: { flex: 1, minWidth: 0, ...typography.body, color: colors.ink },
  price: {
    ...typography.total,
    textAlign: 'center',
    paddingVertical: space[1],
    color: colors.ink,
    fontVariant: ['tabular-nums'],
  },
  keypad: { paddingHorizontal: 22 },
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
