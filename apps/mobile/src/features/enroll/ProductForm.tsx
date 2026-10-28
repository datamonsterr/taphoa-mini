import { PostHogMaskView } from '@/components/ui/ReplayMask';
import { Image } from 'expo-image';
import { Camera, Pencil, X } from 'lucide-react-native';
import { memo, useState, type ReactNode } from 'react';
import { ScrollView, StyleSheet, TextInput, View } from 'react-native';

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
import { formatVnd } from '@/lib/format';
import { colors, radius, space, typography } from '@/theme';

const PHOTO = 72;
const MAX_DIGITS = 9;
export type ProductValues = { name: string; price: number };
export type ProductPhoto = { id: string; uri: string };
type Props = {
  photos: ProductPhoto[];
  maxPhotos: number;
  minPhotos?: number;
  onAddPhoto: () => void;
  onRemovePhoto?: (id: string) => void;
  onSave: (values: ProductValues) => void;
  onValuesChange?: (values: ProductValues) => void;
  saving: boolean;
  disabled?: boolean;
  onClose: () => void;
  initialName?: string;
  initialPrice?: string;
  saveLabel?: string;
  testID?: string;
  footer?: ReactNode;
  children?: ReactNode;
};

const Thumb = memo(function Thumb({
  uri,
  primary,
}: {
  uri: string;
  primary: boolean;
}) {
  return (
    <PostHogMaskView style={[styles.photo, primary && styles.photoPrimary]}>
      <Image
        source={{ uri }}
        cachePolicy="memory-disk"
        contentFit="cover"
        style={StyleSheet.absoluteFill}
        accessibilityIgnoresInvertColors
      />
    </PostHogMaskView>
  );
});

export function ProductForm({
  photos,
  maxPhotos,
  minPhotos = 1,
  onAddPhoto,
  onRemovePhoto,
  onSave,
  onValuesChange,
  saving,
  disabled = false,
  onClose,
  initialName = '',
  initialPrice = '',
  saveLabel = 'Lưu vào kho và thêm vào giỏ',
  testID = 'enroll-sheet',
  footer,
  children,
}: Props) {
  const [name, setName] = useState(initialName);
  const [digits, setDigits] = useState(() =>
    String(Math.min(Number(initialPrice) || 0, 10 ** MAX_DIGITS - 1) || ''),
  );
  const keyDiameter = useKeypadDiameter(76);
  const price = Number(digits || '0');
  const canSave =
    price > 0 && photos.length >= minPhotos && !saving && !disabled;
  return (
    <Sheet
      height={740}
      onClose={onClose}
      testID={testID}
      footer={
        <View style={styles.footer}>
          {footer}
          <CheckButton
            variant="ink"
            accessibilityLabel={saveLabel}
            onPress={() => onSave({ name: name.trim(), price })}
            disabled={!canSave}
            block
          />
        </View>
      }
    >
      <View style={styles.header}>
        <CircleButton icon={X} accessibilityLabel="Đóng" onPress={onClose} />
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.photos}
          contentContainerStyle={styles.photosContent}
        >
          {photos.map(({ id, uri }, index) => (
            <View key={id}>
              <Thumb uri={uri} primary={index === 0} />
              {onRemovePhoto ? (
                <CircleButton
                  icon={X}
                  accessibilityLabel={`Xóa ảnh ${index + 1}`}
                  disabled={saving}
                  onPress={() => onRemovePhoto(id)}
                />
              ) : null}
            </View>
          ))}
          {photos.length < maxPhotos ? (
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel="Thêm ảnh góc khác"
              disabled={saving}
              onPress={onAddPhoto}
              style={styles.slot}
            >
              <Icon icon={Camera} color={colors.inkMuted} />
            </PressableScale>
          ) : null}
        </ScrollView>
        <Text
          accessibilityLabel={`${photos.length} trên ${maxPhotos} ảnh`}
          style={styles.count}
        >{`${photos.length}/${maxPhotos}`}</Text>
      </View>
      <View style={styles.nameField}>
        <Icon icon={Pencil} color={colors.inkMuted} />
        <TextInput
          value={name}
          onChangeText={(next) => {
            setName(next);
            onValuesChange?.({ name: next, price });
          }}
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
        <Keypad
          onKey={(key) => {
            const next = applyKey(digits, key, MAX_DIGITS);
            setDigits(next);
            onValuesChange?.({ name, price: Number(next || '0') });
          }}
          diameter={keyDiameter}
        />
      </View>
      {children}
    </Sheet>
  );
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
});
