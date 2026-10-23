import * as multipart from '@/lib/api/multipart';
import type { Candidate, Detection, Scan } from '@/lib/api/types';

/** Test builders for scans; shared by the camera unit and screen tests. */
export function candidate(
  id: string,
  price: number,
  similarity = 0.9,
  name: string | null = `SP ${id}`,
): Candidate {
  return { product_id: id, price, similarity, name };
}

export function detection(
  id: string,
  over: Partial<Detection> = {},
): Detection {
  return {
    id,
    bbox: [100, 200, 300, 400],
    score: 0.95,
    match: 'matched',
    candidates: [candidate(`${id}-a`, 12000), candidate(`${id}-b`, 15000)],
    ...over,
  };
}

export function scan(detections: Detection[], over: Partial<Scan> = {}): Scan {
  return {
    id: 'scan-1',
    image: { id: 'img-1', url: 'https://x/img.jpg', width: 1080, height: 1440 },
    mode: 'multi',
    purpose: 'checkout',
    pipeline: { segmenter: 's', embedder: 'e' },
    detections,
    created_at: '2026-10-23T00:00:00.000Z',
    ...over,
  } as Scan;
}

/**
 * Jest runs on Node's `FormData`, which cannot carry React Native's `{ uri, name, type }` file
 * parts. Send a Blob instead so the in-app mock API can read the upload.
 */
export function uploadPartsAsBlobs() {
  return jest
    .spyOn(multipart, 'appendFile')
    .mockImplementation((form, field) => {
      form.append(
        field,
        new Blob(['jpeg'], { type: 'image/jpeg' }),
        'scan.jpg',
      );
    });
}
