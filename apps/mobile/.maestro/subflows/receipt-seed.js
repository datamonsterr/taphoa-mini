// Host-side setup for receipts.yaml. Real Clerk + backend + OCR, no app test route.
// MAESTRO_CLERK_SECRET_KEY comes from the shell, never a YAML interpolation or log.
// CLI cwd is apps/mobile (scripts/e2e-android.sh); the emulator uses 10.0.2.2,
// while this HTTP client and the fixture upload use the host's localhost/filesystem.
var base =
  typeof MAESTRO_API_URL === 'string' && MAESTRO_API_URL
    ? MAESTRO_API_URL
    : 'http://localhost:8080';
function checked(response, operation) {
  if (!response.ok) {
    throw new Error(operation + ' failed: HTTP ' + response.status);
  }
  return json(response.body);
}
function clerk(method, route, body) {
  return checked(
    http.request('https://api.clerk.com/v1' + route, {
      method: method,
      headers: {
        Authorization: 'Bearer ' + MAESTRO_CLERK_SECRET_KEY,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    'Clerk ' + method,
  );
}
// Reuse the identity created by sign-in.yaml; never sign the phone out or replace
// its session. The second, short-lived testing session is only for API seeding.
var users = clerk(
  'GET',
  '/users?email_address=' + encodeURIComponent(output.email),
);
if (users.length !== 1)
  throw new Error('Expected exactly one flow-owned Clerk user');
var session = clerk('POST', '/sessions', { user_id: users[0].id });
var token = clerk('POST', '/sessions/' + session.id + '/tokens', {
  expires_in_seconds: 3600,
}).jwt;
var headers = {
  Authorization: 'Bearer ' + token,
  'Content-Type': 'application/json',
};
function api(method, route, body, extra) {
  return checked(
    http.request(base + route, {
      method: method,
      headers: Object.assign({}, headers, extra || {}),
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    'Receipt setup ' + method + ' ' + route,
  );
}
try {
  var me = api('GET', '/v1/me');
  if (me.memberships.length !== 1)
    throw new Error('Expected one flow-owned store');
  headers['X-Store-Id'] = me.memberships[0].store.id;
  if (typeof VERIFY_STOCK !== 'undefined' && VERIFY_STOCK === '1') {
    var saved = api('GET', '/v1/receipts/' + output.receipt.id);
    if (saved.status !== 'confirmed')
      throw new Error('Receipt was not confirmed');
    var stock = api('GET', '/v1/stock').items.filter(function (row) {
      return row.product_id === output.receipt.productId;
    });
    if (
      stock.length !== 1 ||
      stock[0].stock_quantity !== output.receipt.quantity
    ) {
      throw new Error(
        'Confirmed receipt did not increase product stock by the edited quantity',
      );
    }
  } else {
    var image = checked(
      http.post(base + '/v1/images', {
        headers: {
          Authorization: headers.Authorization,
          'X-Store-Id': headers['X-Store-Id'],
        },
        multipartForm: {
          purpose: 'enrollment',
          image: {
            filePath:
              '../backend/crates/recognition/tests/fixtures/receipts/receipt-1.jpg',
            mediaType: 'image/jpeg',
          },
        },
      }),
      'Receipt image upload',
    );
    var receipt = api(
      'POST',
      '/v1/receipts',
      { image_id: image.id },
      {
        'Idempotency-Key': 'g1-maestro-' + Date.now(),
      },
    );
    if (!receipt.lines.length)
      throw new Error('Real OCR returned no receipt lines');
    // Enroll after OCR so its background indexing cannot contend with OCR's slot.
    var hex = Date.now().toString(16).padStart(12, '0');
    var id =
      hex.slice(0, 8) +
      '-' +
      hex.slice(8) +
      '-7000-8000-' +
      Math.floor(Math.random() * 0xffffffffffff)
        .toString(16)
        .padStart(12, '0');
    var product = api('POST', '/v1/products', {
      id: id,
      name: 'G1 receipt stock',
      price: 15000,
      image_ids: [image.id],
      force_new: true,
    });
    // Only non-sensitive data is exposed to the flow/debug artifacts.
    output.receipt = {
      id: receipt.id,
      name: receipt.lines[0].product_name,
      quantity: receipt.lines[0].quantity + 1,
      product: product.name,
      productId: product.id,
      drops: receipt.lines.slice(1).map(function (line) {
        return line.product_name;
      }),
    };
  }
} finally {
  // Revoke the temporary seed session. The app keeps its original session.
  clerk('POST', '/sessions/' + session.id + '/revoke', {});
}
