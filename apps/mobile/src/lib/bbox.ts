export type Size = { width: number; height: number };
export type Rect = { x: number; y: number; width: number; height: number };
/** `[x, y, width, height]` in image pixels, as the API returns it. */
export type BBox = readonly [number, number, number, number];
export type Fit = 'cover' | 'contain';

const EMPTY: Rect = { x: 0, y: 0, width: 0, height: 0 };

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Map an image-pixel box into view coordinates for an image drawn with the given fit
 * (`cover` crops the overflow, `contain` letterboxes). The result is clamped to the view.
 */
export function mapBox(
  bbox: BBox,
  imageSize: Size,
  viewSize: Size,
  fit: Fit,
): Rect {
  if (
    imageSize.width <= 0 ||
    imageSize.height <= 0 ||
    viewSize.width <= 0 ||
    viewSize.height <= 0
  ) {
    return EMPTY;
  }
  const sx = viewSize.width / imageSize.width;
  const sy = viewSize.height / imageSize.height;
  const scale = fit === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy);
  const offsetX = (viewSize.width - imageSize.width * scale) / 2;
  const offsetY = (viewSize.height - imageSize.height * scale) / 2;

  const left = clamp(bbox[0] * scale + offsetX, 0, viewSize.width);
  const top = clamp(bbox[1] * scale + offsetY, 0, viewSize.height);
  const right = clamp((bbox[0] + bbox[2]) * scale + offsetX, 0, viewSize.width);
  const bottom = clamp(
    (bbox[1] + bbox[3]) * scale + offsetY,
    0,
    viewSize.height,
  );
  return { x: left, y: top, width: right - left, height: bottom - top };
}

const STRIP_HEIGHT = 64;
const STRIP_GAP = 26;
const STRIP_MARGIN = 8;

/** Top of a floating strip: below the box (clearing its price pill), else above it. */
export function stripTop(
  box: Rect,
  viewHeight: number,
  stripHeight = STRIP_HEIGHT,
): number {
  const below = box.y + box.height + STRIP_GAP;
  if (below + stripHeight <= viewHeight - STRIP_MARGIN) return below;
  return Math.max(STRIP_MARGIN, box.y - stripHeight - 12);
}

/** Crop rectangle in pixels of the photo that was scanned. */
export type CropRect = {
  originX: number;
  originY: number;
  width: number;
  height: number;
};

/**
 * Scale an API box (image pixels of the uploaded scan) onto the local photo, clamped to it.
 * Returns null when the box is empty once clamped.
 */
export function cropRect(
  bbox: BBox,
  scanImage: Size,
  photo: Size,
): CropRect | null {
  if (scanImage.width <= 0 || scanImage.height <= 0) return null;
  const sx = photo.width / scanImage.width;
  const sy = photo.height / scanImage.height;
  const left = clamp(Math.round(bbox[0] * sx), 0, photo.width);
  const top = clamp(Math.round(bbox[1] * sy), 0, photo.height);
  const right = clamp(Math.round((bbox[0] + bbox[2]) * sx), 0, photo.width);
  const bottom = clamp(Math.round((bbox[1] + bbox[3]) * sy), 0, photo.height);
  if (right <= left || bottom <= top) return null;
  return {
    originX: left,
    originY: top,
    width: right - left,
    height: bottom - top,
  };
}

/** Route-param form of a crop rect: "x,y,w,h". */
export const formatCrop = (r: CropRect) =>
  `${r.originX},${r.originY},${r.width},${r.height}`;

export function parseCrop(value: string | undefined): CropRect | null {
  if (!value) return null;
  const parts = value.split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [originX, originY, width, height] = parts as [
    number,
    number,
    number,
    number,
  ];
  if (width <= 0 || height <= 0 || originX < 0 || originY < 0) return null;
  return { originX, originY, width, height };
}
