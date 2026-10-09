#!/usr/bin/env node
/**
 * verify-idb-autoincrement.mjs
 *
 * 用**真实 Chromium IndexedDB** 验证 `smart-trader-v1/events`（{keyPath:'id', autoIncrement:true}）
 * 在 `ckxVault.applyVault(..., {mode:'overwrite'})` 大批量覆盖恢复之后的**自增计数器语义**：
 *
 *  1) clear() 不重置 key generator；
 *  2) put(显式数字 id) 且 id >= generator.current 时，generator.current = id + 1；
 *  3) 覆盖恢复 1..N 后，业务新建一条**不带 id** 的事件应得 id = N+1（不与恢复的 id 冲突）；
 *  4) merge 模式不回退生成器（已有 id 到 9000 的库，merge 后 add 得 9001）。
 *
 * 不修改 src/，不新增依赖（用项目已有 esbuild + playwright）。
 * 任一项断言失败 → exit 1；全过 → exit 0。
 *
 * 运行：node scripts/verify-idb-autoincrement.mjs
 */
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CKX_VAULT = path.resolve(ROOT, 'src/persistence/ckxVault.js');
const EVAL_TIMEOUT_MS = 240_000;

// ---------------------------------------------------------------- 打包入口（IIFE）
async function makeBundle() {
  const entry = [
    `import { applyVault, collectVault, exportVaultBytes, importVault } from ${JSON.stringify(CKX_VAULT)};`,
    'globalThis.__ckx = { applyVault, collectVault, exportVaultBytes, importVault };',
  ].join('\n');
  const res = await build({
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
      res.end('<!doctype html><html><head><meta charset="utf-8"><title>idb-probe</title></head><body></body></html>');
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// ---------------------------------------------------------------- 页面内测试（自包含，供 page.evaluate 序列化）
async function pageMain() {
  const DB = 'smart-trader-v1';
  const N = 5000;
  const MERGE_HIGH = 9000;

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
  const makeMainStores = (d) => {
    d.createObjectStore('events', { keyPath: 'id', autoIncrement: true });
    d.createObjectStore('state', { keyPath: 'key' });
    d.createObjectStore('candles', { keyPath: 'id' });
    d.createObjectStore('trades', { keyPath: 'id' });
    d.createObjectStore('reconcile', { keyPath: 'id' });
  };
  function delDB(name) {
    return new Promise((res, rej) => {
      const r = indexedDB.deleteDatabase(name);
      r.onsuccess = () => res();
      r.onerror = () => rej(r.error);
      r.onblocked = () => res();
    });
  }
  async function getAll(name, store) {
    const db = await openDB(name);
    try { return await req(db.transaction(store, 'readonly').objectStore(store).getAll()); }
    finally { db.close(); }
  }
  async function putAll(name, store, recs) {
    const db = await openDB(name);
    try {
      await new Promise((res, rej) => {
        const t = db.transaction(store, 'readwrite');
        const s = t.objectStore(store);
        for (const rec of recs) s.put(rec);
        t.oncomplete = () => res();
        t.onerror = () => rej(t.error);
        t.onabort = () => rej(t.error || new Error('tx abort'));
      });
    } finally { db.close(); }
  }
  async function clearStore(name, store) {
    const db = await openDB(name);
    try {
      await new Promise((res, rej) => {
        const t = db.transaction(store, 'readwrite');
        t.objectStore(store).clear();
        t.oncomplete = () => res();
        t.onerror = () => rej(t.error);
      });
    } finally { db.close(); }
  }
  async function addNoKey(name, store, rec) {
    const db = await openDB(name);
    try { return await req(db.transaction(store, 'readwrite').objectStore(store).add(rec)); }
    finally { db.close(); }
  }

  const R = { errors: [] };
  try {
    // ---------- (a) 建库 v2（5 stores） ----------
    await delDB(DB);
    (await openDB(DB, 2, makeMainStores)).close();

    // ---------- (b) 播种 120 条旧事件 + 1 条 state ----------
    const old = [];
    for (let i = 1; i <= 120; i++) old.push({ id: i, ts: i, type: 'OLD' });
    await putAll(DB, 'events', old);
    await putAll(DB, 'state', [{ key: 'state.old', value: { bal: 1 } }]);

    // ---------- (c) 构造 vault（5000 条 events + 1 条 state） ----------
    const events = [];
    for (let i = 1; i <= N; i++) events.push({ id: i, ts: i, type: 'c', payload: 'x'.repeat(40) });
    const vault = {
      schema: 'srsi.vault.v1',
      schemaVersion: 1,
      exportedAt: 'T',
      app: {},
      data: {
        ls: { smartTrader: '{}' },
        idb: { 'smart-trader-v1': { events, state: [{ key: 'state.full', value: { bal: 1000 } }] } },
      },
    };
    R.vaultEvents = events.length;

    // ---------- (d) applyVault overwrite（ls:null → 不写 localStorage；idb 用真实默认适配器） ----------
    R.applyOverwrite = await globalThis.__ckx.applyVault(vault, { mode: 'overwrite' }, { ls: null });

    // ---------- (e) 校验 ----------
    const recs = await getAll(DB, 'events');
    R.count = recs.length;
    const ids = recs.map((r) => r.id).sort((a, b) => a - b);
    const uniq = new Set(ids);
    R.uniqueIds = uniq.size;
    R.minId = ids.length ? ids[0] : null;
    R.maxId = ids.length ? ids[ids.length - 1] : null;
    R.oldLeftover = recs.filter((r) => r.type === 'OLD').length;
    let missing = 0;
    for (let i = 1; i <= N; i++) if (!uniq.has(i)) missing++;
    R.missing = missing;
    R.idsOk = R.count === N && R.uniqueIds === N && R.missing === 0
      && R.oldLeftover === 0 && R.minId === 1 && R.maxId === N;
    const last = recs.find((r) => r.id === N);
    R.payloadOk = !!(last && typeof last.payload === 'string' && last.payload.length === 40);

    const states = await getAll(DB, 'state');
    R.stateCount = states.length;
    R.stateKey = states.length ? states[0].key : null;
    R.stateOk = states.length === 1 && states[0].key === 'state.full';

    // freshId：原生 IDB（不经产品代码）在同一 store add 一条不带 id 的
    R.freshId = await addNoKey(DB, 'events', { ts: 999999, type: 'NEW' });
    const recs2 = await getAll(DB, 'events');
    R.countAfter = recs2.length;
    R.uniqueAfter = new Set(recs2.map((r) => r.id)).size;
    R.dupAfterOk = R.countAfter === N + 1 && R.uniqueAfter === N + 1;

    // ---------- clearResetsGen：单独库验证 clear() 是否重置生成器 ----------
    await delDB('gen-probe');
    await openDB('gen-probe', 1, (d) => d.createObjectStore('g', { keyPath: 'id', autoIncrement: true })).then((x) => x.close());
    await putAll('gen-probe', 'g', [{ id: 1 }, { id: 2 }, { id: 3 }]);
    await clearStore('gen-probe', 'g');
    R.gClearResetsNewId = await addNoKey('gen-probe', 'g', {});

    // ---------- (f) merge 对照：已有 id 到 9000 的库 ----------
    await delDB(DB);
    (await openDB(DB, 2, makeMainStores)).close();
    const seeded = [];
    for (let i = 1; i <= MERGE_HIGH; i++) seeded.push({ id: i, ts: i, type: 'PRE' });
    await putAll(DB, 'events', seeded);
    R.preMergeCount = (await getAll(DB, 'events')).length;
    R.applyMerge = await globalThis.__ckx.applyVault(vault, { mode: 'merge' }, { ls: null });
    R.mergeHighKept = (await getAll(DB, 'events')).some((r) => r.id === MERGE_HIGH && r.type === 'PRE');
    R.mergeFreshId = await addNoKey(DB, 'events', { ts: 1, type: 'NEW2' });
    R.mergeCountAfter = (await getAll(DB, 'events')).length;

    await delDB('gen-probe');
  } catch (e) {
    R.errors.push(String((e && e.stack) || e));
  }
  return R;
}

// ---------------------------------------------------------------- 主流程
function withTimeout(promise, ms, label) {
  let timer;
  const t = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} 超时 > ${ms}ms`)), ms); });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

async function main() {
  const t0 = Date.now();
  let bundle = '';
  try {
    bundle = await makeBundle();
  } catch (e) {
    console.error('[FATAL] esbuild 打包失败：', (e && (e.message || e)) || e);
    process.exit(1);
  }
  console.log(`[info] esbuild IIFE bundle 大小 = ${bundle.length} bytes`);

  const server = await startServer();
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/`;

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
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

  check('events count = 5000', R.count === 5000, `实测 ${R.count}（期望 5000）`);
  check('id 1..5000 齐全/无重复/无旧遗留', R.idsOk === true,
    `uniq=${R.uniqueIds} missing=${R.missing} oldLeftover=${R.oldLeftover} min=${R.minId} max=${R.maxId}`);
  check('最后一条 payload 长度 = 40', R.payloadOk === true, `payloadOk=${R.payloadOk}`);
  check('state 仅剩 1 条且为 state.full（旧 state 已清）', R.stateOk === true,
    `count=${R.stateCount} key=${R.stateKey}`);
  check('freshId = 5001（恢复后新建不冲突）', R.freshId === 5001, `实测 ${R.freshId}（期望 5001）`);
  check('dupAfter 无重复（count=uniq=5001）', R.dupAfterOk === true,
    `count=${R.countAfter} uniq=${R.uniqueAfter}（期望 5001）`);
  check('clear() 不重置 key generator（1..3 clear 后 add → 4）', R.gClearResetsNewId === 4,
    `实测 ${R.gClearResetsNewId}（期望 4；若为 1 则 clear 会重置，与规范相反）`);
  check('merge：9000 高位记录保留', R.mergeHighKept === true, `mergeHighKept=${R.mergeHighKept}`);
  check('merge 后生成器不回退（add → 9001）', R.mergeFreshId === 9001,
    `实测 ${R.mergeFreshId}（期望 9001）`);
  check('merge 后总数 = 9001', R.mergeCountAfter === 9001, `实测 ${R.mergeCountAfter}（期望 9001）`);

  console.log('');
  let allPass = true;
  for (const r of rows) {
    if (!r.pass) allPass = false;
    console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.label}${r.detail ? ' —— ' + r.detail : ''}`);
  }
  console.log('');
  console.log(`[applyVault overwrite] ${JSON.stringify(R.applyOverwrite || null)}`);
  console.log(`[applyVault merge]     ${JSON.stringify(R.applyMerge || null)}`);
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
