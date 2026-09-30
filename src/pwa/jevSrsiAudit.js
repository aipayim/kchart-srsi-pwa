// Jev×SRSI 裁决审计（GOAL_jev-srsi §3 · P1）—— 配对数据集（**只观察，零行为变化**）
//
// 目标：积累「SRSI 信号 × 同刻 Jev 意见 → 结果」的配对样本，回答「Jev 对 SRSI 有没有增量信息」。
//
// 红线（务必遵守）：
//  - **不碰** runSrsiAutoTrade / 开仓闸门 / _tryOpen / 带状态机；**不喂 TSEV**（那是 P4 的独立通道）；
//    **绝不触发任何交易**——本模块只读信号事件 + 只读 __jevLatest + 只读 K 线。
//  - 信号源复用既有事件总线 `signalAlerts.onSignalEvent`（不另写一套识别，避免两套逻辑漂移）。
//  - 结局复用既有 `winLossByAtr`（TP 2×ATR / SL 1.5×ATR，与卫星/回测同源），不引入新出场规则。
//  - 写入失败不静默吞：localStorage 走 kchartApi._safeSetItem（配额自愈，§5.30 红线；不可用时本地 fallback）；
//    IndexedDB 失败显式告警并降级为内存。
//
// ⭐ 已知坑（勿重犯）：
//  - `winLossByAtr` 的 `direction` 只认 **'buy' / 'sell'**（其余一律当空）→ side('long'|'short') 必须显式映射。
//  - `__jevLatest` 是**全局单例**：必须校验 `latest.sym === ev.sym`，否则会跨币串味（§5.34 教训）。
//  - 入场索引必须按**时间对齐**（barT→klinesT），不能用位置。

import { onSignalEvent, sideOf } from '../tech2/signalAlerts.js';
import { winLossByAtr, atrClose } from '../engine/indicators.js';
import { THRESH } from '../engine/thresholds.js';
import { JEV_SCALP_BARS, JEV_WINDOW_MS } from '../engine/jevState.js';
// P2：统计的**单一来源**（面板与脚本共用）——本模块不再自写一套
import {
  pairStats, wilsonCI, pairGroupOf, isDecided, JE_SRSI_DECISION
} from '../engine/jevSrsiStats.js';
export { pairStats, wilsonCI, pairGroupOf, isDecided };

// 可与 Jev 意见配对的 SRSI 方向信号（有明确方向）
export const PAIR_KINDS = {
  'srsi-edge-upper': 'short',
  'srsi-edge-lower': 'long',
  'srsi-cross-buy': 'long',
  'srsi-cross-sell': 'short',
  'srsi-hook-gold': 'long',
  'srsi-hook-death': 'short'
};

export const AUDIT_TF = '15m';                                  // 裁决口径固定 15m（与卫星/SRSI 同源）
export const AUDIT_TP_ATR = THRESH.BT_TP_ATR;                   // 2
export const AUDIT_SL_ATR = THRESH.BT_SL_ATR;                   // 1.5
export const AUDIT_BARS_DEFAULT = JEV_SCALP_BARS;               // 8 根（2h）——只有用户显式确认才改
export const JEV_SIDE_THR = 15;                                 // |强度|≥15 才算有方向（与 jevClient 一致）
export const JEV_AUDIT_MIN_PAIRS = JE_SRSI_DECISION.MIN_PAIRS;  // 判定样本门槛（单一来源 jevSrsiStats）
export const JEV_AUDIT_MIN_GROUP = JE_SRSI_DECISION.MIN_GROUP;  // 每组样本门槛（单一来源）
export const JEV_AUDIT_CAP = 5000;                              // IDB 明细上限
export const JEV_AUDIT_LSK = 'smartTrader_jevAudit';            // localStorage 只存聚合快照（KB 级）
export const TSEV_TD = AUDIT_TF;                                // TSEV 样本的「口径周期」= 配对周期（15m）

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v) => (v != null && Number.isFinite(+v)) ? +v : null;

export function isPairableKind(kind) { return !!PAIR_KINDS[kind]; }

/** 当前生效的裁决根数（默认 8；由调用方通过 setAuditBars 注入用户显式确认的 N） */
let _bars = AUDIT_BARS_DEFAULT;
export function auditBars() { return _bars; }
export function setAuditBars(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v) || v <= 0) return _bars;
  _bars = Math.max(4, Math.min(32, v));
  return _bars;
}

/** 配对去重键：同一 (币, 种类, 方向, bar) 只算一次（与 signalEventKey 同构） */
export function pairKey(p) {
  if (!p) return '';
  return [p.sym || '', p.kind || '', p.side || '', p.barT != null ? p.barT : (p.ts || '')].join('|');
}

/**
 * 从 __jevLatest 取「最近一次 Jev 意见」（超短档优先，回退短档）。
 * @param latest globalThis.__jevLatest（{sym,ts,freqMs,dirs,driver}）
 * @param now    当前时刻（ms）
 * @param opts   {sym, horizon='scalp', windowMs}
 * @returns null | {ts,dir('long'|'short'|null),strength,conf,label,ageMs,stale,source,driver}
 */
export function pickJevOpinion(latest, now, opts = {}) {
  if (!latest || !latest.dirs || !Number.isFinite(+latest.ts)) return null;
  // 币对校验（全局单例，必须同币）
  if (opts.sym && latest.sym && latest.sym !== opts.sym) return null;
  const t = Number.isFinite(+now) ? +now : Date.now();
  const ageMs = t - (+latest.ts);
  const win = Number.isFinite(+opts.windowMs) && +opts.windowMs > 0
    ? +opts.windowMs
    : Math.max(2 * (num(latest.freqMs) || 0), JEV_WINDOW_MS.scalp, 3600e3);
  const stale = !(ageMs >= 0 && ageMs <= win);
  const tries = [opts.horizon || 'scalp', 'short', 'mid', 'long'];
  let d = null, source = null;
  for (const h of tries) { if (latest.dirs[h] && latest.dirs[h].strength != null) { d = latest.dirs[h]; source = h; break; } }
  if (!d) return { ts: +latest.ts, dir: null, strength: null, conf: null, label: '中性/缺', ageMs, stale, source: null, driver: latest.driver || null };
  const strength = num(d.strength);
  const dir = (strength != null && strength >= JEV_SIDE_THR) ? 'long' : (strength != null && strength <= -JEV_SIDE_THR) ? 'short' : null;
  return {
    ts: +latest.ts, dir: stale ? null : dir, strength, conf: num(d.conf),
    label: d.label || null, ageMs, stale, source, driver: latest.driver || null
  };
}

/**
 * 由一条信号事件构建配对记录（纯函数；不落库）。
 * @returns null | pair({id,ts,barT,sym,kind,side,price,K,D,band,jev,jevSide,evalTf,evalBars,...})
 */
export function pairFromEvent(ev, opts = {}) {
  if (!ev || !PAIR_KINDS[ev.kind]) return null;
  const side = sideOf(ev);
  if (side !== 'long' && side !== 'short') return null;
  const now = Number.isFinite(+opts.now) ? +opts.now : Date.now();
  const latest = opts.latest !== undefined ? opts.latest : globalThis.__jevLatest;
  const jev = latest ? pickJevOpinion(latest, now, { sym: ev.sym, horizon: opts.horizon || 'scalp', windowMs: opts.windowMs }) : null;
  const barT = Number.isFinite(+ev.barT) ? +ev.barT : null;
  const ts = Number.isFinite(+ev.ts) ? +ev.ts : now;
  const p = {
    id: '', ts, barT: barT != null ? barT : ts, sym: ev.sym || '', kind: ev.kind, side,
    price: num(ev.price), w: num(ev.w),
    K: num(opts.K), D: num(opts.D), band: opts.band || null,
    jev, jevSide: (jev && jev.dir) ? jev.dir : null,
    entryIdx: null, entryPrice: null, atr: null,
    outcome: null, matured: false,
    evalTf: AUDIT_TF, evalBars: auditBars(),
    src: ev.src || ''
  };
  p.id = pairKey(p);
  return p;
}

/**
 * P4 剩余子项：由「已判定配对」生成一条 TSEV 喂样（纯函数）。
 * 仅 win/loss 才产出（pending/expired/no-entry 一律不产出）。
 * side = 配对信号方向（long→+1 / short→−1）——即学习「15m SRSI 方向信号自身的可靠度」；
 * 与将来消费口径（confirm.fresh 时按 confirm.dir 出 side）**同源**，不得改成 Jev 方向（否则学用不一致）。
 * @returns null | {sym, ts, td, side, hit}
 */
export function tsevSampleOf(pair, outcome) {
  if (!pair || !outcome) return null;
  const st = outcome.status;
  if (st !== 'win' && st !== 'loss') return null;
  const side = pair.side === 'long' ? 1 : pair.side === 'short' ? -1 : 0;
  if (!side) return null;
  const sym = pair.sym || '';
  if (!sym) return null;
  const ts = Number.isFinite(+pair.ts) ? +pair.ts : (Number.isFinite(+pair.barT) ? +pair.barT : Date.now());
  const td = typeof pair.evalTf === 'string' && pair.evalTf ? pair.evalTf : TSEV_TD;
  return { sym, ts, td, side, hit: st === 'win' };
}

/**
 * 幂等喂样（纯函数 + 注入 feedFn）：
 *  - 已喂过（`pair.tsevFed`）→ 直接返回，不再调用 feedFn（重启动/裁剪后仍幂等）；
 *  - **喂样失败不得标记 fed**（v1.6.75 教训：标了 fed 会永久吞掉该样本）；
 *  - 非 win/loss → 不喂、不标记。
 * @returns {{pair, fed:boolean, attempted:boolean}}
 */
export function applyTsevFeed(pair, outcome, feedFn) {
  if (!pair) return { pair, fed: false, attempted: false };
  if (pair.tsevFed) return { pair, fed: true, attempted: false };
  const s = tsevSampleOf(pair, outcome);
  if (!s) return { pair, fed: false, attempted: false };
  let ok = false;
  try { ok = !!(feedFn && feedFn(s)); } catch (e) { ok = false; }
  if (!ok) return { pair, fed: false, attempted: true };
  return { pair: Object.assign({}, pair, { tsevFed: true, tsevFedAt: Date.now() }), fed: true, attempted: true };
}

// 弱引用喂样（不在 kchart.js/本模块 import localLoop —— 保持隔离红线）
function _feedTsev(s) {
  const api = globalThis.__localTsev;
  if (api && typeof api.recordJevSrsiSample === 'function') return !!api.recordJevSrsiSample(s.sym, s.ts, s.td, s.side, s.hit);
  return false;
}
/** TSEV 喂样通道是否可用（供面板/测试判断；不可用则配对正常累积，只是暂不喂 TSEV） */
export function tsevFeedAvailable() {
  const api = globalThis.__localTsev;
  return !!(api && typeof api.recordJevSrsiSample === 'function');
}

/** 时间对齐：返回最后一个 `times[i] <= t` 的下标；无 times 或找不到返回 -1（别用位置对齐） */
export function alignIdx(times, t) {
  if (!Array.isArray(times) || !times.length || !Number.isFinite(+t)) return -1;
  let lo = 0, hi = times.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (Number.isFinite(+times[mid]) && +times[mid] <= +t) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

/** 入场时点的 ATR（用该点及之前的数据算，取最后一个有限正值） */
export function lastFiniteAtr(closes, idx) {
  if (!Array.isArray(closes) || idx < 0) return null;
  try {
    const a = atrClose(closes.slice(0, idx + 1), 14);
    for (let i = a.length - 1; i >= 0; i--) { if (Number.isFinite(a[i]) && a[i] > 0) return a[i]; }
  } catch (e) { /* 忽略 */ }
  return null;
}

/**
 * 判定一条配对的前向结局（纯函数，复用 winLossByAtr）。
 * @param pair   pairFromEvent 产物
 * @param klines {closes, times} 15m 数据（times 可选；无则须给 opts.idx）
 * @param opts   {idx, bars, tpAtr, slAtr, now}
 * @returns {status:'pending'|'win'|'loss'|'expired'|'no-entry', win, pnlPct, barsHeld, exitDir, barsDone, at}
 */
export function evalPairOutcome(pair, klines, opts = {}) {
  if (!pair || !klines || !Array.isArray(klines.closes)) return { status: 'no-entry', reason: 'no-klines' };
  const closes = klines.closes;
  const bars = Number.isFinite(+opts.bars) ? Math.round(+opts.bars) : (pair.evalBars || auditBars());
  const t = Number.isFinite(+pair.barT) ? +pair.barT : +pair.ts;
  let idx = (opts.idx != null && Number.isFinite(+opts.idx)) ? +opts.idx
    : (pair.entryIdx != null && Number.isFinite(+pair.entryIdx)) ? +pair.entryIdx
    : alignIdx(klines.times, t);
  if (idx < 0 || idx >= closes.length) return { status: 'no-entry', reason: 'out-of-window' };
  const entryPrice = finite(+pair.entryPrice) && +pair.entryPrice > 0 ? +pair.entryPrice : num(closes[idx]);
  const atr = finite(+pair.atr) && +pair.atr > 0 ? +pair.atr : lastFiniteAtr(closes, idx);
  if (!(entryPrice > 0) || !(atr > 0)) return { status: 'no-entry', reason: 'no-entry-data' };
  const need = idx + bars;
  if (closes.length - 1 < need) {
    return { status: 'pending', barsDone: Math.max(0, closes.length - 1 - idx), bars };
  }
  const atrArr = new Array(need + 1).fill(atr);
  const r = winLossByAtr(closes.slice(0, need + 1), atrArr, {
    entryIdx: idx,
    // ⭐ 方向映射（勿写 'long'/'short'）：winLossByAtr 只判断 === 'buy'
    direction: pair.side === 'long' ? 'buy' : 'sell',
    tpAtr: Number.isFinite(+opts.tpAtr) ? +opts.tpAtr : AUDIT_TP_ATR,
    slAtr: Number.isFinite(+opts.slAtr) ? +opts.slAtr : AUDIT_SL_ATR,
    horizon: bars
  });
  if (!r || r.win == null) return { status: 'expired', win: 0, pnlPct: num(r && r.pnlPct) || 0, barsHeld: bars, exitDir: null, bars };
  return {
    status: r.win === 1 ? 'win' : 'loss', win: r.win, pnlPct: num(r.pnlPct),
    barsHeld: r.barsHeld, exitDir: r.exitDir, bars
  };
}

/** 增量合并（按 id 去重；新记录覆盖同 id 旧记录）——纯函数，返回 {list, added, updated} */
export function mergePairs(existing, incoming) {
  const list = Array.isArray(existing) ? existing.slice() : [];
  const idx = {};
  list.forEach((p, i) => { if (p && p.id) idx[p.id] = i; });
  let added = 0, updated = 0;
  for (const p of (Array.isArray(incoming) ? incoming : [incoming])) {
    if (!p || !p.id) continue;
    if (idx[p.id] != null) { list[idx[p.id]] = p; updated++; }
    else { idx[p.id] = list.length; list.push(p); added++; }
  }
  return { list, added, updated };
}

/** 容量裁剪（按 ts 升序留最新 cap 条）——纯函数 */
export function trimPairList(pairs, cap = JEV_AUDIT_CAP) {
  const list = (Array.isArray(pairs) ? pairs : []).filter(Boolean);
  if (list.length <= cap) return list;
  return list.slice().sort((a, b) => (+a.ts || 0) - (+b.ts || 0)).slice(-cap);
}

// ---------------------------------------------------------------------------
// 统计：canonical 实现已移到 src/engine/jevSrsiStats.js（P2 共享核心）
// 本模块只 re-export（见文件头 import/export），不在两侧各写一套。
// ---------------------------------------------------------------------------

/** 聚合快照（KB 级，仅 localStorage；明细在 IDB） */
export function aggregateSnapshot(pairs, sym) {
  try {
    const list = sym ? (pairs || []).filter(p => p.sym === sym) : (pairs || []);
    const st = pairStats(list);
    return {
      at: Date.now(), sym: sym || null, total: st.total, decided: st.decided, pending: st.pending,
      coverage: st.coverage, days: st.days,
      same: { n: st.groups.same.n, wins: st.groups.same.wins, losses: st.groups.same.losses, hitRate: st.groups.same.hitRate },
      reverse: { n: st.groups.reverse.n, wins: st.groups.reverse.wins, losses: st.groups.reverse.losses, hitRate: st.groups.reverse.hitRate },
      increment: st.increment, enough: st.enough
    };
  } catch (e) { return null; }
}

/** localStorage 安全写入：优先 kchartApi._safeSetItem（配额自愈），退化到本地 cleanup 重试 */
export function safeSetItem(key, str) {
  if (typeof localStorage === 'undefined') { try { console.warn('[JEV-AUDIT] 无 localStorage，快照跳过:', key); } catch (_) {} return false; }
  const api = globalThis.kchartApi;
  if (api && typeof api._safeSetItem === 'function') {
    try { return !!api._safeSetItem(key, str); } catch (e) { /* 继续 fallback */ }
  }
  try { localStorage.setItem(key, str); return true; }
  catch (e) {
    try {
      for (const k of Object.keys(localStorage)) {
        if (/^srsiOptHist:/.test(k) || /^smartTrader_kchart_bt/.test(k)) localStorage.removeItem(k);
      }
      localStorage.setItem(key, str);
      return true;
    } catch (e2) {
      try { console.warn('[JEV-AUDIT] localStorage 写入失败:', key, (e2 && e2.name) || e2); } catch (_) {}
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// IndexedDB（DB kchart_jev / store srsiPairs；与 jevClient 共用同一库，容量/清理集中）
// ---------------------------------------------------------------------------
const DB_NAME = 'kchart_jev';
const DB_VER = 2;
const STORE = 'srsiPairs';
let _db = null, _dbFailed = false;
let _mem = [];            // 内存镜像（面板快速读取；IDB 不可用时降级）
let _loaded = false, _loading = null;
let _lastErr = null;

function hasIDB() { return typeof indexedDB !== 'undefined'; }
function openDB() {
  return new Promise((resolve) => {
    if (!hasIDB()) return resolve(null);
    try {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('decisions')) {
          const st0 = d.createObjectStore('decisions', { keyPath: 'id' });
          st0.createIndex('ts', 'ts', { unique: false });
          st0.createIndex('sym', 'sym', { unique: false });
        }
        if (!d.objectStoreNames.contains(STORE)) {
          const st = d.createObjectStore(STORE, { keyPath: 'id' });
          st.createIndex('ts', 'ts', { unique: false });
          st.createIndex('sym', 'sym', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { _lastErr = 'open:' + ((req.error && req.error.name) || 'err'); resolve(null); };
      req.onblocked = () => { resolve(null); };
    } catch (e) { _lastErr = 'open:' + ((e && e.name) || e); resolve(null); }
  });
}
async function db() {
  if (_dbFailed) return null;
  if (_db) return _db;
  _db = await openDB();
  if (!_db) _dbFailed = true;
  return _db;
}
function idbReq(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }

/** 载入明细到内存镜像（幂等；force=true 强制重读） */
export async function loadPairs(force) {
  if (_loaded && !force) return _mem;
  if (_loading) return _loading;
  _loading = (async () => {
    const d = await db();
    if (!d) { _loaded = true; return _mem; }
    try {
      const tx = d.transaction(STORE, 'readonly');
      const all = await idbReq(tx.objectStore(STORE).getAll());
      all.sort((a, b) => (+a.ts || 0) - (+b.ts || 0));
      _mem = all;
      _lastErr = null;
    } catch (e) { _lastErr = 'read:' + ((e && e.name) || e); }
    _loaded = true;
    return _mem;
  })();
  return _loading;
}

export function memoryPairs() { return _mem; }
export function auditLastErr() { return _lastErr; }

/** 写入一条配对（更新内存 + IDB；同 id 覆盖） */
export async function putPair(pair) {
  if (!pair || !pair.id) return false;
  const m = mergePairs(_mem, pair);
  _mem = m.list;
  writeSnapshot();
  const d = await db();
  if (!d) return false;
  try {
    const tx = d.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(pair);
    return true;
  } catch (e) {
    _lastErr = 'put:' + ((e && e.name) || e);
    try { console.warn('[JEV-AUDIT] IndexedDB 写入失败（已保留内存）:', _lastErr); } catch (_) {}
    return false;
  }
}

/** 批量写（回填用） */
export async function putPairs(pairs) {
  const arr = (Array.isArray(pairs) ? pairs : []).filter(p => p && p.id);
  if (!arr.length) return 0;
  _mem = mergePairs(_mem, arr).list;
  writeSnapshot();
  const d = await db();
  if (!d) return 0;
  try {
    const tx = d.transaction(STORE, 'readwrite');
    const st = tx.objectStore(STORE);
    for (const p of arr) st.put(p);
    return arr.length;
  } catch (e) {
    _lastErr = 'putMany:' + ((e && e.name) || e);
    try { console.warn('[JEV-AUDIT] IndexedDB 批量写入失败（已保留内存）:', _lastErr); } catch (_) {}
    return 0;
  }
}

/** 容量裁剪（IDB 超上限删最旧） */
export async function trimPairs() {
  if (_mem.length <= JEV_AUDIT_CAP) return 0;
  const keep = trimPairList(_mem, JEV_AUDIT_CAP);
  const dropIds = _mem.filter(p => !keep.includes(p)).map(p => p.id);
  _mem = keep;
  const d = await db();
  if (!d) return dropIds.length;
  try {
    const tx = d.transaction(STORE, 'readwrite');
    const st = tx.objectStore(STORE);
    for (const id of dropIds) st.delete(id);
  } catch (e) { _lastErr = 'trim:' + ((e && e.name) || e); }
  return dropIds.length;
}

export async function clearPairs() {
  _mem = [];
  writeSnapshot();
  const d = await db();
  if (!d) return false;
  try {
    const tx = d.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    return true;
  } catch (e) { _lastErr = 'clear:' + ((e && e.name) || e); return false; }
}

function writeSnapshot() {
  try {
    const snap = aggregateSnapshot(_mem, null);
    if (snap) safeSetItem(JEV_AUDIT_LSK, JSON.stringify(snap));
  } catch (e) { /* 快照失败不影响明细 */ }
}

// ---------------------------------------------------------------------------
// 记录管线（订阅事件流 + 到期回填）
// ---------------------------------------------------------------------------
let _installed = false;
const _listeners = [];
export function onAuditChange(cb) { if (typeof cb === 'function' && !_listeners.includes(cb)) _listeners.push(cb); }
function emitChange() { for (const cb of _listeners) { try { cb(); } catch (e) { /* 单个订阅者失败不影响其它 */ } } }

/** 记录一条配对（去重 + 落库 + 通知面板） */
export async function recordPair(pair) {
  if (!pair || !pair.id) return null;
  if (_mem.some(p => p && p.id === pair.id)) return null;
  await putPair(pair);
  emitChange();
  return pair;
}

/** 安装事件订阅（幂等；只装一次）。捕获 directional SRSI 事件 → 配对。 */
export function initJevSrsiAudit(opts = {}) {
  if (_installed) return false;
  _installed = true;
  if (opts.bars) setAuditBars(opts.bars);
  onSignalEvent((ev) => {
    try {
      if (!ev || !PAIR_KINDS[ev.kind]) return;
      const pair = pairFromEvent(ev, { latest: globalThis.__jevLatest, now: Date.now(), K: opts.K, D: opts.D, band: opts.band });
      if (pair) recordPair(pair);
    } catch (e) {
      try { console.warn('[JEV-AUDIT] 配对失败:', (e && e.message) || e); } catch (_) {}
    }
  });
  loadPairs(true).then(() => emitChange()).catch(() => {});
  return true;
}

/** 取 15m 行情（closes/times）——只读 window.S，无网络 */
function klines15(sym) {
  const S = globalThis.S || {};
  const closes = (S.klines && S.klines[sym] && S.klines[sym][AUDIT_TF]) || null;
  const times = (S.klinesT && S.klinesT[sym] && S.klinesT[sym][AUDIT_TF]) || null;
  if (!Array.isArray(closes) || !closes.length) return null;
  return { closes, times: Array.isArray(times) ? times : null };
}

/**
 * 到期回填：对未结算配对算结局并落库。返回 {checked, matured, pending}。
 * 供 PWA 每秒循环调用（内部由调用方节流，例如 5min）。
 */
export async function tickJevSrsiPairs() {
  await loadPairs();
  const list = _mem.filter(p => p && !p.matured);
  if (!list.length) return { checked: 0, matured: 0, pending: 0, fed: 0 };
  const updated = [];
  let matured = 0, pending = 0, fed = 0;
  for (const p of list) {
    try {
      const kl = klines15(p.sym);
      if (!kl) { pending++; continue; }
      const o = evalPairOutcome(p, kl, { bars: p.evalBars || auditBars() });
      if (o.status === 'pending') { pending++; continue; }
      let np = Object.assign({}, p, { entryIdx: (p.entryIdx != null && Number.isFinite(+p.entryIdx)) ? p.entryIdx : alignIdx(kl.times, p.barT || p.ts), outcome: o, matured: true, maturedAt: Date.now() });
      // P4 剩余子项：仅 win/loss 喂 TSEV（幂等；喂样失败不标 fed）
      const fr = applyTsevFeed(np, o, _feedTsev);
      np = fr.pair;
      if (fr.attempted && fr.fed) fed++;
      updated.push(np);
      matured++;
    } catch (e) { pending++; }
  }
  if (updated.length) {
    await putPairs(updated);
    try { await trimPairs(); } catch (e) { /* 裁剪失败不阻塞 */ }
    emitChange();
  }
  return { checked: list.length, matured, pending, fed };
}
