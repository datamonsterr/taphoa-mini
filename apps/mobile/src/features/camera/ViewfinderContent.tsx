import type { PermissionResponse } from 'expo-camera';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { DetectionOverlay, type CaptureMode } from '@/components/camera';
import type { Detection } from '@/components/camera/DetectionOverlay';
import { DocumentOverlay } from '@/components/camera/DocumentOverlay';
import type { Product, Scan } from '@/lib/api';
import { mapBox } from '@/lib/bbox';
import { useT } from '@/lib/i18n';
import { camera } from '@/theme';

import { BarcodeIndicator } from './BarcodeIndicator';
import { styles } from './cameraStyles';
import { ConfidenceBadge } from './ConfidenceBadge';
import { confidencePercent } from './detections';
import { PermissionPrompt } from './PermissionPrompt';
import type { Photo } from './scanReducer';
import { ScanError } from './ScanError';
import { strings } from './strings';

type Size = { width: number; height: number };

type Props = {
  photo: Photo | null | undefined;
  scan: Scan | null | undefined;
  permission: PermissionResponse | null;
  phase: string;
  error: string | null | undefined;
  busy: boolean;
  hasResult: boolean;
  documentDetected: boolean;
  document: Scan['document'] | undefined;
  documentImageSize: Size;
  documentMirrored: boolean;
  mode: CaptureMode;
  detections: Detection[];
  selected: Record<string, boolean>;
  openId: string | null | undefined;
  canEnroll: boolean;
  imageSize: Size;
  viewSize: Size;
  barcodeResult: { code: string; product: Product | null } | null;
  onReset: () => void;
  onRetry: () => void;
  onToggle: (id: string) => void;
  onPricePress: (id: string) => void;
  onChoose: (detectionId: string, productId: string) => void;
  onAskPermission: () => void;
  onOpenSettings: () => void;
};

/** What sits inside the viewfinder: permission prompt, frozen photo with boxes, overlays, errors. */
export function ViewfinderContent(p: Props) {
  const t = useT(strings);
  const { photo, scan, permission, phase, hasResult, mode, selected } = p;
  return (
    <>
      {photo ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('backToCamera')}
            onPress={p.onReset}
            style={StyleSheet.absoluteFill}
          />
          {p.busy ? (
            <View
              testID="scan-busy"
              accessibilityLabel={t('scanning')}
              pointerEvents="none"
              style={styles.busy}
            >
              <ActivityIndicator size="large" color={camera.white} />
            </View>
          ) : null}
          {hasResult && !p.documentDetected ? (
            <>
              <DetectionOverlay
                imageSize={p.imageSize}
                viewSize={p.viewSize}
                detections={p.detections}
                selected={selected}
                mode={mode}
                openId={p.openId}
                canEnroll={p.canEnroll}
                onToggle={p.onToggle}
                onPricePress={p.onPricePress}
                onChoose={p.onChoose}
              />
              {mode === 'one'
                ? p.detections.map((d) => (
                    <ConfidenceBadge
                      key={d.id}
                      box={mapBox(d.bbox, p.imageSize, p.viewSize, 'cover')}
                      percent={confidencePercent(
                        scan!.detections.find((x) => x.id === d.id)!,
                      )}
                      low={!!d.lowMatch || (!!d.ambiguous && !selected[d.id])}
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
          onPress={
            permission.canAskAgain ? p.onAskPermission : p.onOpenSettings
          }
        />
      ) : null}
      {p.documentDetected && p.document ? (
        <DocumentOverlay
          document={p.document}
          imageSize={p.documentImageSize}
          viewSize={p.viewSize}
          mirrored={p.documentMirrored}
        />
      ) : null}
      {p.barcodeResult ? <BarcodeIndicator {...p.barcodeResult} /> : null}
      {phase === 'error' ? (
        <ScanError
          message={p.error ?? t('scanError')}
          retryLabel={t('retry')}
          onRetry={p.onRetry}
        />
      ) : null}
    </>
  );
}
