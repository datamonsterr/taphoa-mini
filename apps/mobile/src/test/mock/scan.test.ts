import { createMockFetch } from './fetch';
import { resetMockDb, getMockDb } from './db';
import { getMockScenario, setMockScenario } from './scenario';
import { PRODUCT_IDS } from './fixtures';
import type { Scan } from '@/lib/api/types';

const mockFetch = createMockFetch();

async function scan(
  fields: Record<string, string>,
  file: object | null = {
    uri: 'file:///cam/1.jpg',
    name: '1.jpg',
    type: 'image/jpeg',
  },
): Promise<Scan> {
  const parts = [
    ...Object.entries(fields).map(([fieldName, string]) => ({
      fieldName,
      string,
    })),
    ...(file ? [{ fieldName: 'image', ...file }] : []),
  ];
  const request = new Request('http://mock.local/v1/recognition/scans', {
    method: 'POST',
  });
  (request as unknown as { _bodyInit: unknown })._bodyInit = {
    getParts: () => parts,
  };
  const response = await mockFetch(request);
  expect(response.status).toBe(201);
  return (await response.json()) as Scan;
}

beforeEach(resetMockDb);

test('scenario defaults to auto and is resettable', () => {
  expect(getMockScenario()).toBe('auto');
  setMockScenario('multi');
  expect(getMockScenario()).toBe('multi');
  resetMockDb();
  expect(getMockScenario()).toBe('auto');
});

test('single mode: one central box in 1080x1440 image pixels, uses the uploaded uri', async () => {
  const result = await scan({ mode: 'single' });
  expect(result.image).toMatchObject({
    width: 1080,
    height: 1440,
    url: 'file:///cam/1.jpg',
  });
  expect(result.detections).toHaveLength(1);
  const [x, y, w, h] = result.detections[0]!.bbox;
  expect(w).toBeCloseTo(1080 * 0.45, -1);
  expect(x + w / 2).toBeCloseTo(540, 0);
  expect(y + h / 2).toBeCloseTo(720, 0);
  expect(result.detections[0]!.match).toBe('matched');
  expect(result.detections[0]!.candidates[0]!.product_id).toBe(
    PRODUCT_IDS.coca,
  );
});

test('auto: every 3rd single scan is unknown with low similarity', async () => {
  const matches: string[] = [];
  let lastSimilarity = 1;
  for (let i = 0; i < 6; i += 1) {
    const result = await scan({ mode: 'single' });
    matches.push(result.detections[0]!.match);
    lastSimilarity = result.detections[0]!.candidates[0]!.similarity;
  }
  expect(matches).toEqual([
    'matched',
    'matched',
    'unknown',
    'matched',
    'matched',
    'unknown',
  ]);
  expect(lastSimilarity).toBeLessThan(0.5);
});

test('multi mode: 3 boxes left to right with top_k look-alike candidates', async () => {
  const result = await scan({ mode: 'multi', top_k: '3' });
  expect(result.mode).toBe('multi');
  expect(result.detections).toHaveLength(3);
  const xs = result.detections.map((d) => d.bbox[0]);
  expect([...xs].sort((a, b) => a - b)).toEqual(xs);
  for (const d of result.detections) {
    expect(d.candidates).toHaveLength(3);
    const sims = d.candidates.map((c) => c.similarity);
    expect([...sims].sort((a, b) => b - a)).toEqual(sims);
    for (const [bx, by, bw, bh] of [d.bbox]) {
      expect(bx + bw).toBeLessThanOrEqual(1080);
      expect(by + bh).toBeLessThanOrEqual(1440);
    }
  }
  const first = result.detections[0]!.candidates.map((c) => c.name);
  expect(first).toEqual([
    'Coca-Cola lon 330ml',
    'Pepsi lon 330ml',
    '7Up lon 330ml',
  ]);
});

test.each([
  ['match', 'multi', 1, 'matched'],
  ['multi', 'single', 3, 'matched'],
  ['unknown', 'multi', 1, 'unknown'],
  ['ambiguous', 'single', 1, 'ambiguous'],
] as const)(
  'scenario %s overrides mode %s -> %i boxes (%s)',
  async (scenario, mode, boxes, match) => {
    setMockScenario(scenario);
    const result = await scan({ mode });
    expect(result.detections).toHaveLength(boxes);
    expect(result.detections.every((d) => d.match === match)).toBe(true);
  },
);

test('ambiguous candidates are close in similarity', async () => {
  setMockScenario('ambiguous');
  const [a, b] = (await scan({ mode: 'single' })).detections[0]!.candidates;
  expect(a!.similarity - b!.similarity).toBeLessThan(0.05);
});

test('the scan is stored in the DB', async () => {
  const result = await scan({ mode: 'single' });
  expect(getMockDb().scans.get(result.id)).toEqual(result);
});
