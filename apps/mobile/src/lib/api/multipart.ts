import { File } from 'expo-file-system';
import { Platform } from 'react-native';

import type { UploadFile } from './types';

/**
 * A multipart file part that Expo's native `fetch` can send. Expo replaces the global `fetch`
 * (`expo/fetch`) and, unlike React Native's own XHR-based one, it cannot read a `{ uri, name,
 * type }` part: it throws "Unsupported FormDataPart" and the request never leaves the phone. It
 * accepts any part that carries `name`, `type` and `bytes()`, so the file is read lazily here.
 */
export type NativeFilePart = {
  name: string;
  type: string;
  bytes: () => Promise<Uint8Array>;
};

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
 * Prepares a capture for the synchronous `bodySerializer`. Web: the camera returns a `data:`/`blob:`
 * URI and a browser `FormData` would stringify the `{ uri, name, type }` object, so fetch it into a
 * Blob. Native: wrap it as a {@link NativeFilePart} that Expo's `fetch` can read.
 */
export async function resolveUpload(file: UploadFile): Promise<UploadFile> {
  if (Platform.OS !== 'web') return toNativePart(file);
  if (file instanceof Blob) return file;
  const blob = await (await fetch(file.uri)).blob();
  // Some runtimes drop the type of a data:/blob: fetch; the server needs a JPEG/PNG/WebP part type.
  return blob.type ? blob : new Blob([blob], { type: file.type });
}

function toNativePart(file: UploadFile): UploadFile {
  if (typeof Blob !== 'undefined' && file instanceof Blob) return file;
  const { uri, name, type } = file as {
    uri: string;
    name: string;
    type: string;
  };
  const part: NativeFilePart = {
    name,
    type,
    bytes: () => new File(uri).bytes(),
  };
  return part as unknown as UploadFile;
}
