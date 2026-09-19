// 价格与均线关系纯函数引擎（MA20 体系盯盘辅助层的计算层）
// 设计原则：纯函数、零 DOM/网络访问、不读 window；所有跨周期对齐只允许使用「已收盘」的更高周期值（防前视）。
// 渲染与 UI 由调用方负责，本模块只产出数据。
//
// 术语：本周期 = 主图 K 线周期；日线/周线/4H = 更高周期（默认已按主图 bar 对齐传入，见 buildMaRelation 说明）。

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
export function alignClosedIdx(T, t) {
  const times = arr(t);
  const n = times.length;
  const out = new Array(n).fill(-1);
  const H = arr(T);
  if (H.length === 0 || n === 0) return out;
  for (let i = 0; i < n; i++) {
    const ti = times[i];
    if (!num(ti)) { out[i] = -1; continue; }
    let lo = 0, hi = H.length - 1, res = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (num(H[mid]) && H[mid] <= ti) { res = mid; lo = mid + 1; } else hi = mid - 1;
    }
    out[i] = res;
  }
  return out;
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
function alignToMain(raw, times, mainT, n) {
  const out = nullArr(n);
  const R = arr(raw);
  if (R.length === 0 || n === 0) return out;
  const T = arr(times), M = arr(mainT);
  if (T.length === R.length && M.length === n) {
    const idx = alignClosedIdx(T, M);
    for (let i = 0; i < n; i++) { const j = idx[i]; if (j >= 0 && j < R.length) out[i] = R[j]; }
    return out;
  }
  const m = R.length, off = n - m;
  for (let i = 0; i < n; i++) { const j = i - off; if (j >= 0 && j < m) out[i] = R[j]; }
  return out;
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
    return {
      opts: o, ma, vwap: nullArr(n), daily, weekly,
      squeeze: { spreadPct: null, squeezed: false },
      market, signals: [],
      info: {
        distFast: null, distDaily20: null, distWeekly20: null, distWeekly200: null,
        devAtr: false, squeezed: false, lastSignal: null,
      },
    };
  }

  // 本周期均线与 VWAP
  const ma = {
    fast: maSeries(closes, o.fast, o.type),
    mid: maSeries(closes, o.mid, o.type),
    slow: maSeries(closes, o.slow, o.type),
  };
  const vwap = o.vwap ? vwapSeries(highs, lows, closes, inp.vols) : nullArr(n);

  // 更高周期对齐（防前视）
  const aligned1d = alignToMain(inp.closes1d, inp.t1d, mainT, n);
  const aligned4h = alignToMain(inp.closes4h, inp.t4h, mainT, n);
  const aligned1w = alignToMain(inp.closes1w, inp.t1w, mainT, n);

  const daily = {}; for (const p of dPer) daily[p] = maSeries(aligned1d, p, o.type);
  const weekly = {}; for (const p of wPer) weekly[p] = maSeries(aligned1w, p, o.type);
  const ma4h = maSeries(aligned4h, o.fast, o.type);

  const market = maMarketState(inp.closes1d, {});

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

    // L1 回踩站稳（多）
    if (market.state !== 'BEAR' && num(c) && num(f) && num(fp) && f >= fp
      && c > f && touched(i, 'long', o, lows, highs, ma.fast, atr)) {
      push(i, 'long', 'L1', c, structStop(i, 'long', o, lows, highs, f));
    }

    // L1' 反弹受阻（空）
    if (o.allowShort && market.state !== 'BULL' && num(c) && num(f) && num(fp) && f <= fp
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
        if (market.state !== 'BEAR' && c > m4 && p <= m4p) {
          const st = structStop(i, 'long', o, lows, highs, f);
          const stop = num(st) && num(ai) ? st - 0.1 * ai : st;
          push(i, 'long', 'L3', c, stop);
        }
        if (o.allowShort && market.state !== 'BULL' && c < m4 && p >= m4p) {
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

  return {
    opts: o, ma, vwap, daily, weekly,
    squeeze: { spreadPct: sqLast.spreadPct, squeezed: sqLast.squeezed },
    market, signals,
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

// 返回 { tone:'bull'|'bear'|'range'|'none', verdict:'一句话结论', rows:[{icon,color,label,detail}] }
export function maRelReadout(data) {
  const empty = { tone: 'none', verdict: '未启用均线关系（在主图工具面板点「📐 均线关系」开启）', rows: [] };
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

  return { tone, verdict, rows };
}
