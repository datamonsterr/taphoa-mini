import { getApiClient } from './client';
import { unwrap } from './errors';
import { appendFile, resolveUpload } from './multipart';
import type {
  Image,
  ImagePurpose,
  Scan,
  ScanMode,
  ScanPurpose,
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

/** POST /v1/recognition/scans (multipart: image file + mode + purpose + top_k). */
export async function createScan(input: CreateScanInput): Promise<Scan> {
  const image = input.image ? await resolveUpload(input.image) : undefined;
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
