/**
 * CKX SDK 0.4.0 回归：A 组 P0 反馈落地后的行为校验
 *
 * 覆盖官方 0.4.0 变更通知中的四组：
 *  ③ `decryptFromVideo(video, pw, options?)` 与 `decrypt` 对齐（支持 `options.schema`）
 *  ④ 错误语义细分 + 结构化字段：
 *     - 非 CKX 载体 → `CKX_NO_CARRIER`
 *     - 载体结构损坏（解密前判定）→ `CKX_CARRIER_DAMAGED`
 *     - 密码错（GCM 认证失败）→ `CKX_WRONG_PASSWORD`（不做密码/篡改 oracle 细分）
 *     - 新增 `messageKey`（`ckx.err.*`）/ `retryable` / **`detail` 由 string 变结构化对象**
 *  ② `GET /v1/ckx/embed/policy?origin=` **只回该 origin**（不再含全量 `origins`）；全量走 `/v1/ckx/integrators`
 *  ① `mode=image` 可传载体：`ckx:encrypt` 的 `carrier` 直通（embed 侧由浏览器 E2E 覆盖）+ SDK 侧自选载体往返
 *
 * 期望值均由本机实测锁定（见 commit message / AGENTS §5.74.2）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { buildEncryptMessage, fetchEmbedPolicy, fetchIntegrators, CKX_EMBED_ORIGIN } from '../src/persistence/ckxEmbed.js';
import { importVault, exportVaultBytes, collectVault } from '../src/persistence/ckxVault.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CKX = await import('../src/vendor/ckx/ckx.esm.js');

let fails = 0;
const check = (name, cond, extra) => { if (!cond) { fails++; console.error('FAIL:', name, extra == null ? '' : extra); } else console.log('ok:', name); };
const caught = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const PW = 'pw-040-strong';
const meta = { app: 'https://x.test', schema: 'srsi.vault.v1', schemaVersion: '1' };
const base = await CKX.encryptToFile('{"a":1}', PW, meta);

// ---------------------------------------------------------------- 0) 版本与结构
{
  check('V1 SDK 已是 0.4.0（新导出 CKX_MESSAGE_KEYS）', typeof CKX.CKX_MESSAGE_KEYS === 'object' && !!CKX.CKX_MESSAGE_KEYS.CKX_WRONG_PASSWORD);
  check('V2 CKX_ITERATIONS 仍 600000', CKX.CKX_ITERATIONS === 600000);
  const dts = readFileSync(join(__dirname, '..', 'src', 'vendor', 'ckx', 'ckx.d.ts'), 'utf8');
  check('V3 d.ts 声明 detail 为结构化接口', /interface CkxErrorDetail/.test(dts) && /detail: CkxErrorDetail \| undefined/.test(dts));
  check('V4 d.ts 声明 messageKey/retryable', /messageKey: string/.test(dts) && /retryable: boolean/.test(dts));
}

// ---------------------------------------------------------------- 1) ④ 错误语义细分 + 结构化字段
{
  const e1 = await caught(() => CKX.decrypt('not-a-ckx-carrier', PW));
  check('E1 非载体 → CKX_NO_CARRIER', e1 && e1.code === 'CKX_NO_CARRIER', e1 && e1.code);

  const e2 = await caught(() => CKX.decrypt(base.slice(0, Math.floor(base.length / 2)), PW));
  check('E2 结构损坏（截断）→ CKX_CARRIER_DAMAGED（不再是 WRONG_PASSWORD）', e2 && e2.code === 'CKX_CARRIER_DAMAGED', e2 && e2.code);

  const flipped = base.slice(); flipped[flipped.length - 5] ^= 0xff;   // 只坏密文 → GCM 认证失败
  const e3 = await caught(() => CKX.decrypt(flipped, PW));
  check('E3 密文被篡改 → CKX_WRONG_PASSWORD（不细分，防 oracle）', e3 && e3.code === 'CKX_WRONG_PASSWORD', e3 && e3.code);

  const e4 = await caught(() => CKX.decrypt(base, 'definitely-wrong'));
  check('E4 密码错 → CKX_WRONG_PASSWORD', e4 && e4.code === 'CKX_WRONG_PASSWORD');

  const e5 = await caught(() => CKX.encryptToFile('x', PW, { app: 'https://x.test', label: 'L'.repeat(5000) }));
  check('E5 meta 超长 → CKX_PAYLOAD_TOO_LARGE', e5 && e5.code === 'CKX_PAYLOAD_TOO_LARGE', e5 && e5.code);

  // 结构化字段（破坏性变更的回归核心）
  for (const [label, e] of [['E1', e1], ['E2', e2], ['E3', e3], ['E4', e4], ['E5', e5]]) {
    check(`${label} messageKey 为 ckx.err.* 稳定键`, !!e && typeof e.messageKey === 'string' && e.messageKey.startsWith('ckx.err.'), e && e.messageKey);
    check(`${label} retryable 为 boolean`, !!e && typeof e.retryable === 'boolean', e && String(e.retryable));
    check(`${label} detail 是**结构化对象**（0.3.0 为 string → 破坏性变更）`, !!e && e.detail && typeof e.detail === 'object' && !Array.isArray(e.detail), e && typeof e.detail);
  }
  check('E5 detail 带 limit/actual 字节数', e5.detail.limit === 4096 && Number(e5.detail.actual) > 4096, JSON.stringify(e5.detail));
  check('E5 detail.field = meta', e5.detail.field === 'meta', e5.detail.field);
  check('E2 detail 可定位到结构字段', typeof e2.detail.field === 'string' && !!e2.detail.hint, JSON.stringify(e2.detail));
  check('E3/E4 hint 说明可用于 UX 提示', typeof e4.detail.hint === 'string' && e4.detail.hint.length > 0, e4.detail.hint);
  check('CKX_MESSAGE_KEYS 与实抛 messageKey 一致', CKX.CKX_MESSAGE_KEYS.CKX_WRONG_PASSWORD === e4.messageKey && CKX.CKX_MESSAGE_KEYS.CKX_CARRIER_DAMAGED === e2.messageKey);
  const e6 = await caught(() => CKX.encryptToFile('x', '', { app: 'https://x.test' }));
  check('E6 空密码 → CKX_PASSWORD_REQUIRED', e6 && e6.code === 'CKX_PASSWORD_REQUIRED');
  const e7 = await caught(() => { const c = base.slice(); c[4] = 9; return CKX.decrypt(c, PW); });
  check('E7 容器版本不支持 → CKX_UNSUPPORTED_FORMAT_VERSION', e7 && e7.code === 'CKX_UNSUPPORTED_FORMAT_VERSION');
}

// ---------------------------------------------------------------- 2) ③ decryptFromVideo schema 门禁
{
  const video = new Uint8Array([0, 0, 0, 0, 1, 2, 3, 4, 5, 6]);
  const v = await CKX.encryptToVideo('vid-payload', PW, { app: 'https://x.test', schema: 'srsi.vault.v1', schemaVersion: '1' }, video);
  const ok = await CKX.decryptFromVideo(v, PW, { schema: 'srsi.vault.v1' });
  check('D1 video 正确 schema → 可解', ok.text === 'vid-payload', ok.text);
  const bad = await caught(() => CKX.decryptFromVideo(v, PW, { schema: 'other.v9' }));
  check('D2 video schema 不符 → CKX_SCHEMA_MISMATCH', bad && bad.code === 'CKX_SCHEMA_MISMATCH', bad && bad.code);
  const noOpt = await CKX.decryptFromVideo(v, PW);
  check('D3 不传 options 仍可解（向后兼容）', noOpt.text === 'vid-payload');
}

// ---------------------------------------------------------------- 3) ② policy 最小化 + integrators
{
  const seen = [];
  const fakeFetch = (url) => { seen.push(String(url)); return Promise.resolve({ ok: true, json: async () => (String(url).includes('integrators') ? { ok: true, origins: ['https://a.test', 'https://srsi.openapi.im'], slaByOrigin: {} } : { ok: true, v: 1, origin: 'https://srsi.openapi.im', allowed: true, sla: null, freeFeatures: ['text', 'image', 'file', 'video'], proFeatures: ['schema'] }) }); };
  const p = await fetchEmbedPolicy('https://srsi.openapi.im', { fetch: fakeFetch });
  check('P1 policy 归一化只含必要字段 + sla', p.allowed === true && p.sla === null && Array.isArray(p.freeFeatures) && 'raw' in p);
  check('P2 policy 归一化对象**不含 origins**（0.4.0 起由 integrators 提供）', !('origins' in p));
  const pLegacy = await fetchEmbedPolicy('https://x.test', { fetch: () => Promise.resolve({ ok: true, json: async () => ({ ok: true, allowed: false, origins: ['https://x.test'] }) }) });
  check('P3 兼容 0.3.x 旧响应（不崩、不暴露 origins）', pLegacy.allowed === false && !('origins' in pLegacy));
  const it = await fetchIntegrators({ fetch: fakeFetch });
  check('P4 integrators 返回全量名单', it.origins.length === 2 && it.origins.includes('https://srsi.openapi.im'));
  check('P5 两个端点都被请求过', seen.some((u) => u.includes('/v1/ckx/embed/policy')) && seen.some((u) => u.includes('/v1/ckx/integrators')));

  // 真实端点（网络可用才断言；不可用则跳过）
  let livePol = null;
  try { livePol = await fetchEmbedPolicy('https://srsi.openapi.im'); } catch (e) { livePol = { err: (e && (e.code || e.message)) || 'err' }; }
  if (livePol && !livePol.err && livePol.allowed) {
    check('P6【live】srsi.openapi.im 仍在白名单且归一化后不含 origins', !('origins' in livePol) && livePol.sla === null, JSON.stringify({ allowed: livePol.allowed, sla: livePol.sla }));
    let it2 = null;
    try { it2 = await fetchIntegrators(); } catch (e) { it2 = { err: (e && (e.code || e.message)) || 'err' }; }
    check('P7【live】/v1/ckx/integrators 含本域', !!(it2 && !it2.err && it2.origins.includes('https://srsi.openapi.im')), it2 && JSON.stringify(it2.origins || it2.err));
  } else {
    console.log('ok: P6/P7【live】跳过（网络不可达）', livePol && livePol.err);
  }
}

// ---------------------------------------------------------------- 4) ① image 载体（SDK 侧）+ carrier 直通
{
  // 32x32 自有载图
  const W = 32, H = 32;
  const carrier = { data: new Uint8ClampedArray(W * H * 4), width: W, height: H };
  for (let i = 0; i < W * H; i++) { carrier.data[i * 4] = 12; carrier.data[i * 4 + 1] = 34; carrier.data[i * 4 + 2] = 56; carrier.data[i * 4 + 3] = 255; }
  const payload = 'img-payload-中文✓';
  const out = await CKX.encryptToImage(payload, PW, { app: 'https://x.test', schema: 'srsi.vault.v1', schemaVersion: '1' }, carrier);
  check('I1 encryptToImage 返回新载体且尺寸不变', out.width === W && out.height === H && out.data.length === carrier.data.length);
  check('I2 使用的确是自有载体（像素被写入，非演示图）', Buffer.compare(Buffer.from(out.data), Buffer.from(carrier.data)) !== 0);
  const back = await CKX.decrypt(out, PW);
  check('I3 自有载图可解回原文', back.text === payload, back.text);
  const metaRead = CKX.readMeta(out);
  check('I4 免密码 readMeta 可读 schemaId', metaRead && metaRead.schemaId === 'srsi.vault.v1');

  // ckx:encrypt 的 carrier 字段直通（embed 侧协议）
  const msg = buildEncryptMessage('N1', new ArrayBuffer(4), { label: 'x' }, new ArrayBuffer(8));
  check('I5 buildEncryptMessage 带 carrier', msg.type === 'ckx:encrypt' && msg.carrier instanceof ArrayBuffer && msg.carrier.byteLength === 8);
  const msgNo = buildEncryptMessage('N1', 'p');
  check('I6 不传 carrier 时不产生该字段', msgNo.carrier === undefined);
}

// ---------------------------------------------------------------- 5) 集成层：损坏载体从 importVault 透出
{
  const vault = await collectVault({}, { ls: { keys: () => ['smartTrader'], get: () => 'x', set() {}, remove() {} }, idb: null });
  const bytes = await exportVaultBytes(vault, PW);
  const eDmg = await caught(() => importVault(bytes.slice(0, Math.floor(bytes.length / 2)), PW));
  check('G1 importVault 透出 CKX_CARRIER_DAMAGED', eDmg && eDmg.code === 'CKX_CARRIER_DAMAGED', eDmg && eDmg.code);
  const ePw = await caught(() => importVault(bytes, 'nope'));
  check('G2 importVault 透出 CKX_WRONG_PASSWORD', ePw && ePw.code === 'CKX_WRONG_PASSWORD');
  const ok = await importVault(bytes, PW);
  check('G3 正常路径仍可解', ok.vault.schema === 'srsi.vault.v1');
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
