import { useRouter, type Href } from 'expo-router';
import { useCallback } from 'react';

import type { NextStepChipData } from '@/components/assistant/chip';
import type { Detection } from '@/components/camera/DetectionOverlay';
import { useAssistantEnabled } from '@/features/assistant/flags';
import { assistantHref } from '@/features/assistant/route';
import { useNextStepChips } from '@/features/assistant/useNextStepChips';
import { voiceHref } from '@/features/voice/route';
import type { Scan } from '@/lib/api';
import { cropRect, formatCrop, type BBox } from '@/lib/bbox';

import { isLowMatch } from './matching';
import type { Photo } from './scanReducer';

type Args = {
  scan: Scan | null | undefined;
  photo: Photo | null | undefined;
  imageSize: { width: number; height: number };
  detections: Detection[];
  canEnroll: boolean;
  joinedAt: string | undefined;
  documentDetected: boolean;
  unknownProduct: boolean;
  readReceipt: (open?: (receiptId: string) => void) => Promise<void>;
  toggleOpen: (id: string) => void;
};

/** Where the board's taps lead: enroll, the next-step chips, and a price press. */
export function useCameraActions({
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
}: Args) {
  const router = useRouter();
  /** Enroll the pressed detection: its id and box (cropped to the photo) go with the photo. */
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

  const assistantOn = useAssistantEnabled();
  const { chips, tap } = useNextStepChips({
    screen: 'camera',
    documentDetected,
    unknownProduct,
    canEnroll,
    enabled: assistantOn,
    joinedAt,
  });
  const onChipPress = (chip: NextStepChipData, position: number) => {
    tap(chip, position);
    const { action } = chip;
    if (action.type === 'receipt')
      void readReceipt(
        action.destination === 'review'
          ? undefined
          : (receiptId) =>
              router.push(
                assistantHref({
                  entry: 'receipt',
                  screen: 'camera',
                  receiptId,
                }),
              ),
      );
    else if (action.type === 'voice') router.push(voiceHref({ entry: 'chip' }));
    else if (action.type === 'enroll')
      goEnroll(scan?.detections.find(isLowMatch)?.id);
    else if (action.type === 'navigate') router.push(action.route as Href);
    else
      router.push(
        assistantHref({
          entry: 'chip',
          prompt: action.prompt_vi,
          screen: action.context.screen,
          nextStepId: action.context.next_step_id,
        }),
      );
  };

  const onPricePress = useCallback(
    (id: string) => {
      if (detections.find((d) => d.id === id)?.lowMatch) goEnroll(id);
      else toggleOpen(id);
    },
    [detections, goEnroll, toggleOpen],
  );

  return { chips, onChipPress, onPricePress };
}
