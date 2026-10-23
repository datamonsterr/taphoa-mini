export type FormFile = {
  uri?: string;
  name?: string;
  type?: string;
  size?: number;
};
export type FormValue = string | FormFile;
export type FormFields = Map<string, FormValue>;

type RnPart = {
  fieldName: string;
  string?: string;
  uri?: string;
  name?: string;
  type?: string;
};
type RnFormData = { getParts: () => RnPart[] };

const isRnFormData = (value: unknown): value is RnFormData =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as RnFormData).getParts === 'function';

function fromRnParts(form: RnFormData): FormFields {
  const fields: FormFields = new Map();
  for (const part of form.getParts()) {
    fields.set(
      part.fieldName,
      part.uri !== undefined
        ? { uri: part.uri, name: part.name, type: part.type }
        : (part.string ?? ''),
    );
  }
  return fields;
}

/**
 * The web build sends a Blob, not a `{ uri }` part. Give it a local object URL so the stored
 * image still loads in the browser (the mock has no server to host it).
 */
function blobUri(blob: Blob): { uri?: string } {
  try {
    return { uri: URL.createObjectURL(blob) };
  } catch {
    // Native runtimes have no object URLs; their parts carry a real `uri` already.
    return {};
  }
}

/**
 * Reads a multipart request body.
 * React Native's whatwg-fetch style `Request` keeps the original `FormData` in `_bodyInit`
 * (RN `FormData` exposes `getParts()`) and its `formData()` may throw, so try that first and
 * fall back to the standard `request.formData()`.
 */
export async function readMultipart(request: Request): Promise<FormFields> {
  const bodyInit = (request as unknown as { _bodyInit?: unknown })._bodyInit;
  if (isRnFormData(bodyInit)) return fromRnParts(bodyInit);

  const form = (await request.formData()) as unknown as {
    entries: () => Iterable<
      [string, string | (Required<Omit<FormFile, 'uri'>> & Blob)]
    >;
  };
  const fields: FormFields = new Map();
  for (const [key, value] of form.entries()) {
    fields.set(
      key,
      typeof value === 'string'
        ? value
        : {
            name: value.name,
            type: value.type,
            size: value.size,
            ...blobUri(value),
          },
    );
  }
  return fields;
}
