// Security headers and Content Security Policy definitions for apps/landing.
// These headers are served by apps/landing/Caddyfile in production and
// mirrored by scripts/serve.mjs in local preview and Playwright testing.

export const CSP_DIRECTIVES = {
  'default-src': ["'none'"],
  'script-src': ["'self'"],
  'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
  'font-src': ['https://fonts.gstatic.com'],
  'img-src': ["'self'"],
  'connect-src': ["'self'", 'https://backend-production-5f5c.up.railway.app'],
  'frame-ancestors': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'self'"],
};

export function buildCspString(directives = CSP_DIRECTIVES) {
  return Object.entries(directives)
    .map(([directive, values]) => `${directive} ${values.join(' ')}`)
    .join('; ');
}

export const CSP_POLICY = buildCspString();

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy':
    'camera=(), microphone=(), geolocation=(), browsing-topics=()',
  'Content-Security-Policy': CSP_POLICY,
};

/**
 * Parses a CSP string into a Map of directive name to array of token values.
 * @param {string} cspString
 * @returns {Map<string, string[]>}
 */
export function parseCsp(cspString) {
  const map = new Map();
  for (const part of cspString.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const tokens = trimmed.split(/\s+/);
    const directive = tokens[0].toLowerCase();
    const values = tokens.slice(1);
    map.set(directive, values);
  }
  return map;
}

/**
 * Validates that a CSP policy contains all required directives and does not allow unsafe-inline in script-src.
 * Throws an Error with a descriptive message if any check fails.
 * @param {string} cspString
 */
export function validateCsp(cspString) {
  if (!cspString || typeof cspString !== 'string') {
    throw new Error('Content-Security-Policy header is missing or empty');
  }

  const parsed = parseCsp(cspString);

  const defaultSrc = parsed.get('default-src');
  if (!defaultSrc || !defaultSrc.includes("'none'")) {
    throw new Error("CSP must include: default-src 'none'");
  }

  const scriptSrc = parsed.get('script-src');
  if (!scriptSrc || !scriptSrc.includes("'self'")) {
    throw new Error("CSP must include: script-src 'self'");
  }
  if (scriptSrc.includes("'unsafe-inline'")) {
    throw new Error("CSP script-src must not allow 'unsafe-inline'");
  }
  if (scriptSrc.includes("'unsafe-eval'")) {
    throw new Error("CSP script-src must not allow 'unsafe-eval'");
  }

  const styleSrc = parsed.get('style-src');
  if (!styleSrc || !styleSrc.includes("'self'")) {
    throw new Error("CSP must include 'self' in style-src");
  }
  if (!styleSrc.includes('https://fonts.googleapis.com')) {
    throw new Error('CSP must allow https://fonts.googleapis.com in style-src');
  }

  const fontSrc = parsed.get('font-src');
  if (!fontSrc || !fontSrc.includes('https://fonts.gstatic.com')) {
    throw new Error('CSP must allow https://fonts.gstatic.com in font-src');
  }

  const imgSrc = parsed.get('img-src');
  if (!imgSrc || !imgSrc.includes("'self'")) {
    throw new Error("CSP must allow 'self' in img-src");
  }

  const connectSrc = parsed.get('connect-src');
  if (
    !connectSrc ||
    !connectSrc.includes('https://backend-production-5f5c.up.railway.app')
  ) {
    throw new Error(
      'CSP must allow https://backend-production-5f5c.up.railway.app in connect-src',
    );
  }

  const frameAncestors = parsed.get('frame-ancestors');
  if (!frameAncestors || !frameAncestors.includes("'none'")) {
    throw new Error("CSP must include: frame-ancestors 'none'");
  }

  const baseUri = parsed.get('base-uri');
  if (!baseUri || !baseUri.includes("'none'")) {
    throw new Error("CSP must include: base-uri 'none'");
  }

  const formAction = parsed.get('form-action');
  if (!formAction || !formAction.includes("'self'")) {
    throw new Error("CSP must include: form-action 'self'");
  }

  return true;
}
