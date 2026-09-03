// 技术指标纯函数引擎：EMA / RSI / MACD / SRSI / ATR / AIS(自适应) / 共振
// 所有函数均为纯函数，输入价格序列数组，输出等长数组或对象，可独立单测。
import { THRESH } from './thresholds.js';

// EMA(指数移动平均)：返回与 data 等长数组，不足 period 的头部为 null
export function ema(data, period) {
  const out = new Array(data.length).fill(null);
  if (period <= 0 || data.length < period) return out;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += data[i];
  let prev = sum / period;   // 用前 period 个值的 SMA 起步
  out[period - 1] = prev;
  for (let i = period; i < data.length; i++) {
    prev = data[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// 简单移动平均（供 MACD/SRSI 使用）
export function sma(data, period) {
  const out = new Array(data.length).fill(null);
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum += data[i];
    if (i >= period) sum -= data[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

// RSI(相对强弱指数)：返回 0~100 数组，不足 period+1 的头部为 null
export function rsi(data, period = 14) {
  const out = new Array(data.length).fill(null);
  if (data.length < period + 1) return out;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = data[i] - data[i - 1];
    if (diff >= 0) avgGain += diff; else avgLoss -= diff;
  }
  avgGain /= period; avgLoss /= period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < data.length; i++) {
    const diff = data[i] - data[i - 1];
    const gain = diff >= 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

// MACD(指数平滑异同移动平均)：返回 { line, signal, hist } 三条等长数组
export function macd(data, fast = 12, slow = 26, signal = 9) {
  const emaF = ema(data, fast);
  const emaS = ema(data, slow);
  const line = data.map((_, i) => (emaF[i] !== null && emaS[i] !== null ? emaF[i] - emaS[i] : null));
  const sig = sma(line.map(v => (v === null ? 0 : v)), signal).map((v, i) => (i >= signal - 1 && line[i] !== null ? v : null));
  const hist = line.map((v, i) => (v !== null && sig[i] !== null ? v - sig[i] : null));
  return { line, signal: sig, hist };
}

// SRSI(随机RSI / StochRSI)：先算 RSI，再做随机指标，输出 0~100 数组
export function srsi(data, rsiPeriod = 14, stochPeriod = 14) {
  const r = rsi(data, rsiPeriod);
  const out = new Array(data.length).fill(null);
  for (let i = stochPeriod - 1; i < data.length; i++) {
    if (r[i] === null) continue;
    let min = Infinity, max = -Infinity;
    for (let j = Math.max(0, i - stochPeriod + 1); j <= i; j++) {
      if (r[j] === null) { min = Infinity; max = -Infinity; break; }
      if (r[j] < min) min = r[j];
      if (r[j] > max) max = r[j];
    }
    if (max - min > 1e-12) out[i] = ((r[i] - min) / (max - min)) * 100;
    else out[i] = 50;
  }
  return out;
}

// 平滑辅助：对数组做简单移动平均，跳过头部的 null（不把 null 当 0 污染均值）。
// period<=1 时原样返回。
function smoothSeries(arr, period) {
  const out = new Array(arr.length).fill(null);
  if (!(period > 1)) return arr.slice();
  const q = [];
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v === null || v === undefined) { out[i] = null; continue; }
    q.push(v); sum += v;
    if (q.length > period) sum -= q.shift();
    if (q.length === period) out[i] = sum / period;
  }
  return out;
}

// 标准随机RSI（K/D 双线）：RSI → 随机 %K 原始值 → SMA(smoothK)=%K → SMA(smoothD)=%D
// 用户人工盯盘参数：RSI 85 / stoch 50 / 平滑K 10 / 平滑D 5
// opts: { rsiPeriod=14, stochPeriod=14, smoothK=3, smoothD=3 }
// 返回 { k, d, rawK } 三条等长数组（不足窗口的头部为 null）
export function srsiKD(data, opts = {}) {
  const rsiPeriod = opts.rsiPeriod || 14;
  const stochPeriod = opts.stochPeriod || 14;
  const smoothK = opts.smoothK == null ? 3 : opts.smoothK;
  const smoothD = opts.smoothD == null ? 3 : opts.smoothD;
  const r = rsi(data, rsiPeriod);
  const rawK = new Array(data.length).fill(null);
  for (let i = stochPeriod - 1; i < data.length; i++) {
    if (r[i] === null) continue;
    let min = Infinity, max = -Infinity;
    for (let j = Math.max(0, i - stochPeriod + 1); j <= i; j++) {
      if (r[j] === null) { min = Infinity; max = -Infinity; break; }
      if (r[j] < min) min = r[j];
      if (r[j] > max) max = r[j];
    }
    if (max - min > 1e-12) rawK[i] = ((r[i] - min) / (max - min)) * 100;
    else rawK[i] = 50;
  }
  const k = smoothSeries(rawK, smoothK);
  const d = smoothSeries(k, smoothD);
  return { k, d, rawK };
}

// SRSI 区间/穿越判定（用户反手策略核心）：
//   zone: 'overbought'(K>=80 超买带) / 'oversold'(K<=20 超卖带) / 'neutral'
//   crossing: K 从下方上穿 80 → 'sell'(进入超买 → 反手做空)
//             K 从上方下穿 20 → 'buy'(进入超卖 → 反手做多)
//             否则 null
// opts: { overbought=80, oversold=20 }
export function srsiSignal(k, prevK, opts = {}) {
  const overbought = opts.overbought != null ? opts.overbought : 80;
  const oversold = opts.oversold != null ? opts.oversold : 20;
  let zone = 'neutral';
  if (k != null && k >= overbought) zone = 'overbought';
  else if (k != null && k <= oversold) zone = 'oversold';
  let crossing = null;
  if (k != null && prevK != null) {
    if (prevK < overbought && k >= overbought) crossing = 'sell';
    else if (prevK > oversold && k <= oversold) crossing = 'buy';
  }
  return { zone, crossing };
}

// 整段 K 线的穿越序列：返回与 k 等长的数组，元素为 'buy' | 'sell' | null（供画布标记）
export function srsiCrossings(kArr, opts = {}) {
  const out = new Array(kArr.length).fill(null);
  for (let i = 0; i < kArr.length; i++) {
    const v = kArr[i];
    if (v == null) continue;
    out[i] = srsiSignal(v, i > 0 ? kArr[i - 1] : null, opts).crossing;
  }
  return out;
}

// K/D 两线交叉 + 带退出 的"钩"信号（用户命名）：
//   deathHook(死钩) = 高位死叉 + 跌破超买线：K 由 ≥超买 跌到 <超买（掉落上限带），且附近 lookback 根内发生过 K 下穿 D 翻转
//   goldHook(金钩) = 低位金叉 + 突破超卖线：K 由 ≤超卖 升到 >超卖（突破下限带），且附近 lookback 根内发生过 K 上穿 D 翻转
// 注意：真实反弹中 K(快) 常先破带再上穿 D（或相反），故钩标记落在"带退出"那根，翻转只要在窗口内（前后皆可）即算。
// 返回与 kArr 等长数组，元素为 null | 'deathHook' | 'goldHook'
export function srsiHooks(kArr, dArr, opts = {}) {
  const overbought = opts.overbought != null ? opts.overbought : 80;
  const oversold = opts.oversold != null ? opts.oversold : 20;
  const lookback = opts.lookback != null ? opts.lookback : 15;
  const n = kArr.length;
  const out = new Array(n).fill(null);
  if (!dArr || dArr.length !== n) return out;
  const deathCross = new Array(n).fill(false);
  const goldCross = new Array(n).fill(false);
  const exitOB = new Array(n).fill(false);   // K 由超买区跌破（掉落上限带）
  const exitOS = new Array(n).fill(false);   // K 由超卖区突破（突破下限带）
  for (let i = 1; i < n; i++) {
    const pk = kArr[i - 1], pd = dArr[i - 1], k = kArr[i], d = dArr[i];
    if (pk == null || pd == null || k == null || d == null) continue;
    if (pk > pd && k <= d) deathCross[i] = true;
    if (pk < pd && k >= d) goldCross[i] = true;
    if (pk >= overbought && k < overbought) exitOB[i] = true;
    if (pk <= oversold && k > oversold) exitOS[i] = true;
  }
  const near = (arr, i) => {
    for (let j = Math.max(1, i - lookback); j <= Math.min(n - 1, i + lookback); j++) if (arr[j]) return true;
    return false;
  };
  for (let i = 1; i < n; i++) {
    if (exitOB[i] && near(deathCross, i)) out[i] = 'deathHook';
    else if (exitOS[i] && near(goldCross, i)) out[i] = 'goldHook';
  }
  return out;
}

// 使用 K 线数据计算真实波动幅度（ATR），返回数组
// klines: [{h, l, c}] 或 {high, low, close}
export function atr(klines, period = 14) {
  const n = klines.length;
  const trs = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const k = klines[i];
    const h = k.h ?? k.high, l = k.l ?? k.low, c = k.c ?? k.close;
    if (h == null || l == null || c == null) continue;
    const pc = i > 0 ? (klines[i - 1].c ?? klines[i - 1].close) : c;
    trs[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  const out = new Array(n).fill(null);
  let sum = 0, cnt = 0;
  for (let i = 0; i < n; i++) {
    if (trs[i] === null) { out[i] = null; continue; }
    if (cnt < period) { sum += trs[i]; cnt++; }
    if (cnt === period) {
      out[i] = sum / period;
      sum -= trs[i - period + 1];
      cnt--;
    }
  }
  return out;
}

// 用收盘价序列近似的波动率（用于无 OHLC 时的自适应）：ATR ≈ EMA(|Δprice|)
export function atrClose(priceSeries, period = 14) {
  const diffs = priceSeries.map((v, i) => i === 0 ? 0 : Math.abs(v - priceSeries[i - 1]));
  return ema(diffs, period);
}

// 根据波动率计算自适应周期：波动大→周期短(反应快)，波动小→周期长(更平滑)
// 使用尾部窗口(最近100个ATR)计算波动率基准，避免整段历史主导
// base=基础周期, minPeriod/maxPeriod=夹取范围, atrArr=ATR序列, priceSeries=价格
export function adaptivePeriod(base, minPeriod, maxPeriod, atrArr, priceSeries, windowSize = 100) {
  const valid = atrArr.filter(v => v !== null && v > 0);
  const cur = atrArr[atrArr.length - 1];
  if (!cur || cur <= 0 || valid.length === 0) return base;
  const trailing = valid.slice(-windowSize);
  const avg = trailing.reduce((a, b) => a + b, 0) / trailing.length;
  const ratio = avg / cur;
  let p = Math.round(base * ratio);
  p = Math.max(minPeriod, Math.min(maxPeriod, p));
  return p;
}

// 逐点自适应 EMA：每个点 i 按其附近窗口的 ATR 波动率计算自适应周期，
// 用随时间变化的平滑系数 alpha=2/(p+1) 因果递推（只依赖 ≤i 的数据，不随渲染重算漂移）。
// 波动大→周期短(紧跟价格)，波动小→周期长(更平滑)。返回 { line, lastPeriod }
export function adaptiveEma(priceSeries, base = 20, minP = 8, maxP = 32, atrPeriod = 14, windowSize = 100) {
  const n = priceSeries.length;
  const atrArr = atrClose(priceSeries, atrPeriod);
  const out = new Array(n).fill(null);
  const recent = [];
  let sum = 0;
  let prev = null;
  let lastP = base;
  for (let i = 0; i < n; i++) {
    const cur = atrArr[i];
    if (cur != null && cur > 0) {
      recent.push(cur);
      sum += cur;
      if (recent.length > windowSize) sum -= recent.shift();
    }
    if (recent.length === 0) continue;
    const avg = sum / recent.length;
    const ratio = avg / (cur != null && cur > 0 ? cur : avg);
    let p = Math.round(base * ratio);
    p = Math.max(minP, Math.min(maxP, p));
    lastP = p;
    const alpha = 2 / (p + 1);
    prev = prev == null ? priceSeries[i] : priceSeries[i] * alpha + prev * (1 - alpha);
    out[i] = prev;
  }
  return { line: out, lastPeriod: lastP };
}

// 自适应指标 AIS：逐点自适应 EMA 线 + 逐点 ATR 通道（波动大→通道宽，波动小→通道窄）
// 返回 { line, upper, lower, period, atrNow }
export function ais(priceSeries, base = 20, minP = 8, maxP = 32, atrPeriod = 14, mult = 2) {
  const atrArr = atrClose(priceSeries, atrPeriod);
  const { line, lastPeriod } = adaptiveEma(priceSeries, base, minP, maxP, atrPeriod);
  const upper = line.map((v, i) => (v === null || atrArr[i] == null ? null : v + mult * atrArr[i]));
  const lower = line.map((v, i) => (v === null || atrArr[i] == null ? null : v - mult * atrArr[i]));
  const atrNow = atrArr[atrArr.length - 1] ?? 0;
  return { line, upper, lower, period: lastPeriod, atrNow };
}

// 自适应 MACD：快慢 EMA 周期随波动率同步缩放
export function aisMacd(data, fastBase = 12, slowBase = 26, signal = 9, atrPeriod = 14) {
  const atrArr = atrClose(data, atrPeriod);
  const fastP = adaptivePeriod(fastBase, 6, 24, atrArr, data);
  const slowP = adaptivePeriod(slowBase, 13, 52, atrArr, data);
  const emaF = ema(data, fastP);
  const emaS = ema(data, slowP);
  const line = data.map((_, i) => (emaF[i] !== null && emaS[i] !== null ? emaF[i] - emaS[i] : null));
  const sig = sma(line.map(v => (v === null ? 0 : v)), signal).map((v, i) => (i >= signal - 1 && line[i] !== null ? v : null));
  const hist = line.map((v, i) => (v !== null && sig[i] !== null ? v - sig[i] : null));
  return { line, signal: sig, hist, fastP, slowP };
}

// ---- 逐点信号序列（可配置信号源 + 去噪） ----

// 信号源定义：每个源对第 i 根K线给出方向贡献（buy/sell 票数，AIS 弱信号 0.5 票）
const SIGNAL_SOURCES = {
  trend: (i, s) => {
    if (s.price[i] > s.ema20[i] && s.ema20[i] > s.ema120[i]) return { buy: 1 };
    if (s.price[i] < s.ema20[i] && s.ema20[i] < s.ema120[i]) return { sell: 1 };
    return null;
  },
  rsi: (i, s) => s.rsi[i] > 50 ? { buy: 1 } : s.rsi[i] < 50 ? { sell: 1 } : null,
  macd: (i, s) => s.macd[i] > s.macdSignal[i] ? { buy: 1 } : s.macd[i] < s.macdSignal[i] ? { sell: 1 } : null,
  srsi: (i, s) => s.srsi[i] > 50 ? { buy: 1 } : s.srsi[i] < 50 ? { sell: 1 } : null,
  ais: (i, s) => {
    if (s.price[i] > s.aisUpper[i]) return { buy: 1 };
    if (s.price[i] < s.aisLower[i]) return { sell: 1 };
    if (s.price[i] > s.aisLine[i]) return { buy: 0.5 };
    return { sell: 0.5 };
  }
};

export const SIGNAL_SOURCE_KEYS = ['trend', 'rsi', 'macd', 'srsi', 'ais'];

// 信号源选择键 → 参与投票的源列表
// 'all' = 全部(等价原 resonanceSeries 行为)；也可传 'ais'/'trend'/... 单源
export function signalSourcesFor(key) {
  if (!key || key === 'all') return SIGNAL_SOURCE_KEYS.slice();
  const arr = Array.isArray(key) ? key : [key];
  return arr.filter(k => SIGNAL_SOURCE_KEYS.indexOf(k) >= 0);
}

/**
 * 逐点信号序列（画布 ▲▼ 标记）— 原 resonanceSeries 的可配置版本。
 *
 * series: { price:[], ema20:[], ema120:[], rsi:[], macd:[]|macdLine:[], macdSignal:[],
 *           srsi:[], aisUpper:[], aisLower:[], aisLine:[] }
 *
 * opts:
 *   sources    参与投票的信号源数组（默认全部 5 源）
 *   minVotes   最低票数（默认 3）。对单源会自动钳制到该源最大票(1 或 1.5)，
 *              避免"只看 AIS 时永远达不到 3 票"——AIS 单源下只有突破通道(1 票)才出信号。
 *   confirmBars 确认K线数（默认 0）。>0 时信号需持续 confirmBars+1 根K线才输出，
 *              过滤价格在 AIS/EMA 附近反复穿越造成的假信号。
 *
 * 返回与 price 等长的数组，元素为 'buy' | 'sell' | null
 */
export function signalSeries(series, opts = {}) {
  const n = series.price.length;
  const srcs = signalSourcesFor(opts.sources);
  if (!srcs.length) return new Array(n).fill(null);
  const raw = new Array(n).fill(null);
  // 参与源里的 AIS 允许弱票 0.5(在线内时) 与强票 1(突破通道) → 单源最大票 1
  const maxVotes = srcs.length;
  const effMin = Math.max(1, Math.min(opts.minVotes == null ? 3 : opts.minVotes, maxVotes));
  for (let i = 0; i < n; i++) {
    const s = series;
    let ok = s.price[i] != null;
    if (ok) for (const k of srcs) {
      if (k === 'trend' && (s.ema20[i] == null || s.ema120[i] == null)) { ok = false; break; }
      if (k === 'rsi' && s.rsi[i] == null) { ok = false; break; }
      if (k === 'macd' && (s.macd[i] == null || s.macdSignal[i] == null)) { ok = false; break; }
      if (k === 'srsi' && s.srsi[i] == null) { ok = false; break; }
      if (k === 'ais' && (s.aisUpper[i] == null || s.aisLower[i] == null || s.aisLine[i] == null)) { ok = false; break; }
    }
    if (!ok) continue;
    let buy = 0, sell = 0;
    for (const k of srcs) {
      const v = SIGNAL_SOURCES[k](i, s);
      if (v) { buy += v.buy || 0; sell += v.sell || 0; }
    }
    if (buy >= effMin && buy > sell) raw[i] = 'buy';
    else if (sell >= effMin && sell > buy) raw[i] = 'sell';
  }
  const confirm = Math.max(0, opts.confirmBars || 0);
  if (!confirm) return raw;
  const out = new Array(n).fill(null);
  let last = null, run = 0;
  for (let i = 0; i < n; i++) {
    const r = raw[i];
    if (r === last) run++; else run = 1;
    last = r;
    if (r && run > confirm) out[i] = r;
  }
  return out;
}

// 逐点共振序列：对整段历史计算每个时刻的买入/卖出判定，供画布绘制 ▲▼ 标记
// 等价于 signalSeries(series, { sources:'all', minVotes:3, confirmBars:0 })，保持旧调用兼容。
// series: { price:[], ema20:[], ema120:[], rsi:[], macd:[], macdSignal:[], srsi:[], aisUpper:[], aisLower:[], aisLine:[] }
export function resonanceSeries(series) {
  return signalSeries(series, { sources: 'all', minVotes: 3, confirmBars: 0 });
}

// 共振信号判定：基于一组指标的当前值
// indicators: { price, ema20, ema120, rsi, macd, macdSignal, macdHist, srsi, aisLine, aisUpper, aisLower, aisPeriod, rsiPeriod, srsiPeriod, macdFast, macdSlow }
// 返回 { buy, sell, strength, conditions }
export function resonance(ind) {
  const c = [];
  let buyScore = 0, sellScore = 0;

  // 1. 趋势排列
  if (ind.price > ind.ema20 && ind.ema20 > ind.ema120) { c.push({ n: '趋势多', d: '价>EMA20>EMA120', side: 'buy' }); buyScore++; }
  else if (ind.price < ind.ema20 && ind.ema20 < ind.ema120) { c.push({ n: '趋势空', d: '价<EMA20<EMA120', side: 'sell' }); sellScore++; }

  // 2. RSI
  if (ind.rsi > 50) { c.push({ n: 'RSI偏多', d: 'RSI>50', side: 'buy' }); buyScore++; }
  else if (ind.rsi < 50) { c.push({ n: 'RSI偏空', d: 'RSI<50', side: 'sell' }); sellScore++; }

  // 3. MACD 金叉/死叉
  if (ind.macd > ind.macdSignal) { c.push({ n: 'MACD多头', d: 'MACD>Signal', side: 'buy' }); buyScore++; }
  else if (ind.macd < ind.macdSignal) { c.push({ n: 'MACD空头', d: 'MACD<Signal', side: 'sell' }); sellScore++; }

  // 4. SRSI 超买/超卖回归
  if (ind.srsi > 50) { c.push({ n: 'SRSI偏多', d: 'SRSI>50', side: 'buy' }); buyScore++; }
  else if (ind.srsi < 50) { c.push({ n: 'SRSI偏空', d: 'SRSI<50', side: 'sell' }); sellScore++; }

  // 5. AIS 通道方向
  if (ind.price > ind.aisUpper) { c.push({ n: 'AIS强势', d: '价>AIS上轨', side: 'buy' }); buyScore++; }
  else if (ind.price < ind.aisLower) { c.push({ n: 'AIS弱势', d: '价<AIS下轨', side: 'sell' }); sellScore++; }
  else if (ind.price > ind.aisLine) { c.push({ n: 'AIS偏多', d: '价>AIS线', side: 'buy' }); buyScore += 0.5; }
  else { c.push({ n: 'AIS偏空', d: '价<AIS线', side: 'sell' }); sellScore += 0.5; }

  const buy = buyScore >= 3;
  const sell = sellScore >= 3;
  let strength = 'weak';
  if (buy && buyScore >= 4.5) strength = 'strong';
  else if (sell && sellScore >= 4.5) strength = 'strong';
  else if (buy || sell) strength = 'medium';

  return {
    buy, sell, strength,
    buyScore, sellScore,
    conditions: c
  };
}

// ---- 信号回测 / 市场情境（供技术分析页“胜率叠加”与“情境过滤”使用）----

// 单点信号置信度(1-3)：统计该 bar 上多/空方条件得分，方向一致则越高
function convAt(series, i, side) {
  const s = series;
  let score = 0;
  if (s.price[i] != null && s.ema20[i] != null && s.ema120[i] != null) {
    if (s.price[i] > s.ema20[i] && s.ema20[i] > s.ema120[i]) score++;
    else if (s.price[i] < s.ema20[i] && s.ema20[i] < s.ema120[i]) score--;
  }
  if (s.rsi[i] != null) score += s.rsi[i] > 50 ? 1 : s.rsi[i] < 50 ? -1 : 0;
  if (s.macd[i] != null && s.macdSignal[i] != null) score += s.macd[i] > s.macdSignal[i] ? 1 : s.macd[i] < s.macdSignal[i] ? -1 : 0;
  if (s.srsi[i] != null) score += s.srsi[i] > 50 ? 1 : s.srsi[i] < 50 ? -1 : 0;
  if (s.aisUpper[i] != null) {
    if (s.price[i] > s.aisUpper[i]) score++;
    else if (s.price[i] < s.aisLower[i]) score--;
    else if (s.price[i] > s.aisLine[i]) score += 0.5;
    else score -= 0.5;
  }
  const aligned = side === 'buy' ? score : -score;
  if (aligned >= 4.5) return 3;
  if (aligned >= 3.5) return 2;
  return 1;
}

// 信号回测：对整段历史回测共振信号的“下一波 1×ATR 先到”胜率。
// series 结构与 resonanceSeries 相同；targetAtr=目标波幅倍数, horizon=最多向后看的 bar 数。
// 返回 { marks:[{i,side,win(boolean|null),conv}], stats:{total,wins,unresolved,winRate,buy,sell} }
export function signalBacktest(series_, { targetAtr = THRESH.BT_TARGET_ATR, horizon = THRESH.BT_HORIZON, signals = null } = {}) {
  const s = series_;
  const norm = {
    price: s.price,
    ema20: s.ema20, ema120: s.ema120,
    rsi: s.rsi,
    macd: s.macd || s.macdLine,
    macdSignal: s.macdSignal,
    srsi: s.srsi,
    aisUpper: s.aisUpper, aisLower: s.aisLower, aisLine: s.aisLine
  };
  // 传入 signals（signalSeries 过滤后的序列）时按过滤信号回测，保证图与胜率一致
  const res = signals || resonanceSeries(norm);
  const n = res.length;
  const price = s.price || [];
  const atrArr = atrClose(price, 14);
  const marks = [];
  let last = null;
  for (let i = 0; i < n; i++) {
    const r = res[i];
    if (r && r !== last) {
      const p = price[i];
      // P1-3: 无真实 ATR 时不再用 p×0.002 造假兜底 → 该样本 win=null(不计入, 不回测污染)
      const atr = atrArr[i] || atrArr[n - 1] || 0;
      let win = null;
      if (atr > 0 && isFinite(atr) && p > 0) {
        const t = atr * targetAtr;
        const lim = Math.min(n, i + horizon);
        for (let j = i + 1; j < lim; j++) {
          const pj = price[j];
          if (pj == null || !isFinite(pj)) continue;
          if (r === 'buy' && pj >= p + t) { win = true; break; }
          if (r === 'buy' && pj <= p - t) { win = false; break; }
          if (r === 'sell' && pj <= p - t) { win = true; break; }
          if (r === 'sell' && pj >= p + t) { win = false; break; }
        }
      }
      marks.push({ i, side: r, win, conv: convAt(norm, i, r) });
    }
    last = r;
  }
  const stats = {
    total: 0, wins: 0, unresolved: 0, winRate: null,
    buy: { wins: 0, losses: 0, winRate: null },
    sell: { wins: 0, losses: 0, winRate: null }
  };
  marks.forEach(m => {
    if (m.win == null) { stats.unresolved++; return; }
    stats.total++;
    if (m.win) stats.wins++;
    const k = m.side;
    if (m.win) stats[k].wins++; else stats[k].losses++;
  });
  const rate = (s) => (s.wins + s.losses) ? s.wins / (s.wins + s.losses) : null;
  stats.winRate = stats.total ? stats.wins / stats.total : null;
  stats.buy.winRate = rate(stats.buy);
  stats.sell.winRate = rate(stats.sell);
  return { marks, stats, targetAtr, horizon };
}

// 前向回测胜率(walk-forward): 避免样本内回测污染实盘权重。
// 对每个信号点 i, 只用 i 之前(lag 之前)的已完成样本统计胜率, 再用于 i 之后的新样本。
// 这是"滞后样本内评估"——只有 lag 之前的胜负已定, 与实时信号发生时刻对齐, 不会偷看未来。
export function walkForwardWinRate(series_, { targetAtr = THRESH.BT_TARGET_ATR, horizon = THRESH.BT_HORIZON, lag = 0 } = {}) {
  if (!series_ || !series_.price || !series_.price.length) return { marks: [], stats: null, buy: null, sell: null };
  const bt = signalBacktest(series_, { targetAtr, horizon });
  const marks = bt.marks || [];
  const cut = marks.length - lag; // 只统计前 cut 个信号(在 lag 之前的)
  const stats = { total: 0, wins: 0, unresolved: 0, winRate: null, buy: { wins: 0, losses: 0, winRate: null }, sell: { wins: 0, losses: 0, winRate: null } };
  for (let k = 0; k < Math.max(0, cut); k++) {
    const m = marks[k];
    if (m.win == null) { stats.unresolved++; continue; }
    stats.total++;
    if (m.win) stats.wins++;
    const s = m.side;
    if (m.win) stats[s].wins++; else stats[s].losses++;
  }
  stats.winRate = stats.total ? stats.wins / stats.total : null;
  const rate = (s) => (s.wins + s.losses) ? s.wins / (s.wins + s.losses) : null;
  stats.buy.winRate = rate(stats.buy);
  stats.sell.winRate = rate(stats.sell);
  return { marks, stats, buy: { winRate: stats.buy.winRate, wins: stats.buy.wins, losses: stats.buy.losses }, sell: { winRate: stats.sell.winRate, wins: stats.sell.wins, losses: stats.sell.losses } };
}

// 方向感知 · ATR 止盈/止损判盈亏（纪律分析因子消融回测用，与 signalBacktest 同构但不绑定共振信号）：
//   入场 = 指定 entryIdx 方向开仓；沿后扫描，+tpAtr×ATR 先到 → win(+1)，-slAtr×ATR 先到 → lose(-1)，
//   horizon 内都没触发 → null(不分胜负, 不计入样本)。
// 输入: opts = { entryIdx, direction:'buy'|'sell', tpAtr=2, slAtr=1.5, horizon }
// 返回: { win: 1|-1|null, pnlPct, barsHeld, exitDir }（pnlPct 按相对入场价百分比, barsHeld=触发的K线数）
export function winLossByAtr(price, atrArr, opts = {}) {
  const { entryIdx = 0, direction = 'buy', tpAtr = THRESH.BT_TP_ATR, slAtr = THRESH.BT_SL_ATR, horizon = THRESH.BT_HORIZON } = opts;
  if (!Array.isArray(price) || price.length === 0) return { win: null, pnlPct: 0, barsHeld: 0, exitDir: null };
  const p = price[entryIdx];
  const atr = atrArr && atrArr[entryIdx];
  if (p == null || !isFinite(p) || p <= 0 || atr == null || !isFinite(atr) || atr <= 0) return { win: null, pnlPct: 0, barsHeld: 0, exitDir: null };
  const up = atr * tpAtr;
  const dn = atr * slAtr;
  const lim = Math.min(price.length, entryIdx + 1 + horizon);
  for (let j = entryIdx + 1; j < lim; j++) {
    const pj = price[j];
    if (pj == null || !isFinite(pj)) continue;
    if (direction === 'buy') {
      if (pj >= p + up) return { win: 1, pnlPct: (pj - p) / p * 100, barsHeld: j - entryIdx, exitDir: 'tp' };
      if (pj <= p - dn) return { win: -1, pnlPct: (pj - p) / p * 100, barsHeld: j - entryIdx, exitDir: 'sl' };
    } else {
      if (pj <= p - up) return { win: 1, pnlPct: (p - pj) / p * 100, barsHeld: j - entryIdx, exitDir: 'tp' };
      if (pj >= p + dn) return { win: -1, pnlPct: (p - pj) / p * 100, barsHeld: j - entryIdx, exitDir: 'sl' };
    }
  }
  return { win: null, pnlPct: 0, barsHeld: 0, exitDir: null };
}

// 市场情境(regime)：趋势/震荡 + 波动扩张/收缩。
// 依据 AIS 线斜率与价格位置 + ATR 状态。返回 { type, label, slopePct, atrState }
export function detectRegime(series, lookback = 60) {
  const n = series.price.length;
  const line = series.aisLine;
  const price = series.price;
  if (n < 30) return { type: 'unknown', label: '数据不足', slopePct: 0, atrState: 'unknown' };
  const i = n - 1;
  const j = Math.max(0, i - lookback);
  const cur = line[i], prev = line[j];
  let slopePct = 0;
  if (cur != null && prev != null && prev > 0) slopePct = (cur - prev) / prev * 100;
  const atrArr = atrClose(price, 14);
  const atrNow = atrArr[i] || 0;
  const valid = [];
  atrArr.forEach(v => { if (v != null && v > 0) valid.push(v); });
  const avg = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : atrNow;
  const atrState = atrNow > avg * 1.25 ? '扩张' : atrNow < avg * 0.75 ? '收缩' : '平稳';
  const above = price[i] != null && line[i] != null ? price[i] > line[i] : null;
  let type, label;
  if (Math.abs(slopePct) < THRESH.REGIME_DEAD_SLOPE_PCT) { type = 'range'; label = '震荡市（横盘）'; }
  else if (slopePct > 0 && above) { type = 'trend-up'; label = '多头趋势 ↑'; }
  else if (slopePct < 0 && above === false) { type = 'trend-down'; label = '空头趋势 ↓'; }
  else if (slopePct > 0) { type = 'pullback-up'; label = '上涨中回调'; }
  else { type = 'pullback-down'; label = '下跌中反弹'; }
  return { type, label, slopePct, atrState };
}

// 市场情境连续化(供参数自适应引擎使用)：输出方向/强度/波动率等连续量。
// 死区斜率随 ATR% 中位数自适应(波动越大, 死区越大, 避免把噪声当趋势)。
// series: { price, aisLine }（与 detectRegime 同结构）
// opts.pctHis: ATR% 历史数组(如 S.ai.atrSuper[sym]['1t'].pctHis), 用于波动率/死区
// 返回 { type, direction(-1|0|1), strength(0~1), volatility(0~1), atrState,
//        stability(0~1), deadZone(%), label, slopePct }
export function detectRegimeState(series, opts = {}) {
  const n = series && series.price ? series.price.length : 0;
  const line = series && series.aisLine;
  const price = series && series.price;
  if (n < 30) return { type: 'unknown', direction: 0, strength: 0, volatility: 0.5, atrState: 'unknown', stability: 0, deadZone: THRESH.REGIME_DEAD_SLOPE_PCT, label: '数据不足', slopePct: 0 };
  const pctHis = opts.pctHis;
  let medPct = null;
  if (pctHis && pctHis.length) {
    const s = [...pctHis].filter(v => typeof v === 'number' && isFinite(v) && v > 0).sort((a, b) => a - b);
    if (s.length) medPct = s[Math.floor(s.length / 2)];
  }
  let curPct = null;
  if (pctHis && pctHis.length) {
    const lastPct = pctHis[pctHis.length - 1];
    if (typeof lastPct === 'number' && isFinite(lastPct) && lastPct > 0) curPct = lastPct;
  }
  // 死区自适应: max(0.1%, ATR%中位数×0.5)。无 pctHis 时回退固定值。
  const deadZone = medPct != null ? Math.max(THRESH.REGIME_DEAD_MIN_PCT, medPct * THRESH.REGIME_DEAD_ATR_MULT) : THRESH.REGIME_DEAD_SLOPE_PCT;
  const i = n - 1;
  const j = Math.max(0, i - (opts.lookback || 60));
  const cur = line[i], prev = line[j];
  let slopePct = 0;
  if (cur != null && prev != null && prev > 0) slopePct = (cur - prev) / prev * 100;
  const above = price[i] != null && line[i] != null ? price[i] > line[i] : null;
  let type, label;
  if (Math.abs(slopePct) < deadZone) { type = 'range'; label = '震荡市（横盘）'; }
  else if (slopePct > 0 && above) { type = 'trend-up'; label = '多头趋势 ↑'; }
  else if (slopePct < 0 && above === false) { type = 'trend-down'; label = '空头趋势 ↓'; }
  else if (slopePct > 0) { type = 'pullback-up'; label = '上涨中回调'; }
  else { type = 'pullback-down'; label = '下跌中反弹'; }
  const direction = type === 'trend-up' || type === 'pullback-up' ? 1 : (type === 'trend-down' || type === 'pullback-down' ? -1 : 0);
  // 强度: |slope%| 相对死区的倍数, 6×死区封顶=满强度(波动自适应)
  const strength = deadZone > 0 ? Math.min(1, Math.max(0, Math.abs(slopePct) / (deadZone * THRESH.REGIME_STRENGTH_MULT))) : 0;
  // 波动率: 当前 ATR% 相对中位数, [0.5x, 2x] 映射到 [0,1]; 无数据默认 0.5
  let volatility = 0.5;
  if (curPct != null && medPct != null && medPct > 0) {
    const ratio = curPct / medPct;
    volatility = Math.min(1, Math.max(0, (ratio - 0.5) / 1.5));
  }
  const atrState = curPct != null && medPct != null && medPct > 0 ? (curPct > medPct * 1.25 ? '扩张' : curPct < medPct * 0.75 ? '收缩' : '平稳') : 'unknown';
  // 稳定性: 1 - |cur/med - 1| 钳制 [0,1]
  let stability = 0.5;
  if (curPct != null && medPct != null && medPct > 0) stability = Math.min(1, Math.max(0, 1 - Math.abs(curPct / medPct - 1)));
  return { type, direction, strength, volatility, atrState, stability, deadZone, label, slopePct };
}

// 中期方向门（顺势回调模式）：依据 1m 收盘序列的 AIS 斜率+价格位置判断趋势方向。
// 返回 { gate: 'long'|'short'|'none'|'unknown', label, slopePct }
export function trendGate(closes1m, lookback = 60) {  if (!closes1m || closes1m.length < 30) return { gate: 'unknown', label: '1m数据不足', slopePct: 0 };
  const a = ais(closes1m, 20, 8, 32, 14, 2);
  const i = closes1m.length - 1;
  const j = Math.max(0, i - lookback);
  const cur = a.line[i], prev = a.line[j];
  let slopePct = 0;
  if (cur != null && prev != null && prev > 0) slopePct = (cur - prev) / prev * 100;
  const above = closes1m[i] != null && a.line[i] != null ? closes1m[i] > a.line[i] : null;
  let gate, label;
  if (Math.abs(slopePct) < THRESH.REGIME_DEAD_SLOPE_PCT) { gate = 'none'; label = '中期横盘'; }
  else if (slopePct > 0 && above) { gate = 'long'; label = '中期多头 ↑'; }
  else if (slopePct < 0 && above === false) { gate = 'short'; label = '中期空头 ↓'; }
  else if (slopePct > 0) { gate = 'long'; label = '中期上涨(回调中)'; }
  else { gate = 'short'; label = '中期下跌(反弹中)'; }
  return { gate, label, slopePct };
}

// 顺势回调入场检测（1t）：在方向门内，价格回踩 AIS 线/EMA20 支撑并出现反转确认。
// 返回 { ready, buy, sell, pulled, confirm, label }
export function pullbackEntry(series, gate) {
  if (!series || series.price.length < 30) return { ready: false, buy: false, sell: false, label: '数据不足' };
  const i = series.price.length - 1;
  const price = series.price[i];
  const e20 = series.ema20 && series.ema20[i];
  const aisL = series.aisLine && series.aisLine[i];
  const mh = series.macdHist || [];
  const sr = series.srsi || [];
  // 真实 ATR 缺失时不再用 price*0.001 造假兜底(修复: 假值污染回调判定) → 直接判定不可用
  const atr = series.atr;
  if (atr == null || !isFinite(atr) || atr <= 0) return { ready: false, buy: false, sell: false, label: '无ATR' };
  if (price == null || e20 == null || aisL == null) return { ready: false, buy: false, sell: false, label: '指标不全' };
  const tol = Math.max(0.5 * atr, price * 0.001);
  const nearLine = Math.abs(price - aisL) <= tol;
  const nearEma = Math.abs(price - e20) <= tol;
  const mhNow = mh[i], mhPrev = mh[i - 1];
  const srNow = sr[i], srPrev = sr[i - 1];
  const macdUp = mhNow != null && mhPrev != null && mhNow > mhPrev;
  const macdDn = mhNow != null && mhPrev != null && mhNow < mhPrev;
  const srRise = srNow != null && srPrev != null && srNow > srPrev && srNow < 50;
  const srFall = srNow != null && srPrev != null && srNow < srPrev && srNow > 50;
  if (gate === 'long') {
    const pulled = nearLine || nearEma || price < e20;
    const confirm = macdUp || srRise || price > e20;
    return { ready: pulled && confirm, buy: pulled && confirm, sell: false, pulled, confirm, label: '顺势回调做多' };
  }
  if (gate === 'short') {
    const pulled = nearLine || nearEma || price > e20;
    const confirm = macdDn || srFall || price < e20;
    return { ready: pulled && confirm, buy: false, sell: pulled && confirm, pulled, confirm, label: '顺势回调做空' };
  }
  return { ready: false, buy: false, sell: false, pulled: false, confirm: false, label: '无方向门' };
}

// ===== 信号方向分类(供 AI 学习去噪/回测对齐) =====
// 显式方向信号: long/short; 上下文信号(回测验证/多周期确认/顺势回调/持仓量)返回 null,
// 由调用方按当前持仓/交易方向归类(它们总是与触发分支方向一致)。
export const SIG_DIR = {
  '超跌': 'long', '负费率': 'long', '鲸鱼转入': 'long', '急跌': 'long', '共振买入': 'long',
  '短线多头': 'long', '站上AIS': 'long', 'SRSI超卖': 'long', 'MACD多头': 'long', 'LLM做多': 'long',
  '量价底背离': 'long', '触及支撑': 'long', '三层共振多': 'long', '新闻利好': 'long',
  '超涨': 'short', '正费率': 'short', '鲸鱼转出': 'short', '急涨': 'short', '共振卖出': 'short',
  '短线空头': 'short', '跌破AIS': 'short', 'SRSI超买': 'short', 'MACD空头': 'short', 'LLM做空': 'short',
  '量价顶背离': 'short', '触及阻力': 'short', '三层共振空': 'short', '新闻利空': 'short'
};

// 新闻情绪分析: 基于关键词打分的启发式情绪判断
// items: [{title, desc, category}] 从 RSS 解析的新闻条目
// 返回 {score, bullishCount, bearishCount, net, sentiment}
export function newsSentiment(items) {
  const bullishWords = ['surge', 'rally', 'bullish', 'upgrade', 'partnership', 'adoption',
    'breakthrough', 'approval', 'inflow', 'buy', 'launch', 'high', 'gain', 'positive',
    'growth', 'boom', 'outperform', 'record', 'strong', 'opportunity'];
  const bearishWords = ['hack', 'crash', 'ban', 'restrict', 'sell-off', 'decline', 'bearish',
    'fraud', 'outflow', 'downgrade', 'regulation', 'loss', 'drop', 'negative', 'fear',
    'panic', 'warning', 'risk', 'slowdown', 'low', 'weak'];
  if (!items || !items.length) return { score: 0, bullishCount: 0, bearishCount: 0, net: 0, sentiment: 'neutral' };
  let bull = 0, bear = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const text = ((item.title || '') + ' ' + (item.desc || '') + ' ' + ((item.category || []).join(' ') || '')).toLowerCase();
    for (let j = 0; j < bullishWords.length; j++) {
      if (text.indexOf(bullishWords[j]) >= 0) { bull++; break; }
    }
    for (let j = 0; j < bearishWords.length; j++) {
      if (text.indexOf(bearishWords[j]) >= 0) { bear++; break; }
    }
  }
  const net = bull - bear;
  const sentiment = net >= 2 ? 'bullish' : net <= -2 ? 'bearish' : 'neutral';
  return { score: net, bullishCount: bull, bearishCount: bear, net, sentiment };
}

export function signalSide(name) {
  return SIG_DIR[name] || null;
}

// 只保留与交易方向一致的信号(上下文信号恒保留, 由方向决定其归属)
export function filterSignalsBySide(arr, side) {
  if (!arr) return [];
  if (side !== 'long' && side !== 'short') return [];
  return arr.filter(function (n) {
    const d = SIG_DIR[n];
    return d ? d === side : true;
  });
}

// 方向门抑制因子: 随 1m 斜率幅度连续变化(斜率越大趋势越强→逆势越被压制)
// 弱趋势(slope≈0.15%)→约0.78 轻抑; 强趋势(slope≥1.5%)→0.15 近禁。替代原硬清零 ss/ls=0。
export function gateKeepFactor(slopePct) {
  const k = THRESH.GATE_KEEP_BASE - Math.abs(slopePct || 0) * THRESH.GATE_KEEP_SLOPE;
  return Math.max(THRESH.GATE_KEEP_MIN, Math.min(THRESH.GATE_KEEP_MAX, k));
}

// Binance 多空账户比接口(globalLongShortAccountRatio/topLongShortAccountRatio)返回的
// longAccount/shortAccount 为 0~1 的小数(0.5399 = 53.99% 多头), 非百分比。
// 归一化为 0~100 的百分比; 若已是百分比(>1)则不作变换(容错)。
export function normLongRatio(v) {
  let lp = parseFloat(v && v.longAccount);
  if (lp > 0 && lp <= 1) lp *= 100;
  return lp || 50;
}

// ===== ATR 监督机制(五层防护) =====
// 防止交易系统全依赖信任一个错误的 ATR 值(坏数据/异常跳变/时钟异常等导致)。
// 纯函数, 无 DOM/全局依赖, 可单测。
//
// history: { prev:{atr,t}, median(atrPct%), alerts:[] } —— 由调用方(legacy.js)维护的监督状态
// atrPct 计算方法: atr/价格*100
//
// 返回 { atr, state, alert, atrPct }
//   state: 'ok' | 'clamped'(合理性钳制) | 'replaced'(突变复用) | 'fallback'(降级回退)
//   atr: 监督后的最终 atr(价格绝对单位), 供止损/超时/交易计划使用
export function superviseATR(atrNow, price, atrPct, history, opts = {}) {
  const DEFAULT_PCT = THRESH.ATR_DEFAULT_PCT;            // 无历史时的兜底波动率(价格百分比)
  const PCT_MIN = THRESH.ATR_PCT_MIN, PCT_MAX = THRESH.ATR_PCT_MAX;  // ATR% 合理范围
  const SPIKE_RATIO = opts.spikeRatio || THRESH.ATR_SPIKE_RATIO;      // 突变阈值(当前/上次)
  const MED_DEV = opts.medDev || THRESH.ATR_MED_DEV;              // 偏离中位数阈值
  const hist = history || {};

  const out = { atr: null, state: 'fallback', alert: null, atrPct: null, valid: false };

  // ---- 度量工具: 由 atrPct 反算 atr ----
  const atrFromPct = pct => (price > 0 && isFinite(price)) ? pct * price / 100 : 0;

  // ---- 取历史回退值(优先上次有效, 其次中位数, 最后默认) ----
  function fallbackValue(reason) {
    let atr = null, state = 'fallback', note = reason;
    if (hist.prev && hist.prev.atr > 0) {
      atr = hist.prev.atr;
      note = reason + '(使用上次有效值)';
    } else if (hist.median > 0) {
      atr = atrFromPct(hist.median);
      note = reason + '(使用中位数' + hist.median.toFixed(2) + '%)';
    } else {
      atr = atrFromPct(DEFAULT_PCT);
      note = reason + '(使用默认值' + DEFAULT_PCT + '%)';
    }
    out.atr = atr;
    out.alert = note;
    out.atrPct = price > 0 ? atr / price * 100 : null;
    return out;
  }

  // ---- Layer 1: 输入校验 ----
  const badInput = !atrNow || !isFinite(atrNow) || atrNow <= 0 ||
                   !price || !isFinite(price) || price <= 0;
  if (badInput) {
    out.valid = false;
    return fallbackValue('ATR输入无效');
  }

  const curPct = (atrNow / price) * 100;
  out.valid = true;

  // ---- Layer 2: 合理范围钳制(ATR% 超出物理合理区间 → 视为数据错误) ----
  if (curPct < PCT_MIN || curPct > PCT_MAX) {
    out.state = 'clamped';
    const median = hist.median > 0 ? hist.median : DEFAULT_PCT;
    out.atr = atrFromPct(median);
    out.alert = 'ATR%超出合理范围(' + curPct.toFixed(2) + '%<' + PCT_MIN + '或>' + PCT_MAX + '), 钳制到中位数' + median.toFixed(2) + '%';
    out.atrPct = price > 0 ? out.atr / price * 100 : null;
    return out;
  }

  // ---- Layer 3: 变化率看门狗(单帧突变 >阈值 → 复用上次) ----
  if (hist.prev && hist.prev.atr > 0) {
    const ratio = atrNow / hist.prev.atr;
    if (ratio > SPIKE_RATIO || ratio < 1 / SPIKE_RATIO) {
      out.state = 'replaced';
      out.atr = hist.prev.atr;
      out.alert = 'ATR突变(' + ratio.toFixed(2) + 'x), 复用上次有效值';
      out.atrPct = price > 0 ? out.atr / price * 100 : null;
      return out;
    }
  }

  // ---- Layer 4: 中位数偏离预警(单帧偏离中位数>阈值 → 记预警但保留当前值) ----
  out.atr = atrNow;
  out.atrPct = curPct;
  out.state = 'ok';
  if (hist.median > 0) {
    const medRatio = curPct / hist.median;
    if (medRatio > MED_DEV || medRatio < 1 / MED_DEV) {
      out.alert = 'ATR偏离中位数' + medRatio.toFixed(2) + 'x(中位数' + hist.median.toFixed(2) + '%->当前' + curPct.toFixed(2) + '%), 仅预警';
    }
  }
  return out;
}

// 由 ATR% 计算 ATR 绝对值: pctAsFraction (如 0.5 表示 0.5%)
export function atrFromPct(price, pctAsNumber) {
  if (!price || !isFinite(price) || price <= 0 || !pctAsNumber || !isFinite(pctAsNumber)) return null;
  return (pctAsNumber / 100) * price;
}

// ---- 多周期涨跌计算 (数据融合页第1卡) ----
// 输入: klinesMap = { tf: [[openTime,o,h,l,c,vol,...], ...] } (Binance klines 数组, c 在 idx4)
//       每个 tf 至少需要 ago+1 根。7d/30d 由日线 limit=31 逐根回推。
// 输出: { pct:{tf:percent|null}, long:count, short:count, flat:count, overall:'long'|'short'|'flat', price:最新收盘 }
export function computeTFChanges(klinesMap, { agoMap, flatEps = 0.05 } = {}) {
  const DEFAULT_AGO = { '5m': 1, '15m': 1, '30m': 1, '1h': 1, '4h': 1, '8h': 1, '1d': 1, '7d': 7, '30d': 30 };
  const ago = agoMap || DEFAULT_AGO;
  const pct = {};
  let long = 0, short = 0, flat = 0, price = null;
  Object.keys(klinesMap || {}).forEach(tf => {
    const kl = klinesMap[tf];
    if (!Array.isArray(kl) || kl.length === 0) { pct[tf] = null; return; }
    const closes = kl.map(k => parseFloat(k[4] || k.close));
    const lastClose = closes[closes.length - 1];
    if (!(lastClose > 0) || !isFinite(lastClose)) { pct[tf] = null; return; }
    if (price === null) price = lastClose;
    const a = (ago[tf] != null ? ago[tf] : 1);
    if (closes.length <= a) { pct[tf] = null; return; }
    const prev = closes[closes.length - 1 - a];
    if (!(prev > 0) || !isFinite(prev)) { pct[tf] = null; return; }
    const chg = (lastClose - prev) / prev * 100;
    pct[tf] = chg;
    if (chg > flatEps) long++;
    else if (chg < -flatEps) short++;
    else flat++;
  });
  return { pct, long, short, flat, overall: long > short ? 'long' : short > long ? 'short' : 'flat', price };
}

// ===== 量价背离检测 =====
// 经典顶背离: 价格创新高但成交量未创新高(萎缩) → 上涨动能衰竭 → bear=true(做空信号)
// 经典底背离: 价格创新低但成交量未创新低(萎缩) → 下跌动能衰竭 → bull=true(做多信号)
// 将窗口分为前后两半, 比较价格极值与对应成交量极值。
// price: 价格序列, vol: 成交量序列, win: 总窗口长度(自动均分两半)
// 返回 { bull, bear, pct }  pct=成交量变化%(后半均值 vs 前半均值)
export function volumeDivergence(price, vol, win = 20) {
  if (!Array.isArray(price) || !Array.isArray(vol)) return { bull: false, bear: false, pct: null };
  const n = Math.min(price.length, vol.length);
  if (n < 10) return { bull: false, bear: false, pct: null };
  const half = Math.max(3, Math.floor(win / 2));
  if (n < half * 2) return { bull: false, bear: false, pct: null };
  const a0 = n - half * 2, a1 = n - half, b1 = n - 1;
  // 前半段[a0, a1) 后半段[a1, b1]
  let pMaxOld = -Infinity, pMinOld = Infinity, vMaxOld = 0, vMinOld = Infinity, vSumOld = 0;
  let pMaxNew = -Infinity, pMinNew = Infinity, vMaxNew = 0, vMinNew = Infinity, vSumNew = 0;
  const valid = v => v != null && isFinite(v) && v > 0;
  for (let i = a0; i < a1; i++) {
    if (!valid(price[i]) || !valid(vol[i])) continue;
    if (price[i] > pMaxOld) { pMaxOld = price[i]; vMaxOld = vol[i]; }
    if (price[i] < pMinOld) { pMinOld = price[i]; vMinOld = vol[i]; }
    vSumOld += vol[i];
  }
  for (let i = a1; i <= b1; i++) {
    if (!valid(price[i]) || !valid(vol[i])) continue;
    if (price[i] > pMaxNew) { pMaxNew = price[i]; vMaxNew = vol[i]; }
    if (price[i] < pMinNew) { pMinNew = price[i]; vMinNew = vol[i]; }
    vSumNew += vol[i];
  }
  if (!isFinite(pMaxOld) || !isFinite(pMaxNew)) return { bull: false, bear: false, pct: null };
  const bear = pMaxNew > pMaxOld && vMaxNew < vMaxOld;
  const bull = pMinNew < pMinOld && vMinNew < vMinOld;
  const avgOld = vSumOld / half, avgNew = vSumNew / half;
  const pct = avgOld > 0 ? (avgNew - avgOld) / avgOld * 100 : null;
  return { bull, bear, pct };
}

// ===== 支撑/阻力位检测 =====
// 在近 lookback 根 K 线中用枢轴点(局部极值)检测最近支撑(下方最高)与阻力(上方最低)。
// series: 价格序列数组, lookback: 搜索窗口。
// 返回 { sup(最近支撑价格), res(最近阻力价格), supDistPct(距支撑%), resDistPct(距阻力%) }
export function supportResistance(series, lookback = 40) {
  if (!Array.isArray(series) || series.length < 5) return { sup: null, res: null, supDistPct: null, resDistPct: null };
  const n = series.length;
  const price = series[n - 1];
  if (!isFinite(price) || price <= 0) return { sup: null, res: null, supDistPct: null, resDistPct: null };
  const from = Math.max(0, n - lookback);
  let sup = null, res = null;
  for (let i = from + 1; i < n - 1; i++) {
    const l = series[i - 1], c = series[i], r = series[i + 1];
    if (l == null || c == null || r == null) continue;
    if (!isFinite(l) || !isFinite(c) || !isFinite(r)) continue;
    if (c >= l && c > r) {
      // 局部高点 → 阻力
      if (c > price && (res === null || c < res)) res = c;
    } else if (c <= l && c < r) {
      // 局部低点 → 支撑
      if (c < price && (sup === null || c > sup)) sup = c;
    }
  }
  return {
    sup, res,
    supDistPct: sup != null && sup > 0 ? (price - sup) / price * 100 : null,
    resDistPct: res != null && res > 0 ? (res - price) / price * 100 : null
  };
}

// ---- 多周期技术评分 (数据融合页 card 加分, 0-100) ----
// 输入: sig = { rsi, macdHist, price, ema20, ema120, aisLine, aisUpper, aisLower } (computeIndicators 的 current)
//       res = resonance 对象 (可选, 有 buy/sell 布尔)
// 以 50 为基准: RSI 超买减/超卖加, MACD 柱方向, 价格在 EMA20 上下, EMA20vs120, AIS 通道位置, 共振信号
export function techScore(sig, res, opts = {}) {
  const { clampMin = 5, clampMax = 95, base = 50 } = opts;
  if (!sig || typeof sig !== 'object') return null;
  let score = base;
  const parts = [];
  const rsi = sig.rsi;
  if (rsi != null && isFinite(rsi)) {
    if (rsi > 70) { score -= 10; parts.push('RSI超买-10'); }
    else if (rsi < 30) { score += 10; parts.push('RSI超卖+10'); }
  }
  const mh = sig.macdHist;
  if (mh != null && isFinite(mh)) {
    if (mh > 0) { score += 8; parts.push('MACD+8'); }
    else if (mh < 0) { score -= 8; parts.push('MACD-8'); }
  }
  if (sig.price != null && sig.ema20 != null && isFinite(sig.price) && isFinite(sig.ema20)) {
    if (sig.price > sig.ema20) { score += 8; parts.push('价>EMA20+8'); }
    else { score -= 8; parts.push('价<EMA20-8'); }
  }
  if (sig.ema20 != null && sig.ema120 != null && isFinite(sig.ema20) && isFinite(sig.ema120)) {
    if (sig.ema20 > sig.ema120) { score += 8; parts.push('EMA20>EMA120+8'); }
    else { score -= 8; parts.push('EMA20<EMA120-8'); }
  }
  if (sig.price != null && sig.aisLower != null && sig.aisUpper != null) {
    const lo = sig.aisLower, hi = sig.aisUpper, span = hi - lo;
    if (isFinite(lo) && isFinite(hi) && span > 0) {
      const pos = (sig.price - lo) / span;
      if (pos > 0.7) { score += 5; parts.push('AIS上沿+5'); }
      else if (pos < 0.3) { score -= 5; parts.push('AIS下沿-5'); }
    }
  }
  if (res && res.buy) { score += 10; parts.push('共振买+10'); }
  else if (res && res.sell) { score -= 10; parts.push('共振卖-10'); }
  return { score: Math.max(clampMin, Math.min(clampMax, Math.round(score))), parts };
}

// 计算某价格序列近期动量%: (last - prevN) / prevN * 100; 序列 < lookback+1 返回 null
export function momentumPct(series, lookback = 10) {
  if (!Array.isArray(series) || series.length <= lookback) return null;
  const last = series[series.length - 1];
  const prev = series[series.length - 1 - lookback];
  if (!isFinite(last) || !isFinite(prev) || prev <= 0) return null;
  return (last - prev) / prev * 100;
}

// 动量状态标签(价格走势卡/急涨急跌门槛 复用 updateAI 的 MOM_RUSH_PCT)
// 输入 spark 价格数组(≥11 点), 返回 '急涨'|'急跌'|'偏涨'|'偏跌'|'平稳'; 数据不足或无效返回 null。
// P2-2: 由 renderFusion 与测试共用同一纯函数, 消除测试自写副本。
export function momentumState(arr, opts = {}) {
  if (!Array.isArray(arr) || arr.length < 11) return null;
  const last = arr[arr.length - 1];
  const old = arr[arr.length - 11];
  if (old == null || !isFinite(old) || old <= 0 || last == null || !isFinite(last)) return null;
  const rush = opts.rush || THRESH.MOM_RUSH_PCT;
  const mild = opts.mild || 0.8;
  const mom = (last - old) / old * 100;
  if (mom > rush) return '急涨';
  if (mom < -rush) return '急跌';
  if (mom > mild) return '偏涨';
  if (mom < -mild) return '偏跌';
  return '平稳';
}

// Taker 主动买卖量比 → 买方占比%: bs/(1+bs)*100 (与 renderFusion taker 卡一致)
// P2-2: 由 renderFusion 与测试共用同一纯函数, 消除测试自写副本。
export function takerBuyPct(tk) {
  const bs = parseFloat(tk && tk.buySellRatio) || 1;
  return Math.round(bs / (1 + bs) * 100);
}

// ===== 链上数据解析(阶段二) =====
// 纯函数, 无 DOM/全局依赖, 可单测。负责把各链上数据源返回的原始 JSON 解析为规范结构。

// 把 "0x..."(十六进制) 或 "12345" 字符串安全转数字; 失败返回 null
export function hexToNum(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (/^0x/i.test(s)) {
    const n = parseInt(s, 16);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Etherscan/BscScan V2 统一响应解析: { status:'1', message:'OK', result:... }
// kind 决定 result 的解析方式:
//   'supply'  ethsupply → result 为 wei 十六进制字符串 → { wei, eth }
//   'txcount' txcount   → result 为十进制字符串 → { tx }
//   'bnbburn' bnbburn   → result 为对象 { 'Total Burnt (BNB)':.., 'Auto-Burn':.., 'Public Burned':.. } → { total, auto, public }
//   'active'  dailytx/dailyactiveaddress → result 为数组, 返回 { rows, last }
// 返回 { ok, ... } 或 { ok:false, err }
export function parseScanV2(resp, kind = 'txcount') {
  if (!resp || resp.status !== '1') {
    return { ok: false, err: (resp && (resp.result || resp.message)) || 'API error' };
  }
  const r = resp.result;
  if (kind === 'supply') {
    const wei = hexToNum(r);
    if (wei == null) return { ok: false, err: 'bad supply' };
    return { ok: true, wei, eth: wei / 1e18 };
  }
  if (kind === 'txcount') {
    const tx = hexToNum(r);
    if (tx == null) return { ok: false, err: 'bad txcount' };
    return { ok: true, tx };
  }
  if (kind === 'bnbburn') {
    if (!r || typeof r !== 'object') return { ok: false, err: 'bad bnbburn' };
    const num = (s) => { const n = parseFloat(String(s || '').replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? n : 0; };
    return {
      ok: true,
      total: num(r['Total Burnt (BNB)']),
      auto: num(r['Auto-Burn']),
      pub: num(r['Public Burned'])
    };
  }
  if (kind === 'active') {
    if (!Array.isArray(r) || !r.length) return { ok: false, err: 'no rows' };
    return { ok: true, rows: r, last: r[r.length - 1] };
  }
  return { ok: false, err: 'unknown kind ' + kind };
}

// Blockchair stats 响应解析: { data: { transactions_24h, blocks_24h, volume_24h, circulation } }
// keyless 降级用(ETH)。返回 { ok, tx24h, blocks24h, volume24h, circulation }
export function parseBlockchairStats(d) {
  const data = d && d.data;
  if (!data) return { ok: false, err: 'no blockchair data' };
  return {
    ok: true,
    tx24h: hexToNum(data.transactions_24h),
    blocks24h: hexToNum(data.blocks_24h),
    volume24h: hexToNum(data.volume_24h),
    circulation: hexToNum(data.circulation)
  };
}

// 链上活跃度趋势: 当前 vs 参考, 阈值 ±3% → 'up'|'down'|'flat'; 数据不足或当前为0(异常)返回 null
export function onChainTrend(cur, ref) {
  if (cur == null || ref == null || cur === 0 || ref === 0 || !Number.isFinite(cur) || !Number.isFinite(ref)) return null;
  const r = (cur - ref) / ref;
  if (r > 0.03) return 'up';
  if (r < -0.03) return 'down';
  return 'flat';
}

// ===== 三层共振 (阶段三) =====
// AI 方向 × 量价背离 × 支撑/阻力，三层一致才触发"共振"，不一致时抑制。
// 层1 = side(AI 方向, 'long'/'short'), 层2 = 量价背离, 层3 = 贴近支撑/阻力(1×ATR 内)。
// 返回 { side, layers:['量价底背离','触及支撑',...], agree:已确认层数(层1隐含), resonance: agree>=2, level:0|1|2|3 }
// 数据不足时返回 { side, layers:[], agree:0, resonance:false, level:0 }。
/**
 * 阶段0: 清洗 sigScore 表中"脏数据"行(winRate>1 或 wins+losses!==total 的假样本)。
 * 幂等纯函数: 不修改传入对象, 返回 { changed, table }(changed=是否有行被清除)。
 * 只保留 wins+losses===total 且 0<=winRate<=1 的合法行。
 */
export function sanitizeSigScoreTable(ss) {
  const table = ss || {};
  const out = {};
  let changed = false;
  Object.keys(table).forEach((k) => {
    const s = table[k];
    const ok = s && typeof s.total === 'number'
      && s.wins + s.losses === s.total
      && s.winRate >= 0 && s.winRate <= 1;
    if (ok) out[k] = s;
    else changed = true;
  });
  return { changed, table: out };
}

export function threeLayerResonance(price, vol, atr, side) {  const empty = { side: side || null, layers: [], agree: 0, resonance: false, level: 0 };
  if (!Array.isArray(price) || price.length < 5) return empty;
  if (!Array.isArray(vol) || vol.length < 5) return empty;
  const last = price[price.length - 1];
  if (last == null || !isFinite(last) || last <= 0) return empty;
  const want = side === 'long' ? 'long' : side === 'short' ? 'short' : null;
  if (!want) return empty;
  const layers = [];
  let agree = 0;
  const vd = volumeDivergence(price, vol, 20);
  if (vd && vd.bull && want === 'long') { layers.push('量价底背离'); agree++; }
  if (vd && vd.bear && want === 'short') { layers.push('量价顶背离'); agree++; }
  const sr = supportResistance(price, 40);
  const useAtr = atr != null && isFinite(atr) && atr > 0 ? atr : null;
  if (useAtr) {
    const atrPct = Math.max(0.2, useAtr / last * 100);
    if (want === 'long' && sr.sup != null) {
      const gap = (last - sr.sup) / last * 100;
      if (gap < atrPct) { layers.push('触及支撑'); agree++; }
    }
    if (want === 'short' && sr.res != null) {
      const gap = (sr.res - last) / last * 100;
      if (gap < atrPct) { layers.push('触及阻力'); agree++; }
    }
  }
  const resonance = agree >= 2;
  return { side: want, layers, agree, resonance, level: resonance ? (agree === 2 ? 2 : 3) : agree };
}

// 对 K 线 OHLC 四列做下采样聚合：每 step 根取 1 根
//   O = 组内首根 open, H = 组内 max high, L = 组内 min low, C = 组内末根 close
// 右对齐：优先保留最近的完整组（末尾不足 step 的部分丢弃），保证最新 K 线不被丢
export function downsampleOHLC(opens, highs, lows, closes, step) {
  const n = opens.length;
  if (step < 1 || n === 0) return { opens: [], highs: [], lows: [], closes: [] };
  const N = Math.floor(n / step);
  const offset = n - N * step;
  const ro = new Array(N), rh = new Array(N), rl = new Array(N), rc = new Array(N);
  for (let i = 0; i < N; i++) {
    const start = offset + i * step;
    let h = -Infinity, l = Infinity;
    for (let j = start; j < start + step; j++) {
      if (highs[j] > h) h = highs[j];
      if (lows[j] < l) l = lows[j];
    }
    ro[i] = opens[start];
    rh[i] = h;
    rl[i] = l;
    rc[i] = closes[start + step - 1];
  }
  return { opens: ro, highs: rh, lows: rl, closes: rc };
}

// sumVol：与 downsampleOHLC 同款"右对齐分组"对成交量求和。
// 用于 10m=5m 下采样时把组内 K 线成交量累加，保证与 downsampled OHLC 一一对齐。
export function sumVol(vols, step) {
  const n = vols.length;
  if (step < 1 || n === 0) return [];
  const N = Math.floor(n / step);
  const offset = n - N * step;
  const rv = new Array(N);
  for (let i = 0; i < N; i++) {
    const start = offset + i * step;
    let s = 0;
    for (let j = start; j < start + step; j++) {
      const v = vols[j];
      if (v != null && isFinite(v)) s += v;
    }
    rv[i] = s;
  }
  return rv;
}

