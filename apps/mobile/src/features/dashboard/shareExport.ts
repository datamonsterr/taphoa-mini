import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { newUuid } from '@/lib/uuid';

/** Authenticated bytes are downloaded by api-client, then shared from a private cache file. */
export async function shareExport(
  bytes: ArrayBuffer,
  name: string,
  mimeType: string,
) {
  if (!(await Sharing.isAvailableAsync()))
    throw new Error('Sharing is unavailable');
  const file = new File(Paths.cache, `${newUuid()}-${name}`);
  try {
    file.create();
    await file.write(new Uint8Array(bytes));
    await Sharing.shareAsync(file.uri, {
      mimeType,
      dialogTitle: name,
      UTI: name.endsWith('.csv')
        ? 'public.comma-separated-values-text'
        : 'org.openxmlformats.spreadsheetml.sheet',
    });
  } finally {
    if (file.exists) file.delete();
  }
}
