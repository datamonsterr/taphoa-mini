// Generates the placeholder product silhouettes in assets/products (no dependencies).
// Run: node scripts/gen-product-images.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 160;
const out = join(dirname(fileURLToPath(import.meta.url)), '../assets/products');

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type), data]);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
};

function png(pixels) {
  const raw = Buffer.alloc((SIZE * 3 + 1) * SIZE);
  for (let y = 0; y < SIZE; y += 1) {
    const row = y * (SIZE * 3 + 1);
    raw[row] = 0;
    pixels.copy(raw, row + 1, y * SIZE * 3, (y + 1) * SIZE * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

function canvas(bg) {
  const px = Buffer.alloc(SIZE * SIZE * 3);
  const set = (x, y, c) => px.set(c, (y * SIZE + x) * 3);
  for (let y = 0; y < SIZE; y += 1)
    for (let x = 0; x < SIZE; x += 1) set(x, y, hex(bg));
  const rect = (x0, y0, w, h, color, r = 0) => {
    const c = hex(color);
    for (let y = y0; y < y0 + h; y += 1) {
      for (let x = x0; x < x0 + w; x += 1) {
        const dx = Math.max(x0 + r - x, 0, x - (x0 + w - 1 - r));
        const dy = Math.max(y0 + r - y, 0, y - (y0 + h - 1 - r));
        if (dx * dx + dy * dy <= r * r) set(x, y, c);
      }
    }
  };
  return { px, rect };
}

const shapes = {
  can: ({ rect }, c) => {
    rect(52, 30, 56, 104, c.main, 8);
    rect(52, 62, 56, 34, c.accent);
    rect(58, 24, 44, 8, '#c9ced6', 3);
  },
  bottle: ({ rect }, c) => {
    rect(70, 18, 20, 22, '#c9ced6', 4);
    rect(54, 40, 52, 96, c.main, 18);
    rect(54, 70, 52, 30, c.accent);
  },
  box: ({ rect }, c) => {
    rect(40, 44, 80, 84, c.main, 6);
    rect(40, 44, 80, 22, c.accent, 6);
    rect(54, 84, 52, 26, '#ffffff', 4);
  },
  bag: ({ rect }, c) => {
    rect(38, 36, 84, 98, c.main, 10);
    rect(38, 36, 84, 14, c.accent, 6);
    rect(52, 72, 56, 34, '#ffffff', 6);
  },
  carton: ({ rect }, c) => {
    rect(48, 40, 64, 94, c.main, 4);
    rect(48, 24, 64, 20, c.accent, 3);
    rect(56, 74, 48, 28, '#ffffff', 4);
  },
  tray: ({ rect }, c) => {
    rect(32, 76, 96, 40, c.main, 12);
    for (let i = 0; i < 5; i += 1) rect(40 + i * 18, 60, 14, 22, c.accent, 7);
  },
  jug: ({ rect }, c) => {
    rect(56, 20, 30, 16, '#c9ced6', 4);
    rect(44, 36, 72, 100, c.main, 14);
    rect(44, 76, 72, 28, c.accent);
  },
};

const items = [
  ['coca', 'can', '#d32f2f', '#f5f5f5', '#fdecea'],
  ['coca-b', 'can', '#b71c1c', '#ffcdd2', '#fff5f5'],
  ['pepsi', 'can', '#1565c0', '#d32f2f', '#e8f1fb'],
  ['7up', 'can', '#2e7d32', '#c0ca33', '#eaf5ea'],
  ['haohao', 'bag', '#e53935', '#fdd835', '#fff8e1'],
  ['haohao-b', 'bag', '#c62828', '#ffee58', '#fffde7'],
  ['omachi', 'bag', '#f9a825', '#6d4c41', '#fff3e0'],
  ['vinamilk', 'carton', '#1976d2', '#e3f2fd', '#eef6fd'],
  ['vinamilk-b', 'carton', '#0d47a1', '#bbdefb', '#f3f8fe'],
  ['lavie', 'bottle', '#29b6f6', '#0277bd', '#e6f6fe'],
  ['oreo', 'box', '#1c1c24', '#1e88e5', '#ececf0'],
  ['trung', 'tray', '#d7b98e', '#f3e5c8', '#faf5ea'],
  ['tuongan', 'jug', '#f9a825', '#2e7d32', '#fff8e1'],
  ['namngu', 'bottle', '#8d3b1a', '#e53935', '#fbeee8'],
  ['omo', 'box', '#0288d1', '#e53935', '#e5f4fb'],
];

mkdirSync(out, { recursive: true });
for (const [slug, shape, main, accent, bg] of items) {
  const c = canvas(bg);
  shapes[shape](c, { main, accent });
  const file = join(out, `${slug}.png`);
  writeFileSync(file, png(c.px));
  console.log(slug);
}
