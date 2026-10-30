import { PostHogMaskView } from '@/components/ui/ReplayMask';
import { Image } from 'expo-image';
import { Camera, Pencil, X } from 'lucide-react-native';
import { memo, useState, type ReactNode } from 'react';
import {
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  CheckButton,
  CircleButton,
  Icon,
  Keypad,
  PressableScale,
  Sheet,
  applyKey,
  Text,
} from '@/components/ui';
import { formatVnd } from '@/lib/format';
import { colors, radius, space, typography } from '@/theme';

import { BarcodeField } from './BarcodeField';
import { validBarcode } from '@/features/camera/barcode';

const PHOTO = 72;
const MAX_DIGITS = 9;
// Fits name, barcode, price and all four keypad rows (1-9, 000, 0, delete) above the save button
// on a 411x914 dp screen; at 740 the 000 row sat below the scrolled fold and nothing could tap it.
export const ENROLL_SHEET_HEIGHT = 840;
export const QUICK_ENROLL_SHEET_HEIGHT = 880;
/** Height of everything in the sheet except the keypad keys (header, fields, price, footer, gaps). */
const FORM_OVERHEAD = 450;
const TITLE_OVERHEAD = 40;
/** Row gap of the keypad (space[3]) times its three gaps. */
const KEY_GAPS = 36;
const MIN_KEY = 48;
const BOARD_KEY = 76;
const SHEET_TOP_GAP = 8;

/**
 * Key diameter that fits all four keypad rows (1-9, 000, 0, delete) in a sheet of this height, so
 * the last row never scrolls below the fold on a short phone. Board size when there is room.
 */
export function enrollKeyDiameter(
  sheetHeight: number,
  bottomInset: number,
  titled: boolean,
) {
  const overhead =
    FORM_OVERHEAD + (titled ? TITLE_OVERHEAD : 0) + bottomInset + KEY_GAPS;
  const fit = Math.floor((sheetHeight - overhead) / 4);
  return Math.min(BOARD_KEY, Math.max(MIN_KEY, fit));
}
export type ProductValues = { name: string; price: number; barcode?: string };
export type ProductPhoto = { id: string; uri: string };
type Props = {
  photos: ProductPhoto[];
  maxPhotos: number;
  minPhotos?: number;
  title?: string;
  onAddPhoto: () => void;
  onRemovePhoto?: (id: string) => void;
  onSave: (values: ProductValues) => void;
  onValuesChange?: (values: ProductValues) => void;
  saving: boolean;
  disabled?: boolean;
  onClose: () => void;
  initialName?: string;
  initialPrice?: string;
  initialBarcode?: string;
  barcodeError?: string;
  onBarcodeChange?: () => void;
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
  title,
  onAddPhoto,
  onRemovePhoto,
  onSave,
  onValuesChange,
  saving,
  disabled = false,
  onClose,
  initialName = '',
  initialPrice = '',
  initialBarcode = '',
  barcodeError,
  onBarcodeChange,
  saveLabel = 'Lưu vào kho và thêm vào giỏ',
  testID = 'enroll-sheet',
  footer,
  children,
}: Props) {
  const [barcode, setBarcode] = useState(initialBarcode);
  const [name, setName] = useState(initialName);
  const [digits, setDigits] = useState(() =>
    String(Math.min(Number(initialPrice) || 0, 10 ** MAX_DIGITS - 1) || ''),
  );
  const { height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  // Same clamp as `Sheet`: the preferred height never passes the window below the top inset.
  const sheetHeight = Math.min(
    title ? QUICK_ENROLL_SHEET_HEIGHT : ENROLL_SHEET_HEIGHT,
    Math.max(0, windowHeight - insets.top - SHEET_TOP_GAP),
  );
  const keyDiameter = enrollKeyDiameter(sheetHeight, insets.bottom, !!title);
  const price = Number(digits || '0');
  const canSave =
    price > 0 &&
    photos.length >= minPhotos &&
    !saving &&
    !disabled &&
    (!barcode || validBarcode(barcode));
  return (
    <Sheet
      height={sheetHeight}
      onClose={onClose}
      testID={testID}
      footer={
        <View style={styles.footer}>
          {footer}
          <CheckButton
            variant="ink"
            accessibilityLabel={saveLabel}
            onPress={() =>
              onSave({
                name: name.trim(),
                price,
                ...(barcode ? { barcode } : {}),
              })
            }
            disabled={!canSave}
            block
          />
        </View>
      }
    >
      {title ? (
        <Text accessibilityRole="header" style={styles.title}>
          {title}
        </Text>
      ) : null}
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
            onValuesChange?.({
              name: next,
              price,
              ...(barcode ? { barcode } : {}),
            });
          }}
          placeholder="Tên"
          placeholderTextColor={colors.inkMuted}
          accessibilityLabel="Tên (không bắt buộc)"
          maxLength={120}
          style={styles.nameInput}
        />
      </View>
      <BarcodeField
        value={barcode}
        disabled={saving}
        error={barcodeError}
        onChange={(next) => {
          setBarcode(next);
          onBarcodeChange?.();
          onValuesChange?.({ name, price, ...(next ? { barcode: next } : {}) });
        }}
      />
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
            onValuesChange?.({
              name,
              price: Number(next || '0'),
              ...(barcode ? { barcode } : {}),
            });
          }}
          diameter={keyDiameter}
        />
      </View>
      {children}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  title: {
    ...typography.heading,
    color: colors.ink,
    textAlign: 'center',
  },
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
