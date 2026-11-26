// 依存なしでアプリアイコン（PNG）を作る。背景はテラコッタ、白いマイク。
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x / size, y / size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
const BG = [181, 70, 47, 255], FG = [255, 248, 236, 255], CLEAR = [0, 0, 0, 0];
function mic(u, v, scale) {
  // 中心基準に縮める
  const x = 0.5 + (u - 0.5) / scale, y = 0.5 + (v - 0.5) / scale;
  // カプセル
  const cx = 0.5, top = 0.22, bottom = 0.52, r = 0.12;
  const dy = y < top ? y - top : y > bottom ? y - bottom : 0;
  if (Math.hypot(x - cx, dy) <= r) return true;
  // U字のホルダー
  const ur = 0.2, uy = 0.5, d = Math.hypot(x - cx, y - uy);
  if (y >= uy && d <= ur && d >= ur - 0.04) return true;
  // 支柱と台
  if (Math.abs(x - cx) <= 0.02 && y >= 0.7 && y <= 0.8) return true;
  if (Math.abs(x - cx) <= 0.14 && y >= 0.78 && y <= 0.82) return true;
  return false;
}
function rounded(u, v, rad) {
  const dx = Math.max(rad - u, 0, u - (1 - rad)), dy = Math.max(rad - v, 0, v - (1 - rad));
  return Math.hypot(dx, dy) <= rad;
}
const out = 'public/';
writeFileSync(out + 'icon-192.png', png(192, (u, v) => (rounded(u, v, 0.18) ? (mic(u, v, 1) ? FG : BG) : CLEAR)));
writeFileSync(out + 'icon-512.png', png(512, (u, v) => (rounded(u, v, 0.18) ? (mic(u, v, 1) ? FG : BG) : CLEAR)));
writeFileSync(out + 'icon-512-maskable.png', png(512, (u, v) => (mic(u, v, 0.72) ? FG : BG)));
console.log('icons written');
