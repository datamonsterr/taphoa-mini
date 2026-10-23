import { isLowMatch } from './matching';
import {
  confidencePercent,
  toCartLines,
  toOverlayDetections,
} from './detections';
import { candidate, detection, scan } from './testing';

const FALLBACK = 'Sản phẩm';

describe('isLowMatch', () => {
  it('trusts the server match: only unknown or candidate-less is low', () => {
    expect(isLowMatch(detection('a'))).toBe(false);
    expect(isLowMatch(detection('a', { match: 'ambiguous' }))).toBe(false);
    expect(isLowMatch(detection('a', { match: 'unknown' }))).toBe(true);
    expect(isLowMatch(detection('a', { candidates: [] }))).toBe(true);
    // No client-side similarity cut-off: a weak score on a matched box is still the server's call.
    expect(
      isLowMatch(detection('a', { candidates: [candidate('x', 1, 0.2)] })),
    ).toBe(false);
  });
});

describe('toOverlayDetections', () => {
  const result = scan([
    detection('d1', { bbox: [1, 2, 3, 4] }),
    detection('d2', {
      match: 'unknown',
      candidates: [candidate('u', 5000, 0.3, null)],
    }),
  ]);

  it('maps the top-1 to name, price and an alternatives list', () => {
    const [first] = toOverlayDetections(result, {}, FALLBACK);
    expect(first).toMatchObject({
      id: 'd1',
      name: 'SP d1-a',
      price: 12000,
      bbox: [1, 2, 3, 4],
      lowMatch: false,
    });
    expect(first!.alternatives!.map((a) => a.id)).toEqual(['d1-a', 'd1-b']);
    expect(first!.alternatives![1]).toMatchObject({
      name: 'SP d1-b',
      price: 15000,
    });
  });

  it('carries the thumbnail of a candidate', () => {
    const withThumb = scan([
      detection('d', {
        candidates: [{ ...candidate('p', 1000), thumbnail_url: 'https://t/p' }],
      }),
    ]);
    expect(
      toOverlayDetections(withThumb, {}, FALLBACK)[0]!.alternatives![0],
    ).toMatchObject({ thumbnailUri: 'https://t/p' });
  });

  it('a chosen candidate replaces name and price and moves first', () => {
    const [first] = toOverlayDetections(result, { d1: 'd1-b' }, FALLBACK);
    expect(first).toMatchObject({ name: 'SP d1-b', price: 15000 });
    expect(first!.alternatives!.map((a) => a.id)).toEqual(['d1-b', 'd1-a']);
  });

  it('a low match has no alternatives and a fallback name', () => {
    const low = toOverlayDetections(result, {}, FALLBACK)[1]!;
    expect(low).toMatchObject({ lowMatch: true, name: FALLBACK });
    expect(low.alternatives).toBeUndefined();
  });

  it('a stale chosen id falls back to the top-1', () => {
    const [first] = toOverlayDetections(result, { d1: 'gone' }, FALLBACK);
    expect(first!.name).toBe('SP d1-a');
  });
});

describe('toCartLines', () => {
  const result = scan([
    detection('d1', {
      candidates: [
        { ...candidate('p1', 12000), thumbnail_url: 'https://t/1' },
        candidate('p2', 15000),
      ],
    }),
    detection('d2'),
    detection('d3', { match: 'unknown' }),
  ]);

  it('lists every selected box with its chosen candidate', () => {
    const lines = toCartLines(
      result,
      { d1: true, d2: true, d3: true },
      { d2: 'd2-b' },
      FALLBACK,
    );
    expect(lines).toEqual([
      {
        productId: 'p1',
        name: 'SP p1',
        price: 12000,
        imageUrl: 'https://t/1',
        detectionId: 'd1',
        suggestedProductId: 'p1',
        scanId: 'scan-1',
      },
      {
        productId: 'd2-b',
        name: 'SP d2-b',
        price: 15000,
        detectionId: 'd2',
        suggestedProductId: 'd2-a',
        scanId: 'scan-1',
      },
    ]);
  });

  it('skips deselected boxes and low matches', () => {
    expect(
      toCartLines(result, { d1: false, d2: true, d3: true }, {}, FALLBACK).map(
        (l) => l.productId,
      ),
    ).toEqual(['d2-a']);
    expect(toCartLines(result, {}, {}, FALLBACK)).toEqual([]);
  });

  it('uses the fallback for an unnamed product', () => {
    const unnamed = scan([
      detection('d', { candidates: [candidate('p', 900, 0.9, null)] }),
    ]);
    expect(toCartLines(unnamed, { d: true }, {}, FALLBACK)[0]!.name).toBe(
      FALLBACK,
    );
  });
});

describe('confidencePercent', () => {
  it('rounds the top-1 similarity to a whole percent, 0 without candidates', () => {
    expect(
      confidencePercent(
        detection('a', { candidates: [candidate('x', 1, 0.964)] }),
      ),
    ).toBe(96);
    expect(confidencePercent(detection('a', { candidates: [] }))).toBe(0);
  });
});
