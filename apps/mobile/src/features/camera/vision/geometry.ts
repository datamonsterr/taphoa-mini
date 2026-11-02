export type Box = { x: number; y: number; width: number; height: number };
export type Size = { width: number; height: number };
/** Clockwise rotation of raw frame pixels into the displayed orientation. */
export type Rotation = 0 | 90 | 180 | 270;
export type FrameGeometry = Size & { rotation: Rotation };

/** Matches a centered `resizeMode="cover"` preview. Coordinates are not clipped. */
export function mapBoxToPreview(
  box: Box,
  frame: FrameGeometry,
  view: Size,
  mirrored = false,
): Box | null {
  'worklet';
  if (
    ![frame.width, frame.height, view.width, view.height].every(
      (v) => Number.isFinite(v) && v > 0,
    )
  )
    return null;
  let rotated: Box;
  switch (frame.rotation) {
    case 90:
      rotated = {
        x: frame.height - box.y - box.height,
        y: box.x,
        width: box.height,
        height: box.width,
      };
      break;
    case 180:
      rotated = {
        ...box,
        x: frame.width - box.x - box.width,
        y: frame.height - box.y - box.height,
      };
      break;
    case 270:
      rotated = {
        x: box.y,
        y: frame.width - box.x - box.width,
        width: box.height,
        height: box.width,
      };
      break;
    default:
      rotated = { ...box };
  }
  const sideways = frame.rotation === 90 || frame.rotation === 270;
  const width = sideways ? frame.height : frame.width;
  const height = sideways ? frame.width : frame.height;
  const scale = Math.max(view.width / width, view.height / height);
  if (mirrored) rotated.x = width - rotated.x - rotated.width;
  return {
    x: rotated.x * scale + (view.width - width * scale) / 2,
    y: rotated.y * scale + (view.height - height * scale) / 2,
    width: rotated.width * scale,
    height: rotated.height * scale,
  };
}

/** A tap outside every box unlocks. Ties preserve input order. */
export function selectBoxAtPoint<T extends Box>(
  boxes: readonly T[],
  point: { x: number; y: number },
): T | null {
  'worklet';
  let selected: T | null = null;
  let nearest = Infinity;
  for (const box of boxes) {
    if (
      point.x < box.x ||
      point.x > box.x + box.width ||
      point.y < box.y ||
      point.y > box.y + box.height
    )
      continue;
    const distance =
      (point.x - box.x - box.width / 2) ** 2 +
      (point.y - box.y - box.height / 2) ** 2;
    if (distance < nearest) {
      nearest = distance;
      selected = box;
    }
  }
  return selected;
}
