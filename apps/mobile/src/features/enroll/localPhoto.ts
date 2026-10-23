import { Directory, File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';

/**
 * A local file uri for `url`. React Native's multipart upload needs a file on the device, so a
 * remote crop is downloaded into the cache first. The browser can upload a remote url as is.
 */
export async function toLocalPhoto(url: string): Promise<string> {
  if (Platform.OS === 'web' || !/^https?:/.test(url)) return url;
  const file = await File.downloadFileAsync(url, new Directory(Paths.cache));
  return file.uri;
}
