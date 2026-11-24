import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CSP_POLICY,
  SECURITY_HEADERS,
  parseCsp,
  validateCsp,
} from './security-headers.mjs';

const SITE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const CADDYFILE_PATH = join(SITE_DIR, 'Caddyfile');

/**
 * Parses Caddyfile header block to extract header name and value pairs.
 * @param {string} caddyfileContent
 * @returns {Map<string, string>}
 */
function extractCaddyHeaders(caddyfileContent) {
  const headers = new Map();
  const headerBlockMatch = caddyfileContent.match(/header\s*\{([^}]+)\}/s);
  if (!headerBlockMatch) return headers;

  const lines = headerBlockMatch[1].split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    // Matches e.g. Content-Security-Policy "..." or X-Frame-Options DENY
    const match = trimmed.match(/^([A-Za-z0-9_-]+)\s+(?:"([^"]+)"|([^\s]+))$/);
    if (match) {
      const name = match[1];
      const value = match[2] !== undefined ? match[2] : match[3];
      headers.set(name, value);
    } else if (trimmed.startsWith('-')) {
      headers.set(trimmed, '');
    }
  }
  return headers;
}

test('Caddyfile defines all required security headers', async () => {
  const caddyfile = await readFile(CADDYFILE_PATH, 'utf8');
  const headers = extractCaddyHeaders(caddyfile);

  assert.equal(
    headers.get('X-Content-Type-Options'),
    'nosniff',
    'expected X-Content-Type-Options nosniff in Caddyfile',
  );
  assert.equal(
    headers.get('Referrer-Policy'),
    'strict-origin-when-cross-origin',
    'expected Referrer-Policy strict-origin-when-cross-origin in Caddyfile',
  );
  assert.equal(
    headers.get('X-Frame-Options'),
    'DENY',
    'expected X-Frame-Options DENY in Caddyfile',
  );
  assert.equal(
    headers.get('Permissions-Policy'),
    'camera=(), microphone=(), geolocation=(), browsing-topics=()',
    'expected Permissions-Policy in Caddyfile',
  );
  assert.ok(headers.has('-Server'), 'expected -Server in Caddyfile');
  assert.ok(
    headers.has('Content-Security-Policy'),
    'expected Content-Security-Policy in Caddyfile',
  );
});

test('Caddyfile CSP passes validation and matches security-headers module', async () => {
  const caddyfile = await readFile(CADDYFILE_PATH, 'utf8');
  const headers = extractCaddyHeaders(caddyfile);
  const caddyCsp = headers.get('Content-Security-Policy');

  assert.ok(caddyCsp, 'Caddyfile missing Content-Security-Policy');
  assert.equal(
    caddyCsp,
    CSP_POLICY,
    'Caddyfile CSP must match security-headers.mjs CSP_POLICY',
  );
  assert.doesNotThrow(() => validateCsp(caddyCsp));
});

test('validateCsp verifies all required directives', () => {
  assert.doesNotThrow(() => validateCsp(CSP_POLICY));

  // Must reject empty or missing
  assert.throws(() => validateCsp(''), /missing or empty/);

  // Must reject missing default-src 'none'
  assert.throws(
    () =>
      validateCsp(
        CSP_POLICY.replace("default-src 'none'", "default-src 'self'"),
      ),
    /default-src 'none'/,
  );

  // Must reject missing script-src
  assert.throws(
    () => validateCsp(CSP_POLICY.replace(/script-src [^;]+;?/, '')),
    /script-src 'self'/,
  );

  // Must reject unsafe-inline in script-src
  assert.throws(
    () =>
      validateCsp(
        CSP_POLICY.replace(
          "script-src 'self'",
          "script-src 'self' 'unsafe-inline'",
        ),
      ),
    /must not allow 'unsafe-inline'/,
  );

  // Must reject unsafe-eval in script-src
  assert.throws(
    () =>
      validateCsp(
        CSP_POLICY.replace(
          "script-src 'self'",
          "script-src 'self' 'unsafe-eval'",
        ),
      ),
    /must not allow 'unsafe-eval'/,
  );

  // Must reject missing Google Fonts in style-src
  assert.throws(
    () =>
      validateCsp(
        CSP_POLICY.replace('https://fonts.googleapis.com', 'https://other.com'),
      ),
    /https:\/\/fonts\.googleapis\.com/,
  );

  // Must reject missing Google Fonts in font-src
  assert.throws(
    () =>
      validateCsp(
        CSP_POLICY.replace('https://fonts.gstatic.com', 'https://other.com'),
      ),
    /https:\/\/fonts\.gstatic\.com/,
  );

  // Must reject missing backend in connect-src
  assert.throws(
    () =>
      validateCsp(
        CSP_POLICY.replace(
          'https://backend-production-5f5c.up.railway.app',
          'https://other.com',
        ),
      ),
    /https:\/\/backend-production-5f5c\.up\.railway\.app/,
  );

  // Must reject missing frame-ancestors 'none'
  assert.throws(
    () => validateCsp(CSP_POLICY.replace(/frame-ancestors [^;]+;?/, '')),
    /frame-ancestors 'none'/,
  );

  // Must reject missing base-uri 'none'
  assert.throws(
    () => validateCsp(CSP_POLICY.replace(/base-uri [^;]+;?/, '')),
    /base-uri 'none'/,
  );

  // Must reject missing form-action 'self'
  assert.throws(
    () => validateCsp(CSP_POLICY.replace(/form-action [^;]+;?/, '')),
    /form-action 'self'/,
  );
});

test('security-headers module provides all headers', () => {
  assert.equal(SECURITY_HEADERS['X-Content-Type-Options'], 'nosniff');
  assert.equal(
    SECURITY_HEADERS['Referrer-Policy'],
    'strict-origin-when-cross-origin',
  );
  assert.equal(SECURITY_HEADERS['X-Frame-Options'], 'DENY');
  assert.equal(
    SECURITY_HEADERS['Permissions-Policy'],
    'camera=(), microphone=(), geolocation=(), browsing-topics=()',
  );
  assert.equal(SECURITY_HEADERS['Content-Security-Policy'], CSP_POLICY);
});
