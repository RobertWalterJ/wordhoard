// Wordhoard — icon generator. Writes app/icons/*.png with no dependencies:
// draws into an RGBA buffer, then encodes a PNG by hand (zlib is built in).
// Re-runnable:  node build/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'icons');
mkdirSync(OUT, { recursive: true });

// ── PNG encoding ─────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // raw scanlines, each prefixed with filter type 0
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── tiny drawing surface (with 3x supersampling for clean edges) ─────────
const SS = 3;

function surface(size) {
  const w = size * SS;
  const buf = Buffer.alloc(w * w * 4);
  const px = (x, y, [r, g, b, a = 255]) => {
    if (x < 0 || y < 0 || x >= w || y >= w) return;
    const i = (y * w + x) * 4;
    if (a === 255) { buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255; return; }
    const na = a / 255, ia = 1 - na;
    buf[i] = r * na + buf[i] * ia;
    buf[i + 1] = g * na + buf[i + 1] * ia;
    buf[i + 2] = b * na + buf[i + 2] * ia;
    buf[i + 3] = Math.max(buf[i + 3], a);
  };
  return {
    w,
    px,
    rect(x, y, rw, rh, col) {
      const x0 = Math.round(x * SS), y0 = Math.round(y * SS);
      const x1 = Math.round((x + rw) * SS), y1 = Math.round((y + rh) * SS);
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) px(xx, yy, col);
    },
    roundRect(x, y, rw, rh, r, col) {
      const x0 = x * SS, y0 = y * SS, x1 = (x + rw) * SS, y1 = (y + rh) * SS, rr = r * SS;
      for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) {
        for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
          const cx = Math.min(Math.max(xx + 0.5, x0 + rr), x1 - rr);
          const cy = Math.min(Math.max(yy + 0.5, y0 + rr), y1 - rr);
          const dx = xx + 0.5 - cx, dy = yy + 0.5 - cy;
          if (dx * dx + dy * dy <= rr * rr) px(xx, yy, col);
        }
      }
    },
    // Vertical gradient fill, drawn row by row.
    vgrad(x, y, rw, rh, top, bot, radius = 0) {
      const y0 = Math.round(y * SS), y1 = Math.round((y + rh) * SS);
      for (let yy = y0; yy < y1; yy++) {
        const k = (yy - y0) / Math.max(1, y1 - y0 - 1);
        const col = [
          Math.round(top[0] + (bot[0] - top[0]) * k),
          Math.round(top[1] + (bot[1] - top[1]) * k),
          Math.round(top[2] + (bot[2] - top[2]) * k),
          255,
        ];
        if (radius > 0) {
          // clip the row to the rounded rect
          const yc = yy + 0.5, ry0 = y * SS, ry1 = (y + rh) * SS, rr = radius * SS;
          const dy = Math.max(0, Math.max(ry0 + rr - yc, yc - (ry1 - rr)));
          const inset = dy > 0 ? rr - Math.sqrt(Math.max(0, rr * rr - dy * dy)) : 0;
          const x0 = Math.round(x * SS + inset), x1 = Math.round((x + rw) * SS - inset);
          for (let xx = x0; xx < x1; xx++) px(xx, yy, col);
        } else {
          const x0 = Math.round(x * SS), x1 = Math.round((x + rw) * SS);
          for (let xx = x0; xx < x1; xx++) px(xx, yy, col);
        }
      }
    },
    // Downsample the supersampled buffer to the target size.
    resolve(size) {
      const out = Buffer.alloc(size * size * 4);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          let r = 0, g = 0, b = 0, a = 0;
          for (let sy = 0; sy < SS; sy++) {
            for (let sx = 0; sx < SS; sx++) {
              const i = ((y * SS + sy) * w + (x * SS + sx)) * 4;
              r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; a += buf[i + 3];
            }
          }
          const n = SS * SS, o = (y * size + x) * 4;
          out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
        }
      }
      return out;
    },
  };
}

// ── the mark: a hoard of words, stacked ─────────────────────────────────
// Four bars tapering downward. It reads as lines of text at a glance and as a
// pile at a distance, and it still resolves at 48px on a home screen.
const NAVY_TOP = [22, 55, 92];
const NAVY_BOT = [8, 27, 49];
const PALE = [244, 241, 230, 255];
const PALE_DIM = [169, 189, 208, 255];
const GOLD = [237, 165, 44, 255];

function draw(size, { bleed }) {
  const s = surface(size);
  const u = size / 100;

  if (bleed) s.vgrad(0, 0, size, size, NAVY_TOP, NAVY_BOT);
  else s.vgrad(0, 0, size, size, NAVY_TOP, NAVY_BOT, 22 * u);

  // Maskable icons must keep the mark inside the middle ~80%.
  const k = bleed ? 0.78 : 1;
  const cx = size / 2, cy = size / 2;
  const M = (v) => v * u * k;
  const X = (v) => cx + M(v - 50);
  const Y = (v) => cy + M(v - 50);

  const bars = [
    [62, 25, GOLD],
    [52, 41, PALE],
    [40, 57, PALE],
    [24, 73, PALE_DIM],
  ];
  for (const [w, y, col] of bars) {
    s.roundRect(X(50 - w / 2), Y(y), M(w), M(11), M(5.5), col);
  }

  return s.resolve(size);
}

const jobs = [
  ['icon-192.png', 192, { bleed: false }],
  ['icon-512.png', 512, { bleed: false }],
  ['icon-maskable-512.png', 512, { bleed: true }],
];

for (const [name, size, opts] of jobs) {
  const png = encodePng(size, size, draw(size, opts));
  writeFileSync(join(OUT, name), png);
  console.log(name.padEnd(24), (png.length / 1024).toFixed(1) + 'K');
}
