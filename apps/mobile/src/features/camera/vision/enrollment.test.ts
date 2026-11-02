import {
  laplacianVariance, viewChanged, shouldKeepKeyframe, coverageSectors,
  coveragePrompt, stopDecision, selectLockedTrack, keyframeReferences,
  voiceDraftToForm, boxLumaThumbnail,
} from './enrollment';
import { createUploadQueue } from './uploadQueue';

const box = { x: 0.2, y: 0.2, width: 0.4, height: 0.4 };
const track = { ...box, id: 7, trackingId: 7 };
const sharp = Array.from({ length: 256 }, (_, i) => (i + Math.floor(i / 16)) % 2 * 255);
const flat = Array(256).fill(80);
const sample = { box, luma: sharp };

it('measures Laplacian variance on interior pixels, rejecting blur and invalid thumbnails', () => {
  expect(laplacianVariance(flat)).toBe(0);
  expect(laplacianVariance(sharp)).toBeGreaterThan(100);
  expect(laplacianVariance([])).toBe(0);
});
it('extracts a luma thumbnail inside the normalized locked box', () => {
  const pixels = new Uint8Array(32 * 32 * 4).fill(255);
  expect(boxLumaThumbnail(pixels, 32, 32, box)).toHaveLength(256);
  expect(boxLumaThumbnail(pixels, 32, 32, box)[0]).toBeCloseTo(255);
});
it('requires both sharpness and a changed view; the first sharp view is kept', () => {
  expect(shouldKeepKeyframe(sample, null)).toBe(true);
  expect(shouldKeepKeyframe({ box, luma: flat }, sample)).toBe(false);
  expect(shouldKeepKeyframe(sample, sample)).toBe(false);
  expect(shouldKeepKeyframe({ box, luma: sharp.map(v => 255 - v) }, sample)).toBe(true);
});
it('uses thumbnail mean absolute difference OR box IoU below .6 for view change', () => {
  expect(viewChanged(sample, sample)).toBe(false);
  expect(viewChanged({ ...sample, box: { ...box, x: 0.6 } }, sample)).toBe(true);
  expect(viewChanged({ ...sample, luma: flat }, sample)).toBe(true);
});
it('fills eight heuristic sectors from baseline, shape, distance and position; prompts target gaps', () => {
  expect(coverageSectors(box, box)).toEqual([0]);
  expect(coverageSectors(box, { ...box, width: 0.2 })).toContain(1);
  expect(coverageSectors(box, { ...box, width: 0.6 })).toContain(2);
  expect(coverageSectors(box, { ...box, width: 0.2, height: 0.2 })).toContain(3);
  expect(coverageSectors(box, { ...box, width: 0.6, height: 0.6 })).toContain(4);
  expect(coverageSectors(box, { ...box, x: 0 })).toContain(5);
  expect(coverageSectors(box, { ...box, x: 0.5 })).toContain(6);
  expect(coverageSectors(box, { ...box, y: 0.5 })).toContain(7);
  expect(coveragePrompt([0])).toBe('Xoay sản phẩm');
  expect(coveragePrompt([0, 1, 2])).toBe('Đưa ra xa');
  expect(coveragePrompt([0, 1, 2, 3])).toBe('Lại gần');
  expect(coveragePrompt([0, 1, 2, 3, 4, 5, 6])).toBe('Lật mặt sau');
  expect(coveragePrompt([0, 1, 2, 3, 4, 5, 6, 7])).toBe('Xoay sản phẩm');
});
it.each([
  [9999, 8, false, 'continue'], [10000, 8, false, 'complete'],
  [10000, 7, false, 'extend'], [14999, 7, false, 'extend'],
  [15000, 7, false, 'retry'], [12000, 8, false, 'complete'],
  [1000, 24, false, 'complete'], [2000, 8, true, 'complete'],
  [2000, 7, true, 'retry'],
])('stop boundary %i ms / %i frames / manual %s -> %s', (ms, count, manual, expected) => {
  expect(stopDecision(ms, count, manual)).toBe(expected);
});
it('reacquires a missing tracking id by IoU with the last box and refuses unrelated boxes', () => {
  expect(selectLockedTrack([track], track)).toEqual(track);
  expect(selectLockedTrack([{ ...track, id: 9 }], track)?.id).toBe(9);
  expect(selectLockedTrack([{ ...track, x: 0.9, id: 9 }], track)).toBeNull();
  expect(selectLockedTrack([], track)).toBeNull();
});
it('converts normalized upright boxes to saved JPEG pixels only at the product POST boundary', () => {
  expect(keyframeReferences([{ uri: 'file:///a', width: 768, height: 1024, bbox: box, imageId: 'image' }])).toEqual([
    { image_id: 'image', source: 'keyframe', bbox: [153.6, 204.8, 307.2, 409.6] },
  ]);
  expect(keyframeReferences([{ uri: 'file:///a', width: 768, height: 1024, bbox: box }])).toEqual([]);
});
it('maps voice product fields without inventing prices or losing the unit', () => {
  expect(voiceDraftToForm({ name: ' Mì gói ', price: 5000, unit: ' gói ' })).toEqual({ name: 'Mì gói', price: '5000', unit: 'gói' });
  expect(voiceDraftToForm({ name: '', price: null, unit: null })).toEqual({ name: '', price: '', unit: '' });
  expect(voiceDraftToForm(undefined)).toEqual({ name: '', price: '', unit: '' });
});
it('uploads as frames arrive with at most four jobs, waits for all, and continues after failure', async () => {
  const releases: (() => void)[] = [];
  let running = 0;
  let peak = 0;
  const queue = createUploadQueue(4);
  const jobs = Array.from({ length: 6 }, (_, i) => queue.add(async () => {
    running++;
    peak = Math.max(peak, running);
    await new Promise<void>(resolve => releases.push(resolve));
    running--;
    if (i === 1) throw new Error('offline');
    return i;
  }));
  const results = Promise.allSettled(jobs);
  const drain = queue.drain();
  expect(peak).toBe(4);
  releases.splice(0).forEach(fn => fn());
  await new Promise(resolve => setTimeout(resolve, 0));
  releases.splice(0).forEach(fn => fn());
  await drain;
  expect((await results).map(r => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled', 'fulfilled', 'fulfilled', 'fulfilled']);
  expect(peak).toBe(4);
});
