import { readMultipart } from './multipart';

test('reads a React Native request through _bodyInit.getParts()', async () => {
  const rnForm = {
    getParts: () => [
      { fieldName: 'mode', string: 'single', headers: {} },
      {
        fieldName: 'image',
        uri: 'file:///data/shot.jpg',
        name: 'shot.jpg',
        type: 'image/jpeg',
        headers: {},
      },
      { fieldName: 'note' },
    ],
  };
  const request = {
    _bodyInit: rnForm,
    formData: () => Promise.reject(new TypeError('Unsupported body')),
  } as unknown as Request;

  const fields = await readMultipart(request);
  expect(fields.get('mode')).toBe('single');
  expect(fields.get('image')).toEqual({
    uri: 'file:///data/shot.jpg',
    name: 'shot.jpg',
    type: 'image/jpeg',
  });
  expect(fields.get('note')).toBe('');
});

test('falls back to request.formData() for standard requests', async () => {
  const original = URL.createObjectURL;
  URL.createObjectURL = () => {
    throw new Error('Cannot create URL for blob');
  };
  const form = new FormData();
  form.append('mode', 'multi');
  form.append('image', new Blob(['abc'], { type: 'image/png' }), 'a.png');
  const fields = await readMultipart(
    new Request('http://mock.local/x', { method: 'POST', body: form }),
  );
  expect(fields.get('mode')).toBe('multi');
  expect(fields.get('image')).toEqual({
    name: 'a.png',
    type: 'image/png',
    size: 3,
  });
  URL.createObjectURL = original;
});

test('web: a Blob part gets a local object URL so the stored image loads', async () => {
  const original = URL.createObjectURL;
  URL.createObjectURL = jest.fn(() => 'blob:http://localhost/abc');
  try {
    const form = new FormData();
    form.append('image', new Blob(['abc'], { type: 'image/jpeg' }), 'a.jpg');
    const fields = await readMultipart(
      new Request('http://mock.local/x', { method: 'POST', body: form }),
    );
    expect(fields.get('image')).toEqual({
      name: 'a.jpg',
      type: 'image/jpeg',
      size: 3,
      uri: 'blob:http://localhost/abc',
    });
  } finally {
    URL.createObjectURL = original;
  }
});

test('ignores a _bodyInit without getParts and uses formData()', async () => {
  const form = new FormData();
  form.append('purpose', 'enrollment');
  const request = new Request('http://mock.local/x', {
    method: 'POST',
    body: form,
  });
  (request as unknown as { _bodyInit: unknown })._bodyInit = {
    not: 'form data',
  };
  expect((await readMultipart(request)).get('purpose')).toBe('enrollment');
});
