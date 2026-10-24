import { cropRect, formatCrop, mapBox, parseCrop, stripTop } from './bbox';

const view = { width: 358, height: 358 };

describe('mapBox', () => {
  it('scales uniformly when image and view share aspect ratio', () => {
    const r = mapBox(
      [100, 200, 300, 400],
      { width: 1000, height: 1000 },
      view,
      'cover',
    );
    expect(r.x).toBeCloseTo(35.8);
    expect(r.y).toBeCloseTo(71.6);
    expect(r.width).toBeCloseTo(107.4);
    expect(r.height).toBeCloseTo(143.2);
  });

  it('cover: crops the long side and offsets by half the overflow (portrait image)', () => {
    // 1080x1440 into 360x360: scale = 360/1080 = 1/3, height 480, offsetY = -60
    const r = mapBox(
      [540, 720, 108, 144],
      { width: 1080, height: 1440 },
      { width: 360, height: 360 },
      'cover',
    );
    expect(r.x).toBeCloseTo(180);
    expect(r.y).toBeCloseTo(180);
    expect(r.width).toBeCloseTo(36);
    expect(r.height).toBeCloseTo(48);
  });

  it('cover: landscape image crops horizontally', () => {
    // 1440x1080 into 360x360: scale 1/3, width 480, offsetX -60
    const r = mapBox(
      [600, 300, 300, 300],
      { width: 1440, height: 1080 },
      { width: 360, height: 360 },
      'cover',
    );
    expect(r).toEqual({ x: 140, y: 100, width: 100, height: 100 });
  });

  it('contain: letterboxes with offset on the short side', () => {
    // 1080x1440 into 360x360: scale 0.25, width 270, offsetX 45
    const r = mapBox(
      [0, 0, 1080, 1440],
      { width: 1080, height: 1440 },
      { width: 360, height: 360 },
      'contain',
    );
    expect(r).toEqual({ x: 45, y: 0, width: 270, height: 360 });
  });

  it('contain: landscape image letterboxes vertically', () => {
    const r = mapBox(
      [0, 0, 100, 100],
      { width: 1000, height: 500 },
      { width: 400, height: 400 },
      'contain',
    );
    expect(r).toEqual({ x: 0, y: 100, width: 40, height: 40 });
  });

  it('clamps a box cropped out on the left/top edges', () => {
    const r = mapBox(
      [0, 0, 300, 300],
      { width: 1440, height: 1080 },
      { width: 360, height: 360 },
      'cover',
    );
    // raw x = -60, width 100 -> visible 0..40
    expect(r.x).toBe(0);
    expect(r.width).toBeCloseTo(40);
    expect(r.y).toBe(0);
    expect(r.height).toBeCloseTo(100);
  });

  it('clamps a box overflowing the right/bottom edges', () => {
    const r = mapBox(
      [1300, 900, 400, 400],
      { width: 1440, height: 1080 },
      { width: 360, height: 360 },
      'cover',
    );
    expect(r.x + r.width).toBeCloseTo(360);
    expect(r.y + r.height).toBeCloseTo(360);
  });

  it('returns a zero-size box when fully outside the view', () => {
    const r = mapBox(
      [0, 0, 100, 100],
      { width: 1440, height: 1080 },
      { width: 360, height: 360 },
      'cover',
    );
    expect(r.width).toBe(0);
    expect(r.height).toBeCloseTo(100 / 3);
  });

  it('returns an empty box for a degenerate image or view', () => {
    const zero = { x: 0, y: 0, width: 0, height: 0 };
    expect(
      mapBox([1, 1, 1, 1], { width: 0, height: 10 }, view, 'cover'),
    ).toEqual(zero);
    expect(
      mapBox(
        [1, 1, 1, 1],
        { width: 10, height: 10 },
        { width: 0, height: 5 },
        'cover',
      ),
    ).toEqual(zero);
  });
});

describe('stripTop', () => {
  it('puts the strip below the box when it fits', () => {
    expect(stripTop({ x: 0, y: 52, width: 80, height: 126 }, 358)).toBe(204);
  });

  it('puts the strip above the box when there is no room below', () => {
    expect(stripTop({ x: 0, y: 184, width: 142, height: 142 }, 358)).toBe(108);
  });

  it('never goes above the top margin', () => {
    expect(stripTop({ x: 0, y: 20, width: 50, height: 330 }, 358)).toBe(8);
  });
});

describe('cropRect', () => {
  it('scales the box from the scanned image onto the photo', () => {
    expect(
      cropRect(
        [100, 200, 300, 400],
        { width: 1080, height: 1440 },
        { width: 540, height: 720 },
      ),
    ).toEqual({ originX: 50, originY: 100, width: 150, height: 200 });
  });

  it('clamps to the photo and drops an empty box', () => {
    const size = { width: 100, height: 100 };
    expect(cropRect([90, 90, 50, 50], size, size)).toEqual({
      originX: 90,
      originY: 90,
      width: 10,
      height: 10,
    });
    expect(cropRect([120, 0, 10, 10], size, size)).toBeNull();
    expect(cropRect([0, 0, 10, 10], { width: 0, height: 0 }, size)).toBeNull();
  });
});

describe('crop params', () => {
  it('round-trips', () => {
    const rect = { originX: 1, originY: 2, width: 30, height: 40 };
    expect(parseCrop(formatCrop(rect))).toEqual(rect);
  });

  it('rejects missing, malformed and empty values', () => {
    for (const bad of [
      undefined,
      '',
      '1,2,3',
      'a,b,c,d',
      '1,2,0,4',
      '-1,2,3,4',
    ]) {
      expect(parseCrop(bad)).toBeNull();
    }
  });
});
