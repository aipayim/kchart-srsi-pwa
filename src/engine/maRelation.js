// 价格与均线关系纯函数引擎（MA20 体系盯盘辅助层的计算层）
// 设计原则：纯函数、零 DOM/网络访问、不读 window；所有跨周期对齐只允许使用「已收盘」的更高周期值（防前视）。
// 渲染与 UI 由调用方负责，本模块只产出数据。
//
// 术语：本周期 = 主图 K 线周期；日线/周线/4H = 更高周期（默认已按主图 bar 对齐传入，见 buildMaRelation 说明）。

import { winLossByAtr } from './indicators.js';
import { THRESH } from './thresholds.js';

export const MA_REL_DEFAULTS = {
  type: 'sma',          // 'sma' | 'ema'
  fast: 20, mid: 60, slow: 120,
  daily: [20, 50, 200],
  weekly: [20, 200],
  squeezePct: 1.2,      // 均线密集阈值（最大差值/价格 %）
  devAtr: 1.5,          // 乖离阈值（×ATR，超过则标“远离均线，谨慎追”）
  swing: 15,            // 结构回看根数
  cool: 8,              // 同向信号冷却根数
  allowShort: true,
  l3: true,             // 是否启用 L3（4H MA20 突破）
  vwap: true,
};

// 有限数判定：null/undefined/NaN/Infinity 一律视为「无值」
function num(v) { return typeof v === 'number' && Number.isFinite(v); }
function arr(v) { return Array.isArray(v) ? v : []; }
function nullArr(n) { return new Array(n).fill(null); }
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

// 均线序列：type 'sma'|'ema'；返回与 closes 等长数组，不足周期处为 null。
// EMA 采用「前 period 个值的 SMA 起步」递推，与 indicators.js 的 ema() 口径一致。
export function maSeries(closes, period, type = 'sma') {
  const src = arr(closes);
  const n = src.length;
  const out = nullArr(n);
  if (!num(period) || period < 1 || n === 0) return out;

  if (type === 'ema') {
    if (n < period) return out;
    const k = 2 / (period + 1);
    let sum = 0, cnt = 0, prev = null;
    for (let i = 0; i < n; i++) {
      const x = src[i];
      if (prev === null) {
        // 起步窗口：任一点缺失则无法种子化，整条不可用（保守）
        if (!num(x)) return out;
        sum += x; cnt++;
        if (cnt === period) { prev = sum / period; out[i] = prev; }
      } else {
        if (!num(x)) { out[i] = prev; continue; }   // 缺失沿用上一值
        prev = x * k + prev * (1 - k);
        out[i] = prev;
      }
    }
    return out;
  }

  // SMA：滑动窗口；窗口内出现非有限值则该点为 null
  let sum = 0, bad = 0;
  for (let i = 0; i < n; i++) {
    const x = src[i];
    if (num(x)) sum += x; else bad++;
    if (i >= period) {
      const y = src[i - period];
      if (num(y)) sum -= y; else bad--;
    }
    if (i >= period - 1 && bad === 0) out[i] = sum / period;
  }
  return out;
}

// 累积 VWAP：典型价 (h+l+c)/3 按成交量加权；返回等长数组。
// 无成交量（缺失或 <=0）处沿用上一值；尚无任何成交量前为 null。
export function vwapSeries(highs, lows, closes, vols) {
  const c = arr(closes), h = arr(highs), l = arr(lows), v = arr(vols);
  const n = c.length;
  const out = nullArr(n);
  let pv = 0, vv = 0, prev = null;
  for (let i = 0; i < n; i++) {
    const ci = c[i];
    const tp = (num(h[i]) && num(l[i]) && num(ci)) ? (h[i] + l[i] + ci) / 3 : (num(ci) ? ci : null);
    const vi = v[i];
    if (num(tp) && num(vi) && vi > 0) { pv += tp * vi; vv += vi; }
    if (vv > 0) prev = pv / vv;
    out[i] = prev;
  }
  return out;
}

// 价格距均线 %：(price-ma)/ma*100；任一无有效值返回 null
export function maDistPct(price, ma) {
  if (!num(price) || !num(ma) || ma === 0) return null;
  return (price - ma) / ma * 100;
}

// 「已收盘」更高周期对齐（防前视）：out[i] = 最后一个满足 T[j] <= t[i] 的 j；无则 -1。
// T 假定升序（更高周期 bar 的时间戳）。t 为主图 bar 时间戳。二分查找。
// v1.6.38：新增可选第三参 barMs（该高周期一根 bar 的毫秒数）。
//   - 提供（正有限数）时要求 T[j] + barMs <= t[i]，即该 bar **已收盘**（消除「进行中 bar 被当作历史」的前视）；
//   - 不提供 / 非正数时保持旧语义 T[j] <= t[i]（向后兼容其它调用方）。
export function alignClosedIdx(T, t, barMs) {
  const times = arr(t);
  const n = times.length;
  const out = new Array(n).fill(-1);
  const H = arr(T);
  if (H.length === 0 || n === 0) return out;
  const useBar = num(barMs) && barMs > 0;
  for (let i = 0; i < n; i++) {
    const ti = times[i];
    if (!num(ti)) { out[i] = -1; continue; }
    let lo = 0, hi = H.length - 1, res = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const hm = H[mid];
      const okClosed = num(hm) && (useBar ? (hm + barMs <= ti) : (hm <= ti));
      if (okClosed) { res = mid; lo = mid + 1; } else hi = mid - 1;
    }
    out[i] = res;
  }
  return out;
}

// v1.6.38：推断更高周期一根 bar 的步长（毫秒）——相邻时间戳差的中位数。
// 不足 2 根 / 无有效差值 → 回退 fallback（日线 1d / 4H 4h / 周线 7d）。
function inferBarMs(times, fallback) {
  const T = arr(times);
  if (T.length < 2) return fallback;
  const diffs = [];
  for (let i = 1; i < T.length; i++) {
    const d = T[i] - T[i - 1];
    if (num(d) && d > 0) diffs.push(d);
  }
  if (!diffs.length) return fallback;
  diffs.sort((a, b) => a - b);
  const m = diffs[Math.floor(diffs.length / 2)];
  return (num(m) && m > 0) ? m : fallback;
}

// 内部：给定三条均线值 + 收盘价，判定密集/挤压
function squeezeFromVals(vals, close, squeezePct) {
  const [a, b, c] = vals;
  const bad = !num(a) || !num(b) || !num(c) || !num(close) || close === 0;
  if (bad) return { spreadPct: null, squeezed: false, vals: [a, b, c] };
  const mx = Math.max(a, b, c), mn = Math.min(a, b, c);
  const spreadPct = (mx - mn) / close * 100;
  const thr = num(squeezePct) ? squeezePct : MA_REL_DEFAULTS.squeezePct;
  return { spreadPct, squeezed: spreadPct <= thr, vals: [a, b, c] };
}

// 均线密集/挤压：spreadPct = (max(三条均线)-min(...))/close*100
// 返回 { spreadPct, squeezed, vals:[fast,mid,slow] }；任一条为 null → { spreadPct:null, squeezed:false, vals }
export function squeezeAt(closes, i, opts) {
  const o = { ...MA_REL_DEFAULTS, ...(opts || {}) };
  const src = arr(closes);
  const idx = Number.isInteger(i) ? i : src.length - 1;
  if (idx < 0 || idx >= src.length) return { spreadPct: null, squeezed: false, vals: [null, null, null] };
  const f = maSeries(src, o.fast, o.type);
  const m = maSeries(src, o.mid, o.type);
  const s = maSeries(src, o.slow, o.type);
  return squeezeFromVals([f[idx], m[idx], s[idx]], src[idx], o.squeezePct);
}

// 市场状态机（日线口径，纯标量）
// BULL : close > maFast 且 slopePct >= 0（走平后抬头也算）
// BEAR : close < maFast 且 slopePct < 0
// 否则 RANGE
export function maMarketState(closes1d, opts) {
  const o = { fast: 20, mid: 50, slopeBars: 5, type: 'sma', ...(opts || {}) };
  const src = arr(closes1d);
  const n = src.length;
  const base = { state: 'RANGE', close: null, maFast: null, maMid: null, slopePct: 0, aboveFast: false, aboveMid: false };
  if (n === 0) return base;

  const f = maSeries(src, o.fast, o.type);
  const m = maSeries(src, o.mid, o.type);
  const L = n - 1;
  const close = num(src[L]) ? src[L] : null;
  const maFast = f[L], maMid = m[L];
  const aboveFast = num(close) && num(maFast) && close > maFast;
  const aboveMid = num(close) && num(maMid) && close > maMid;

  // 斜率：fast 均线最近 slopeBars 根的变化率 %；不可算则视为 0（走平）
  let slopePct = 0;
  const back = Number.isInteger(o.slopeBars) ? o.slopeBars : 5;
  const j = L - back;
  if (j >= 0 && num(maFast) && num(f[j]) && f[j] !== 0) {
    slopePct = (maFast - f[j]) / f[j] * 100;
  }

  let state = 'RANGE';
  if (aboveFast && slopePct >= 0) state = 'BULL';
  else if (num(close) && num(maFast) && close < maFast && slopePct < 0) state = 'BEAR';

  return { state, close, maFast, maMid, slopePct, aboveFast, aboveMid };
}

// 内部：把更高周期序列对齐到主图 bar。
// - 提供 times（更高周期时间戳，长度与 raw 相同）与 mainT 时：走 alignClosedIdx（真正防前视）。
// - 否则视为「已对齐」；长度不齐时按尾部对齐（防御性，调用方应优先传时间戳）。
function alignToMain(raw, times, mainT, n, barMs) {
  const out = nullArr(n);
  const R = arr(raw);
  if (R.length === 0 || n === 0) return out;
  const T = arr(times), M = arr(mainT);
  if (T.length === R.length && M.length === n) {
    const idx = alignClosedIdx(T, M, barMs);
    for (let i = 0; i < n; i++) { const j = idx[i]; if (j >= 0 && j < R.length) out[i] = R[j]; }
    return out;
  }
  const m = R.length, off = n - m;
  for (let i = 0; i < n; i++) { const j = i - off; if (j >= 0 && j < m) out[i] = R[j]; }
  return out;
}

// v1.6.38：因果日线 regime —— stateAt(i) = 主图 bar i 时刻「最后已收盘日线」的市场状态。
// 仅在提供 t1d 且长度与 closes1d 一致、mainT 长度与 n 一致时可用（走 alignClosedIdx + barMs，防前视）；
// 否则回退为全局最新状态（旧行为，向后兼容无时间戳的调用方）。
// 按日线索引缓存：同一根已收盘日线只算一次 maMarketState（避免 O(n) 次全量计算）。
function makeCausalMarketState(closes1d, t1d, mainT, n, barMs, fallbackMarket) {
  const C = arr(closes1d);
  const T = arr(t1d);
  const M = arr(mainT);
  const fb = (fallbackMarket && fallbackMarket.state) || 'RANGE';
  if (C.length === 0 || T.length !== C.length || M.length !== n || n === 0) {
    return () => fb;
  }
  const idx = alignClosedIdx(T, M, barMs);
  const cache = new Map();
  return (i) => {
    const di = idx[i];
    if (di < 0) return 'RANGE';          // 尚无任何已收盘日线 → 不给方向
    let st = cache.get(di);
    if (st === undefined) {
      st = maMarketState(C.slice(0, di + 1), {}).state;
      cache.set(di, st);
    }
    return st;
  };
}

// 内部：回踩/刺到均线判定（L1/L1'）
function touched(i, side, o, lows, highs, maF, atr) {
  const from = Math.max(0, i - o.swing), to = i - 1;
  for (let j = from; j <= to; j++) {
    const m = maF[j];
    if (!num(m)) continue;
    if (side === 'long') {
      const lo = lows[j];
      if (num(lo) && lo <= m) return true;
      if (num(lo) && num(atr[j]) && Math.abs(lo - m) < 0.3 * atr[j]) return true;
    } else {
      const hi = highs[j];
      if (num(hi) && hi >= m) return true;
      if (num(hi) && num(atr[j]) && Math.abs(hi - m) < 0.3 * atr[j]) return true;
    }
  }
  return false;
}

// 内部：结构防守位（最近 swing 根的最低/最高价）
function structStop(i, side, o, lows, highs, fallback) {
  const from = Math.max(0, i - o.swing + 1), to = i;
  let best = null;
  for (let j = from; j <= to; j++) {
    const v = side === 'long' ? lows[j] : highs[j];
    if (!num(v)) continue;
    best = best === null ? v : (side === 'long' ? Math.min(best, v) : Math.max(best, v));
  }
  return best === null ? fallback : best;
}

// 内部：失效位扫描（从 i+1 起第一根收盘破 stop）
function findInvalid(i, side, stop, closes) {
  if (!num(stop)) return null;
  for (let k = i + 1; k < closes.length; k++) {
    const c = closes[k];
    if (!num(c)) continue;
    if (side === 'long' ? c < stop : c > stop) return k;
  }
  return null;
}

// 主入口：一次算出全部展示所需数据
// 输入约定：
//   closes/highs/lows/opens/vols/atr —— 主图周期序列（等长；atr 元素可为 null）
//   closes1d/closes4h/closes1w —— 更高周期收盘序列；推荐直接传「已按主图 bar 对齐」的等长数组
//                                （null 表示无值）；若传原始序列，请同时提供 t1d/t4h/t1w（时间戳）以走
//                                alignClosedIdx 防前视对齐。t = 主图 bar 时间戳。
export function buildMaRelation(input) {
  const inp = input || {};
  const o = { ...MA_REL_DEFAULTS, ...(inp.opts || {}) };
  const closes = arr(inp.closes);
  const n = closes.length;
  const lows = arr(inp.lows);
  const highs = arr(inp.highs);
  const opens = arr(inp.opens);
  const atr = arr(inp.atr);
  const mainT = arr(inp.t);

  const dPer = (Array.isArray(o.daily) && o.daily.length) ? o.daily : MA_REL_DEFAULTS.daily;
  const wPer = (Array.isArray(o.weekly) && o.weekly.length) ? o.weekly : MA_REL_DEFAULTS.weekly;

  // 数据不足：结构完整但均线全 null、signals 空（不抛异常）
  if (n < 30) {
    const ma = { fast: nullArr(n), mid: nullArr(n), slow: nullArr(n) };
    const daily = {}; for (const p of dPer) daily[p] = nullArr(n);
    const weekly = {}; for (const p of wPer) weekly[p] = nullArr(n);
    const market = maMarketState(inp.closes1d, {});
    const out0 = {
      opts: o, ma, vwap: nullArr(n), daily, weekly,
      squeeze: { spreadPct: null, squeezed: false },
      market, signals: [], closes, atr,
      info: {
        distFast: null, distDaily20: null, distWeekly20: null, distWeekly200: null,
        devAtr: false, squeezed: false, lastSignal: null,
        px: null, atrPct: null,
      },
    };
    out0.stand = standProgress(out0);
    out0.breakout = squeezeBreakout(out0);
    out0.stats = signalForwardStats([], closes, atr, { baseline: true });
    return out0;
  }

  // 本周期均线与 VWAP
  const ma = {
    fast: maSeries(closes, o.fast, o.type),
    mid: maSeries(closes, o.mid, o.type),
    slow: maSeries(closes, o.slow, o.type),
  };
  const vwap = o.vwap ? vwapSeries(highs, lows, closes, inp.vols) : nullArr(n);

  // 更高周期对齐（防前视）
  // ⚠ v1.6.34 修复：必须**先在更高周期自身算均线，再对齐到主图**。
  // 原实现「先对齐（前向填充）再算均线」→ 同一根高周期收盘被重复填充 N 次（N=主图在该高周期内的根数）
  //   → 均线恒等于该高周期收盘价（假值！表现为「日MA20 = 日线收盘 · 距 +0.00%」）。
  const dRaw = arr(inp.closes1d), d4Raw = arr(inp.closes4h), wRaw = arr(inp.closes1w);
  // v1.6.38：高周期对齐必须只用「已收盘」bar（barMs = 该周期一根 bar 的毫秒数，按时间戳中位数推断，失败回退常量）。
  const dBarMs = inferBarMs(inp.t1d, 86400e3);
  const h4BarMs = inferBarMs(inp.t4h, 4 * 3600e3);
  const wBarMs = inferBarMs(inp.t1w, 7 * 86400e3);
  const daily = {}; for (const p of dPer) daily[p] = alignToMain(maSeries(dRaw, p, o.type), inp.t1d, mainT, n, dBarMs);
  const weekly = {}; for (const p of wPer) weekly[p] = alignToMain(maSeries(wRaw, p, o.type), inp.t1w, mainT, n, wBarMs);
  const ma4h = alignToMain(maSeries(d4Raw, o.fast, o.type), inp.t4h, mainT, n, h4BarMs);

  // 展示用的「当前大环境」= 最新日线读数（含进行中 bar）——这是当前读数，不是历史过滤器。
  const market = maMarketState(inp.closes1d, {});
  // v1.6.38：因果 regime —— 历史信号只允许用「该主图 bar 时刻已收盘」的日线状态（消除前视）。
  const stateAt = makeCausalMarketState(dRaw, inp.t1d, mainT, n, dBarMs, market);

  // 最后一根的挤压状态
  const lastI = n - 1;
  const sqLast = squeezeFromVals([ma.fast[lastI], ma.mid[lastI], ma.slow[lastI]], closes[lastI], o.squeezePct);

  // ---- 信号扫描（全部用收盘价确认，影线穿越不算） ----
  const signals = [];
  const last = { long: -Infinity, short: -Infinity };
  const openAt = (i) => (opens.length > i && num(opens[i])) ? opens[i] : (i > 0 && num(closes[i - 1]) ? closes[i - 1] : null);

  function push(i, side, type, entry, stop) {
    if (i - last[side] < o.cool) return;           // 同向冷却
    last[side] = i;
    const r = (num(entry) && num(stop)) ? Math.abs(entry - stop) : null;
    signals.push({ i, side, type, entry, stop, r, invalidIdx: findInvalid(i, side, stop, closes) });
  }

  const has4h = arr(inp.closes4h).length > 0;

  for (let i = 1; i < n; i++) {
    const c = closes[i], p = closes[i - 1];
    const f = ma.fast[i], fp = ma.fast[i - 1];
    const mid = ma.mid[i];
    const ai = atr[i];
    const mstate = stateAt(i);

    // L1 回踩站稳（多）
    if (mstate !== 'BEAR' && num(c) && num(f) && num(fp) && f >= fp
      && c > f && touched(i, 'long', o, lows, highs, ma.fast, atr)) {
      push(i, 'long', 'L1', c, structStop(i, 'long', o, lows, highs, f));
    }

    // L1' 反弹受阻（空）
    if (o.allowShort && mstate !== 'BULL' && num(c) && num(f) && num(fp) && f <= fp
      && c < f && touched(i, 'short', o, lows, highs, ma.fast, atr)) {
      push(i, 'short', 'L1', c, structStop(i, 'short', o, lows, highs, f));
    }

    // L2 密集后向上打开（多）：前一根三条均线挤压 + 本根实体较大阳线站上两条均线
    if (num(c) && num(f) && num(mid)) {
      const sq = squeezeFromVals([ma.fast[i - 1], ma.mid[i - 1], ma.slow[i - 1]], p, o.squeezePct);
      const bodyUp = num(ai) && num(openAt(i)) && (c - openAt(i)) > 0.8 * ai;
      if (sq.squeezed && bodyUp && c > f && c > mid) {
        push(i, 'long', 'L2', c, structStop(i, 'long', o, lows, highs, f));
      }
      // L2' 密集后向下打开（空）
      if (o.allowShort) {
        const bodyDown = num(ai) && num(openAt(i)) && (openAt(i) - c) > 0.8 * ai;
        if (sq.squeezed && bodyDown && c < f && c < mid) {
          push(i, 'short', 'L2', c, structStop(i, 'short', o, lows, highs, f));
        }
      }
    }

    // L3 4H MA20 突破（多/空）：收盘上/下穿 4H 均线
    if (o.l3 && has4h) {
      const m4 = ma4h[i], m4p = ma4h[i - 1];
      if (num(c) && num(p) && num(m4) && num(m4p)) {
        if (mstate !== 'BEAR' && c > m4 && p <= m4p) {
          const st = structStop(i, 'long', o, lows, highs, f);
          const stop = num(st) && num(ai) ? st - 0.1 * ai : st;
          push(i, 'long', 'L3', c, stop);
        }
        if (o.allowShort && mstate !== 'BULL' && c < m4 && p >= m4p) {
          const st = structStop(i, 'short', o, lows, highs, f);
          const stop = num(st) && num(ai) ? st + 0.1 * ai : st;
          push(i, 'short', 'L3', c, stop);
        }
      }
    }
  }

  // ---- info ----
  const d20 = daily[20] || nullArr(n);
  const w20 = weekly[20] || nullArr(n);
  const w200 = weekly[200] || nullArr(n);
  const distFast = maDistPct(closes[lastI], ma.fast[lastI]);
  let devAtr = false;
  if (num(closes[lastI]) && num(atr[lastI]) && atr[lastI] > 0 && num(distFast)) {
    const atrPct = atr[lastI] / closes[lastI] * 100;
    devAtr = Math.abs(distFast) > o.devAtr * atrPct;
  }

  const out = {
    opts: o, ma, vwap, daily, weekly,
    t: mainT,                 // v1.6.32：主图 bar 时间戳（解读面板的信号列表要显示时间）
    squeeze: { spreadPct: sqLast.spreadPct, squeezed: sqLast.squeezed },
    market, signals,
    closes, atr,              // v1.6.36：回踩→站稳进度 / 突破预告 / 信号胜率需读原始序列
    info: {
      distFast,
      distDaily20: maDistPct(closes[lastI], d20[lastI]),
      distWeekly20: maDistPct(closes[lastI], w20[lastI]),
      distWeekly200: maDistPct(closes[lastI], w200[lastI]),
      devAtr,
      squeezed: sqLast.squeezed,
      lastSignal: signals.length ? signals[signals.length - 1] : null,
      // v1.6.31：解读面板需要的最新价与 ATR%（纯展示）
      px: num(closes[lastI]) ? closes[lastI] : null,
      atrPct: (num(atr[lastI]) && num(closes[lastI]) && closes[lastI] > 0) ? atr[lastI] / closes[lastI] * 100 : null,
    },
  };
  // v1.6.36：三项新增分析（纯函数，结果随 data 一起返回；livePrice 由解读面板按实时价重算）
  out.stand = standProgress(out);
  out.breakout = squeezeBreakout(out);
  out.stats = signalForwardStats(signals, closes, atr, { baseline: true });
  return out;
}

// ============================================================
// v1.6.31：均线关系「小白解读」——把状态翻译成「图标 + 彩色标签 + 说明」的行（供 PWA 驾驶舱面板）
// 只解读用户**已开启**的项：opts.daily/weekly 为空数组表示未开；opts.vwap/l3/showSlow 为布尔。
// 纯函数，可单测；不依赖 DOM。
// ============================================================
function _fmtPx(v) {
  if (v == null || !isFinite(v)) return '--';
  const a = Math.abs(v);
  if (a >= 10000) return v.toFixed(0);
  if (a >= 100) return v.toFixed(2);
  if (a >= 1) return v.toFixed(3);
  return v.toFixed(5);
}
function _pct(v) {
  if (v == null || !isFinite(v)) return '--';
  return (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
}
function _lastNum(arr) { if (!Array.isArray(arr) || !arr.length) return null; const v = arr[arr.length - 1]; return (v != null && isFinite(v)) ? v : null; }
// v1.6.36：文字进度条（纯字符串，供面板显示「回踩→站稳」进度）
function _bar(p, n) {
  const k = (typeof p === 'number' && isFinite(p)) ? Math.round(clamp01(p) * (n || 8)) : 0;
  return '▰'.repeat(k) + '▱'.repeat(Math.max(0, (n || 8) - k));
}

// ============================================================
// v1.6.36：回踩 → 站稳 进度（用户需求：让小白直观看懂「距 MA20 站稳还有多远」）
// 站稳定义（全项目一致）：**收盘价**站上 MA20（影线不算）。
// 纯函数：只读 data（buildMaRelation 返回）+ opts.livePrice（可选，用实时价算「现在离站稳多远」）。
// progress 0..1：带外→0，贴近带→0.6，带内→0.6..1，收盘确认站上→1。
// ============================================================
export function standProgress(data, opts) {
  const base = { ok: false, side: null, stage: 'none', above: null, standBars: 0, inBandBars: 0, distStandPct: null, distBandPct: null, progress: null, label: '数据不足' };
  if (!data || !data.ma || !Array.isArray(data.ma.fast)) return base;
  const closes = Array.isArray(data.closes) ? data.closes : [];
  const maF = data.ma.fast;
  const atrArr = Array.isArray(data.atr) ? data.atr : [];
  const n = closes.length;
  if (n < 3 || maF.length !== n) return base;
  const state = (data.market && data.market.state) || 'RANGE';
  const side = state === 'BULL' ? 'long' : state === 'BEAR' ? 'short' : null;
  const i = n - 1;                       // 最新 bar（可能是进行中）
  const ic = n - 2;                      // 最后一根**已收盘** bar（站稳以收盘确认）
  const live = (opts && num(opts.livePrice)) ? opts.livePrice : null;
  const px = live != null ? live : (num(data.info && data.info.px) ? data.info.px : closes[i]);
  const f = maF[i];
  if (!num(px) || !num(f) || f <= 0) return base;
  const atrAbs = (num(atrArr[i]) && atrArr[i] > 0) ? atrArr[i] : Math.abs(f) * 0.01;
  const bandHalf = 0.2 * atrAbs;         // 回踩带半宽 = 0.2×ATR
  const bandLo = f - bandHalf, bandHi = f + bandHalf;

  const inBandOf = (c) => num(c) && c >= bandLo - 1e-9 && c <= bandHi + 1e-9;
  const goodSideOf = (c) => side === 'short' ? (num(c) && c < f) : (num(c) && c >= f);
  let standBars = 0;
  if (side) for (let k = ic; k >= 0; k--) { if (goodSideOf(closes[k])) standBars++; else break; }
  let inBandBars = 0;
  for (let k = ic; k >= 0; k--) { if (inBandOf(closes[k])) inBandBars++; else break; }

  const distStand = side === 'short' ? (px - f) : (f - px);          // >0 = 还没站上
  const distBand = side === 'short' ? (px - bandHi) : (bandLo - px); // >0 = 还没进带
  const distStandPct = distStand / f * 100;
  const distBandPct = distBand / f * 100;
  const crossed = side === 'short' ? (num(closes[ic]) && closes[ic] < f) : (num(closes[ic]) && closes[ic] >= f);

  let progress;
  if (!side) progress = 1 - clamp01(Math.abs(px - f) / Math.max(2 * atrAbs, 1e-9));  // 震荡：距 MA20 贴合度
  else if (crossed && distStand <= 0) progress = 1;
  else if (distStand <= 0) progress = 0.85;
  else if (distBand <= 0) progress = 0.6 + 0.4 * clamp01(1 - distStand / Math.max(bandHalf, 1e-9));
  else progress = 0.6 * clamp01(1 - distBand / Math.max(3 * atrAbs, 1e-9));

  let stage, label;
  if (!side) {
    stage = 'range';
    label = '震荡：距 MA20 ' + Math.abs((px - f) / f * 100).toFixed(2) + '%（±0.2×ATR 内视为贴合）';
  } else {
    const dir = side === 'short' ? '做空' : '做多';
    const edge = side === 'short' ? '反抽带' : '回踩带';
    const okSide = side === 'short' ? '下方' : '上方';
    if (crossed && distStand <= 0) { stage = 'stand'; label = '已站稳 MA20（连续 ' + standBars + ' 根收盘在' + okSide + '）→ ' + dir + '条件成立'; }
    else if (distStand <= 0) { stage = 'ready'; label = '现价已' + (side === 'short' ? '跌破' : '站上') + ' MA20，等这根收盘确认（已连续 ' + standBars + ' 根）'; }
    else if (distBand <= 0) { stage = 'inband'; label = '已进' + edge + '内 · 距站稳还差 ' + Math.abs(distStandPct).toFixed(2) + '%' + (inBandBars > 0 ? '（连续 ' + inBandBars + ' 根在带内）' : ''); }
    else { stage = distBand <= atrAbs ? 'near' : 'far'; label = '距' + edge + ' ' + Math.abs(distBandPct).toFixed(2) + '% · 距站稳 ' + Math.abs(distStandPct).toFixed(2) + '%'; }
  }
  return { ok: true, side, stage, above: px >= f, standBars, inBandBars, distStandPct, distBandPct, progress: clamp01(progress), label };
}

// ============================================================
// v1.6.36：均线密集「突破预告」（理论里的 L2 只报「打开后」——这是提前预警）
// 密集区 = 三条均线的 [min, max]；价格贴近上/下沿（≤0.5×ATR）或已在区内 → 提示「即将选择方向」。
// ============================================================
export function squeezeBreakout(data) {
  const base = { ok: false, squeezed: false, watching: false, nearEdge: false, hi: null, lo: null, mid: null, upPct: null, downPct: null, refUp: null, refDown: null, closer: null, label: '数据不足' };
  if (!data || !data.ma) return base;
  const vals = [_lastNum(data.ma.fast), _lastNum(data.ma.mid), _lastNum(data.ma.slow)].filter(num);
  if (vals.length < 2) return base;
  const hi = Math.max(...vals), lo = Math.min(...vals), mid = (hi + lo) / 2;
  const closes = Array.isArray(data.closes) ? data.closes : [];
  const atrArr = Array.isArray(data.atr) ? data.atr : [];
  const i = closes.length - 1;
  const px = num(data.info && data.info.px) ? data.info.px : (i >= 0 ? closes[i] : null);
  if (!num(px) || px <= 0) return base;
  const atrAbs = (num(atrArr[i]) && atrArr[i] > 0) ? atrArr[i] : Math.abs(px) * 0.01;
  const atrPct = atrAbs / px * 100;
  const upPct = (hi - px) / px * 100;     // >0 = 价格在密集区上沿下方
  const downPct = (px - lo) / px * 100;   // >0 = 价格在密集区下沿上方
  const inside = px >= lo && px <= hi;
  const nearUp = Math.abs(upPct) <= 0.5 * atrPct;
  const nearDown = Math.abs(downPct) <= 0.5 * atrPct;
  const nearEdge = inside || nearUp || nearDown;
  const squeezed = !!(data.squeeze && data.squeeze.squeezed);
  const watching = squeezed && nearEdge;
  const closer = Math.abs(upPct) <= Math.abs(downPct) ? 'up' : 'down';
  const label = watching
    ? '密集区收窄 · 价格贴近' + (closer === 'up' ? '上沿' : '下沿') + ' → 关注向' + (closer === 'up' ? '上' : '下') + '突破 ' + _fmtPx(closer === 'up' ? hi : lo) + '（收盘确认）'
    : squeezed ? '均线密集（尚未贴近边缘）· 等收盘突破 ' + _fmtPx(hi) + ' / ' + _fmtPx(lo)
      : '均线未密集（无突破预告）';
  return { ok: true, squeezed, watching, nearEdge, hi, lo, mid, upPct, downPct, refUp: hi, refDown: lo, closer, label };
}

// ============================================================
// v1.6.36：历史信号前瞻胜率（L1/L2/L3 按 2×ATR 止盈 / 1.5×ATR 止损判定）
// 诚实展示：这套理论在**本币本周期**的数据上到底有没有优势（复用 winLossByAtr，与因子消融同口径）。
// 纯函数；样本不足时 winRate=null。
// v1.6.38：新增 opts.baseline=true 时的**随机基线对照**——「同方向、逐 bar 入场」的胜率。
//   用抽样（每 max(1, floor(len/400)) 根取一根）避免每根 horizon 全扫描；抽样时 baselineSampled=true。
// ============================================================
function _baselineWinRate(closes, atr, dir, tpAtr, slAtr, horizon, step) {
  const n = Array.isArray(closes) ? closes.length : 0;
  let wins = 0, losses = 0;
  for (let i = 0; i < n - 1; i += step) {
    const r = winLossByAtr(closes, atr, { entryIdx: i, direction: dir, tpAtr, slAtr, horizon });
    if (r.win === 1) wins++; else if (r.win === -1) losses++;
  }
  const resolved = wins + losses;
  return resolved > 0 ? wins / resolved : null;
}

export function signalForwardStats(signals, closes, atr, opts) {
  const o = opts || {};
  const tpAtr = num(o.tpAtr) ? o.tpAtr : THRESH.BT_TP_ATR;
  const slAtr = num(o.slAtr) ? o.slAtr : THRESH.BT_SL_ATR;
  const horizon = num(o.horizon) ? o.horizon : THRESH.BT_HORIZON;
  const out = { n: 0, wins: 0, losses: 0, unresolved: 0, winRate: null, avgPnlPct: null, byType: {}, baseline: null, baselineLong: null, baselineShort: null, edge: null, baselineStep: null, baselineSampled: false };
  const list = Array.isArray(signals) ? signals : [];
  let pnlSum = 0, pnlN = 0, valid = 0;
  for (const s of list) {
    if (!s || !num(s.i) || !s.side) continue;
    valid++;
    const r = winLossByAtr(closes, atr, { entryIdx: s.i, direction: s.side === 'long' ? 'buy' : 'sell', tpAtr, slAtr, horizon });
    const key = s.type || 'L1';
    const t = out.byType[key] || (out.byType[key] = { n: 0, wins: 0, losses: 0, unresolved: 0, winRate: null });
    t.n++;
    if (r.win === 1) { out.wins++; t.wins++; }
    else if (r.win === -1) { out.losses++; t.losses++; }
    else { out.unresolved++; t.unresolved++; }
    if (r.win != null && num(r.pnlPct)) { pnlSum += r.pnlPct; pnlN++; }
  }
  out.n = valid;
  const resolved = out.wins + out.losses;
  out.winRate = resolved > 0 ? out.wins / resolved : null;
  out.avgPnlPct = pnlN > 0 ? pnlSum / pnlN : null;
  for (const k of Object.keys(out.byType)) {
    const t = out.byType[k];
    const rr = t.wins + t.losses;
    t.winRate = rr > 0 ? t.wins / rr : null;
  }
  // v1.6.38：随机基线对照（仅 opts.baseline===true 时计算；默认关闭以保持向后兼容）
  if (o.baseline === true) {
    const nBars = Array.isArray(closes) ? closes.length : 0;
    const step = Math.max(1, Math.floor(nBars / 400));
    out.baselineStep = step;
    out.baselineSampled = step > 1;
    out.baselineLong = _baselineWinRate(closes, atr, 'buy', tpAtr, slAtr, horizon, step);
    out.baselineShort = _baselineWinRate(closes, atr, 'sell', tpAtr, slAtr, horizon, step);
    let lng = 0, sht = 0;
    for (const s of list) { if (s && s.side === 'long') lng++; else if (s && s.side === 'short') sht++; }
    const tot = lng + sht, bl = out.baselineLong, bs = out.baselineShort;
    if (tot === 0) out.baseline = (bl != null && bs != null) ? (bl + bs) / 2 : (bl != null ? bl : bs);
    else if (sht === 0) out.baseline = bl;
    else if (lng === 0) out.baseline = bs;
    else if (bl != null && bs != null) out.baseline = (bl * lng + bs * sht) / tot;
    else out.baseline = (bl != null ? bl : bs);
    if (out.winRate != null && out.baseline != null) out.edge = out.winRate - out.baseline;
  }
  return out;
}

// 返回 { tone, verdict, rows, signals }
//   rows      = 状态解读行（每维度一行）
//   signals   = v1.6.32：最近 N 笔信号（默认 10，最新在前，带时间），供面板逐笔列出与主图箭头对位
export function maRelReadout(data, opts2) {
  const o2 = opts2 || {};
  const sigLimit = (o2.sigLimit != null && isFinite(o2.sigLimit)) ? Math.max(0, Math.floor(o2.sigLimit)) : 10;
  const empty = { tone: 'none', verdict: '未启用均线关系（在主图工具面板点「📐 均线关系」开启）', rows: [], signals: [], stand: null, breakout: null, stats: null };
  if (!data || !data.opts) return empty;
  const o = data.opts;
  const closes = (data.ma && data.ma.fast) || [];
  const lastI = closes.length - 1;
  if (lastI < 0) return empty;
  const px = (data.info && data.info.px != null) ? data.info.px : null;
  const mFast = _lastNum(data.ma.fast), mMid = _lastNum(data.ma.mid), mSlow = _lastNum(data.ma.slow);
  const d20 = _lastNum(data.daily && data.daily[20]), d50 = _lastNum(data.daily && data.daily[50]), d200 = _lastNum(data.daily && data.daily[200]);
  const w20 = _lastNum(data.weekly && data.weekly[20]), w200 = _lastNum(data.weekly && data.weekly[200]);
  const vw = _lastNum(data.vwap);
  const price = px != null ? px : mFast;   // 无实时价时用均线自身占位（仅用于“在均线上/下”的相对判断）
  const mk = data.market || {};
  const state = mk.state || 'RANGE';
  const tone = state === 'BULL' ? 'bull' : state === 'BEAR' ? 'bear' : 'range';
  const rows = [];
  // v1.6.36：新增三项分析（在下方对应位置 push 行，结果一并返回供渲染层使用）
  const sp = standProgress(data, { livePrice: o2.livePrice });
  const bo = squeezeBreakout(data);
  const st2 = (data.stats && data.stats.n != null) ? data.stats : signalForwardStats(data.signals, data.closes, data.atr, { baseline: true });

  // 1) 大环境
  const stIcon = tone === 'bull' ? '▲' : tone === 'bear' ? '▼' : '◆';
  const stColor = tone === 'bull' ? '#2ecc71' : tone === 'bear' ? '#ff6b6b' : '#f59e0b';
  const stDo = tone === 'bull' ? '只找做多' : tone === 'bear' ? '只找做空' : '不给方向·观望';
  rows.push({
    icon: stIcon, color: stColor,
    label: '大环境 ' + state + '（' + stDo + '）',
    detail: '日线收盘 ' + _fmtPx(mk.close) + ' · 日线MA20 ' + _fmtPx(mk.maFast) + ' · 斜率 ' + _pct(mk.slopePct) +
      (mk.aboveMid != null ? ' · ' + (mk.aboveMid ? '在日线MA50 上方' : '在日线MA50 下方') : ''),
  });

  // 2) 价格 vs 本周期 MA20（主战场）
  if (mFast != null) {
    const up = price >= mFast;
    rows.push({
      icon: '●', color: up ? '#2ecc71' : '#ff6b6b',
      label: '价在本周期MA' + (o.fast || 20) + ' ' + (up ? '上方' : '下方') + '（' + (up ? '偏多' : '偏空') + '）',
      detail: 'MA' + (o.fast || 20) + ' ' + _fmtPx(mFast) + ' · 距 ' + _pct(data.info && data.info.distFast) +
        (mMid != null ? ' · MA' + (o.mid || 60) + ' ' + _fmtPx(mMid) : ''),
    });
  }

  // 2.5) v1.6.36：回踩 → 站稳 进度（用户需求：让小白直观看懂「距站稳还有多远」）
  if (sp.ok) {
    const spColor = (sp.stage === 'stand' || sp.stage === 'ready') ? '#2ecc71' : sp.stage === 'inband' ? '#ffd740' : sp.stage === 'range' ? '#f59e0b' : '#8899aa';
    const pctTxt = Math.round((sp.progress || 0) * 100) + '% ' + _bar(sp.progress, 8);
    // 震荡时没有「站稳」概念 → 改说「均线贴合度」（不追涨杀跌）
    const head = sp.side === 'short' ? ('反抽→受阻 ' + pctTxt + '（等反抽受阻）')
      : sp.side === 'long' ? ('回踩→站稳 ' + pctTxt + '（等回踩站稳）')
        : ('均线贴合度 ' + pctTxt + '（震荡：不追涨杀跌）');
    rows.push({
      icon: sp.stage === 'stand' ? '✅' : '⏳', color: spColor,
      label: head,
      detail: sp.label + (sp.standBars > 0 && sp.stage !== 'stand' ? ' · 已连续 ' + sp.standBars + ' 根在正确侧' : ''),
    });
  }

  // 3) 均线排列
  if (mFast != null && mMid != null) {
    const arr3 = (mSlow != null) ? [mFast, mMid, mSlow] : [mFast, mMid];
    const bullArr = arr3.every((v, i) => i === 0 || arr3[i - 1] > v);
    const bearArr = arr3.every((v, i) => i === 0 || arr3[i - 1] < v);
    const ic = bullArr ? '▲' : bearArr ? '▼' : '◆';
    const cl = bullArr ? '#2ecc71' : bearArr ? '#ff6b6b' : '#f59e0b';
    rows.push({
      icon: ic, color: cl,
      label: bullArr ? '均线多头排列（趋势向上）' : bearArr ? '均线空头排列（趋势向下）' : '均线纠缠（无明确趋势）',
      detail: 'MA' + (o.fast || 20) + ' ' + _fmtPx(mFast) + (mMid != null ? ' / MA' + (o.mid || 60) + ' ' + _fmtPx(mMid) : '') +
        ((o.showSlow && mSlow != null) ? ' / MA' + (o.slow || 120) + ' ' + _fmtPx(mSlow) : ''),
    });
  }

  // 4) 均线密集
  const sq = data.squeeze || {};
  if (sq.spreadPct != null) {
    rows.push({
      icon: sq.squeezed ? '●' : '○', color: sq.squeezed ? '#ffd740' : 'rgba(160,175,190,.85)',
      label: sq.squeezed ? '均线密集（即将选方向，等收盘突破）' : '均线未密集（尚可顺势）',
      detail: '三线最大差 ' + _pct(sq.spreadPct) + ' · 密集阈值 ' + (o.squeezePct != null ? o.squeezePct : 1.2) + '%',
    });
  }

  // 4.5) v1.6.36：密集突破预告（理论里的 L2 只报「打开后」，这是提前预警）
  if (bo.ok && (bo.squeezed || bo.watching)) {
    rows.push({
      icon: bo.watching ? '⚡' : '○', color: bo.watching ? '#ffd740' : 'rgba(160,175,190,.85)',
      label: bo.watching ? ('密集突破预告：关注向' + (bo.closer === 'up' ? '上' : '下') + '突破') : '密集区已形成，等收盘突破',
      detail: bo.label + ' · 上沿 ' + _fmtPx(bo.refUp) + ' / 下沿 ' + _fmtPx(bo.refDown) + '（距上 ' + _pct(bo.upPct) + ' · 距下 ' + _pct(bo.downPct) + '）',
    });
  }

  // 5) 日线 / 周线参照（仅在开启时解读）
  if (Array.isArray(o.daily) && o.daily.length) {
    rows.push({
      icon: '●', color: d20 != null && price >= d20 ? '#2ecc71' : '#ff6b6b',
      label: '日线MA20 ' + (d20 != null && price >= d20 ? '上方' : '下方') + '（大方向参照）',
      detail: '日MA20 ' + _fmtPx(d20) + ' · 距 ' + _pct(data.info && data.info.distDaily20) +
        (d50 != null ? ' · 日MA50 ' + _fmtPx(d50) : '') + (d200 != null ? ' · 日MA200 ' + _fmtPx(d200) : ''),
    });
  }
  if (Array.isArray(o.weekly) && o.weekly.length) {
    rows.push({
      icon: '●', color: w20 != null && price >= w20 ? '#00E676' : '#ff5252',
      label: '周线MA20 ' + (w20 != null && price >= w20 ? '上方' : '下方') + '（大级别）',
      detail: '周MA20 ' + _fmtPx(w20) + ' · 距 ' + _pct(data.info && data.info.distWeekly20) +
        (w200 != null ? ' · 周MA200 ' + _fmtPx(w200) + ' · 距 ' + _pct(data.info && data.info.distWeekly200) : ''),
    });
  }

  // 6) VWAP
  if (o.vwap && vw != null) {
    const up = price >= vw;
    rows.push({
      icon: '●', color: up ? '#2ecc71' : '#ff6b6b',
      label: '价在 VWAP ' + (up ? '上方' : '下方') + '（当日成交均价参照）',
      detail: 'VWAP ' + _fmtPx(vw) + ' · 距 ' + _pct(maDistPct(price, vw)),
    });
  }

  // 7) 最近信号
  const sig = data.info && data.info.lastSignal;
  if (sig) {
    const up = sig.side === 'long';
    const invalid = sig.invalidIdx != null;
    const dirTxt = up ? '做多' : '做空';
    const rTxt = (sig.r != null && isFinite(sig.r)) ? _fmtPx(sig.r) : '--';
    const tp2 = (sig.r != null && isFinite(sig.r)) ? _fmtPx(sig.entry + (up ? 1 : -1) * sig.r * 2) : '--';
    rows.push({
      icon: up ? '▲' : '▼', color: invalid ? '#8899aa' : (up ? '#2ecc71' : '#ff6b6b'),
      label: (sig.type || 'L1') + ' ' + (sig.type === 'L2' ? '密集后打开' : sig.type === 'L3' ? '4H MA20 突破' : (up ? '回踩站稳' : '反弹受阻')) + ' · ' + dirTxt + (invalid ? '（已失效）' : '（有效）'),
      detail: '入场 ' + _fmtPx(sig.entry) + ' · 防守 ' + _fmtPx(sig.stop) + ' · 1R ' + rTxt + ' · 2R目标 ' + tp2,
    });
  } else {
    rows.push({ icon: '○', color: 'rgba(160,175,190,.85)', label: '暂无可执行信号', detail: '等价格给「收盘态度」：站上/跌破 MA' + (o.fast || 20) });
  }

  // 7.5) v1.6.36/38：历史信号前瞻胜率 + 随机基线对照（诚实展示：这套理论在本币本周期到底有没有优势）
  if (st2 && st2.n > 0) {
    const MIN_N = 200;                        // v1.6.38：样本量守卫（500 根 K 线 ≈ 70 样本，统计意义极弱）
    const insufficient = st2.n < MIN_N;
    const parts = Object.keys(st2.byType).sort().map(k => {
      const t = st2.byType[k];
      const rr = t.wins + t.losses;
      return k + ' ' + (rr > 0 ? (t.wins / rr * 100).toFixed(0) + '%' : '--') + '(' + t.n + ')';
    });
    const blPct = (st2.baseline != null) ? (st2.baseline * 100).toFixed(0) + '%' : null;
    let label, color;
    if (insufficient) {
      // 样本不足：不给看起来权威的百分比结论
      label = '历史信号胜率 · 样本不足（n<' + MIN_N + '）· 仅参考（样本 ' + st2.n + '）';
      color = '#8899aa';
    } else {
      const wrTxt = st2.winRate != null ? (st2.winRate * 100).toFixed(0) + '%' : '--';
      let edgeWord;
      if (st2.edge == null || blPct == null) edgeWord = '优势不明确';
      else if (st2.edge >= 0.03) edgeWord = '有优势';
      else if (st2.edge <= -0.03) edgeWord = '无优势';
      else edgeWord = '优势不明确';
      color = edgeWord === '有优势' ? '#2ecc71' : edgeWord === '无优势' ? '#ff6b6b' : '#f59e0b';
      label = '历史信号胜率 ' + wrTxt + '（样本 ' + st2.n + '）' +
        (blPct != null ? ' · 随机基线 ' + blPct : '') + ' → ' + edgeWord;
    }
    rows.push({
      icon: '📊', color,
      label,
      detail: '盈 ' + st2.wins + ' · 亏 ' + st2.losses + ' · 未定 ' + st2.unresolved +
        (st2.avgPnlPct != null ? ' · 均盈亏 ' + _pct(st2.avgPnlPct) : '') +
        (parts.length ? ' · 分类型 ' + parts.join(' ') : '') +
        (st2.baseline != null ? ' · 随机基线(多' + (st2.baselineLong != null ? (st2.baselineLong * 100).toFixed(0) + '%' : '--') +
          '/空' + (st2.baselineShort != null ? (st2.baselineShort * 100).toFixed(0) + '%' : '--') + ')' : '') +
        (st2.baselineSampled ? ' · 抽样基线' : '') +
        ' · 仅历史统计不代表未来',
    });
  }

  // 8) 等待区 / 乖离
  const atrPct = (data.info && data.info.atrPct != null) ? data.info.atrPct : null;
  if (tone === 'bull') rows.push({ icon: '⏳', color: '#2ecc71', label: '等待区：等回踩 MA' + (o.fast || 20) + ' 站稳再做多', detail: mFast != null ? ('回踩带 ' + _fmtPx(mFast) + ' ± 0.2×ATR' + (atrPct != null ? '（≈' + _fmtPx(mFast * atrPct / 100 * 0.2) + '）' : '')) : '' });
  else if (tone === 'bear') rows.push({ icon: '⏳', color: '#ff6b6b', label: '等待区：等反抽 MA' + (o.fast || 20) + ' 受阻再做空', detail: mFast != null ? ('反抽带 ' + _fmtPx(mFast) + ' ± 0.2×ATR') : '' });
  else rows.push({ icon: '⏳', color: '#f59e0b', label: '等待区：震荡不猜方向，等均线密集后收盘带量跳出', detail: mFast != null ? ('当前MA' + (o.fast || 20) + ' ' + _fmtPx(mFast)) : '' });
  if (data.info && data.info.devAtr) {
    const thr = (atrPct != null && o.devAtr != null) ? (o.devAtr * atrPct) : null;
    rows.push({ icon: '⚠', color: '#f59e0b', label: '远离均线，勿追涨/追空', detail: '距本周期MA' + (o.fast || 20) + ' ' + _pct(data.info.distFast) + (thr != null ? ' · 阈值 ' + thr.toFixed(2) + '%（' + o.devAtr + '×ATR ' + atrPct.toFixed(2) + '%）' : '') });
  }

  // 结论
  let verdict;
  if (tone === 'bull') verdict = '顺势偏多：等回踩 MA' + (o.fast || 20) + ' 站稳再做多；收盘跌破 MA' + (o.fast || 20) + ' 先减仓观察';
  else if (tone === 'bear') verdict = '顺势偏空：等反抽 MA' + (o.fast || 20) + ' 受阻再做空；收盘站上 MA' + (o.fast || 20) + ' 转观望';
  else verdict = '震荡观望：不猜方向，等均线密集后收盘带量跳出密集区再动手';
  if (sig && sig.invalidIdx != null) verdict += '（最近信号已失效，按防守位认错）';

  // 最近 N 笔信号（最新在前；带时间戳，供面板逐笔列出）
  const times = Array.isArray(data.t) ? data.t : [];
  const sigList = (sigLimit <= 0) ? [] : (Array.isArray(data.signals) ? data.signals : []).slice(-sigLimit).reverse().map(s => ({
    i: s.i,
    ts: (times[s.i] != null && isFinite(times[s.i])) ? times[s.i] : null,
    side: s.side,
    type: s.type || 'L1',
    entry: s.entry, stop: s.stop, r: s.r,
    invalid: s.invalidIdx != null,
  }));

  return { tone, verdict, rows, signals: sigList, stand: sp, breakout: bo, stats: st2 };
}
