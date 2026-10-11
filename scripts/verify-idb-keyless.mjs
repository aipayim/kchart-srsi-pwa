#!/usr/bin/env node
/**
 * verify-idb-keyless.mjs
 *
 * 用**真实 Chromium IndexedDB** 验证「无 keyPath（out-of-line key）store」的备份/恢复：
 *
 *  1) `kchart_pwa/disc`（`createObjectStore('disc')` **无 keyPath**，`put(value,'samples')`）与
 *     `smartTraderAP/events`（`{keyPath:'id'}`）能被 `collectVault()` 正确读取；
 *     无 keyPath 的记录以 `{__ckxKey,__ckxValue}` 包封形式入 vault（**key 不能丢**）。
 *  2) `exportVaultBytes → importVault → applyVault(overwrite)` 之后：
 *     `getAllKeys()` 仍为 `['samples']`（key 未丢！本次修复核心）、`get('samples')` 与原对象深等、
 *     `smartTraderAP/events` 的 `getAll()` 与原记录深等。
 *  3) 反向断言：**没有**「值被当成 key」的脏数据（key 仍是字符串 'samples'，非对象/undefined）。
 *  4) 旧形状 vault（不含新库）仍可 `applyVault` 写入。
 *
 * 不修改 src/，不新增依赖（用项目已有 esbuild + playwright）。
 * 任一项断言失败 → exit 1；全过 → exit 0。
 *
 * 已接入 `npm test`。为不把“未装 Playwright 浏览器”的环境搞红：
 *  - esbuild / playwright / Chromium 任一不可用 → 打印 `[SUMMARY] SKIP` 并 **exit 0**（醒目提示，不静默）；
 *  - 需要强制跑（CI）→ 设 `CKX_IDB_VERIFY_REQUIRE=1`（不可用则 exit 1）；
 *  - 想本地跳过 → 设 `CKX_SKIP_IDB_VERIFY=1`。
 *
 * 运行：node scripts/verify-idb-keyless.mjs
 */
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CKX_VAULT = path.resolve(ROOT, 'src/persistence/ckxVault.js');
const EVAL_TIMEOUT_MS = 240_000;

// ---------------------------------------------------------------- 打包入口（IIFE）
async function makeBundle(esbuild) {
  const entry = [
    `import { applyVault, collectVault, exportVaultBytes, importVault, makePreview } from ${JSON.stringify(CKX_VAULT)};`,
    'globalThis.__ckx = { applyVault, collectVault, exportVaultBytes, importVault, makePreview };',
  ].join('\n');
  const res = await esbuild.build({
    stdin: { contents: entry, resolveDir: path.dirname(CKX_VAULT), loader: 'js', sourcefile: 'ckx-entry.js' },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    write: false,
    logLevel: 'warning',
  });
  return res.outputFiles[0].text;
}

// ---------------------------------------------------------------- 本地 HTML 源（IndexedDB 需真实 origin）
function startServer() {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><head><meta charset="utf-8"><title>idb-keyless-probe</title></head><body></body></html>');
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// ---------------------------------------------------------------- 页面内测试（自包含，供 page.evaluate 序列化）
async function pageMain() {
  const DB_KP = 'kchart_pwa';     // 无 keyPath store
  const DB_AP = 'smartTraderAP';  // keyPath 'id'
  const STORE_DISC = 'disc';
  const STORE_EV = 'events';
  const PASSWORD = 'pw-keyless-123';

  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  function openDB(name, version, onCreate) {
    return new Promise((res, rej) => {
      const r = version ? indexedDB.open(name, version) : indexedDB.open(name);
      r.onupgradeneeded = () => { if (onCreate) onCreate(r.result); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.onblocked = () => rej(new Error('open blocked: ' + name));
    });
  }
  function delDB(name) {
    return new Promise((res, rej) => {
      const r = indexedDB.deleteDatabase(name);
      r.onsuccess = () => res();
      r.onerror = () => rej(r.error);
      r.onblocked = () => res();
    });
  }
  async function txDo(name, store, mode, fn) {
    const db = await openDB(name);
    try {
      return await new Promise((res, rej) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        let out;
        t.oncomplete = () => res(out && typeof out === 'object' && 'result' in out ? out.result : (out === undefined ? true : out));
        t.onerror = () => rej(t.error);
        t.onabort = () => rej(t.error || new Error('tx abort'));
        out = fn(s);
      });
    } finally { db.close(); }
  }
  const putKeyless = (db, store, value, key) => txDo(db, store, 'readwrite', (s) => { s.put(value, key); });
  const putRec = (db, store, rec) => txDo(db, store, 'readwrite', (s) => { s.put(rec); });
  const clearStore = (db, store) => txDo(db, store, 'readwrite', (s) => { s.clear(); });
  const getAllKeys = (db, store) => txDo(db, store, 'readonly', (s) => s.getAllKeys());
  const getAll = (db, store) => txDo(db, store, 'readonly', (s) => s.getAll());
  const getKey = (db, store, key) => txDo(db, store, 'readonly', (s) => s.get(key));

  const R = { errors: [] };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  try {
    // 代表性对象（仿 localLoop _stats 形状：嵌套 + 键顺序固定，用于 JSON 深等）
    const original = {
      n: 42,
      h: { win: 20, los: 10 },
      buckets: { '2026-40': { n: 5, w: 3 }, '2026-41': { n: 7, w: 4 } },
      learned: { 'pullback|1t|1': 0.42, 'hook|15m|-1': -0.31 },
      updatedAt: '2026-10-11T00:00:00.000Z',
    };
    const evRec = { id: 'e1', t: 1, kind: 'rebalance' };

    // ---------- (1) 建库 + 播种（disc 无 keyPath） ----------
    await delDB(DB_KP);
    await delDB(DB_AP);
    (await openDB(DB_KP, 1, (d) => d.createObjectStore(STORE_DISC))).close();
    (await openDB(DB_AP, 1, (d) => d.createObjectStore(STORE_EV, { keyPath: 'id' }))).close();
    await putKeyless(DB_KP, STORE_DISC, original, 'samples');
    await putRec(DB_AP, STORE_EV, evRec);

    // ---------- (2) collectVault（idb 用真实默认适配器；ls:null 不读 localStorage） ----------
    const vault = await globalThis.__ckx.collectVault({ includeSecrets: false }, { ls: null });
    R.vaultIdbDiscLen = ((vault.data.idb[DB_KP] || {})[STORE_DISC] || []).length;
    R.vaultIdbEvLen = ((vault.data.idb[DB_AP] || {})[STORE_EV] || []).length;
    const discRec = (vault.data.idb[DB_KP] || {})[STORE_DISC] && vault.data.idb[DB_KP][STORE_DISC][0];
    R.wrapKeyOk = !!(discRec && discRec.__ckxKey === 'samples');
    R.wrapValueDeepEqual = !!(discRec && same(discRec.__ckxValue, original));
    const summ = globalThis.__ckx.makePreview(vault, null, 'file').summary;
    R.detailDisc = summ.idbDetail[`${DB_KP}/${STORE_DISC}`];
    R.detailEvents = summ.idbDetail[`${DB_AP}/${STORE_EV}`];

    // ---------- (3) 导出 → 导入（dry-run）→ 先改脏 → 覆盖恢复 ----------
    const bytes = await globalThis.__ckx.exportVaultBytes(vault, PASSWORD);
    R.bytesLen = bytes && bytes.length;
    const preview = await globalThis.__ckx.importVault(bytes, PASSWORD);
    R.previewSchema = preview && preview.vault && preview.vault.schema;

    // 改脏：确保后续看到的是「真恢复」而非「没变」
    await clearStore(DB_KP, STORE_DISC);
    await putKeyless(DB_KP, STORE_DISC, { stale: 1 }, 'samples');
    await clearStore(DB_AP, STORE_EV);
    await putRec(DB_AP, STORE_EV, { id: 'stale', t: 0, kind: 'x' });
    R.dirtyKeys = await getAllKeys(DB_KP, STORE_DISC);
    R.dirtyEvIds = (await getAll(DB_AP, STORE_EV)).map((r) => r.id);

    R.applyRes = await globalThis.__ckx.applyVault(preview, { mode: 'overwrite' }, { ls: null });

    // ---------- (4) 恢复后断言 ----------
    const keys = await getAllKeys(DB_KP, STORE_DISC);
    R.restoredKeys = keys;
    R.restoredKeysStr = JSON.stringify(keys);
    R.restoredKeysOk = keys.length === 1 && keys[0] === 'samples';
    R.keyIsString = typeof keys[0] === 'string';
    const val = await getKey(DB_KP, STORE_DISC, 'samples');
    R.restoredDeepEqual = same(val, original);
    R.restoredHasStale = !!(val && typeof val === 'object' && 'stale' in val);
    const evAll = await getAll(DB_AP, STORE_EV);
    R.restoredEvAll = evAll;
    R.restoredEvDeepEqual = same(evAll, [evRec]);
    R.restoredEvHasStale = evAll.some((r) => r && r.id === 'stale');

    // ---------- (5) 反向：没有「值被当成 key」的脏数据 ----------
    R.noValueAsKey = keys.length === 1 && typeof keys[0] === 'string' && keys[0] === 'samples';

    // ---------- (6) 旧形状 vault（不含新库）仍可导入 ----------
    await delDB('smart-trader-v1');
    (await openDB('smart-trader-v1', 1, (d) => d.createObjectStore('state', { keyPath: 'key' }))).close();
    const oldVault = {
      schema: 'srsi.vault.v1',
      schemaVersion: 1,
      exportedAt: 'T',
      app: {},
      data: { ls: {}, idb: { 'smart-trader-v1': { state: [{ key: 'state.full', value: { bal: 1 } }] } } },
    };
    R.oldErr = null;
    try { R.applyOld = await globalThis.__ckx.applyVault(oldVault, { mode: 'overwrite' }, { ls: null }); }
    catch (e) { R.oldErr = String((e && e.message) || e); }
    const st = await getAll('smart-trader-v1', 'state');
    R.oldState = st;
    R.oldStateOk = st.length === 1 && st[0].key === 'state.full' && st[0].value && st[0].value.bal === 1;

    await delDB(DB_KP);
    await delDB(DB_AP);
    await delDB('smart-trader-v1');
  } catch (e) {
    R.errors.push(String((e && e.stack) || e));
  }
  return R;
}

// ---------------------------------------------------------------- 主流程
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function withTimeout(promise, ms, label) {
  let timer;
  const t = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} 超时 > ${ms}ms`)), ms); });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

async function main() {
  const t0 = Date.now();

  const REQUIRE = process.env.CKX_IDB_VERIFY_REQUIRE === '1';
  const skip = (reason) => {
    console.log('');
    if (REQUIRE) { console.error(`[SUMMARY] FAIL —— CKX_IDB_VERIFY_REQUIRE=1 但无法运行：${reason}`); process.exit(1); }
    console.log('══════════════════════════════════════════════════════════════════');
    console.log(`[SUMMARY] SKIP —— 真实 Chromium IndexedDB 无 keyPath 备份语义未验证：${reason}`);
    console.log('          安装浏览器后可跑：npx playwright install chromium');
    console.log('          强制要求本项（CI）：CKX_IDB_VERIFY_REQUIRE=1');
    console.log('══════════════════════════════════════════════════════════════════');
    process.exit(0);
  };
  if (process.env.CKX_SKIP_IDB_VERIFY === '1') skip('CKX_SKIP_IDB_VERIFY=1（用户显式跳过）');

  let esbuild, chromium;
  try { esbuild = await import('esbuild'); } catch (e) { return skip('esbuild 不可用（' + ((e && e.message) || e) + '）'); }
  try { chromium = (await import('playwright')).chromium; } catch (e) { return skip('playwright 不可用（' + ((e && e.message) || e) + '）'); }

  let bundle = '';
  try {
    bundle = await makeBundle(esbuild);
  } catch (e) {
    console.error('[FATAL] esbuild 打包失败：', (e && (e.message || e)) || e);
    process.exit(1);
  }
  console.log(`[info] esbuild IIFE bundle 大小 = ${bundle.length} bytes`);

  const server = await startServer();
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/`;

  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  } catch (e) {
    server.close();
    return skip('Chromium 无法启动（' + ((e && e.message) || e) + '）');
  }
  let R = null;
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(EVAL_TIMEOUT_MS);
    await page.goto(url, { waitUntil: 'load' });
    await page.addScriptTag({ content: bundle });
    R = await withTimeout(page.evaluate(pageMain), EVAL_TIMEOUT_MS, 'page.evaluate');
  } catch (e) {
    console.error(`[error] 页面执行失败：${(e && e.message) || e}`);
    R = { errors: [String((e && e.stack) || e)] };
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.close();
  }

  R = R || {};
  if (R.errors && R.errors.length) {
    console.error('[error] 页面内异常摘要：');
    for (const e of R.errors) console.error('   ' + String(e).split('\n')[0]);
  }

  const rows = [];
  const check = (label, cond, detail) => rows.push({ label, pass: !!cond, detail: detail == null ? '' : String(detail) });

  check("collectVault 读取无 keyPath store：disc 记录数 = 1", R.vaultIdbDiscLen === 1, `实测 ${R.vaultIdbDiscLen}（期望 1）`);
  check("collectVault 读取 keyPath store：events 记录数 = 1", R.vaultIdbEvLen === 1, `实测 ${R.vaultIdbEvLen}（期望 1）`);
  check('包封 __ckxKey = "samples"（key 未丢）', R.wrapKeyOk === true, `wrapKeyOk=${R.wrapKeyOk}`);
  check('包封 __ckxValue 与原对象深等', R.wrapValueDeepEqual === true, `wrapValueDeepEqual=${R.wrapValueDeepEqual}`);
  check("summary.idbDetail['kchart_pwa/disc'] = 1", R.detailDisc === 1, `实测 ${R.detailDisc}`);
  check("summary.idbDetail['smartTraderAP/events'] = 1", R.detailEvents === 1, `实测 ${R.detailEvents}`);
  check('exportVaultBytes 产出非空字节', Number.isFinite(R.bytesLen) && R.bytesLen > 0, `bytesLen=${R.bytesLen}`);
  check('importVault 解出 schema = srsi.vault.v1', R.previewSchema === 'srsi.vault.v1', `实测 ${R.previewSchema}`);
  check('改脏生效（恢复到真动作）', same(R.dirtyKeys, ['samples']) && same(R.dirtyEvIds, ['stale']),
    `dirtyKeys=${JSON.stringify(R.dirtyKeys)} dirtyEvIds=${JSON.stringify(R.dirtyEvIds)}`);
  check("恢复后 getAllKeys() = ['samples']（key 未丢！）", R.restoredKeysOk === true, `实测 ${R.restoredKeysStr}`);
  check("恢复后 key 是字符串（非对象/undefined）", R.keyIsString === true, `typeof=${R.restoredKeys && typeof R.restoredKeys[0]}`);
  check('恢复后 get("samples") 与原对象深等', R.restoredDeepEqual === true, `restoredDeepEqual=${R.restoredDeepEqual}`);
  check('恢复后无 stale 残留（disc）', R.restoredHasStale === false, `restoredHasStale=${R.restoredHasStale}`);
  check('恢复后 smartTraderAP/events 与原记录深等', R.restoredEvDeepEqual === true,
    `实测 ${JSON.stringify(R.restoredEvAll)}`);
  check('恢复后无 stale 残留（events）', R.restoredEvHasStale === false, `restoredEvHasStale=${R.restoredEvHasStale}`);
  check('反向：无「值被当成 key」脏数据', R.noValueAsKey === true, `noValueAsKey=${R.noValueAsKey}`);
  check('旧形状 vault 可导入且不报错', R.oldErr == null, `oldErr=${R.oldErr}`);
  check('旧形状 vault state 写入成功（state.full / bal=1）', R.oldStateOk === true, `oldState=${JSON.stringify(R.oldState)}`);

  console.log('');
  let allPass = true;
  for (const r of rows) {
    if (!r.pass) allPass = false;
    console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.label}${r.detail ? ' —— ' + r.detail : ''}`);
  }
  console.log('');
  console.log(`[restored getAllKeys()] ${JSON.stringify(R.restoredKeys)}`);
  console.log(`[restored deep-equal]  disc=${R.restoredDeepEqual}  events=${R.restoredEvDeepEqual}`);
  console.log(`[applyVault overwrite]  ${JSON.stringify(R.applyRes || null)}`);
  console.log(`[applyVault old-shape]  ${JSON.stringify(R.applyOld || null)}`);
  console.log('');

  const durS = ((Date.now() - t0) / 1000).toFixed(1);
  if (allPass && !(R.errors && R.errors.length)) {
    console.log(`[SUMMARY] ALL PASS（${rows.length}/${rows.length}，耗时 ${durS}s）`);
    process.exit(0);
  }
  const failed = rows.filter((r) => !r.pass).length;
  console.log(`[SUMMARY] FAIL（${rows.length - failed}/${rows.length} 通过，耗时 ${durS}s）`);
  process.exit(1);
}

main().catch((e) => {
  console.error('[FATAL]', (e && e.stack) || e);
  process.exit(1);
});
