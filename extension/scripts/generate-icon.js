// Generates a colorful 128x128 PNG marketplace icon (resources/icon.png).
// Renders at 4x supersampling and downsamples for anti-aliasing, using only
// Node built-ins (zlib for deflate + crc32, no external image libraries).
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const SIZE = 128;
const SCALE = 4;
const SS = SIZE * SCALE; // supersampled size

// Colors
const BG_TOP_LEFT = [99, 102, 241]; // indigo #6366F1
const BG_BOTTOM_RIGHT = [249, 115, 22]; // orange #F97316
const STAR_FILL = [255, 255, 255]; // white
const DOT_FILL = [255, 255, 255]; // white
const CORNER_RADIUS = 22 * SCALE;

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function insideRoundedRect(x, y, w, h, r) {
  if (x < r && y < r) {
    return Math.hypot(x - r, y - r) <= r;
  }
  if (x > w - r && y < r) {
    return Math.hypot(x - (w - r), y - r) <= r;
  }
  if (x < r && y > h - r) {
    return Math.hypot(x - r, y - (h - r)) <= r;
  }
  if (x > w - r && y > h - r) {
    return Math.hypot(x - (w - r), y - (h - r)) <= r;
  }
  return true;
}

function pointInPolygon(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    const intersect = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersect) {
      inside = !inside;
    }
  }
  return inside;
}

function starPolygon(cx, cy, outerR, innerR) {
  const points = [];
  for (let i = 0; i < 10; i++) {
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    const r = i % 2 === 0 ? outerR : innerR;
    points.push([cx + r * Math.cos(angle), cy + r * Math.sin(angle)]);
  }
  return points;
}

const star = starPolygon(SS / 2, SS * 0.44, SS * 0.34, SS * 0.135);
const dotRadius = SS * 0.045;
const dotY = SS * 0.825;
const dotXs = [SS * 0.32, SS * 0.5, SS * 0.68];

// Render at supersampled resolution.
const buf = Buffer.alloc(SS * SS * 4);
for (let y = 0; y < SS; y++) {
  for (let x = 0; x < SS; x++) {
    const idx = (y * SS + x) * 4;
    if (!insideRoundedRect(x, y, SS, SS, CORNER_RADIUS)) {
      buf[idx + 3] = 0; // transparent outside rounded rect
      continue;
    }

    const t = (x + y) / (2 * SS);
    let r = lerp(BG_TOP_LEFT[0], BG_BOTTOM_RIGHT[0], t);
    let g = lerp(BG_TOP_LEFT[1], BG_BOTTOM_RIGHT[1], t);
    let b = lerp(BG_TOP_LEFT[2], BG_BOTTOM_RIGHT[2], t);

    if (pointInPolygon(x + 0.5, y + 0.5, star)) {
      [r, g, b] = STAR_FILL;
    } else {
      for (const dx of dotXs) {
        if (Math.hypot(x + 0.5 - dx, y + 0.5 - dotY) <= dotRadius) {
          [r, g, b] = DOT_FILL;
          break;
        }
      }
    }

    buf[idx] = Math.round(r);
    buf[idx + 1] = Math.round(g);
    buf[idx + 2] = Math.round(b);
    buf[idx + 3] = 255;
  }
}

// Downsample SS x SS -> SIZE x SIZE by averaging SCALE x SCALE blocks.
const out = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let sy = 0; sy < SCALE; sy++) {
      for (let sx = 0; sx < SCALE; sx++) {
        const sIdx = ((y * SCALE + sy) * SS + (x * SCALE + sx)) * 4;
        r += buf[sIdx];
        g += buf[sIdx + 1];
        b += buf[sIdx + 2];
        a += buf[sIdx + 3];
      }
    }
    const n = SCALE * SCALE;
    const oIdx = (y * SIZE + x) * 4;
    out[oIdx] = Math.round(r / n);
    out[oIdx + 1] = Math.round(g / n);
    out[oIdx + 2] = Math.round(b / n);
    out[oIdx + 3] = Math.round(a / n);
  }
}

// Build raw scanlines with filter byte 0 per row.
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter type: none
  out.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(zlib.crc32(crcInput) >>> 0, 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const ihdrData = Buffer.alloc(13);
ihdrData.writeUInt32BE(SIZE, 0); // width
ihdrData.writeUInt32BE(SIZE, 4); // height
ihdrData[8] = 8; // bit depth
ihdrData[9] = 6; // color type: RGBA
ihdrData[10] = 0; // compression
ihdrData[11] = 0; // filter
ihdrData[12] = 0; // interlace

const idatData = zlib.deflateSync(raw, { level: 9 });

const png = Buffer.concat([
  signature,
  chunk("IHDR", ihdrData),
  chunk("IDAT", idatData),
  chunk("IEND", Buffer.alloc(0)),
]);

const outPath = path.join(__dirname, "..", "resources", "icon.png");
fs.writeFileSync(outPath, png);
console.log(`Wrote ${outPath} (${png.length} bytes)`);
