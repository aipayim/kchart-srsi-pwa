/**
 * 回归：大批量 IndexedDB 恢复 + **自增（autoIncrement）计数器**语义
 *
 * 背景（诚实边界）：`smart-trader-v1/events` 是 `{keyPath:'id', autoIncrement:true}`。
 * 恢复时 `applyVault` 用 `put`（保留原 id），而 `clear()` **不会重置** IDB 的自增生成器。
 * 规范行为：向带 key generator 的 store 写入**显式数字 key** 时，若 `key >= generator.current`，
 * 则 `generator.current = key + 1`。因此「覆盖恢复 N 条(1..N) → 下一条新建事件 id = N+1」不冲突。
 *
 * 本文件用**忠实建模该语义的假 IDB**做回归（拦截 `add` 误用/丢 id/顺序错等改动）；
 * 真实浏览器 IndexedDB 的 ground truth 由 `scripts/verify-idb-autoincrement.mjs`（Playwright）验证。
 */
import { collectVault, importVault, applyVault, vaultSummary } from '../src/persistence/ckxVault.js';

let fails = 0;
const check = (name, cond, extra) => { if (!cond) { fails++; console.error('FAIL:', name, extra == null ? '' : extra); } else console.log('ok:', name); };

const BIG = 5000;

// ---------------------------------------------------------------- 忠实建模 autoIncrement 的假 IndexedDB
function makeAutoIdb() {
  // db/store → { recs: Map<key, rec>, gen: number }
  const stores = new Map();
  const ops = [];                       // 记录调用顺序，用于断言 clear 先于 put
  const KEY_PATH = { 'smart-trader-v1/events': 'id', 'smart-trader-v1/state': 'key' };
  const AUTO = { 'smart-trader-v1/events': true };
  // 规范语义：key generator 的 current = **下一个将生成的 key**（初值 1）；
  // 生成时取 current 并 +1；写入**显式数字 key** 时若 key >= current 则 current = key + 1。
  function S(db, store) {
    const k = db + '/' + store;
    if (!stores.has(k)) stores.set(k, { recs: new Map(), gen: 1 });
    return stores.get(k);
  }
  return {
    ops,
    _stores: stores,
    get(db, store) { return S(db, store); },
    async list(db, store) { return [...S(db, store).recs.values()]; },
    async put(db, store, rec) {
      ops.push(['put', db, store, rec && rec.id]);
      const s = S(db, store);
      const kp = KEY_PATH[db + '/' + store] || 'id';
      let key = rec == null ? undefined : rec[kp];
      if (AUTO[db + '/' + store]) {
        if (key == null) { key = s.gen; s.gen = key + 1; rec = Object.assign({}, rec, { [kp]: key }); }   // 生成器给出新 key
        else { const n = Number(key); if (Number.isFinite(n) && n >= s.gen) s.gen = n + 1; } // 规范：显式 key 推进生成器
      }
      s.recs.set(key, rec);
      return true;
    },
    async clear(db, store) {
      ops.push(['clear', db, store]);
      S(db, store).recs.clear();        // 规范：clear() 不重置 key generator
      return true;
    },
    // 模拟「业务新建一条事件」（不带 id）
    async appendEvent(db, store, rec) { return this.put(db, store, rec); },
  };
}
function fakeLs(init = {}) {
  const m = new Map(Object.entries(init));
  return { keys: () => [...m.keys()], get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, String(v)), remove: (k) => m.delete(k) };
}
function bigVault(n) {
  const events = [];
  for (let i = 1; i <= n; i++) events.push({ id: i, ts: 1000 + i, type: i % 3 === 0 ? 'trade' : 'ai', payload: 'x'.repeat(40) });
  return {
    schema: 'srsi.vault.v1', schemaVersion: 1, exportedAt: '2026-10-09T00:00:00.000Z',
    app: { version: 'test', tag: 'v-test' },
    data: { ls: { smartTrader: '{"a":1}', pwa_zoom: '1.25' }, idb: { 'smart-trader-v1': { events, state: [{ key: 'state.full', value: { bal: 1000 } }] } } },
  };
}

// ---------------------------------------------------------------- 1) 大批量覆盖恢复：id 保留 + 生成器推进
{
  const vault = bigVault(BIG);
  const idb = makeAutoIdb();
  // 目标库先有旧数据（模拟"已经用过一阵子"）
  for (let i = 1; i <= 120; i++) await idb.put('smart-trader-v1', 'events', { id: i, ts: i, type: 'old', payload: 'OLD' });
  await idb.put('smart-trader-v1', 'state', { key: 'stale', value: 1 });
  const genBefore = idb.get('smart-trader-v1', 'events').gen;
  const opsStart = idb.ops.length;      // 只统计 applyVault 开始后的操作（前置播种也算 op）

  const t0 = Date.now();
  const r = await applyVault(vault, { mode: 'overwrite' }, { ls: fakeLs({ smartTrader: 'OLD' }), idb });
  const ms = Date.now() - t0;

  check('B1 恢复条数正确', r.idb === BIG + 1 && r.ls === 2, JSON.stringify(r));
  const recs = await idb.list('smart-trader-v1', 'events');
  check('B2 覆盖后无旧遗留', recs.length === BIG && recs.every((x) => x.type !== 'old'));
  check('B3 id 逐条保留（1..N，未重编号）', recs[0].id === 1 && recs[BIG - 1].id === BIG && new Set(recs.map((x) => x.id)).size === BIG);
  check('B4 payload 完整（非截断）', recs[BIG - 1].payload.length === 40);
  const afterOps = idb.ops.slice(opsStart);
  check('B5 clear 先于 put（覆盖语义）', afterOps.length > 0 && afterOps[0][0] === 'clear' && afterOps.filter((o) => o[0] === 'clear').length === 2, JSON.stringify(afterOps.slice(0, 3)));
  check('B6 state 旧记录被清（覆盖而非叠加）', (await idb.list('smart-trader-v1', 'state')).length === 1);

  const genAfter = idb.get('smart-trader-v1', 'events').gen;
  check('B7 生成器已推进到 maxId+1', genAfter === BIG + 1, `genBefore=${genBefore} genAfter=${genAfter}`);

  // 关键断言：恢复后「业务新建事件」不会与恢复的 id 冲突
  await idb.appendEvent('smart-trader-v1', 'events', { ts: 999999, type: 'NEW', payload: 'y'.repeat(10) });
  const after = await idb.list('smart-trader-v1', 'events');
  const fresh = after.find((x) => x.type === 'NEW');
  check('B8 新建事件获得 id = N+1（不冲突）', !!fresh && fresh.id === BIG + 1, fresh ? String(fresh.id) : 'missing');
  check('B9 总数 = N+1 且无重复 id', after.length === BIG + 1 && new Set(after.map((x) => x.id)).size === BIG + 1);
  check('B10 大批量恢复未出现 O(n²) 级别耗时（< 8s）', ms < 8000, ms + 'ms');
}

// ---------------------------------------------------------------- 2) 合并恢复：幂等、不重编号、不动生成器倒退
{
  const vault = bigVault(500);
  const idb = makeAutoIdb();
  await applyVault(vault, { mode: 'overwrite' }, { ls: fakeLs({}), idb });
  const gen1 = idb.get('smart-trader-v1', 'events').gen;
  const r2 = await applyVault(vault, { mode: 'merge' }, { ls: fakeLs({}), idb });
  const recs = await idb.list('smart-trader-v1', 'events');
  check('M1 合并幂等（同 id 覆盖，不新增）', r2.idb === 501 && recs.length === 500);
  check('M2 合并未清空（无 clear 调用）', idb.ops.filter((o) => o[0] === 'clear' && o[2] === 'events').length === 1);
  check('M3 生成器未倒退', idb.get('smart-trader-v1', 'events').gen === gen1 && gen1 === 501);
  // 合并前库里已有更大 id → 生成器应保持较大值
  const idb2 = makeAutoIdb();
  await idb2.put('smart-trader-v1', 'events', { id: 9000, ts: 1, type: 'newer' });
  await applyVault(vault, { mode: 'merge' }, { ls: fakeLs({}), idb: idb2 });
  check('M4 合并不会让生成器回退（旧库 id 更大时）', idb2.get('smart-trader-v1', 'events').gen === 9001, String(idb2.get('smart-trader-v1', 'events').gen));
  const recs2 = await idb2.list('smart-trader-v1', 'events');
  check('M5 合并保留原有更大 id 记录', recs2.some((x) => x.id === 9000) && recs2.length === 501);
}

// ---------------------------------------------------------------- 3) 端到端：真实加密 → 预览 → 大批量恢复
{
  const src = { ls: fakeLs({ smartTrader: '{"a":1}', pwa_zoom: '1' }), idb: makeAutoIdb() };
  for (let i = 1; i <= 800; i++) await src.idb.put('smart-trader-v1', 'events', { id: i, ts: i, type: 'e' });
  const vault = await collectVault({}, src);
  check('E1 收集摘要', vaultSummary(vault).idbRecords === 800);
  const { exportVaultBytes } = await import('../src/persistence/ckxVault.js');
  const bytes = await exportVaultBytes(vault, 'pw-big-123');
  const prev = await importVault(bytes, 'pw-big-123');
  const dst = makeAutoIdb();
  const r = await applyVault(prev, { mode: 'overwrite' }, { ls: fakeLs({}), idb: dst });
  const recs = await dst.list('smart-trader-v1', 'events');
  check('E2 端到端恢复 800 条且 id 保留', r.idb === 800 && recs.length === 800 && recs[799].id === 800);
  check('E3 端到端后生成器 = 801', dst.get('smart-trader-v1', 'events').gen === 801);
}

// ---------------------------------------------------------------- 4) 边界：空 vault / 无 events
{
  const idb = makeAutoIdb();
  await idb.put('smart-trader-v1', 'events', { id: 7, ts: 1, type: 'keep' });
  const empty = { schema: 'srsi.vault.v1', schemaVersion: 1, exportedAt: 'T', app: {}, data: { ls: {}, idb: {} } };
  const r = await applyVault(empty, { mode: 'overwrite' }, { ls: fakeLs({ old: '1' }), idb });
  check('Z1 vault 无该 store 时不动它', r.idb === 0 && (await idb.list('smart-trader-v1', 'events')).length === 1);
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
