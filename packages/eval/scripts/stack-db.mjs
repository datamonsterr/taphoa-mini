// Database helpers for scripts/local-stack.sh, so the stack needs no psql or redis-cli.
//
//   node scripts/stack-db.mjs create <admin-url> <db>     create the database when missing
//   node scripts/stack-db.mjs drop <admin-url> <db>       drop it (connections are cut)
//   node scripts/stack-db.mjs flush-redis <redis-url>     FLUSHDB of the database in the URL path
//
// Names are checked, never interpolated unchecked. Passwords are never printed.
import net from 'node:net';
import pg from 'pg';

const [command, target, name] = process.argv.slice(2);

function dbName(value) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value ?? '')) {
    throw new Error(`invalid database name: ${value}`);
  }
  return value;
}

async function withAdmin(url, fn) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function resp(...parts) {
  return (
    `*${parts.length}\r\n` +
    parts.map((p) => `$${Buffer.byteLength(p)}\r\n${p}\r\n`).join('')
  );
}

async function flushRedis(url) {
  const u = new URL(url);
  const db = u.pathname.replace(/^\//, '') || '0';
  if (!/^\d+$/.test(db) || db === '0') {
    // Refuse DB 0: the shared default database belongs to other work.
    throw new Error(`refusing to flush redis db ${db}; use a numbered db`);
  }
  const commands = [];
  if (u.password) commands.push(resp('AUTH', decodeURIComponent(u.password)));
  commands.push(resp('SELECT', db), resp('FLUSHDB'));
  await new Promise((resolve, reject) => {
    const socket = net.connect(Number(u.port || 6379), u.hostname);
    let seen = '';
    let expected = commands.length;
    socket.setTimeout(5000, () => reject(new Error('redis timeout')));
    socket.on('error', reject);
    socket.on('data', (chunk) => {
      seen += chunk.toString('utf8');
      const replies = seen.split('\r\n').filter(Boolean);
      const bad = replies.find((r) => r.startsWith('-'));
      if (bad) {
        reject(new Error(`redis: ${bad}`));
        socket.destroy();
      } else if (replies.length >= expected) {
        socket.end();
        resolve(undefined);
      }
    });
    socket.on('connect', () => socket.write(commands.join('')));
  });
}

try {
  if (command === 'create') {
    const db = dbName(name);
    await withAdmin(target, async (c) => {
      const { rowCount } = await c.query(
        'SELECT 1 FROM pg_database WHERE datname = $1',
        [db],
      );
      if (rowCount === 0) await c.query(`CREATE DATABASE ${db}`);
    });
    console.log(`database ${db} ready`);
  } else if (command === 'drop') {
    const db = dbName(name);
    await withAdmin(target, (c) =>
      c.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`),
    );
    console.log(`database ${db} dropped`);
  } else if (command === 'flush-redis') {
    await flushRedis(target);
    console.log('redis database flushed');
  } else {
    console.error(
      'usage: stack-db.mjs create|drop <admin-url> <db> | flush-redis <url>',
    );
    process.exit(2);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
