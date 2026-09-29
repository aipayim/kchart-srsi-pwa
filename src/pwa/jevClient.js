// Jev 客户端（PWA）：设置读写 + 状态采集 + 决策调用 + 落库/回填 + 本地 TSEV 喂样
//
// 红线：
//  - 只做「判断 + 学习 + 显示」，**绝不触发任何交易/资金动作**（不 import 交易引擎、不调 placeOrder）。
//  - Token 只进 IndexedDB（AES-GCM，exchange='LLM'），绝不进 localStorage / 日志 / 提示词。
//  - 写入失败不静默吞：localStorage 走 _safeSet（失败记录在 status().storageErr），IDB 失败抛给调用方。
import { saveApiKey, getApiKey, hasApiKey, clearApiKey } from '../auth/apiKeyStore.js';
import { decisionCall, probeDecisionShapes, estimateTokens } from '../ai/llmClient.js';
import {
  JEV_HORIZON_IDS, JEV_DEFAULT_GROUPS, JEV_LEVELS, JEV_MODES,
  JEV_DEFAULT_QUESTIONS, JEV_DEFAULT_TEMPLATE,
  buildJevState, buildJevBody, parseJevResponse, jevSamplesFor
} from '../engine/jevState.js';
import { winLossByAtr, atrClose, volumeDivergence, supportResistance } from '../engine/indicators.js';
import { parseJevFlow, flowFillSummary } from '../engine/jevState.js';
import { fetchJevFlow, fetchJevNews } from './data.js';
import { newsSentiment } from '../engine/indicators.js';
import { THRESH } from '../engine/thresholds.js';

const LSK = 'pwa_jev';
const DB_NAME = 'kchart_jev';
const DB_VER = 1;
const STORE = 'decisions';
const DEC_CAP = 400;             // 明细上限（超出裁掉最旧）

// 每个档的评估口径：evalTf = 用于判盈亏的 K 线周期；bars = 到期所需的前向根数
// TP/SL 与项目标准一致（THRESH.BT_TP_ATR / BT_SL_ATR）→ 与因子消融/回测同源
export const JEV_EVAL = {
  short: { tf: '1h', bars: 24 },
  mid: { tf: '4h', bars: 30 },
  long: { tf: '1d', bars: 30 }
};

let _status = { lastErr: null, storageErr: null, lastRun: 0, running: false, lastResult: null, keyPresent: false };

// ---------------------------------------------------------------------------
// 设置（localStorage，小对象；写失败显式记录，不静默吞）
// ---------------------------------------------------------------------------
export function defaultJevCfg() {
  return {
    enabled: false,
    baseUrl: 'http://localhost:3460/v1',   // 生产由用户填自己的 Jev 地址
    model: 'jev-latest',
    horizons: { short: true, mid: true, long: true },
    groups: JSON.parse(JSON.stringify(JEV_DEFAULT_GROUPS)),
    newsSrc: '',                  // 新闻源（可选）：RSS 直链或包裹代理 https://代理/?url={url}；空=开发走 /rss-proxy，生产=未知
    freq: '1h',                  // 15m | 1h | 4h | 1d | manual
    mode: 'off',                 // off | learn | apply
    template: JEV_DEFAULT_TEMPLATE,
    questions: Object.assign({}, JEV_DEFAULT_QUESTIONS),
    price: { inPer1M: 0, outPer1M: 0 },   // 单价（$/1M tokens）；本地网关 = 0
    flow: null,                   // 最近一次采集到的盘口（缓存，供面板展示填充度）
    lastFill: null,
    spend: { calls: 0, inTok: 0, outTok: 0, cost: 0 },
    autoMature: true
  };
}

function _safeSet(key, str) {
  try { localStorage.setItem(key, str); _status.storageErr = null; return true; }
  catch (e) {
    _status.storageErr = String((e && e.message) || e);
    // 配额自愈：清理可重建的派生键后重试一次（绝不碰用户配置/账户）
    try {
      const kill = ['pwa_signal_events', 'smartTrader_cockpitEvents', 'smartTrader_ruleMonitor'];
      for (const k of Object.keys(localStorage)) {
        if (/^srsiOptHist:/.test(k) || kill.indexOf(k) >= 0) localStorage.removeItem(k);
      }
      localStorage.setItem(key, str);
      _status.storageErr = null;
      return true;
    } catch (e2) {
      _status.storageErr = String((e2 && e2.message) || e2);
      return false;
    }
  }
}

export function readJevCfg() {
  const base = defaultJevCfg();
  let raw = null;
  try { raw = localStorage.getItem(LSK); } catch (e) { raw = null; }
  if (!raw) return base;
  let v = null;
  try { v = JSON.parse(raw); } catch (e) { v = null; }
  if (!v || typeof v !== 'object') return base;
  const out = Object.assign(base, v);
  out.horizons = Object.assign({}, base.horizons, v.horizons || {});
  out.groups = Object.assign({}, base.groups, v.groups || {});
  out.questions = Object.assign({}, base.questions, v.questions || {});
  out.price = Object.assign({}, base.price, v.price || {});
  out.spend = Object.assign({}, base.spend, v.spend || {});
  if (!JEV_MODES[out.mode]) out.mode = 'off';
  return out;
}

export function writeJevCfg(cfg) {
  return _safeSet(LSK, JSON.stringify(cfg || {}));
}

export function patchJevCfg(patch) {
  const c = readJevCfg();
  Object.assign(c, patch || {});
  writeJevCfg(c);
  return c;
}

/** cfg（含 audio/token 合并后的调用配置），token 从 IndexedDB 解密取出 */
export async function jevCallCfg() {
  const c = readJevCfg();
  let token = '';
  try {
    const k = await getApiKey('LLM');
    token = (k && k.apiKey) || '';
  } catch (e) { token = ''; }
  _status.keyPresent = !!token;
  return {
    provider: 'custom', baseUrl: c.baseUrl, model: c.model, apiKey: token,
    timeoutMs: 45000, _cfg: c
  };
}

export async function setJevToken(token) {
  if (!token) { await clearApiKey('LLM'); _status.keyPresent = false; return true; }
  // 非安全上下文（http:// + 非 localhost）浏览器不提供 crypto.subtle → 加密库无法工作，显式报错而非静默失败
  if (!(globalThis.crypto && globalThis.crypto.subtle)) {
    const e = new Error('当前页面不是安全上下文（无 crypto.subtle），无法加密保存 Token → 请用 https 或 http://localhost 打开');
    _status.lastErr = e.message;
    throw e;
  }
  await saveApiKey({ exchange: 'LLM', apiKey: token, secret: '' });
  _status.keyPresent = true;
  return true;
}
export async function hasJevToken() { try { return await hasApiKey('LLM'); } catch (e) { return false; } }

/** 「测试连接」：优先按当前配置形状调用一次；失败则自动探测候选形状 */
export async function testJevConnection(opts = {}) {
  const cc = await jevCallCfg();
  if (!cc.apiKey) return { ok: false, err: '未填写 Token（Token 只存本机加密库）' };
  const cfg = readJevCfg();
  const stateText = (opts.stateText || '（连接测试）标的 BTCUSDT，价格 100000，趋势向上，RSI 60，MACD 多头。');
  let body = null;
  try {
    body = buildJevBody({ model: cfg.model, template: cfg.template, questions: cfg.questions, enabled: cfg.horizons }, stateText);
  } catch (e) {
    return { ok: false, err: '请求体构造失败: ' + String((e && e.message) || e) };
  }
  const t0 = Date.now();
  try {
    const r = await decisionCall(cc, body);
    const parsed = parseJevResponse(r.json, { levels: JEV_LEVELS });
    return { ok: true, ms: Date.now() - t0, model: r.json && r.json.model, usage: r.usage, parsed, shape: 'current' };
  } catch (e) {
    const probe = await probeDecisionShapes(cc, stateText, JEV_DEFAULT_QUESTIONS.short);
    return { ok: false, err: String((e && e.message) || e), ms: Date.now() - t0, probe };
  }
}

/** 形状探测（设置页按钮）：返回每个候选形状的 HTTP 状态 */
export async function probeJevShapes() {
  const cc = await jevCallCfg();
  if (!cc.apiKey) return { ok: false, err: '未填写 Token' };
  const probe = await probeDecisionShapes(cc, '（探测）BTCUSDT 趋势向上', '偏多还是偏空？');
  return probe;
}

// ---------------------------------------------------------------------------
// IndexedDB（独立库，避免与 localLoop 的 kchart_pwa 版本冲突）
// ---------------------------------------------------------------------------
function hasIDB() { return typeof indexedDB !== 'undefined'; }
let _db = null;
function openDB() {
  return new Promise((resolve) => {
    if (!hasIDB()) return resolve(null);
    try {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const st = db.createObjectStore(STORE, { keyPath: 'id' });
          st.createIndex('ts', 'ts', { unique: false });
          st.createIndex('sym', 'sym', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch (e) { resolve(null); }
  });
}
async function db() { if (_db) return _db; _db = await openDB(); return _db; }
function idbReq(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }

export async function listDecisions(limit = 200) {
  const d = await db();
  if (!d) return [];
  try {
    const tx = d.transaction(STORE, 'readonly');
    const all = await idbReq(tx.objectStore(STORE).getAll());
    all.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return all.slice(0, limit);
  } catch (e) { return []; }
}
async function putDecision(rec) {
  const d = await db();
  if (!d) return false;
  const tx = d.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).put(rec);
  return true;
}
export async function clearDecisions() {
  const d = await db();
  if (!d) return false;
  const tx = d.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).clear();
  return true;
}
async function trimDecisions() {
  const all = await listDecisions(9999);
  if (all.length <= DEC_CAP) return;
  const d = await db();
  if (!d) return;
  const tx = d.transaction(STORE, 'readwrite');
  for (const r of all.slice(DEC_CAP)) tx.objectStore(STORE).delete(r.id);
}

// ---------------------------------------------------------------------------
// 状态采集（读 window.S + kchartApi；无网络）
// ---------------------------------------------------------------------------
function kapi() { return globalThis.kchartApi || null; }
function S() { return globalThis.S || {}; }

/** 由 klines 数组 + 该周期 indicators 组装 fmtTfLine 所需读数 */
function readingsFor(sym, tf) {
  const s = S();
  const closes = (s.klines && s.klines[sym] && s.klines[sym][tf]) || null;
  if (!Array.isArray(closes) || closes.length < 8) return null;
  const highs = (s.klinesH && s.klinesH[sym] && s.klinesH[sym][tf]) || null;
  const lows = (s.klinesL && s.klinesL[sym] && s.klinesL[sym][tf]) || null;
  const vols = (s.klinesV && s.klinesV[sym] && s.klinesV[sym][tf]) || null;
  const ind = (s.indicators && s.indicators[sym] && s.indicators[sym][tf]) || null;
  const n = closes.length;
  const cur = ind && ind.current ? ind.current : null;
  const series = ind && ind.series ? ind.series : null;
  const atrPct = (cur && cur.atr && cur.price) ? (cur.atr / cur.price) * 100 : null;
  const { vd, sr } = { vd: null, sr: null };
  // MACD 状态：用 series.macdHist 的末两根
  let macd = null;
  if (series && Array.isArray(series.macdHist)) {
    const h = series.macdHist;
    macd = macdStateOf(h[n - 1], h[n - 2]);
  }
  // SRSI(K/D)：series.srsi 是 RSI 值，K/D 需另算 → 用 kchart 的 SRSI 速览（若可用）或跳过
  let kd = null;
  try {
    const ov = kapi() && kapi().__srsiOverviewRow ? kapi().__srsiOverviewRow(sym, tf) : null;
    if (ov && ov.k != null && ov.d != null) kd = [ov.k, ov.d];
  } catch (e) { kd = null; }

  return {
    rsi: cur ? cur.rsi : null,
    macd,
    ma: maStateOf(cur ? cur.price : closes[n - 1], cur ? cur.ema20 : null, cur ? cur.ema120 : null),
    vol: volStateOf(vols, closes),
    pattern: patternOf(closes, highs, lows),
    momPct: momentumPctOf(closes, 10),
    atr: atrTxt(atrPct, null),
    srsi: null,
    kd,
    band: kd ? bandOf(kd[0]) : null,
    atrPct
  };
}

// 以下为轻量本地实现（与 jevState 的同名纯函数语义一致；此处避免循环 import 只做展示用副本）
function macdStateOf(h, p) {
  if (h == null) return null;
  if (p == null) return h > 0 ? '多头' : h < 0 ? '空头' : '缠绕';
  if (p <= 0 && h > 0) return '金叉';
  if (p >= 0 && h < 0) return '死叉';
  if (h > 0) return Math.abs(h) >= Math.abs(p) ? '多头发散' : '多头收敛';
  if (h < 0) return Math.abs(h) >= Math.abs(p) ? '空头发散' : '空头收敛';
  return '缠绕';
}
function maStateOf(price, e20, e120) {
  if (price == null || e20 == null) return null;
  if (Math.abs(price - e20) / e20 < 0.002) return '缠绕均线';
  const above = price > e20;
  if (e120 != null && e20 > e120) return above ? '站上均线(多头排列)' : '跌破均线(多头排列)';
  if (e120 != null && e20 < e120) return above ? '站上均线(空头排列)' : '跌破均线(空头排列)';
  return above ? '站上均线' : '跌破均线';
}
function volStateOf(vols, closes) {
  if (!Array.isArray(vols) || vols.length < 6) return null;
  const n = vols.length, cur = vols[n - 1];
  if (!(cur > 0)) return null;
  const win = vols.slice(Math.max(0, n - 21), n - 1).filter(v => v > 0).sort((a, b) => a - b);
  if (win.length < 4) return null;
  const med = win[Math.floor(win.length / 2)];
  if (!med) return null;
  const r = cur / med;
  const dir = Array.isArray(closes) && closes.length >= 4 ? Math.sign(closes[n - 1] - closes[n - 4]) : 0;
  if (r >= 2.5) return dir < 0 ? '爆量下跌' : '爆量上涨';
  if (r >= 1.4) return dir < 0 ? '放量下跌' : '放量突破';
  if (r <= 0.6) return dir < 0 ? '缩量回调' : '缩量上涨';
  return '量能平稳';
}
function patternOf(closes, highs, lows) {
  if (!Array.isArray(closes) || closes.length < 8) return null;
  const n = closes.length; const out = [];
  let up = 0; for (let i = n - 1; i >= 1 && i > n - 5; i--) { if (closes[i] > closes[i - 1]) up++; else break; }
  if (up >= 3) out.push('连阳');
  let dn = 0; for (let i = n - 1; i >= 1 && i > n - 5; i--) { if (closes[i] < closes[i - 1]) dn++; else break; }
  if (dn >= 3) out.push('连阴');
  return out.length ? out.join('+') : '无明显形态';
}
function momentumPctOf(closes, lb) {
  if (!Array.isArray(closes) || closes.length <= lb) return null;
  const a = closes[closes.length - 1 - lb], b = closes[closes.length - 1];
  if (!(a > 0)) return null;
  return (b - a) / a * 100;
}
function atrTxt(p, m) {
  if (p == null) return null;
  let band = '中波动';
  if (m > 0) { if (p >= m * 1.4) band = '高波动（扩张）'; else if (p <= m * 0.7) band = '低波动（收缩）'; }
  return band + '(ATR ' + p.toFixed(2) + '%)';
}
function bandOf(k) { return k >= 80 ? '上带' : k <= 20 ? '下带' : '中带'; }

/** 采集完整输入（纯数据）。ctx = 预先取好的 {flow, ext}（避免每档重复联网） */
export function gatherJevInput(sym, group, ctx) {
  const cfg = (kapi() && kapi().getConfig) ? kapi().getConfig() : {};
  const s = S();
  const jcfg = readJevCfg();
  const tfs = (jcfg.groups && jcfg.groups[group]) || JEV_DEFAULT_GROUPS[group] || [];
  const tf = {};
  for (const t of tfs) {
    try { tf[t] = readingsFor(sym, t); } catch (e) { tf[t] = null; }
  }
  // 共振 / 支撑阻力 / 量价背离：用该档的首个周期（最短）做主参考
  let resonance = null, vd = null, sr = null;
  const ref = tfs.find(t => tf[t]) || tfs[0];
  const ind = (s.indicators && s.indicators[sym] && s.indicators[sym][ref]) || null;
  if (ind && ind.resonance) resonance = ind.resonance;
  const closes = (s.klines && s.klines[sym] && s.klines[sym][ref]) || null;
  const vols = (s.klinesV && s.klinesV[sym] && s.klinesV[sym][ref]) || null;
  if (Array.isArray(closes) && Array.isArray(vols)) {
    try {
      vd = volumeDivergence(closes, vols, 20);
      sr = supportResistance(closes, 40);
    } catch (e) { vd = null; sr = null; }
  }
  // 体制 / 波动率分位 / 趋势门 / 宏观
  let regime = null;
  try {
    const api = kapi();
    if (api && api.__regimeState) regime = api.__regimeState(sym);
  } catch (e) { regime = null; }
  let volQ = null;
  try {
    const ap = globalThis.__adaptivePortfolio;
    if (ap && ap.getState) {
      const st = ap.getState();
      const m = st && st.market;
      if (m && m.symbols) { const x = m.symbols.find(y => y.sym === sym); if (x && x.volQ != null) volQ = x.volQ; }
      else if (m && m.volQ != null) volQ = m.volQ;
    }
  } catch (e) { volQ = null; }
  let trend = null, macro = null;
  try {
    const api = kapi();
    if (api && api.__horizonTrend) trend = api.__horizonTrend(sym);
  } catch (e) { trend = null; }
  return { sym, group, tfs, tf, resonance, vd, sr, regime, volQ, trend, macro, flow: (ctx && ctx.flow) || {}, ext: (ctx && ctx.ext) || {}, now: Date.now() };
}

/**
 * 一次性采集「盘口/订单流 + 外部语义」上下文（联网，带缓存；失败只影响对应子项）。
 * 拿不到就留给 buildJevState 写「未知」——**不会影响 Jev 判断与学习本身**（提示词已声明未知项由模型自行知识补全）。
 */
export async function collectJevContext(sym, opts = {}) {
  const cfg = readJevCfg();
  const ctx = { flow: {}, ext: {}, fill: null, errs: [] };
  try {
    const raw = await fetchJevFlow(sym, opts.flowOpts);
    const f = parseJevFlow(raw);
    const flow = {};
    if (f.fundingRate != null) { flow.fundingRate = f.fundingRate; flow.frTrend = f.frTrend || null; }
    if (f.basisPct != null) flow.basisPct = f.basisPct;
    if (f.oi != null) {
      flow.oi = f.oi;
      if (f.oiChangePct != null) {
        const mins = (f.oiChangeBars || 1) * 5;
        flow.oiTrend = (f.oiChangePct >= 0 ? '上升' : '下降') + ' ' + Math.abs(f.oiChangePct).toFixed(2) + '%（近' + mins + 'm）';
      }
    }
    if (f.longRatio != null) flow.longRatio = f.longRatio;
    if (f.taker != null) flow.taker = f.taker;
    if (f.topLongRatio != null) {
      flow.whale = '大户多空账户多占比 ' + f.topLongRatio.toFixed(1) + '%' +
        (f.longRatio != null ? '（散户 ' + f.longRatio.toFixed(1) + '%，' + (f.topLongRatio > f.longRatio ? '大户更偏多' : f.topLongRatio < f.longRatio ? '大户更偏空' : '一致') + '）' : '');
    }
    ctx.flow = flow;
    ctx.rawFlow = f;
  } catch (e) { ctx.errs.push('盘口: ' + String((e && e.message) || e)); }
  try {
    const news = await fetchJevNews(cfg.newsSrc, opts.newsOpts);
    if (news && news.items && news.items.length) {
      const sent = newsSentiment(news.items);
      ctx.ext.news = { sentiment: sent.sentiment, bullishCount: sent.bullishCount, bearishCount: sent.bearishCount, title: news.items[0] && news.items[0].title, source: news.source };
    }
  } catch (e) { ctx.errs.push('新闻: ' + String((e && e.message) || e)); }
  ctx.fill = flowFillSummary(ctx.rawFlow, ctx.ext);
  return ctx;
}

// ---------------------------------------------------------------------------
// 执行一轮判断
// ---------------------------------------------------------------------------
export async function runJevOnce(opts = {}) {
  const cfg = readJevCfg();
  if (!cfg.enabled && !opts.force) return { ok: false, err: '未启用' };
  const sym = opts.sym || (kapi() && kapi().getConfig ? kapi().getConfig().symbol : null);
  if (!sym) return { ok: false, err: '无交易对' };
  const cc = await jevCallCfg();
  if (!cc.apiKey) return { ok: false, err: '未填写 Token' };
  _status.running = true;
  try {
    // 一次性取盘口/新闻（避免每档重复联网）；拿不到就是「未知」
    const ctx = opts.ctx || await collectJevContext(sym, opts);
    const enabled = cfg.horizons || {};
    const merged = [];
    for (const h of JEV_HORIZON_IDS) {
      if (enabled[h] === false) continue;
      const inp = gatherJevInput(sym, h, ctx);
      const s2 = buildJevState(inp);
      merged.push({ h, text: s2.text, missing: s2.missing });
    }
    if (!merged.length) throw new Error('至少勾选一个周期档');
    const stateText = merged.map(m => m.text).join('\n\n');
    const body = buildJevBody({ model: cfg.model, template: cfg.template, questions: cfg.questions, enabled }, stateText);
    const t0 = Date.now();
    const r = await decisionCall(cc, body);
    const parsed = parseJevResponse(r.json, { levels: JEV_LEVELS });
    const inTok = (r.usage && (r.usage.input_tokens || r.usage.prompt_tokens)) || estimateTokens(JSON.stringify(body));
    const outTok = (r.usage && (r.usage.output_tokens || r.usage.completion_tokens)) || 0;
    const cost = (inTok / 1e6) * (cfg.price.inPer1M || 0) + (outTok / 1e6) * (cfg.price.outPer1M || 0);
    // 累计
    cfg.spend = cfg.spend || {};
    cfg.spend.calls = (cfg.spend.calls || 0) + 1;
    cfg.spend.inTok = (cfg.spend.inTok || 0) + inTok;
    cfg.spend.outTok = (cfg.spend.outTok || 0) + outTok;
    cfg.spend.cost = (cfg.spend.cost || 0) + cost;
    cfg.lastRunTs = Date.now();
    cfg.flow = ctx.flow || null;
    cfg.lastFill = ctx.fill || null;
    writeJevCfg(cfg);
    // 落库（含待回填样本）
    const samples = (cfg.mode && cfg.mode !== 'off') ? jevSamplesFor(parsed, sym, Date.now()) : [];
    const rec = {
      id: sym + '|' + Date.now() + '|' + Math.random().toString(36).slice(2, 7),
      ts: Date.now(), sym, model: r.json && r.json.model || cfg.model,
      ms: Date.now() - t0, inTok, outTok, cost,
      driver: parsed.driver, dirs: parsed.horizons,
      mode: cfg.mode || 'off', samples, entry: {}, matured: false, outcomes: null,
      err: parsed.ok ? null : (parsed.err || '解析失败')
    };
    // 记录每个档的入场价 + ATR（用于到期判盈亏）
    for (const h of JEV_HORIZON_IDS) {
      if (!rec.dirs[h]) continue;
      const ev = JEV_EVAL[h];
      const s = S();
      const closes = (s.klines && s.klines[sym] && s.klines[sym][ev.tf]) || null;
      const ind = (s.indicators && s.indicators[sym] && s.indicators[sym][ev.tf]) || null;
      if (Array.isArray(closes) && closes.length) {
        let atr = ind && ind.current && ind.current.atr ? ind.current.atr : null;
        if (atr == null) { try { const a = atrClose(closes, 14); atr = a[a.length - 1]; } catch (e) { atr = null; } }
        rec.entry[h] = { tf: ev.tf, price: closes[closes.length - 1], atr, ts: Date.now() };
      }
    }
    await putDecision(rec);
    await trimDecisions();
    _status.lastRun = Date.now(); _status.lastErr = parsed.ok ? null : parsed.err;
    const res = { ok: parsed.ok, rec, parsed, stateText, missing: merged.reduce((a, m) => a.concat(m.missing), []) };
    _status.lastResult = res;
    return res;
  } catch (e) {
    _status.lastErr = String((e && e.message) || e);
    return { ok: false, err: _status.lastErr };
  } finally {
    _status.running = false;
  }
}

// ---------------------------------------------------------------------------
// 到期回填 + TSEV 喂样
// ---------------------------------------------------------------------------
/** 用当前已加载的 K 线，判定一条记录某档的前向盈亏；返回 {win, side} 或 null（未到期/无法判定） */
export function evalDecisionHorizon(rec, h) {
  const dir = rec && rec.dirs && rec.dirs[h];
  if (!dir || dir.strength == null) return null;
  const ev = JEV_EVAL[h];
  const side = dir.strength >= JEV_SIDE_THR ? 1 : dir.strength <= -JEV_SIDE_THR ? -1 : 0;
  if (!side) return null;
  const e = rec.entry && rec.entry[h];
  if (!e || !(e.price > 0) || !(e.atr > 0)) return null;
  const s = S();
  const closes = (s.klines && s.klines[rec.sym] && s.klines[rec.sym][ev.tf]) || null;
  const times = (s.klinesT && s.klinesT[rec.sym] && s.klinesT[rec.sym][ev.tf]) || null;
  if (!Array.isArray(closes) || !closes.length) return null;
  let idx = closes.length - 1;
  if (Array.isArray(times) && times.length === closes.length) {
    let found = -1;
    for (let i = times.length - 1; i >= 0; i--) { if (times[i] <= rec.ts) { found = i; break; } }
    idx = found;            // 决策时刻对应的 bar
  }
  if (idx < 0) return null;                        // 该 bar 已滚出窗口
  const need = Math.min(idx + ev.bars, closes.length - 1);
  if (need - idx < ev.bars) return null;           // 还没走满到期根数
  const atrArr = [];
  for (let i = 0; i <= need; i++) atrArr.push(e.atr);   // 用决策时的 ATR 作固定止损/止盈距离
  const r = winLossByAtr(closes.slice(0, need + 1), atrArr, {
    entryIdx: idx, direction: side === 1 ? 'buy' : 'sell',
    tpAtr: THRESH.BT_TP_ATR, slAtr: THRESH.BT_SL_ATR, horizon: ev.bars
  });
  if (!r || r.win === 0 || r.win == null) return { win: 0, side, pnlPct: (r && r.pnlPct) != null ? r.pnlPct : null, bars: ev.bars, tf: ev.tf };
  return { win: r.win, side, pnlPct: r.pnlPct, bars: r.barsHeld, tf: ev.tf, exitDir: r.exitDir };
}

// 方向档阈值（|强度| ≥ 此值才算「有方向」；与 jevState.jevSide 保持一致）
export const JEV_SIDE_THR = 15;

/**
 * 纯函数：算出该记录本次应回填的结果与应喂的样本。
 * ⭐ `rec.fed`（已喂过的档）保证**每个档的样本只喂一次**、绝不会重复计数。
 *   —— v1.6.59 修复：旧实现只要 `rec.matured` 为 false 就在**每个 5min tick** 重喂已到期档的样本
 *   （短档 24h 到期、长档 30 天到期 ⇒ 短档样本会被重复喂上千次，直接污染 TSEV 命中率）。
 * ⭐ `hit = (win === 1)`：`evalDecisionHorizon` 把 Jev 判的方向作为 `winLossByAtr.direction` 传入，
 *   所以 `win=1` **本身就是「判对了」**（做空时 win=1 = 价格先跌到 TP）。
 *   —— v1.6.59 修复：旧实现写成 `(win===1 && side==='long') || (win===-1 && side==='short')`，
 *   **把所有做空判断的胜败弄反了**（会反向学习）。
 * ⭐ 中性档（|强度| < JEV_SIDE_THR）**不参与评估/结算** → 否则「全是中性」的记录会永远挂在「待回填」。
 */
export function planMaturation(rec, evalFn) {
  const outcomes = {};
  let allDone = true;
  for (const h of JEV_HORIZON_IDS) {
    const d = rec && rec.dirs && rec.dirs[h];
    if (!d || d.strength == null) continue;
    if (!(d.strength >= JEV_SIDE_THR || d.strength <= -JEV_SIDE_THR)) continue;   // 中性档不结算
    const o = evalFn(rec, h);
    if (!o) { allDone = false; continue; }
    outcomes[h] = o;
  }
  const fed = Object.assign({}, (rec && rec.fed) || {});
  const toFeed = [];
  for (const smp of ((rec && rec.samples) || [])) {
    if (!smp || !smp.horizon || fed[smp.horizon]) continue;
    const o = outcomes[smp.horizon];
    if (!o) continue;                        // 该档尚未到期 → 下次再看
    fed[smp.horizon] = true;                 // 无论胜败，只看一次
    if (o.win === 0) continue;               // 到期未触发 → 不计入样本
    toFeed.push(Object.assign({}, smp, { win: o.win, hit: o.win === 1 }));
  }
  return { outcomes, allDone, fed, toFeed, anyOutcome: Object.keys(outcomes).length > 0 };
}

/** 回填所有到期记录；每个样本只喂一次。返回 {matured, fed} */
export async function matureDecisions() {
  const d = await db();
  if (!d) return { matured: 0, fed: 0 };
  const all = await listDecisions(9999);
  const localLoop = globalThis.__localTsev || null;
  const canFeed = !!(localLoop && typeof localLoop.recordJevSample === 'function');
  let matured = 0, fed = 0;
  for (const rec of all) {
    if (rec.matured) continue;
    const plan = planMaturation(rec, evalDecisionHorizon);
    if (!plan.anyOutcome && !plan.allDone) {
      // 可能因 K 线滚出窗口永远无法判定 → 超过 120 天标记为过期
      if (Date.now() - rec.ts > 120 * 86400000) { rec.matured = true; rec.outcomes = {}; rec.expired = true; await putDecision(rec); matured++; }
      continue;
    }
    if (canFeed && plan.toFeed.length) {
      for (const smp of plan.toFeed) {
        const sideNum = smp.side === 'long' ? 1 : -1;
        try { localLoop.recordJevSample(rec.sym, rec.ts, smp.horizon, sideNum, smp.hit ? 1 : 0); fed++; } catch (e) { /* 单条失败不影响其它 */ }
      }
    }
    rec.fed = plan.fed;
    rec.outcomes = plan.outcomes;
    rec.matured = plan.allDone;
    if (plan.allDone) matured++;
    await putDecision(rec);
  }
  return { matured, fed };
}

/** 分档统计（命中率/平均盈亏）+ 本机 TSEV 已学到的 jev 因子权重 */
export function jevStats(decisions, sym) {
  const rows = (decisions || []).filter(r => !sym || r.sym === sym);
  const out = { n: rows.length, byHorizon: {}, learned: {}, fedN: 0 };
  for (const h of JEV_HORIZON_IDS) out.byHorizon[h] = { n: 0, wins: 0, losses: 0, expired: 0, sumPnl: 0, winRate: null, avgPnl: null, conf: 0 };
  for (const r of rows) {
    const oc = r.outcomes || {};
    for (const h of JEV_HORIZON_IDS) {
      const o = oc[h];
      if (!o) continue;
      const b = out.byHorizon[h];
      if (o.win === 0) { b.expired++; continue; }
      b.n++;
      if (o.win === 1) b.wins++; else b.losses++;
      if (o.pnlPct != null) b.sumPnl += o.pnlPct;
      if (r.dirs && r.dirs[h] && r.dirs[h].conf != null) b.conf += r.dirs[h].conf;
    }
  }
  for (const h of JEV_HORIZON_IDS) {
    const b = out.byHorizon[h];
    if (b.n) { b.winRate = b.wins / b.n; b.avgPnl = b.sumPnl / b.n; }
    b.avgConf = b.n ? b.conf / b.n : null;
  }
  // 本机 TSEV：已学到的 jev 权重（两个方向分别看）+ 未达门槛时的样本进度
  // 注意 localLoop.getWeights() 返回 { perSym:{ [sym]: {'name|cond|side':w} }, n }（不接受参数）
  out.progress = {};
  for (const h of JEV_HORIZON_IDS) out.progress[h] = { long: null, short: null };
  try {
    const local = globalThis.__localTsev;
    if (local && local.getWeights) {
      const r = local.getWeights();
      const perSym = (r && r.perSym && typeof r.perSym === 'object') ? r.perSym : (r && r[sym] ? r : null);
      const W = (perSym && perSym[sym]) || {};
      for (const h of JEV_HORIZON_IDS) {
        const wl = W['jev|' + h + '|1'], ws = W['jev|' + h + '|-1'];
        out.learned[h] = { long: wl != null ? wl : null, short: ws != null ? ws : null };
      }
      if (local.debugTsev) {
        const dbg = local.debugTsev(sym) || [];
        const jevRows = dbg.filter(x => String(x.key || '').indexOf('jev|') === 0);
        out.fedN = jevRows.reduce((a, x) => a + ((x.n || 0) | 0), 0);
        // 样本进度：面板用它回答「怎样才能生效」（门槛 LOCAL_FACTOR_MIN=50）
        for (const x of jevRows) {
          const seg = String(x.key).split('|');   // jev | horizon | side
          const h = seg[1], sd = Number(seg[2]);
          if (!out.progress[h]) continue;
          out.progress[h][sd === 1 ? 'long' : 'short'] = { n: x.n || 0, p: x.p != null ? x.p : null, w: x.w != null ? x.w : null, passed: !!x.passed };
        }
      }
      out.weightsSource = 'local';
      out.minSample = 50;
    }
  } catch (e) { /* 学习信息缺失不影响统计 */ }
  // 样本数（未成熟样本数）
  out.pending = rows.filter(r => !r.matured).length;
  return out;
}

// 供 kchartApp 定时调用：到期回填（节流 5min）
let _lastMature = 0;
export async function tickJevMature(force) {
  const now = Date.now();
  if (!force && now - _lastMature < 5 * 60000) return null;
  _lastMature = now;
  try {
    const r = await matureDecisions();
    if (r && (r.matured || r.fed)) emitJevChange();
    return r;
  } catch (e) { return null; }
}

// ---------------------------------------------------------------------------
// 自动调度（由 kchartApp 的每秒循环调用；内部按 frequency + lastRunTs 节流）
// ---------------------------------------------------------------------------
const FREQ_MS = { '15m': 900000, '1h': 3600000, '4h': 14400000, '1d': 86400000, manual: 0 };let _schedBusy = false;
let _schedLastAttempt = 0;   // 无论成败都记（防失败时每秒重试刷屏）
const _listeners = [];
export function onJevChange(cb) { if (typeof cb === 'function') _listeners.push(cb); }
function emitJevChange() { for (const cb of _listeners) { try { cb(); } catch (e) { /* 单个订阅者失败不影响其它 */ } } }

/** 到点则自动跑一轮判断（手动模式不自动跑）。启用后立即跑第一次，之后按频率。永不抛错、不写控制台。 */
export function jevSchedulerTick() {
  let cfg;
  try { cfg = readJevCfg(); } catch (e) { return; }
  if (!cfg.enabled) return;
  const ms = FREQ_MS[cfg.freq] || 0;
  if (!ms) return;
  const now = Date.now();
  const last = Math.max(cfg.lastRunTs || 0, _schedLastAttempt);
  if (now - last < ms) return;
  if (_schedBusy) return;
  _schedBusy = true;
  _schedLastAttempt = now;
  runJevOnce({}).finally(() => { _schedBusy = false; emitJevChange(); });
}

/** 测试钩子：调度器内部状态（仅用于单测断言节流行为） */
export function __jevSchedState() {
  return { busy: _schedBusy, lastAttempt: _schedLastAttempt };
}

export function jevStatus() {
  return Object.assign({}, _status, { hasToken: _status.keyPresent });
}
