// 生成 PWA 图标（192/512 PNG），纯 zlib，无第三方依赖
// 用法: node scripts/gen-icon.mjs
import zlib from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const CRC_TABLE = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function makePng(size) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let p = 0;
  const cx = size / 2, cy = size / 2;
  const R = size * 0.30;      // 外圈
  const r = size * 0.17;      // 内圈
  for (let y = 0; y < size; y++) {
    raw[p++] = 0; // filter none
    for (let x = 0; x < size; x++) {
      const dx = x - cx, dy = y - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      let col;
      if (d <= r) col = [10, 14, 23];                       // 内圈深底
      else if (d <= R) col = [0, 230, 118];                 // 外圈绿（accent）
      else col = [10, 14, 23];                              // 背景深
      raw[p++] = col[0]; raw[p++] = col[1]; raw[p++] = col[2]; raw[p++] = 255;
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

mkdirSync('public', { recursive: true });
writeFileSync('public/pwa-192.png', makePng(192));
writeFileSync('public/pwa-512.png', makePng(512));
writeFileSync('public/favicon.png', makePng(192));
console.log('PWA 图标已生成: public/pwa-192.png, public/pwa-512.png, public/favicon.png');
