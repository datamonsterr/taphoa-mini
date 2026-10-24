import { getApiClient } from './client';
import { isApiError, unwrap, type ApiError } from './errors';
import { appendFile, resolveUpload } from './multipart';
import type {
  Image,
  ImagePurpose,
  Scan,
  ScanMode,
  ScanPurpose,
  SegmentPointsRequest,
  SegmentPointsResponse,
  UploadFile,
} from './types';

export type CreateScanInput = {
  /** Photo to analyse. Required unless `image_id` of an uploaded image is given. */
  image?: UploadFile;
  image_id?: string;
  mode?: ScanMode;
  purpose?: ScanPurpose;
  top_k?: number;
};

/** Wait before the one retry when the server sent no `Retry-After`. */
export const BUSY_RETRY_DELAY_MS = 500;
/** A `Retry-After` longer than this is not worth holding the shutter for. */
const BUSY_RETRY_MAX_MS = 3000;

/**
 * The backend has one inference slot: while it is held, scans answer 503 `segmenter busy`
 * (with `Retry-After`). "No model loaded" is also a 503 but retrying cannot help.
 */
export const isSegmenterBusy = (error: unknown): boolean =>
  isApiError(error) &&
  error.status === 503 &&
  /segmenter busy/i.test(error.body.error);

/** POST /v1/recognition/scans (multipart: image file + mode + purpose + top_k). */
export async function createScan(input: CreateScanInput): Promise<Scan> {
  const image = input.image ? await resolveUpload(input.image) : undefined;
  try {
    return await postScan(input, image);
  } catch (error) {
    if (!isSegmenterBusy(error)) throw error;
    const wait = Math.min(
      (error as ApiError).retryAfterMs ?? BUSY_RETRY_DELAY_MS,
      BUSY_RETRY_MAX_MS,
    );
    await new Promise((resolve) => setTimeout(resolve, wait));
    // Exactly one retry: same image / image_id, so the server sees the same scan again.
    return postScan(input, image);
  }
}

function postScan(
  input: CreateScanInput,
  image: Awaited<ReturnType<typeof resolveUpload>> | undefined,
): Promise<Scan> {
  return unwrap(
    getApiClient().raw.POST('/v1/recognition/scans', {
      body: {
        image_id: input.image_id,
        mode: input.mode,
        purpose: input.purpose,
        top_k: input.top_k,
      },
      bodySerializer: () => {
        const form = new FormData();
        if (image) appendFile(form, 'image', image);
        if (input.image_id) form.append('image_id', input.image_id);
        form.append('mode', input.mode ?? 'multi');
        form.append('purpose', input.purpose ?? 'checkout');
        // No default: the server picks `top_k` unless the caller asks for one.
        if (input.top_k !== undefined)
          form.append('top_k', String(input.top_k));
        return form;
      },
    }),
  );
}

/** POST /v1/images (multipart: image file + purpose). */
export async function uploadImage(
  file: UploadFile,
  purpose?: ImagePurpose,
): Promise<Image> {
  const upload = await resolveUpload(file);
  return unwrap(
    getApiClient().raw.POST('/v1/images', {
      body: { image: '', purpose },
      bodySerializer: () => {
        const form = new FormData();
        appendFile(form, 'image', upload);
        if (purpose) form.append('purpose', purpose);
        return form;
      },
    }),
  );
}

/** POST /v1/segment/points (point-prompted MobileSAM segmentation). */
export const segmentPoints = (
  body: SegmentPointsRequest,
): Promise<SegmentPointsResponse> =>
  unwrap(getApiClient().raw.POST('/v1/segment/points', { body }));
