import type { Box } from './geometry';

export type ObjectBox = Box & { trackingId: number | null };
export type TrackedBox = ObjectBox & { id: number };
type Track = TrackedBox & { age: number };
export type TrackerState = { tracks: Track[]; nextId: number };

export function createTracker(): TrackerState {
  'worklet';
  return { tracks: [], nextId: -1 };
}

export function intersectionOverUnion(a: Box, b: Box): number {
  'worklet';
  const overlap =
    Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const union =
    Math.max(0, a.width) * Math.max(0, a.height) +
    Math.max(0, b.width) * Math.max(0, b.height) -
    overlap;
  return union > 0 ? overlap / union : 0;
}

/**
 * Native ML Kit ids are non-negative; fallback ids count down from -1. Greedy global
 * IoU matching (threshold 0.3) is one-to-one and keeps missing tracks for 15 frames.
 * State is explicit so a frame worklet can own it without React renders.
 */
export function trackObjects(
  state: TrackerState,
  detections: readonly ObjectBox[],
  maxAge = 15,
) {
  'worklet';
  const matches: { detection: number; track: number; overlap: number }[] = [];
  detections.forEach((box, detection) => {
    if (box.trackingId !== null) return;
    state.tracks.forEach((previous, track) => {
      if (previous.trackingId !== null) return;
      const overlap = intersectionOverUnion(box, previous);
      if (overlap >= 0.3) matches.push({ detection, track, overlap });
    });
  });
  matches.sort((a, b) => b.overlap - a.overlap);
  const assigned: Record<number, number> = {};
  const usedTracks: number[] = [];
  for (const match of matches) {
    if (
      assigned[match.detection] !== undefined ||
      usedTracks.includes(match.track)
    )
      continue;
    assigned[match.detection] = state.tracks[match.track].id;
    usedTracks.push(match.track);
  }
  let nextId = state.nextId;
  const objects: TrackedBox[] = detections.map((box, i) => ({
    ...box,
    id: box.trackingId ?? assigned[i] ?? nextId--,
  }));
  const retained = state.tracks
    .filter(
      (track) =>
        !objects.some((object) => object.id === track.id) && track.age < maxAge,
    )
    .map((track) => ({ ...track, age: track.age + 1 }));
  return {
    objects,
    state: {
      nextId,
      tracks: [
        ...objects.map((object) => ({ ...object, age: 0 })),
        ...retained,
      ],
    },
  };
}
