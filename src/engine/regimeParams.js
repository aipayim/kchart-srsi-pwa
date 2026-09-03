/**
 * regimeParams.js — 参数自适应引擎(纯函数, 无 DOM, 可单测)
 *
 * 思想: 在线感知市场状态(detectRegimeState 输出的连续量) → 按 5 类 regime 的
 *       离散参数映射线性插值, 得到当前风控/进出场参数的平滑取值。
 *       市场变了, 参数自动跟着变, 不为任何单一市场手工调参。
 *
 * 输入 regimeState (来自 indicators.js detectRegimeState):
 *   { type, direction, strength(0~1), volatility(0~1), atrState, stability, deadZone }
 *
 * 输出参数:
 *   gateKeep      方向门逆势抑制系数(越小越禁逆势)
 *   stopMult      止损距离(×ATR, 1t)
 *   ladderMult    阶梯止盈阈值(×ATR 数组)
 *   exitSpreadThr 评分反转平仓分差阈值(越大越难触发)
 *   aiMaxScale    每日 AI 开仓上限缩放(高波日降频)
 *   trendW / meanW 趋势信号 / 均值回归信号权重倍率
 */
import { THRESH } from './thresholds.js';

const RANGE = THRESH.REGIME_RANGE;
const DEFAULT_PARAM = THRESH.REGIME_DEFAULT_PARAM;

// 趋势类信号(顺势): 趋势市强化
const TREND_SIGS = [
  '短线多头', '短线空头', '站上AIS', '跌破AIS', 'MACD多头', 'MACD空头',
  '持仓量上升', '三层共振多', '三层共振空', '共振买入', '共振卖出', '顺势回调',
];
// 均值回归类信号(逆势): 震荡市强化
const MEAN_SIGS = [
  'SRSI超买', 'SRSI超卖', '量价顶背离', '量价底背离', '触及支撑', '触及阻力',
  '超跌', '超涨', '急跌', '急涨',
];

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// 数值线性插值: t∈[0,1], 边界处取 a/b
function interp(a, b, t) {
  if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * t;
  return b;
}

// 数组插值(等长)
function interpArr(a, b, t) {
  if (!Array.isArray(a) || !Array.isArray(b)) return b;
  const n = Math.max(a.length, b.length);
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(interp(a[i], b[i], t));
  }
  return out;
}

/**
 * 主入口: regimeState → 当前参数组(与 range 类做 strength 弱趋势插值, 防突变)
 * unknown/数据不足 → 返回默认参数(行为等价于修复前固定参数)。
 */
export function regimeParams(state) {
  if (!state || !state.type || state.type === 'unknown') return { ...DEFAULT_PARAM };
  const base = RANGE[state.type] || DEFAULT_PARAM;
  if (state.type === 'range') return { ...base };
  const range = RANGE['range'];
  // 弱趋势(strength→0) ≈ 震荡市 → 参数向 range 靠拢; 强趋势(strength→1) → 用本类参数
  const t = clamp(state.strength || 0, 0, 1);
  return {
    gateKeep: interp(range.gateKeep, base.gateKeep, t),
    stopMult: interp(range.stopMult, base.stopMult, t),
    ladderMult: interpArr(range.ladderMult, base.ladderMult, t),
    exitSpreadThr: interp(range.exitSpreadThr, base.exitSpreadThr, t),
    aiMaxScale: interp(range.aiMaxScale, base.aiMaxScale, t),
    trendW: interp(range.trendW, base.trendW, t),
    meanW: interp(range.meanW, base.meanW, t),
  };
}

/**
 * 阶梯止盈部分平仓比例(替代原固定 0.25):
 * 波动率越高 → 比例越大(快跑锁利), 下限 REGIME_VOL_FLOOR 防超紧。
 */
export function volFactor(state) {
  // 无状态/未知 → 返回原固定比例 0.25(零行为变化); 有状态 → 波动越高比例越大
  if (!state || typeof state.volatility !== 'number') return THRESH.REGIME_VOL_FLOOR_PCT;
  const vol = state.volatility;
  return clamp(THRESH.REGIME_VOL_FLOOR_PCT * (1 + vol), THRESH.REGIME_VOL_FLOOR, 1);
}

/**
 * 信号权重倍率(与 getSigScore 相乘):
 *   趋势市: 趋势信号 ×trendW(1.5), 均值回归信号 ×meanW(0.5)
 *   震荡市: 反过来
 *   回调/未知: 中性 1.0
 */
export function regimeSignalWeight(sigName, state) {
  if (!state || !state.type || state.type === 'unknown') return 1;
  const rp = regimeParams(state);
  const isTrend = TREND_SIGS.indexOf(sigName) >= 0;
  const isMean = MEAN_SIGS.indexOf(sigName) >= 0;
  if (state.type === 'range') return isTrend ? rp.trendW : (isMean ? rp.meanW : 1);
  if (state.type === 'trend-up' || state.type === 'trend-down') return isTrend ? rp.trendW : (isMean ? rp.meanW : 1);
  return 1;
}

/**
 * 市场状态 → 信号策略（纯函数）：
 *   'energy-leader'    能量领跑: 各周期 SRSI KD 能量最高者驱动方向 (trend-up 数据最优)
 *   'freshest-signal'  最新鲜信号: 离当前最近的一根穿越/钩驱动方向 (trend-down 数据最优)
 *   'trend-baseline'   EMA 趋势基线: 方向基准(EMA20/120)驱动方向 (pullback/range 数据最优)
 *
 * 跨市场状态实测命中率(单批, 待持续累积):
 *   trend-up:   领跑56.3% > 趋势46.9% > 新鲜40.6%
 *   trend-down: 新鲜47.1% > 领跑35.3% > 趋势29.4%
 *   pullback/range: 趋势72.7%/75% 显著占优
 * 弱趋势(strength<0.5)一律回退趋势基线, 防临界处策略闪烁。
 */
export function regimeStrategy(state) {
  if (!state || !state.type || state.type === 'unknown') return 'trend-baseline';
  if ((state.strength || 0) < 0.5) return 'trend-baseline';
  if (state.type === 'trend-up') return 'energy-leader';
  if (state.type === 'trend-down') return 'freshest-signal';
  return 'trend-baseline';
}

export { TREND_SIGS, MEAN_SIGS };
