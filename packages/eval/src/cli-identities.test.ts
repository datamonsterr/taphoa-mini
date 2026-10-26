import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chooseAuth, main } from './cli.ts';
import { ClerkAuth, EnvAuth, LEAD_EMAIL, SELLER_EMAIL } from './runner/auth.ts';

const SECRET = 'sk_test_clerk_secret';
const STORE = 'e7a10e7a-0000-4000-8000-000000000000';

let dir: string;
let githubEnv: string;
let lines: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'identities-'));
  githubEnv = join(dir, 'github-env');
  writeFileSync(githubEnv, '');
  lines = [];
  vi.spyOn(console, 'error').mockImplementation((l: unknown) => {
    lines.push(String(l));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function clerk(missing: string[] = []) {
  let sessions = 0;
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/users') {
      const email = url.searchParams.get('email_address') ?? '';
      return Response.json(
        missing.includes(email) ? [] : [{ id: `user_${email.length}` }],
      );
    }
    if (url.pathname === '/v1/sessions') {
      sessions++;
      return Response.json({ id: `sess_${sessions}` });
    }
    expect(init?.method).toBe('POST');
    const exp = Math.floor(Date.now() / 1000) + 60;
    const part = (o: object) =>
      Buffer.from(JSON.stringify(o)).toString('base64url');
    const session = url.pathname.split('/')[3];
    return Response.json({
      jwt: `${part({})}.${part({ exp, session })}.sig`,
    });
  });
}

const run = (
  args: string[],
  env: Record<string, string | undefined>,
  fetchFn: typeof fetch,
) =>
  main(args, env, {
    fetch: fetchFn,
    log: (l) => lines.push(l),
    warn: (l) => lines.push(l),
  });

describe('identities', () => {
  it('checks both roles and prints no token', async () => {
    const f = clerk();
    expect(await run(['identities'], { CLERK_SECRET_KEY: SECRET }, f)).toBe(0);
    const out = lines.join('\n');
    expect(out).toContain('lead');
    expect(out).toContain('seller');
    expect(out).not.toMatch(/\.sig/);
    expect(out).not.toContain(SECRET);
  });

  it('writes masked tokens and the store id to GITHUB_ENV', async () => {
    const code = await run(
      ['identities', '--github-env'],
      { CLERK_SECRET_KEY: SECRET, GITHUB_ENV: githubEnv },
      clerk(),
    );
    expect(code).toBe(0);
    const file = readFileSync(githubEnv, 'utf8');
    const lead = /^EVAL_LEAD_TOKEN=(.+)$/m.exec(file)?.[1];
    const seller = /^EVAL_SELLER_TOKEN=(.+)$/m.exec(file)?.[1];
    expect(lead).toBeTruthy();
    expect(seller).toBeTruthy();
    expect(lead).not.toBe(seller);
    expect(file).toContain(`EVAL_STORE_ID=${STORE}`);
    // Each token is masked, and appears nowhere else in the output.
    expect(lines).toContain(`::add-mask::${lead}`);
    expect(lines).toContain(`::add-mask::${seller}`);
    expect(lines.filter((l) => l.includes(lead!))).toHaveLength(1);
    expect(lines.filter((l) => l.includes(seller!))).toHaveLength(1);
  });

  it('uses EVAL_STORE_ID when it is set', async () => {
    await run(
      ['identities', '--github-env'],
      { CLERK_SECRET_KEY: SECRET, GITHUB_ENV: githubEnv, EVAL_STORE_ID: 'abc' },
      clerk(),
    );
    expect(readFileSync(githubEnv, 'utf8')).toContain('EVAL_STORE_ID=abc');
  });

  it('fails clearly when a user is missing, writing nothing', async () => {
    const code = await run(
      ['identities', '--github-env'],
      { CLERK_SECRET_KEY: SECRET, GITHUB_ENV: githubEnv },
      clerk([SELLER_EMAIL]),
    );
    expect(code).toBe(2);
    expect(lines.join('\n')).toContain(SELLER_EMAIL);
    expect(readFileSync(githubEnv, 'utf8')).toBe('');
  });

  it('names the lead user when it is the missing one', async () => {
    const code = await run(
      ['identities'],
      { CLERK_SECRET_KEY: SECRET },
      clerk([LEAD_EMAIL]),
    );
    expect(code).toBe(2);
    expect(lines.join('\n')).toContain(LEAD_EMAIL);
  });

  it('needs CLERK_SECRET_KEY', async () => {
    const f = clerk();
    expect(await run(['identities'], {}, f)).toBe(2);
    expect(f).not.toHaveBeenCalled();
  });

  it('needs GITHUB_ENV for --github-env', async () => {
    const code = await run(
      ['identities', '--github-env'],
      { CLERK_SECRET_KEY: SECRET },
      clerk(),
    );
    expect(code).toBe(2);
  });
});

describe('chooseAuth', () => {
  it('prefers fixed tokens, then Clerk, then the missing-token error', () => {
    expect(
      chooseAuth({ EVAL_LEAD_TOKEN: 't', CLERK_SECRET_KEY: SECRET }),
    ).toBeInstanceOf(EnvAuth);
    expect(chooseAuth({ CLERK_SECRET_KEY: SECRET })).toBeInstanceOf(ClerkAuth);
    expect(
      chooseAuth({ CLERK_SECRET_KEY: SECRET, EVAL_LEAD_TOKEN: ' ' }),
    ).toBeInstanceOf(ClerkAuth);
    expect(chooseAuth({})).toBeInstanceOf(EnvAuth);
  });
});
