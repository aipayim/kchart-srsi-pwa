// Alpha 同源策略核心（浏览器/Node 逐位一致）——从 scripts/goal3-pwa-core.mjs 复制（commit 386921d）
// ⚠ 修改顺序红线：只允许改 scripts/goal3-pwa-core.mjs → 跑 node scripts/goal4-run-align.mjs 与
//    node scripts/goal5-fixture.mjs 对齐验证 → 再同步本文件。反向改动会使前端结果失去 Node 权威背书。
// 对齐证据：goal4-run-align（真实 BTC/ETH 现货 4 用例 Δ=0）+ goal5-fixture（合成 fixture 2 用例 Δ=0）。
// —— 基础工具 ——
export const FEE = 0.00045, SLIP = 0.0002, MMR = 0.004;
export function maxDD(eq) { let peak = -Infinity, dd = 0; for (const v of eq) { if (v > peak) peak = v; const d = (peak - v) / peak; if (d > dd) dd = d; } return dd; }
export function sharpeDaily(eq, times) {
  const dm = new Map(); for (let i = 0; i < eq.length; i++) dm.set(Math.floor(times[i] / 86400e3), eq[i]);
  const keys = [...dm.keys()].sort((a, b) => a - b); const r = [];
  for (let i = 1; i < keys.length; i++) r.push(dm.get(keys[i]) / dm.get(keys[i - 1]) - 1);
  if (r.length < 10) return 0;
  const mu = r.reduce((a, b) => a + b, 0) / r.length;
  const sd = Math.sqrt(r.reduce((a, b) => a + (b - mu) ** 2, 0) / (r.length - 1));
  return sd > 0 ? mu / sd * Math.sqrt(365) : 0;
}
export function annualized(eq0, eq1, times) {
  const days = (times[times.length - 1] - times[0]) / 86400e3;
  if (days <= 0 || !(eq0 > 0)) return -1;
  return Math.pow(eq1 / eq0, 365 / days) - 1;
}
// 已收盘高周期对齐：out[i] = 最后一根满足 T[j]+ms ≤ t[i] 的 j（防前视）
export function alignClosed(T, ms, t) { const out = new Int32Array(t.length); let j = -1; for (let i = 0; i < t.length; i++) { while (j + 1 < T.length && T[j + 1] + ms <= t[i]) j++; out[i] = j; } return out; }
// funding z（90 印滚动，因果）：fundingArr = [[tMs, rate], ...]
export function carryZSeries(t, fundingArr) {
  const frT = fundingArr.map(f => f[0]), frV = fundingArr.map(f => f[1]);
  const out = new Array(t.length).fill(null);
  let j = 0; const win = 90;
  for (let i = 0; i < t.length; i++) {
    while (j + 1 < frT.length && frT[j + 1] <= t[i]) j++;
    if (j + 1 < win) continue;
    let s = 0, s2 = 0;
    for (let q = j - win + 1; q <= j; q++) { s += frV[q]; s2 += frV[q] ** 2; }
    const mu = s / win, sd = Math.sqrt(Math.max(1e-12, s2 / win - mu * mu));
    out[i] = sd > 0 ? (frV[j] - mu) / sd : 0;
  }
  return out;
}
// GOAL2 combo 信号（权重 0.5 carry + 0.3 breakout + 0.2 momo；carry z 饱和 ±4.5）
// 组合信号因子分解（P0 信号驾驶舱）：返回三因子的加权贡献（carry×0.5 / momo×0.2 / brk×0.3）
// 与 comboWeight 同源同算法（comboWeight 现直接委托本函数），仅额外暴露中间量，不改任何计算结果。
// carryW/momoW/brkW 之和 = 组合原始权重分子；w = clamp(sum/4.5, ±1)（vol-target 缩放在 runBacktest 内另做）。
// ⚠ 红线：本函数与 scripts/goal3-pwa-core.mjs 逐字一致（修改须先改 goal3 并跑对齐）。
export function comboFactors(z, c1d, j) {
  const momo = j >= 10 ? c1d[j] / c1d[j - 10] - 1 : 0;
  let brk = 0;
  if (j >= 20) { let hi = -Infinity, lo = Infinity; for (let q = j - 20; q < j; q++) { if (c1d[q] > hi) hi = c1d[q]; if (c1d[q] < lo) lo = c1d[q]; } if (hi !== lo) brk = ((c1d[j] - lo) / (hi - lo)) * 2 - 1; }
  const cW = z == null ? 0 : Math.max(-4.5, Math.min(4.5, -z));
  const mW = Math.max(-4.5, Math.min(4.5, momo * 50));
  const bW = brk / 2 * 4.5;
  const carryW = 0.5 * cW, momoW = 0.2 * mW, brkW = 0.3 * bW;
  const sum = carryW + momoW + brkW;
  return { w: Math.max(-1, Math.min(1, sum / 4.5)), carryW, momoW, brkW, sum, cW, mW, bW };
}
export function comboWeight(z, c1d, j) { return comboFactors(z, c1d, j).w; }
// —— 现货/永续通用回测循环（与 goal2-bt.runStrategy 语义一致）——
// bars: {t,o,c}（1h）；bars1d: {t,c}（1d）；funding: [[t,rate],...]（现货传 []，信号层用 fundingZ 单独注入）
export function runBacktest(bars, bars1d, cfg = {}) {
  const { t, o, c } = bars, n = t.length;
  const funding = cfg.funding ?? [];
  const fundingZ = cfg.fundingZ ?? carryZSeries(t, funding);
  const levCap = cfg.levCap ?? 1, volTarget = cfg.volTarget ?? 0, band = cfg.band ?? 0.05;
  const volLB = cfg.volLookbackBars ?? 720, vtCap = cfg.vtCap ?? 1.5;
  const longOnly = cfg.longOnly ?? false, useFunding = cfg.useFunding !== false;
  const i0 = cfg.start ? t.findIndex(x => x >= cfg.start) : 0;
  const i1raw = cfg.end ? t.findIndex(x => x > cfg.end) : n - 1;
  const endI = (i1raw < 0 ? n - 1 : Math.min(i1raw, n - 1));
  if (i0 < 0 || endI - i0 < 100) return { error: '窗口数据不足' };
  const ad = alignClosed(bars1d.t, 86400e3, t);
  const rets = new Array(n).fill(0);
  for (let i = 1; i < n; i++) rets[i] = Math.log(c[i] / c[i - 1]);
  const eqs = [], ts = [], ws = [];
  let equity = 1, posW = 0, posEntry = 0, liqPrice = null;
  let fees = 0, fundingPaid = 0, liq = 0;
  const trades = []; let openTrade = null;
  let fIdx = 0; const startT = t[i0];
  for (let i = i0; i <= endI; i++) {
    if (useFunding) {
      while (fIdx < funding.length && funding[fIdx][0] <= t[i]) {
        const ft = funding[fIdx][0], fr = funding[fIdx][1]; fIdx++;
        if (ft < startT || posW === 0) continue;
        const pay = (posW > 0 ? 1 : -1) * fr * Math.abs(posW) * levCap * equity;
        equity -= pay; fundingPaid += pay;
      }
    }
    if (posW !== 0 && liqPrice != null) {
      const hit = cfg.h && cfg.l ? (posW > 0 ? cfg.l[i] <= liqPrice : cfg.h[i] >= liqPrice) : (posW > 0 ? c[i] <= liqPrice : c[i] >= liqPrice);
      if (hit) { equity = 0; liq++; if (openTrade) { trades.push({ ...openTrade, tOut: t[i], pOut: c[i], pnlPct: -100, eqOut: 0, reason: '爆仓' }); openTrade = null; } posW = 0; liqPrice = null; eqs.push(equity); ts.push(t[i]); ws.push(0); continue; }
    }
    if (posW !== 0 && posEntry > 0) {
      equity *= 1 + posW * levCap * (c[i] / posEntry - 1);
      posEntry = c[i];
      const lev = Math.abs(posW) * levCap;
      liqPrice = lev > 1 / MMR ? (posW > 0 ? posEntry * (1 - (1 / lev - MMR)) : posEntry * (1 + (1 / lev - MMR))) : null;
    }
    let w = comboWeight(fundingZ[i], bars1d.c, ad[i]);
    if (longOnly) w = Math.max(0, w);
    if (volTarget > 0 && i > volLB) {
      let s = 0, s2 = 0;
      for (let j = i - volLB + 1; j <= i; j++) { s += rets[j]; s2 += rets[j] ** 2; }
      const mu = s / volLB, sd = Math.sqrt(Math.max(1e-12, s2 / volLB - mu * mu)) * Math.sqrt(24 * 365);
      if (sd > 0) w *= Math.min(vtCap, volTarget / sd);
    }
    if (i + 1 < n && Math.abs(w - posW) > band) {
      const turnover = Math.abs(w - posW) * levCap;
      const cost = turnover * equity * (FEE + SLIP);
      equity -= cost; fees += cost;
      if (openTrade) trades.push({ ...openTrade, tOut: t[i + 1], pOut: o[i + 1], pnlPct: (equity - openTrade.eqIn) / openTrade.eqIn * 100, eqOut: equity, reason: '翻转' });
      openTrade = posW === 0 ? null : { tIn: t[i + 1], side: w > 0 ? '多' : (w < 0 ? '空' : '平'), w, pIn: o[i + 1], eqIn: equity };
      posW = w; posEntry = o[i + 1]; liqPrice = null;
    }
    eqs.push(equity); ts.push(t[i]); ws.push(w);
  }
  if (openTrade && eqs.length) trades.push({ ...openTrade, tOut: ts[ts.length - 1], pOut: c[endI], pnlPct: (equity - openTrade.eqIn) / openTrade.eqIn * 100, eqOut: equity, reason: '末根估值' });
  return { final: eqs[eqs.length - 1], lastW: posW, ws, trades, annRet: annualized(eqs[0], eqs[eqs.length - 1], ts), sharpe: sharpeDaily(eqs, ts), maxDD: maxDD(eqs) * 100, fees, fundingPaid, liq, eqs, ts, nBars: eqs.length };
}

// ===== GOAL8: 双策略组合（vol 倒数滞后融合，GOAL7 实验产品化） =====
// dS/dA = 两策略日权益序列（SRSI 美元口径 / Alpha 倍数口径）；win=融合窗口；init=首日权益基准。
// 纯滞后：i<win 预热期 50/50；此后 wS = va/(vs+va)（过去 win 个日收益 RMS 的倒数比）。
export function combineDaily(dS, dA, win = 30, initS = 1000, initA = 1) {
  const toR = (arr, init) => { const r = []; let prev = init; for (const v of (arr || [])) { const x = Number(v); r.push(Number.isFinite(x) && prev > 0 ? x / prev - 1 : 0); prev = x > 0 ? x : prev; } return r; };
  const rs = toR(dS, initS), ra = toR(dA, initA);
  const n = Math.min(rs.length, ra.length);
  if (n < 2) return { ws: [], daily: [], sharpe: 0, ddPct: 0, annPct: 0, wAvg: 0 };
  const out = [], ws = [];
  for (let i = 0; i < n; i++) {
    if (i < win || win <= 0) { ws.push(0.5); out.push(0.5 * rs[i] + 0.5 * ra[i]); continue; }
    let vs = 0, va = 0;
    for (let j = i - win; j < i; j++) { vs += rs[j] ** 2; va += ra[j] ** 2; }
    vs = Math.sqrt(vs / win) || 1e-9; va = Math.sqrt(va / win) || 1e-9;
    const w = Math.min(1, Math.max(0, va / (vs + va)));
    ws.push(w); out.push(w * rs[i] + (1 - w) * ra[i]);
  }
  const mu = out.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(out.reduce((s, x) => s + (x - mu) ** 2, 0) / (n - 1)) || 1e-12;
  let e = 1, peak = 1, dd = 0;
  for (const x of out) { e *= 1 + x; peak = Math.max(peak, e); dd = Math.max(dd, 1 - e / peak); }
  return { ws, daily: out, sharpe: mu / sd * Math.sqrt(365), ddPct: dd * 100, annPct: (Math.pow(e, 365 / n) - 1) * 100, wAvg: ws.reduce((s, x) => s + x, 0) / n };
}
