// 自适应组合 —— 共享纯函数（无 DOM，可单测）
// 移植自已严格验证的研究实现，逐位对齐：
//   scripts/adaptive-portfolio/lib/regime.mjs   → realizedVol / rollingPercentileLog
//   scripts/carry-harvest/carry.mjs             → runCarry 的再平衡/资金费/权益数学
// 最终算法（定稿，勿改）：
//   volQ = 30 日已实现波动率的 1 年滚动分位（因果）
//   g    = clamp(k2 − k1·volQ, floor, cap)      // k1=1.4, k2=1.6, floor=0.3, cap=1.2
//   w_A  = min(1, w0·g)                          // Alpha 腿资本权重
//   w_C  = 1 − w_A                               // carry 腿资本权重
// 红线：无前视——volQ 必须由调用方右移（默认 shift=1，取「已收盘」那根）后再使用。

/**
 * 已实现波动率（年化）。与 regime.mjs realizedVol 逐位一致。
 * @param {ArrayLike<number>} closes 收盘价
 * @param {number} win 滚动窗口（1h bar 数）
 * @param {number} barsPerYear 年化因子（1h → 8760）
 * @returns {Float64Array} 与 closes 等长，预热期 NaN
 */
export function realizedVolSeries(closes, win = 720, barsPerYear = 8760) {
  const n = closes.length, out = new Float64Array(n).fill(NaN);
  if (n < 2) return out;
  const r = new Float64Array(n);
  for (let i = 1; i < n; i++) r[i] = Math.log(closes[i] / closes[i - 1]);
  let s = 0, s2 = 0;
  for (let i = 1; i < n; i++) {
    s += r[i]; s2 += r[i] * r[i];
    if (i > win) { s -= r[i - win]; s2 -= r[i - win] * r[i - win]; }
    if (i >= win) {
      const mu = s / win, v = Math.max(0, s2 / win - mu * mu);
      out[i] = Math.sqrt(v * barsPerYear);
    }
  }
  return out;
}

/**
 * 滚动分位（对数分箱直方图，O(n·bins)，因果）。与 regime.mjs rollingPercentileLog 逐位一致。
 * @param {ArrayLike<number>} arr 输入序列（如已实现波动率）
 * @param {number} win 滚动窗口
 * @returns {Float64Array} 分位 0..1，预热/非法值处 NaN
 */
export function rollingPercentileSeries(arr, win, { lo = 0.005, hi = 5.0, bins = 120 } = {}) {
  const llo = Math.log(lo), lhi = Math.log(hi);
  const binOf = (v) => {
    if (!(v > 0) || !Number.isFinite(v)) return -1;
    if (v <= lo) return 0;
    if (v >= hi) return bins - 1;
    return Math.max(0, Math.min(bins - 1, Math.floor((Math.log(v) - llo) / (lhi - llo) * bins)));
  };
  const hist = new Int32Array(bins);
  const out = new Float64Array(arr.length).fill(NaN);
  let count = 0;
  for (let i = 0; i < arr.length; i++) {
    const b = binOf(arr[i]); if (b >= 0) { hist[b]++; count++; }
    if (i >= win) { const b0 = binOf(arr[i - win]); if (b0 >= 0) { hist[b0]--; count--; } }
    if (i >= win - 1 && count > 0 && b >= 0) {
      let below = 0; for (let q = 0; q < b; q++) below += hist[q];
      out[i] = (below + 0.5 * hist[b]) / count;
    }
  }
  return out;
}

/**
 * 取某序列的「当前」波动率分位（默认右移一根，只用已收盘 bar，防前视）。
 * 研究口径：run-06 用 `volQ[i-1]`（i=当前 in-flight bar）→ 等价于 shift=1 时的 out[n-2]。
 * @param {ArrayLike<number>} closes 收盘价（可含 in-flight 最后一根）
 * @param {object} [opts] { volWin, rankWin, barsPerYear, shift, lo, hi, bins }
 * @returns {number} 0..1；数据不足或非有限 → NaN（调用方据此进入预热）
 */
export function volQuantile(closes, { volWin = 720, rankWin = 8760, barsPerYear = 8760, shift = 1, lo = 0.005, hi = 5.0, bins = 120 } = {}) {
  const n = closes ? closes.length : 0;
  const idx = n - 1 - shift;
  if (idx < 0 || n < rankWin + shift) return NaN;   // 需 1 年 1h 数据 + 右移
  if (idx < volWin) return NaN;                     // 已实现波动率预热
  const rv = realizedVolSeries(closes, volWin, barsPerYear);
  const q = rollingPercentileSeries(rv, rankWin, { lo, hi, bins });
  const v = q[idx];
  return Number.isFinite(v) ? v : NaN;
}

/**
 * Alpha 腿资本权重 w_A = min(1, w0·g)，g = clamp(k2 − k1·volQ, floor, cap)。
 * volQ 非有限（预热）→ g=1（退化为静态基线 w0）。
 */
export function adaptiveAlphaWeight(volQ, { w0 = 0.5, k1 = 1.4, k2 = 1.6, floor = 0.3, cap = 1.2 } = {}) {
  const g = Number.isFinite(volQ) ? Math.max(floor, Math.min(cap, k2 - k1 * volQ)) : 1;
  return Math.min(1, w0 * g);
}

/** 返回 { g, wA, wC }；wC = 1 − wA。 */
export function adaptiveWeights(volQ, opts = {}) {
  const { w0 = 0.5, k1 = 1.4, k2 = 1.6, floor = 0.3, cap = 1.2 } = opts;
  const g = Number.isFinite(volQ) ? Math.max(floor, Math.min(cap, k2 - k1 * volQ)) : 1;
  const wA = Math.min(1, w0 * g);
  return { g, wA, wC: 1 - wA };
}

/**
 * carry 腿目标持仓（现货多 = 永续空 = f·legEquity）。
 * 研究口径：f = lev/(lev+1)（lev=3 → 0.75），永续保证金 = 名义/lev。
 * @returns {{spotQty:number, perpQty:number, margin:number, notional:number, f:number}}
 */
export function carryTargetQty(legEquity, lev, spotPx, perpPx, { frac = null } = {}) {
  const fmax = lev > 0 ? lev / (lev + 1) : 0;
  const f = Number.isFinite(frac) ? Math.max(0, Math.min(fmax, frac)) : fmax;
  const eq = Number.isFinite(legEquity) && legEquity > 0 ? legEquity : 0;
  const notional = f * eq;
  return {
    spotQty: spotPx > 0 ? notional / spotPx : 0,
    perpQty: perpPx > 0 ? -notional / perpPx : 0,
    margin: lev > 0 ? notional / lev : 0,
    notional,
    f,
  };
}

/**
 * 是否需要再平衡：名义相对权益偏离 > band（任一腿）即需要；目标为空仓而当前有仓亦需要。
 * @param {{spotQty:number, perpQty:number, spotPx:number, perpPx:number}} cur
 * @param {{spotQty?:number, perpQty?:number, notional:number}} target
 * @param {number} equity 腿权益
 * @param {number|object} band 0.10 或 { band }
 */
export function carryNeedsRebalance(cur, target, equity, band = 0.10) {
  const b = (band && typeof band === 'object') ? (band.band ?? 0.10) : (band ?? 0.10);
  if (!(equity > 0)) return false;
  const curSpotNot = (cur.spotQty || 0) * (cur.spotPx || 0);
  const curPerpNot = (cur.perpQty || 0) * (cur.perpPx || 0);   // 空头为负
  const tgtNot = (target && Number.isFinite(target.notional)) ? target.notional : 0;
  const eps = 1e-9;
  if (tgtNot <= 0) return Math.abs(curSpotNot) > eps || Math.abs(curPerpNot) > eps;
  if (Math.abs(curSpotNot - tgtNot) / equity > b) return true;
  if (Math.abs(-curPerpNot - tgtNot) / equity > b) return true;
  return false;
}

/**
 * 资金费结算额（USD，正=收入）。空头在 rate>0 时收取（perpQty<0 → pay>0）。
 * 与 carry.mjs `pay = -perpQty * px * funding` 逐位一致。
 */
export function fundingPay(perpQty, px, rate) {
  if (!Number.isFinite(perpQty) || !Number.isFinite(px) || !Number.isFinite(rate)) return 0;
  return -perpQty * px * rate;
}

/** 腿权益 = 现金 + 保证金 + 现货市值 + 永续市值（与 carry.mjs equityAt 同构）。 */
export function carryEquityAt(cash, margin, spotQty, perpQty, spotPx, perpPx) {
  const z = (v) => (Number.isFinite(v) ? v : 0);
  return z(cash) + z(margin) + z(spotQty) * z(spotPx) + z(perpQty) * z(perpPx);
}

/** 通用数值钳制。 */
export function clamp(x, lo, hi) {
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}
