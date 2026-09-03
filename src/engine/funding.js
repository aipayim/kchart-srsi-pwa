/**
 * 资金费率结算引擎 — 与真实交易所规则对齐（纸面/真实共用）
 *
 * Binance / OKX 永续合约资金费率每 8 小时结算一次：
 *  - Binance 结算时刻：UTC 00:00 / 08:00 / 16:00
 *  - OKX 结算时刻：UTC 00:00 / 08:00 / 16:00（部分 4h 品种）
 *
 * 支付规则：
 *  - fundingRate > 0：多头支付空头
 *  - fundingRate < 0：空头支付多头
 *  - 支付额 = 持仓名义价值 × fundingRate（± 方向）
 */

export const FUNDING_HOURS = [0, 8, 16];

/** 距下一个结算时刻的毫秒数 */
export function msUntilFunding(now = Date.now()) {
  const d = new Date(now);
  const hour = d.getUTCHours();
  let next = FUNDING_HOURS.find((h) => h > hour);
  if (next === undefined) next = FUNDING_HOURS[0] + 24;
  const target = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), next, 0, 0, 0);
  return target - now;
}

/** 下一次结算时刻（Date） */
export function nextFundingTime(now = Date.now()) {
  return new Date(now + msUntilFunding(now));
}

/** 是否跨过了最近一次结算边界（用于轮询检测） */
export function crossedFundingBoundary(prevCheck, now = Date.now()) {
  return msUntilFunding(now) > msUntilFunding(prevCheck) && msUntilFunding(now) > 7 * 3600 * 1000;
}

/**
 * 计算单个持仓的资金费用（USD，正=收入，负=支出）
 * @param {object} pos {side:'long'|'short', notional, fundingRate}
 */
export function fundingPayment({ side, notional, fundingRate }) {
  if (!notional || !isFinite(fundingRate)) return 0;
  // 多头在正费率时支付 => 支付为负；空头在正费率时收取 => 支付为正
  const sign = side === 'long' ? -1 : 1;
  return notional * fundingRate * sign;
}

/**
 * 结算一批持仓的资金费用
 * @param {object} opts
 * @param {Array}  opts.positions 持仓数组
 * @param {Function} opts.getFundingRate (symbol)=>number
 * @param {Function} opts.getNotional (pos)=>number
 * @param {Function} opts.onSettle (pos, payment, rate)=>void  每笔结算回调（记账/落账）
 * @returns {{settled:number, payments:Array}}
 */
export function settleFundingFor({ positions, getFundingRate, getNotional, onSettle }) {
  const payments = [];
  let settled = 0;
  positions.forEach((pos) => {
    if (!pos.qty || pos.qty <= 0.00001) return;
    const rate = getFundingRate(pos.sym);
    const notional = getNotional(pos);
    const payment = fundingPayment({ side: pos.side, notional, fundingRate: rate });
    if (Math.abs(payment) < 1e-9) return;
    payments.push({ sym: pos.sym, side: pos.side, rate, notional, payment });
    if (onSettle) onSettle(pos, payment, rate);
    settled++;
  });
  return { settled, payments };
}
