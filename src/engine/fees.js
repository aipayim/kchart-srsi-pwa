/**
 * 手续费模型 — 按交易所真实费率表（纸面/真实共用）
 *
 * 默认值参考 Binance / OKX 合约（USDT-M/SWAP）普通用户费率：
 *  - taker 0.05% / maker 0.02%
 *  - Binance 使用 BNB 抵扣：9 折（taker 0.045% / maker 0.018%）
 *  - OKX 使用 OKB 抵扣：9 折
 *
 * 真实接入时可用 API 拉取实际账户费率（VIP 等级）覆盖此表。
 */

export const EXCHANGE_FEES = {
  Binance: {
    label: '币安',
    taker: 0.0005,
    maker: 0.0002,
    discount: 0.9,          // BNB 抵扣折扣系数（乘以费率）
    hasDiscount: true
  },
  OKX: {
    label: '欧易',
    taker: 0.0005,
    maker: 0.0002,
    discount: 0.9,
    hasDiscount: true
  }
};

/** 获取某交易所单边费率 */
export function getFeeRate(exchange, { isMaker = false, useDiscount = true } = {}) {
  const cfg = EXCHANGE_FEES[exchange] || EXCHANGE_FEES.Binance;
  let rate = isMaker ? cfg.maker : cfg.taker;
  if (useDiscount && cfg.hasDiscount) rate *= cfg.discount;
  return rate;
}

/**
 * 计算单笔手续费
 * @param {string} exchange 'Binance' | 'OKX'
 * @param {number} notional 名义价值（USD）
 * @param {object} opts
 */
export function calcFee(exchange, notional, opts = {}) {
  if (!notional || notional <= 0) return 0;
  return notional * getFeeRate(exchange, opts);
}

/**
 * 开仓名义价值（保证金 * 杠杆）
 */
export function openNotional(margin, lev) {
  return margin * lev;
}

/**
 * 平仓名义价值（数量 * 参考价）
 */
export function closeNotional(qty, price) {
  return qty * price;
}
