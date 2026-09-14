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

// 数据端点：第一优先是相对-origin 端点 ''（即当前页面的同源 /api /fapi 路径，
// 由 Cloudflare Pages Function 代理转发到 Binance——墙内用户浏览器只连已可达的
// srsi.openapi.im，由 Cloudflare 边缘去拉 Binance，从而任何地区都能拿到数据）。
// 失败再回退 Binance 直连（api.binance.com / data-api.binance.vision）。
// 可在加载前设置 window.KCHART_BINANCE_API 强制用单一端点（覆盖下方列表）。
// group: 'api' → 现货/行情(/api/*) ; 'fapi' → 合约资金费(/fapi/*)。两组都把同源代理放首位。
// PWA 运行在用户终端，K线拉取是【终端→Binance】直连；Cloudflare Pages 只是下载/更新壳，不中转行情。
// "任何地区可用"取决于用户终端网络能否到达 Binance；受限地区需用户在 PWA 内填一个【可达 Binance 的
// 代理/镜像】（持久化到 localStorage pwa_binance_proxy，或加载前设 window.KCHART_BINANCE_API）。
// 代理 URL 两种写法：反向代理 https://myproxy/binance → <代理>/api/v3/klines...；
//   包裹代理 https://corsproxy.io/?url={url} → <代理>?url=<encoded 全 URL>。
// 默认走 Binance 多域名并发竞速（api/api1/api2/data-api.vision），提升不同地区命中率。
const EP_API = ['https://api.binance.com', 'https://api1.binance.com', 'https://api2.binance.com', 'https://data-api.binance.vision'];
const EP_FAPI = ['https://fapi.binance.com', 'https://fapi.binance.vision'];
const PROXY_KEY = 'pwa_binance_proxy';

function userProxy() {
  try { if (typeof localStorage !== 'undefined') { const v = localStorage.getItem(PROXY_KEY); if (v) return v; } } catch (e) {}
  return (typeof globalThis !== 'undefined' && globalThis.KCHART_BINANCE_API) || null;
}
function endpointList(group) {
  const p = userProxy();
  if (p) return [p];
  return group === 'fapi' ? EP_FAPI : EP_API;
}
function buildProxyUrl(base, path, group) {
  const host = group === 'fapi' ? 'https://fapi.binance.com' : 'https://api.binance.com';
  if (base.includes('{url}')) return base.replace('{url}', encodeURIComponent(host + path));
  return base + path;
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

// 带端点自动切换的数据请求：所有端点并发竞速，取首个成功；全部失败才抛错。
// 用 Promise.any 而非串行 for：被墙端点会静默挂起，串行会一直等到超时，
// 并发则可用端点一旦返回即胜出，不再空等被墙的那个（避免页面"回测中"久转）。
async function fetchApiData(path, group = 'api', timeout = 8000) {
  const list = endpointList(group);
  if (!list.length) throw new Error('未配置数据端点');
  if (list.length === 1) {
    try { return await fetchJson(buildProxyUrl(list[0], path, group), timeout); }
    catch (e) { const err = new Error('数据源不可达: ' + (e && e.message)); err.sourceUnreachable = true; throw err; }
  }
  // 并发竞速：被墙端点会静默挂起，串行会一直等到超时；并发则可用端点一旦返回即胜出。
  const attempts = list.map((base, i) => fetchJson(buildProxyUrl(base, path, group), timeout).then(d => ({ i, d })));
  try {
    const first = await Promise.any(attempts);
    return first.d;
  } catch (agg) {
    const errs = (agg && agg.errors) ? agg.errors : [agg];
    const lastErr = errs[errs.length - 1];
    const e = new Error('数据源不可达 (全部端点失败): ' + (lastErr && lastErr.message));
    e.sourceUnreachable = true;
    throw e;
  }
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
  // 主图原生周/月线（7d→1w, 30d→1M）：根数充足且对齐交易所；SRSI 速览仍用日线 klines['7d']/['30d']（各自 resample）。
  // nativeMain(kchart.js) 优先读 klinesWeek/klinesMonth，缺失时回退 aggTFData（日线聚合）。
  try {
    const wk = await fetchApiData('/api/v3/klines?symbol=' + sym + '&interval=1w&limit=' + (THRESH.KLINE_LIMIT || 150));
    if (Array.isArray(wk) && wk.length) {
      if (!S.klinesWeek) S.klinesWeek = {};
      const p = parseKlines('1w', wk);
      S.klinesWeek[sym] = { o: p.opens, h: p.highs, l: p.lows, c: p.closes, v: p.vols, t: p.times };
    }
  } catch (e) {}
  try {
    const mo = await fetchApiData('/api/v3/klines?symbol=' + sym + '&interval=1M&limit=' + (THRESH.KLINE_LIMIT || 150));
    if (Array.isArray(mo) && mo.length) {
      if (!S.klinesMonth) S.klinesMonth = {};
      const p = parseKlines('1M', mo);
      S.klinesMonth[sym] = { o: p.opens, h: p.highs, l: p.lows, c: p.closes, v: p.vols, t: p.times };
    }
  } catch (e) {}
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

// 分页拉取某币种某周期的历史 K 线（用于本机 TSEV 回补），自动端点切换 + 轻量限流。
// 返回与 parseKlines 一致的结构 { opens,highs,lows,closes,vols,times }。
// 注意：Binance 在同时传 startTime+endTime 时会从 startTime 升序返回，故分页只用 endTime 驱动
// （每次取 endTime 之前的最近 limit 根），用 firstTs<=startTime 作为停止条件。
export async function fetchKlinesRange(sym, tf, startTime, endTime, onProgress, maxBars = 12000) {
  const interval = KLINE_INTERVAL[tf] || tf;
  let all = [];
  let end = endTime;
  let guard = 0;
  while (guard++ < 200) {
    const path = '/api/v3/klines?symbol=' + sym + '&interval=' + interval
      + '&endTime=' + end + '&limit=1000';
    let raw;
    try { raw = await fetchApiData(path, 8000); }
    catch (e) { break; }
    if (!raw || !raw.length) break;
    all = raw.concat(all);             // raw 为本批较早数据，拼到队首
    if (onProgress) onProgress(all.length);
    if (all.length >= maxBars) break;  // 达到最大根数即停，避免短周期拉几十万根卡死
    const firstTs = raw[0][0];
    if (firstTs <= startTime) break;   // 已到目标起点
    end = firstTs - 1;
    // 注意：不要因 raw.length<1000 提前 break —— Binance 历史中间偶发缺口会让某页
    // 不足 1000 根，此时应继续向更早翻页补足，否则拉到的窗口会比目标天数短，
    // 导致不同周期/不同次拉取的数据窗口不一致（如 1h 只拉到 15000/625天 而非 17520/730天）。
    await new Promise(r => setTimeout(r, 30));
  }
  // 按请求窗口 [startTime, endTime] 截断，避免单次 limit=1000 页覆盖超过目标周期
  // （如 15m 一页≈10.4天，会让 24h/7d 拉到同一整页 → 回测数据雷同）
  const trimmed = all.filter(k => k[0] >= startTime && k[0] <= endTime);
  return parseKlines(tf, trimmed.length ? trimmed : all);
}

// 拉取真实历史资金费率（Binance U 本位合约 /fapi/v1/fundingRate），用于回测成本还原
// 返回 [{fundingTime, fundingRate}] 升序；与 PaperEngine 实盘 fundingPayment 共用同一结算口径
export async function fetchFundingRate(sym, startTime, endTime) {
  const path = '/fapi/v1/fundingRate?symbol=' + sym + '&startTime=' + startTime + '&endTime=' + endTime + '&limit=1000';
  try {
    const json = await fetchApiData(path, 'fapi');
    if (!Array.isArray(json)) return [];
    return json
      .filter(r => r && r.fundingTime != null && r.fundingRate != null)
      .map(r => ({ fundingTime: +r.fundingTime, fundingRate: +r.fundingRate }))
      .sort((a, b) => a.fundingTime - b.fundingTime);
  } catch (e) { return []; }
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
