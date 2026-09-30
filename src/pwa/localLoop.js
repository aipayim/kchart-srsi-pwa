// 本机 TSEV 自学习 loop（浏览器/PWA 专用，Node 不引入）
// 作用：PWA 打开期间，用本机已加载的 K线数据跑「纪律方向 → 前向 ATR 判盈亏」样本，
//       累积进 IndexedDB，并本地训练 TSEV 权重；权重「本机优先」合并进 kchart.js 的投票。
// 两种数据来源：
//   1) 增量 loop（每 60min）：对当前币用已加载实时 K线 walk-forward 采样（1h 粒度）。
//   2) 首次回补（backfill）：对 PWA 可选的全部币种拉取最近 N 年历史(默认4年，4h粒度)，
//      离线算出因子态统计写入同一 _stats。这样首开即可用本机权重，无需联网服务器。
// 存储为紧凑的「每因子按周分桶统计」{key:{buckets:{[周索引]:{n,h}}}}（总量仅几 KB），规避移动端 IndexedDB 配额；
// 训练期按样本真实时间做近期加权(见 disciplineAnalysis.aggregateBuckets)，旧行情自动淡出、近期 regime 主导。
import { analyzeTradeDiscipline } from '../tech2/kchart.js';
import { atrClose } from '../engine/indicators.js';
import { JEV_HORIZON_IDS } from '../engine/jevState.js';
import { trainTsevWeights, trainTsevWeightsStats, forwardAccuracy as calcForwardAccuracy, factorStatsTable, rollingAccuracy, guardDecision, weightFingerprint, TSEV_CFG } from '../engine/disciplineAnalysis.js';

const DB_NAME = 'kchart_pwa';
const STORE = 'disc';
const KEY = 'samples';
const EVAL_TF_LIVE = '1h';
const TFS_LIVE = ['15m', '1h', '4h'];
const EVAL_TF_BACK = '4h';
const TFS_BACK = ['4h', '1d'];
const HIST_BARS = 80;
const BARS = 300;
const MAIN = '1h';
const STRIDE = 1;
const INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_BACKFILL_YEARS = 4;
// ---- P5：权重版本化 + 退化守卫 + 学习曲线（GOAL_jev-srsi §7）----
const VER_KEY = 'pwa_tsev_ver';     // 每日权重快照（上限 VER_CAP，KB 级；走 _safeSetItem 配额自愈）
const VER_CAP = 20;
const GUARD_N = 50;                 // 退化守卫：每币最近 N 个已判定样本
const GUARD_MIN_DECIDED = 10;       // 任一侧可判决样本少于此 → 不判断（insufficient）
const GUARD_MARGIN = 0.02;          // 新权重准确率落后超过 2pp 才回退（防噪声抖动）
const GUARD_GAP_MS = 30 * 60 * 1000;// 守卫最小间隔（30min），避免频繁 churn
const JEV_SRSI_TF = '15m';          // SRSI 对齐因子族口径（与 P1 配对 AUDIT_TF 一致）
const SRSI_CFG = { rsiPeriod: 85, stochPeriod: 50, stochK: 10, stochD: 5, overbought: 80, oversold: 20 };
// 不同评估轴对应的「未来 N 根」偏移（用于方向标签 dirLabel）
const FUT_BARS = {
  '1h': { h4: 4, d1: 24, d3: 72 },
  '4h': { h4: 1, d1: 6, d3: 18 }
};

let _db = null;
let _stats = {};              // key -> {buckets:{[周索引]:{n,h}}}  按周分桶聚合统计（key 含 sym 前缀：sym|name|cond|side）
let _sampleCount = 0;         // 总行数（含被因子过滤前的样本）
let _sampledTs = {};          // sym -> Set(已采样评估根时间戳)，防止 60min loop 重复累加同一根
let _perSym = {};             // sym -> {total, done, backfilled}
let _localWeights = {};       // 训练后的本机权重（按币种）：{ [sym]: { 'name|cond|side': w } }
let _localN = 0;
let _rows = {};               // 验证缓冲（仅内存，不持久化）：{ [sym]: [{factors, raw}] }，用于前向准确度回测
let _verFull = [];            // P5：权重版本快照（含权重本体；仅在内存，权威副本）
let _verLoaded = false;
let _guardHistory = [];       // P5：退化守卫回滚历史（内存，最近若干条）
let _guardLogKey = '';        // P5：守卫日志去重键（sym|权重指纹）
let _lastGuardAt = 0;         // P5：上次守卫时间（间隔闸门）
let _rejected = {};          // P5：被守卫拒绝的权重（粘性）{ [sym]: {fp, weights, at} }（仅内存）
const ROW_CAP = 6000;         // 每币最多保留样本数（环形覆盖，保证 walk-forward 有足够 test 集）
let _enabled = true;
let _timer = null;
let _backfilling = false;
let _progress = { sym: '', pct: 0 };
let _onTrained = null;
let _onProgress = null;
let _getSym = null;
let _getSymList = null;
const _status = { running: false, lastRun: 0, sampleCount: 0, enabled: true, backfilling: false };

function hasIDB() { return typeof indexedDB !== 'undefined'; }

function openDB() {
  return new Promise((resolve) => {
    if (!hasIDB()) return resolve(null);
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

function idbGet(key) {
  return new Promise((resolve) => {
    if (!_db) return resolve(null);
    try {
      const tx = _db.transaction(STORE, 'readonly');
      const rq = tx.objectStore(STORE).get(key);
      rq.onsuccess = () => resolve(rq.result != null ? rq.result : null);
      rq.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

function idbSet(key, val) {
  return new Promise((resolve) => {
    if (!_db) return resolve(false);
    try {
      const tx = _db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(val, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch { resolve(false); }
  });
}

async function loadSamples() {
  const v = await idbGet(KEY);
  // v:5 起训练标签改用「1日尺度 ATR 触达方向(dirLabel)」而非裸 4h 符号：前者是真实价动方向，
  // 趋势因子命中上限显著高于恒定基准率的裸符号。旧 v:4 的 4h 符号标签统计与新标签不可混，故直接丢弃并触发全量重补。
  if (v && v.v === 5 && v.stats) {
    _stats = v.stats || {};
    _sampleCount = v.sampleCount || 0;
    _perSym = v.perSym || {};
    // 恢复去重集合（防止重补中途刷新导致重复累加）；结构化克隆保留 Set，防御性回退
    const st = (v.sampledTs) || {};
    _sampledTs = {};
    for (const s in st) _sampledTs[s] = (st[s] instanceof Set) ? st[s] : new Set(st[s]);
    // 迁移：旧版本曾在 fetch 失败时误置 backfilled=true 且 total=0，导致永久跳过回补 → 清除使其重试
    for (const s in _perSym) {
      const p = _perSym[s];
      if (p && p.backfilled && (!p.total || p.error)) { delete p.backfilled; }
    }
  } else {
    // 旧格式（v2 的 {n,h} 聚合或无版本号）：结构已变（改为按周分桶 + 训练期近期加权），
    // 直接清空并触发全量回补，使新结构生效、旧混合历史被近期加权正确淡出。
    _stats = {};
    _sampleCount = 0;
    _perSym = {};
    _sampledTs = {};
    await persistSamples();
  }
  _status.sampleCount = _sampleCount;
}

async function persistSamples() {
  await idbSet(KEY, { v: 5, stats: _stats, sampleCount: _sampleCount, perSym: _perSym, sampledTs: _sampledTs });
}

function keyOf(sym, f) { return sym + '|' + f.name + '|' + f.cond + '|' + f.side; }

// 方向标签（趋势/动量，B 改进）：若未来 horizon 根内价格触及 ±1×ATR（真实波动），按触达方向定标签；
// 否则回退到「净符号」(终点相对起点)。非扁平（返回 +1/-1/0）。用 ATR 触达而非裸终点符号，使趋势因子
// 预测的是「真实的价动方向」而非微小抖动，命中上限显著高于裸 4h 符号（基准率≈50%）。
function dirLabel(price, i, horizon, atrArr) {
  const atr = (atrArr && atrArr[i]) || 0;
  if (atr > 0) {
    for (let k = i + 1; k <= i + horizon && k < price.length; k++) {
      const d = price[k] - price[i];
      if (d >= atr) return 1;
      if (d <= -atr) return -1;
    }
  }
  const j = i + horizon;
  if (j >= price.length) return 0;
  const d = price[j] - price[i];
  return d > 0 ? 1 : (d < 0 ? -1 : 0);
}

function addRow(row) {
  const futDir = row.futDir;
  if (!futDir) return;
  const lab = futDir.d1; // 训练标签：1日尺度方向（B 改进）
  if (lab == null) return; // 末尾样本无 d1 标签，跳过避免污染 n/h
  const fs = row.factors || [];
  const sym = row.sym || '';
  // 按样本真实时间分桶（周索引），训练期做近期加权；缺 ts 时回退到“当前周”避免丢样本
  const ts = (typeof row.ts === 'number' && row.ts > 0) ? row.ts : Date.now();
  const wk = Math.floor(ts / (7 * 86400000));
  for (const f of fs) {
    if (!f || f.side === 0) continue;
    const k = keyOf(sym, f);
    const a = _stats[k] || (_stats[k] = { buckets: {} });
    if (!a.buckets) a.buckets = {};   // 防御：importSamples 可能写入旧 {n,h} 形状条目
    const b = a.buckets[wk] || (a.buckets[wk] = { n: 0, h: 0 });
    b.n++;
    // hit = 因子 side 与「1日尺度未来方向」同向的样本数（dirLabel：ATR 触达 / 净符号）。训练标签
    // 用真实价动方向而非裸 4h 符号，使趋势因子命中上限显著高于恒定基准率的裸符号。
    b.h += (lab === f.side) ? 1 : 0;
  }
  _sampleCount++;
  // 验证缓冲（仅内存）：保留 factors 与真实未来方向 raw/futDir，供前向准确度回测（walk-forward、各周期）
  if (row.raw != null) {
    const buf = _rows[sym] || (_rows[sym] = []);
    buf.push({ factors: fs, raw: row.raw, futDir });
    if (buf.length > ROW_CAP) buf.splice(0, buf.length - ROW_CAP);
  }
}

// 从 _stats 纯计算出各币权重（不落盘、不改全局状态）
function computeWeights() {
  const out = {};
  const syms = new Set();
  for (const k in _stats) { const s = k.indexOf('|'); if (s > 0) syms.add(k.slice(0, s)); }
  for (const sym of syms) {
    const prefix = sym + '|';
    const stats = {};
    for (const k in _stats) {
      if (k.startsWith(prefix)) stats[k.slice(prefix.length)] = _stats[k];
    }
    if (Object.keys(stats).length) {
      const w = trainTsevWeightsStats(stats, { MIN_SAMPLE: TSEV_CFG.LOCAL_FACTOR_MIN, Z_THRESH: TSEV_CFG.Z_THRESH, recencyHalfLifeDays: TSEV_CFG.LOCAL_RECENCY_HALFLIFE_DAYS });
      if (Object.keys(w).length) out[sym] = w;
    }
  }
  return out;
}

// P5 退化守卫（逐币，**粘性**）：
//  - 新权重在最近 GUARD_N 个已判定样本上准确率落后旧权重超过 GUARD_MARGIN → 保留旧权重；
//  - **被拒绝的权重指纹会被记住**（`_rejected[sym]`）：同一版坏权重后续 train() 直接不采用，
//    否则同一次训练窗口（30min）内的下一次 train() 会把坏权重再装回去（实测踩坑）；
//  - 权重指纹变了但本次无法评估（守卫间隔未到）→ 保守沿用已接受的权重；
//  - 样本不足（decided < GUARD_MIN_DECIDED）→ 不判断（采用新权重）。
function guardLog(sym, fp, g) {
  const key = sym + '|' + fp;
  if (key === _guardLogKey) return;   // 同一版坏权重只记一次（防刷屏）
  _guardLogKey = key;
  _guardHistory.push({ at: Date.now(), sym, accNew: g.accNew, accPrev: g.accPrev, decidedNew: g.decidedNew, decidedPrev: g.decidedPrev, delta: g.delta });
  if (_guardHistory.length > 20) _guardHistory.splice(0, _guardHistory.length - 20);
  try { console.log('[TSEV-GUARD] 回退', sym, '新权重命中率 ' + ((g.accNew || 0) * 100).toFixed(1) + '% < 旧 ' + ((g.accPrev || 0) * 100).toFixed(1) + '%（n=' + g.decidedNew + '/' + g.decidedPrev + '）→ 保留上一版权重'); } catch (e) {}
}

function train() {
  const prevW = _localWeights;
  const freshW = computeWeights();
  const out = {};
  try {
    const hasRows = Object.keys(_rows).some(s => _rows[s] && _rows[s].length);
    const gapOk = hasRows && (Date.now() - _lastGuardAt >= GUARD_GAP_MS);
    if (gapOk) _lastGuardAt = Date.now();
    for (const sym in freshW) {
      const nw = freshW[sym];
      if (!nw) continue;
      const fp = weightFingerprint(nw);
      const rej = _rejected[sym];
      const pw = prevW ? prevW[sym] : null;
      if (rej && rej.fp === fp) { out[sym] = rej.weights; continue; }   // 已判过的同一版坏权重 → 不采用
      if (gapOk) {
        const g = guardDecision(_rows[sym] || [], nw, pw, { n: GUARD_N, minDecided: GUARD_MIN_DECIDED, margin: GUARD_MARGIN });
        if (g.action === 'revert' && pw) {
          out[sym] = pw;
          _rejected[sym] = { fp, weights: pw, at: Date.now() };
          guardLog(sym, fp, g);
          continue;
        }
      } else if (rej && rej.fp !== fp) {
        out[sym] = rej.weights;   // 有活跃回退但本次无法评估 → 保守沿用已接受的权重
        continue;
      }
      out[sym] = nw;
      if (rej) delete _rejected[sym];   // 该轮已重新评估且未被拒绝 → 解除回退
    }
  } catch (e) { /* 守卫失败不得影响训练主路径 */ }
  _localWeights = Object.keys(out).length ? out : freshW;
  _localN = _sampleCount;
  _status.sampleCount = _sampleCount;
  try { maybeSnapshot(); } catch (e) { /* 快照失败不影响训练 */ }
  return _localWeights;
}

// ---- P5：权重版本化（每日快照，上限 VER_CAP，一键回滚）----
function _lskGet(key) {
  try { return (typeof localStorage !== 'undefined') ? localStorage.getItem(key) : null; } catch (e) { return null; }
}
function _lskSet(key, str) {
  try {
    const api = globalThis.kchartApi;
    if (api && typeof api._safeSetItem === 'function') return !!api._safeSetItem(key, str);   // 配额自愈（§5.30 红线）
  } catch (e) { /* fallthrough */ }
  try { if (typeof localStorage !== 'undefined') { localStorage.setItem(key, str); return true; } } catch (e) {}
  return false;
}
function _cloneWeights(W) {
  const o = {};
  for (const s in (W || {})) { const m = W[s]; if (!m) continue; const c = {}; for (const k in m) c[k] = m[k]; o[s] = c; }
  return o;
}
function _hasWeightContent(W) { return !!W && Object.keys(W).some(s => W[s] && Object.keys(W[s]).filter(k => !k.startsWith('__')).length); }
function verLoad(force) {
  if (_verLoaded && !force) return _verFull;
  let arr = [];
  try { const raw = _lskGet(VER_KEY); const j = raw ? JSON.parse(raw) : []; if (Array.isArray(j)) arr = j.filter(v => v && v.weights); } catch (e) { arr = []; }
  _verFull = arr.slice(-VER_CAP);
  _verLoaded = true;
  return _verFull;
}
function verSave() { return _lskSet(VER_KEY, JSON.stringify(_verFull.slice(-VER_CAP))); }
function maybeSnapshot() {
  verLoad();
  if (!_hasWeightContent(_localWeights)) return false;   // 空权重不建版
  const day = new Date().toISOString().slice(0, 10);
  const last = _verFull[_verFull.length - 1];
  if (last && last.day === day) return false;            // 每天最多一版
  _verFull.push({ at: Date.now(), day, weights: _cloneWeights(_localWeights), sampleCount: _sampleCount, factors: factorCount() });
  if (_verFull.length > VER_CAP) _verFull.splice(0, _verFull.length - VER_CAP);
  verSave();
  return true;
}
/** 权重版本列表（元数据，不含权重本体） */
export function listWeightVersions() {
  const list = verLoad();
  return list.map((v, i) => ({ idx: i, at: v.at, day: v.day, sampleCount: v.sampleCount, factors: v.factors, syms: Object.keys(v.weights || {}).length }));
}
/**
 * 一键回滚到某个权重版本。ref: 索引(idx) | 'YYYY-MM-DD' | 时间戳字符串 | 缺省=最近一版。
 * 说明：回滚后由**退化守卫继续保护**——若后续训练出的新权重实测更优，会自动再次采用（“以实测为准”）。
 */
export function rollbackWeights(ref) {
  const list = verLoad();
  if (!list.length) return false;
  let v = null;
  if (typeof ref === 'number' && Number.isFinite(ref)) v = (ref >= 0 && ref < list.length) ? list[ref] : (ref < 0 ? list[list.length - 1] : null);
  else if (typeof ref === 'string' && ref) v = list.find(x => x.day === ref) || list.find(x => String(x.at) === ref) || null;
  else v = list[list.length - 1];
  if (!v || !_hasWeightContent(v.weights)) return false;
  _localWeights = _cloneWeights(v.weights);
  _localN = _sampleCount;
  try { console.log('[TSEV-ROLLBACK] 回滚到', v.day, '· 样本', v.sampleCount, '· 因子', v.factors); } catch (e) {}
  return true;
}
/** 学习曲线（面板用）：滚动命中率（近 20/50/全部）+ 版本数 + 最近守卫回退记录 */
export function learningCurve(sym) {
  const s = sym || '';
  const rows = _rows[s] || [];
  const W = _localWeights[s] || {};
  const rc = rollingAccuracy(rows, W, [20, 50, 0]);
  return Object.assign({ sym: s, rows: rows.length, versions: listWeightVersions().length, guard: _guardHistory.slice(-5) }, rc);
}

function factorCount() {
  let n = 0;
  for (const s in _localWeights) n += Object.keys(_localWeights[s]).filter(k => !k.startsWith('__')).length;
  return n;
}
function factorCountFor(sym) { return _localWeights[sym] ? Object.keys(_localWeights[sym]).filter(k => !k.startsWith('__')).length : 0; }

// walk-forward 采样（纯函数，无 S 依赖）：给定 priceMap（含 evalTf 与各 tf 的 closes 数组），
// 返回 rows: { sym, ts, factors, futDir, raw }。供实时 loop 与历史回补共用。
// evalTimes：与 priceMap[evalTf] 对齐的时间戳数组（用于 ts 去重键），缺省用索引 i。
function samplePriceMap(priceMap, sym, srsiCfg, evalTf, tfs, evalTimes) {
  const ev = priceMap[evalTf];
  if (!ev || ev.length < HIST_BARS + 10) return [];
  const futBars = FUT_BARS[evalTf] || FUT_BARS['1h'];
  const rows = [];
  const klineSel = {};
  tfs.forEach(tf => { klineSel[tf] = true; });
  const useTs = evalTimes && evalTimes.length === ev.length;
  for (let i = HIST_BARS; i < ev.length - 1; i += STRIDE) {
    const pm = {};
    let ok = true;
    for (const tf of tfs) {
      const c = priceMap[tf];
      if (!c || c.length <= i) { ok = false; break; }
      pm[tf] = c.slice(0, i + 1);
    }
    if (!ok) continue;
    let a;
    try {
      a = analyzeTradeDiscipline(pm, srsiCfg, { bars: BARS, mainTF: evalTf, klineSel, capMin: 240, deadZone: 0.5, deadMode: 'fixed' });
    } catch { continue; }
    if (!a || !a.factors || !a.factors.length) continue;
    const factors = a.factors;
    const futDir = {};
    const atrArr = atrClose(ev, 14);
    for (const k in futBars) {
      const j = i + futBars[k];
      if (ev.length > j) futDir[k] = dirLabel(ev, i, futBars[k], atrArr);
    }
    // 训练/验证标签（B 改进）：用 1 日(d1)时间尺度的 ATR 触达方向，而非裸 4h 符号 → 趋势因子命中上限更高
    const mainHorizon = futBars.d1 || (futBars.h4 || 4);
    const raw = dirLabel(ev, i, mainHorizon, atrArr);
    rows.push({ sym, ts: useTs ? evalTimes[i] : i, factors, futDir, raw });
  }
  return rows;
}

// 用本机已加载的 K线（S.klines / S.klinesT）对一个币做 walk-forward 采样（1h 粒度）
export async function collectSymbol(sym) {
  const S = globalThis.S;
  if (!S || !S.klines || !S.klines[sym]) return 0;
  const priceMap = {};
  for (const tf of TFS_LIVE) {
    const c = S.klines[sym] && S.klines[sym][tf];
    if (!c || c.length < 2) { priceMap[tf] = []; continue; }
    priceMap[tf] = c;
  }
  const sev = priceMap[EVAL_TF_LIVE];
  if (!sev || sev.length < HIST_BARS + 10) return 0;
  const evalTimes = (S.klinesT && S.klinesT[sym] && S.klinesT[sym][EVAL_TF_LIVE]) || null;
  const rows = samplePriceMap(priceMap, sym, SRSI_CFG, EVAL_TF_LIVE, TFS_LIVE, evalTimes);
  if (!rows.length) { train(); return 0; }
  const seen = _sampledTs[sym] || (_sampledTs[sym] = new Set());
  let added = 0;
  for (const r of rows) {
    if (seen.has(r.ts)) continue;
    seen.add(r.ts);
    addRow(r);
    added++;
  }
  if (added > 0) { await persistSamples(); train(); }
  else { train(); }
  return added;
}

async function runOnce() {
  if (!_enabled) return;
  const S = globalThis.S;
  if (!S) return;
  _status.running = true;
  try {
    const sym = (typeof _getSym === 'function' && _getSym()) || (S.sel) || 'BTCUSDT';
    const n = await collectSymbol(sym);
    if (n > 0) { if (_onTrained) { try { _onTrained(); } catch {} } }
    _status.lastRun = Date.now();
  } finally {
    _status.running = false;
  }
}

// ---- 历史回补（多币、最近 N 年、4h 粒度）----
async function fetchKlinesRange(sym, tf, startTime, endTime, onProgress) {
  const mod = await import('./data.js');
  return mod.fetchKlinesRange(sym, tf, startTime, endTime, onProgress);
}

async function backfillSymbol(sym, years) {
  const now = Date.now();
  const start = now - (years || DEFAULT_BACKFILL_YEARS) * 365 * 24 * 3600 * 1000;
  _perSym[sym] = _perSym[sym] || {};
  _perSym[sym].total = null;
  _perSym[sym].done = 0;
  _perSym[sym].error = null;
  emitProgress();
  let c4 = { closes: [] }, c1 = { closes: [] };
  try {
    const [r4, r1] = await Promise.all([
      fetchKlinesRange(sym, '4h', start, now, () => emitProgress()),
      fetchKlinesRange(sym, '1d', start, now, () => emitProgress())
    ]);
    if (r4 && r4.closes) c4 = r4;
    if (r1 && r1.closes) c1 = r1;
  } catch (e) {}
  // 数据源完全不可达：标记 error 但不置 backfilled，下一轮加载会重试（避免误判为已完成而永久停用）
  if (!c4.closes.length && !c1.closes.length) {
    _perSym[sym].error = '数据源不可达';
    emitProgress();
    await persistSamples();
    return;
  }
  const priceMap = { '4h': c4.closes, '1d': c1.closes };
  const evalTimes = c4.times || null;
  const rows = samplePriceMap(priceMap, sym, SRSI_CFG, EVAL_TF_BACK, TFS_BACK, evalTimes);
  _perSym[sym].total = rows.length;
  const seen = _sampledTs[sym] || (_sampledTs[sym] = new Set());
  for (let i = 0; i < rows.length; i += 200) {
    for (let j = i; j < Math.min(i + 200, rows.length); j++) {
      if (seen.has(rows[j].ts)) continue;
      seen.add(rows[j].ts);
      addRow(rows[j]);
    }
    _perSym[sym].done = Math.min(i + 200, rows.length);
    emitProgress();
    await new Promise(r => setTimeout(r, 0)); // 让出主线程，避免冻屏
  }
  // 仅在真正采到样本时才标记完成；0 样本（如历史接口异常）留待下次重试
  if (rows.length > 0) { _perSym[sym].backfilled = true; delete _perSym[sym].error; }
  else _perSym[sym].error = '采得0样本';
  await persistSamples();
}

export async function backfillAll(syms, years) {
  if (!_enabled || _backfilling) return;
  const list = (syms || []).filter(Boolean);
  if (!list.length) return;
  _backfilling = true;
  _status.backfilling = true;
  try {
    for (const sym of list) {
      if (_perSym[sym] && _perSym[sym].backfilled) continue;
      _progress = { sym, pct: 0 };
      emitProgress();
      try { await backfillSymbol(sym, years || DEFAULT_BACKFILL_YEARS); }
      catch (e) { /* 单币失败跳过 */ }
      train();
      if (_onTrained) { try { _onTrained(); } catch {} }
    }
  } finally {
    _backfilling = false;
    _status.backfilling = false;
    _progress = { sym: '', pct: 0 };
    emitProgress();
    await persistSamples();
  }
}

function emitProgress() {
  if (_onProgress) {
    _onProgress({
      backfilling: _backfilling,
      sym: _progress.sym,
      pct: _progress.pct,
      perSym: _perSym,
      sampleCount: _sampleCount,
      factorCount: factorCount(),
      enabled: _enabled
    });
  }
}

export function onProgress(cb) { if (typeof cb === 'function') _onProgress = cb; }

export async function init() {
  _db = await openDB();
  await loadSamples();
  try { verLoad(true); } catch (e) { /* 版本列表读取失败不影响训练 */ }
  train();
  _status.enabled = _enabled;
}

export function start() {
  if (_timer) return;
  _timer = setInterval(() => { runOnce().catch(() => {}); }, INTERVAL_MS);
  // 打开后立即尝试；若 K线 尚未加载完成会返回 0，故短间隔重试直到首次采到样本（最多 ~96s）
  let attempts = 0;
  const trySoon = () => {
    runOnce().then(() => {
      if (_sampleCount === 0 && attempts < 12) { attempts++; setTimeout(trySoon, 8000); }
    }).catch(() => {
      if (_sampleCount === 0 && attempts < 12) { attempts++; setTimeout(trySoon, 8000); }
    });
  };
  trySoon();
}

// 切换交易对 / K线刷新后手动触发一次采样（数据已就绪时立即累积当前币样本）
export function kick() {
  if (_enabled) runOnce().catch(() => {});
}

export function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

export function setEnabled(v) {
  _enabled = !!v;
  _status.enabled = _enabled;
  if (_enabled) start();
  else stop();
}

export function status() {
  return { ..._status, sampleCount: _sampleCount, factorCount: factorCount(), backfilling: _backfilling, progress: _progress, perSym: _perSym, verCount: verLoad().length, guardN: _guardHistory.length };
}

export function getStats() {
  return { sampleCount: _sampleCount, factorCount: factorCount(), source: (Object.keys(_localWeights).length ? 'local' : 'classic'), backfilling: _backfilling, perSym: _perSym };
}

export function getWeights() {
  let total = 0;
  for (const s in _localWeights) total += Object.keys(_localWeights[s]).length;
  return total ? { perSym: _localWeights, n: _localN } : null;
}

/**
 * 外部样本注入（Jev 判断当因子）：与 addRow 同格式（按周分桶），供到期回填后调用。
 * 因子键 = `<sym>|jev|<horizon>|<side>` → 训练后权重名 `jev|<horizon>|<side>`。
 * 只写「按周分桶统计」而非原始样本，写入量极小（数 KB），遵守 §5.30 配额红线。
 *
 * 关掉 Jev 后：本函数不再被调用，但**已写入的 _stats 与训练出的权重仍在 IndexedDB/内存中保留**
 * （train() 会继续把 jev|* 一起训练进去），故「本机学到的 Jev 可信度」不会因关 Jev 而丢失。
 */
export function recordJevSample(sym, tsMs, horizon, side, hit) {
  if (!sym || !horizon) return false;
  const s = Number(side);
  if (s !== 1 && s !== -1) return false;
  // ⭐ v1.6.71 修复：旧正则写死 `short|mid|long`，导致 P0 新增的「超短档 scalp」样本被**静默拒绝**
  //   （表现为面板「超短档已判定 15 笔」但「本机 TSEV 独立样本 0/50」永远不增长）。
  //   改用 JEV_HORIZON_IDS 单一来源（含 scalp），避免新增档位时再次漏掉。
  if (JEV_HORIZON_IDS.indexOf(String(horizon)) < 0) return false;
  return _recordBucket(sym + '|jev|' + horizon + '|' + s, tsMs, hit);
}

/**
 * P4 剩余子项：SRSI 对齐因子族样本（键 `<sym>|jev_srsi|<td>|<side>`）—— 样本来自 P1 配对结果「命中即喂」。
 * td = 配对口径周期（默认 '15m'，与 jevSrsiAudit.AUDIT_TF 一致）；side = 配对信号方向（long→+1/short→−1）；
 * hit = 该配对是否命中（win）。写按周分桶统计（数 KB），train() 会自动把它一并训练 → debugTsev 可见。
 * ⭐ 本批**只喂样 + 可视化**；消费端（extractDisciplineFactors）故意未接——待 P2 统计裁决通过并由用户确认后再接
 *   （GOAL_jev-srsi §6.2/§10 闸门），以免用未裁决的统计改动纪律方向（显示层）。
 */
export function recordJevSrsiSample(sym, tsMs, td, side, hit) {
  if (!sym) return false;
  const s = Number(side);
  if (s !== 1 && s !== -1) return false;
  const tf = (typeof td === 'string' && /^[0-9]+[mhd]$/.test(td)) ? td : JEV_SRSI_TF;
  return _recordBucket(sym + '|jev_srsi|' + tf + '|' + s, tsMs, hit);
}

// 共用：按周分桶写入一条外部样本 + 持久化 + 重训（供 recordJevSample / recordJevSrsiSample）
function _recordBucket(k, tsMs, hit) {
  const ts = (typeof tsMs === 'number' && tsMs > 0) ? tsMs : Date.now();
  const wk = Math.floor(ts / (7 * 86400000));
  const a = _stats[k] || (_stats[k] = { buckets: {} });
  if (!a.buckets) a.buckets = {};   // 防御：见 addRow
  const b = a.buckets[wk] || (a.buckets[wk] = { n: 0, h: 0 });
  b.n++;
  b.h += hit ? 1 : 0;
  _sampleCount++;
  _status.sampleCount = _sampleCount;
  try { persistSamples(); } catch (e) { /* 持久化失败不阻断（内存已更新） */ }
  try { train(); if (_onTrained) _onTrained(_localWeights); } catch (e) { /* 训练失败保留旧权重 */ }
  return true;
}

export function onTrained(cb) { _onTrained = cb; }

export function setSymbolProvider(fn) { if (typeof fn === 'function') _getSym = fn; }
export function setSymbolListProvider(fn) { if (typeof fn === 'function') _getSymList = fn; }

// 前向准确度回测（walk-forward）：用本机验证缓冲对指定币重放 TSEV 投票，返回命中率。
// 供面板「本机回测命中率」看板使用，让用户判断是否可信。
export function forwardAccuracy(sym) {
  const buf = _rows[sym];
  if (!buf || buf.length < 40) return null;
  return calcForwardAccuracy(buf, { embargo: 24 });
}

// 诊断：返回某币「已学因子」明细（与线上 train 同阈值），便于面板肉眼看学到哪几个、命中率几何
export function debugTsev(sym) {
  const prefix = sym + '|';
  const stats = {};
  for (const k in _stats) if (k.startsWith(prefix)) stats[k.slice(prefix.length)] = _stats[k];
  return factorStatsTable(stats, {
    MIN_SAMPLE: TSEV_CFG.LOCAL_FACTOR_MIN,
    Z_THRESH: TSEV_CFG.Z_THRESH,
    recencyHalfLifeDays: TSEV_CFG.LOCAL_RECENCY_HALFLIFE_DAYS,
    shrink: TSEV_CFG.SHRINK
  });
}

// 把一条源统计并入目标条目：兼容两种形状
//  - v5：{ buckets: { [周索引]: {n,h} } }（按周分桶，训练期近期加权）
//  - 旧 v2：{ n, h }（无时间信息 → 折算到当前周桶，给满近期权重；且**不得静默丢弃**）
function _mergeStatInto(target, src, wk) {
  if (!target || !src) return;
  if (src.buckets && typeof src.buckets === 'object') {
    target.buckets = target.buckets || {};
    for (const w in src.buckets) {
      const s = src.buckets[w];
      if (!s) continue;
      const b = target.buckets[w] || (target.buckets[w] = { n: 0, h: 0 });
      b.n += s.n || 0; b.h += s.h || 0;
    }
    return;
  }
  if (src.n || src.h) {
    target.buckets = target.buckets || {};
    const b = target.buckets[wk] || (target.buckets[wk] = { n: 0, h: 0 });
    b.n += src.n || 0; b.h += src.h || 0;
  }
}
function _statN(a) {
  if (!a) return 0;
  if (a.buckets) { let n = 0; for (const w in a.buckets) n += (a.buckets[w] && a.buckets[w].n) || 0; return n; }
  return a.n || 0;
}

// 导出已学统计为 JSON 字符串（跨设备共享：桌面重训 → 手机导入）
export async function exportSamples() {
  const v = await idbGet(KEY);
  return v ? JSON.stringify(v) : null;
}

// 导入并合并统计：按 key 累加 n/h（v5 buckets 与旧 {n,h} 两种形状都支持，不得静默丢样本）
// perSym 取并集（冲突以较大 done 为准）
export async function importSamples(json) {
  let v;
  try { v = JSON.parse(json); } catch { return false; }
  if (!v || !v.stats) return false;
  const cur = (await idbGet(KEY)) || {};
  const curStats = cur.stats || {};
  const wk = Math.floor(Date.now() / (7 * 86400000));
  for (const k in v.stats) {
    if (!v.stats[k]) continue;
    // 健壮性：_stats 键必须是 `sym|name|cond|side`（≥3 个分隔符）。缺 sym 前缀的脏键会导致
    // 产生无法被任何币种消费的“孤儿条目”（debugTsev/train 都看不到）——直接跳过。
    if ((k.match(/\|/g) || []).length < 3) continue;
    const c = curStats[k] || (curStats[k] = { buckets: {} });
    _mergeStatInto(c, v.stats[k], wk);
  }
  const curPer = cur.perSym || {};
  const vPer = v.perSym || {};
  for (const s in vPer) curPer[s] = Object.assign(curPer[s] || {}, vPer[s]);
  const sampleCount = Object.keys(curStats).reduce((s, k) => s + _statN(curStats[k]), 0);
  await idbSet(KEY, { v: 5, stats: curStats, sampleCount, perSym: curPer });
  _stats = curStats; _perSym = curPer; _sampleCount = sampleCount;
  train();
  return true;
}

// 供 kchartApp / 主程序注册到 globalThis，供 kchart.js 读取本机权重
export function register() {
  globalThis.__localTsev = {
    getWeights, status, getStats, setEnabled, start, stop, onTrained, onProgress,
    backfillAll, kick, collectSymbol, forwardAccuracy, debugTsev, exportSamples, importSamples,
    setSymbolProvider, setSymbolListProvider, recordJevSample,
    // P4 剩余子项 + P5
    recordJevSrsiSample, listWeightVersions, rollbackWeights, learningCurve
  };
}
