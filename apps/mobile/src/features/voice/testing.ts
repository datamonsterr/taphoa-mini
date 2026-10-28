import * as fixture from './fixture';

/**
 * Jest runs on Node's `FormData`, which cannot carry a React Native file part. Send the clip as a
 * Blob named after the clip, so the in-app mock API reads it (its canned replies follow the name).
 */
export function uploadClipsAsBlobs() {
  return jest
    .spyOn(fixture, 'clipToUpload')
    .mockImplementation(async (clip) => ({
      audio: new Blob(['m4a'], { type: clip.type }),
      filename: clip.name,
    }));
}
