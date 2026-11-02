import { createTracker, intersectionOverUnion, trackObjects } from './tracker';

const box = (x = 0, trackingId: number | null = null) => ({ trackingId, x, y: 0, width: 100, height: 100 });

describe('IoU fallback tracker', () => {
  it('computes overlap and handles empty or disjoint boxes', () => {
    expect(intersectionOverUnion(box(), box())).toBe(1);
    expect(intersectionOverUnion(box(), box(50))).toBeCloseTo(1 / 3);
    expect(intersectionOverUnion(box(), box(200))).toBe(0);
    expect(intersectionOverUnion({ ...box(), width: 0 }, { ...box(), width: 0 })).toBe(0);
  });

  it('keeps native ids, uses a separate fallback namespace, and does not mutate state', () => {
    const state = createTracker();
    const first = trackObjects(state, [box(0, 1), box(200)]);
    expect(first.objects.map((o) => o.id)).toEqual([1, -1]);
    const second = trackObjects(first.state, [box(210), box(5, 1)]);
    expect(second.objects.map((o) => o.id)).toEqual([-1, 1]);
    expect(state.tracks).toEqual([]);
    expect(first.state.tracks[1].x).toBe(200);
  });

  it('greedily matches the best overlap globally, one to one', () => {
    const first = trackObjects(createTracker(), [box(0), box(70)]);
    const next = trackObjects(first.state, [box(50), box(5)]);
    expect(next.objects.map((o) => o.id)).toEqual([-2, -1]);
    const split = trackObjects(first.state, [box(1), box(2)]);
    expect(new Set(split.objects.map((o) => o.id)).size).toBe(2);
  });

  it('does not associate disjoint objects', () => {
    const first = trackObjects(createTracker(), [box()]);
    expect(trackObjects(first.state, [box(300)]).objects[0].id).toBe(-2);
  });

  it('recovers after 15 missing frames and expires after 16', () => {
    const first = trackObjects(createTracker(), [box()]);
    let state = first.state;
    for (let i = 0; i < 15; i++) state = trackObjects(state, []).state;
    expect(trackObjects(state, [box(2)]).objects[0].id).toBe(-1);
    state = trackObjects(state, []).state;
    expect(state.tracks).toEqual([]);
    expect(trackObjects(state, [box(2)]).objects[0].id).toBe(-2);
  });
});
