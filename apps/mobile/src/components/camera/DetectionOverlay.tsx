import { memo, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';

import { mapBox, stripTop, type BBox, type Fit, type Size } from '@/lib/bbox';

import { AlternativesStrip, type StripItem } from './AlternativesStrip';
import type { CaptureMode } from './ModeToggle';
import { DetectionBox } from './DetectionBox';
import { PricePill } from './PricePill';

export type Detection = {
  id: string;
  name: string;
  /** Top-1 match price in đồng. */
  price: number;
  /** `[x, y, width, height]` in image pixels. */
  bbox: BBox;
  /** Top-1 below the match threshold. */
  lowMatch?: boolean;
  /** Server verdict `ambiguous`: looks low (amber) until the seller picks a candidate. */
  ambiguous?: boolean;
  /** Top-1 first, then look-alikes. */
  alternatives?: readonly StripItem[];
};

type Props = {
  imageSize: Size;
  viewSize: Size;
  fit?: Fit;
  detections: readonly Detection[];
  /** Missing id counts as deselected. */
  selected: Readonly<Record<string, boolean>>;
  mode: CaptureMode;
  /** Detection whose alternatives strip is open. */
  openId?: string | null;
  /** False hides the enroll path: unknown pills render disabled. Default true. */
  canEnroll?: boolean;
  onToggle: (id: string) => void;
  onPricePress: (id: string) => void;
  onChoose: (detectionId: string, itemId: string) => void;
};

const PILL_HEIGHT = 40;
/** Keeps the pill clear of the viewfinder's bottom edge and corner marks. */
const EDGE = 16;

/** Boxes, price pills and the floating strip, positioned over the frozen photo. */
export const DetectionOverlay = memo(function DetectionOverlay({
  imageSize,
  viewSize,
  fit = 'cover',
  detections,
  selected,
  mode,
  openId,
  canEnroll = true,
  onToggle,
  onPricePress,
  onChoose,
}: Props) {
  // Rects depend on the geometry only, so a selection change keeps every box's props equal
  // and the memoised DetectionBox / PricePill skip their render.
  const boxes = useMemo(
    () =>
      detections.map((detection) =>
        mapBox(detection.bbox, imageSize, viewSize, fit),
      ),
    [detections, imageSize, viewSize, fit],
  );
  const placed = useMemo(() => {
    let counter = 0;
    return detections.map((detection, index) => {
      const isSelected = !detection.lowMatch && !!selected[detection.id];
      return {
        detection,
        box: boxes[index]!,
        isSelected,
        guess: !!detection.ambiguous && !isSelected,
        number: isSelected && mode === 'many' ? ++counter : undefined,
      };
    });
  }, [detections, boxes, selected, mode]);

  const open = placed.find(
    (item) => item.detection.id === openId && item.detection.alternatives,
  );

  return (
    <View
      style={[StyleSheet.absoluteFill, styles.overlay]}
      pointerEvents="box-none"
    >
      {placed.map(({ detection, box, isSelected, guess, number }) => (
        <DetectionBox
          key={detection.id}
          id={detection.id}
          box={box}
          state={
            detection.lowMatch
              ? 'low'
              : guess
                ? 'guess'
                : isSelected
                  ? 'selected'
                  : 'deselected'
          }
          number={number}
          name={detection.name}
          onPress={onToggle}
        />
      ))}
      {placed.map(({ detection, box, isSelected, guess }) => (
        <View
          key={detection.id}
          pointerEvents="box-none"
          style={[
            styles.pillAnchor,
            {
              left: box.x,
              top: Math.min(
                box.y + box.height - PILL_HEIGHT / 2,
                viewSize.height - PILL_HEIGHT - EDGE,
              ),
              width: box.width,
            },
          ]}
        >
          {detection.lowMatch ? (
            <PricePill
              id={detection.id}
              variant="unknown"
              disabled={!canEnroll}
              onPress={onPricePress}
            />
          ) : (
            <PricePill
              id={detection.id}
              variant={guess ? 'guess' : isSelected ? 'selected' : 'deselected'}
              price={detection.price}
              name={detection.name}
              expanded={detection.id === openId}
              onPress={onPricePress}
            />
          )}
        </View>
      ))}
      {mode === 'many' && open?.detection.alternatives ? (
        <AlternativesStrip
          items={open.detection.alternatives}
          currentId={open.detection.alternatives[0].id}
          placement="floating"
          top={stripTop(open.box, viewSize.height)}
          onChoose={(itemId) => onChoose(open.detection.id, itemId)}
        />
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  overlay: { overflow: 'hidden' },
  pillAnchor: { position: 'absolute', alignItems: 'center' },
});
