import type { Candidate, Scan } from '@/lib/api/types';
import type { ScanBox } from '@/lib/api/images';
import { mapBoxToPreview, type FrameGeometry } from './geometry';
import { intersectionOverUnion, type TrackedBox } from './tracker';

/** Photo and frame outputs use the same 4:3 field of view; EXIF is applied before upload. */
export function normalizeBoxes(
  boxes: readonly TrackedBox[],
  frame: FrameGeometry,
): ScanBox[] {
  'worklet';
  const sideways = frame.rotation % 180 !== 0;
  const view = {
    width: sideways ? frame.height : frame.width,
    height: sideways ? frame.width : frame.height,
  };
  const result: ScanBox[] = [];
  for (const box of boxes) {
    if (
      ![box.x, box.y, box.width, box.height].every(Number.isFinite) ||
      box.width <= 0 ||
      box.height <= 0
    )
      continue;
    const upright = mapBoxToPreview(box, frame, view);
    if (!upright) continue;
    const x = Math.max(0, Math.min(1, upright.x / view.width));
    const y = Math.max(0, Math.min(1, upright.y / view.height));
    const right = Math.max(
      0,
      Math.min(1, (upright.x + upright.width) / view.width),
    );
    const bottom = Math.max(
      0,
      Math.min(1, (upright.y + upright.height) / view.height),
    );
    if (right <= x || bottom <= y) continue;
    result.push({
      x,
      y,
      width: right - x,
      height: bottom - y,
      track_id: box.id,
    });
    if (result.length === 10) break;
  }
  return result;
}

export type Stability = {
  baseline: TrackedBox[];
  since: number;
  last: number;
  firedKey: string | null;
};
export function createStability(): Stability {
  'worklet';
  return { baseline: [], since: 0, last: 0, firedKey: null };
}
/** The baseline must remain within .8 IoU throughout the interval, not just at its endpoints. */
export function updateStability(
  state: Stability,
  boxes: TrackedBox[],
  now: number,
  enabled: boolean,
) {
  'worklet';
  const key = boxes
    .map((b) => b.id)
    .sort((a, b) => a - b)
    .join(',');
  const same =
    boxes.length > 0 &&
    boxes.length === state.baseline.length &&
    boxes.every((b) => {
      const old = state.baseline.find((p) => p.id === b.id);
      return old && intersectionOverUnion(old, b) > 0.8;
    });
  const fresh = now - state.last <= 1000;
  const next = { ...state, last: now };
  if (!same || !fresh) {
    next.baseline = boxes;
    next.since = now;
  }
  if (
    key !==
    state.baseline
      .map((b) => b.id)
      .sort((a, b) => a - b)
      .join(',')
  )
    next.firedKey = null;
  const trigger =
    enabled &&
    same &&
    fresh &&
    now - next.since >= 700 &&
    next.firedKey !== key;
  if (trigger) next.firedKey = key;
  return { state: next, trigger };
}

export type VoteHistory = Record<
  number,
  { recent: (Candidate | null)[]; label?: Candidate }
>;
/** Unknown and ambiguous answers occupy a history slot, but cannot vote against a known label. */
export function voteScan(
  previous: VoteHistory,
  input: Scan,
): { history: VoteHistory; scan: Scan } {
  const history = { ...previous };
  const detections = input.detections.map((d) => {
    if (d.track_id === undefined) return d;
    const old = history[d.track_id];
    const candidate = d.match === 'matched' ? d.candidates[0] : undefined;
    const recent = [...(old?.recent ?? []), candidate ?? null].slice(-3);
    const majority = recent.find(
      (c) =>
        c && recent.filter((p) => p?.product_id === c.product_id).length >= 2,
    );
    const label = majority ?? old?.label;
    history[d.track_id] = { recent, label };
    if (!label) return d;
    return {
      ...d,
      match: 'matched' as const,
      candidates: [
        label,
        ...d.candidates.filter((c) => c.product_id !== label.product_id),
      ],
    };
  });
  // Tracking ids are session-local. Bound storage even on a long-running counter camera.
  const keys = Object.keys(history);
  for (const key of keys.slice(0, Math.max(0, keys.length - 50)))
    delete history[Number(key)];
  return { history, scan: { ...input, detections } };
}
