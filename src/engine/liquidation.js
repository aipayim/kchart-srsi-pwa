/**
 * 强平计算 — 与交易所维持保证金梯度表对齐（纸面/真实共用）
 *
 * Binance USDT-M 维持保证金率（MMR）示例（BTCUSDT）：
 *   Tier 1: 0 – 50,000 USD    MMR=0.40%
 *   Tier 2: 50,000 – 60,000    MMR=0.50%
 *   Tier 3: 60,000 – 80,000    MMR=1.00%
 *   ...
 * OKX USDT-SWAP 维持保证金率（BTC-USDT-SWAP）：
 *   Tier 1: 0 – 100,000 USD    MMR=0.50%
 *   Tier 2: 100,000 – 200,000  MMR=1.00%
 *   ...
 *
 * 注：真实梯级表会随交易所规则变化，此处提供合理默认值。
 * 真实接入时，适配器应通过 REST API 拉取最新梯级覆盖此表。
 */

// 按交易所 + 币种维护梯度（默认 Binance BTC 级）
const DEFAULT_TIERS = {
  Binance: {
    BTCUSDT: [{ from: 0, to: 50000, mmr: 0.004 }, { from: 50000, to: 60000, mmr: 0.005 }, { from: 60000, to: 80000, mmr: 0.010 }, { from: 80000, to: 100000, mmr: 0.015 }, { from: 100000, to: Infinity, mmr: 0.025 }],
    // 默认为 BTC 梯度，其他币种可按此比例缩放
    default: [{ from: 0, to: 50000, mmr: 0.004 }, { from: 50000, to: 60000, mmr: 0.005 }, { from: 60000, to: 80000, mmr: 0.010 }, { from: 80000, to: 100000, mmr: 0.015 }, { from: 100000, to: Infinity, mmr: 0.025 }]
  },
  OKX: {
    BTCUSDT: [{ from: 0, to: 100000, mmr: 0.005 }, { from: 100000, to: 200000, mmr: 0.010 }, { from: 200000, to: 500000, mmr: 0.015 }, { from: 500000, to: Infinity, mmr: 0.025 }],
    default: [{ from: 0, to: 100000, mmr: 0.005 }, { from: 100000, to: 200000, mmr: 0.010 }, { from: 200000, to: 500000, mmr: 0.015 }, { from: 500000, to: Infinity, mmr: 0.025 }]
  }
};

// 有效梯级表 = 默认 + setTiers 注入(真实接入时由适配器 REST 拉取覆盖, 这里提供注入点)
let TIERS = DEFAULT_TIERS;

/**
 * 注入/覆盖交易所维持保证金梯度表。
 * 传入结构 { Binance: { SYM: [...tiers] }, OKX: {...} }，逐交易所逐币覆盖，未指定的保留默认。
 * 真实接入时由适配器通过 REST API 拉取最新梯级调用此函数。
 */
export function setTiers(overrides) {
  if (!overrides || typeof overrides !== 'object') return;
  Object.keys(overrides).forEach((ex) => {
    const next = TIERS[ex] ? { ...TIERS[ex] } : {};
    Object.keys(overrides[ex] || {}).forEach((sym) => {
      if (Array.isArray(overrides[ex][sym])) next[sym] = overrides[ex][sym];
    });
    TIERS = { ...TIERS, [ex]: next };
  });
}

/** 恢复默认梯级表 */
export function resetTiers() { TIERS = DEFAULT_TIERS; }

/** 读取当前有效梯级表（调试/测试用） */
export function getTiers() { return TIERS; }

/** 获取某交易所某币种在给定名义价值下的维持保证金率 */
export function getMMR(exchange, symbol, notional) {
  const tiers = (TIERS[exchange] || TIERS.Binance)[symbol] || (TIERS[exchange] || TIERS.Binance).default;
  for (const tier of tiers) {
    if (notional >= tier.from && notional < tier.to) return tier.mmr;
  }
  return 0.025; // 最高档保底
}

/**
 * 计算强平价格（单向持仓，逐仓模式）
 *
 * 近似公式（币安/欧易均适用）：
 *   Long:  liqPrice = entry * (1 - 1/lev + mmr)
 *   Short: liqPrice = entry * (1 + 1/lev - mmr)
 *
 * 其中 mmr = 当前持仓名义价值对应的维持保证金率
 * 更精确的公式需考虑手续费，此处取合理近似（误差 < 1%）
 */
export function liquidationPrice({ exchange = 'Binance', side, entry, lev, notional, mmr, symbol }) {
  if (!mmr) mmr = getMMR(exchange, symbol, notional);
  const imr = 1 / lev;
  if (side === 'long') return entry * (1 - imr + mmr);
  return entry * (1 + imr - mmr);
}

/**
 * 检查持仓是否触发了强平（当前价格 <= long liq 或 >= short liq）
 * @returns {Array<{pos, liqPrice, markPrice }>} 被强平的持仓
 */
export function checkLiquidation(positions, getPrice, getExchange) {
  const liquidated = [];
  positions.forEach((pos) => {
    if (!pos.qty || pos.qty <= 0.00001) return;
    const mark = getPrice(pos.sym);
    if (!mark || !isFinite(mark)) return;
    const ex = getExchange ? getExchange(pos) : 'Binance';
    const notional = pos.entry * pos.qty;
    const mmr = getMMR(ex, pos.sym, notional);
    const liq = liquidationPrice({ exchange: ex, side: pos.side, entry: pos.entry, lev: pos.lev, notional, mmr, symbol: pos.sym });
    if (pos.side === 'long' && mark <= liq) {
      liquidated.push({ pos, liqPrice: liq, markPrice: mark });
    } else if (pos.side === 'short' && mark >= liq) {
      liquidated.push({ pos, liqPrice: liq, markPrice: mark });
    }
  });
  return liquidated;
}