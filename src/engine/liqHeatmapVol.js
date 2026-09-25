// ============================================================
// v1.6.51：清算热图（**成交量代理 OI**）— 纯函数模块（无 DOM / 无 fetch / 无副作用）
// ============================================================
// 定位：**只是参考显示，不接任何交易/资金**。
//
// 背景：PWA 里拿不到 OI / 多空持仓比（fapi.binance.com 本机被墙），无法用「ΔOI 建仓」
//   复刻 scripts/liq-heatmap/cohortModel.mjs。本模块改用**窗口内每根 bar 的成交量**当作
//   「这一根新开了多少名义仓位」的代理（成交量越大 ≈ 该价位建仓越多）。
//
// 模型（与 cohortModel.mjs 同构，但建仓权重 = bar 成交量）：
//   1) 逐 bar 当「一批建仓」：在**该 bar 的典型价** E=(h+l+c)/3 上建仓，名义量 = v[i]（成交量）；
//   2) 按 6 个杠杆档 L 折算清算价：
//        多头清算价 = E·(1 − 1/L + mmr)   空头清算价 = E·(1 + 1/L − mmr)
//      质量 = v[i] · 侧占比 · w_L；侧占比默认 **0.5**（无多空比数据时必须中性，UI 会标注）；
//   3) 扫价清除：价格从 c[i-1] 走到 c[i]，**下跌**（c[i]<c[i-1]）清除 [l[i], c[i-1]] 内的**多头**清算带，
//      **上涨**清除 [c[i-1], h[i]] 内的**空头**清算带（用 bar 的 l/h 扩展更真实）；
//   4) 衰减：每个 bar 全体质量 ×exp(−1/decayBars)（= 指数衰减 exp(−age/decayBars)，age 以 bar 计）；
//   5) 价格轴用**对数**，bins 默认 180；网格列 = 窗口内每根 bar（colStep 可抽稀）。
//
// 硬约束（测试覆盖）：
//   · **完全确定性**（同输入两次结果逐位相同，无 Math.random）
//   · **因果**（第 i 列只用 ≤i 的数据；截断输入不改变前面的列）
//   · **不修改输入数组**（全部只读访问 / slice）
//   · 窗口内一次算完；起始 bar 之前的历史不参与（故窗口越长越有代表性，见 kchart 的 cfg.liqWin）
//
// 已知近似（诚实披露，UI 必须标注）：
//   · 杠杆分布 w_L 是假设；侧占比固定 0.5（无真实多空比）；
//   · 清算价范围外的仓位不进入显示网格（在图上不可见，属正常「离屏」）；
//   · 清算热图模型**未通过交易性验证**（scripts/liq-heatmap/REPORT.md：密度对价格无吸引力/无预测力）。

export const LH_DEF = {
  levs: [5, 10, 20, 25, 50, 100],   // 杠杆档位
  mmr: 0.004,                        // 维持保证金率
  decayBars: 60,                     // 质量指数衰减时间常数（bar）
  bins: 180,                         // 对数价格桶数
  padLog: 0.08,                      // 价格轴上下各留 8% 对数空间
  wL: { 5: .10, 10: .25, 20: .15, 25: .10, 50: .25, 100: .15 },  // 各杠杆建仓权重（和=1.0）
  colStep: 1,                        // 网格列抽稀（1=每根 bar 一列）
};

const isNum = (x) => typeof x === 'number' && isFinite(x);
const clamp01 = (x) => x < 0 ? 0 : (x > 1 ? 1 : x);

function _normOpts(opts) {
  const o = opts || {};
  const levs = (Array.isArray(o.levs) && o.levs.length)
    ? o.levs.filter((x) => isNum(x) && x > 1) : LH_DEF.levs.slice();
  const wL = (o.wL && typeof o.wL === 'object') ? o.wL : LH_DEF.wL;
  return {
    levs: levs.length ? levs : LH_DEF.levs.slice(),
    mmr: isNum(o.mmr) ? o.mmr : LH_DEF.mmr,
    decayBars: (isNum(o.decayBars) && o.decayBars > 0) ? o.decayBars : LH_DEF.decayBars,
    bins: (isNum(o.bins) && o.bins >= 8 && o.bins <= 2000) ? Math.floor(o.bins) : LH_DEF.bins,
    padLog: isNum(o.padLog) ? Math.max(0, Math.min(0.5, o.padLog)) : LH_DEF.padLog,
    wL,
    colStep: (isNum(o.colStep) && o.colStep >= 1) ? Math.floor(o.colStep) : LH_DEF.colStep,
    sideRatio: isNum(o.sideRatio) ? clamp01(o.sideRatio) : 0.5,
    // 可选：强制价格轴（{pLo,pHi}）——用于「同一坐标轴下」检验模型因果性/单元测试复现。
    // 不传时按输入窗口 low/high + padLog 自动推导（纯显示选择）。
    range: (o.range && isNum(o.range.pLo) && isNum(o.range.pHi) && o.range.pLo > 0 && o.range.pHi > o.range.pLo)
      ? { pLo: o.range.pLo, pHi: o.range.pHi } : null,
  };
}

// 内部引擎：一次遍历算出「网格 + 末列直方图」。wantGrid=false 时省掉网格内存（volCohorts 用）。
function _engine(bars, opts, wantGrid) {
  const O = _normOpts(opts);
  const bins = O.bins;
  const c = (bars && bars.c) || [];
  const h = (bars && bars.h) || [];
  const l = (bars && bars.l) || [];
  const v = (bars && bars.v) || [];
  const n = Array.isArray(c) ? c.length : 0;
  const levs = O.levs;
  const wL = O.wL;
  const dk = Math.exp(-1 / O.decayBars);   // 每 bar 衰减因子

  const base = {
    cols: 0, bins, colStep: O.colStep, pLo: NaN, pHi: NaN, ratio: NaN,
    grid: new Float32Array(0), maxV: 0, n, colStepUsed: O.colStep,
    long: new Float32Array(bins), short: new Float32Array(bins), liq: new Float32Array(bins),
    sideRatio: O.sideRatio, decayBars: O.decayBars, levs: levs.slice(), mmr: O.mmr,
  };
  if (n < 1) return base;

  const H = (i) => { const x = h[i]; return isNum(x) ? x : (isNum(c[i]) ? c[i] : NaN); };
  const L = (i) => { const x = l[i]; return isNum(x) ? x : (isNum(c[i]) ? c[i] : NaN); };
  const C = (i) => (isNum(c[i]) ? c[i] : NaN);

  // ---- 价格范围（对数）：默认取窗口 low/high + padLog；可用 opts.range 强制 ----
  let pLo, pHi;
  if (O.range) {
    pLo = O.range.pLo; pHi = O.range.pHi;
  } else {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) {
      const hh = H(i), ll = L(i);
      if (isNum(hh) && hh > hi) hi = hh;
      if (isNum(ll) && ll < lo) lo = ll;
    }
    if (!isNum(lo) || !isNum(hi) || !(lo > 0) || !(hi > 0)) return base;
    if (!(hi > lo)) { hi = lo * 1.001; lo = lo * 0.999; }
    const lnLo0 = Math.log(lo), lnHi0 = Math.log(hi);
    const lr = lnHi0 - lnLo0;
    pLo = Math.exp(lnLo0 - O.padLog * lr); pHi = Math.exp(lnHi0 + O.padLog * lr);
  }
  const lnLo = Math.log(pLo), lnHi = Math.log(pHi);
  const lnRatio = (lnHi - lnLo) / bins;   // 每个桶的对数宽度
  const ratio = Math.exp(lnRatio);
  // 价格 → 桶（越界返回 -1，调用方跳过；显示范围外属正常「离屏」）
  const binOf = (p) => {
    if (!(p > 0) || !isNum(p)) return -1;
    const b = Math.floor((Math.log(p) - lnLo) / lnRatio);
    return (b < 0 || b >= bins) ? -1 : b;
  };

  const cols = Math.floor((n - 1) / O.colStep) + 1;
  const grid = wantGrid ? new Float32Array(cols * bins) : new Float32Array(0);
  const longB = new Float32Array(bins);
  const shortB = new Float32Array(bins);
  let maxV = 0;

  const decayAll = () => { for (let b = 0; b < bins; b++) { longB[b] *= dk; shortB[b] *= dk; } };
  const clearRange = (arr, b0, b1) => {
    if (b0 < 0 || b1 < 0 || b0 >= bins || b1 >= bins) return;
    const a = Math.min(b0, b1), z = Math.max(b0, b1);
    for (let b = a; b <= z; b++) arr[b] = 0;
  };
  const addCohort = (E, notional) => {
    if (!(notional > 0) || !(E > 0)) return;
    const pLong = O.sideRatio, pShort = 1 - O.sideRatio;
    for (let k = 0; k < levs.length; k++) {
      const Lv = levs[k];
      const w = wL[Lv];
      if (!isNum(w) || !(w > 0)) continue;
      const mLong = notional * pLong * w, mShort = notional * pShort * w;
      if (mLong > 0) { const b = binOf(E * (1 - 1 / Lv + O.mmr)); if (b >= 0) longB[b] += mLong; }
      if (mShort > 0) { const b = binOf(E * (1 + 1 / Lv - O.mmr)); if (b >= 0) shortB[b] += mShort; }
    }
  };

  const snapshot = (i) => {
    const ci = Math.floor(i / O.colStep);
    if (wantGrid) {
      const rowBase = ci * bins;
      for (let b = 0; b < bins; b++) {
        const val = longB[b] + shortB[b];
        grid[rowBase + b] = val;
        if (val > maxV) maxV = val;
      }
    } else {
      for (let b = 0; b < bins; b++) { const val = longB[b] + shortB[b]; if (val > maxV) maxV = val; }
    }
  };

  for (let i = 0; i < n; i++) {
    if (i > 0) decayAll();
    const cPrev = C(i - 1), cCur = C(i);
    // 扫价清除：下跌清多头带（用 l[i]），上涨清空头带（用 h[i]）
    if (isNum(cPrev) && isNum(cCur) && cCur < cPrev) {
      const wick = L(i);
      const lowSweep = isNum(wick) && wick < cCur ? wick : cCur;
      clearRange(longB, binOf(lowSweep), binOf(cPrev));
    } else if (isNum(cPrev) && isNum(cCur) && cCur > cPrev) {
      const wick = H(i);
      const highSweep = isNum(wick) && wick > cCur ? wick : cCur;
      clearRange(shortB, binOf(cPrev), binOf(highSweep));
    }
    // 建仓（典型价）——先清后建，新仓不在同一根被扫
    const hh = H(i), ll = L(i), cc = C(i);
    if (isNum(hh) && isNum(ll) && isNum(cc)) {
      const E = (hh + ll + cc) / 3;
      const vol = isNum(v[i]) ? v[i] : 0;
      addCohort(E, vol * E);   // 基础币成交量 × 典型价 → USDT 名义（否则卡片会把 BTC 数量显示成 "$73"）
    }
    if (i % O.colStep === 0 || i === n - 1) snapshot(i);
  }

  const liq = new Float32Array(bins);
  for (let b = 0; b < bins; b++) liq[b] = longB[b] + shortB[b];

  return {
    cols, bins, colStep: O.colStep, pLo, pHi, ratio, grid, maxV, n,
    long: longB, short: shortB, liq,
    sideRatio: O.sideRatio, decayBars: O.decayBars, levs: levs.slice(), mmr: O.mmr,
  };
}

// 末列（全窗口累积）清算密度直方图 + 分侧拆分。
// 返回 { liq, long, short, pLo, pHi, bins, maxV, ... }（liq/long/short 为长度 bins 的 Float32Array，桶 b 对应价格 [pLo·ratio^b, pLo·ratio^(b+1)]）。
export function volCohorts(bars, opts) {
  return _engine(bars, opts, false);
}

// 对数价格 × 时间 的热力网格。
// 返回 { cols, bins, pLo, pHi, ratio, grid(Float32Array cols*bins), maxV, levelsAtCol(col), ... }
// grid[col*bins + b] = 该 bar 时点、该价格桶的清算质量（多头+空头）。
export function liqGrid(bars, opts) {
  const res = _engine(bars, opts, true);
  res.levelsAtCol = (col) => zonesAtCol(res, col);
  return res;
}

// 单列 → 连续非零桶合并成「区间（zone）」。
// 返回 [{ lo, hi, mass, score(0..100 相对 maxV), b0, b1 }]（lo/hi 为桶边界价格，lo<hi）。
export function zonesAtCol(res, col) {
  const out = [];
  if (!res || !res.grid || !(res.cols > 0) || !(res.bins > 0)) return out;
  const bins = res.bins;
  const c = Math.max(0, Math.min(res.cols - 1, (col | 0)));
  const rowBase = c * bins;
  const r = isNum(res.ratio) && res.ratio > 0 ? res.ratio : Math.exp((Math.log(res.pHi) - Math.log(res.pLo)) / bins);
  const maxV = res.maxV > 0 ? res.maxV : 0;
  let s = -1, sum = 0;
  for (let b = 0; b <= bins; b++) {
    const val = b < bins ? res.grid[rowBase + b] : 0;
    if (val > 0) { if (s < 0) { s = b; sum = 0; } sum += val; }
    else if (s >= 0) {
      out.push({
        lo: res.pLo * Math.pow(r, s),
        hi: res.pLo * Math.pow(r, b),
        mass: sum,
        score: maxV > 0 ? Math.round(Math.min(1, sum / maxV) * 100) : 0,
        b0: s, b1: b - 1,
      });
      s = -1;
    }
  }
  return out;
}

// 取某列「当前价上方 / 下方」质量最大的前 n 个区间（score 相对全局 maxV，可跨上下直接比较）。
// 返回 { above:[{lo,hi,mass,score,distPct}], below:[...] }；distPct = (区间几何中点 − price)/price×100（上方为正）。
export function topZones(res, col, price, n) {
  const empty = { above: [], below: [] };
  if (!res || !res.grid || !(res.cols > 0)) return empty;
  const zones = zonesAtCol(res, col);
  const p = (isNum(price) && price > 0) ? price : null;
  const above = [], below = [];
  for (let i = 0; i < zones.length; i++) {
    const z = zones[i];
    const mid = Math.sqrt(z.lo * z.hi);
    const distPct = p != null ? (mid - p) / p * 100 : NaN;
    const item = { lo: z.lo, hi: z.hi, mass: z.mass, score: z.score, distPct };
    if (p == null) { above.push(item); continue; }
    if (mid >= p) above.push(item); else below.push(item);
  }
  above.sort((a, b) => b.mass - a.mass);
  below.sort((a, b) => b.mass - a.mass);
  const k = (isNum(n) && n > 0) ? Math.floor(n) : 2;
  return { above: above.slice(0, k), below: below.slice(0, k) };
}

// ============================================================
// v1.6.52：清算雷达（DOM 卡片数据源）——把某列区间按「当前价上方 / 下方」分组，
//   各取质量最大的前 n 条，并额外给出「距离最近」的上/下方档位（= 用户最关心的「临近价位的量」）。
// 返回 { price, up:[{rank,lo,hi,mass,score,distPct,nearest}], down:[...],
//        nearUp:{lo,hi,mass,score,distPct}|null, nearDown:{...}|null, maxMass, totalMass }
//   · distPct = (区间中心价 − price)/price×100（上方为正、下方为负）
//   · nearest：该组内距离最小的那条（标记，可能不在前 n 条内）
//   · maxMass/totalMass：整列所有区间的最大质量 / 质量总和
// 空输入 / col 越界 / price<=0 → 返回空结构（不抛异常）。
// ============================================================
function _nearestOf(arr) {
  if (!arr || !arr.length) return null;
  let best = null, bd = Infinity;
  for (let i = 0; i < arr.length; i++) {
    const d = Math.abs(arr[i].distPct);
    if (isNum(d) && d < bd) { bd = d; best = arr[i]; }
  }
  return best;
}

export function radarModel(gridRes, col, price, opts) {
  const empty = { up: [], down: [], nearUp: null, nearDown: null, maxMass: 0, totalMass: 0 };
  if (!gridRes || !gridRes.grid || !(gridRes.cols > 0) || !(gridRes.bins > 0)) return empty;
  if (!isNum(col) || col < 0 || col >= gridRes.cols) return empty;
  if (!isNum(price) || !(price > 0)) return empty;
  const n = (opts && isNum(opts.n) && opts.n > 0) ? Math.floor(opts.n) : 3;
  const zones = zonesAtCol(gridRes, col);
  if (!zones.length) return { price, up: [], down: [], nearUp: null, nearDown: null, maxMass: 0, totalMass: 0 };
  let maxMass = 0, totalMass = 0;
  const up = [], down = [];
  for (let i = 0; i < zones.length; i++) {
    const z = zones[i];
    const mid = Math.sqrt(z.lo * z.hi);
    const distPct = (mid - price) / price * 100;
    if (z.mass > maxMass) maxMass = z.mass;
    totalMass += z.mass;
    (mid >= price ? up : down).push({ lo: z.lo, hi: z.hi, mass: z.mass, score: z.score, distPct });
  }
  up.sort((a, b) => b.mass - a.mass);
  down.sort((a, b) => b.mass - a.mass);
  const nearU = _nearestOf(up), nearD = _nearestOf(down);
  const pack = (it, rank) => ({
    rank, lo: it.lo, hi: it.hi, mass: it.mass, score: it.score, distPct: it.distPct,
    nearest: it === nearU || it === nearD,
  });
  const clean = (it) => it ? { lo: it.lo, hi: it.hi, mass: it.mass, score: it.score, distPct: it.distPct } : null;
  return {
    price,
    up: up.slice(0, n).map((it, k) => pack(it, k + 1)),
    down: down.slice(0, n).map((it, k) => pack(it, k + 1)),
    nearUp: clean(nearU),
    nearDown: clean(nearD),
    maxMass, totalMass,
  };
}

// 价格区间人类可读：'84,786 – 85,002'（千分位、四舍五入、lo>hi 自动交换；非法 → '--'）
export function fmtLiqRange(lo, hi) {
  if (!isNum(lo) || !isNum(hi)) return '--';
  let a = lo, b = hi;
  if (a > b) { const t = a; a = b; b = t; }
  const f = (x) => String(Math.round(x)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return f(a) + ' – ' + f(b);
}

// 浮层位置钳制（纯函数，可单测）：留 4px 边距，容器小于卡片时贴左上。
// 与 kchart.js 的 clampBoxPos 同语义（那边已改为委托本函数，避免逻辑分叉）。
export function clampCardPos(x, y, w, h, bw, bh) {
  if (![x, y, w, h, bw, bh].every((v) => typeof v === 'number' && isFinite(v))) return { x: 4, y: 4 };
  const cx = bw - w - 4, cy = bh - h - 4;
  return { x: Math.max(4, Math.min(cx < 4 ? 4 : cx, x)), y: Math.max(4, Math.min(cy < 4 ? 4 : cy, y)) };
}

// 人类可读名义量：$1.2M / $340K / $12.3K / $999 / $0.00；非法 → '--'
export function fmtLiqUsd(x) {
  if (!isNum(x)) return '--';
  const neg = x < 0, a = Math.abs(x);
  let s;
  if (a >= 1e9) s = (a / 1e9).toFixed(2) + 'B';
  else if (a >= 1e6) s = (a / 1e6).toFixed(2) + 'M';
  else if (a >= 1e3) s = (a / 1e3).toFixed(1) + 'K';
  else s = a >= 10 ? a.toFixed(0) : a.toFixed(2);
  return (neg ? '-' : '') + '$' + s;
}
