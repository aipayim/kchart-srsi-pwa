// carry 腿 —— 现货多 + 永续空（delta 中性资金费收割）
// 研究口径（scripts/carry-harvest/carry.mjs 的 runCarry，已独立验证）：
//   现货多名义 = 永续空名义 = f·腿权益（f = lev/(lev+1)，lev=3 → 0.75）
//   永续保证金 = 名义/lev；名义相对权益偏离 > band(10%) 再平衡
//   资金费：空头在 rate>0 时收取（每 8h 结算一次）
// 实现要点：本模块只做「腿」——下单/平仓走注入的 PaperEngine（单池子账户），
//   现货多头用 lev=1（等价现货）、永续空头用 lev=3；持仓以 src='carry' + sig 区分。
// 默认纯纸面；真实资金仍由上层硬锁。

import { carryTargetQty, carryNeedsRebalance, fundingPay } from '../engine/adaptivePortfolioMath.js';

export const CARRY_SRC = 'carry';
export const CARRY_SPOT_SIG = 'carrySpot';
export const CARRY_PERP_SIG = 'carryPerp';

/** 持仓浮盈（USD，qty 恒为正，side 区分方向）。 */
export function posPnl(pos, px) {
  if (!pos || !Number.isFinite(px)) return 0;
  return (px - pos.entry) * pos.qty * (pos.side === 'long' ? 1 : -1);
}

/**
 * @param {object} o
 * @param {object} o.engine PaperEngine（或同接口：S / placeOrder / exitPosition / checkLiquidations）
 * @param {string} o.symbol 交易对
 * @param {object} o.sub 子账户（单池；usdt 余额）
 * @param {number} [o.lev=3]
 * @param {number} [o.band=0.10]
 * @param {number} [o.feeReserve=0.004] 下单前预留的手续费+滑点比例（防余额不足拒单）
 * @param {number} [o.frac=null] 覆盖 f（默认 lev/(lev+1)）
 * @param {function} [o.log]
 */
export function createCarryLeg({ engine, symbol, sub, lev = 3, band = 0.10, feeReserve = 0.004, frac = null, log = () => {} } = {}) {
  const state = {
    symbol, lev, band, frac,
    fundingCum: 0, rebalCount: 0, liqCount: 0, rejectCount: 0,
    lastRebalT: 0, lastFundingT: 0, lastReason: '',
  };

  function positions() {
    const S = engine.S;
    const ps = (S.pos || []).filter((p) => p.sym === symbol && p.src === CARRY_SRC);
    return {
      spot: ps.find((p) => p.sig === CARRY_SPOT_SIG) || null,
      perp: ps.find((p) => p.sig === CARRY_PERP_SIG) || null,
    };
  }
  function qty() {
    const { spot, perp } = positions();
    return {
      spotQty: spot ? spot.qty : 0,
      perpQty: perp ? perp.qty * (perp.side === 'short' ? -1 : 1) : 0,   // 有符号：空头为负
    };
  }
  /** 腿权益：现金 + 现货市值 + 永续保证金 + 永续浮盈。 */
  function legEquity(px) {
    const { spot, perp } = positions();
    const cash = sub ? (sub.bal || 0) : 0;
    const spotVal = spot ? spot.qty * px : 0;
    const perpPart = perp ? (perp.amt || 0) + posPnl(perp, px) : 0;
    return cash + spotVal + perpPart;
  }
  async function closeAll(reason) {
    const { spot, perp } = positions();
    if (spot) { try { engine.exitPosition(spot, { reason }); } catch (e) { log('close_spot_err', e); } }
    if (perp) { try { engine.exitPosition(perp, { reason }); } catch (e) { log('close_perp_err', e); } }
  }

  async function openTarget(target, px) {
    const acct = sub;
    if (!acct) return { ok: false, reason: 'no_sub' };
    let ok = true;
    // 现货多头（lev=1）：名义 = notional
    if (target.notional > 0) {
      const o = await engine.placeOrder({ symbol, side: 'long', amt: target.notional, lev: 1, marginMode: 'usdt', sub: acct, ai: false, sig: CARRY_SPOT_SIG, src: CARRY_SRC });
      if (o && o.status === 'rejected') { ok = false; state.rejectCount++; log('spot_rejected', o.rejectReason); }
    }
    // 永续空头（lev）：保证金 = notional/lev
    if (target.margin > 0) {
      const o = await engine.placeOrder({ symbol, side: 'short', amt: target.margin, lev, marginMode: 'usdt', sub: acct, ai: false, sig: CARRY_PERP_SIG, src: CARRY_SRC });
      if (o && o.status === 'rejected') { ok = false; state.rejectCount++; log('perp_rejected', o.rejectReason); }
    }
    return { ok, px };
  }

  /**
   * 对齐 carry 腿到目标（按 band 决定是否再平衡）。
   * @returns {Promise<{action:'none'|'rebalance'|'error', reason:string, target:object, equity:number}>}
   */
  async function sync({ px, equity, now = Date.now() } = {}) {
    if (!(px > 0)) return { action: 'none', reason: 'no_price', target: null, equity: 0 };
    const eq = Number.isFinite(equity) && equity > 0 ? equity : legEquity(px);
    const sizingEq = Math.max(0, eq * (1 - feeReserve));
    const target = carryTargetQty(sizingEq, lev, px, px, { frac });
    const { spotQty, perpQty } = qty();
    const need = carryNeedsRebalance({ spotQty, perpQty, spotPx: px, perpPx: px }, target, eq, band);
    if (!need) return { action: 'none', reason: 'in_band', target, equity: eq };
    try {
      await closeAll('[carry]再平衡');
      const r = await openTarget(target, px);
      state.rebalCount++; state.lastRebalT = now;
      state.lastReason = r.ok ? 'rebalance' : 'rebalance_partial';
      return { action: 'rebalance', reason: r.ok ? 'band' : 'partial', target, equity: eq, ok: r.ok };
    } catch (e) {
      state.lastReason = 'error';
      log('rebalance_err', e);
      return { action: 'error', reason: e && e.message, target, equity: eq };
    }
  }

  /** 资金费结算（每 8h 边界由上层调用一次）：空头 rate>0 收。 */
  function accrueFunding({ rate, px, now = Date.now() } = {}) {
    const { perp } = positions();
    if (!perp || !(px > 0) || !Number.isFinite(rate)) return 0;
    const signedPerp = perp.qty * (perp.side === 'short' ? -1 : 1);
    const pay = fundingPay(signedPerp, px, rate);
    if (sub) sub.bal = (sub.bal || 0) + pay;
    state.fundingCum += pay; state.lastFundingT = now;
    return pay;
  }

  /** 强平检查（委托引擎，返回本腿被强平的持仓）。 */
  function checkLiquidation() {
    if (!engine.checkLiquidations) return [];
    let hits = [];
    try { hits = engine.checkLiquidations() || []; } catch (e) { log('liq_err', e); return []; }
    const mine = hits.filter((h) => h && h.pos && h.pos.src === CARRY_SRC);
    if (mine.length) state.liqCount += mine.length;
    return mine;
  }

  function summary(px) {
    const { spot, perp } = positions();
    const signedPerp = perp ? perp.qty * (perp.side === 'short' ? -1 : 1) : 0;
    return {
      symbol,
      inPosition: !!(spot || perp),
      spotQty: spot ? spot.qty : 0,
      perpQty: signedPerp,
      margin: perp ? (perp.amt || 0) : 0,
      notional: spot ? spot.qty * px : 0,
      pnl: posPnl(perp, px),
      equity: legEquity(px),
      fundingCum: state.fundingCum,
      rebalCount: state.rebalCount,
      liqCount: state.liqCount,
      rejectCount: state.rejectCount,
      lastReason: state.lastReason,
    };
  }

  return { state, positions, qty, legEquity, sync, accrueFunding, checkLiquidation, closeAll, summary };
}
