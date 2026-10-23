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
