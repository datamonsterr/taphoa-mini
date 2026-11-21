import { getApiClient } from './client';
import { unwrap } from './errors';

/** Ask the backend to load recognition models before the next capture. */
export async function warmRecognition(): Promise<void> {
  await unwrap(getApiClient().raw.POST('/v1/recognition/warm', {}));
}
