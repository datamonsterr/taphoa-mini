import { takePhoto, toScanMode, toUploadFile } from './capture';

describe('takePhoto', () => {
  it('takes a 0.6 quality picture and returns uri and size', async () => {
    const takePictureAsync = jest.fn().mockResolvedValue({
      uri: 'file:///a.jpg',
      width: 1080,
      height: 1440,
      base64: undefined,
    });
    const photo = await takePhoto({ takePictureAsync });
    expect(takePictureAsync).toHaveBeenCalledWith({ quality: 0.6 });
    expect(photo).toEqual({ uri: 'file:///a.jpg', width: 1080, height: 1440 });
  });

  it('throws when the camera is not mounted', async () => {
    await expect(takePhoto(null)).rejects.toThrow('camera not ready');
  });

  it('throws when the camera returns nothing', async () => {
    await expect(
      takePhoto({ takePictureAsync: jest.fn().mockResolvedValue(undefined) }),
    ).rejects.toThrow('no photo');
  });
});

describe('toUploadFile / toScanMode', () => {
  it('names the upload scan.jpg as image/jpeg', () => {
    expect(toUploadFile({ uri: 'file:///a.jpg', width: 1, height: 1 })).toEqual(
      { uri: 'file:///a.jpg', name: 'scan.jpg', type: 'image/jpeg' },
    );
  });

  it('maps the toggle to the API mode', () => {
    expect(toScanMode('one')).toBe('single');
    expect(toScanMode('many')).toBe('multi');
  });
});

// The low-rate loop uses a processed JPEG, never the raw multi-megabyte still.
describe('probe capture', () => {
  const { takeProbePhoto } = jest.requireActual('./capture');
  const { ImageManipulator } = jest.requireMock('expo-image-manipulator');

  it.each([
    [1080, 1440, 480, 640],
    [1920, 1080, 640, 360],
    [320, 240, 320, 240],
  ])(
    'silently recompresses %sx%s to %sx%s',
    async (width, height, targetWidth, targetHeight) => {
      const takePictureAsync = jest
        .fn()
        .mockResolvedValue({ uri: 'file:///probe.jpg', width, height });
      const saveAsync = jest.fn().mockResolvedValue({
        uri: 'file:///small.jpg',
        width: targetWidth,
        height: targetHeight,
      });
      const manipulate = jest
        .spyOn(ImageManipulator, 'manipulate')
        .mockReturnValue({ renderAsync: async () => ({ saveAsync }) });
      const photo = await takeProbePhoto({ takePictureAsync });
      expect(takePictureAsync).toHaveBeenCalledWith({
        quality: 0.2,
        shutterSound: false,
        skipProcessing: true,
      });
      expect(manipulate).toHaveBeenCalledWith('file:///probe.jpg', {
        maxWidth: 640,
        maxHeight: 640,
      });
      expect(saveAsync).toHaveBeenCalledWith({ format: 'jpeg', compress: 0.3 });
      expect(photo).toMatchObject({ width: targetWidth, height: targetHeight });
      manipulate.mockRestore();
    },
  );

  it('serializes a shutter press behind a pending silent capture', async () => {
    let release!: (value: {
      uri: string;
      width: number;
      height: number;
    }) => void;
    const camera = {
      takePictureAsync: jest
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              release = resolve;
            }),
        )
        .mockResolvedValueOnce({
          uri: 'file:///full.jpg',
          width: 1080,
          height: 1440,
        }),
    };
    const probe = takeProbePhoto(camera);
    const full = takePhoto(camera);
    expect(camera.takePictureAsync).toHaveBeenCalledTimes(1);
    release({ uri: 'file:///probe.jpg', width: 480, height: 640 });
    await probe;
    await expect(full).resolves.toMatchObject({ uri: 'file:///full.jpg' });
    expect(camera.takePictureAsync).toHaveBeenCalledTimes(2);
  });
});
