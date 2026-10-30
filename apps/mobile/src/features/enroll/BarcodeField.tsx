import { CameraView, useCameraPermissions } from 'expo-camera';
import { ScanBarcode, X } from 'lucide-react-native';
import { useRef, useState } from 'react';
import { Modal, StyleSheet, TextInput, View } from 'react-native';

import { CircleButton, Text } from '@/components/ui';
import { BARCODE_SETTINGS, validBarcode } from '@/features/camera/barcode';
import { colors, radius, space, typography } from '@/theme';

export function BarcodeField({
  value,
  onChange,
  disabled = false,
  error,
}: {
  value: string;
  onChange: (code: string) => void;
  disabled?: boolean;
  error?: string;
}) {
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState('');
  const [permission, requestPermission] = useCameraPermissions();
  const accepted = useRef(false);
  const invalid = value !== '' && !validBarcode(value);
  return (
    <View style={styles.group}>
      <View style={styles.field}>
        <TextInput
          accessibilityLabel="Mã vạch (không bắt buộc)"
          placeholder="Mã vạch"
          placeholderTextColor={colors.inkMuted}
          keyboardType="number-pad"
          maxLength={20}
          value={value}
          editable={!disabled}
          onChangeText={(text) =>
            onChange(text.replace(/\D/g, '').slice(0, 20))
          }
          style={styles.input}
        />
        <CircleButton
          icon={ScanBarcode}
          accessibilityLabel="Quét mã vạch"
          disabled={disabled}
          onPress={() => {
            accepted.current = false;
            setScanError('');
            setScanning(true);
            if (!permission?.granted) void requestPermission();
          }}
        />
      </View>
      {error || invalid ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error || 'Mã vạch cần 6–20 chữ số'}
        </Text>
      ) : null}
      {scanning ? (
        <Modal onRequestClose={() => setScanning(false)} animationType="slide">
          <View style={styles.scanner}>
            <CircleButton
              icon={X}
              accessibilityLabel="Đóng quét mã vạch"
              onPress={() => setScanning(false)}
            />
            <Text style={styles.hint}>Đưa mã vạch vào khung</Text>
            {permission?.granted ? (
              <CameraView
                facing="back"
                style={styles.preview}
                barcodeScannerSettings={BARCODE_SETTINGS}
                onBarcodeScanned={({ data }) => {
                  if (accepted.current) return;
                  const code = data;
                  if (!validBarcode(code)) {
                    setScanError('Mã vạch cần 6–20 chữ số');
                    return;
                  }
                  accepted.current = true;
                  onChange(code);
                  setScanning(false);
                }}
              />
            ) : (
              <Text style={styles.hint}>Cần quyền camera để quét mã vạch</Text>
            )}
            {scanError ? <Text style={styles.hint}>{scanError}</Text> : null}
          </View>
        </Modal>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({
  group: { gap: space[1] },
  field: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radius.full,
    backgroundColor: colors.surfaceSoft,
    paddingLeft: space[4],
  },
  input: { flex: 1, minWidth: 0, ...typography.body, color: colors.ink },
  error: { ...typography.caption, color: colors.danger },
  scanner: {
    flex: 1,
    padding: space[6],
    paddingTop: space[8],
    gap: space[4],
    justifyContent: 'center',
    backgroundColor: colors.cameraBg,
  },
  preview: {
    width: '100%',
    aspectRatio: 1,
    overflow: 'hidden',
    borderRadius: radius.lg,
  },
  hint: { ...typography.body, color: colors.cameraInk, textAlign: 'center' },
});
