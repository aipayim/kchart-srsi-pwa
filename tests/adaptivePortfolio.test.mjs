/**
 * 自适应组合（批次 1：引擎 + 纸面记录）单元测试 (Node 原生, 无框架)
 *
 * 测试:
 *   src/engine/adaptivePortfolioMath.js —— realizedVolSeries / rollingPercentileSeries /
 *     volQuantile（无前视） / adaptiveAlphaWeight / adaptiveWeights / carryTargetQty /
 *     carryNeedsRebalance / fundingPay / carryEquityAt
 *   src/pwa/carryLeg.js                 —— 开仓/再平衡/资金费/权益（真实 PaperEngine）
 *   src/pwa/adaptivePortfolio.js        —— 组合状态机：开关/预热/权重/事件/持久化/reset
 */

import { strictEqual, deepStrictEqual } from 'assert';
import {
  realizedVolSeries, rollingPercentileSeries, volQuantile, adaptiveAlphaWeight, adaptiveWeights,
  carryTargetQty, carryNeedsRebalance, fundingPay, carryEquityAt, clamp,
} from '../src/engine/adaptivePortfolioMath.js';
import { createCarryLeg, CARRY_SRC, CARRY_SPOT_SIG, CARRY_PERP_SIG, posPnl } from '../src/pwa/carryLeg.js';
import { createAdaptivePortfolio, volBucket } from '../src/pwa/adaptivePortfolio.js';
import { PaperEngine } from '../src/exchange/PaperEngine.js';

if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;   // 模拟浏览器（引擎内部引用 window.getMarkPrice 等，Node 下回退 S.prices）

let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; } else { failed++; console.log('FAIL:', name); } }
function near(a, b, eps = 1e-9) { return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= eps; }

const HOUR = 3600e3, DAY = 86400e3;

// ---------- 合成数据工具 ----------
function mulberry32(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function synthCloses(n, { drift = 0, vol = 0.01, seed = 1, start = 100 } = {}) {
  const rnd = mulberry32(seed); const c = new Float64Array(n); let p = start;
  for (let i = 0; i < n; i++) { p *= Math.exp(drift + (rnd() - 0.5) * vol); c[i] = p; }
  return c;
}
function makeState(bal = 1000) {
  return { prices: {}, subs: [{ id: 1, bal, st: 'idle', pnl: 0, ex: 'Binance', tr: 0, w: 0, type: 'perp', coins: {}, sim: true, adaptive: true }], pos: [], closed: [], realized: 0, ai: { atrSuper: {} }, fusion: { fr: {} } };
}

// ============================================================
// 1. 纯函数
// ============================================================
{
  // realizedVolSeries：常数价 → 0；预热 NaN；长度对齐
  const flat = new Float64Array(100).fill(50);
  const rv = realizedVolSeries(flat, 20);
  ok('realizedVol: 常数价 → 0', near(rv[99], 0, 1e-12));
  ok('realizedVol: 预热期 NaN', Number.isNaN(rv[10]));
  ok('realizedVol: 长度对齐', rv.length === 100);
  const c = synthCloses(500, { vol: 0.02, seed: 7 });
  const rv2 = realizedVolSeries(c, 100);
  ok('realizedVol: 正波动 > 0', rv2[499] > 0);
  ok('realizedVol: 年化因子影响', realizedVolSeries(c, 100, 8760)[499] > realizedVolSeries(c, 100, 8760 / 2)[499]);
}
{
  // rollingPercentileSeries：常数 → 0.5；NaN 跳过；预热 NaN
  const constArr = new Float64Array(50).fill(1.5);
  const q = rollingPercentileSeries(constArr, 10);
  ok('percentile: 常数 → 0.5', near(q[49], 0.5, 1e-12));
  ok('percentile: 预热 NaN', Number.isNaN(q[5]));
  const arr = new Float64Array(200); for (let i = 0; i < 200; i++) arr[i] = 0.1 + i * 0.01;
  const q2 = rollingPercentileSeries(arr, 20);
  ok('percentile: 单调递增序列 → 高位', q2[199] > 0.6);
  const withNaN = new Float64Array(50).fill(NaN); for (let i = 20; i < 50; i++) withNaN[i] = 1;
  const q3 = rollingPercentileSeries(withNaN, 10);
  ok('percentile: NaN 输入被跳过（仍能算）', Number.isFinite(q3[49]));
}
{
  // volQuantile：数据不足 → NaN；无前视（改 in-flight 不影响 shift=1）；值域
  ok('volQuantile: 数据不足 → NaN', Number.isNaN(volQuantile(synthCloses(100), {})));
  const n = 9000;
  const c = synthCloses(n, { vol: 0.015, seed: 3 });
  const v1 = volQuantile(c, { shift: 1 });
  const c2 = Float64Array.from(c); c2[n - 1] = c[n - 1] * 10;   // 只改 in-flight 最后一根
  const v2 = volQuantile(c2, { shift: 1 });
  ok('volQuantile: shift=1 无前视（改最后一根不影响）', v1 === v2);
  ok('volQuantile: 值域 [0,1]', v1 >= 0 && v1 <= 1);
  const v0 = volQuantile(c, { shift: 0 });
  const v0b = volQuantile(c2, { shift: 0 });
  ok('volQuantile: shift=0 会被最后一根影响（证明 shift 有效）', v0 !== v0b);
}
{
  // adaptiveAlphaWeight：边界/NaN/单调
  ok('alphaWeight: volQ=0 → cap 1.2 → 0.6', near(adaptiveAlphaWeight(0, { w0: 0.5 }), 0.6, 1e-12));
  ok('alphaWeight: volQ=1 → floor 0.3 → 0.15', near(adaptiveAlphaWeight(1, { w0: 0.5 }), 0.15, 1e-12));
  ok('alphaWeight: NaN（预热）→ w0', near(adaptiveAlphaWeight(NaN, { w0: 0.5 }), 0.5, 1e-12));
  ok('alphaWeight: 钳制 ≤1', adaptiveAlphaWeight(0, { w0: 5 }) <= 1);
  ok('alphaWeight: 单调不增', adaptiveAlphaWeight(0.1) >= adaptiveAlphaWeight(0.5) && adaptiveAlphaWeight(0.5) >= adaptiveAlphaWeight(0.9));
  const w = adaptiveWeights(0.5, { w0: 0.5 });
  ok('adaptiveWeights: wC = 1 − wA', near(w.wA + w.wC, 1, 1e-12));
  ok('adaptiveWeights: g 在 [floor,cap]', w.g >= 0.3 && w.g <= 1.2);
}
{
  // carryTargetQty
  const t = carryTargetQty(1000, 3, 100, 100);
  ok('carryTarget: f=0.75', near(t.f, 0.75, 1e-12));
  ok('carryTarget: notional=750', near(t.notional, 750, 1e-9));
  ok('carryTarget: margin=250', near(t.margin, 250, 1e-9));
  ok('carryTarget: spotQty=7.5', near(t.spotQty, 7.5, 1e-9));
  ok('carryTarget: perpQty=−7.5（空）', near(t.perpQty, -7.5, 1e-9));
  const t2 = carryTargetQty(1000, 3, 100, 100, { frac: 0.5 });
  ok('carryTarget: frac 覆盖', near(t2.notional, 500, 1e-9));
  const t3 = carryTargetQty(1000, 3, 100, 100, { frac: 5 });
  ok('carryTarget: frac 钳制到 fmax', near(t3.notional, 750, 1e-9));
  ok('carryTarget: 负权益 → 0', near(carryTargetQty(-5, 3, 100, 100).notional, 0, 1e-12));
}
{
  // carryNeedsRebalance
  const px = 100;
  const tgt = carryTargetQty(1000, 3, px, px);   // notional 750
  ok('rebalance: 目标仓在带内 → false', carryNeedsRebalance({ spotQty: 7.5, perpQty: -7.5, spotPx: px, perpPx: px }, tgt, 1000, 0.10) === false);
  ok('rebalance: 现货偏离 20% → true', carryNeedsRebalance({ spotQty: 6.0, perpQty: -7.5, spotPx: px, perpPx: px }, tgt, 1000, 0.10) === true);
  ok('rebalance: 空头目标 + 当前有仓 → true', carryNeedsRebalance({ spotQty: 7.5, perpQty: -7.5, spotPx: px, perpPx: px }, { notional: 0 }, 1000, 0.10) === true);
  ok('rebalance: 目标空 + 无仓 → false', carryNeedsRebalance({ spotQty: 0, perpQty: 0, spotPx: px, perpPx: px }, { notional: 0 }, 1000, 0.10) === false);
  ok('rebalance: equity≤0 → false', carryNeedsRebalance({ spotQty: 7.5, perpQty: -7.5, spotPx: px, perpPx: px }, tgt, 0, 0.10) === false);
  ok('rebalance: band 可传对象', carryNeedsRebalance({ spotQty: 7.5, perpQty: -7.5, spotPx: px, perpPx: px }, tgt, 1000, { band: 0.5 }) === false);
}
{
  // fundingPay：空头 rate>0 收；多头 rate>0 付；NaN → 0
  ok('funding: 空头 rate>0 → 收(+750×0.0001)', near(fundingPay(-7.5, 100, 0.0001), 0.075, 1e-12));
  ok('funding: 空头 rate<0 → 付', fundingPay(-7.5, 100, -0.0001) < 0);
  ok('funding: 多头 rate>0 → 付', fundingPay(7.5, 100, 0.0001) < 0);
  ok('funding: NaN → 0', fundingPay(NaN, 100, 0.0001) === 0);
  ok('funding: rate NaN → 0', fundingPay(-7.5, 100, NaN) === 0);
}
{
  ok('carryEquityAt: 合计（研究口径 cash=750）', near(carryEquityAt(750, 250, 7.5, -7.5, 100, 100), 1000, 1e-9));
  ok('clamp', clamp(5, 0, 1) === 1 && clamp(-5, 0, 1) === 0 && clamp(NaN, 0, 1) === 0);
  ok('volBucket: 分桶', volBucket(0.1) === 'low' && volBucket(0.5) === 'mid' && volBucket(0.9) === 'high' && volBucket(NaN) === 'na');
}

// ============================================================
// 2. carryLeg（真实 PaperEngine）
// ============================================================
{
  const S = makeState(1000);
  S.prices.BTCUSDT = { last: 100 };
  const engine = new PaperEngine({ stateRef: () => S, onLog: () => {}, getSlip: () => 0 });
  const sub = S.subs[0];
  const leg = createCarryLeg({ engine, symbol: 'BTCUSDT', sub, lev: 3, band: 0.10, feeReserve: 0.004 });
  ok('carryLeg: 初始无仓', leg.summary(100).inPosition === false);

  const res = await leg.sync({ px: 100, equity: 1000, now: 1 });
  ok('carryLeg: sync → rebalance', res.action === 'rebalance');
  const pos = leg.positions();
  ok('carryLeg: 现货多头已开', !!pos.spot && pos.spot.side === 'long' && pos.spot.sig === CARRY_SPOT_SIG && pos.spot.src === CARRY_SRC);
  ok('carryLeg: 永续空头已开', !!pos.perp && pos.perp.side === 'short' && pos.perp.sig === CARRY_PERP_SIG);
  ok('carryLeg: 现货数量 ≈ 0.75×0.996×1000/100', near(pos.spot.qty, 7.47, 0.05));
  ok('carryLeg: 永续数量 ≈ 7.47', near(pos.perp.qty, 7.47, 0.05));
  ok('carryLeg: 永续保证金 ≈ 249', near(pos.perp.amt, 249, 2));
  ok('carryLeg: 腿权益 ≈ 1000（扣手续费）', leg.legEquity(100) > 995 && leg.legEquity(100) <= 1000);

  // 带内不再平衡
  const res2 = await leg.sync({ px: 100, equity: 1000, now: 2 });
  ok('carryLeg: 带内 → 不再平衡', res2.action === 'none');
  ok('carryLeg: rebalCount 仍 1', leg.state.rebalCount === 1);

  // 价格大幅上涨 → delta 中性下权益基本不变（现货赚、永续亏）
  const eqUp = leg.legEquity(110);
  ok('carryLeg: 价格上涨 delta 中性（权益近似不变）', Math.abs(eqUp - 1000) < 5);

  // 资金费：空头 rate>0 收
  const before = sub.bal;
  const pay = leg.accrueFunding({ rate: 0.0001, px: 100, now: 3 });
  ok('carryLeg: 资金费 > 0（空头收取）', pay > 0);
  ok('carryLeg: 资金费计入余额', near(sub.bal - before, pay, 1e-9));
  ok('carryLeg: fundingCum 累计', near(leg.state.fundingCum, pay, 1e-9));

  // 强平检查（无强平）
  ok('carryLeg: 强平检查返回数组', Array.isArray(leg.checkLiquidation()));

  // 平仓
  await leg.closeAll('[test]');
  ok('carryLeg: 全平后无仓', leg.summary(100).inPosition === false);

  // posPnl 符号
  ok('posPnl: 多头上涨为正', posPnl({ side: 'long', entry: 100, qty: 2 }, 110) > 0);
  ok('posPnl: 空头上涨为负', posPnl({ side: 'short', entry: 100, qty: 2 }, 110) < 0);
}

// ============================================================
// 3. adaptivePortfolio（注入假 fetcher，零网络）
// ============================================================
function makeFetchers({ n = 9000, px = 100, vol = 0.015, seed = 5, fundRate = 0 } = {}) {
  const c = synthCloses(n, { vol, seed });
  const t = new Float64Array(n); for (let i = 0; i < n; i++) t[i] = Date.UTC(2024, 0, 1) + i * HOUR;
  const dn = 800; const dc = synthCloses(dn, { vol: 0.03, seed: seed + 1 });
  const dt = new Float64Array(dn); for (let i = 0; i < dn; i++) dt[i] = Date.UTC(2023, 0, 1) + i * DAY;
  return {
    klinesRange: async (sym, tf) => tf === '1h'
      ? { opens: c, highs: c, lows: c, closes: c, vols: c.map(() => 1), times: t }
      : { opens: dc, highs: dc, lows: dc, closes: dc, vols: dc.map(() => 1), times: dt },
    fundingRate: async () => [],
    premiumIndex: async () => ({ markPrice: px, indexPrice: px, lastFundingRate: fundRate, nextFundingTime: 0 }),
  };
}

// 3a. 默认 disabled → tick no-op
{
  const S = makeState(1000);
  const ap = createAdaptivePortfolio({ state: S, symbols: ['BTCUSDT'], w0: 0.5, capital: 1000, cfg: { persist: false, priceSource: () => ({ BTCUSDT: { last: 100 } }), fetchers: makeFetchers() } });
  ok('AP: 默认 disabled', ap.isEnabled() === false);
  const r = await ap.tick(Date.UTC(2026, 0, 1, 5));
  ok('AP: disabled → tick 返回 null', r === null);
  ok('AP: disabled → 无持仓', S.pos.length === 0);
}

// 3b. enable + tick → 权重计算 + 两腿开仓
{
  const S = makeState(1000);
  const ap = createAdaptivePortfolio({ state: S, symbols: ['BTCUSDT', 'ETHUSDT'], w0: 0.5, capital: 1000, cfg: { persist: false, priceSource: () => ({ BTCUSDT: { last: 100 }, ETHUSDT: { last: 200 } }), fetchers: makeFetchers() } });
  ap.enable();
  ok('AP: enable 后 enabled', ap.isEnabled() === true);
  await ap.tick(Date.UTC(2026, 0, 1, 5, 0, 0));
  await ap.tick(Date.UTC(2026, 0, 1, 5, 0, 1));   // 每 tick 只刷新一个币 → 第二次刷新 ETH
  const st = ap.getState();
  ok('AP: 预热结束（两币均有足够 K 线）', st.warming === false);
  ok('AP: BTC 已预热', st.perSymbol.BTCUSDT.warming === false);
  ok('AP: ETH 已预热', st.perSymbol.ETHUSDT.warming === false);
  const b = st.perSymbol.BTCUSDT;
  ok('AP: volQ 已算', Number.isFinite(b.volQ) && b.volQ >= 0 && b.volQ <= 1);
  ok('AP: wA + wC = 1', near(b.wA + b.wC, 1, 1e-6));
  ok('AP: carry 腿已开仓', b.carry && b.carry.inPosition === true);
  ok('AP: 现货多头存在', S.pos.some((p) => p.sig === CARRY_SPOT_SIG));
  ok('AP: 永续空头存在', S.pos.some((p) => p.sig === CARRY_PERP_SIG));
  ok('AP: 每币都有 carry', st.perSymbol.ETHUSDT.carry.inPosition === true);
  ok('AP: 组合权益接近 1000（扣手续费）', st.equity > 990 && st.equity <= 1000.5);
  ok('AP: 事件含 enable', ap.getEvents().some((e) => e.type === 'enable'));
  ok('AP: 事件含 carry_rebalance', ap.getEvents().some((e) => e.type === 'carry_rebalance'));
  ok('AP: 事件含 volQ_cross', ap.getEvents().some((e) => e.type === 'volQ_cross'));

  // 第二次 tick：带内 → 不再平衡
  const rb1 = S.pos.filter((p) => p.src === CARRY_SRC).length;
  await ap.tick(Date.UTC(2026, 0, 1, 5, 0, 2));
  const rb2 = S.pos.filter((p) => p.src === CARRY_SRC).length;
  ok('AP: 再次 tick 不重复开仓', rb1 === rb2);

  // disable → tick no-op
  ap.disable();
  ok('AP: disable 后 enabled=false', ap.isEnabled() === false);
  const posBefore = S.pos.length;
  await ap.tick(Date.UTC(2026, 0, 1, 5, 0, 3));
  ok('AP: disable 后 tick no-op', S.pos.length === posBefore);

  // reset
  ap.reset();
  ok('AP: reset 清空持仓', S.pos.length === 0);
  ok('AP: reset 恢复本金', near(S.subs[0].bal, 1000, 1e-9));
  ok('AP: reset 清空事件', ap.getEvents().length === 0);
}

// 3c. 预热降级：K 线不足 → wA=w0（g=1）
{
  const S = makeState(1000);
  const ap = createAdaptivePortfolio({ state: S, symbols: ['BTCUSDT'], w0: 0.5, capital: 1000, cfg: { persist: false, priceSource: () => ({ BTCUSDT: { last: 100 } }), fetchers: makeFetchers({ n: 500 }) } });
  ap.enable();
  await ap.tick(Date.UTC(2026, 0, 1, 5));
  const b = ap.getState().perSymbol.BTCUSDT;
  ok('AP: 预热 warming=true', b.warming === true);
  ok('AP: 预热 wA=w0', near(b.wA, 0.5, 1e-9));
  ok('AP: 预热 volQ=null', b.volQ === null);
  ok('AP: 预热仍可开 carry（权益可得）', b.carry && b.carry.inPosition === true);
}

// 3d. 无行情 → 不开仓、不报错
{
  const S = makeState(1000);
  const ap = createAdaptivePortfolio({ state: S, symbols: ['BTCUSDT'], w0: 0.5, capital: 1000, cfg: { persist: false, priceSource: () => ({}), fetchers: { ...makeFetchers(), premiumIndex: async () => null } } });
  ap.enable();
  await ap.tick(Date.UTC(2026, 0, 1, 5));
  ok('AP: 无行情 → 无持仓', S.pos.length === 0);
  ok('AP: 无行情 → 不抛异常', true);
}

// 3e. 持久化（mock localStorage）：enabled + 权重 跨实例恢复
{
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    key: (i) => [...store.keys()][i] || null,
    get length() { return store.size; },
  };
  const S1 = makeState(1000);
  const ap1 = createAdaptivePortfolio({ state: S1, symbols: ['BTCUSDT'], w0: 0.5, capital: 1000, cfg: { priceSource: () => ({ BTCUSDT: { last: 100 } }), fetchers: makeFetchers() } });
  ap1.enable();
  await ap1.tick(Date.UTC(2026, 0, 1, 5));
  const w1 = ap1.getState().perSymbol.BTCUSDT.wA;
  ok('AP: 持久化已写入 localStorage', !!store.get('pwa_adaptive_portfolio'));
  const raw = JSON.parse(store.get('pwa_adaptive_portfolio'));
  ok('AP: 快照含 enabled', raw.enabled === true);
  ok('AP: 快照含引擎持仓', Array.isArray(raw.engine.pos) && raw.engine.pos.length > 0);

  // 新实例（同 localStorage）→ 恢复 enabled + 权重 + 持仓
  const S2 = makeState(1000);
  const ap2 = createAdaptivePortfolio({ state: S2, symbols: ['BTCUSDT'], w0: 0.5, capital: 1000, cfg: { priceSource: () => ({ BTCUSDT: { last: 100 } }), fetchers: makeFetchers() } });
  ok('AP: 恢复 enabled', ap2.isEnabled() === true);
  ok('AP: 恢复权重 wA', near(ap2.getState().perSymbol.BTCUSDT.wA, w1, 1e-9));
  ok('AP: 恢复引擎持仓', S2.pos.length === raw.engine.pos.length);

  // 清理 mock
  delete globalThis.localStorage;
}

// 3g. 隔离引擎强平检查必须用隔离价格（不受全局 window.getMarkPrice 污染——主系统会提供该全局）
{
  const S = makeState(1000);
  const savedGMP = globalThis.getMarkPrice;
  globalThis.getMarkPrice = () => 0.1;   // 污染：返回极低价 → 若隔离检查用它，会误强平现货多单
  const ap = createAdaptivePortfolio({ state: S, symbols: ['BTCUSDT'], w0: 0.5, capital: 1000, cfg: { persist: false, priceSource: () => ({ BTCUSDT: { last: 100 } }), fetchers: makeFetchers({ px: 100 }) } });
  ap.enable();
  await ap.tick(Date.UTC(2026, 0, 1, 5));
  ok('AP: 全局错误 markPrice 不导致误强平（现货仍在）', S.pos.some((p) => p.sig === CARRY_SPOT_SIG));
  ok('AP: 全局错误 markPrice 不导致误强平（永续仍在）', S.pos.some((p) => p.sig === CARRY_PERP_SIG));
  ok('AP: liqCount 为 0', (ap.getState().perSymbol.BTCUSDT.carry.liqCount || 0) === 0);
  if (savedGMP === undefined) { try { delete globalThis.getMarkPrice; } catch (e) {} } else globalThis.getMarkPrice = savedGMP;
}

// 3h. setSymbols：运行时改交易对（重建 perSymbol / 平仓 / 幂等 / 事件）
{
  const S = makeState(1000);
  const ap = createAdaptivePortfolio({ state: S, symbols: ['BTCUSDT', 'ETHUSDT'], w0: 0.5, capital: 1000, cfg: { persist: false, priceSource: () => ({ BTCUSDT: { last: 100 }, ETHUSDT: { last: 200 }, SOLUSDT: { last: 50 } }), fetchers: makeFetchers() } });
  ap.enable();
  await ap.tick(Date.UTC(2026, 0, 1, 5));
  ok('setSymbols: 初始列表', ap.getSymbols().join(',') === 'BTCUSDT,ETHUSDT');
  ok('setSymbols: 初始有仓', S.pos.length > 0);
  const changed = ap.setSymbols(['BTCUSDT', 'SOLUSDT']);
  ok('setSymbols: 返回 true', changed === true);
  ok('setSymbols: getSymbols 更新', ap.getSymbols().join(',') === 'BTCUSDT,SOLUSDT');
  ok('setSymbols: 平掉旧仓', S.pos.length === 0);
  const st = ap.getState().perSymbol;
  ok('setSymbols: perSymbol 重建（SOL 在 / ETH 无）', st.SOLUSDT != null && st.ETHUSDT == null);
  ok('setSymbols: 幂等（同列表 → false）', ap.setSymbols(['BTCUSDT', 'SOLUSDT']) === false);
  ok('setSymbols: 空列表 → false', ap.setSymbols([]) === false);
  ok('setSymbols: 小写/去重归一化', ap.setSymbols(['btcusdt', 'BTCUSDT', 'ethusdt']) === true && ap.getSymbols().join(',') === 'BTCUSDT,ETHUSDT');
  ok('setSymbols: 事件记录', ap.getEvents().some((e) => e.type === 'symbols_change'));
}

// 3f. install 挂到 window（模拟）
{
  const g = globalThis;
  const saved = g.__adaptivePortfolio;
  delete g.__adaptivePortfolio;
  const ap = createAdaptivePortfolio({ state: makeState(1000), symbols: ['BTCUSDT'], capital: 1000, cfg: { persist: false, priceSource: () => ({ BTCUSDT: { last: 100 } }), fetchers: makeFetchers() } });
  g.__adaptivePortfolio = ap;
  ok('AP: 可挂载 window.__adaptivePortfolio', typeof g.__adaptivePortfolio.tick === 'function');
  if (saved === undefined) delete g.__adaptivePortfolio; else g.__adaptivePortfolio = saved;
}

console.log(`\n=== adaptivePortfolio: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
