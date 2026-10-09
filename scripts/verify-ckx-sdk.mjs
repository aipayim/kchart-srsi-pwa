#!/usr/bin/env node
/**
 * vendored CKX SDK 完整性校验（阶段 0）
 *
 * 目的：确保 `src/vendor/ckx/` 下的第三方 SDK **逐字节**来自
 *   https://cryptokey.im/ckx/sdk/ckx-sdk-latest.zip
 * 任何篡改（供应链攻击 / 误编辑 / 版本漂移）都会使 sha384 失配 → 非零退出。
 *
 * 用法：
 *   node scripts/verify-ckx-sdk.mjs                 # 对硬编码的 MANIFEST 值校验（离线、确定性）
 *   node scripts/verify-ckx-sdk.mjs --manifest <f>  # 对本地 MANIFEST.json 校验
 *   node scripts/verify-ckx-sdk.mjs --json          # 机器可读输出
 *
 * 期望值来源：https://cryptokey.im/ckx/sdk/MANIFEST.json
 *   generatedAt: 2026-10-04T23:26:46.080Z
 *   package @cryptokey/ckx v0.3.0, formatVersion 1, license Apache-2.0
 */
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const VENDOR_DIR = join(REPO, 'src', 'vendor', 'ckx');

// MANIFEST.json 中的固定期望值（来源见文件头）。请勿手改，除非同步升级 SDK。
export const EXPECTED = {
  package: '@cryptokey/ckx',
  version: '0.3.0',
  formatVersion: '1',
  generatedAt: '2026-10-04T23:26:46.080Z',
  files: {
    'ckx.esm.js': {
      bytes: 23862,
      sha384: 'sha384-xaI7CqZ0AokQ5FJgll3MCFYbW9zGGSuA6Vq88YVI1y3LxHAfRgR4KWARCUbUMgVV',
    },
    'ckx.d.ts': {
      bytes: 12700,
      sha384: 'sha384-2cwgYdijBHHs03Gzfj8jlXhBR5EE8OTNy6sNjJAsat3qpbREQbOnJC2lJAzzxkKz',
    },
    LICENSE: {
      bytes: 11347,
      sha384: 'sha384-GM/3Jrs/y6+jGEosIuuAA1h6oD7Y9C3DghiynB5tWJofjn4Y6qvz9QFSh0PzRZBv',
    },
  },
};

function sha384(buf) {
  return 'sha384-' + createHash('sha384').update(buf).digest('base64');
}

/** 从 MANIFEST.json 文本解析出 { files: {name:{bytes,sha384}} } */
export function parseManifest(text) {
  const m = JSON.parse(text);
  const out = { package: m.name, version: m.version, formatVersion: String(m.formatVersion), generatedAt: m.generatedAt, files: {} };
  for (const f of m.files || []) {
    if (f && f.name) out.files[f.name] = { bytes: f.bytes, sha384: f.sha384 };
  }
  return out;
}

/**
 * 校验 vendored 文件。
 * @param {object} opts
 * @param {string} [opts.dir]      vendor 目录（默认 src/vendor/ckx）
 * @param {object} [opts.expected] 期望值（默认硬编码 EXPECTED）
 * @returns {{ok:boolean, results:Array}}
 */
export function verifyCkxSdk(opts = {}) {
  const dir = opts.dir || VENDOR_DIR;
  const expected = opts.expected || EXPECTED;
  const results = [];
  for (const [name, exp] of Object.entries(expected.files)) {
    const path = join(dir, name);
    const entry = { name, path, expected: exp, ok: false, exists: false, actualBytes: null, actualSha384: null, errors: [] };
    if (!existsSync(path)) {
      entry.errors.push('missing file');
      results.push(entry);
      continue;
    }
    entry.exists = true;
    const buf = readFileSync(path);
    entry.actualBytes = buf.length;
    entry.actualSha384 = sha384(buf);
    if (entry.actualBytes !== exp.bytes) entry.errors.push(`bytes ${entry.actualBytes} != ${exp.bytes}`);
    if (entry.actualSha384 !== exp.sha384) entry.errors.push(`sha384 ${entry.actualSha384} != ${exp.sha384}`);
    entry.ok = entry.errors.length === 0;
    results.push(entry);
  }
  return { ok: results.every((r) => r.ok), results, expected };
}

// ---------------------------------------------------------------- CLI
function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const mi = argv.indexOf('--manifest');
  let expected = EXPECTED;
  let manifestNote = '(hardcoded MANIFEST values)';
  if (mi >= 0 && argv[mi + 1]) {
    const text = readFileSync(argv[mi + 1], 'utf8');
    const parsed = parseManifest(text);
    // 只保留 vendor 目录里实际存在的文件名的期望值
    const files = {};
    for (const name of Object.keys(EXPECTED.files)) {
      if (parsed.files[name]) files[name] = parsed.files[name];
    }
    expected = { ...parsed, files };
    manifestNote = argv[mi + 1];
  }

  const r = verifyCkxSdk({ expected });
  if (json) {
    process.stdout.write(JSON.stringify({ ok: r.ok, manifestNote, expected: { version: r.expected.version, generatedAt: r.expected.generatedAt }, results: r.results }, null, 2) + '\n');
  } else {
    process.stdout.write(`CKX SDK vendoring check — ${r.expected.package || EXPECTED.package} v${r.expected.version} (manifest: ${manifestNote})\n`);
    for (const e of r.results) {
      const mark = e.ok ? 'OK  ' : 'FAIL';
      process.stdout.write(`  [${mark}] ${e.name.padEnd(12)} ${String(e.actualBytes ?? '-').padStart(6)} B  ${e.actualSha384 || '-'}\n`);
      for (const err of e.errors) process.stdout.write(`         ↳ ${err}\n`);
    }
    process.stdout.write(r.ok ? '\n✅ 全部一致：vendored SDK 未被修改。\n' : '\n❌ 校验失败：vendored SDK 与 MANIFEST 不符，请重新下载并替换。\n');
  }
  process.exit(r.ok ? 0 : 1);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === (process.argv[1].startsWith('/') ? process.argv[1] : join(process.cwd(), process.argv[1]));
if (isMain) main();
