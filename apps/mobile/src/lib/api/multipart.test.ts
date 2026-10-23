import { Platform } from 'react-native';

import { uploadPartsAsBlobs } from '@/features/camera/testing';

import { createScan, uploadImage } from './images';
import { resolveUpload } from './multipart';

// 1x1 transparent PNG; Node's fetch reads data: URIs, as browsers do for web camera captures.
const DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const photo = { uri: DATA_URI, name: 'scan.jpg', type: 'image/jpeg' };

const asWeb = () => jest.replaceProperty(Platform, 'OS', 'web');

afterEach(() => jest.restoreAllMocks());

describe('resolveUpload', () => {
  test('native keeps the uri file object for React Native FormData', async () => {
    const file = await resolveUpload(photo);
    expect(file).toBe(photo);
  });

  test('web turns a data: uri into a Blob', async () => {
    asWeb();
    const file = await resolveUpload(photo);
    expect(file).toBeInstanceOf(Blob);
    expect((file as Blob).type).toBe('image/jpeg');
  });

  test('web passes an existing Blob through', async () => {
    asWeb();
    const blob = new Blob(['x']);
    expect(await resolveUpload(blob)).toBe(blob);
  });
});

describe('web uploads', () => {
  test('createScan uploads the captured frame as a file part', async () => {
    asWeb();
    const scan = await createScan({ image: photo, mode: 'multi' });
    expect(scan.detections.length).toBeGreaterThan(0);
  });

  test('uploadImage uploads the frame as a file part', async () => {
    asWeb();
    const image = await uploadImage(photo, 'enrollment');
    expect(image.id).toBeTruthy();
  });
});

describe('createScan fields', () => {
  const sentKeys = async (input: Parameters<typeof createScan>[0]) => {
    uploadPartsAsBlobs();
    const append = jest.spyOn(FormData.prototype, 'append');
    await createScan(input);
    return append.mock.calls.map(([key]) => key);
  };

  test('omits top_k so the server default applies', async () => {
    expect(await sentKeys({ image: photo })).not.toContain('top_k');
  });

  test('sends top_k only when asked', async () => {
    expect(await sentKeys({ image: photo, top_k: 3 })).toContain('top_k');
  });
});
