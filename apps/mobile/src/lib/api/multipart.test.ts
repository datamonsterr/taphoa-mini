import { Platform } from 'react-native';

import { uploadPartsAsBlobs } from '@/features/camera/testing';

import { createScan, uploadImage } from './images';
import { appendFile, resolveUpload, type NativeFilePart } from './multipart';

// 1x1 transparent PNG; Node's fetch reads data: URIs, as browsers do for web camera captures.
const DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const photo = { uri: DATA_URI, name: 'scan.jpg', type: 'image/jpeg' };

const asWeb = () => jest.replaceProperty(Platform, 'OS', 'web');

afterEach(() => jest.restoreAllMocks());

describe('resolveUpload', () => {
  test('native wraps the uri as a part Expo fetch can read', async () => {
    const file = await resolveUpload(photo);
    expect(file).toMatchObject({ name: 'scan.jpg', type: 'image/jpeg' });
    expect(typeof (file as unknown as NativeFilePart).bytes).toBe('function');
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

describe('native multipart through expo/fetch', () => {
  // Expo swaps the global fetch for `expo/fetch`; this is the exact encoder it runs on a native
  // FormData. React Native's own `FormData` (not Node's) is what the app builds.
  const { convertFormDataAsync } = jest.requireActual(
    'expo/src/winter/fetch/convertFormData',
  );
  const { installFormDataPatch } = jest.requireActual(
    'expo/src/winter/FormData',
  );
  const RNFormData = jest.requireActual(
    'react-native/Libraries/Network/FormData',
  ).default;
  installFormDataPatch(RNFormData);

  const encode = async (file: Parameters<typeof appendFile>[2]) => {
    const form = new RNFormData() as unknown as FormData;
    appendFile(form, 'image', file);
    form.append('purpose', 'enrollment');
    const { body } = await convertFormDataAsync(form);
    return Buffer.from(body as Uint8Array).toString('latin1');
  };

  test('the raw { uri, name, type } part is rejected (the Android save bug)', async () => {
    await expect(encode(photo)).rejects.toThrow('Unsupported FormDataPart');
  });

  test('a resolved native part is encoded with its filename, type and bytes', async () => {
    const file = await resolveUpload(photo);
    const part = file as unknown as NativeFilePart;
    part.bytes = async () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    const text = await encode(file);
    expect(text).toContain('name="image"; filename="scan.jpg"');
    expect(text).toContain('content-type: image/jpeg');
    expect(text).toContain('\xff\xd8\xff\xe0');
    expect(text).toContain('name="purpose"');
  });
});
