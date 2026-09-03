// 独立迷你 PWA 的数据层（与主系统 refreshTechKlines 1:1 镜像，保证 K线数据一致）
// 仅依赖共享引擎模块（indicators/timeframe/thresholds），不引入 legacy.js / main.js
import { downsampleOHLC, sumVol, ema, rsi, srsi, macd, atrClose, ais, aisMacd, resonance } from '../engine/indicators.js';
import { KLINE_TF, KLINE_INTERVAL, KLINE_DOWNSAMPLE } from '../engine/timeframe.js';
import { THRESH } from '../engine/thresholds.js';

// 与主系统默认 techConfig 对齐（ais 全开），确保 RSI/MACD 子图用 AIS 自适应版本，与主系统一致
export const DEFAULT_TECH = {
  ais: { ema20: true, ema120: true, rsi: true, macd: true, srsi: true },
  srsiRsiPeriod: 85, srsiStochPeriod: 50, srsiSmoothK: 10, srsiSmoothD: 5, srsiOverbought: 80, srsiOversold: 20
};

// 纯函数：由收盘价序列计算与主系统 computeIndicators 完全一致的 series 形状
// （跳过 ATR 监督——kchart 子图不渲染 atr，故不影响显示一致性）
export function computeSeries(arr) {
  const cfg = (typeof globalThis !== 'undefined' && globalThis.techConfig) || DEFAULT_TECH;
  const atrArr = atrClose(arr, 14);
  const atrNow = atrArr[atrArr.length - 1] || 0;
  const e20 = ema(arr, 20), e120 = ema(arr, 120);
  const rsiArr = rsi(arr, 14);
  const srsiArr = srsi(arr, 14, 14);
  const macdArr = macd(arr, 12, 26, 9);
  const a20 = ais(arr, 20, 8, 32, 14, 2);
  const a120 = ais(arr, 120, 40, 180, 14, 2);
  const aRsi = ais(rsiArr, 14, 5, 30, 14, 2);
  const aSrsi = ais(srsiArr, 14, 5, 30, 14, 2);
  const aMacd = aisMacd(arr, 12, 26, 9, 14);
  const i = Math.max(0, arr.length - 1);
  const last = (a) => (a && a[i] != null ? a[i] : null);
  const sig = {
    price: arr[i],
    ema20: cfg.ais.ema20 ? last(a20.line) : last(e20),
    ema120: cfg.ais.ema120 ? last(a120.line) : last(e120),
    rsi: cfg.ais.rsi ? last(aRsi.line) : last(rsiArr),
    macd: cfg.ais.macd ? last(aMacd.line) : last(macdArr.line),
    macdSignal: cfg.ais.macd ? last(aMacd.signal) : last(macdArr.signal),
    macdHist: cfg.ais.macd ? last(aMacd.hist) : last(macdArr.hist),
    srsi: cfg.ais.srsi ? last(aSrsi.line) : last(rsiArr),
    aisLine: last(a20.line), aisUpper: last(a20.upper), aisLower: last(a20.lower),
    aisPeriod: a20.period, atr: atrNow
  };
  const res = resonance(sig);
  return {
    series: {
      price: arr,
      ema20: cfg.ais.ema20 ? a20.line : e20,
      ema120: cfg.ais.ema120 ? a120.line : e120,
      rsi: cfg.ais.rsi ? aRsi.line : rsiArr,
      srsi: cfg.ais.srsi ? aSrsi.line : rsiArr,
      macdLine: cfg.ais.macd ? aMacd.line : macdArr.line,
      macdSignal: cfg.ais.macd ? aMacd.signal : macdArr.signal,
      macdHist: cfg.ais.macd ? aMacd.hist : macdArr.hist,
      aisLine: a20.line, aisUpper: a20.upper, aisLower: a20.lower,
      atr: atrNow
    },
    current: sig,
    resonance: res,
    atr: atrNow,
    n: arr.length,
    periods: { ema20: a20.period, ema120: a120.period, rsi: aRsi.period, srsi: aSrsi.period, macdFast: aMacd.fastP, macdSlow: aMacd.slowP }
  };
}

// 数据端点：优先 api.binance.com，失败自动切 data-api.binance.vision（大陆用户/地域受限友好）。
// 可在加载前设置 window.KCHART_BINANCE_API 强制用单一端点（覆盖下方列表）。
const BINANCE_ENDPOINTS = ['https://api.binance.com', 'https://data-api.binance.vision'];
const EP_KEY = 'pwa_binance_endpoint_idx';   // 持久化上次成功端点，避免每次重连都等被墙端点超时

function endpointList() {
  const forced = (typeof globalThis !== 'undefined' && globalThis.KCHART_BINANCE_API);
  return forced ? [forced] : BINANCE_ENDPOINTS;
}

// 读取持久化的上次成功端点索引（异常/无 localStorage 时安全回退到 0）
function loadGoodIdx() {
  try {
    if (typeof localStorage !== 'undefined') {
      const v = parseInt(localStorage.getItem(EP_KEY), 10);
      if (!isNaN(v) && v >= 0 && v < BINANCE_ENDPOINTS.length) return v;
    }
  } catch (e) {}
  return 0;
}
function saveGoodIdx(idx) {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(EP_KEY, String(idx)); } catch (e) {}
}

// 上次成功使用的端点索引（模块级缓存；成功后直连，并持久化跨会话）
let _goodIdx = loadGoodIdx();
function currentApi() {
  const list = endpointList();
  return list[Math.min(_goodIdx, list.length - 1)];
}

// 纯函数：把 Binance 原始 klines 解析成 O/H/L/C/V/T
// 与 legacy.js refreshTechKlines 的解析逐行一致：索引 c[1..5]/c[0]、downsampleOHLC + sumVol、times.slice(-closes.length)
export function parseKlines(tf, raw) {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  let opens = raw.map(c => parseFloat(c[1]));
  let highs = raw.map(c => parseFloat(c[2]));
  let lows = raw.map(c => parseFloat(c[3]));
  let closes = raw.map(c => parseFloat(c[4]));
  let vols = raw.map(c => parseFloat(c[5]));
  let times = raw.map(c => parseInt(c[0], 10) || 0);
  const ds = KLINE_DOWNSAMPLE[tf];
  if (ds) {
    const step = ds.step;
    const agg = downsampleOHLC(opens, highs, lows, closes, step);
    opens = agg.opens; highs = agg.highs; lows = agg.lows; closes = agg.closes;
    vols = sumVol(vols, step);
    times = times.slice(-closes.length);
  }
  return { opens, highs, lows, closes, vols, times };
}

async function fetchJson(url, timeout = 10000) {
  if (typeof fetch !== 'function') throw new Error('fetch 不可用');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// 带端点自动切换的数据请求：当前端点失败 → 依次尝试其余端点；成功则把可用索引缓存到 _goodIdx。
// 全部失败才抛错（保留最后一次错误信息，供页面上报"数据源不可达"）。
async function fetchApiData(path, timeout = 10000) {
  const list = endpointList();
  if (!list.length) throw new Error('未配置数据端点');
  let lastErr = null;
  for (let i = 0; i < list.length; i++) {
    const idx = (_goodIdx + i) % list.length;
    const url = list[idx] + path;
    try {
      const data = await fetchJson(url, timeout);
      _goodIdx = idx;               // 缓存当前可用端点，下次直连
      saveGoodIdx(idx);             // 持久化，跨会话默认用该端点（避免大陆用户每次等被墙端点超时）
      return data;
    } catch (e) {
      lastErr = e;
    }
  }
  const e = new Error('数据源不可达 (全部端点失败): ' + (lastErr && lastErr.message));
  e.sourceUnreachable = true;
  throw e;
}

// 拉取某币种全部 TF 的 klines，写回 globalThis.S.klines*（与 kchart.js 读取结构一致）
export async function refreshKlines(sym) {
  const S = globalThis.S;
  if (!S) throw new Error('globalThis.S 未初始化');
  if (!S.indicators) S.indicators = {};
  const tfs = KLINE_TF;
  const results = await Promise.allSettled(tfs.map(tf => {
    const interval = KLINE_INTERVAL[tf] || tf;
    const path = '/api/v3/klines?symbol=' + sym + '&interval=' + interval + '&limit=' + (THRESH.KLINE_LIMIT || 150);
    return fetchApiData(path).then(r => ({ tf, raw: r }));
  }));
  let ok = 0;
  results.forEach(res => {
    if (res.status !== 'fulfilled') return;
    const { tf, raw } = res.value;
    const parsed = parseKlines(tf, raw);
    if (!parsed) return;
    if (!S.klines[sym]) S.klines[sym] = {};
    if (!S.klinesO[sym]) S.klinesO[sym] = {};
    if (!S.klinesH[sym]) S.klinesH[sym] = {};
    if (!S.klinesL[sym]) S.klinesL[sym] = {};
    if (!S.klinesV[sym]) S.klinesV[sym] = {};
    if (!S.klinesT[sym]) S.klinesT[sym] = {};
    S.klines[sym][tf] = parsed.closes;
    S.klinesO[sym][tf] = parsed.opens;
    S.klinesH[sym][tf] = parsed.highs;
    S.klinesL[sym][tf] = parsed.lows;
    S.klinesV[sym][tf] = parsed.vols;
    S.klinesT[sym][tf] = parsed.times;
    if (!S.indicators[sym]) S.indicators[sym] = {};
    S.indicators[sym][tf] = computeSeries(parsed.closes); // RSI/MACD 子图所需，与主系统一致
    ok++;
  });
  if (ok === 0) {
    // 所有周期均失败：通常是数据源不可达（端点全部失败或被墙）。
    let reason = '未知错误';
    for (const r of results) { if (r.status === 'rejected' && r.reason) { reason = r.reason.message || String(r.reason); break; } }
    const e = new Error('K线加载失败: ' + reason);
    e.sourceUnreachable = true;
    throw e;
  }
  return ok;
}

// 拉取最新价/24h 涨跌（Binance /ticker/24hr），写回 globalThis.S.prices[sym]
export async function refreshPrice(sym) {
  const S = globalThis.S;
  if (!S) throw new Error('globalThis.S 未初始化');
  try {
    const raw = await fetchApiData('/api/v3/ticker/24hr?symbol=' + sym);
    const last = parseFloat(raw.lastPrice);
    const chg = parseFloat(raw.priceChangePercent);
    if (!S.prices[sym]) S.prices[sym] = {};
    S.prices[sym].last = last;
    S.prices[sym].chg = chg;
    return { last, chg };
  } catch (e) {
    return null;
  }
}
