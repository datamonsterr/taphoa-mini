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
  MAX_SHOTS,
  MIN_SHOTS,
  selectReferences,
  useQuickEnrollStore,
} from './quickEnroll';

type Props = {
  onClose: () => void;
  onAddPhoto: () => void;
  onCreated: (product: Product) => void;
};

export function QuickEnrollSheet({ onClose, onAddPhoto, onCreated }: Props) {
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
    const references = selectReferences(useQuickEnrollStore.getState());
    if (references.length < MIN_SHOTS) return;
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
      testID="quick-enroll-sheet"
      photos={accepted.map((shot) => ({ id: shot.id, uri: shot.uri }))}
      maxPhotos={MAX_SHOTS}
      minPhotos={MIN_SHOTS}
      onAddPhoto={onAddPhoto}
      onRemovePhoto={(id) => dispatch({ type: 'remove', id })}
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
