import { useMutation } from '@tanstack/react-query';

import { getApiClient } from './client';
import { unwrap } from './errors';
import { appendFile, resolveUpload } from './multipart';
import type { ScanDocument, UploadFile } from './types';

export async function probeDocument({
  image,
  signal,
}: {
  image: UploadFile;
  signal?: AbortSignal;
}): Promise<ScanDocument> {
  const upload = await resolveUpload(image);
  return unwrap(
    getApiClient().raw.POST('/v1/recognition/document-probes', {
      body: { image: '' },
      signal,
      bodySerializer: () => {
        const form = new FormData();
        appendFile(form, 'image', upload);
        return form;
      },
    }),
  );
}

/** The camera loop owns cadence and backoff; React Query must never retry a probe. */
export const useProbeDocument = () =>
  useMutation({ mutationFn: probeDocument, retry: false });
