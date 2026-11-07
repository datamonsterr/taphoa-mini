import {
  normalizeBoxes,
  createStability,
  updateStability,
  voteScan,
} from './identify';
import { candidate, detection, scan } from '../testing';
const box = (id = 1, x = 10) => ({
  id,
  trackingId: id,
  x,
  y: 20,
  width: 30,
  height: 40,
});
it.each([
  [0, { x: 0.1, y: 0.1, width: 0.3, height: 0.2 }],
  [90, { x: 0.7, y: 0.1, width: 0.2, height: 0.3 }],
  [180, { x: 0.6, y: 0.7, width: 0.3, height: 0.2 }],
  [270, { x: 0.1, y: 0.6, width: 0.2, height: 0.3 }],
] as const)(
  'normalizes raw boxes into upright upload space at %i degrees',
  (rotation, expected) => {
    expect(
      normalizeBoxes([box()], { width: 100, height: 200, rotation })[0],
    ).toMatchObject(
      Object.fromEntries(
        Object.entries({ ...expected, track_id: 1 }).map(([key, value]) => [
          key,
          expect.closeTo(value, 6),
        ]),
      ),
    );
  },
);
it('clips boxes, drops invalid/empty geometry, and caps the B2 payload at ten', () => {
  const frame = { width: 100, height: 200, rotation: 0 as const };
  expect(
    normalizeBoxes([{ ...box(), x: -10, width: 30 }], frame)[0],
  ).toMatchObject({ x: 0, width: 0.2 });
  expect(
    normalizeBoxes(
      [
        { ...box(), x: 101 },
        { ...box(), width: NaN },
        { ...box(), height: 0 },
      ],
      frame,
    ),
  ).toEqual([]);
  expect(
    normalizeBoxes(
      Array.from({ length: 12 }, (_, i) => box(i)),
      frame,
    ),
  ).toHaveLength(10);
  expect(normalizeBoxes([box()], { ...frame, width: 0 })).toEqual([]);
});
it('requires 700ms at IoU > .8, with the same ids regardless of ordering, and fires once', () => {
  let state = createStability();
  const step = (now: number, boxes = [box(1), box(2, 60)], enabled = true) => {
    const result = updateStability(state, boxes, now, enabled);
    state = result.state;
    return result.trigger;
  };
  expect(step(0)).toBe(false);
  expect(step(350)).toBe(false);
  expect(step(699)).toBe(false);
  expect(step(700, [box(2, 61), box(1, 11)])).toBe(true);
  expect(step(1400)).toBe(false);
  expect(step(2000, undefined, false)).toBe(false);
  expect(step(3000)).toBe(false);
  expect(step(3100, [box(3)])).toBe(false);
  expect(step(3450, [box(3)])).toBe(false);
  expect(step(3800, [box(3)])).toBe(true);
});
it('resets stability on motion, missing/new tracks, frame gaps, empty input and disabled auto', () => {
  let state = createStability();
  const step = (time: number, boxes = [box()], enabled = true) => {
    const result = updateStability(state, boxes, time, enabled);
    state = result.state;
    return result.trigger;
  };
  step(0);
  step(300);
  expect(step(700, [box(1, 50)])).toBe(false);
  expect(step(900, [])).toBe(false);
  step(1000);
  step(1300);
  expect(step(1700, [box(), box(2)])).toBe(false);
  step(2000, [box(), box(2)]);
  expect(step(2400, [box(), box(2)], false)).toBe(false);
  expect(step(2800, [box(), box(2)])).toBe(true);
  step(3000, []);
  step(3100);
  expect(step(5000)).toBe(false);
});
it('votes over three results per track and preserves a majority through unknown/ambiguous', () => {
  const result = (
    product: string,
    match: 'matched' | 'ambiguous' | 'unknown' = 'matched',
  ) =>
    scan([
      detection('d', {
        track_id: 7,
        match,
        candidates: [candidate(product, 100)],
      }),
      detection('untracked'),
    ]);
  let history = {};
  const next = (
    product: string,
    match?: 'matched' | 'ambiguous' | 'unknown',
  ) => {
    const input = result(product, match);
    const voted = voteScan(history, input);
    expect(input.detections[0]!.candidates[0]!.product_id).toBe(product);
    history = voted.history;
    return voted.scan.detections[0]!;
  };
  next('a');
  next('a');
  expect(next('b').candidates[0]!.product_id).toBe('a');
  expect(next('b', 'ambiguous').candidates[0]!.product_id).toBe('a');
  expect(next('b', 'unknown').candidates[0]!.product_id).toBe('a');
  next('b');
  expect(next('b').candidates[0]!.product_id).toBe('b');
  expect(
    voteScan(history, scan([detection('other', { track_id: 8 })])).scan
      .detections[0]!.candidates[0]!.product_id,
  ).toBe('other-a');
});

it('does not promote one historical match into a stable majority', () => {
  const first = voteScan({}, scan([detection('d', { track_id: 7 })]));
  const unknown = detection('d', {
    track_id: 7,
    match: 'unknown',
    candidates: [],
  });
  expect(voteScan(first.history, scan([unknown])).scan.detections[0]).toEqual(
    unknown,
  );
  const different = detection('d', {
    track_id: 7,
    candidates: [candidate('other', 100)],
  });
  expect(voteScan(first.history, scan([different])).scan.detections[0]).toEqual(
    different,
  );
});
