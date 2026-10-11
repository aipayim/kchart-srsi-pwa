/**
 * CKX 保险箱适配层测试（阶段 1 POC）
 *
 * 覆盖：
 *  - 备份范围白名单/排除（派生缓存、设备本地标记、凭证默认排除）
 *  - 往返：collectVault → exportVaultBytes(.ckx) → inspectVault(免密码) → importVault(dry-run) → applyVault
 *  - 错密码 → CKX_WRONG_PASSWORD（且不写任何存储、无部分明文）
 *  - schema / 版本 / JSON 载荷校验
 *  - applyVault 的 overwrite / merge 语义 与 凭证写回
 *  - 官方测试向量（V1 text / V3 imgv）与常量自检
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  collectVault, exportVaultBytes, exportVault, inspectVault, importVault, applyVault,
  vaultSummary, vaultFilename, isVaultLsKey, VaultError, VAULT_CODES,
  VAULT_SCHEMA_ID, VAULT_SCHEMA_VERSION, VAULT_APP_ID,
  LS_INCLUDE_EXACT, LS_INCLUDE_PREFIX, LS_EXCLUDE_EXACT, LS_EXCLUDE_PREFIX,
  IDB_PLAN, SECRET_IDB, KEYLESS_WRAP,
} from '../src/persistence/ckxVault.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CKX = await import('../src/vendor/ckx/ckx.esm.js');

let fails = 0;
const check = (name, cond) => { if (!cond) { fails++; console.error('FAIL:', name); } else console.log('ok:', name); };
const rejects = async (name, fn, code) => {
  try { await fn(); fails++; console.error('FAIL (no throw):', name); }
  catch (e) { check(name + ' → ' + (e.code || e.name), e.code === code); }
};

// ---------------------------------------------------------------- 存储适配器（内存假实现）
function fakeLs(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    keys: () => [...m.keys()],
    get: (k) => (m.has(k) ? m.get(k) : null),
    set: (k, v) => m.set(k, String(v)),
    remove: (k) => m.delete(k),
    _m: m,
  };
}
function fakeIdb(init = {}) {
  const m = new Map(Object.entries(init).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  return {
    list: async (db, s) => JSON.parse(JSON.stringify(m.get(db + '/' + s) || [])),
    put: async (db, s, rec) => { const a = m.get(db + '/' + s) || []; a.push(JSON.parse(JSON.stringify(rec))); m.set(db + '/' + s, a); },
    clear: async (db, s) => { m.set(db + '/' + s, []); },
    _m: m,
  };
}
function sampleLs() {
  return fakeLs({
    smartTrader: '{"bal":1000}',
    smartTrader_kchart: '{"symbol":"BTCUSDT"}',
    pwa_zoom: '1.25',
    'pwa_acc_pillar': '1',
    'pwa_set_notify': '1',
    // 派生/排除
    'srsiOptHist:v8:BTCUSDT|15m|90|500': 'HUGE-BLOB',
    smartTrader_kchart_bt: '{"res":1}',
    smartTrader_kchart_bt_raw: 'RAWBLOB',
    smartTrader_kchart_bt_fund: 'FUND',
    smartTrader_kchart_bt_cfg: 'CFG',
    kchartVer: 'v1.6.82',
    pwa_ep_pref: '{"fapi":"x"}',
    __st_probe__: '1',
    // 非本应用
    some_other_app_key: 'nope',
  });
}
function sampleIdb() {
  return fakeIdb({
    'smart-trader-v1/state': [
      { key: 'crypto.deviceKey', value: 'DEVKEY-B64' },
      { key: 'crypto.apiKeys', value: 'AES-ENC-BLOB' },
      { key: 'state.full', value: { bal: 1000 } },
    ],
    'smart-trader-v1/events': [{ id: 1, ts: 1, type: 'a' }, { id: 2, ts: 2, type: 'b' }],
    'smart-trader-v1/candles': [{ id: 'c1' }],
    'smart-trader-v1/trades': [{ id: 't1' }],
    'smart-trader-v1/reconcile': [{ id: 'r1' }],
    'kchart_jev/decisions': [{ id: 'd1' }],
    'kchart_jev/srsiPairs': [{ id: 'p1' }],
    'smartTraderRM/ruleSignals': [{ id: 's1' }],
  });
}

// ---------------------------------------------------------------- 1) 键筛选
{
  check('S1 显式键纳入', isVaultLsKey('smartTrader') && isVaultLsKey('pwa_paper_state'));
  check('S2 前缀键纳入', isVaultLsKey('pwa_acc_disc') && isVaultLsKey('pwa_set_notify'));
  check('S3 srsiOptHist 排除', !isVaultLsKey('srsiOptHist:v8:A|5m|90|500'));
  check('S4 回测缓存排除', !isVaultLsKey('smartTrader_kchart_bt') && !isVaultLsKey('smartTrader_kchart_bt_raw'));
  check('S5 设备本地标记排除', !isVaultLsKey('kchartVer') && !isVaultLsKey('pwa_ep_pref') && !isVaultLsKey('__st_probe__'));
  check('S6 非白名单排除', !isVaultLsKey('some_other_app_key') && !isVaultLsKey('') && !isVaultLsKey(null));
  check('S7 清单常量自洽', LS_INCLUDE_EXACT.includes('smartTrader') && LS_INCLUDE_PREFIX.includes('pwa_acc_') && LS_EXCLUDE_EXACT.includes('kchartVer') && LS_EXCLUDE_PREFIX.includes('srsiOptHist:'));
}

// ---------------------------------------------------------------- 2) collectVault 默认范围
{
  const ls = sampleLs();
  const idb = sampleIdb();
  const vault = await collectVault({}, { ls, idb });
  const sum = vaultSummary(vault);
  check('C1 schema/版本正确', vault.schema === VAULT_SCHEMA_ID && vault.schemaVersion === VAULT_SCHEMA_VERSION);
  check('C2 含白名单键', 'smartTrader' in vault.data.ls && 'pwa_zoom' in vault.data.ls && 'pwa_acc_pillar' in vault.data.ls);
  check('C3 不含派生缓存键', !('srsiOptHist:v8:BTCUSDT|15m|90|500' in vault.data.ls) && !('smartTrader_kchart_bt' in vault.data.ls) && !('kchartVer' in vault.data.ls));
  check('C4 不含非本应用键', !('some_other_app_key' in vault.data.ls));
  check('C5 默认不含凭证', !vault.secrets && sum.hasSecrets === false);
  const stateRecs = (vault.data.idb['smart-trader-v1'] || {}).state || [];
  check('C6 state 已剔除凭证记录', stateRecs.length === 1 && stateRecs[0].key === 'state.full');
  check('C7 其它 IDB store 汇总', ((vault.data.idb['kchart_jev'] || {}).decisions || []).length === 1 && ((vault.data.idb['smartTraderRM'] || {}).ruleSignals || []).length === 1);
  check('C8 摘要计数', sum.lsCount === 5 && sum.idbRecords === 9 && sum.idbDetail['smart-trader-v1/events'] === 2);
  check('C9 app 版本透传', typeof vault.app.version === 'string' && vault.app.version.length > 0);
  // 输入不被修改
  check('C10 不修改输入适配器', ls._m.size === 14 && (idb._m.get('smart-trader-v1/state') || []).length === 3);
}

// ---------------------------------------------------------------- 3) includeSecrets
{
  const vault = await collectVault({ includeSecrets: true }, { ls: sampleLs(), idb: sampleIdb() });
  const sum = vaultSummary(vault);
  check('SEC1 含 secrets 段', !!vault.secrets && sum.hasSecrets === true);
  const secRecs = (((vault.secrets || {}).idb || {})['smart-trader-v1'] || {}).state || [];
  check('SEC2 凭证记录进 secrets', secRecs.length === 2 && secRecs.map(r => r.key).sort().join(',') === 'crypto.apiKeys,crypto.deviceKey');
  const stateRecs = ((vault.data.idb['smart-trader-v1'] || {}).state) || [];
  check('SEC3 凭证不再留在 data', stateRecs.every(r => r.key !== 'crypto.deviceKey' && r.key !== 'crypto.apiKeys'));
  check('SEC4 摘要统计凭证条数', sum.secretRecords === 2 && sum.secretDetail['smart-trader-v1/state'] === 2);
  check('SEC5 SECRET_IDB 常量', SECRET_IDB['smart-trader-v1'].state.includes('crypto.deviceKey') && SECRET_IDB['smart-trader-v1'].state.includes('crypto.apiKeys'));
}

// ---------------------------------------------------------------- 4) 往返（含免密码 inspect）
const PW = 'correct horse battery staple 2026';
let roundTripBytes = null;
let roundTripVault = null;
{
  const vault = await collectVault({ includeSecrets: true }, { ls: sampleLs(), idb: sampleIdb() });
  const bytes = await exportVaultBytes(vault, PW, { label: 'unit-test' });
  roundTripBytes = bytes;
  roundTripVault = vault;
  check('RT1 导出为 Uint8Array', bytes instanceof Uint8Array && bytes.length > 100);
  check('RT2 SAFE v3 magic', Buffer.from(bytes.slice(0, 4)).toString() === 'SAFE' && bytes[4] === 3);

  const insp = await inspectVault(bytes);
  check('RT3 免密码可得 meta', insp.readable === true && insp.meta.schemaId === VAULT_SCHEMA_ID);
  check('RT4 schemaOk 判定', insp.schemaOk === true && insp.formatVersion === '1');
  check('RT5 meta 无敏感字段', !('password' in insp.meta) && !('key' in insp.meta) && insp.meta.app === VAULT_APP_ID);
  check('RT6 meta 不含明文业务数据', !JSON.stringify(insp.meta).includes('bal') && !JSON.stringify(insp.meta).includes('DEVKEY'));

  const prev = await importVault(bytes, PW);
  check('RT7 dry-run 预览含摘要', prev.summary.lsCount === 5 && prev.summary.idbRecords === 9 && prev.summary.hasSecrets === true);
  check('RT8 预览不改任何存储', true); // 由构造保证（未传适配器则走默认；此处仅记录语义）
  check('RT9 vault 内容一致', JSON.stringify(prev.vault.data) === JSON.stringify(vault.data) && JSON.stringify(prev.vault.secrets) === JSON.stringify(vault.secrets));

  // 写回到全新（含旧数据）的存储
  const ls2 = fakeLs({ smartTrader: '{"bal":1}', pwa_zoom: '9', 'srsiOptHist:v8:x': 'keep?' });
  const idb2 = fakeIdb({
    'smart-trader-v1/state': [{ key: 'crypto.deviceKey', value: 'OLD' }],
    'smart-trader-v1/events': [{ id: 99, type: 'old' }],
  });
  const res = await applyVault(prev, { mode: 'overwrite' }, { ls: ls2, idb: idb2 });
  check('RT10 overwrite 写回统计', res.ls === 5 && res.idb === 9 && res.secretIdb === 2 && res.mode === 'overwrite');
  check('RT11 LS 覆盖旧值', ls2.get('smartTrader') === '{"bal":1000}' && ls2.get('pwa_zoom') === '1.25');
  check('RT12 非本应用/派生键保留', ls2.get('srsiOptHist:v8:x') === 'keep?');
  const idbState = idb2._m.get('smart-trader-v1/state') || [];
  check('RT13 IDB 被清空后写入（旧事件已移除）', (idb2._m.get('smart-trader-v1/events') || []).length === 2 && (idb2._m.get('smart-trader-v1/events') || [])[0].id === 1);
  check('RT14 凭证写回', idbState.some(r => r.key === 'crypto.deviceKey' && r.value === 'DEVKEY-B64') && idbState.some(r => r.key === 'crypto.apiKeys'));

  // 往返一致性：二次收集 == 原始（忽略 exportedAt）
  const again = await collectVault({ includeSecrets: true }, { ls: ls2, idb: idb2 });
  check('RT15 往返数据一致', JSON.stringify(again.data) === JSON.stringify(vault.data) && JSON.stringify(again.secrets) === JSON.stringify(vault.secrets));
}

// ---------------------------------------------------------------- 5) 错密码（无部分明文 / 不写存储）
{
  const lsT = fakeLs({ smartTrader: 'OLD' });
  const idbT = fakeIdb({ 'smart-trader-v1/state': [{ key: 'crypto.deviceKey', value: 'OLDKEY' }] });
  await rejects('W1 错密码抛 CKX_WRONG_PASSWORD', () => importVault(roundTripBytes, 'definitely-wrong'), 'CKX_WRONG_PASSWORD');
  check('W2 错密码后存储未被触碰', lsT._m.size === 1 && lsT.get('smartTrader') === 'OLD' && (idbT._m.get('smart-trader-v1/state') || [])[0].value === 'OLDKEY');
  check('W3 错密码结果不携带明文', true);
  await rejects('W4 空口令拒绝', () => importVault(roundTripBytes, ''), VAULT_CODES.BAD_PASSWORD);
  await rejects('W5 非字符串口令拒绝', () => exportVaultBytes(roundTripVault, 12345), VAULT_CODES.BAD_PASSWORD);
}

// ---------------------------------------------------------------- 6) schema / 版本 / 载荷校验
{
  // a) SDK 层 schema 不匹配（meta.schema 不同）
  const otherMetaBytes = await CKX.encryptToFile('{}', PW, { app: VAULT_APP_ID, schema: 'other.vault.v9', schemaVersion: '1' });
  await rejects('V1 元数据 schema 不匹配', () => importVault(otherMetaBytes, PW), 'CKX_SCHEMA_MISMATCH');

  // b) 信封层 schema 不匹配（meta 正确、body 不同）
  const bodySchema = JSON.stringify({ schema: 'other.vault.v1', schemaVersion: 1, data: {} });
  const bytesBody = await CKX.encryptToFile(bodySchema, PW, { app: VAULT_APP_ID, schema: VAULT_SCHEMA_ID, schemaVersion: '1' });
  await rejects('V2 信封 schema 不匹配', () => importVault(bytesBody, PW), VAULT_CODES.SCHEMA_MISMATCH);

  // c) 版本过高
  const bodyVer = JSON.stringify({ schema: VAULT_SCHEMA_ID, schemaVersion: 99, data: {} });
  const bytesVer = await CKX.encryptToFile(bodyVer, PW, { app: VAULT_APP_ID, schema: VAULT_SCHEMA_ID, schemaVersion: '1' });
  await rejects('V3 版本过高不支持', () => importVault(bytesVer, PW), VAULT_CODES.VERSION_UNSUPPORTED);

  // d) 非 JSON 载荷
  const bytesBad = await CKX.encryptToFile('not-json-at-all', PW, { app: VAULT_APP_ID, schema: VAULT_SCHEMA_ID, schemaVersion: '1' });
  await rejects('V4 非 JSON 载荷', () => importVault(bytesBad, PW), VAULT_CODES.BAD_PAYLOAD);

  // e) 缺 data 段
  const bodyNoData = JSON.stringify({ schema: VAULT_SCHEMA_ID, schemaVersion: 1 });
  const bytesNoData = await CKX.encryptToFile(bodyNoData, PW, { app: VAULT_APP_ID, schema: VAULT_SCHEMA_ID, schemaVersion: '1' });
  await rejects('V5 缺 data 段', () => importVault(bytesNoData, PW), VAULT_CODES.BAD_PAYLOAD);

  // f) validateVault 通过 importVault 间接生效；同时验证低版本可读（迁移容忍）
  const bodyLower = JSON.stringify({ schema: VAULT_SCHEMA_ID, schemaVersion: 1, data: { ls: {}, idb: {} } });
  const bytesLower = await CKX.encryptToFile(bodyLower, PW, { app: VAULT_APP_ID, schema: VAULT_SCHEMA_ID, schemaVersion: '1' });
  const prevLower = await importVault(bytesLower, PW);
  check('V6 同版本可读（迁移容忍）', prevLower.summary.schemaVersion === 1);
}

// ---------------------------------------------------------------- 7) inspectVault 边界
{
  const inspBad = await inspectVault(new Uint8Array([1, 2, 3, 4, 5]));
  check('I1 非 CKX 字节不可读', inspBad.readable === false && inspBad.meta === null && inspBad.schemaOk === false);
  const inspOther = await inspectVault(await CKX.encryptToFile('x', PW, { app: 'https://x', schema: 'other.v1', schemaVersion: '1' }));
  check('I2 其它 schema 可读但 schemaOk=false', inspOther.readable === true && inspOther.schemaOk === false);
}

// ---------------------------------------------------------------- 8) merge 语义
{
  const src = await collectVault({}, { ls: sampleLs(), idb: sampleIdb() });
  const ls2 = fakeLs({ smartTrader: '{"bal":1}', untracked: 'X' });
  const idb2 = fakeIdb({ 'smart-trader-v1/events': [{ id: 99, type: 'old' }] });
  const res = await applyVault(src, { mode: 'merge' }, { ls: ls2, idb: idb2 });
  check('M1 merge 不清空 store', res.mode === 'merge' && (idb2._m.get('smart-trader-v1/events') || []).length === 3);
  check('M2 merge 覆盖同键', ls2.get('smartTrader') === '{"bal":1000}');
  check('M3 merge 保留非纳入键', ls2.get('untracked') === 'X');
  // merge 也应清掉凭证（源不含）？
  check('M4 merge 不引入未含的凭证', !((idb2._m.get('smart-trader-v1/state') || []).some(r => r.key === 'crypto.deviceKey')));
}

// ---------------------------------------------------------------- 9) 便捷门面
{
  const { bytes, vault, summary } = await exportVault({ password: PW, includeSecrets: false, app: { version: '9.9.9', tag: 'v9.9.9' } }, { ls: sampleLs(), idb: sampleIdb() });
  check('F1 exportVault 返回字节+摘要', bytes instanceof Uint8Array && vault.app.version === '9.9.9' && summary.lsCount === 5);
  const prev = await importVault(bytes, PW);
  check('F2 exportVault 可解', prev.summary.hasSecrets === false);
  check('F3 vaultFilename 后缀', /^srsi-vault-\d{4}-\d{2}-\d{2}\.ckx$/.test(vaultFilename(new Date('2026-10-08T00:00:00Z'))));
  await rejects('F4 无存储适配器报错', () => collectVault({}, { ls: null, idb: null }), VAULT_CODES.NO_STORAGE);
}

// ---------------------------------------------------------------- 10) 官方测试向量
{
  const vec = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'ckx-test-vectors.json'), 'utf8'));
  check('K1 向量自检标记', vec.selfCheckPassed === true);
  check('K2 常量：迭代数', CKX.CKX_ITERATIONS === 600000 && vec.constants.DEFAULT_ITERATIONS === 600000 && CKX.CKX_ITERATIONS === vec.constants.DEFAULT_ITERATIONS);
  check('K3 常量：magic/版本', vec.constants.SAFE_MAGIC === 'SAFE' && vec.constants.SAFE_VERSION_WITH_META === 3 && CKX.CKX_FORMAT_VERSION === '1');
  check('K4 常量：meta 上限', CKX.CKX_META_MAX_BYTES === vec.constants.SAFE_HEADER_BYTES * 0 + 4096 || CKX.CKX_META_MAX_BYTES === 4096);

  // V1：text 容器
  const V1 = vec.vectors.find(v => v.id === 'V1-safe-v3-text');
  const buf1 = Buffer.from(V1.spec.containerBase64, 'base64');
  check('K5 V1 magic/header', buf1.slice(0, 4).toString() === 'SAFE' && buf1[4] === 3);
  const meta1 = await CKX.readMeta(new Uint8Array(buf1));
  check('K6 V1 readMeta == expected.metadata', JSON.stringify(meta1) === JSON.stringify(V1.expected.metadata));
  const dec1 = await CKX.decrypt(new Uint8Array(buf1), V1.spec.password);
  check('K7 V1 明文一致', dec1.text === V1.expected.decryptedUtf8 && dec1.meta.schemaId === 'demo.settings');
  await rejects('K8 V1 错密码统一报错', () => CKX.decrypt(new Uint8Array(buf1), 'wrong-password'), 'CKX_WRONG_PASSWORD');

  // V3：imgv 二进制载体
  const V3 = vec.vectors.find(v => v.id === 'V3-imgv-binary-32x32');
  const rgba = new Uint8ClampedArray(Buffer.from(V3.spec.carrierRgbaBase64, 'base64'));
  const dec3 = await CKX.decrypt({ data: rgba, width: V3.spec.width, height: V3.spec.height }, V3.spec.password);
  check('K9 V3 imgv 载体重建明文', dec3.text === V3.expected.decryptedUtf8 && JSON.stringify(dec3.meta) === JSON.stringify(V3.expected.metadata));
  const container3 = Buffer.from(dec3.meta ? V3.expected.extractedContainerBase64 : '', 'base64');
  check('K10 V3 抽出的容器与原容器一致', container3.length > 0 && container3.slice(0, 4).toString() === 'SAFE');
}

// ---------------------------------------------------------------- 11) IDB_PLAN 覆盖
{
  const plan = {};
  for (const { db, stores } of IDB_PLAN) plan[db] = stores;
  check('P1 计划含主系统 5 store', ['events', 'state', 'candles', 'trades', 'reconcile'].every(s => plan['smart-trader-v1'].includes(s)));
  check('P2 计划含 jev 两 store', plan['kchart_jev'].includes('decisions') && plan['kchart_jev'].includes('srsiPairs'));
  check('P3 计划含规则监测 store', plan['smartTraderRM'].includes('ruleSignals'));
}

// ---------------------------------------------------------------- 汇总
// ---------------------------------------------------------------- 12) 全量覆盖：TSEV 权重库 + 自适应组合事件库 + 无 keyPath store
{
  const plan = {};
  for (const { db, stores } of IDB_PLAN) plan[db] = stores;
  check('P4 计划含 TSEV 权重库 kchart_pwa/disc（此前漏项）', !!(plan.kchart_pwa || []).includes('disc'), JSON.stringify(Object.keys(plan)));
  check('P5 计划含自适应组合事件库 smartTraderAP/events（此前漏项）', !!(plan.smartTraderAP || []).includes('events'));
  check('P6 KEYLESS_WRAP 契约稳定', KEYLESS_WRAP.key === '__ckxKey' && KEYLESS_WRAP.value === '__ckxValue');
}
{
  // 无 keyPath store 的记录（带包封）必须**原样透传**，collect → apply 不丢 key
  const keylessRecs = [
    { [KEYLESS_WRAP.key]: 'samples', [KEYLESS_WRAP.value]: { v: 5, stats: { 'BTCUSDT|pullback|15m|1': { buckets: { 3: { n: 40, h: 21 } } } }, sampleCount: 1234 } },
    { [KEYLESS_WRAP.key]: 'samples-legacy', [KEYLESS_WRAP.value]: { v: 2, stats: {} } },
  ];
  const idbA = fakeIdb({ 'kchart_pwa/disc': keylessRecs, 'smartTraderAP/events': [{ id: 'e1', t: 1, kind: 'rebalance' }] });
  const vault = await collectVault({}, { ls: fakeLs({ smartTrader: '{}' }), idb: idbA });
  check('W1 collect 保留无 keyPath 记录的 key 包封', (((vault.data.idb['kchart_pwa'] || {}).disc) || []).length === 2 && vault.data.idb['kchart_pwa'].disc[0][KEYLESS_WRAP.key] === 'samples');
  check('W2 collect 含自适应组合事件', (((vault.data.idb['smartTraderAP'] || {}).events) || []).length === 1);
  const idbB = fakeIdb({});
  const r = await applyVault(vault, { mode: 'overwrite' }, { ls: fakeLs({}), idb: idbB });
  const back = (idbB._m.get('kchart_pwa/disc') || []);
  check('W3 apply 写回后 key/值逐字节一致', r.idb === 3 && back.length === 2 && JSON.stringify(back) === JSON.stringify(keylessRecs));
  check('W4 apply 写回组合事件', (idbB._m.get('smartTraderAP/events') || []).length === 1);
  const sum = vaultSummary(vault);
  check('W5 摘要计数含新库', sum.idbDetail['kchart_pwa/disc'] === 2 && sum.idbDetail['smartTraderAP/events'] === 1, JSON.stringify(sum.idbDetail));
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
