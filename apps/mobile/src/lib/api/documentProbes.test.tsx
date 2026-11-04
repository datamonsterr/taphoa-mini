import { act, renderHook } from '@testing-library/react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Platform } from 'react-native';

import { createTestQueryClient } from '@/test/render';
import { uploadPartsAsBlobs } from '@/features/camera/testing';

import { resetApiClient, setApiTransport } from './client';
import { probeDocument, useProbeDocument } from './documentProbes';
import { ApiError } from './errors';

type ReadableForm = FormData & {
  keys(): IterableIterator<string>;
  get(key: string): Blob | string | null;
};

const document = {
  detected: true,
  score: 0.9,
  text_lines: 12,
  line_boxes: [[0.2, 0.2, 0.5, 0.05]],
};
const image = {
  uri: 'file:///probe.jpg',
  name: 'probe.jpg',
  type: 'image/jpeg',
};
const transport = (status = 200) => {
  const fn = jest.fn(
    async () =>
      new Response(
        JSON.stringify(
          status === 200
            ? document
            : { error: 'busy', code: 'ocr_unavailable' },
        ),
        {
          status,
          headers: { 'content-type': 'application/json', 'retry-after': '12' },
        },
      ),
  );
  setApiTransport(fn as unknown as typeof fetch);
  return fn;
};
afterEach(() => {
  setApiTransport();
  resetApiClient();
  jest.restoreAllMocks();
});

test('POSTs a native capture as multipart image and returns the document boxes', async () => {
  uploadPartsAsBlobs();
  const fn = transport();
  expect(await probeDocument({ image })).toEqual(document);
  const request = (fn.mock.calls as unknown as [Request][])[0][0];
  expect(request.method).toBe('POST');
  expect(new URL(request.url).pathname).toBe('/v1/recognition/document-probes');
  expect(request.headers.get('content-type')).toMatch(
    /^multipart\/form-data; boundary=/,
  );
  const form = (await request.formData()) as unknown as ReadableForm;
  expect([...form.keys()]).toEqual(['image']);
  expect((form.get('image') as Blob).type).toBe('image/jpeg');
});

test('resolves a web data URI into a multipart file', async () => {
  jest.replaceProperty(Platform, 'OS', 'web');
  const fn = transport();
  await probeDocument({
    image: { ...image, uri: 'data:image/jpeg;base64,/9j/' },
  });
  const request = (fn.mock.calls as unknown as [Request][])[0][0];
  const form = (await request.formData()) as unknown as ReadableForm;
  expect((form.get('image') as Blob).size).toBeGreaterThan(0);
});

test.each([429, 503])(
  'the mutation does not retry %s and preserves Retry-After',
  async (status) => {
    uploadPartsAsBlobs();
    const fn = transport(status);
    const client = createTestQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = await renderHook(() => useProbeDocument(), { wrapper });
    let error: unknown;
    await act(async () => {
      try {
        await result.current.mutateAsync({ image });
      } catch (value) {
        error = value;
      }
    });
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status, retryAfterMs: 12000 });
    expect(fn).toHaveBeenCalledTimes(1);
  },
);
