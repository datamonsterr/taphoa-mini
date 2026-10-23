import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ApiClient } from '@taphoa/api-client';
import {
  assertErrorResponse,
  createStore,
  joinAsSeller,
  newClient,
} from '../src/helpers.js';

const sample = readFileSync(
  new URL('../../../apps/backend/tests/fixtures/sample.png', import.meta.url),
);

/** Uploads the sample PNG with a unique trailer so every call is a distinct object. */
async function upload(
  client: ApiClient,
  tag: string = randomUUID(),
): Promise<string> {
  const file = new File([sample, Buffer.from(tag)], 'p.png', {
    type: 'image/png',
  });
  const { data, response } = await client.uploadImage(file, 'enrollment');
  expect(response.status).toBe(201);
  return data!.id;
}

async function enroll(
  client: ApiClient,
  body: Record<string, unknown> = {},
  tag?: string,
) {
  const image = await upload(client, tag);
  const id = randomUUID();
  const res = await client.raw.POST('/v1/products', {
    body: {
      id,
      price: 10000,
      image_ids: [image],
      force_new: true,
      ...body,
    } as never,
  });
  return { id, image, ...res };
}

/** The embedder is optional in some environments: skip enroll specs on 503. */
async function enrollOrSkip(
  ctx: { skip: () => void },
  client: ApiClient,
  body: Record<string, unknown> = {},
) {
  const res = await enroll(client, body);
  if (res.response.status === 503) {
    ctx.skip();
  }
  expect(res.response.status).toBe(201);
  return res;
}

describe('Catalog contract specs (E3)', () => {
  it('enrolls, reads, edits price with history, archives', async (ctx) => {
    const { client: lead } = await createStore();
    const created = await enrollOrSkip(ctx, lead, {
      name: 'Sting đỏ 330ml',
      cost_price: 8000,
      base_unit: 'chai',
    });
    const product = created.data!;
    expect(product.version).toBe(1);
    expect(product.images).toHaveLength(1);
    expect(product.archived).toBe(false);

    // identical replay is 200
    const replay = await lead.raw.POST('/v1/products', {
      body: {
        id: created.id,
        price: 10000,
        image_ids: [created.image],
        force_new: true,
        name: 'Sting đỏ 330ml',
        cost_price: 8000,
        base_unit: 'chai',
      } as never,
    });
    expect(replay.response.status).toBe(200);

    const patched = await lead.raw.PATCH('/v1/products/{productId}', {
      params: { path: { productId: created.id } },
      body: { price: 12000 } as never,
    });
    expect(patched.response.status).toBe(200);
    expect(patched.data!.price).toBe(12000);
    expect(patched.data!.version).toBe(2);

    const hist = await lead.raw.GET('/v1/products/{productId}/price-history', {
      params: { path: { productId: created.id } },
    });
    expect(hist.response.status).toBe(200);
    expect(
      hist.data!.items.some(
        (h) =>
          h.field === 'price' && h.old_value === 10000 && h.new_value === 12000,
      ),
    ).toBe(true);

    const del = await lead.raw.DELETE('/v1/products/{productId}', {
      params: { path: { productId: created.id } },
    });
    expect(del.response.status).toBe(204);
    const list = await lead.raw.GET('/v1/products');
    expect(list.data!.items.map((p) => p.id)).not.toContain(created.id);
  });

  it('searches accent-insensitively and paginates', async (ctx) => {
    const { client: lead } = await createStore();
    await enrollOrSkip(ctx, lead, { name: 'Mì Hảo Hảo' });
    for (let i = 0; i < 3; i++) await enroll(lead, { name: `Item ${i}` });
    const found = await lead.raw.GET('/v1/products', {
      params: { query: { q: 'hao hao' } },
    });
    expect(found.data!.items).toHaveLength(1);
    const page1 = await lead.raw.GET('/v1/products', {
      params: { query: { limit: 3 } },
    });
    expect(page1.data!.items).toHaveLength(3);
    expect(page1.data!.next_cursor).toBeTruthy();
    const page2 = await lead.raw.GET('/v1/products', {
      params: { query: { limit: 3, cursor: page1.data!.next_cursor! } },
    });
    expect(page2.data!.items).toHaveLength(1);
  });

  it('rejects a duplicate photo with candidates unless force_new', async (ctx) => {
    const { client: lead } = await createStore();
    const first = await enroll(lead, { name: 'Aquafina' }, '');
    if (first.response.status === 503) ctx.skip();
    expect(first.response.status).toBe(201);
    // Re-upload the very same bytes.
    const again = await upload(lead, '');
    const res = await lead.raw.POST('/v1/products', {
      body: { id: randomUUID(), price: 5000, image_ids: [again] } as never,
    });
    expect(res.response.status).toBe(409);
    assertErrorResponse(res.error, 'duplicate_suspected');
    const candidates = (
      res.error as { details?: { candidates?: { product_id: string }[] } }
    ).details!.candidates!;
    expect(candidates[0].product_id).toBe(first.id);
  });

  it('enforces the permission matrix', async (ctx) => {
    const { client: lead } = await createStore();
    const plain = (await joinAsSeller(lead)).client;
    const enroller = (await joinAsSeller(lead, { can_enroll: true })).client;
    const created = await enrollOrSkip(ctx, lead);

    const noEnroll = await enroll(plain);
    expect(noEnroll.response.status).toBe(403);
    const ok = await enroll(enroller);
    expect(ok.response.status).toBe(201);

    for (const client of [plain, enroller]) {
      const patch = await client.raw.PATCH('/v1/products/{productId}', {
        params: { path: { productId: created.id } },
        body: { price: 1 } as never,
      });
      expect(patch.response.status).toBe(403);
      const del = await client.raw.DELETE('/v1/products/{productId}', {
        params: { path: { productId: created.id } },
      });
      expect(del.response.status).toBe(403);
    }
    const cat = await plain.raw.POST('/v1/categories', {
      body: { id: randomUUID(), name: 'Nope' },
    });
    expect(cat.response.status).toBe(403);
  });

  it('isolates stores', async (ctx) => {
    const { client: a } = await createStore();
    const { client: b } = await createStore();
    const created = await enrollOrSkip(ctx, a);
    const get = await b.raw.GET('/v1/products/{productId}', {
      params: { path: { productId: created.id } },
    });
    expect(get.response.status).toBe(404);
    assertErrorResponse(get.error, 'not_found');
  });

  it('manages categories and reference photos', async (ctx) => {
    const { client: lead } = await createStore();
    const id = randomUUID();
    const c = await lead.raw.POST('/v1/categories', {
      body: { id, name: 'Nước giải khát' },
    });
    expect(c.response.status).toBe(201);
    const dup = await lead.raw.POST('/v1/categories', {
      body: { id: randomUUID(), name: 'nước giải khát' },
    });
    expect(dup.response.status).toBe(409);
    const cats = await lead.raw.GET('/v1/categories');
    expect(cats.data!.items).toHaveLength(1);

    const created = await enrollOrSkip(ctx, lead, { category_id: id });
    const extra = await upload(lead);
    const add = await lead.raw.POST('/v1/products/{productId}/images', {
      params: { path: { productId: created.id } },
      body: { image_id: extra },
    });
    expect(add.response.status).toBe(201);
    const rm = await lead.raw.DELETE(
      '/v1/products/{productId}/images/{imageId}',
      { params: { path: { productId: created.id, imageId: extra } } },
    );
    expect(rm.response.status).toBe(204);
    const last = await lead.raw.DELETE(
      '/v1/products/{productId}/images/{imageId}',
      { params: { path: { productId: created.id, imageId: created.image } } },
    );
    expect(last.response.status).toBe(409);
  });

  it('exports the price list', async (ctx) => {
    const { client: lead, session } = await createStore();
    await enrollOrSkip(ctx, lead, { name: 'Coca' });
    const base = process.env.BACKEND_URL!.replace(/\/+$/, '');
    const pdf = await fetch(`${base}/v1/exports/price-list`, {
      headers: { authorization: `Bearer ${session.access_token}` },
    });
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('content-type')).toContain('application/pdf');
    expect(
      Buffer.from(await pdf.arrayBuffer())
        .subarray(0, 4)
        .toString(),
    ).toBe('%PDF');
    const anon = await newClient().raw.GET('/v1/exports/price-list', {
      params: { query: {} },
      parseAs: 'stream',
    });
    expect(anon.response.status).toBe(401);
  });
});
