import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.resolve(__dirname, '..', 'build');

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0;
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  const compressed = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function sdRoundedBox(px, py, bx, by, r) {
  const qx = Math.abs(px) - bx + r;
  const qy = Math.abs(py) - by + r;
  const out = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return out + inside - r;
}

function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const aa = 2.2 / size;

  // 5 audio wave bars: [xCenter, halfHeight]
  const bars = [
    [-0.44, 0.16],
    [-0.22, 0.34],
    [0.0, 0.46],
    [0.22, 0.28],
    [0.44, 0.19],
  ];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = ((x + 0.5) / size) * 2 - 1;
      const v = ((y + 0.5) / size) * 2 - 1;

      // Squircle container
      const boxDist = sdRoundedBox(u, v, 0.9, 0.9, 0.24);
      const mask = 1 - smoothstep(-aa, aa, boxDist);
      if (mask <= 0.001) continue;

      // Deep dark obsidian background with tasteful aurora glow
      let r = 9;
      let g = 12;
      let b = 22;

      // Subtle corner aurora glows (Spotify emerald + violet + deep teal)
      const g1 = Math.exp(-((u + 0.45) ** 2 + (v + 0.42) ** 2) * 2.4);
      const g2 = Math.exp(-((u - 0.48) ** 2 + (v - 0.44) ** 2) * 2.2);
      const g3 = Math.exp(-((u - 0.1) ** 2 + (v + 0.5) ** 2) * 3.0);

      r += g1 * 18 + g2 * 96 + g3 * 16;
      g += g1 * 128 + g2 * 40 + g3 * 102;
      b += g1 * 72 + g2 * 188 + g3 * 148;

      // Crisp thin luminous ring halo
      const rad = Math.hypot(u, v);
      const ring = Math.exp(-((rad - 0.68) ** 2) * 260) * 0.34;
      r += ring * 45;
      g += ring * 215;
      b += ring * 155;

      // Subtle glass rim highlight
      const rim = smoothstep(-0.04, -0.005, boxDist) * (1 - smoothstep(-0.005, 0.008, boxDist));
      r += rim * 58;
      g += rim * 96;
      b += rim * 108;

      // Glowing audio visualizer bars
      for (const [bx, bh] of bars) {
        const d = sdRoundedBox(u - bx, v, 0.064, bh, 0.064);
        // Tight emerald bloom around each bar
        const glow = Math.exp(-Math.max(d, 0) * 18) * 0.14;
        r += glow * 30;
        g += glow * 225;
        b += glow * 125;

        const barAlpha = 1 - smoothstep(-aa, aa, d);
        if (barAlpha > 0) {
          // Vertical gradient across the bar (crisp pure white-mint top to Spotify emerald bottom)
          const t = clamp((v + bh) / (2 * bh), 0, 1);
          const br = 242 * (1 - t) + 30 * t;
          const bg = 255 * (1 - t) + 215 * t;
          const bb = 248 * (1 - t) + 110 * t;
          r = r * (1 - barAlpha) + br * barAlpha;
          g = g * (1 - barAlpha) + bg * barAlpha;
          b = b * (1 - barAlpha) + bb * barAlpha;
        }
      }

      const idx = (y * size + x) * 4;
      rgba[idx] = clamp(Math.round(r), 0, 255);
      rgba[idx + 1] = clamp(Math.round(g), 0, 255);
      rgba[idx + 2] = clamp(Math.round(b), 0, 255);
      rgba[idx + 3] = clamp(Math.round(mask * 255), 0, 255);
    }
  }

  return encodePng(size, size, rgba);
}

function encodeIco(pngEntries) {
  const count = pngEntries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = ICO
  header.writeUInt16LE(count, 4);

  const dirEntries = [];
  let offset = 6 + count * 16;

  for (const { size, png } of pngEntries) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bpp
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    dirEntries.push(entry);
    offset += png.length;
  }

  return Buffer.concat([header, ...dirEntries, ...pngEntries.map((e) => e.png)]);
}

fs.mkdirSync(buildDir, { recursive: true });
const sizes = [256, 128, 64, 48, 32, 16];
const entries = sizes.map((size) => ({ size, png: renderIcon(size) }));

fs.writeFileSync(path.join(buildDir, 'icon.png'), entries[0].png);
fs.writeFileSync(path.join(buildDir, 'icon.ico'), encodeIco(entries));
console.log('[generate-icon] Wrote build/icon.png and build/icon.ico');
