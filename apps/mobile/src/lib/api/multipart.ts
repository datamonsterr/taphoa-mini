import { Platform } from 'react-native';

import type { UploadFile } from './types';

/**
 * Appends an image part. React Native sends `{ uri, name, type }` objects as file parts;
 * on web (and in tests) a Blob/File is passed instead.
 */
export function appendFile(form: FormData, field: string, file: UploadFile) {
  if (typeof Blob !== 'undefined' && file instanceof Blob) {
    form.append(field, file);
    return;
  }
  form.append(field, file as unknown as Blob);
}

/**
 * Web only: the camera returns a `data:`/`blob:` URI, and a browser `FormData` would stringify the
 * RN-style `{ uri, name, type }` object. Fetch the URI into a Blob first (async, so it has to run
 * before the synchronous `bodySerializer`). Native keeps the object.
 */
export async function resolveUpload(file: UploadFile): Promise<UploadFile> {
  if (Platform.OS !== 'web') return file;
  if (file instanceof Blob) return file;
  const blob = await (await fetch(file.uri)).blob();
  // Some runtimes drop the type of a data:/blob: fetch; the server needs a JPEG/PNG/WebP part type.
  return blob.type ? blob : new Blob([blob], { type: file.type });
}
