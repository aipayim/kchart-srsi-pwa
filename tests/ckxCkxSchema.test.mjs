/**
 * CKX 官方协议 JSON Schema（draft 2020-12，fixture 逐字段落盘）校验：用 ajv 断言**我们发出的**
 * postMessage 对象符合官方 `$defs`，并反向证明校验不是空跑（删必需字段必须失败）。
 *
 * Schema 来源：https://cryptokey.im/ckx/spec/protocol-v1.schema.json
 *   fixture：`tests/fixtures/ckx-protocol-v1.schema.json`（仅额外加了一行 `_source`，未改 `$id`/`$schema`/`$defs`）。
 */
import Ajv2020 from 'ajv/dist/2020.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  buildInitMessage, buildEncryptMessage, buildDecryptMessage, buildCancelMessage, buildEstimateMessage,
} from '../src/persistence/ckxEmbed.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'ckx-protocol-v1.schema.json'), 'utf8'));

let fails = 0;
const check = (name, cond, extra) => { if (!cond) { fails++; console.error('FAIL:', name, extra == null ? '' : extra); } else console.log('ok:', name); };

// ---------------------------------------------------------------- 0) schema 完整性 + ajv 装载
check('S0 fixture 保留官方 $id', schema.$id === 'https://cryptokey.im/ckx/spec/protocol-v1.schema.json');
check('S0b fixture 为 draft 2020-12', schema.$schema === 'https://json-schema.org/draft/2020-12/schema');
check('S0c fixture 注明来源', typeof schema._source === 'string' && schema._source.includes('cryptokey.im'));

const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema(schema);
const V = (def) => ajv.getSchema(schema.$id + '#/$defs/' + def);
check('S0d 四个 host→embed def 可装载', ['CkxInit', 'CkxEncrypt', 'CkxDecrypt', 'CkxCancel', 'CkxEstimate'].every((d) => typeof V(d) === 'function'));
check('S0e embed→host def 可装载', ['CkxReady', 'CkxCapabilities', 'CkxResult', 'CkxPlaintext', 'CkxError', 'CkxEstimateResult', 'CkxResize', 'CkxIdleWarning'].every((d) => typeof V(d) === 'function'));

const ok = (def, msg, label) => { const v = V(def); const res = v(msg); check(label, res === true, res ? '' : JSON.stringify(v.errors)); };
const bad = (def, msg, label) => { const v = V(def); const res = v(msg); check(label, res === false, '预期失败但通过了'); };

// ---------------------------------------------------------------- 1) host → embed（我们实际发出的消息）
ok('CkxInit', buildInitMessage('nonce-abc', { app: 'https://srsi.openapi.im', mode: 'file' }), 'S1 ckx:init（无 schema/timeout）通过');
ok('CkxInit', buildInitMessage('nonce-abc', { app: 'https://srsi.openapi.im', schema: 'srsi.vault.v1', schemaVersion: 1, label: 'L', locale: 'zh-CN', theme: 'dark' }), 'S2 ckx:init（含 schema）通过');
{
  // timeout 属可选 integer≥0；实现透传时也必须合法
  const withT = buildInitMessage('nonce-abc', { app: 'https://srsi.openapi.im', timeout: 300 });
  ok('CkxInit', withT, 'S3 ckx:init（带 timeout 选项）通过');
  check('S3b timeout 透传时须为 integer≥0（当前实现若省略也合法）', withT.timeout === undefined || (Number.isInteger(withT.timeout) && withT.timeout >= 0), String(withT.timeout));
}
ok('CkxEncrypt', buildEncryptMessage('nonce-abc', 'payload-text', { app: 'https://srsi.openapi.im' }), 'S4 ckx:encrypt（无 carrier）通过');
ok('CkxEncrypt', buildEncryptMessage('nonce-abc', new ArrayBuffer(8), { app: 'https://srsi.openapi.im' }, new ArrayBuffer(64)), 'S5 ckx:encrypt（含 carrier，image 模式）通过');
ok('CkxDecrypt', buildDecryptMessage('nonce-abc', 'carrier-text', 'vault.ckx'), 'S6 ckx:decrypt 通过');
ok('CkxCancel', buildCancelMessage('nonce-abc'), 'S7 ckx:cancel 通过');
ok('CkxEstimate', buildEstimateMessage('nonce-abc', 'payload-text'), 'S8 ckx:estimate（无 meta/carrier）通过');
ok('CkxEstimate', buildEstimateMessage('nonce-abc', new ArrayBuffer(8), { app: 'https://srsi.openapi.im' }, new ArrayBuffer(64)), 'S9 ckx:estimate（含 meta/carrier）通过');

// 反向：删必需字段必须失败（证明 ajv 真在校验，不是空跑）
{
  const mi = buildInitMessage('n', { app: 'https://x.test' }); delete mi.app;
  bad('CkxInit', mi, 'S10 ckx:init 缺 app → 失败');
  const me = buildEncryptMessage('n', 'p'); delete me.nonce;
  bad('CkxEncrypt', me, 'S11 ckx:encrypt 缺 nonce → 失败');
  const md = buildDecryptMessage('n', 'c'); delete md.nonce;
  bad('CkxDecrypt', md, 'S12 ckx:decrypt 缺 nonce → 失败');
  const mc = buildCancelMessage('n'); delete mc.nonce;
  bad('CkxCancel', mc, 'S13 ckx:cancel 缺 nonce → 失败');
  const ms = buildEstimateMessage('n', 'p'); delete ms.payload;
  bad('CkxEstimate', ms, 'S14 ckx:estimate 缺 payload → 失败');
  // 错误常量值
  bad('CkxInit', Object.assign(buildInitMessage('n', { app: 'https://x.test' }), { v: 2 }), 'S15 ckx:init v=2 → 失败');
  bad('CkxCancel', Object.assign(buildCancelMessage('n'), { type: 'ckx:init' }), 'S16 ckx:cancel type 错 → 失败');
}

// ---------------------------------------------------------------- 2) embed → host（客户端消费的消息形状）
ok('CkxReady', { v: 1, formatVersion: '1', type: 'ckx:ready', nonce: 'n', capabilities: ['text', 'image', 'file', 'video'], pro: false }, 'S20 ckx:ready 通过');
ok('CkxCapabilities', { v: 1, formatVersion: '1', type: 'ckx:capabilities', nonce: 'n', capabilities: [], pro: false, granted: [], schemas: ['srsi.vault.v1'], source: 'none', expiresAt: null, sdkVersion: '0.4.0', idleTimeoutSec: 120, ignored: ['schema'] }, 'S21 ckx:capabilities（0.4.0 扩展字段）通过');
ok('CkxResult', { v: 1, formatVersion: '1', type: 'ckx:result', nonce: 'n', kind: 'carrier', file: { name: 'v.ckx', mime: 'application/octet-stream', bytes: new ArrayBuffer(4) }, meta: {} }, 'S22 ckx:result 通过');
ok('CkxPlaintext', { v: 1, formatVersion: '1', type: 'ckx:plaintext', nonce: 'n', text: 'hi', meta: {} }, 'S23 ckx:plaintext 通过');
ok('CkxError', { v: 1, formatVersion: '1', type: 'ckx:error', nonce: 'n', code: 'CKX_PAYLOAD_TOO_LARGE', message: 'too big', messageKey: 'ckx.err.payload.too.large', retryable: false, detail: { field: 'meta', limit: 4096, actual: 5000 } }, 'S24 ckx:error（结构化 detail）通过');
ok('CkxEstimateResult', { v: 1, formatVersion: '1', type: 'ckx:estimate.result', nonce: 'n', mode: 'image', medium: 'B', binary: true, payloadBytes: 1000, containerBytes: 1057, requiredBytes: 1000, availableBytes: 64, fits: false, detail: { limit: 64, actual: 1000 } }, 'S25 ckx:estimate.result（fits=false + detail）通过');
ok('CkxResize', { v: 1, formatVersion: '1', type: 'ckx:resize', nonce: 'n', height: 640 }, 'S26 ckx:resize 通过');
ok('CkxIdleWarning', { v: 1, formatVersion: '1', type: 'ckx:idle-warning', nonce: 'n', remainingMs: 15000 }, 'S27 ckx:idle-warning 通过');
{
  const r = { v: 1, formatVersion: '1', type: 'ckx:resize', nonce: 'n' }; delete r.height;
  bad('CkxResize', r, 'S28 ckx:resize 缺 height → 失败');
  const c = { v: 1, formatVersion: '1', type: 'ckx:capabilities', nonce: 'n', capabilities: [], pro: false }; delete c.granted;
  bad('CkxCapabilities', c, 'S29 ckx:capabilities 缺 granted → 失败');
  const e = { v: 1, formatVersion: '1', type: 'ckx:estimate.result', nonce: 'n' }; delete e.fits;
  bad('CkxEstimateResult', e, 'S30 ckx:estimate.result 缺 fits → 失败');
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
