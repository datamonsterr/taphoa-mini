import { mapBoxToPreview, selectBoxAtPoint } from './geometry';

const box = { x: 10, y: 20, width: 30, height: 40 };

describe('frame pixels to a centered cover preview', () => {
  it.each([
    [0, { x: 10, y: 20, width: 30, height: 40 }],
    [90, { x: 140, y: 10, width: 40, height: 30 }],
    [180, { x: 60, y: 140, width: 30, height: 40 }],
    [270, { x: 20, y: 60, width: 40, height: 30 }],
  ] as const)(
    'rotates clockwise by %i degrees before scaling',
    (rotation, expected) => {
      const view =
        rotation % 180
          ? { width: 200, height: 100 }
          : { width: 100, height: 200 };
      expect(
        mapBoxToPreview(box, { width: 100, height: 200, rotation }, view),
      ).toEqual(expected);
    },
  );

  it('uses cover scaling and preserves boxes beyond the cropped viewport', () => {
    expect(
      mapBoxToPreview(
        box,
        { width: 100, height: 200, rotation: 0 },
        { width: 200, height: 200 },
      ),
    ).toEqual({ x: 20, y: -60, width: 60, height: 80 });
  });

  it('mirrors after rotation in preview coordinates', () => {
    expect(
      mapBoxToPreview(
        box,
        { width: 100, height: 200, rotation: 90 },
        { width: 200, height: 100 },
        true,
      ),
    ).toEqual({ x: 20, y: 10, width: 40, height: 30 });
  });

  it.each([
    [0, { x: 10, y: -30, width: 30, height: 40 }],
    [90, { x: 90, y: 10, width: 40, height: 30 }],
    [180, { x: 60, y: 90, width: 30, height: 40 }],
    [270, { x: -30, y: 60, width: 40, height: 30 }],
  ] as const)(
    'center crops a square preview at %i degrees',
    (rotation, expected) => {
      expect(
        mapBoxToPreview(
          box,
          { width: 100, height: 200, rotation },
          { width: 100, height: 100 },
        ),
      ).toEqual(expected);
    },
  );

  it('returns null before layout and for invalid dimensions', () => {
    expect(
      mapBoxToPreview(
        box,
        { width: 0, height: 200, rotation: 0 },
        { width: 100, height: 200 },
      ),
    ).toBeNull();
    expect(
      mapBoxToPreview(
        box,
        { width: 100, height: 200, rotation: 0 },
        { width: 0, height: 200 },
      ),
    ).toBeNull();
  });
});

describe('tap to lock', () => {
  const boxes = [
    { id: 1, x: 0, y: 0, width: 100, height: 100 },
    { id: 2, x: 40, y: 40, width: 60, height: 60 },
    { id: 3, x: 150, y: 0, width: 30, height: 30 },
  ];
  it('only selects a containing box, choosing its nearest centre', () => {
    expect(selectBoxAtPoint(boxes, { x: 49, y: 49 })?.id).toBe(1);
    expect(selectBoxAtPoint(boxes, { x: 80, y: 80 })?.id).toBe(2);
    expect(selectBoxAtPoint(boxes, { x: 150, y: 0 })?.id).toBe(3);
    expect(selectBoxAtPoint(boxes, { x: 130, y: 20 })).toBeNull();
    expect(selectBoxAtPoint([], { x: 0, y: 0 })).toBeNull();
  });
});
