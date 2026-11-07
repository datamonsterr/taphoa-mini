import { useRef, useState } from 'react';
import { Alert } from 'react-native';

import { ProductForm, type ProductValues } from '@/features/enroll/ProductForm';
import {
  isApiError,
  useCreateProduct,
  type Candidate,
  type Product,
} from '@/lib/api';
import { barcodeConflict } from '@/features/enroll/barcodeConflict';
import { newUuid } from '@/lib/uuid';
import {
  keyframeReferences,
  MIN_KEYFRAMES,
  type Keyframe,
  type voiceDraftToForm,
} from './vision/enrollment';

import {
  MAX_SHOTS,
  MIN_SHOTS,
  selectReferences,
  useQuickEnrollStore,
} from './quickEnroll';

type Props = {
  onClose: () => void;
  onAddPhoto: () => void;
  onCreated: (product: Product) => void;
  oneTrip?: {
    frames: Keyframe[];
    draft: ReturnType<typeof voiceDraftToForm>;
    voiceSuccess: boolean;
  };
};

export function QuickEnrollSheet({
  onClose,
  onAddPhoto,
  onCreated,
  oneTrip,
}: Props) {
  const shots = useQuickEnrollStore((s) => s.shots);
  const dispatch = useQuickEnrollStore((s) => s.dispatch);
  const create = useCreateProduct();
  const [barcodeError, setBarcodeError] = useState('');
  const [saving, setSaving] = useState(false);
  const productId = useRef<string | null>(null);
  const pending = useRef(false);
  const accepted = shots.filter((s) => s.status === 'accepted');

  async function save(values: ProductValues, forceNew = false) {
    if (pending.current) return;
    const references = oneTrip
      ? keyframeReferences(oneTrip.frames)
      : selectReferences(useQuickEnrollStore.getState());
    if (references.length < (oneTrip ? MIN_KEYFRAMES : MIN_SHOTS)) return;
    productId.current ??= newUuid();
    pending.current = true;
    setSaving(true);
    try {
      const product = await create.mutateAsync({
        id: productId.current,
        ...values,
        references,
        force_new: forceNew,
      });
      onCreated(product);
      if (useQuickEnrollStore.getState().active) dispatch({ type: 'toggle' });
    } catch (error) {
      const conflict = await barcodeConflict(error, values.barcode ?? '');
      if (conflict) {
        setBarcodeError(conflict);
        return;
      }
      if (isApiError(error) && error.code === 'duplicate_suspected') {
        const candidates = error.body.details?.candidates;
        const candidate = Array.isArray(candidates)
          ? (candidates[0] as Candidate | undefined)
          : undefined;
        Alert.alert(
          `Giống "${candidate?.name ?? 'hàng có sẵn'}"?`,
          'Vẫn tạo sản phẩm mới?',
          [
            { text: 'Hủy', style: 'cancel' },
            { text: 'Vẫn tạo món mới', onPress: () => void save(values, true) },
          ],
        );
      } else {
        Alert.alert('Không lưu được', 'Bạn đã nhập vẫn còn, thử lại.');
      }
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }

  return (
    <ProductForm
      testID={oneTrip ? 'one-trip-enroll-sheet' : 'quick-enroll-sheet'}
      title={
        oneTrip
          ? `Thêm hàng · ${oneTrip.frames.length} khung hình`
          : `Thêm hàng nhanh · ${accepted.length}/${MIN_SHOTS}`
      }
      photos={
        oneTrip
          ? oneTrip.frames.map((frame, i) => ({
              id: String(i),
              uri: frame.uri,
            }))
          : accepted.map((shot) => ({ id: shot.id, uri: shot.uri }))
      }
      maxPhotos={oneTrip ? oneTrip.frames.length : MAX_SHOTS}
      minPhotos={oneTrip ? MIN_KEYFRAMES : MIN_SHOTS}
      initialName={oneTrip?.draft.name}
      initialPrice={oneTrip?.draft.price}
      initialUnit={oneTrip?.draft.unit}
      autoFocusName={oneTrip ? !oneTrip.voiceSuccess : false}
      disabled={
        oneTrip ? oneTrip.frames.some((frame) => !frame.imageId) : false
      }
      onAddPhoto={onAddPhoto}
      onRemovePhoto={
        oneTrip ? undefined : (id) => dispatch({ type: 'remove', id })
      }
      onSave={(values) => void save(values)}
      saving={saving}
      barcodeError={barcodeError}
      onBarcodeChange={() => setBarcodeError('')}
      onClose={() => {
        if (!pending.current) onClose();
      }}
      saveLabel="Lưu sản phẩm"
    />
  );
}
