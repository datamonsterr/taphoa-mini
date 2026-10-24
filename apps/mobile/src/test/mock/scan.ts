import { newUuid } from '@/lib/uuid';
import type {
  Candidate,
  Detection,
  Image,
  Product,
  Scan,
  ScanMode,
  ScanPurpose,
} from '@/lib/api/types';

import { getMockDb, nowIso } from './db';
import { PRODUCT_IDS } from './fixtures';
import { getMockScenario } from './scenario';

export const SCAN_IMAGE_SIZE = { width: 1080, height: 1440 } as const;

/** Look-alike groups: top-1 first, then products the embedder confuses it with. */
const LOOKALIKES: (keyof typeof PRODUCT_IDS)[][] = [
  ['coca', 'pepsi', '7up'],
  ['haohao', 'omachi'],
  ['vinamilk', 'lavie', 'oreo'],
];

type Outcome = 'matched' | 'ambiguous' | 'unknown';
type Plan = { boxes: number; outcome: Outcome };

function plan(mode: ScanMode, singleSeq: number): Plan {
  const scenario = getMockScenario();
  switch (scenario) {
    case 'match':
      return { boxes: 1, outcome: 'matched' };
    case 'multi':
      return { boxes: 3, outcome: 'matched' };
    case 'unknown':
      return { boxes: 1, outcome: 'unknown' };
    case 'ambiguous':
      return { boxes: 1, outcome: 'ambiguous' };
    default:
      if (mode === 'multi') return { boxes: 3, outcome: 'matched' };
      return { boxes: 1, outcome: singleSeq % 3 === 0 ? 'unknown' : 'matched' };
  }
}

/** [x, y, width, height] in image pixels, ordered left to right. */
function boxesFor(count: number): [number, number, number, number][] {
  const { width, height } = SCAN_IMAGE_SIZE;
  if (count === 1) {
    const w = Math.round(width * 0.45);
    const h = Math.round(w * 1.3);
    return [[Math.round((width - w) / 2), Math.round((height - h) / 2), w, h]];
  }
  const w = Math.round(width * 0.25);
  const h = Math.round(w * 1.5);
  const gap = Math.round((width - count * w) / (count + 1));
  return Array.from({ length: count }, (_, i) => [
    gap + i * (w + gap),
    Math.round(height * 0.34) + (i % 2) * 40,
    w,
    h,
  ]);
}

function candidatesFor(
  group: (keyof typeof PRODUCT_IDS)[],
  topK: number,
  outcome: Outcome,
): Candidate[] {
  const db = getMockDb();
  const ids = [
    ...group.map((key) => PRODUCT_IDS[key]),
    ...db.products.map((p) => p.product.id),
  ].filter((id, i, all) => all.indexOf(id) === i);
  const top =
    outcome === 'matched' ? 0.94 : outcome === 'ambiguous' ? 0.82 : 0.31;
  const step =
    outcome === 'ambiguous' ? 0.015 : outcome === 'matched' ? 0.08 : 0.03;
  return ids
    .map((id) => db.products.find((p) => p.product.id === id)?.product)
    .filter((p): p is Product => p !== undefined && !p.archived)
    .slice(0, topK)
    .map((p, i) => ({
      product_id: p.id,
      similarity: Math.round((top - i * step) * 100) / 100,
      name: p.name ?? null,
      price: p.price,
      default_unit_id: null,
      ...(p.images[0] ? { thumbnail_url: p.images[0].url } : {}),
    }));
}

export function buildScan(input: {
  image: Image;
  mode: ScanMode;
  purpose: ScanPurpose;
  topK: number;
}): Scan {
  const db = getMockDb();
  const seq = db.scanCount;
  db.scanCount += 1;
  if (input.mode === 'single') db.singleScanCount += 1;
  const { boxes, outcome } = plan(input.mode, db.singleScanCount);

  const detections: Detection[] = boxesFor(boxes).map((bbox, i) => ({
    id: newUuid(),
    bbox,
    score: Math.round((0.97 - i * 0.02) * 100) / 100,
    match: outcome,
    candidates: candidatesFor(
      LOOKALIKES[(seq + i) % LOOKALIKES.length]!,
      input.topK,
      outcome,
    ),
  }));

  const scan: Scan = {
    id: newUuid(),
    image: { ...input.image, ...SCAN_IMAGE_SIZE },
    mode: input.mode,
    purpose: input.purpose,
    pipeline: {
      segmenter: 'mock-segmenter',
      embedder: 'mock-embedder',
      catalog_version: db.products.length,
    },
    timings_ms: { segment: 40, embed: 25, search: 5, total: 70 },
    detections,
    document: { detected: false, score: 0, text_lines: 0 },
    created_at: nowIso(),
  };
  db.scans.set(scan.id, scan);
  return scan;
}
