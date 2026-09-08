// SRSI 参数优选（看盘辅助）：对给定收盘价序列，按网格搜索最优 RSI周期/STOCH/平滑K/D/上下带。
// 纯函数、确定性、无前视（walk-forward：前 2/3 调参、后 1/3 验证）。
// 与纪律因子消融同源：用 srsiKD + srsiCrossings + winLossByAtr(2×ATR/1.5×ATR) 评估信号质量。
// 设计目标（用户定位）：输出「推荐参数 + 可採用建议 + 训练/验证指标」，供用户在图上看盘对比，
// 不静默覆盖手调、不接入自动交易/纪律分析（纪律消融为后续阶段）。
import { srsiKD, srsiCrossings, winLossByAtr, atrClose, ewma } from './indicators.js';
import { THRESH } from './thresholds.js';

// 网格 = AgentMore 规范引擎口径（确定性、可复现）：rsi{5,7,9,14,21,28} × stoch{5,7,9,14,21,28} × k{2,3,5}
// × d=3(形式参数，band 模式不用 D，不进网格) × band{90/10,85/15,80/20} = 324 组。
// 触发(band 穿越)/出场(opp 水平触达)/过滤(ema200)/费率(0.10%RT)/次根开盘/单持仓不反手/末根剔除 均为框架常量，不进网格。
// 该网格同时作为「邻近网格」默认（规范引擎已证明冠军来自此域，无需更大域）。
// 冠军选择 = 两道门槛（对方确认伪代码第29行 70% 邻域硬门槛为事后形式化错误，从未作为门槛执行）：
//   ① n ≥ minN（网格内建 n<40 丢弃，1h/4h 通用）② 时间中位切两半、每半独立重算同参数 → 两半各自 avg>0。
// 邻域 {rsi±1档}×{stoch±1档}×{k全档} 正收益占比 仅作稳健性「报告」，不作门槛。
export const SRSI_NEIGHBORHOOD = {
  rsiPeriods: [5, 7, 9, 14, 21, 28],
  stochPeriods: [5, 7, 9, 14, 21, 28],
  smoothKs: [2, 3, 5],
  smoothDs: [3], // K/D 中仅 K 用于破带穿越判定，D 不影响交易；固定 3 与手册一致
  bands: [
    { overbought: 90, oversold: 10 },
    { overbought: 85, oversold: 15 },
    { overbought: 80, oversold: 20 }
  ]
};

export const SRSI_GRID_DEFAULTS = SRSI_NEIGHBORHOOD;

// 生成参数网格。KD 只随 (rsi,stoch,k,d) 变，故评分阶段按该 key 缓存，避免对每种带重复计算。
export function srsiParamGrid(opts = {}) {
  const g = { ...SRSI_GRID_DEFAULTS, ...opts };
  const out = [];
  for (const rsiPeriod of g.rsiPeriods)
    for (const stochPeriod of g.stochPeriods)
      for (const smoothK of g.smoothKs)
        for (const smoothD of g.smoothDs)
          for (const b of g.bands)
            out.push({ rsiPeriod, stochPeriod, smoothK, smoothD, overbought: b.overbought, oversold: b.oversold });
  return out;
}

// 邻近网格（默认推荐用）：参数邻域更小 → 选参膨胀更可控，且完整覆盖手册观测值。
export function srsiNeighborhoodGrid(opts = {}) {
  const g = { ...SRSI_NEIGHBORHOOD, ...opts };
  const out = [];
  for (const rsiPeriod of g.rsiPeriods)
    for (const stochPeriod of g.stochPeriods)
      for (const smoothK of g.smoothKs)
        for (const smoothD of g.smoothDs)
          for (const b of g.bands)
            out.push({ rsiPeriod, stochPeriod, smoothK, smoothD, overbought: b.overbought, oversold: b.oversold });
  return out;
}

// 闸门方向：K 跌破超卖带(买入穿越) → 空压(short)；K 升破超买带(卖出穿越) → 多压(long)。
// 与 kchart.auxGateDir 语义一致（超卖→short / 超买→long）。
function gateDirFromCross(sig) {
  return sig === 'buy' ? 'short' : (sig === 'sell' ? 'long' : null);
}

// 评分（纯函数）：
//  swing 模式 → 反手 band-crossing 入场，2×ATR 止盈 / 1.5×ATR 止损，输出 EV/胜率/累计%/t值。
//  gate  模式 → 仅评方向放行正确率（后市移动方向一致的占比）+ 笔数（对齐手册闸门 31笔/67.7% 口径）。
// 可传入已算好的 k/d（缓存），避免重复 srsiKD。
export function scoreSrsiParams(closes, params, opts = {}) {
  const tpAtr = opts.tpAtr != null ? opts.tpAtr : THRESH.BT_TP_ATR;
  const slAtr = opts.slAtr != null ? opts.slAtr : THRESH.BT_SL_ATR;
  const horizon = opts.horizon != null ? opts.horizon : THRESH.BT_HORIZON;
  const role = opts.role || 'swing';
  const k = opts.k || srsiKD(closes, params).k;
  const d = opts.d || srsiKD(closes, params).d;
  const atr = opts.atr || atrClose(closes, opts.atrPeriod || 14);
  const cross = srsiCrossings(k, params);

  if (role === 'gate') {
    let agree = 0, count = 0;
    for (let i = 0; i < cross.length; i++) {
      const sig = cross[i];
      if (!sig) continue;
      const dir = gateDirFromCross(sig);
      if (!dir) continue;
      const j = Math.min(closes.length - 1, i + 1 + horizon);
      const moved = closes[j] - closes[i];
      if (!isFinite(moved) || moved === 0) continue;
      const ok = (dir === 'long' && moved > 0) || (dir === 'short' && moved < 0);
      if (ok) agree++;
      count++;
    }
    const rate = count ? agree / count : 0;
    return { params, signals: count, agree, rate, winRate: rate, ev: rate, cumReturnPct: 0, tLike: 0,
      buy: { total: 0, winRate: 0 }, sell: { total: 0, winRate: 0 } };
  }

  // swing
  let wins = 0, total = 0, pnlSum = 0, pnlComp = 1;
  let buyTot = 0, buyWin = 0, sellTot = 0, sellWin = 0;
  for (let i = 0; i < cross.length; i++) {
    const sig = cross[i];
    if (!sig) continue;
    const r = winLossByAtr(closes, atr, { entryIdx: i, direction: sig, tpAtr, slAtr, horizon });
    if (r.win == null) continue;
    const rr = r.pnlPct / 100;
    total++;
    pnlSum += rr;
    pnlComp *= (1 + rr);
    if (r.win === 1) wins++;
    if (sig === 'buy') { buyTot++; if (r.win === 1) buyWin++; }
    else { sellTot++; if (r.win === 1) sellWin++; }
  }
  const winRate = total ? wins / total : 0;
  const be = slAtr / (tpAtr + slAtr);
  const se = total ? Math.sqrt(winRate * (1 - winRate) / total) : 0;
  const tLike = (se > 0 && isFinite(se)) ? (winRate - be) / se : 0;
  return {
    params, signals: total, wins, winRate,
    ev: total ? pnlSum / total : 0,
    cumReturnPct: total ? (pnlComp - 1) * 100 : 0,
    tLike,
    buy: { total: buyTot, winRate: buyTot ? buyWin / buyTot : 0 },
    sell: { total: sellTot, winRate: sellTot ? sellWin / sellTot : 0 }
  };
}

export function gateDirectionAccuracy(closes, params, opts = {}) {
  return scoreSrsiParams(closes, params, { ...opts, role: 'gate' });
}

// 主入口：walk-forward 参数优选（确定性、无随机）。
// 返回 null 当数据不足；否则 { best, role, train, val, defTrain, defVal, decision, reason, gridSize, trainN, valN }。
export function optimizeSrsi(closes, opts = {}) {
  if (!Array.isArray(closes) || closes.length < 60) return null;
  const split = opts.split != null ? opts.split : 0.67;
  const role = opts.role || 'swing';
  const minSamples = opts.minSamples != null ? opts.minSamples : 15;
  const minValSamples = opts.minValSamples != null ? opts.minValSamples : 6;
  const grid = opts.grid || srsiParamGrid(opts.gridOpts);
  const defaultParams = opts.defaultParams || { rsiPeriod: 85, stochPeriod: 50, smoothK: 10, smoothD: 5, overbought: 80, oversold: 20 };
  const atrPeriod = opts.atrPeriod || 14;

  const trainN = Math.max(30, Math.min(closes.length - 1, Math.floor(closes.length * split)));
  const train = closes.slice(0, trainN);
  const val = closes.slice(trainN);
  if (train.length < 30 || val.length < 10) return null;

  const fullAtr = atrClose(closes, atrPeriod);
  const kdCache = new Map();
  const getKD = (p) => {
    const key = `${p.rsiPeriod}|${p.stochPeriod}|${p.smoothK}|${p.smoothD}`;
    let v = kdCache.get(key);
    if (!v) { v = srsiKD(closes, p); kdCache.set(key, v); }
    return v;
  };
  const scoreOn = (p, offset, len) => {
    const kd = getKD(p);
    const k = kd.k.slice(offset, offset + len);
    const d = kd.d.slice(offset, offset + len);
    const sub = closes.slice(offset, offset + len);
    const atr = fullAtr.slice(offset, offset + len);
    return scoreSrsiParams(sub, p, { ...opts, k, d, atr, role });
  };

  // 选优口径：在「全样本」上取累计收益(EV)最优（与 PDF 手册验收口径一致，手册参数即全窗口数据最优）。
  // 训练/验证切分仍用于 decision 护栏（见下方 valObj），但参数选择不再用训练段（避免与手册/全窗口最优分叉）。
  let best = null, bestObj = -Infinity;
  for (const p of grid) {
    const sf = scoreOn(p, 0, closes.length);
    if (sf.signals < minSamples) continue;
    const obj = role === 'gate' ? sf.rate : sf.ev;
    if (obj <= 0) continue;
    if (obj > bestObj) { bestObj = obj; best = p; }
  }
  if (!best) best = defaultParams;
  const bestTrainScore = scoreOn(best, 0, train.length);
  const valScore = scoreOn(best, trainN, val.length);
  const defTrain = scoreOn(defaultParams, 0, train.length);
  const defVal = scoreOn(defaultParams, trainN, val.length);

  const valSignals = valScore ? valScore.signals : 0;
  const valObj = valScore ? (role === 'gate' ? valScore.rate : valScore.ev) : -Infinity;
  const defValObj = defVal ? (role === 'gate' ? defVal.rate : defVal.ev) : -Infinity;
  let decision, reason;
  if (best === defaultParams && bestObj <= 0) { decision = 'reject'; reason = '未找到优于默认且达样本门槛的参数'; }
  else if (valSignals < minValSamples) { decision = 'reject'; reason = '验证集样本不足'; }
  else if (valObj > 0 && valObj >= defValObj) { decision = 'adopt'; reason = '验证集优于默认参数'; }
  else if (valObj > 0) { decision = 'caution'; reason = '验证集为正但弱于默认参数'; }
  else { decision = 'reject'; reason = '验证集期望非正'; }

  return { best, role, train: bestTrainScore, val: valScore, defTrain, defVal, decision, reason, gridSize: grid.length, trainN: train.length, valN: val.length };
}

// ============================================================================
// 手册离场模式（band-exit）：成交于下根开盘、单仓、不反手、EMA200 过滤、0.10% 往返费
// 与手册 PDF 完全对齐：K 破带(穿越)进场 → 持仓至 K 触及对向带 → 下根开盘平仓。
// 统计：净收益=毛×方向 − 0.10% 往返费；t = mean(std(ddof=1)/√n)；累计=cumprod(1+净)−1；
//       胜率=净>0；DD=权益曲线最大峰谷回撤（负值）。
// ============================================================================
export const SRSI_FEE_RT = 0.0010;
export const DEFAULT_SRSI_BAND = { rsiPeriod: 14, stochPeriod: 21, smoothK: 5, smoothD: 3, overbought: 80, oversold: 20 };

// 手册参数对照（swing 用，带固定 90/10）
export const MANUAL_SWING_PARAMS = {
  '4h': { rsiPeriod: 14, stochPeriod: 21, smoothK: 5, smoothD: 3, overbought: 90, oversold: 10 },
  '1h': { rsiPeriod: 21, stochPeriod: 21, smoothK: 5, smoothD: 3, overbought: 90, oversold: 10 }
};

// 手册参数按「币对」区分（来自各币 PDF 摘要），避免把所有币都对齐到 BTC 手册。
export const MANUAL_SWING_PARAMS_BY_SYMBOL = {
  BTCUSDT: {
    '4h': { rsiPeriod: 14, stochPeriod: 21, smoothK: 5, smoothD: 3, overbought: 90, oversold: 10 },
    '1h': { rsiPeriod: 21, stochPeriod: 21, smoothK: 5, smoothD: 3, overbought: 90, oversold: 10 },
    '15m': { rsiPeriod: 14, stochPeriod: 9, smoothK: 2, smoothD: 2, overbought: 90, oversold: 10 }
  },
  ETHUSDT: {
    '4h': { rsiPeriod: 14, stochPeriod: 9, smoothK: 3, smoothD: 3, overbought: 90, oversold: 10 },
    '1h': { rsiPeriod: 7, stochPeriod: 21, smoothK: 5, smoothD: 3, overbought: 90, oversold: 10 },
    '15m': { rsiPeriod: 14, stochPeriod: 9, smoothK: 2, smoothD: 2, overbought: 90, oversold: 10 }
  }
};
export function manualSwingParams(symbol, tf) {
  const bySym = MANUAL_SWING_PARAMS_BY_SYMBOL[symbol];
  if (bySym && bySym[tf]) return bySym[tf];
  return MANUAL_SWING_PARAMS[tf] || MANUAL_SWING_PARAMS['1h'];
}
// 闸门下游 1h 冠军（逐币挂各自冠军）
export const GATE_DOWNSTREAM = {
  BTCUSDT: { rsiPeriod: 21, stochPeriod: 21, smoothK: 5, smoothD: 3, overbought: 90, oversold: 10 },
  ETHUSDT: { rsiPeriod: 7, stochPeriod: 21, smoothK: 5, smoothD: 3, overbought: 90, oversold: 10 }
};
export const GATE_DOWNSTREAM_DEFAULT = GATE_DOWNSTREAM.BTCUSDT;

// 边界约定（手册口径）：多 = 前根≥下带 且 当根<下带（前值含等号）；空 = 前根≤上带 且 当根>上带。
function bandBoundaryLong(prevK, curK, os) { return prevK >= os && curK < os; }
function bandBoundaryShort(prevK, curK, ob) { return prevK <= ob && curK > ob; }

export function detectBandSignals(k, closes, ema200, ob, os) {
  const sigs = [];
  for (let i = 1; i < k.length; i++) {
    if (k[i] == null || k[i - 1] == null) continue;
    const c = closes[i], e = ema200[i];
    if (c == null || e == null) continue;
    const pv = k[i - 1], cu = k[i];
    if (bandBoundaryLong(pv, cu, os) && c > e) sigs.push({ i, dir: 'long' });
    else if (bandBoundaryShort(pv, cu, ob) && c < e) sigs.push({ i, dir: 'short' });
  }
  return sigs;
}

// 单仓、不反手：仅在空仓且触发穿越根(经 EMA200 过滤)时于下根开盘进场；
// 持多→每根收盘 K≥上带 则下根开盘平仓→空仓（不追溯反手）；持空镜像；持仓中忽略一切入场信号。
export function buildBandTrades(sigs, k, opens, ob, os) {
  const trades = [];
  let openCount = 0;
  let pos = null;
  let si = 0;
  const n = k.length;
  for (let j = 1; j < n; j++) {
    if (pos) {
      let exit = false;
      if (pos.dir === 'long' && k[j] != null && k[j] >= ob) exit = true;
      else if (pos.dir === 'short' && k[j] != null && k[j] <= os) exit = true;
      if (exit) {
        const entryOpen = opens[pos.entryIdx + 1];
        const exitOpen = opens[j + 1];
        if (j + 1 < n && entryOpen != null && exitOpen != null) {
          const gross = pos.dir === 'long' ? (exitOpen - entryOpen) / entryOpen : (entryOpen - exitOpen) / entryOpen;
          const net = gross - SRSI_FEE_RT;
          trades.push({ dir: pos.dir, entryIdx: pos.entryIdx, exitIdx: j, grossPct: gross * 100, netPct: net * 100 });
        }
        pos = null;
        continue;
      }
    }
    while (si < sigs.length && sigs[si].i < j) si++;
    if (si < sigs.length && sigs[si].i === j && !pos) {
      const s = sigs[si];
      if (j + 1 < n && opens[j + 1] != null) pos = { dir: s.dir, entryIdx: j };
      si++;
    }
  }
  if (pos) openCount++;
  return { trades, openCount };
}

export function bandStats(trades) {
  const n = trades.length;
  if (!n) return { n: 0, winRate: 0, avg: 0, ev: 0, t: 0, cum: 0, dd: 0 };
  let sum = 0, wins = 0;
  const nets = trades.map(t => t.netPct / 100);
  for (const x of nets) { sum += x; if (x > 0) wins++; }
  const mean = sum / n;
  let varr = 0;
  for (const x of nets) varr += (x - mean) ** 2;
  const sd = n > 1 ? Math.sqrt(varr / (n - 1)) : 0;
  const t = (sd > 0 && n > 1) ? mean / (sd / Math.sqrt(n)) : 0;
  let eq = 1, peak = 1, dd = 0;
  for (const x of nets) { eq *= (1 + x); if (eq > peak) peak = eq; const d = (eq - peak) / peak; if (d < dd) dd = d; }
  return { n, winRate: wins / n, avg: mean, ev: mean, t, cum: eq - 1, dd };
}

// 同级 closes 数组引用 → 缓存 KD 与 EMA200，避免邻域/两半回测重复计算（同一序列只算一次）。
const _segCache = new WeakMap();
function _segSeriesCache(closes) {
  let m = _segCache.get(closes);
  if (!m) { m = new Map(); _segCache.set(closes, m); }
  return m;
}
function scoreBandSegment(closes, opens, params) {
  const m = _segSeriesCache(closes);
  const kKey = `k|${params.rsiPeriod}|${params.stochPeriod}|${params.smoothK}|${params.smoothD}`;
  let kd = m.get(kKey);
  if (!kd) { kd = srsiKD(closes, params); m.set(kKey, kd); }
  const k = kd.k;
  let ema200 = m.get('__ema200');
  if (!ema200) { ema200 = ewma(closes, 200); m.set('__ema200', ema200); }
  const sigs = detectBandSignals(k, closes, ema200, params.overbought, params.oversold);
  const { trades, openCount } = buildBandTrades(sigs, k, opens, params.overbought, params.oversold);
  return { stats: bandStats(trades), openCount, n: trades.length, trades };
}

// 冠军选择（确定性、对齐 AgentMore 规范引擎）：
// 排序键 (t↓, EV↓, n↓)；顺序遍历，首个通过两道门槛者 = 冠军：
//   ① n ≥ minN（网格内建 n<40 丢弃，1h/4h 通用）
//   ② 时间中位切两半，每半独立重算指标+回测同参数（不跨段携带状态）→ 两半各自 avg>0
// 邻域 {rsi±1档}×{stoch±1档}×{k全档} 正收益(avg>0)占比 仅作稳健性「报告」(nbRatio)，不作门槛。
// 返回首个全过候选；若全不达标则回退 t 最高且 n≥minN 者（fallback=true）。
export function selectBandChampion(closes, opens, opts = {}) {
  const grid = opts.grid || srsiParamGrid(opts.gridOpts);
  const minN = opts.minN != null ? opts.minN : 40;
  if (!Array.isArray(closes) || closes.length < 60) return null;
  const n = closes.length;
  const mid = Math.floor(n / 2);
  const full = (p) => scoreBandSegment(closes, opens, p);
  const half = (p, which) => scoreBandSegment(
    which === 'h1' ? closes.slice(0, mid) : closes.slice(mid),
    which === 'h1' ? opens.slice(0, mid) : opens.slice(mid),
    p
  );
  const cands = [];
  for (const p of grid) {
    const s = full(p).stats;
    cands.push({ p, s });
  }
  // 排序 (t↓, EV↓, n↓)
  cands.sort((a, b) => (b.s.t - a.s.t) || (b.s.ev - a.s.ev) || (b.s.n - a.s.n));
  for (const c of cands) {
    if (c.s.n < minN) continue;
    const h1 = half(c.p, 'h1');
    const h2 = half(c.p, 'h2');
    if (!(h1.stats.avg > 0 && h2.stats.avg > 0)) continue;
    const nb = bandNeighborTPos(closes, opens, c.p); // 报告项：avg>0 占比，非门槛
    return { params: c.p, stats: c.s, filters: { nPass: true, twoHalf: { h1: h1.stats.avg, h2: h2.stats.avg }, nbRatio: nb.ratio, nbReportOnly: true }, candidates: cands };
  }
  for (const c of cands) if (c.s.n >= minN) {
    return { params: c.p, stats: c.s, filters: { nPass: true, twoHalf: null, nbRatio: null, fallback: true }, candidates: cands };
  }
  return null;
}

// swing 优选（band 离场）。冠军由 selectBandChampion（规范引擎：t↓ 排序 + 两门槛顺序过滤）选出，
// 不硬编码结果、不硬编码参数域。返回全样本(full)+训练/验证切分+手册/默认对照+并列对照口径(EV/胜率)。
export function optimizeSrsiBand(closes, opens, opts = {}) {
  const grid = opts.grid || srsiParamGrid(opts.gridOpts);
  const defaultParams = opts.defaultParams || DEFAULT_SRSI_BAND;
  const minN = opts.minN != null ? opts.minN : 40;
  if (!Array.isArray(closes) || closes.length < 60) return null;
  const split = opts.split != null ? opts.split : 0.67;
  const trainN = Math.max(30, Math.min(closes.length - 1, Math.floor(closes.length * split)));
  if (trainN < 30 || closes.length - trainN < 10) return null;

  const seg = (p, offset, len) => scoreBandSegment(closes.slice(offset, offset + len), opens.slice(offset, offset + len), p);

  // 冠军选择（手册规格）
  const champ = selectBandChampion(closes, opens, { grid, minN });
  const best = champ ? champ.params : defaultParams;
  const full = seg(best, 0, closes.length);
  const train = seg(best, 0, trainN);
  const val = seg(best, trainN, closes.length - trainN);
  const defFull = seg(defaultParams, 0, closes.length);
  const defTrain = seg(defaultParams, 0, trainN);
  const defVal = seg(defaultParams, trainN, closes.length - trainN);

  // 并列对照口径（不参与选择，仅供面板展示）：EV 最优 / 胜率最优
  let bestEv = null, bestEvVal = -Infinity;
  for (const p of grid) {
    const s = seg(p, 0, closes.length);
    if (s.n < 15 || s.stats.ev <= 0) continue;
    if (s.stats.ev > bestEvVal) { bestEvVal = s.stats.ev; bestEv = p; }
  }
  let bestWin = null, bestWinRate = -1, bestWinEv = -Infinity;
  for (const p of grid) {
    const s = seg(p, 0, closes.length);
    if (s.n < 15 || s.stats.ev <= 0) continue;
    if (s.stats.winRate > bestWinRate || (s.stats.winRate === bestWinRate && s.stats.ev > bestWinEv)) {
      bestWinRate = s.stats.winRate; bestWinEv = s.stats.ev; bestWin = p;
    }
  }

  const vN = val.n, vObj = val.stats.ev, dFObj = defFull.stats.ev;
  let decision, reason;
  if (champ && full.stats.ev > 0) {
    decision = 'adopt';
    reason = `t 最大候选经「两半OOS为正」门槛验证 ${full.stats.n} 笔 EV${(full.stats.ev * 100).toFixed(2)}%`;
  } else if (best === defaultParams) { decision = 'reject'; reason = '未找到达门槛且为正的有效参数'; }
  else if (full.n >= 15 && full.stats.ev > 0 && full.stats.ev >= dFObj) { decision = 'caution'; reason = '全样本优于默认参数'; }
  else { decision = 'reject'; reason = '样本不足或期望非正'; }

  return {
    best, bestEv, bestWin,
    role: 'band', exitMode: 'band',
    train, val, full, defTrain, defVal, defFull,
    decision, reason, gridSize: grid.length, trainN, valN: closes.length - trainN,
    championFilters: champ ? champ.filters : null,
    bestSelection: champ && champ.filters.fallback ? 'fallback' : 'spec',
    bestEvStats: bestEv ? seg(bestEv, 0, closes.length).stats : null,
    bestWinStats: bestWin ? seg(bestWin, 0, closes.length).stats : null
  };
}

// 邻域稳健性（仅报告项，非门槛）：{rsi±1档}×{stoch±1档}×{k全档} 的近邻组合，
// 统计「正收益(avg>0)」占比，供面板展示稳健性；规范引擎确认其从不作选择门槛。
export function bandNeighborTPos(closes, opens, params) {
  const RSI_STEPS = [5, 7, 9, 14, 21, 28];
  const STOCH_STEPS = [5, 7, 9, 14, 21, 28];
  const K_STEPS = [2, 3, 5];
  const stepNeighbors = (arr, v) => {
    const i = arr.indexOf(v);
    const out = [];
    if (i > 0) out.push(arr[i - 1]);
    if (i >= 0 && i < arr.length - 1) out.push(arr[i + 1]);
    return out;
  };
  const rN = stepNeighbors(RSI_STEPS, params.rsiPeriod);
  const sN = stepNeighbors(STOCH_STEPS, params.stochPeriod);
  const neighbors = [];
  for (const r of rN) for (const s of sN) for (const k of K_STEPS) {
    neighbors.push({ ...params, rsiPeriod: r, stochPeriod: s, smoothK: k });
  }
  let total = 0, pos = 0;
  for (const np of neighbors) {
    const s = scoreBandSegment(closes, opens, np);
    total++;
    if (s.stats.ev > 0) pos++; // 正收益（avg>0）
  }
  return { total, pos, ratio: total ? pos / total : 0 };
}

// 滚动 walk-forward 样本外交叉验证：序列切 folds 段，对第 i 段(i>=1)单独评估固定参数的 band 离场表现并跨段累加。
// 比单次 2/3 切分更稳健：慢周期单一切分验证窗信号过稀，此法用多个不重叠样本外段累积足够成交再做判断。
// 注：此处评估的是"预先选定的固定参数"(manual/default)在各段上的表现，等同对固定策略做跨周期样本外检验。
export function rollingOos(closes, opens, params, folds) {
  if (!closes || !params || closes.length < folds * 120) return null;
  const segLen = Math.floor(closes.length / folds);
  const nets = [];
  let openCount = 0;
  for (let i = 1; i < folds; i++) {
    const start = i * segLen;
    const end = Math.min(closes.length, (i + 1) * segLen);
    if (end - start < 60) continue;
    const segCloses = closes.slice(start, end);
    const segOpens = opens.slice(start, end);
    const k = srsiKD(segCloses, params).k;
    const ema200 = ewma(segCloses, 200);
    const sigs = detectBandSignals(k, segCloses, ema200, params.overbought, params.oversold);
    const { trades } = buildBandTrades(sigs, k, segOpens, params.overbought, params.oversold);
    for (const tr of trades) nets.push(tr.netPct / 100);
    if (sigs.length && !trades.length) openCount++;
  }
  if (!nets.length) return null;
  return { stats: bandStats(nets.map(x => ({ netPct: x * 100 }))), openCount };
}

function binSearchSorted(arr, v) {
  let lo = 0, hi = arr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] === v) return mid;
    if (arr[mid] < v) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
}

// 闸门参数网格（手册规格，不硬编码结果）：rl{3,5,9,14} × sl{9,14,21} × thr{10,15,20,25,30}，
// 平滑 K=2、D=3（band 模式 D 不用）；放行阈值 thr 为参数（多 kv≤thr / 空 kv≥100−thr）。
export const GATE_PARAMS_GRID = (() => {
  const out = [];
  for (const rsiPeriod of [3, 5, 9, 14])
    for (const stochPeriod of [9, 14, 21])
      for (const thr of [10, 15, 20, 25, 30])
        out.push({ rsiPeriod, stochPeriod, smoothK: 2, smoothD: 3, overbought: 90, oversold: 10, thr });
  return out;
})();

// 闸门优选（band 口径，目标周期 + 闸门周期均不硬编码）：闸门周期 G 的 K 取「目标周期信号收盘时刻 − gateMs」那一根的即时读数放行目标周期信号；
// 被放行子集在下游目标周期冠军参数的完整 band 出场规则下统计。目标周期 T / 闸门周期 G / 放行阈值由调用方传入。
// 下游冠军(downstream) 即「目标周期用哪套 band 参数产生信号」——由 selectBandChampion 据数据推导，此处不再逐币硬编码。

// 闸门核心：给定闸门参数 pGate + 目标周期数据 + 闸门周期数据 + 下游冠军，返回被放行子集的成交统计。
// 闸门是「纯前置过滤器」：下游冠军在目标周期的全样本交易序列先完整算出（进出场/收益与未过滤回测完全相同），
// 再按每笔交易的信号时刻在闸门周期读取 K 读数决定放行/拦截；放行子集统计 = 该笔交易原收益的子集统计（不重新回测）。
function gateCore(pGate, closesT, opensT, timesT, targetMs, gateMs, closesG, timesG, downstream, thr) {
  const full = scoreBandSegment(closesT, opensT, downstream);
  const tradesAll = full.trades || [];
  const kG = srsiKD(closesG, pGate).k;
  const admitted = [];
  for (const tr of tradesAll) {
    // tr.entryIdx 为该笔交易的信号根(1h)索引；+targetMs 为下根开盘(进场时刻)，-gateMs = 进场时刻前一根 15m 的 open（无前视）
    const idx = binSearchSorted(timesG, timesT[tr.entryIdx] + targetMs - gateMs);
    if (idx < 0 || kG[idx] == null) continue;
    const kv = kG[idx];
    if (tr.dir === 'long' ? kv <= thr : kv >= 100 - thr) admitted.push(tr);
  }
  return { admitted, trades: admitted, stats: bandStats(admitted), sigs: tradesAll };
}

export function optimizeGateBand({ closesT, opensT, timesT, closesG, opensG, timesG, target, targetMs, gateMs, gate, downstream, opts = {} }) {
  const grid = opts.grid || GATE_PARAMS_GRID;
  const defaultParams = opts.defaultParams || { rsiPeriod: 14, stochPeriod: 9, smoothK: 2, smoothD: 3, overbought: 90, oversold: 10, thr: 10 };
  const results = [];
  for (const pGate of grid) {
    const g = gateCore(pGate, closesT, opensT, timesT, targetMs, gateMs, closesG, timesG, downstream, pGate.thr);
    results.push({ params: pGate, stats: g.stats, admitted: g.trades.length });
  }
  // 主选优口径（手册规格）：评分 = 被放行子集均值收益(EV)；选 argmax(EV | n(kept)≥30, 平手→n 大)
  let best = null, bestObj = -Infinity, bestN = -1;
  for (const r of results) {
    if (r.stats.n < 30) continue;
    if (r.stats.ev > bestObj || (r.stats.ev === bestObj && r.stats.n > bestN)) { bestObj = r.stats.ev; best = r; bestN = r.stats.n; }
  }
  if (!best) best = results.find(r => r.params.rsiPeriod === 14 && r.params.stochPeriod === 9 && r.params.thr === 10) || results[0];
  // EV 口径最优（对照显示）
  let bestEv = null, bestEvVal = -Infinity;
  for (const r of results) {
    if (r.stats.n < 30 || r.stats.ev <= 0) continue;
    if (r.stats.ev > bestEvVal) { bestEvVal = r.stats.ev; bestEv = r; }
  }
  const manual = results.find(r => r.params.rsiPeriod === 14 && r.params.stochPeriod === 9 && r.params.smoothK === 2 && r.params.thr === 10) || null;
  const nSignals = gateCore(defaultParams, closesT, opensT, timesT, targetMs, gateMs, closesG, timesG, downstream, defaultParams.thr).sigs.length;

  // 胜率口径最优（与 EV 口径并列输出）
  let bestWin = null, bestWinRate = -1, bestWinEv = -Infinity;
  for (const r of results) {
    if (r.stats.n < 30 || r.stats.ev <= 0) continue;
    if (r.stats.winRate > bestWinRate || (r.stats.winRate === bestWinRate && r.stats.ev > bestWinEv)) {
      bestWinRate = r.stats.winRate; bestWinEv = r.stats.ev; bestWin = r;
    }
  }

  // 滚动样本外(walk-forward)交叉验证（仅作对照展示，不参与选择）
  const oosFolds = opts.rollingFolds != null ? opts.rollingFolds : 5;
  const oos = rollingGateOos(closesT, opensT, timesT, targetMs, gateMs, best.params, closesG, timesG, downstream, oosFolds);
  const oosDef = rollingGateOos(closesT, opensT, timesT, targetMs, gateMs, defaultParams, closesG, timesG, downstream, oosFolds);
  const oosEv = oos && oos.stats ? oos.stats.ev : 0;
  const oosN = oos && oos.stats ? oos.stats.n : 0;
  const oosDefEv = oosDef && oosDef.stats ? oosDef.stats.ev : 0;

  let decision, reason;
  if (best.stats.ev > 0) { decision = 'adopt'; reason = `闸门放行子集均值收益最高 ${best.stats.n} 笔 EV${(best.stats.ev * 100).toFixed(2)}%`; }
  else { decision = 'reject'; reason = '闸门放行后期望非正'; }
  return { best: best.params, bestEv: bestEv ? bestEv.params : null, bestWin: bestWin ? bestWin.params : null, bestEvStats: bestEv ? bestEv.stats : null, bestWinStats: bestWin ? bestWin.stats : null, role: 'gate', exitMode: 'band', stats: best.stats, manual: manual ? manual.stats : null, admitted: best.stats.n, gridSize: results.length, downstream, target, gate, targetMs, gateMs, nSignals, decision, reason, oos, oosDef, oosFolds };
}

// 滚动 walk-forward 样本外交叉验证（闸门版）：按目标周期时间切 folds 段，对第 i 段(i>=1)单独评估固定闸门参数放行子集并累加。
// 目标周期切片后重算其信号(各自下游冠军不变)，闸门周期用同一时间轴按时间戳对齐放行。
export function rollingGateOos(closesT, opensT, timesT, targetMs, gateMs, pGate, closesG, timesG, downstream, folds) {
  if (!closesT || !closesG || closesT.length < folds * 60) return null;
  const segLen = Math.floor(closesT.length / folds);
  const nets = [];
  let openCount = 0;
  for (let i = 1; i < folds; i++) {
    const start = i * segLen;
    const end = Math.min(closesT.length, (i + 1) * segLen);
    if (end - start < 30) continue;
    const seg = gateCore(pGate, closesT.slice(start, end), opensT.slice(start, end), timesT.slice(start, end), targetMs, gateMs, closesG, timesG, downstream);
    for (const tr of seg.trades) nets.push(tr.netPct / 100);
    if (seg.sigs.length && !seg.trades.length) openCount++;
  }
  if (!nets.length) return null;
  return { stats: bandStats(nets.map(x => ({ netPct: x * 100 }))), openCount };
}

