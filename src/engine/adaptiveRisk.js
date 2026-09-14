/**
 * adaptiveRisk.js — 自适应杠杆 / 宽保护性止损 的纯函数核心（实盘 + 回测共用同一套）
 *
 * 设计依据（scripts/liqStudy.mjs 归因）：
 *  - 每单爆仓率 ~6.5% 与入口危险信号无关，只与杠杆有关（7x → 逆向 ~13.9% 必爆）。
 *  - 固定百分比硬止损(6/10/12%) 对均值回归 SRSI 有害：被正常回撤噪声扫掉，净收益反降。
 *  - 因此：① 用「自适应杠杆」在剧烈行情自动降杠杆（直接压爆仓率）；② 用「宽保护性止损」
 *    以受监督 ATR 为基准（默认 2×ATR ≈ 7x 爆仓距离的一半），落于爆仓线内侧，只截真趋势破位。
 *
 * 两者协同：止损只有在「爆仓距离 ≫ 止损距离」时才有用，而这要求低杠杆。自适应杠杆是地基，
 * 宽止损是其 complement。两个功能均默认关；打开才生效，且不影响 (9) 回测基线。
 */

import { THRESH } from './thresholds.js';

/**
 * 自适应杠杆：波动放大→降杠杆，平静→回到基准。
 * @param {object} o
 * @param {number} o.baseLev   基准杠杆（如回测 bt.lev / 实盘 cfg.srsiAutoLev）
 * @param {number} o.atrPct    当前 ATR%（价格百分比，如 atr15/c15*100）
 * @param {number} o.medianAtrPct 历史中位 ATR%（波动基准；回测=样本中位，实盘=滚动中位/EMA）
 * @param {number} [o.minLev]  下限（默认 THRESH.ADAPTIVE_LEV_MIN）
 * @param {number} [o.maxLev]  上限（默认 baseLev）
 * @returns {number} 整数杠杆（minLev..maxLev）
 */
export function adaptiveLeverage({ baseLev, atrPct, medianAtrPct, minLev = THRESH.ADAPTIVE_LEV_MIN, maxLev = baseLev }) {
  const top = Math.max(minLev, maxLev);
  if (!(baseLev > 0) || !(atrPct > 0) || !(medianAtrPct > 0)) return Math.max(minLev, Math.min(top, Math.round(baseLev)));
  // 波动放大(atrPct>中位)→ ratio<1 → 降杠杆；平静→ ratio≥1 → 封顶 baseLev
  const ratio = Math.max(minLev / top, Math.min(1, medianAtrPct / atrPct));
  return Math.max(minLev, Math.min(top, Math.round(baseLev * ratio)));
}

/**
 * 宽保护性止损距离%（价格维度）：mult × 受监督 ATR%。
 * @returns {number|null} 止损距离百分比（如 6.0 表示逆向 6%），无有效 ATR 返回 null
 */
export function protectiveStopPct({ atrPct, mult = THRESH.ATR_STOP_MULT }) {
  if (!(atrPct > 0)) return null;
  return atrPct * mult;
}

/**
 * 由入场价/方向算止损价（long 在下方、short 在上方）。
 * @returns {number|null} 止损价；无有效 ATR 返回 null
 */
export function protectiveStopPrice(entry, side, atrPct, mult = THRESH.ATR_STOP_MULT) {
  const pct = protectiveStopPct({ atrPct, mult });
  if (pct == null || !(entry > 0)) return null;
  return side === 'long' ? entry * (1 - pct / 100) : entry * (1 + pct / 100);
}

/**
 * 采样滚动中位数（实盘用）：维护一个定长窗口的极值中位估计。
 * 这里用简单 EMA 中位近似以避免每 tick 排序；窗口由 THRESH.ADAPTIVE_LEV_MED_N 控节奏。
 * @param {number|null} prev  上一次的中位估计
 * @param {number} atrPct     当前 ATR%
 * @param {number} [alpha]    平滑系数（默认 2/(N+1)）
 * @returns {number} 更新后的中位估计
 */
export function updateAtrMedian(prev, atrPct, alpha) {
  if (!(atrPct > 0)) return prev || 0;
  const a = alpha != null ? alpha : 2 / (THRESH.ADAPTIVE_LEV_MED_N + 1);
  return prev == null ? atrPct : prev + a * (atrPct - prev);
}

/** 数组中位数（回测用：一次性算全样本中位 ATR%）。 */
export function medianOf(arr) {
  const v = (arr || []).filter(x => typeof x === 'number' && isFinite(x) && x > 0);
  if (!v.length) return null;
  v.sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
