/**
 * PWA 加密备份面板（ckxBackup）测试
 * 覆盖：纯函数（格式化/裁剪/计划/清单/预览）+ 备份存储（上限 5、删除、清空）+
 * 导出/预览端到端（真实 SDK，一次往返）+ 范围开关（凭证默认排除）
 */
import {
  fmtBytes, mediumLabel, methodLabel, trimBackups, planLines, backupRowsHtml, previewHtml,
  listBackups, saveBackup, deleteBackup, clearBackups, exportBackup, previewBackup, applyBackup,
  ckxCardHtml, ckxTrustHtml, ckxEmbedCfg, BACKUP_MAX, BACKUP_DB, BACKUP_STORE,
} from '../src/pwa/ckxBackup.js';
import { collectVault, VAULT_SCHEMA_ID, VAULT_CODES } from '../src/persistence/ckxVault.js';

let fails = 0;
const check = (name, cond) => { if (!cond) { fails++; console.error('FAIL:', name); } else console.log('ok:', name); };
const rejects = async (name, fn, code) => {
  try { await fn(); fails++; console.error('FAIL (no throw):', name); }
  catch (e) { check(name + ' → ' + (e.code || e.name), e.code === code); }
};

function fakeLs(init = {}) {
  const m = new Map(Object.entries(init));
  return { keys: () => [...m.keys()], get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, String(v)), remove: (k) => m.delete(k) };
}
function fakeIdb(init = {}) {
  const m = new Map(Object.entries(init).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  return { list: async (db, s) => JSON.parse(JSON.stringify(m.get(db + '/' + s) || [])), put: async (db, s, r) => { const a = m.get(db + '/' + s) || []; a.push(r); m.set(db + '/' + s, a); }, clear: async (db, s) => { m.set(db + '/' + s, []); } };
}
function fakeBackupStore() {
  const m = new Map();
  return {
    _m: m,
    async list() { return [...m.values()]; },
    async put(rec) { m.set(rec.id, rec); },
    async del(id) { m.delete(id); },
    async clear() { m.clear(); },
  };
}
const sampleDeps = () => ({ ls: fakeLs({ smartTrader: '{"a":1}', pwa_zoom: '1.25' }), idb: fakeIdb({ 'smart-trader-v1/state': [{ key: 'crypto.deviceKey', value: 'K' }, { key: 'state.full', value: {} }], 'smart-trader-v1/events': [{ id: 1 }] }) });

// ---------------------------------------------------------------- 1) 纯函数
{
  check('F1 fmtBytes', fmtBytes(0) === '0 B' && fmtBytes(1023) === '1023 B' && fmtBytes(2048) === '2.0 KB' && fmtBytes(3 * 1024 * 1024) === '3.00 MB');
  check('F2 labels', mediumLabel('file') === '.ckx 文件' && mediumLabel('text') === '密文串' && methodLabel('embed') === 'CKX 在线' && methodLabel('local') === '本机加密');
  const items = [{ id: 'a', t: 1 }, { id: 'b', t: 5 }, { id: 'c', t: 3 }, { id: 'd', t: 2 }, { id: 'e', t: 4 }, { id: 'f', t: 6 }, { id: 'g', t: 7 }];
  const tr = trimBackups(items);
  check('F3 trimBackups 保留最近 5 且倒序', tr.length === BACKUP_MAX && tr.map(x => x.id).join(',') === 'g,f,b,e,c');
  check('F4 trimBackups 边界', trimBackups([]).length === 0 && trimBackups(null).length === 0 && trimBackups(items, 2).length === 2);

  const sum = { schema: VAULT_SCHEMA_ID, schemaVersion: 1, exportedAt: 'T', app: { version: '1' }, lsCount: 3, idbRecords: 5, idbDetail: { 'a/b': 2 } };
  const lines = planLines(sum);
  check('F5 planLines 含计数与排除说明', lines.some(l => l.includes('localStorage：3')) && lines.some(l => l.includes('IndexedDB：5')) && lines.some(l => l.includes('凭证默认排除')));
  check('F6 planLines 空输入', planLines(null).length === 1);

  const rows = backupRowsHtml([{ id: 'x', t: Date.now(), medium: 'file', size: 2048, hasSecrets: true }, { id: 'y', t: Date.now(), medium: 'text', size: 10 }]);
  check('F7 backupRowsHtml 行内容', rows.includes('data-id="x"') && rows.includes('.ckx 文件') && rows.includes('含凭证') && rows.includes('密文串') && rows.includes('data-act="dl"') && rows.includes('data-act="del"'));
  check('F8 backupRowsHtml 空态', backupRowsHtml([]).includes('暂无本机备份'));
  check('F9 backupRowsHtml 转义', backupRowsHtml([{ id: '<img>', t: 1, medium: 'file', size: 1 }]).includes('&lt;img&gt;'));

  const prev = previewHtml(sum, { label: 'L', createdAt: 'C' });
  check('F10 previewHtml 含 schema/版本/计数', prev.includes(VAULT_SCHEMA_ID) && prev.includes('校验通过') && prev.includes('不含凭证') && prev.includes('标签：L'));
  const prevSec = previewHtml(Object.assign({}, sum, { hasSecrets: true }), null);
  check('F11 previewHtml 含凭证提示', prevSec.includes('含凭证'));
  check('F12 previewHtml 空输入安全', previewHtml(null) === '');

  // 回归（生产 E2E 抓出）：卡片必须真的渲染出所有被绑定的元素 id，否则 msg() 变 no-op（导出/删除无反馈）
  const cardIds = ['pwaCkxPlan', 'pwaCkxMedium', 'pwaCkxSecrets', 'pwaCkxPw', 'pwaCkxPw2',
    'pwaCkxExpLocal', 'pwaCkxExpEmbed', 'pwaCkxRefreshPlan', 'pwaCkxMsg',
    'pwaCkxFile', 'pwaCkxPaste', 'pwaCkxClearIn', 'pwaCkxImpPw',
    'pwaCkxPrevLocal', 'pwaCkxPrevEmbed', 'pwaCkxPrev', 'pwaCkxImpMsg',
    'pwaCkxList', 'pwaCkxClearAll'];
  const cardHtml = ckxCardHtml();
  const missingIds = cardIds.filter((id) => !cardHtml.includes('id="' + id + '"'));
  check('F13 ckxCardHtml 含全部绑定元素 id', missingIds.length === 0, missingIds.join(','));

  // 信任条（v1.6.86）：明确「加解密由 CKX 官方执行」+ 可验证版本/哈希 + 官方 Verified 徽章
  const trust = ckxTrustHtml();
  check('F14 信任条含官方 Verified 徽章', trust.includes('https://cryptokey.im/badge/ckx-verified.svg') && trust.includes('alt="CKX Verified Integrator"'), '');
  check('F15 信任条含 SDK 版本与 sha384 前缀', trust.includes('0.4.0') && /sha384-8jfvvqC/.test(trust), '');
  check('F16 信任条声明「不自行实现密码学」并给出官方清单/注册表链接', /不自行实现密码学/.test(trust) && trust.includes('/ckx/sdk/MANIFEST.json') && trust.includes('cryptokey.im/registry'), '');
  check('F17 卡片顶部包含信任条', ckxCardHtml().includes('ckx-trust'), '');

  // 0.4.0：embed 路径必须携带 schema 信息性标签（否则 embed 产物 meta 无 schemaId，免密码无法识别归属）
  const cfg = ckxEmbedCfg({}, 'file');
  check('F18 embedCfg 携带 schema 标签 + 版本', cfg.schema === 'srsi.vault.v1' && cfg.schemaVersion === '1', JSON.stringify({ s: cfg.schema, v: cfg.schemaVersion }));
  check('F19 embedCfg 传 medium/label', cfg.medium === 'file' && cfg.label === 'srsi-backup', '');
  const cfgMock = ckxEmbedCfg({ mock: true, embedCfg: { locale: 'zh' } }, 'text');
  check('F20 embedCfg mock 模式指向演示页并保留覆盖项', cfgMock.mock === true && /embed=mock/.test(cfgMock.mockUrl) && cfgMock.locale === 'zh' && cfgMock.medium === 'text', '');
}

// ---------------------------------------------------------------- 2) 备份存储
{
  const bs = fakeBackupStore();
  const deps = { backupStore: bs };
  check('S1 初始为空', (await listBackups(deps)).length === 0);
  for (let i = 1; i <= 7; i++) await saveBackup({ id: 'b' + i, t: i, medium: 'file', size: i }, deps);
  const got = await listBackups(deps);
  check('S2 上限 5 且保留最新', got.length === 5 && got[0].id === 'b7' && got.map(x => x.id).join(',') === 'b7,b6,b5,b4,b3');
  check('S3 最旧实际被删除', !bs._m.has('b1') && !bs._m.has('b2'));
  await deleteBackup('b7', deps);
  check('S4 删除生效', !(await listBackups(deps)).some(x => x.id === 'b7'));
  await clearBackups(deps);
  check('S5 清空生效', (await listBackups(deps)).length === 0);
  check('S6 store 常量', BACKUP_DB === 'smartTraderCKX' && BACKUP_STORE === 'backups' && BACKUP_MAX === 5);
  // 无 store（Node 无 indexedDB）→ 安全降级
  check('S7 无 store 时安全返回', (await listBackups({ backupStore: null })).length >= 0 && (await saveBackup({ id: 'z', t: 1 })) === false);
}

// ---------------------------------------------------------------- 3) 范围：凭证默认排除
{
  const v1 = await collectVault({}, sampleDeps());
  check('R1 默认 collectVault 不含 secrets', v1.secrets === undefined && ((v1.data.idb['smart-trader-v1'] || {}).state || []).every(r => r.key !== 'crypto.deviceKey'));
  const v2 = await collectVault({ includeSecrets: true }, sampleDeps());
  check('R2 includeSecrets 含凭证', !!v2.secrets && !!v2.secrets.idb['smart-trader-v1'].state.length);
}

// ---------------------------------------------------------------- 4) 导出（真实 SDK）+ 预览往返
{
  const deps = Object.assign(sampleDeps(), { backupStore: fakeBackupStore() });
  const out = await exportBackup({ method: 'local', medium: 'file', password: 'pw-strong-123' }, deps);
  check('E1 本机导出 .ckx', out.medium === 'file' && out.bytes instanceof Uint8Array && out.bytes[0] === 0x53 && out.hasSecrets === false);
  check('E2 文件名 .ckx', /\.ckx$/.test(out.filename) && out.summary.lsCount === 2);
  const insp = await previewBackup(out.bytes, { method: 'local', password: 'pw-strong-123' }, deps);
  check('E3 预览往返（ls 2 键，indexedDB 2 条）', insp.summary.lsCount === 2 && insp.summary.idbRecords === 2 && insp.vault.schema === VAULT_SCHEMA_ID);
  await rejects('E4 错密码', () => previewBackup(out.bytes, { method: 'local', password: 'wrong' }, deps), 'CKX_WRONG_PASSWORD');

  const outText = await exportBackup({ method: 'local', medium: 'text', password: 'pw-strong-123' }, deps);
  check('E5 密文串导出', outText.medium === 'text' && typeof outText.text === 'string' && /^[A-Za-z0-9_-]+$/.test(outText.text));
  const pv2 = await previewBackup(outText.text, { method: 'local', password: 'pw-strong-123' }, deps);
  check('E6 密文串可解', pv2.summary.lsCount === 2);

  const outSec = await exportBackup({ method: 'local', medium: 'file', password: 'pw-strong-123', includeSecrets: true }, sampleDeps());
  check('E7 includeSecrets 标记', outSec.hasSecrets === true);
  const pvSec = await previewBackup(outSec.bytes, { method: 'local', password: 'pw-strong-123' }, sampleDeps());
  check('E8 预览显示含凭证', pvSec.summary.hasSecrets === true && pvSec.summary.secretRecords === 1);
}

// ---------------------------------------------------------------- 5) 应用恢复（overwrite / merge）
{
  const deps = Object.assign(sampleDeps(), {});
  const out = await exportBackup({ method: 'local', medium: 'file', password: 'pw-strong-123' }, deps);
  const pv = await previewBackup(out.bytes, { method: 'local', password: 'pw-strong-123' }, deps);
  const ls2 = fakeLs({ smartTrader: 'OLD', pwa_zoom: '9', untracked: 'X' });
  const idb2 = fakeIdb({ 'smart-trader-v1/events': [{ id: 99 }] });
  const r = await applyBackup(pv, { mode: 'overwrite' }, { ls: ls2, idb: idb2 });
  check('A1 overwrite 写回', r.ls === 2 && r.idb === 2 && ls2.get('smartTrader') === '{"a":1}');
  check('A2 merge 保留未纳入键', await (async () => { const ls3 = fakeLs({ untracked: 'X' }); await applyBackup(pv, { mode: 'merge' }, { ls: ls3, idb: fakeIdb({}) }); return ls3.get('untracked') === 'X'; })());
}

// ---------------------------------------------------------------- 6) 错误码透传
{
  await rejects('X1 非法载体', () => previewBackup('not-a-vault', { method: 'local', password: 'x' }, {}), 'CKX_NO_CARRIER');
  const CKX = await import('../src/vendor/ckx/ckx.esm.js');
  const other = await CKX.encryptToFile('{"schema":"other.v1"}', 'pw', { app: 'https://x', schema: 'other.v1', schemaVersion: '1' });
  await rejects('X2 其它 schema 被拒', () => previewBackup(other, { method: 'local', password: 'pw' }, {}), 'CKX_SCHEMA_MISMATCH');
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
