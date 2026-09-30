// Jev（LLM 决策端点 `/v1/decisions`）—— 状态构建 / 请求体模板 / 响应解析
//
// 纯函数模块：无 DOM、无网络、无存储依赖（可 Node 单测）。
//
// 后端 schema（2026-09-29 实测，网关 http://localhost:3460/v1）：
//   POST /decisions  { model, state, questions: { <id>: { type, instructions, criteria } } }
//     type = 'choice' → criteria 是「标签→说明」对象（1..255 项）
//                        返回 { type:'choice', choice:<标签>, confidence, probabilities:{标签:概率} }
//     type = 'score'  → criteria 是标签数组（2..10 项）
//                        返回 { type:'score', score:<0..n-1 连续值>, confidence, legend, probabilities }
//     type = 'noul'   → 无 criteria（或 criteria 键必须是 true/false）→ 返回无量纲标量，本模块不用
//   → 一次调用可批量提问（本模块每轮把「短/中/长 + 驱动」合并为 1 次调用）
//
// 设计红线（用户裁定）：本模块只产生「判断文字与数值」，**不触发任何交易**；
// 提示词只喂提炼后的**文字档位**，绝不塞原始 K 线序列；缺项显式写「未知」。
import { volumeDivergence, supportResistance, newsSentiment, momentumPct } from './indicators.js';

// ⭐ 超短档（scalp）：口径对齐 SRSI 卫星的**实际出场量级**（15m × N 根）——
//   只有这一档用于「Jev 能否纠正 SRSI 信号」的裁决（GOAL_jev-srsi.md §2）。
//   N 预先写死为 JEV_SCALP_BARS，**不得因结果不好而手调**；若卫星真实持仓样本足够，
//   只能由用户显式确认后经 cfg.scalpBars 覆盖（见 calibrateScalpBars）。
export const JEV_SCALP_BARS = 8;   // 8 × 15m = 2h

export const JEV_HORIZONS = [
  { id: 'scalp', name: '超短', desc: '约 2 小时（SRSI 出场口径）' },
  { id: 'short', name: '短', desc: '数小时 ~ 1 天' },
  { id: 'mid', name: '中', desc: '数日 ~ 1 周' },
  { id: 'long', name: '长', desc: '数周 ~ 1 月' }
];
export const JEV_HORIZON_IDS = JEV_HORIZONS.map(h => h.id);
export const JEV_HORIZON_NAMES = JEV_HORIZONS.reduce((a, h) => (a[h.id] = h.name, a), {});

// 各档「前向窗口」天数（= 该档判断要等多久才能结算）—— 到期口径的唯一来源。
// 也是**独立样本**的间隔：相邻判断若落在同一窗口内，其结果是同一段行情决定的，
// 不能当独立样本（否则 n 被高估数十倍、z 检验失去意义）。
// 短 = 1h×24 = 1 天；中 = 4h×30 = 5 天；长 = 1d×30 = 30 天（与 src/pwa/jevClient.js 的 JEV_EVAL 一致）。
export const JEV_WINDOW_DAYS = { scalp: JEV_SCALP_BARS * 15 / 1440, short: 1, mid: 5, long: 30 };
export const JEV_WINDOW_MS = {
  scalp: JEV_SCALP_BARS * 15 * 60000,             // 8 × 15m = 2h（超短档独立样本间隔）
  short: JEV_WINDOW_DAYS.short * 86400000,
  mid: JEV_WINDOW_DAYS.mid * 86400000,
  long: JEV_WINDOW_DAYS.long * 86400000
};

/**
 * 纯函数：用**卫星真实持仓**标定超短档的前向根数 N（数据驱动，只在用户显式确认后应用）。
 *   - 取 `S.closed` 中 `src==='srsiAuto'` 的平仓记录：优先 `barsHeld`，否则 `(t - openT) / 15min`；
 *   - 样本 < minSamples（默认 20）→ 返回 null（调用方保持默认 JEV_SCALP_BARS）；
 *   - 否则取中位数 → 向上取偶 → clamp [4, 32]。
 * ⚠ 结果一旦应用即写死；**不得因「结果不好」而调整**（统计诚实性红线）。
 * @param {Array} closed S.closed 记录数组
 * @param {Object} [opts] { minSamples?:number, tfMs?:number }
 * @returns {number|null}
 */
export function calibrateScalpBars(closed, opts = {}) {
  const minSamples = opts.minSamples != null ? opts.minSamples : 20;
  const tfMs = opts.tfMs != null ? opts.tfMs : 15 * 60000;
  const bars = [];
  for (const c of (Array.isArray(closed) ? closed : [])) {
    if (!c || c.src !== 'srsiAuto') continue;
    let b = null;
    if (typeof c.barsHeld === 'number' && isFinite(c.barsHeld) && c.barsHeld > 0) b = c.barsHeld;
    else if (typeof c.t === 'number' && typeof c.openT === 'number' && c.t > c.openT) b = (c.t - c.openT) / tfMs;
    if (b != null && isFinite(b) && b > 0) bars.push(b);
  }
  if (bars.length < minSamples) return null;
  bars.sort((a, b) => a - b);
  const med = bars[Math.floor(bars.length / 2)];
  let n = Math.ceil(med);
  if (n % 2 !== 0) n += 1;                       // 向上取偶
  return Math.max(4, Math.min(32, n));
}

// 周期分组（默认值；用户可在设置里改勾选，未勾的档不提问）
export const JEV_DEFAULT_GROUPS = {
  scalp: ['5m', '15m', '1h'],
  short: ['5m', '15m', '1h'],
  mid: ['4h', '1d'],
  long: ['7d', '30d']
};

// score 档位（顺序 = 从最空到最多；用数组形式 → score ∈ [0, n-1]）
export const JEV_LEVELS = ['强空', '偏空', '中性', '偏多', '强多'];

// 驱动因素（choice）：键=发给模型的选项、值=说明（同时用作模型理解的提示）
export const JEV_DRIVERS = {
  技术面: '价格形态、指标信号、量能',
  资金面: '资金费率、持仓量、主动买卖与多空比',
  消息面: '新闻/公告、宏观事件、社群情绪',
  体制面: '趋势/震荡、波动率、时间窗口'
};

// 「TSEV 学 Jev」三态
export const JEV_MODES = {
  off: { label: '关（不记录样本）', short: '关' },
  learn: { label: '只学不影响（记录样本，不改 TSEV 投票）', short: '只学' },
  apply: { label: '学并影响（记录样本，且 Jev 因子参与 TSEV 投票）', short: '学+影响' }
};

// 默认请求体模板（高级可编辑；占位符用 {{...}}，本模块只在非空时使用）
export const JEV_DEFAULT_TEMPLATE = '';

export const JEV_DEFAULT_QUESTIONS = {
  scalp: '超短线（约 2 小时，交易执行口径）方向如何？只依据上面给出的状态档位判断；不确定就选「中性」。',
  short: '短线（数小时至 1 天）方向如何？只依据上面给出的状态档位判断。',
  mid: '中线（数日至 1 周）方向如何？只依据上面给出的状态档位判断。',
  long: '长线（数周至 1 月）方向如何？只依据上面给出的状态档位判断。',
  driver: '以上判断的主要驱动来自哪一类信息？'
};

// ---------------------------------------------------------------------------
// 档位分类（纯函数）
// ---------------------------------------------------------------------------
const num = (v) => (typeof v === 'number' && isFinite(v)) ? v : null;
const pct1 = (v) => (v == null ? '?' : (v >= 0 ? '+' : '') + v.toFixed(2) + '%');

export function rsiZone(v) {
  const x = num(v);
  if (x == null) return null;
  if (x >= 70) return '超买';
  if (x <= 30) return '超卖';
  return '中性';
}

// MACD：用 hist 的正负 + 与前值比较（放大/收敛）判定
export function macdState(hist, prevHist) {
  const h = num(hist), p = num(prevHist);
  if (h == null) return null;
  if (p == null) return h > 0 ? '多头' : h < 0 ? '空头' : '缠绕';
  if (p <= 0 && h > 0) return '金叉';
  if (p >= 0 && h < 0) return '死叉';
  if (h > 0) return Math.abs(h) >= Math.abs(p) ? '多头发散' : '多头收敛';
  if (h < 0) return Math.abs(h) >= Math.abs(p) ? '空头发散' : '空头收敛';
  return '缠绕';
}

export function maState(price, ema20, ema120) {
  const p = num(price), a = num(ema20), b = num(ema120);
  if (p == null || a == null) return null;
  const above20 = p > a;
  const near = Math.abs(p - a) / a < 0.002;       // 0.2% 内视为缠绕
  if (near) return '缠绕均线';
  if (b != null && a > b) return above20 ? '站上均线(多头排列)' : '跌破均线(多头排列)';
  if (b != null && a < b) return above20 ? '站上均线(空头排列)' : '跌破均线(空头排列)';
  return above20 ? '站上均线' : '跌破均线';
}

// 量能：末根量 vs 前 20 根中位数；配合近 3 根价格方向
export function volState(vols, closes) {
  if (!Array.isArray(vols) || vols.length < 6) return null;
  const n = vols.length;
  const cur = num(vols[n - 1]);
  if (cur == null || cur <= 0) return null;
  const from = Math.max(0, n - 21);
  const win = vols.slice(from, n - 1).filter(v => num(v) > 0).sort((a, b) => a - b);
  if (win.length < 4) return null;
  const med = win[Math.floor(win.length / 2)];
  if (!med) return null;
  const r = cur / med;
  let dir = 0;
  if (Array.isArray(closes) && closes.length >= 4) {
    dir = Math.sign(num(closes[closes.length - 1]) - num(closes[closes.length - 4])) || 0;
  }
  if (r >= 2.5) return dir < 0 ? '爆量下跌' : '爆量上涨';
  if (r >= 1.4) return dir < 0 ? '放量下跌' : '放量突破';
  if (r <= 0.6) return dir < 0 ? '缩量回调' : '缩量上涨';
  return '量能平稳';
}

// 蜡烛形态（轻量：连阳/连阴、假突破、三角收敛）
export function candlePattern(closes, highs, lows) {
  if (!Array.isArray(closes) || closes.length < 8) return null;
  const n = closes.length;
  const out = [];
  let up = 0;
  for (let i = n - 1; i >= 1 && up >= 0 && i > n - 5; i--) {
    if (closes[i] > closes[i - 1]) up++;
    else break;
  }
  if (up >= 3) out.push('连阳');
  let down = 0;
  for (let i = n - 1; i >= 1 && i > n - 5; i--) {
    if (closes[i] < closes[i - 1]) down++;
    else break;
  }
  if (down >= 3) out.push('连阴');
  // 假突破：末根最高曾突破前 20 根高点，但收盘回到其下方
  if (Array.isArray(highs) && highs.length === n) {
    const from = Math.max(0, n - 21);
    let hh = -Infinity;
    for (let i = from; i < n - 1; i++) if (num(highs[i]) > hh) hh = num(highs[i]);
    const h = num(highs[n - 1]), c = num(closes[n - 1]);
    if (isFinite(hh) && h != null && c != null && h > hh && c < hh) out.push('向上假突破');
  }
  if (Array.isArray(lows) && lows.length === n) {
    const from = Math.max(0, n - 21);
    let ll = Infinity;
    for (let i = from; i < n - 1; i++) if (num(lows[i]) < ll) ll = num(lows[i]);
    const l = num(lows[n - 1]), c = num(closes[n - 1]);
    if (isFinite(ll) && l != null && c != null && l < ll && c > ll) out.push('向下假突破');
  }
  // 三角收敛：近 20 根高低振幅持续收窄（后半振幅 < 前半 70%）
  if (Array.isArray(highs) && Array.isArray(lows) && highs.length === n && n >= 20) {
    const a = n - 20;
    let h1 = -Infinity, l1 = Infinity, h2 = -Infinity, l2 = Infinity;
    for (let i = a; i < a + 10; i++) { if (num(highs[i]) > h1) h1 = num(highs[i]); if (num(lows[i]) < l1) l1 = num(lows[i]); }
    for (let i = a + 10; i < n; i++) { if (num(highs[i]) > h2) h2 = num(highs[i]); if (num(lows[i]) < l2) l2 = num(lows[i]); }
    if (isFinite(h1) && isFinite(l1) && isFinite(h2) && isFinite(l2) && (h1 - l1) > 0) {
      if ((h2 - l2) / (h1 - l1) < 0.7) out.push('三角收敛');
    }
  }
  return out.length ? out.join('+') : '无明显形态';
}

export function srsiBandText(k, ob = 80, os = 20) {
  const x = num(k);
  if (x == null) return null;
  if (x >= ob) return '上带';
  if (x <= os) return '下带';
  return '中带';
}

export function atrBandText(atrPct, medAtrPct) {
  const a = num(atrPct);
  if (a == null) return null;
  let band = '中波动';
  const m = num(medAtrPct);
  if (m != null && m > 0) {
    if (a >= m * 1.4) band = '高波动（扩张）';
    else if (a <= m * 0.7) band = '低波动（收缩）';
  }
  return band + '(ATR ' + a.toFixed(2) + '%)';
}

export function resonanceText(res) {
  if (!res) return null;
  // 兼容两种形态：
  //   ① 数值计数 {buy:2, sell:0}（旧测试/旧调用）
  //   ② indicators.resonance() 的 {buy:bool, sell:bool, strength, buyScore, sellScore, conditions}
  // ⭐ 修复：旧实现只读数值 buy/sell → 传入布尔形态时恒得 0 → 永远输出「无共振」（实测强空共振也被写成无共振）。
  const numBuy = (typeof res.buy === 'number' && isFinite(res.buy)) ? res.buy : null;
  const numSell = (typeof res.sell === 'number' && isFinite(res.sell)) ? res.sell : null;
  const buy = (numBuy != null && numSell != null) ? numBuy : (num(res.buyScore) || 0);
  const sell = (numBuy != null && numSell != null) ? numSell : (num(res.sellScore) || 0);
  const stTxt = res.strength === 'strong' ? '强' : res.strength === 'medium' ? '中' : res.strength === 'weak' ? '弱' : '';
  const names = Array.isArray(res.conditions) ? res.conditions.map(c => c && c.n).filter(Boolean) : [];
  const condTxt = names.length ? '：' + names.slice(0, 6).join('/') : '';
  const stSuffix = stTxt ? ' · ' + stTxt : '';
  if (buy > 0 && sell === 0) return '一致偏多(买' + buy + '/卖' + sell + stSuffix + ')' + condTxt;
  if (sell > 0 && buy === 0) return '一致偏空(买' + buy + '/卖' + sell + stSuffix + ')' + condTxt;
  if (buy > 0 && sell > 0) return '分歧(买' + buy + '/卖' + sell + (buy > sell ? ' 多数偏多' : sell > buy ? ' 多数偏空' : ' 均衡') + stSuffix + ')' + condTxt;
  return '无共振';
}

// UTC 时间窗口
export function timeWindow(nowMs) {
  const d = nowMs ? new Date(nowMs) : new Date();
  const day = d.getUTCDay();
  const h = d.getUTCHours(), min = d.getUTCMinutes();
  const hm = h + min / 60;
  const wd = day >= 1 && day <= 5;
  let slot;
  if (!wd) slot = '周末（流动性偏低）';
  else if (hm < 1) slot = '日线开盘';
  else if (hm >= 22) slot = '尾盘/次日开盘前';
  else slot = '盘中';
  const hhmm = String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
  return slot + '（UTC ' + hhmm + (wd ? ' 工作日' : ' 周末') + '）';
}

// ---------------------------------------------------------------------------
// 状态文本构建
// ---------------------------------------------------------------------------
function fmtTfLine(tf, d) {
  if (!d) return '- ' + tf + ': 未知';
  const parts = [];
  if (d.rsi != null) parts.push('RSI ' + Math.round(d.rsi) + '(' + (rsiZone(d.rsi) || '?') + ')');
  if (d.macd) parts.push('MACD ' + d.macd);
  if (d.ma) parts.push('价格' + d.ma);
  if (d.vol) parts.push('量能 ' + d.vol);
  if (d.pattern && d.pattern !== '无明显形态') parts.push(d.pattern);
  if (d.srsi != null) parts.push('SRSI K=' + Math.round(d.srsi) + (d.kd ? '(K' + Math.round(d.kd[0]) + ' D' + Math.round(d.kd[1]) + ')' : '') + ' 带=' + (d.band || '?'));
  if (d.momPct != null) parts.push('近10根动量 ' + pct1(d.momPct));
  if (d.atr) parts.push(d.atr);
  return '- ' + tf + ': ' + (parts.length ? parts.join(' · ') : '未知');
}

/**
 * 生成喂给 Jev 的状态文本（**纯文字档位**，四组；缺项写「未知」）。
 * @param {Object} inp
 *   inp.sym, inp.group, inp.tfs[], inp.tf{}（每周期读数）, inp.resonance, inp.vd, inp.sr,
 *   inp.regime, inp.volQ, inp.trend, inp.macro, inp.flow{}, inp.ext{}, inp.now
 * @returns {{text:string, missing:string[], sections:Object}}
 */
export function buildJevState(inp) {
  const it = inp || {};
  const missing = [];
  const tfs = Array.isArray(it.tfs) && it.tfs.length ? it.tfs : (JEV_DEFAULT_GROUPS[it.group] || []);
  const tfMap = it.tf || {};

  // ① 技术指标
  const techLines = tfs.map(tf => fmtTfLine(tf, tfMap[tf]));
  const noTech = tfs.every(tf => !tfMap[tf]);
  if (noTech) missing.push('技术指标');
  const resTxt = resonanceText(it.resonance);
  const vd = it.vd || {};
  const vdTxt = vd.bull ? '底部背离（价新低而量收缩）' : vd.bear ? '顶部背离（价新高而量收缩）' : (vd.pct != null ? '无量价背离（量变 ' + pct1(vd.pct) + '）' : '未知');
  const sr = it.sr || {};
  const srTxt = (sr.supDistPct != null || sr.resDistPct != null)
    ? '支撑 -' + (sr.supDistPct != null ? Math.abs(sr.supDistPct).toFixed(2) : '?') + '% / 阻力 +' + (sr.resDistPct != null ? sr.resDistPct.toFixed(2) : '?') + '%'
    : '未知';

  // ② 盘口与订单流
  const fl = it.flow || {};
  const frTxt = fl.fundingRate != null
    ? pct1(fl.fundingRate * 100) + '/期' + (fl.frTrend ? '（' + fl.frTrend + '）' : '') + (fl.fundingRate > 0 ? ' → 多头拥挤（多头付费；趋势市中可延续，震荡市中易回落）' : fl.fundingRate < 0 ? ' → 空头拥挤（空头付费；下跌趋势中可延续，震荡市中易反弹）' : '') +
      (fl.basisPct != null ? ' · 基差 ' + pct1(fl.basisPct) : '')
    : (fl.basisPct != null ? '未知 · 基差 ' + pct1(fl.basisPct) : '未知');
  const oiTxt = fl.oi != null ? (fl.oiTrend ? fl.oiTrend + '（' + fmtNum(fl.oi) + '）' : fmtNum(fl.oi)) : '未知';
  const tkTxt = fl.taker != null ? '主动买/卖 = ' + Number(fl.taker).toFixed(3) + (fl.taker >= 1.05 ? '（买盘主动）' : fl.taker <= 0.95 ? '（卖盘主动）' : '（均衡）') : '未知';
  const lsTxt = fl.longRatio != null ? '多头账户占比 ' + Number(fl.longRatio).toFixed(1) + '%' : '未知';
  const whaleTxt = fl.whale != null ? fl.whale : '未知';
  const liqTxt = fl.liq != null ? fl.liq : '未知';
  if (frTxt === '未知' && oiTxt === '未知' && tkTxt === '未知') missing.push('盘口/订单流');
  // ③ 外部语义
  const ex = it.ext || {};
  const newsTxt = ex.news
    ? (ex.news.sentiment === 'bullish' ? '偏利好' : ex.news.sentiment === 'bearish' ? '偏利空' : '中性') +
      '(利好' + ex.news.bullishCount + '/利空' + ex.news.bearishCount + ')' + (ex.news.title ? ' — ' + String(ex.news.title).slice(0, 60) : '')
    : '未知';
  const macroNewsTxt = ex.macro || '未知（请用你自身的宏观知识判断）';
  const socialTxt = ex.social || '未知';
  if (newsTxt === '未知') missing.push('新闻/外部语义');

  // ④ 市场环境与体制
  const rg = it.regime || {};
  // 兼容两种体制对象：detectRegimeState（type='trend-up'/'range'… 带 label）与旧式 {type:'trend',direction:'up'}
  const REGIME_ZH = { trend: '趋势', range: '震荡', pullback: '回调', 'trend-up': '多头趋势 ↑', 'trend-down': '空头趋势 ↓', 'pullback-up': '上涨中回调', 'pullback-down': '下跌中反弹', unknown: '未知' };
  const _rdir = rg.direction === 'up' || rg.direction === 1 ? '向上' : rg.direction === 'down' || rg.direction === -1 ? '向下' : rg.direction === 0 ? '横向' : null;
  const regimeTxt = rg.type
    ? (rg.label || REGIME_ZH[rg.type] || rg.type) + (!rg.label && _rdir ? '(' + _rdir + ')' : '') + (rg.strength != null ? ' 强度' + Number(rg.strength).toFixed(2) : '')
    : '未知';
  const volQ = num(it.volQ);
  const volTxt = volQ != null ? '波动率分位 ' + Math.round(volQ * 100) + '%（' + (volQ >= 0.7 ? '高' : volQ <= 0.3 ? '低' : '中') + '）' : '未知';
  const tr = it.trend || {}, mc = it.macro || {};
  const trendTxt = tr.label
    ? tr.label + ' ' + pct1(tr.spreadPct) + (tr.tf ? '(' + tr.tf + ' EMA20/120)' : '')
    : (tr.up != null ? (tr.up ? '上升' : '下降') + ' ' + pct1(tr.spreadPct) + (tr.tf ? '(' + tr.tf + ' EMA20/120)' : '') : '未知');
  const macroTxt = mc.label
    ? mc.label + ' ' + pct1(mc.spreadPct) + (mc.tf ? '(' + mc.tf + ')' : '')
    : (mc.up != null ? (mc.up ? '上升' : '下降') + ' ' + pct1(mc.spreadPct) + (mc.tf ? '(' + mc.tf + ')' : '') : '未知');

  const sections = {
    tech: techLines.join('\n') + '\n- 多周期共振: ' + (resTxt || '未知') + '\n- 量价背离: ' + vdTxt + '\n- 支撑/阻力: ' + srTxt,
    flow: '- 资金费率: ' + frTxt + '\n- 持仓量变化: ' + oiTxt + '\n- 主动买卖比: ' + tkTxt + '\n- 多空账户比: ' + lsTxt + '\n- 大单/鲸鱼: ' + whaleTxt + '\n- 清算密集区: ' + liqTxt,
    ext: '- 新闻情绪: ' + newsTxt + '\n- 宏观事件: ' + macroNewsTxt + '\n- 社群舆情: ' + socialTxt,
    regime: '- 市场体制: ' + regimeTxt + '\n- 波动: ' + (volTxt) + '\n- 趋势门' + (tr.tf ? '(' + tr.tf + ')' : '') + ': ' + trendTxt + ' · 宏观' + (mc.tf ? '(' + mc.tf + ')' : '') + ': ' + macroTxt + '\n- 时间窗口: ' + timeWindow(it.now)
  };
  const text = [
    '标的: ' + (it.sym || '未知') + '｜判断档位: ' + (it.group || '短') + '（周期 ' + tfs.join('/') + '）',
    '',
    '【一、技术指标档位】',
    sections.tech,
    '',
    '【二、盘口与订单流档位】',
    sections.flow,
    '',
    '【三、外部语义（你最擅长；未知的请用自身知识补充，不要编造具体数字）】',
    sections.ext,
    '',
    '【四、市场环境与体制】',
    sections.regime
  ].join('\n');
  return { text, missing, sections, tfs };
}

function fmtNum(v) {
  const n = num(v);
  if (n == null) return '未知';
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  return String(Math.round(n));
}

// ---------------------------------------------------------------------------
// 请求体
// ---------------------------------------------------------------------------
/**
 * 模板渲染：占位符 {{key}} → 值。若占位符被双引号包裹（"{{key}}"），替换为 JSON 字符串（含引号）；
 * 否则替换为 JSON 值（数组/对象/数字需在模板里裸写）。{{state}} 推荐裸写。
 */
export function renderTemplate(tpl, vars) {
  if (!tpl || typeof tpl !== 'string') throw new Error('模板为空');
  let out = tpl;
  for (const k in (vars || {})) {
    const val = vars[k];
    const reQ = new RegExp('"' + '\\{\\{' + k + '\\}\\}' + '"', 'g');
    out = out.replace(reQ, JSON.stringify(String(val == null ? '' : val)));
    out = out.split('{{' + k + '}}').join(JSON.stringify(val == null ? null : val));
  }
  const left = out.match(/\{\{[a-zA-Z_][\w]*\}\}/);
  if (left) throw new Error('模板存在未替换占位符: ' + left[0]);
  let json;
  try { json = JSON.parse(out); } catch (e) { throw new Error('模板不是合法 JSON: ' + e.message); }
  if (!json || typeof json !== 'object') throw new Error('模板必须是 JSON 对象');
  return json;
}

/**
 * 构造请求体：cfg.template 非空 → 用模板（高级）；否则用内置（只问已勾选的档）。
 * @param {Object} cfg {model, template, questions:{short,mid,long,driver}, enabled:{short,mid,long}}
 */
export function buildJevBody(cfg, stateText, opts = {}) {
  const c = cfg || {};
  const model = String(c.model || 'jev-latest').trim();
  if (c.template && String(c.template).trim()) {
    return renderTemplate(String(c.template), { model, state: stateText });
  }
  const enabled = c.enabled || { short: true, mid: true, long: true };
  const qs = Object.assign({}, JEV_DEFAULT_QUESTIONS, c.questions || {});
  const questions = {};
  for (const h of JEV_HORIZON_IDS) {
    if (enabled[h] === false) continue;
    questions[h] = { type: 'score', instructions: qs[h], criteria: (opts.levels || JEV_LEVELS).slice() };
  }
  if (Object.keys(questions).length === 0) throw new Error('至少勾选一个周期档（超短/短/中/长）');
  if (enabled.driver !== false) {
    questions.driver = { type: 'choice', instructions: qs.driver, criteria: Object.assign({}, JEV_DRIVERS) };
  }
  return { model, state: stateText, questions };
}

// ---------------------------------------------------------------------------
// 响应解析
// ---------------------------------------------------------------------------
/** score(0..n-1) → −100..+100 强度 */
export function scoreToStrength(score, levels) {
  const n = Math.max(2, (levels || JEV_LEVELS).length);
  const s = num(score);
  if (s == null) return null;
  const v = (s / (n - 1)) * 200 - 100;
  return Math.max(-100, Math.min(100, Math.round(v)));
}

export function strengthLabel(strength) {
  const v = num(strength);
  if (v == null) return '未知';
  if (v >= 60) return '强多';
  if (v >= 15) return '偏多';
  if (v <= -60) return '强空';
  if (v <= -15) return '偏空';
  return '中性';
}

/** 方向（用于 TSEV 因子 side）：>thr 看多 / <−thr 看空 / 其余 flat */
export function jevSide(strength, thr = 15) {
  const v = num(strength);
  if (v == null) return 'flat';
  if (v >= thr) return 'long';
  if (v <= -thr) return 'short';
  return 'flat';
}

/**
 * 解析决策响应。
 * @returns {{ok:boolean, err:string|null, driver:string|null, horizons:Object, usage:Object|null, model:string|null}}
 */
export function parseJevResponse(json, opts = {}) {
  const out = { ok: false, err: null, driver: null, horizons: {}, usage: null, model: null };
  if (!json || typeof json !== 'object') { out.err = '响应为空'; return out; }
  out.usage = json.usage || null;
  out.model = json.model || null;
  const ans = json.answers;
  if (!ans || typeof ans !== 'object') { out.err = '响应缺少 answers'; return out; }
  const levels = opts.levels || JEV_LEVELS;
  for (const h of JEV_HORIZON_IDS) {
    const a = ans[h];
    if (!a) continue;
    if (a.type === 'score') {
      const strength = scoreToStrength(a.score, levels);
      out.horizons[h] = {
        type: 'score', raw: num(a.score), strength, label: strengthLabel(strength),
        conf: num(a.confidence), legend: a.legend || null, probabilities: a.probabilities || null
      };
    } else if (a.type === 'choice') {
      const probs = a.probabilities || {};
      const keys = Object.keys(probs);
      const bullKey = keys.find(k => /多|涨|bull|up/i.test(k));
      const bearKey = keys.find(k => /空|跌|bear|down/i.test(k));
      const strength = (bullKey && bearKey)
        ? Math.round(((num(probs[bullKey]) || 0) - (num(probs[bearKey]) || 0)) * 100)
        : (a.choice && /多|涨|bull|up/i.test(a.choice) ? 60 : a.choice && /空|跌|bear|down/i.test(a.choice) ? -60 : 0);
      out.horizons[h] = {
        type: 'choice', raw: a.choice || null, strength, label: strengthLabel(strength),
        conf: num(a.confidence), probabilities: probs
      };
    } else {
      out.horizons[h] = { type: a.type || 'unknown', raw: a.noul != null ? a.noul : null, strength: null, label: '未知', conf: num(a.confidence) };
    }
  }
  const d = ans.driver;
  if (d && d.type === 'choice' && d.choice) out.driver = String(d.choice);
  else if (d && d.noul != null) out.driver = null;
  if (!Object.keys(out.horizons).length) { out.err = 'answers 中没有可识别的 scalp/short/mid/long 档'; return out; }
  out.ok = true;
  return out;
}

/** 把解析结果转成「已学样本」所需的信息（供 TSEV 记录） */
export function jevSamplesFor(parsed, sym, ts, opts = {}) {
  const thr = opts.thr != null ? opts.thr : 15;
  const out = [];
  if (!parsed || !parsed.ok) return out;
  for (const h of JEV_HORIZON_IDS) {
    const r = parsed.horizons[h];
    if (!r || r.strength == null) continue;
    const side = jevSide(r.strength, thr);
    if (side === 'flat') continue;   // 中性不留样本（与 TSEV「无方向不入票」一致）
    out.push({ sym, ts, horizon: h, side, strength: r.strength, conf: r.conf || 0 });
  }
  return out;
}

// 便捷：由原始 klines 数组计算某周期的读数额度（供收集器复用，纯函数）
export function tfReadings(closes, highs, lows, vols, opts = {}) {
  if (!Array.isArray(closes) || closes.length < 8) return null;
  const n = closes.length;
  const atrPct = opts.atrPct != null ? opts.atrPct : null;
  const hist = Array.isArray(opts.macdHist) ? opts.macdHist : null;
  const kd = Array.isArray(opts.kd) ? opts.kd : null;
  const out = {
    rsi: opts.rsi != null ? opts.rsi : null,
    macd: opts.macd != null ? opts.macd : macdState(hist ? hist[n - 1] : null, hist ? hist[n - 2] : null),
    ma: opts.ma != null ? opts.ma : maState(closes[n - 1], opts.ema20, opts.ema120),
    vol: volState(vols, closes),
    pattern: candlePattern(closes, highs, lows),
    momPct: momentumPct(closes, 10),
    atr: atrBandText(atrPct, opts.medAtrPct),
    srsi: kd ? kd[0] : null,
    kd,
    band: kd ? srsiBandText(kd[0], opts.ob, opts.os) : null
  };
  return out;
}

/**
 * 解析盘口/订单流 API 原始回包（纯函数，可单测）。入参均可为 null：
 *   premium = /fapi/v1/premiumIndex 对象；oi = openInterestHist 数组；
 *   lsGlobal = globalLongShortAccountRatio 数组；lsTop = topLongShortAccountRatio 数组；
 *   taker = takerlongshortRatio 数组；prevRate = 上一次 fundingRate
 * 注意：Binance 的 longAccount 是 **0~1 小数**（0.5399=53.99%）→ 必须归一化（§5.12 踩坑）。
 */
export function parseJevFlow(inp) {
  const it = inp || {};
  const out = { filled: {}, filledN: 0, totalN: 5 };
  const lastEl = (a) => (Array.isArray(a) && a.length ? a[a.length - 1] : null);
  const numOf = (v) => (v == null || v === '' ? null : (isFinite(+v) ? +v : null));

  const p = it.premium;
  if (p) {
    const fr = numOf(p.lastFundingRate);
    if (fr != null) { out.fundingRate = fr; out.filled.funding = true; }
    if (p.nextFundingTime != null) out.fundingNextTs = +p.nextFundingTime || null;
    const mk = numOf(p.markPrice), ix = numOf(p.indexPrice);
    if (mk != null) out.markPrice = mk;
    if (ix != null && mk != null && ix > 0) { out.indexPrice = ix; out.basisPct = (mk - ix) / ix * 100; out.filled.basis = true; }
  }
  const pr = numOf(it.prevRate);
  if (out.fundingRate != null && pr != null && pr !== out.fundingRate) {
    const d = out.fundingRate - pr;
    if (Math.abs(d) > 1e-12) { out.frTrend = d > 0 ? '较上次↑' : '较上次↓'; out.frDelta = d; }
  }

  const oiArr = Array.isArray(it.oi) ? it.oi : null;
  if (oiArr && oiArr.length) {
    const a = numOf(oiArr[0].sumOpenInterest), b = numOf(lastEl(oiArr).sumOpenInterest);
    if (b != null) { out.oi = b; out.filled.oi = true; }
    if (a != null && b != null && a > 0) { out.oiChangePct = (b - a) / a * 100; out.oiChangeBars = oiArr.length; }
  }

  const norm = (v) => { const x = numOf(v); if (x == null) return null; return x <= 1 ? x * 100 : x; };
  const lg = lastEl(it.lsGlobal);
  if (lg) { const v = norm(lg.longAccount); if (v != null) { out.longRatio = v; out.filled.ls = true; } }
  const lt = lastEl(it.lsTop);
  if (lt) { const v = norm(lt.longAccount); if (v != null) out.topLongRatio = v; }
  const tk = lastEl(it.taker);
  if (tk) { const v = numOf(tk.buySellRatio); if (v != null) { out.taker = v; out.filled.taker = true; } }

  out.filledN = Object.keys(out.filled).length;
  return out;
}

/** 数据填充度摘要（面板显示用，纯函数）：配合「缺就写未知」的诚实口径 */
export function flowFillSummary(flow, ext) {
  const f = flow || {};
  const items = [
    ['资金费率', !!(f.filled && f.filled.funding)],
    ['基差', !!(f.filled && f.filled.basis)],
    ['持仓量', !!(f.filled && f.filled.oi)],
    ['多空比', !!(f.filled && f.filled.ls)],
    ['主动买卖', !!(f.filled && f.filled.taker)]
  ];
  const missing = items.filter(x => !x[1]).map(x => x[0]);
  const have = items.length - missing.length;
  const news = !!(ext && ext.news);
  return {
    flow: { have, total: items.length, missing },
    news,
    text: '盘口 ' + have + '/' + items.length + (missing.length ? '（缺：' + missing.join('·') + '）' : '') + ' · 新闻 ' + (news ? '✓' : '未知')
  };
}

/** 收集器辅助：量价背离 + 支撑阻力（复用 indicators 纯函数） */
export function priceStructure(closes, vols) {
  return {
    vd: volumeDivergence(closes, vols, 20) || {},
    sr: supportResistance(closes, 40) || {}
  };
}

export function newsOf(items) {
  try { return newsSentiment(items); } catch (e) { return null; }
}
