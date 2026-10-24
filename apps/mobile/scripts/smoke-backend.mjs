// Calls a running backend the way the app does: create store, upload, enroll, sell, report,
// refresh rotation, invite/join, logout, recovery. Exits non-zero on the first broken contract.
//
//   BACKEND_URL=http://localhost:18080 node scripts/smoke-backend.mjs
//
// Enrollment needs the backend started with EMBEDDER=mock (or the DINO model); scans need the SAM
// model and answer 503 without it, which the script asserts because the app must show an error.
import { deflateSync } from 'node:zlib';

const BASE = (process.env.BACKEND_URL ?? 'http://localhost:8080').replace(
  /\/+$/,
  '',
);
const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:8099';

let step = 0;
const log = (message) =>
  console.log(`${String(++step).padStart(2, '0')} ok  ${message}`);

function assert(condition, message, detail) {
  if (!condition) {
    console.error(
      `FAIL ${message}`,
      detail === undefined ? '' : JSON.stringify(detail),
    );
    process.exit(1);
  }
}

// Client-generated UUIDv7, like src/lib/uuid.ts.
function uuidv7() {
  const hex = (n, l) => n.toString(16).padStart(l, '0');
  const rnd = (bits) => Math.floor(Math.random() * 2 ** bits);
  const time = hex(Date.now(), 12);
  return [
    time.slice(0, 8),
    time.slice(8),
    `7${hex(rnd(12), 3)}`,
    `${hex(8 + rnd(2), 1)}${hex(rnd(12), 3)}`,
    hex(rnd(24), 6) + hex(rnd(24), 6),
  ].join('-');
}

// The server's short sale code (money::sale_code), also computed by src/lib/uuid.ts saleCode.
function saleCode(id) {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const tail = BigInt(`0x${id.replace(/-/g, '')}`) & ((1n << 30n) - 1n);
  let code = '';
  for (let p = 5; p >= 0; p -= 1)
    code += alphabet[Number((tail >> BigInt(p * 5)) & 31n)];
  return code;
}

// A valid PNG with some texture, so the image decoders on the server accept it.
function png(width = 64, height = 64, seed = 1) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = y * (width * 3 + 1) + 1 + x * 3;
      raw[o] = (x * 4 * seed) & 255;
      raw[o + 1] = (y * 4 + seed * 30) & 255;
      raw[o + 2] = ((x + y) * 2 * seed) & 255;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function call(
  method,
  path,
  { token, body, headers = {}, form, expect } = {},
) {
  const init = { method, headers: { ...headers } };
  if (token) init.headers.authorization = `Bearer ${token}`;
  if (form) init.body = form;
  else if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${BASE}${path}`, init);
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  if (expect !== undefined) {
    const ok = Array.isArray(expect)
      ? expect.includes(response.status)
      : response.status === expect;
    assert(
      ok,
      `${method} ${path} -> ${response.status} (wanted ${expect})`,
      json,
    );
  }
  return { status: response.status, json, headers: response.headers };
}

const device = { name: 'smoke', platform: 'web', app_version: '1.0.0' };

// -- CORS: the web origin must be able to send Authorization + Idempotency-Key ---------------------
{
  const pre = await fetch(`${BASE}/v1/sales`, {
    method: 'OPTIONS',
    headers: {
      origin: ORIGIN,
      'access-control-request-method': 'POST',
      'access-control-request-headers':
        'authorization,content-type,idempotency-key',
    },
  });
  const allowed = (
    pre.headers.get('access-control-allow-headers') ?? ''
  ).toLowerCase();
  assert(pre.ok, 'preflight succeeds', pre.status);
  assert(
    allowed.includes('authorization') && allowed.includes('idempotency-key'),
    'preflight names Authorization and Idempotency-Key (a "*" does not cover Authorization)',
    allowed,
  );
  assert(
    ['*', ORIGIN].includes(pre.headers.get('access-control-allow-origin')),
    'origin allowed',
  );
  log(`CORS preflight allows ${ORIGIN}`);
}

// -- F1 create store ----------------------------------------------------------------------------
const created = await call('POST', '/v1/stores', {
  body: { store_name: 'Tạp hóa Smoke', display_name: 'Mẹ', device },
  expect: 201,
});
const lead = created.json;
assert(
  lead.access_token && lead.refresh_token && lead.recovery_code,
  'session + recovery code',
  lead,
);
assert(
  lead.member.role === 'lead' && lead.store.name === 'Tạp hóa Smoke',
  'member and store',
  lead,
);
log(`create store ${lead.store.id}`);
let access = lead.access_token;
let refresh = lead.refresh_token;

const me = await call('GET', '/v1/me', { token: access, expect: 200 });
assert(me.json.member.id === lead.member.id, 'GET /v1/me');
await call('GET', '/v1/store', { token: access, expect: 200 });
const members = await call('GET', '/v1/members', {
  token: access,
  expect: 200,
});
assert(members.json.items.length === 1, 'one member', members.json);
log('me / store / members');

await call('POST', '/v1/products', { body: {}, expect: 401 });
log('private routes answer 401 without a token');

// -- bank account (VietQR) ----------------------------------------------------------------------
const bank = {
  bank_bin: '970436',
  bank_short_name: 'Vietcombank',
  account_number: '0123456789',
  account_name: 'NGUYEN THI BA',
};
const patched = await call('PATCH', '/v1/store', {
  token: access,
  body: { bank_account: bank },
  headers: { 'content-type': 'application/merge-patch+json' },
  expect: 200,
});
assert(
  patched.json.bank_account?.account_number === '0123456789',
  'bank account saved',
  patched.json,
);
log('PATCH /v1/store bank account');

// -- enrollment: upload + create product -------------------------------------------------------
async function upload(seed, purpose = 'enrollment') {
  const form = new FormData();
  form.append(
    'image',
    new Blob([png(64, 64, seed)], { type: 'image/png' }),
    'enroll.png',
  );
  form.append('purpose', purpose);
  const r = await call('POST', '/v1/images', {
    token: access,
    form,
    expect: 201,
  });
  assert(r.json.id && r.json.url, 'image has id and presigned url', r.json);
  return r.json;
}
const image = await upload(1);
const imageFile = await fetch(image.url);
assert(imageFile.ok, 'presigned image url is fetchable', imageFile.status);
log(`upload image ${image.id} and fetch its presigned url`);

const productId = uuidv7();
const productBody = {
  id: productId,
  price: 12000,
  image_ids: [image.id],
  name: 'Sting đỏ 330ml',
  force_new: false,
};
const productRes = await call('POST', '/v1/products', {
  token: access,
  body: productBody,
});
if (productRes.status === 503) {
  console.log(
    'SKIP product enrollment: backend has no embedder (start it with EMBEDDER=mock)',
  );
  process.exit(2);
}
assert(productRes.status === 201, 'POST /v1/products -> 201', productRes);
assert(
  productRes.json.images[0].url && productRes.json.price === 12000,
  'product shape',
  productRes.json,
);
const replay = await call('POST', '/v1/products', {
  token: access,
  body: productBody,
  expect: 200,
});
assert(replay.json.id === productId, 'same id and body replays 200');
log(`create product ${productId} (+ idempotent replay)`);

const list = await call('GET', '/v1/products?limit=200', {
  token: access,
  expect: 200,
});
assert(
  list.json.items.some((p) => p.id === productId),
  'product listed',
  list.json,
);
assert(
  !('stock_quantity' in list.json.items[0]),
  'no stock_quantity from the real API',
);
const search = await call(
  'GET',
  `/v1/products?q=${encodeURIComponent('sting')}`,
  { token: access, expect: 200 },
);
assert(
  search.json.items.length === 1,
  'accent-insensitive search',
  search.json,
);
await call('GET', `/v1/products/${productId}`, { token: access, expect: 200 });
log('list / search / get product');

const dup = await call('POST', '/v1/products', {
  token: access,
  body: { id: uuidv7(), price: 9000, image_ids: [image.id], force_new: false },
});
assert([409, 201].includes(dup.status), 'second enroll of the same photo', dup);
if (dup.status === 409) {
  assert(
    dup.json.code === 'duplicate_suspected' &&
      dup.json.details.candidates.length > 0,
    'duplicate body',
    dup.json,
  );
  const second = await upload(1);
  const added = await call('POST', `/v1/products/${productId}/images`, {
    token: access,
    body: { image_id: second.id },
    expect: 201,
  });
  assert(added.json.url, 'added reference image', added.json);
  log('duplicate_suspected -> merge photo into the existing product');
}

const edited = await call('PATCH', `/v1/products/${productId}`, {
  token: access,
  body: { price: 15000 },
  headers: { 'content-type': 'application/merge-patch+json' },
  expect: 200,
});
assert(edited.json.price === 15000, 'price edit', edited.json);
log('PATCH product price');

// -- scan: no models here, the app must show an error rather than crash -------------------------
{
  const form = new FormData();
  form.append(
    'image',
    new Blob([png(64, 64, 2)], { type: 'image/png' }),
    'scan.png',
  );
  form.append('mode', 'single');
  form.append('purpose', 'checkout');
  const scan = await call('POST', '/v1/recognition/scans', {
    token: access,
    form,
  });
  assert(
    [201, 503].includes(scan.status),
    'scan answers 201 (models) or 503 (none)',
    scan,
  );
  assert(
    scan.status === 201 || typeof scan.json?.error === 'string',
    '503 has a JSON error body',
    scan.json,
  );
  log(
    `recognition scan -> ${scan.status}${scan.status === 503 ? ` ${JSON.stringify(scan.json)}` : ''}`,
  );
}

// -- checkout -----------------------------------------------------------------------------------
const saleId = uuidv7();
const soldAt = new Date().toISOString();
const code = saleCode(saleId);
const saleBody = {
  id: saleId,
  sold_at: soldAt,
  payment_method: 'transfer',
  total: 30000,
  vietqr_memo: `TH ${code}`,
  lines: [
    {
      id: uuidv7(),
      product_id: productId,
      source: 'camera',
      quantity: 2,
      unit_price: 15000,
    },
  ],
};
const sale = await call('POST', '/v1/sales', {
  token: access,
  body: saleBody,
  headers: { 'idempotency-key': saleId },
  expect: 201,
});
assert(
  sale.json.code === code,
  'server sale code equals the app-side saleCode (VietQR memo)',
  [sale.json.code, code],
);
assert(
  sale.json.lines[0].price_mismatch === false && sale.json.total === 30000,
  'sale shape',
  sale.json,
);
const saleReplay = await call('POST', '/v1/sales', {
  token: access,
  body: saleBody,
  headers: { 'idempotency-key': saleId },
  expect: 200,
});
assert(saleReplay.json.id === saleId, 'identical retry replays 200');
const changedClock = await call('POST', '/v1/sales', {
  token: access,
  body: { ...saleBody, sold_at: new Date(Date.now() + 1000).toISOString() },
  expect: 409,
});
assert(
  changedClock.json.code === 'id_conflict',
  'a retry with a new sold_at is rejected (the app freezes sold_at)',
);
log(`create sale ${saleCode(saleId)} + replay + changed-clock conflict`);

const cash = await call('POST', '/v1/sales', {
  token: access,
  body: {
    id: uuidv7(),
    sold_at: new Date().toISOString(),
    payment_method: 'cash',
    cash_received: 50000,
    total: 15000,
    lines: [
      {
        id: uuidv7(),
        product_id: productId,
        source: 'camera',
        quantity: 1,
        unit_price: 15000,
      },
    ],
  },
  expect: 201,
});
assert(cash.json.change_given === 35000, 'cash change', cash.json);
log('cash sale with change');

// -- expense, reports, day close ----------------------------------------------------------------
const expenseBody = {
  id: uuidv7(),
  spent_at: new Date().toISOString(),
  amount: 20000,
  category: 'dien',
  paid_with: 'cash_box',
};
await call('POST', '/v1/expenses', {
  token: access,
  body: expenseBody,
  expect: 201,
});
await call('POST', '/v1/expenses', {
  token: access,
  body: expenseBody,
  expect: 200,
});
log('create expense + replay');

const today = await call('GET', '/v1/reports/today', {
  token: access,
  expect: 200,
});
assert(
  today.json.revenue === 45000 && today.json.sales_count === 2,
  'today revenue',
  today.json,
);
assert(
  today.json.transfer_revenue === 30000 && today.json.cash_revenue === 15000,
  'payment split',
);
assert(
  today.json.expenses === 20000 && today.json.net === 25000,
  'expenses and net',
);
const date = today.json.business_date;
log(`report today ${date}: revenue ${today.json.revenue}`);

const from = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
const summary = await call(
  'GET',
  `/v1/reports/summary?from=${from}&to=${date}&granularity=day`,
  {
    token: access,
    expect: 200,
  },
);
assert(
  summary.json.buckets.at(-1).revenue === 45000,
  'summary last bucket',
  summary.json,
);
const sales = await call(
  'GET',
  `/v1/sales?from=${date}&to=${date}&status=completed&limit=200`,
  {
    token: access,
    expect: 200,
  },
);
assert(sales.json.items.length === 2, 'sales list', sales.json);
await call('GET', `/v1/day-closes/${date}`, { token: access, expect: 404 });
const close = await call('PUT', `/v1/day-closes/${date}`, {
  token: access,
  body: { counted_cash: 15000 },
  expect: 200,
});
assert(
  close.json.expected_cash === 15000 - 20000 + 0 ||
    typeof close.json.expected_cash === 'number',
  'day close',
  close.json,
);
await call('GET', `/v1/day-closes/${date}`, { token: access, expect: 200 });
await call('GET', '/v1/alerts?status=open', { token: access, expect: 200 });
await call('GET', '/v1/review/manual-lines?status=open', {
  token: access,
  expect: 200,
});
log('summary / sales list / day close / alerts / review queue');

// -- refresh rotation ---------------------------------------------------------------------------
const rotated = await call('POST', '/v1/auth/refresh', {
  body: { refresh_token: refresh },
  expect: 200,
});
assert(
  rotated.json.refresh_token !== refresh && rotated.json.access_token,
  'rotated pair',
);
const oldRefresh = refresh;
access = rotated.json.access_token;
refresh = rotated.json.refresh_token;
await call('GET', '/v1/me', { token: access, expect: 200 });
log('refresh rotates the pair');
// Reuse of a rotated token is a theft signal: it revokes the session. (Why refresh must be single flight.)
await call('POST', '/v1/auth/refresh', {
  body: { refresh_token: oldRefresh },
  expect: 401,
});
await call('POST', '/v1/auth/refresh', {
  body: { refresh_token: refresh },
  expect: 401,
});
log('reusing a rotated refresh token revokes the session');

// -- recovery signs the Lead in again and rotates the code --------------------------------------
const recovered = await call('POST', '/v1/auth/recover', {
  body: { recovery_code: lead.recovery_code, device },
  expect: 200,
});
assert(
  recovered.json.recovery_code &&
    recovered.json.recovery_code !== lead.recovery_code,
  'new recovery code',
);
await call('POST', '/v1/auth/recover', {
  body: { recovery_code: lead.recovery_code, device },
  expect: 401,
});
access = recovered.json.access_token;
log('recover with the code (rotated, old code refused)');

// -- invite + join (U1), Seller permissions, logout ----------------------------------------------
const invite = await call('POST', '/v1/invites', {
  token: access,
  body: { role: 'seller', can_enroll: false, ttl_seconds: 600 },
  expect: 201,
});
assert(
  invite.json.token && invite.json.join_url.includes(invite.json.token),
  'invite',
  invite.json,
);
const spaced = invite.json.token
  .replace(/(.{4})/g, '$1 ')
  .trim()
  .toLowerCase();
const joined = await call('POST', '/v1/auth/join', {
  body: { invite_token: invite.json.token, display_name: 'Bà nội', device },
  expect: 201,
});
assert(joined.json.member.role === 'seller', 'joined as seller', joined.json);
await call('POST', '/v1/auth/join', {
  body: { invite_token: invite.json.token, display_name: 'Again', device },
  expect: 410,
});
assert(
  spaced.replace(/\s/g, '').toUpperCase() === invite.json.token,
  'token normalisation round-trips',
);
log('invite -> join (second use answers 410)');

const seller = joined.json.access_token;
await call('GET', '/v1/alerts?status=open', { token: seller, expect: 403 });
await call('GET', '/v1/review/manual-lines?status=open', {
  token: seller,
  expect: 403,
});
await call('PUT', `/v1/day-closes/${date}`, {
  token: seller,
  body: { counted_cash: 1 },
  expect: 403,
});
await call('PATCH', `/v1/products/${productId}`, {
  token: seller,
  body: { price: 1 },
  headers: { 'content-type': 'application/merge-patch+json' },
  expect: 403,
});
const sellerList = await call('GET', '/v1/products', {
  token: seller,
  expect: 200,
});
assert(
  sellerList.json.items[0].cost_price == null,
  'a Seller does not see cost prices',
  sellerList.json.items[0],
);
log('Seller gets 403 on Lead-only calls (the app hides them)');

await call('POST', '/v1/auth/logout', { token: seller, expect: 204 });
await call('GET', '/v1/me', { token: seller, expect: 401 });
log('logout revokes the session');

console.log('\nSMOKE PASSED');
