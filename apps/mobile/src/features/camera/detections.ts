import type { Detection, StripItem } from '@/components/camera';
import type {
  Candidate,
  Detection as ApiDetection,
  Scan,
} from '@/lib/api/types';
import type { NewCartLine } from '@/stores/cart';

import { isLowMatch } from './matching';

function pick(detection: ApiDetection, chosen: Record<string, string>) {
  const picked = detection.candidates.find(
    (c) => c.product_id === chosen[detection.id],
  );
  return picked ?? detection.candidates[0];
}

function toStripItem(c: Candidate, fallbackName: string): StripItem {
  return {
    id: c.product_id,
    name: c.name ?? fallbackName,
    price: c.price,
    thumbnailUri: c.thumbnail_url,
  };
}

/** Scan result in the shape `DetectionOverlay` draws; the chosen candidate leads the strip. */
export function toOverlayDetections(
  scan: Scan,
  chosen: Record<string, string>,
  fallbackName: string,
): Detection[] {
  return scan.detections.map((detection) => {
    const [x, y, width, height] = detection.bbox;
    const bbox = [x!, y!, width!, height!] as const;
    const top = pick(detection, chosen);
    if (isLowMatch(detection)) {
      return {
        id: detection.id,
        name: top?.name ?? fallbackName,
        price: top?.price ?? 0,
        bbox,
        lowMatch: true,
      };
    }
    const items = detection.candidates.map((c) => toStripItem(c, fallbackName));
    const first = items.findIndex((item) => item.id === top!.product_id);
    return {
      id: detection.id,
      name: top!.name ?? fallbackName,
      price: top!.price,
      bbox,
      lowMatch: false,
      ambiguous: detection.match === 'ambiguous',
      alternatives: [items[first]!, ...items.filter((_, i) => i !== first)],
    };
  });
}

/** Cart lines for every selected box, each with its chosen (else top-1) candidate. */
export function toCartLines(
  scan: Scan,
  selected: Record<string, boolean>,
  chosen: Record<string, string>,
  fallbackName: string,
): NewCartLine[] {
  const lines: NewCartLine[] = [];
  for (const detection of scan.detections) {
    if (!selected[detection.id] || isLowMatch(detection)) continue;
    const c = pick(detection, chosen)!;
    lines.push({
      productId: c.product_id,
      name: c.name ?? fallbackName,
      price: c.price,
      ...(c.thumbnail_url ? { imageUrl: c.thumbnail_url } : {}),
      detectionId: detection.id,
      suggestedProductId: detection.candidates[0]!.product_id,
      scanId: scan.id,
      source: scan.mode === 'multi' ? 'multi_photo' : 'camera',
    });
  }
  return lines;
}

/** Top-1 similarity as a whole percent, for the confidence badge. */
export function confidencePercent(detection: ApiDetection): number | undefined {
  const top = detection.candidates[0];
  return top ? Math.round(top.similarity * 100) : undefined;
}
