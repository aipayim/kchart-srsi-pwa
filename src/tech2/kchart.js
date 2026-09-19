// ===== K线分析 页面（全新实现，独立于 技术分析 techChart/techPanel）=====
// 复用公开纯函数与数据源，自建精简渲染：
//   - 顶部：交易对 + K线周期多选（决定 SRSI 多子图）+ 主图周期单选 + 根线数 + 子图顺序 + SRSI 参数
//   - 主图：真 OHLC 蜡烛（数据取自 S.klinesO/H/L 与 S.klines（close））
//   - 子图：RSI / SRSI / MACD（顺序可拖拽），SRSI 对每个勾选 K 线周期渲染短→长堆叠
import { srsiKD, srsiCrossings, srsiHooks, srsiSignal, ema, atrClose, ais, detectRegimeState, barsFromPinch, insufficientMsg, srsiTurnLag, srsiExtremumRate, pickLeadParams, srsiProjectLive } from '../engine/indicators.js';
import { optimizeSrsi, srsiNeighborhoodGrid, srsiParamGrid, optimizeSrsiBand, optimizeGateBand, rollingGateOos, bandNeighborTPos, MANUAL_SWING_PARAMS, manualSwingParams, DEFAULT_SRSI_BAND, GATE_PARAMS_GRID } from '../engine/srsiOptimizer.js';
import { fetchKlinesRange, fetchFundingRate } from '../pwa/data.js';
import { runBacktest as alphaRunBacktest } from '../pwa/alphaCore.js';
export { fetchKlinesRange, fetchFundingRate };
import { KLINE_TF, KLINE_MINUTES, KLINE_INTERVAL, resample } from '../engine/timeframe.js';
import { THRESH } from '../engine/thresholds.js';
import { pushSignalEvent } from './signalAlerts.js';
import { buildMaRelation, MA_REL_DEFAULTS } from '../engine/maRelation.js';
import { adaptiveLeverage, medianOf, protectiveStopPrice, updateAtrMedian } from '../engine/adaptiveRisk.js';
import { getFeeRate } from '../engine/fees.js';
import { liquidationPrice } from '../engine/liquidation.js';
import { fundingPayment, FUNDING_HOURS } from '../engine/funding.js';
import { regimeStrategy } from '../engine/regimeParams.js';
import { updateRuleMonitorTick, renderRuleMonitor, kToggleRuleMonitor, ruleMonitorClear, ruleOptimizeRun, ruleOptimizeApply, ruleVersionSwitch, __ruleMonitorTestState, hudClampPos } from './ruleMonitor.js';
import { TSEV_CFG, extractDisciplineFactors, trainTsevWeights, voteTsev, parseJsonl, combineWeights } from '../engine/disciplineAnalysis.js';

// ---- TSEV 权重（全局：dev 下 /data 训练 或 生产 /tsev-weights.json 快照；本机：IndexedDB 由 localLoop 训练）----
let _tsevWeights = {};     // { [sym]: { 'name|cond|side': logitWeight } }（按币种分别训练）
let _tsevLoading = false;
let _tsevInfo = { globalN: 0, localN: 0, source: 'classic', perSym: {} };
let _tsevEnabled = true;   // 主程序设置页可开关；关闭后纪律分析回退纯经典逻辑、本机 loop 停止
export function setTsevEnabled(v) {
  _tsevEnabled = !!v;
  if (!_tsevEnabled) { _tsevWeights = {}; _tsevInfo = { globalN: 0, localN: 0, source: 'disabled', perSym: {} }; }
}
export function isTsevEnabled() { return _tsevEnabled; }
export function getTsevWeights(sym) { return _tsevEnabled ? ((sym && _tsevWeights[sym]) || {}) : {}; }
export function getTsevInfo() { return _tsevInfo; }

// 读取本机权重（由 src/pwa/localLoop.js 注册到 globalThis.__localTsev）。浏览器才有，Node 环境返回 null。
async function loadLocalTsevWeights() {
  try {
    const api = (typeof globalThis !== 'undefined') && globalThis.__localTsev;
    if (api && typeof api.getWeights === 'function') return await api.getWeights(); // {perSym, n}
  } catch { /* 忽略 */ }
  return null;
}

// 全局权重：dev 下 /data/discipline-factors.jsonl 训练；生产回退到静态 /tsev-weights.json（由 gen-tsev-weights.mjs 生成）。
async function loadGlobalTsevWeights() {
  if (typeof fetch !== 'function') return { weights: {}, n: 0 };
  // dev：用原始 jsonl 现场训练（含最新样本）
  const dt = await fetch('/data/discipline-factors.jsonl').then(r => (r && r.ok ? r.text() : null)).catch(() => null);
  if (dt) {
    const rows = parseJsonl(dt).filter(r => Array.isArray(r.factors) && r.fut);
    if (rows.length) return { weights: trainTsevWeights(rows, { horizon: 'h4', MIN_SAMPLE: TSEV_CFG.MIN_SAMPLE, Z_THRESH: TSEV_CFG.Z_THRESH }), n: rows.length };
  }
  // 生产：静态快照（no-store 避免 SW 缓存旧权重）
  const jt = await fetch('/tsev-weights.json', { cache: 'no-store' }).then(r => (r && r.ok ? r.json() : null)).catch(() => null);
  if (jt && jt.weights) return { weights: jt.weights, n: jt.n || 0 };
  return { weights: {}, n: 0 };
}

// 合并：本机优先（本机样本≥阈值用本机，否则全局，否则经典兜底）。
let _globalWeights = { weights: {}, n: 0 };
export async function loadTsevWeights(force) {
  if (_tsevWeights && !force) return _tsevWeights;
  if (_tsevLoading) return _tsevWeights;
  _tsevLoading = true;
  try {
    const g = await loadGlobalTsevWeights();
    _globalWeights = g;
    await refreshLocalTsev();
  } catch {
    _tsevWeights = {};
    _tsevInfo = { globalN: 0, localN: 0, source: 'classic' };
  } finally {
    _tsevLoading = false;
  }
  return _tsevWeights;
}

// 仅重新读取本机样本并合并（不再拉取全局权重，避免每帧网络开销）。本机 loop 训练后调用以即时反映样本量/权重源。
// 权重按币种分别合并：本机某币样本达标 → 用本机该币权重；否则回退全局池化权重。
export async function refreshLocalTsev() {
  const l = await loadLocalTsevWeights().catch(() => null);
  const localPerSym = (l && l.perSym) || {};
  const localN = (l && l.n) || 0;
  const merged = {};
  const perSymInfo = {};
  const gw = _globalWeights.weights || {};
  const gwCount = gw ? Object.keys(gw).filter(k => !k.startsWith('__')).length : 0;
  for (const sym in localPerSym) {
    const lw = localPerSym[sym];
    if (lw && Object.keys(lw).filter(k => !k.startsWith('__')).length && localN >= TSEV_CFG.LOCAL_MIN_SAMPLE) {
      merged[sym] = lw;
      perSymInfo[sym] = { source: 'local', n: localN, factorCount: Object.keys(lw).filter(k => !k.startsWith('__')).length };
    } else {
      merged[sym] = gw;
      perSymInfo[sym] = { source: gwCount ? 'global' : 'classic', n: _globalWeights.n, factorCount: gwCount };
    }
  }
  _tsevWeights = merged;
  const anyLocal = Object.keys(localPerSym).length > 0;
  _tsevInfo = {
    globalN: _globalWeights.n,
    localN,
    source: anyLocal ? 'local' : (gwCount ? 'global' : 'classic'),
    perSym: perSymInfo
  };
  return _tsevWeights;
}

// ---- 逻辑画布尺寸：宽固定，高随子图数量自适应 ----
const W = 1000;
const PAD_L = 64, PAD_R = 12;
const PAD_T = 14, PAD_B = 16;
const MAIN_H = 320;          // 主图固定高度
const SUB_H = 120;           // 每个 RSI/SRSI/MACD 子图高度
const SUB_GAP = 22;          // 子图标题栏+间距
const STATUS_H = 22;         // GOAL21：主图底部状态带（组合实盘/α 信号角标专用，不再压 K 线与 SRSI 带）
const BASE_H = MAIN_H + PAD_T + PAD_B + STATUS_H;

const STATE_KEY = 'smartTrader_kchart';

const DEFAULT_SRSI = { rsiPeriod: 85, stochPeriod: 50, smoothK: 10, smoothD: 5, overbought: 80, oversold: 20 };
// 历史脏值哨兵：早期版本把通用默认 {85,50,10,5,80,20} 误填进 7d/30d，迁移时需识别并改回长周期特例(14/6)。
// 注意：这是"曾经的默认"，与上方 DEFAULT_SRSI(新默认) 不同，迁移检测必须用此旧哨兵。
const OLD_DEFAULT_SRSI = { rsiPeriod: 85, stochPeriod: 50, smoothK: 10, smoothD: 5, overbought: 80, oversold: 20 };
function isOldDirtySrsi(x) {
  return !!x && x.rsiPeriod === OLD_DEFAULT_SRSI.rsiPeriod && x.stochPeriod === OLD_DEFAULT_SRSI.stochPeriod &&
    x.smoothK === OLD_DEFAULT_SRSI.smoothK && x.smoothD === OLD_DEFAULT_SRSI.smoothD &&
    x.overbought === OLD_DEFAULT_SRSI.overbought && x.oversold === OLD_DEFAULT_SRSI.oversold;
}

// 最近一次「参数优选」所覆盖的时间窗口（按币对+周期记录），用于回测前的泄漏自检：
// 若回测窗口落在优选窗口内，则优选在 in-sample 上挑参、回测又在同一段上验证 → 过拟合泄漏，结果不可信。
let _lastOptWindow = null;
export function getLastOptWindow() { return _lastOptWindow; }
export function setLastOptWindow(w) { _lastOptWindow = w; }
export function checkOptBacktestLeak(sym, from, to) {
  if (!_lastOptWindow || _lastOptWindow.sym !== sym) return null;
  const o = _lastOptWindow;
  if (to < o.from || from > o.to) return null; // 不重叠
  const contained = from >= o.from && to <= o.to;
  const pct = Math.round((Math.min(to, o.to) - Math.max(from, o.from)) / ((to - from) || 1) * 100);
  return contained
    ? `回测窗口[${fmtDate(from)}~${fmtDate(to)}] 完全落在优选窗口[${fmtDate(o.from)}~${fmtDate(o.to)}]内 → 优选过拟合泄漏，结果不可信`
    : `回测窗口与优选窗口重叠 ${pct}% → 可能存在优选过拟合泄漏`;
}

// 7d/30d 为「日线聚合」特例：7d=每7根日线合1根(≈71点)、30d=每30根合1根(≈16点)，
// 点太少无法支撑大 RSI/Stoch 预热；故长周期默认用短参数，保证 K/D 能铺满。
// 这是 7d/30d 的"出厂默认"，用户可在设置卡自由改（但改太大仍会因预热不足显示 --）。
const LONG_TF_SRSI = {
  '7d': { rsiPeriod: 14, stochPeriod: 14, smoothK: 3, smoothD: 3, overbought: 80, oversold: 20 },
  '30d': { rsiPeriod: 6, stochPeriod: 6, smoothK: 2, smoothD: 2, overbought: 80, oversold: 20 },
};

// 每周期独立 SRSI 参数默认值：7d/30d 用长周期特例，其余沿用 DEFAULT_SRSI。
function buildSrsiByTf() {
  const m = {};
  KLINE_TF.forEach(tf => { m[tf] = LONG_TF_SRSI[tf] ? { ...LONG_TF_SRSI[tf] } : { ...DEFAULT_SRSI }; });
  return m;
}

// 判断某 SRSI 参数对象是否等于通用默认（用于识别 7d/30d 被错误填充的脏值）
function isDefaultSrsi(x) {
  return !!x && x.rsiPeriod === DEFAULT_SRSI.rsiPeriod && x.stochPeriod === DEFAULT_SRSI.stochPeriod &&
    x.smoothK === DEFAULT_SRSI.smoothK && x.smoothD === DEFAULT_SRSI.smoothD &&
    x.overbought === DEFAULT_SRSI.overbought && x.oversold === DEFAULT_SRSI.oversold;
}

// ===================== 信号守望 + 引擎状态（2026-09-18 审计修复）=====================
// 审计结论：用户「一整天看不到任何交易信号」的真因是 4 个开关分散在 3 个 tab 且默认全关，
// 而驾驶舱用装饰性徽章假装在跑。本段提供：①与自动交易开关**无关**的带边沿守望（影子状态，
// 不推进实盘状态机）→ 信号一出现就进提醒总线；②引擎真实状态 + 阻塞原因（供 UI 如实展示/一键启动）。
const _sigWatch = {};   // sym → { band, armed, barT }（影子状态，绝不与 srsiAutoBandState 共用）

// 始终开启的信号守望：用纯函数 bandEdge 跑 15m 带态影子机，检测「带边沿」与「预演将破带」并推入提醒总线。
// 注意：只读 getTFData + buildSrsiOverview，不调 srsiAutoBandState（后者会推进实盘状态机）。
export function updateSignalWatch(sym) {
  sym = sym || cfg.symbol;
  const d15 = getTFData(sym, '15m');
  const c = d15.c || [], t = d15.t || [];
  if (c.length < 60) return null;
  const cfg15 = perTfSrsi('15m', cfg.srsiByTf, cfg.srsi);
  let r = null;
  try { r = (buildSrsiOverview(['15m'], () => cfg15, { '15m': c }).rows || [])[0]; } catch (e) { r = null; }
  if (!r || r.k == null || r.d == null) return null;
  const S = typeof window !== 'undefined' ? window.S : null;
  const price = (S && S.prices && S.prices[sym] && isFinite(S.prices[sym].last)) ? S.prices[sym].last : null;
  const barT = t.length ? t[t.length - 1] : null;
  const _eb = resolveEntryBands(cfg);
  const first = !_sigWatch[sym];
  const prev = _sigWatch[sym] || { band: null, armed: false };
  const be = bandEdge(prev.band, r.k, r.d, { upper: _eb.upper, lower: _eb.lower }, prev.armed);
  const _prevOppT = prev.oppT || null;
  _sigWatch[sym] = { band: be.band, armed: be.armed, barT, k: r.k, d: r.d, oppT: _prevOppT };
  // 首次观测只建基线（避免把页面打开前的历史边沿当新信号）
  if (!first && be.edge) {
    pushSignalEvent({
      sym, kind: be.edge === 'enterUpper' ? 'srsi-edge-upper' : 'srsi-edge-lower',
      side: be.edge === 'enterUpper' ? 'short' : 'long', price, barT, src: 'watch',
      text: 'K=' + r.k.toFixed(1) + ' D=' + r.d.toFixed(1) + ' · 15m ' + (be.band === 'upper' ? '上带' : '下带')
    });
  }
  // 预演：进行中 bar 若此刻收盘会进带（尚未确认）——把「破带」提前最多 15 分钟告知（每根 bar 去重）
  try {
    const proj = srsiProjectLive(c, cfg15, price);
    if (proj && proj.k != null && (proj.willCrossUp || proj.willCrossDown)) {
      pushSignalEvent({
        sym, kind: 'srsi-preview', side: proj.willCrossUp ? 'short' : 'long', price, barT, src: 'watch',
        text: (proj.willCrossUp ? '若此刻收盘进超买带' : '若此刻收盘进超卖带') + ' K=' + proj.k.toFixed(1)
      });
    }
  } catch (e) { /* 预演非致命 */ }
  // v1.6.25：主图「机会点/钩」也入「最近信号」（用户要求：只要主图有信号都入流）
  // 只在**已收盘**的 15m bar 上入流（避免进行中 bar 反复重绘造成刷屏；进行中的破带已由上面 srsi-preview 覆盖），
  // 同一根 bar 只入一次（oppT 去重）。
  try {
    const closedT = t.length >= 2 ? t[t.length - 2] : null;
    if (closedT != null && _prevOppT !== closedT) {
      const opps = mainOpportunityMarks(sym);
      let hit = null;
      for (let i = opps.length - 1; i >= 0; i--) { if (opps[i].t === closedT) { hit = opps[i]; break; } }
      _sigWatch[sym].oppT = closedT;
      if (hit) {
        const isHook = hit.kind === 'hook';
        pushSignalEvent({
          sym, side: hit.side, price, barT: closedT, src: 'watch',
          kind: isHook ? (hit.side === 'long' ? 'srsi-hook-gold' : 'srsi-hook-death')
            : (hit.side === 'long' ? 'srsi-cross-buy' : 'srsi-cross-sell'),
          text: (isHook ? '钩信号' : '穿越信号') + ' · 15m 收盘确认'
        });
      }
    }
  } catch (e) { /* 机会点入流非致命 */ }
  return { band: be.band, edge: be.edge, k: r.k, d: r.d, barT };
}

// 引擎真实状态（供驾驶舱/主图状态带如实展示；blockers 为「为什么不会有信号」）
// 2026-09-18 补充：引擎开关与 15m 优选都是**按币对独立**的；Alpha 信号按币对缓存。
// 因此必须把「当前币对 / 实盘标的 / 基石区数据属于哪个币对」一并暴露，否则切币对后 UI 会说谎。
export function signalEngineStatus() {
  const sym = cfg.symbol;
  const optReady15m = !!(cfg.srsiOptSource && cfg.srsiOptSource['15m'] === 'optimized');
  const srsiAutoOn = !!cfg.srsiAutoOn;
  const alphaSignalOn = !!cfg.alphaSignalOn;
  const bySym = (typeof window !== 'undefined' && window.__alphaSignalsBySym) || {};
  const mine = bySym[sym] || null;
  const g = (typeof window !== 'undefined' && window.__alphaSignals) || null;
  const alphaDataSym = mine ? sym : ((g && g.sym) ? g.sym : null);
  const alphaData = !!mine;
  const alphaStale = !mine && !!(g && g.sym && g.sym !== sym);
  const alphaLive = !!(typeof window !== 'undefined' && window.__alphaLab && typeof window.__alphaLab.isLive === 'function' && window.__alphaLab.isLive());
  let liveSym = null;
  try { liveSym = (typeof window !== 'undefined' && window.__alphaLab && window.__alphaLab.liveSymbol) ? window.__alphaLab.liveSymbol() : null; } catch (e) { liveSym = null; }
  const liveElsewhere = !!(alphaLive && liveSym && liveSym !== sym);
  const blockers = [];
  if (!srsiAutoOn) blockers.push('本币对（' + sym + '）SRSI 卫星自动交易未开启');
  else if (!optReady15m) blockers.push('本币对 15m 未优选 → 卫星被硬约束禁止开仓（可一键自动优选）');
  if (!alphaSignalOn) blockers.push('本币对 Alpha 信号未计算（基石区/解读卡无数据）');
  else if (!alphaData) blockers.push('本币对 Alpha 信号计算中…');
  if (!alphaLive) blockers.push('Alpha 基石实盘(paper) 未启动');
  const srsiRunning = srsiAutoOn && optReady15m;
  const alphaLiveHere = !!(alphaLive && liveSym === sym);
  const runningHere = srsiRunning || alphaLiveHere;   // 本币对是否真有引擎在跑（驾驶舱/状态条以此为准）
  // v1.6.16：最近一次拦截原因（仅在本币对卫星已开时有效；未开则为 null）
  const autoSt = _srsiAuto[sym] || null;
  const lastBlock = (autoSt && autoSt.lastBlock) ? autoSt.lastBlock : null;
  return {
    sym, srsiAutoOn, optReady15m, alphaSignalOn, alphaData, alphaDataSym, alphaStale, alphaLive, liveSym, liveElsewhere,
    srsiRunning, alphaRunning: alphaLive, alphaLiveHere, running: srsiRunning || alphaLive, runningHere, blockers,
    lastBlock, lastBlockText: lastBlock ? blockReasonText(lastBlock.reason) : null, lastBlockGuide: lastBlock ? blockGuideText(lastBlock.reason, sym) : null
  };
}

// ===================== SRSI 响应速度 / 领先模式（2026-09-18 诊断落地）=====================
// 诊断结论（BTCUSDT 90 天实测，见 AGENTS）：
//   · 由已实现价格算出的振荡器不可能「领先价格」；15m SRSI 破带/金叉事件对 5m 后市收益 |t|<2（≈无边际）。
//   · 用户真正感知到的「慢 / 错过机会」来自参数响应速度：默认 RSI85/Stoch50/%K10/%D5 的 K 转折
//     平均滞后价格 ~17 分钟（转折确认前价格已走掉 ~0.29%）；快参 R14/S14/K3 只滞后 ~4 分钟。
// 因此这里做三件事：①实测并展示「滞后分钟」；②一键「领先模式」（实测选最快且不过噪的参数）；
// ③实时预演（用当前价合成进行中 bar，提前看到带态变化）。
// ⚠ 仅用于展示与选参：zigzag 转折点依赖后续数据，禁止作为交易信号（防前视，AGENTS §5.17）。
const _leadCache = new Map();
function _tfBarMinutes(tf) {
  const t = (getTFData(cfg.symbol, tf).t) || [];
  if (t.length >= 2 && t[t.length - 1] > t[t.length - 2]) return Math.max(1, Math.round((t[t.length - 1] - t[t.length - 2]) / 60000));
  return Math.max(1, Math.round(tfMs(tf) / 60000));
}
// 实测该周期当前参数的「K 转折平均滞后分钟数」+ 极值占比（噪声）。结果按 币对|周期|参数|末价 缓存。
export function srsiSpeedInfo(tf, params) {
  if (!KLINE_TF.includes(tf) || !params) return null;
  const c = (getTFData(cfg.symbol, tf).c || []).slice();
  if (c.length < 120) return null;
  const barMin = _tfBarMinutes(tf);
  const key = [cfg.symbol, tf, params.rsiPeriod, params.stochPeriod, params.smoothK, params.smoothD, c.length, c[c.length - 1]].join('|');
  if (_leadCache.has(key)) return _leadCache.get(key);
  const k = srsiKD(c, params).k;
  const t = srsiTurnLag(k, c, { barMin });
  const info = { lagMin: t.lagMin, medMin: t.medMin, noise: srsiExtremumRate(k), n: t.n, missedPct: t.missedPct, barMin, turns: t.turnCount, theta: t.theta };
  if (_leadCache.size > 60) _leadCache.clear();
  _leadCache.set(key, info);
  return info;
}
// 速度分级：按「滞后分钟 / 周期长度」的比例（相对周期长度的滞后越少越快）。
export function speedGrade(info) {
  if (!info || !(info.n >= 5)) return { tag: '--', cls: 'na', text: '数据不足' };
  const ratio = info.barMin > 0 ? info.lagMin / info.barMin : 0;
  if (ratio <= 0.5) return { tag: '快', cls: 'fast', text: '快' };
  if (ratio <= 1.5) return { tag: '中', cls: 'mid', text: '中' };
  return { tag: '慢', cls: 'slow', text: '慢' };
}
// 把「滞后分钟」格式化成「N 根（≈时长）」——跨周期可比，避免 1h 显示「300 分钟」这种不好读的数。
export function fmtLag(info) {
  if (!info || !(info.n >= 5)) return '--';
  const bars = info.barMin > 0 ? info.lagMin / info.barMin : 0;
  const m = info.lagMin;
  let dur;
  if (m < 60) dur = m.toFixed(0) + ' 分钟';
  else if (m < 1440) dur = (m / 60).toFixed(1) + ' 小时';
  else dur = (m / 1440).toFixed(1) + ' 天';
  return bars.toFixed(1) + ' 根（≈' + dur + '）';
}
// 领先模式候选评估（带缓存）：返回 pickLeadParams 结果（无可用更快的候选时 null）。
export function srsiLeadInfo(tf, params) {
  if (!KLINE_TF.includes(tf) || !params) return null;
  const c = (getTFData(cfg.symbol, tf).c || []).slice();
  if (c.length < 120) return null;
  const key = ['lead', cfg.symbol, tf, params.rsiPeriod, params.stochPeriod, params.smoothK, params.smoothD, params.overbought, params.oversold, c.length, c[c.length - 1]].join('|');
  if (_leadCache.has(key)) return _leadCache.get(key);
  let pick = null;
  try {
    pick = pickLeadParams(c, {
      current: params, barMin: _tfBarMinutes(tf),
      bands: { overbought: params.overbought, oversold: params.oversold }
    });
  } catch (e) { pick = null; }
  if (_leadCache.size > 60) _leadCache.clear();
  _leadCache.set(key, pick);
  return pick;
}
// 领先模式：开启=用实测响应最快的参数（保留用户当前上下带）；关闭=原样恢复原参数。
export function setSrsiLead(tf, on) {
  tf = tf || cfg.srsiEditTf;
  if (!KLINE_TF.includes(tf)) return null;
  cfg.srsiLead = cfg.srsiLead || {}; cfg.srsiLeadPrev = cfg.srsiLeadPrev || {};
  if (on) {
    const cur = perTfSrsi(tf, cfg.srsiByTf, cfg.srsi);
    const pick = srsiLeadInfo(tf, cur);
    if (!pick) { logLead(`[${tf}] 无法启用领先模式：K 线不足或无可用的更快候选`); return null; }
    if (pick.improved === false) {
      logLead(`[${tf}] 领先模式未启用：当前参数已足够快（滞后 ${pick.baseLagMin != null ? pick.baseLagMin.toFixed(0) : '--'} 分钟，最优候选 ${pick.lagMin.toFixed(0)} 分钟）`);
      return { ...pick, applied: false };
    }
    if (!cfg.srsiLead[tf]) cfg.srsiLeadPrev[tf] = { ...cur };
    cfg.srsiByTf[tf] = { ...cur, ...pick.params };
    if (tf === cfg.srsiEditTf) cfg.srsi = { ...cfg.srsiByTf[tf] };
    cfg.srsiLead[tf] = true;
    logLead(`[${tf}] 领先模式：${cur.rsiPeriod}/${cur.stochPeriod}/${cur.smoothK}/${cur.smoothD} → ${pick.params.rsiPeriod}/${pick.params.stochPeriod}/${pick.params.smoothK}/${pick.params.smoothD}（实测滞后 ${pick.baseLagMin != null ? pick.baseLagMin.toFixed(0) : '--'} → ${pick.lagMin.toFixed(0)} 分钟）`);
    persist(); renderKChart(); if (typeof document !== 'undefined') renderControls();
    return { ...pick, applied: true };
  }
  const prev = cfg.srsiLeadPrev[tf];
  if (prev) { cfg.srsiByTf[tf] = { ...prev }; if (tf === cfg.srsiEditTf) cfg.srsi = { ...prev }; }
  delete cfg.srsiLead[tf]; delete cfg.srsiLeadPrev[tf];
  logLead(`[${tf}] 领先模式已关闭，参数恢复`);
  persist(); renderKChart(); if (typeof document !== 'undefined') renderControls();
  return null;
}
function logLead(msg) {
  try { console.log('[SRSI-LEAD] ' + msg); } catch (e) {}
  try { if (typeof window !== 'undefined' && typeof window.log === 'function') window.log('[SRSI-LEAD] ' + msg); } catch (e) {}
}

// SRSI 参数卡里的「响应速度」行：实测滞后分钟 + 速度分级 + 领先模式开关
// 文本节点带 id（kchartSpeedVal/kchartSpeedSub），供 updateSrsiSpeedRow 在 K 线就绪后就地刷新（不重建整张卡片）。
function srsiSpeedHtml(tf, ep) {
  const info = srsiSpeedInfo(tf, ep);
  const g = speedGrade(info);
  const leadOn = !!cfg.srsiLead[tf];
  const ok = info && info.n >= 5;
  const lagTxt = ok ? fmtLag(info) : '--';
  const sub = ok ? ('转折确认前已走 ' + (info.missedPct ? info.missedPct.toFixed(2) + '%' : '--') + ' · 样本 ' + info.n) : 'K 线不足，无法实测（等数据加载）';
  const lead = srsiLeadInfo(tf, ep);
  const noGain = !leadOn && !!lead && lead.improved === false;
  const btn = leadOn
    ? '<button class="kchart-srsi-btn kchart-speed-btn on" id="kchartSpeedBtn" onclick="window.kSetSrsiLead(\'' + tf + '\',false)">✓ 领先模式已开（点击关闭）</button>'
    : (noGain
      ? '<button class="kchart-srsi-btn kchart-speed-btn" id="kchartSpeedBtn" disabled title="当前参数已是实测较快档">已是较快档</button>'
      : '<button class="kchart-srsi-btn kchart-speed-btn" id="kchartSpeedBtn" onclick="window.kSetSrsiLead(\'' + tf + '\',true)">⚡ 开启领先模式</button>');
  return '<div class="kchart-srsi-speed">' +
    '<span class="kchart-speed-lbl">响应速度</span>' +
    '<span class="kchart-speed-val kchart-speed-' + g.cls + '" id="kchartSpeedVal">K 转折平均滞后 ' + lagTxt + ' · ' + g.text + '</span>' +
    '<span class="kchart-speed-sub" id="kchartSpeedSub">' + sub + '</span>' + btn +
  '</div>';
}

// 就地刷新「响应速度」行 + 领先模式按钮（K 线晚到 / 参数变化后无需重建整卡）。由 updateSrsiProjLive 每帧调用。
let _spdSig = '';
function updateSrsiSpeedRow() {
  const el = typeof document !== 'undefined' ? document.getElementById('kchartSpeedVal') : null;
  const sub = typeof document !== 'undefined' ? document.getElementById('kchartSpeedSub') : null;
  if (!el) return;
  const tf = cfg.srsiEditTf;
  const ep = perTfSrsi(tf, cfg.srsiByTf, cfg.srsi);
  const info = srsiSpeedInfo(tf, ep);
  const lead = srsiLeadInfo(tf, ep);
  const leadOn = !!cfg.srsiLead[tf];
  const noGain = !leadOn && !!lead && lead.improved === false;
  const sig = [tf, ep.rsiPeriod, ep.stochPeriod, ep.smoothK, ep.smoothD, info ? (info.n + ':' + info.lagMin.toFixed(1) + ':' + info.noise.toFixed(2)) : 'na', leadOn ? 'on' : (noGain ? 'nogain' : 'off')].join('|');
  if (sig === _spdSig) return;
  _spdSig = sig;
  const g = speedGrade(info);
  const ok = info && info.n >= 5;
  el.className = 'kchart-speed-val kchart-speed-' + g.cls;
  el.textContent = 'K 转折平均滞后 ' + (ok ? fmtLag(info) : '--') + ' · ' + g.text;
  if (sub) sub.textContent = ok ? ('转折确认前已走 ' + (info.missedPct ? info.missedPct.toFixed(2) + '%' : '--') + ' · 样本 ' + info.n) : 'K 线不足，无法实测（等数据加载）';
  const btn = typeof document !== 'undefined' ? document.getElementById('kchartSpeedBtn') : null;
  if (btn) {
    btn.disabled = noGain;
    if (leadOn) { btn.className = 'kchart-srsi-btn kchart-speed-btn on'; btn.textContent = '✓ 领先模式已开（点击关闭）'; btn.onclick = () => window.kSetSrsiLead(tf, false); }
    else if (noGain) { btn.className = 'kchart-srsi-btn kchart-speed-btn'; btn.textContent = '已是较快档'; btn.onclick = null; }
    else { btn.className = 'kchart-srsi-btn kchart-speed-btn'; btn.textContent = '⚡ 开启领先模式'; btn.onclick = () => window.kSetSrsiLead(tf, true); }
  }
}

// 机制说明（中文，前端讲清楚「为什么宽周期不能预判小周期」）
function srsiLeadNoteHtml() {
  return '<div class="kchart-srsi-note">' +
    '<b>为什么宽周期 SRSI 不能「预判」小周期？</b> ' +
    'SRSI 由<b>已经发生的价格</b>算出，数学上不可能领先价格（实测：15m 破带/金叉事件对 5m 后市的收益 ≈ 0，t 值 &lt; 2）。' +
    '你感受到的「慢 / 错过机会」来自<b>参数响应速度</b>——默认 RSI85/Stoch50/%K10/%D5 是低噪声慢速配置，K 转折平均滞后价格 ~17 分钟（价格已走掉约 0.29% 后信号才出现）。' +
    '开「⚡ 领先模式」改用实测响应最快的参数，转折滞后降到几分钟，代价是噪声/假信号变多。' +
    '正确用法：把宽周期 SRSI 当<b>情境过滤</b>（现在处在超买/超卖区），而不是价格预测器。' +
  '</div>';
}

// 盯盘页「领先模式 + 预演」行：优先主图叠加周期，否则辅助周期，否则主图周期。
// 只在「主图/辅助」这种跨周期叠加场景下最有意义（这正是用户「宽周期 SRSI 套小周期 K 线」的用法）。
function leadTfForDisplay() {
  const ov = overlayTfsList(cfg);
  if (ov.length) return ov[0];
  const aux = KLINE_TF.filter(tf => cfg.srsiAux[tf]);
  if (aux.length) return aux[0];
  return cfg.mainTF;
}
// 渲染盯盘页领先行的静态骨架（含 ids），内容由 updateSrsiProjLive 每帧就地刷新。
function updateOvLeadLive() {
  const el = typeof document !== 'undefined' ? document.getElementById('kchartOvLead') : null;
  if (!el) return;
  const tf = leadTfForDisplay();
  if (!el.dataset.tf || el.dataset.tf !== tf) {
    el.dataset.tf = tf;
    el.innerHTML = '<div class="kchart-ovlead-row"><span class="kchart-ovlead-lbl">⚡ 领先模式</span>' +
      '<span class="kchart-ovlead-tf">' + tf + '</span>' +
      '<span class="kchart-ovlead-spd" id="kchartOvLeadSpd">--</span>' +
      '<button class="kchart-srsi-btn kchart-ovlead-btn" id="kchartOvLeadBtn">⚡ 开启领先模式</button></div>' +
      '<div class="kchart-ovlead-proj" id="kchartOvLeadProj"></div>';
    _spdSig = '';  // 强制下一帧刷新文本
  }
  const ep = perTfSrsi(tf, cfg.srsiByTf, cfg.srsi);
  const info = srsiSpeedInfo(tf, ep);
  const lead = srsiLeadInfo(tf, ep);
  const leadOn = !!cfg.srsiLead[tf];
  const noGain = !leadOn && !!lead && lead.improved === false;
  const sig = [tf, ep.rsiPeriod, ep.stochPeriod, ep.smoothK, ep.smoothD, info ? (info.n + ':' + info.lagMin.toFixed(1)) : 'na', leadOn ? 'on' : (noGain ? 'nogain' : 'off')].join('|');
  if (sig !== _ovLeadSig) {
    _ovLeadSig = sig;
    const spd = document.getElementById('kchartOvLeadSpd');
    if (spd) spd.textContent = info && info.n >= 5 ? ('K 转折平均滞后 ' + fmtLag(info) + ' · ' + speedGrade(info).text + '（样本 ' + info.n + '）') : 'K 线不足，无法实测';
    const btn = document.getElementById('kchartOvLeadBtn');
    if (btn) {
      btn.disabled = noGain;
      if (leadOn) { btn.className = 'kchart-srsi-btn kchart-ovlead-btn on'; btn.textContent = '✓ 领先模式已开'; btn.onclick = () => window.kSetSrsiLead(tf, false); }
      else if (noGain) { btn.className = 'kchart-srsi-btn kchart-ovlead-btn'; btn.textContent = '已是较快档'; btn.onclick = null; }
      else { btn.className = 'kchart-srsi-btn kchart-ovlead-btn'; btn.textContent = '⚡ 开启领先模式'; btn.onclick = () => window.kSetSrsiLead(tf, true); }
    }
  }
  // 预演（每 5s 随实时价变化）
  const projEl = document.getElementById('kchartOvLeadProj');
  if (!projEl) return;
  const S = typeof window !== 'undefined' ? window.S : null;
  const c = (getTFData(cfg.symbol, tf).c || []);
  const px = (S && S.prices && S.prices[cfg.symbol] && isFinite(S.prices[cfg.symbol].last)) ? S.prices[cfg.symbol].last : null;
  const p = c.length >= 3 ? srsiProjectLive(c, ep, px) : null;
  if (!p || p.k == null) { if (_ovProjSig) { _ovProjSig = ''; projEl.textContent = ''; } return; }
  const psig = [tf, p.k.toFixed(2), p.zone, p.zoneClosed, px].join('|');
  if (psig === _ovProjSig) return;
  _ovProjSig = psig;
  const zName = (z) => z === 'overbought' ? '超买带' : (z === 'oversold' ? '超卖带' : '中性区');
  const n1 = (v) => (v == null ? '--' : v.toFixed(1));
  let tail = '';
  if (p.willCrossUp) tail = '⚠ 若此刻收盘将进入超买带（未确认）';
  else if (p.willCrossDown) tail = '⚠ 若此刻收盘将进入超卖带（未确认）';
  else if (p.zone === 'overbought') tail = '距上带 ' + n1(-p.distUp);
  else if (p.zone === 'oversold') tail = '距下带 ' + n1(-p.distDown);
  else tail = '距上带 ' + n1(p.distUp) + ' / 距下带 ' + n1(p.distDown);
  projEl.innerHTML = '<span class="kchart-proj-lbl">预演</span> ' + tf + ' 进行中：若此刻收盘 K=' + n1(p.k) + ' D=' + n1(p.d) +
    '<span class="kchart-proj-sub">已收盘 K=' + n1(p.kClosed) + ' · ' + zName(p.zone) + '</span>' +
    '<span class="' + ((p.willCrossUp || p.willCrossDown) ? 'kchart-proj-alert' : 'kchart-proj-sub') + '">' + tail + '</span>';
}
let _ovLeadSig = '', _ovProjSig = '';
// 由 renderKChart 每帧（PWA 5s / 主系统 1s 循环）调用；签名未变则不重建 DOM。
let _projSig = '';
function updateSrsiProjLive() {
  const S = typeof window !== 'undefined' ? window.S : null;
  const sym = cfg.symbol, tf = cfg.srsiEditTf;
  // 信号守望（始终开启，与自动交易开关无关）：带边沿/预演 → 提醒总线
  try { updateSignalWatch(sym); } catch (e) {}
  const el = typeof document !== 'undefined' ? document.getElementById('kchartSrsiProj') : null;
  if (!el) return;
  try { updateSrsiSpeedRow(); } catch (e) {}
  try { updateOvLeadLive(); } catch (e) {}
  const c = (getTFData(sym, tf).c || []);
  if (c.length < 3) { if (_projSig) { _projSig = ''; el.innerHTML = ''; } return; }
  const px = (S && S.prices && S.prices[sym] && isFinite(S.prices[sym].last)) ? S.prices[sym].last : null;
  const ep = perTfSrsi(tf, cfg.srsiByTf, cfg.srsi);
  const p = srsiProjectLive(c, ep, px);
  if (!p || p.k == null) { if (_projSig) { _projSig = ''; el.innerHTML = ''; } return; }
  const zName = (z) => z === 'overbought' ? '超买带' : (z === 'oversold' ? '超卖带' : '中性区');
  const sig = [tf, ep.rsiPeriod, ep.stochPeriod, ep.smoothK, ep.smoothD, ep.overbought, ep.oversold, p.k.toFixed(2), p.kClosed, p.zone, p.zoneClosed, px].join('|');
  if (sig === _projSig) return;
  _projSig = sig;
  const n1 = (v) => (v == null ? '--' : v.toFixed(1));
  let tail = '';
  if (p.willCrossUp) tail = ' <b class="kchart-proj-alert">⚠ 若此刻收盘将进入' + zName('overbought') + '（未确认）</b>';
  else if (p.willCrossDown) tail = ' <b class="kchart-proj-alert">⚠ 若此刻收盘将进入' + zName('oversold') + '（未确认）</b>';
  else if (p.zone === 'overbought') tail = ' 距上带 ' + n1(-p.distUp) + '';
  else if (p.zone === 'oversold') tail = ' 距下带 ' + n1(-p.distDown) + '';
  else tail = ' 距上带 ' + n1(p.distUp) + ' / 距下带 ' + n1(p.distDown);
  el.innerHTML = '<span class="kchart-proj-lbl">预演</span>' +
    '<span class="kchart-proj-val">' + tf + ' 进行中：若此刻收盘 K=' + n1(p.k) + ' D=' + n1(p.d) + '</span>' +
    '<span class="kchart-proj-sub">已收盘 K=' + n1(p.kClosed) + ' · ' + zName(p.zone) + '</span>' + tail;
}

// v1.6.17：驾驶舱「信号接近度」数据源——15m 进行中 bar 的 K 距「实际触发带」（resolveEntryBands）多远。
// 与卫星真实触发口径一致（用 resolveEntryBands，而非仅 15m 优选带），供驾驶舱进度条 + 脉冲动画。
export function srsiProximityNow(sym, tf) {
  sym = sym || cfg.symbol; tf = tf || '15m';
  const c = (getTFData(sym, tf) || {}).c || [];
  if (c.length < 3) return null;
  const ep = perTfSrsi(tf, cfg.srsiByTf, cfg.srsi);
  const S = typeof window !== 'undefined' ? window.S : null;
  const px = (S && S.prices && S.prices[sym] && isFinite(S.prices[sym].last)) ? S.prices[sym].last : null;
  const p = srsiProjectLive(c, ep, px);
  if (!p || p.k == null) return null;
  const eb = resolveEntryBands(cfg);
  return { sym, tf, k: p.k, d: p.d, kClosed: p.kClosed, upper: eb.upper, lower: eb.lower };
}

// 取某 TF 的 SRSI 参数（考虑 7d/30d 聚合特例与旧全局默认）
export function perTfSrsi(tf, byTf, fallback) {
  if (byTf && byTf[tf]) return byTf[tf];
  if (LONG_TF_SRSI[tf]) return LONG_TF_SRSI[tf];
  return fallback || DEFAULT_SRSI;
}

// 主图叠加药丸背景色：K>D 看多(淡绿) / K<D 看空(淡红) / 无效或相等 透明。
// 半透明以保留 --c 边框与文字、「辅」徽章可读性。
export function kdTrendColor(k, d) {
  if (k == null || d == null || !isFinite(k) || !isFinite(d)) return '';
  if (k > d) return 'rgba(38,166,91,0.22)';
  if (k < d) return 'rgba(211,47,47,0.22)';
  return '';
}

// 辅助周期闸门方向：取该周期 SRSI 行的「指向」。优先用区域姿态(超买=多压/超卖=空压)，
// 其次最近穿越/钩方向，最后 KD 瞬时方向。返回 'long'/'short'/null(中性=不否决)。
export function auxGateDir(row) {
  if (!row) return null;
  if (row.zone === 'oversold') return 'short';
  if (row.zone === 'overbought') return 'long';
  const lc = (typeof latestCross === 'function') ? latestCross(row) : null;
  const cv = lc && lc.cv;
  if (cv === 'buy' || cv === 'goldHook') return 'long';
  if (cv === 'sell' || cv === 'deathHook') return 'short';
  if (row.k != null && row.d != null && isFinite(row.k) && isFinite(row.d)) {
    if (row.k - row.d > 0.5) return 'long';
    if (row.d - row.k > 0.5) return 'short';
  }
  return null;
}

// 辅助放行闸门：给定主信号方向 dir('buy'/'sell') 与一组辅助行，
// 任一辅助行方向相反 → 'vetoed'(否决)；全部同向或中性 → 'released'(放行)；无辅助 → 'na'。
export function auxGateStatus(dir, auxRows) {
  if (!dir || !auxRows || !auxRows.length) return 'na';
  const want = dir === 'buy' ? 'long' : 'short';
  for (const r of auxRows) {
    const g = auxGateDir(r);
    if (!g) continue;
    if (g !== want) return 'vetoed';
  }
  return 'released';
}

// 把 higher-TF 的序列按开盘时间对齐到 base 时间轴：srcTimes[i] 对应 srcVals[i]，
// 每个 base bar 取「≤该 base 时间的最近 src 值」向前填充（forward-fill）。返回与 baseTimes 等长的数组。
export function alignSeriesToBase(baseTimes, srcTimes, srcVals) {
  const n = baseTimes ? baseTimes.length : 0;
  const out = new Array(n).fill(null);
  if (!n || !srcTimes || !srcTimes.length) return out;
  let j = 0;
  let last = null;
  for (let i = 0; i < n; i++) {
    const bt = baseTimes[i];
    while (j < srcTimes.length && srcTimes[j] <= bt) { last = srcVals ? srcVals[j] : null; j++; }
    out[i] = last;
  }
  return out;
}

// 把某周期全量 SRSI 的 K/D 按主图时间轴对齐到主图可见窗口：返回与 baseT 等长的 {k,d}。
// srcT 为该周期开柱时间、baseT 为主图可见窗开柱时间；缺失/非法输入返回空数组（调用方回退切片法）。
export function alignedSrsiOverlay(price, srcT, baseT, srsiCfg) {
  if (!Array.isArray(price) || price.length < 2 || !Array.isArray(srcT) || srcT.length < 2 || !Array.isArray(baseT) || !baseT.length) {
    return { k: [], d: [] };
  }
  const kd = srsiKD(price, srsiCfg);
  const k = alignSeriesToBase(baseT, srcT, kd.k);
  const d = alignSeriesToBase(baseT, srcT, kd.d);
  return { k, d };
}

// 叠加/速览用的每 TF 配色（13 个周期各有稳定色）
const TF_PALETTE = ['#ff6b6b', '#ffa94d', '#ffd43b', '#a9e34b', '#69db7c', '#38d9a9', '#3bc9db', '#4dabf7', '#748ffc', '#9775fa', '#da77f2', '#f783ac', '#e599f7'];
export function tfColor(tf) {
  const idx = KLINE_TF.indexOf(tf);
  return TF_PALETTE[(idx >= 0 ? idx : 0) % TF_PALETTE.length];
}

export function defaultKConfig() {
  // SRSI 参数默认沿用当前技术分析 techConfig（若无则以内置默认）
  const tc = (typeof window !== 'undefined' && window.techConfig) || {};
  const srsi = {
    rsiPeriod: tc.srsiRsiPeriod || DEFAULT_SRSI.rsiPeriod,
    stochPeriod: tc.srsiStochPeriod || DEFAULT_SRSI.stochPeriod,
    smoothK: tc.srsiSmoothK || DEFAULT_SRSI.smoothK,
    smoothD: tc.srsiSmoothD || DEFAULT_SRSI.smoothD,
    overbought: tc.srsiOverbought || DEFAULT_SRSI.overbought,
    oversold: tc.srsiOversold || DEFAULT_SRSI.oversold
  };
  const klineSel = {};
  KLINE_TF.forEach(tf => { klineSel[tf] = true; });
  return {
    symbol: (tc && tc.symbol) || 'BTCUSDT',
    klineSel,
    mainTF: '5m',
    show: { rsi: true, srsi: true, macd: true },
    bars: 150,
    overviewOpen: true,
    discOpen: true,
    discEvidenceOpen: false,   // 纪律面板「证据」折叠区：首次默认收起，点亮后记住
    // v1.6.30：价格-均线关系盯盘辅助层（默认关；纯显示层，不接任何自动交易）
    maRelOn: false,            // 总开关（主图工具面板药丸）
    maRelType: 'sma',          // 'sma' | 'ema'
    maRelShowSlow: false,      // 是否画本周期 MA120
    maRelShowDaily: true,      // 日线 MA20/50/200
    maRelShowWeekly: true,     // 周线 MA20/200
    maRelVwap: true,           // 本周期累积 VWAP
    maRelSqueezePct: 1.2,      // 均线密集阈值 %
    maRelDevAtr: 1.5,          // 乖离阈值（×ATR）
    maRelSwing: 15,            // 结构回看根数
    maRelCool: 8,              // 同向信号冷却根数
    maRelAllowShort: true,     // 是否允许做空信号
    maRelL3: true,             // L3：4H MA20 突破
    maRelShowInfo: true,       // 右上角状态/距离信息表
    srsi,
    srsiByTf: buildSrsiByTf(),   // 每周期独立 SRSI 参数（默认全沿用 DEFAULT_SRSI）
    srsiAux: {},                 // 辅助周期标记：勾选即「只做放行闸门」(gate 角色)，不进共识；normalizeCfg 会对空配置默认注入 15m 为闸门
    overlayTfs: {},              // 主图叠加按周期独立勾选：{ '4h': true, '1h': true }；非全局
    srsiEditTf: '5m',           // 速览参数编辑器当前编辑的周期
    gateTargetTf: '1h',        // 15m 闸门放行对象（可配，默认 1h；用户可在 SRSI 卡切换 30m/1h/4h/8h/1d）
    ovHide: {},             // 主图 chip 栏临时隐藏的周期及其原角色：{ '4h': 'ov'|'aux' }
    srsiOptPreview: {},        // 参数优选预览：{ [tf]: optimizeSrsi 结果 }（持久化，便于刷新后查看）
    srsiOptDeep: false,        // 参数优选：是否用 1440 全网格（默认邻近网格 ~360）
    srsiOptSource: {},         // 已采用优化参数的周期标记：{ [tf]: 'optimized' }
    srsiLead: {},              // 领先模式：{ [tf]: true } —— 该周期用实测响应最快的参数（见 LEAD_CANDIDATES）
    srsiLeadPrev: {},          // 开领先模式前该周期的原参数（关掉时原样恢复）
    optPreviewOn: false,       // 主图叠加「优化预览」（虚线 K/D + 上下带，不写入配置）
    mainOverlay: false,         // 主图 SRSI 多周期叠加开关
    ovQuickTfs: [],             // 主图顶部 chip 栏：参与显隐快选的周期集合（overlay/aux 之外的持久记忆）
    subOrder: ['rsi', 'srsi', 'macd'],   // 子图顺序（拖拽换序）
    // ---- SRSI 自动交易 ----
    srsiAutoOn: false,          // SRSI 自动交易总开关
    tradePanelOpen: false,      // GOAL13：交易面板展开状态（记忆）
    ruleMonitorOpen: false,     // 规则监测面板展开状态（记忆；v1.5.52 起同时是 HUD 悬浮卡总开关）
    ruleHudPos: null,           // v1.5.52：HUD 拖动后位置 {x,y}（相对 .kchart-box px；null=CSS 默认）
    sigOverlay: true,           // GOAL13：主图实盘信号层（Alpha/SRSI 信号映射，总开关）
    btStrategy: 'alpha',        // GOAL12：回测策略选择（alpha=基石第一/默认；srsi；combo）
    srsiAutoApplyBt: false,     // GOAL9：应用回测参数（勾选后回测完成自动把参数快照应用到实盘自动交易）
    srsiAutoMode: 'follow',     // 本位：follow=跟随快捷交易(开空U本位/开多币本位) / usdt / coin
    srsiAutoUpper: 0,           // 上限带（0=使用 15m 优选带）
    srsiAutoLower: 0,           // 下限带（0=使用 15m 优选带）
    srsiAutoLev: 5,             // 杠杆（固定）
    srsiAutoBasePct: 10,        // 仓位基准（可用余额的 %）
    srsiAutoMaxSame: 3,         // 最多连开同向仓位数
    srsiAutoStackDecay: 1,      // 同向连开递减系数(1=不衰减；<1 时第n笔=base×decay^(n-1)，仅作用于非反手同向连开)
    srsiAutoStackFront: 1,      // 递减前保留满仓的同向笔数(默认1=首笔即开始递减；2=前两笔满仓，第三笔起递减)
    srsiAutoDanger: 'none',     // 危险信号防爆：none=关 / filter=预防爆仓(避开危险单) / reverse=防爆反手(EMA120背离→自动反手；reverseKeys 命中优先反手)
    srsiAutoHotStop: false,     // 热停开：1h ATR > 1.3×sma20(1h ATR) 时禁止新开普通单（反手仍允许），防高波动爆仓
    srsiAutoReverseKeys: null,  // P2 模型反手键集 Set(`${side}@${openT}`)；由 walk-forward 训出的 8 特征模型注入，空=不反手
    srsiAutoReversePct: 0,      // 反手单仓位%（0=继承正常开仓%）
    srsiAutoReverseLev: 0,      // 反手单杠杆（0=继承正常杠杆）
    srsiAutoDangerAlarm: true,  // 危险信号红色光晕提醒（仅提醒，不触发操作）
    srsiAutoStopPct: 0,         // 硬止损%(价格逆向达此即平仓；0=关，沿用旧逻辑仅强平)。预防爆仓主力：把 ~14% 强平损失压缩为可控小损
    srsiAutoAdaptiveLev: false, // 自适应杠杆：波动放大→降杠杆(减少单笔爆仓率)；默认关，开=有效
    srsiAutoAdaptiveLevMin: 2,  // 自适应杠杆下限(倍数)
    srsiAutoAtrStop: false,     // 宽保护性止损(ATR 基准)：mult×受监督ATR% 为价格止损(落于爆仓线内侧)；默认关
    srsiAutoAtrStopMult: 2.0,   // 宽止损倍数(×ATR%)
    srsiAutoExitK: 0,           // 中轨离场(0=关；30~80：K从下方上穿≥此值平多、K从上方下穿≤100-此值平空——均值回归亏损单不再扛到强平)
    srsiAutoMaxHoldBars: 0,     // 最长持仓(0=关；单位 15m 根数，超过即市价离场；实盘按等价时间)
    srsiAutoRevConfirm: 3,      // 防爆反手确认阈值%：危险信号触发后，需价格逆向突破此幅度确认趋势破位才开反手(revconf)，避免接飞刀
    srsiAutoConfirmBars: 0,     // GOAL27 确认 bar：带边沿信号后需 N 根 15m 收盘仍满足带内条件才执行（0=关=立即执行，降频省成本）
    srsiAutoRegimeGate: 'off',  // GOAL29 regime 三态闸门：off=关(默认,零行为变化) / confirm=中波降频(+1确认bar) / size=中波减仓×0.5 / block=仅低波阴跌禁开 / tconf=趋势市升确认(AIS regime)
    srsiAutoRegimeW: 480,       // regime 分位滚动窗（1h 根数，默认 480≈20 天）
    srsiAutoRegimeEmaTf: '1h',  // GOAL29-A2 阴跌判定 EMA 周期：'1h'(默认) | '1d'(长窗更优，1d 数据不足自动降级 1h)
    srsiAutoPdBlockOn: false,   // GOAL31-D PD-A 危险拦截：predictDanger 多因子(≥2)命中→拦截该笔普通开仓（反手单不拦；默认 off=零行为变化）
    srsiAutoCloseManual: false, // 自动可平人工单：关=仅平自动单；开=盈利的反向人工单也可被自动平仓（仍仅净盈利才平）
    srsiAutoBonusBig: 3,        // 大方向一致加成比例（%）—— 仅用于 #2 方向合力展示
    srsiAutoBonusMid: 2,        // 中方向一致加成比例（%）
    srsiAutoBonusSmall: 1,       // 小方向一致加成比例（%）
    // #4 仓位缩放权重：4h/1h/30m 的 SRSI 方向与 15m 交易方向一致 +权重，未优选或反向 -权重（乘法因子 1±%）
    srsiAutoW4h: 30,
    srsiAutoW1h: 20,
    srsiAutoW30m: 10,
    srsiAutoPrincipal: 1000,      // 回测本金（USDT）
    srsiAutoBtMode: 'perp',         // 回测账户类型：perp=永续合约(U本位杠杆/可爆仓) / spot=现货(双余额/无杠杆/无爆仓)
    srsiAutoFeeRate: 0.00045,    // 单边手续费率（taker，已含 BNB 9 折；与实盘 engine 同源）
    srsiAutoSlipBase: 0.0002,    // 滑点基础值（实盘 = min(SLIP_CAP, base + SLIP_K×ATR%)）
    srsiAutoUseFunding: true,    // 回测是否计入真实历史资金费率
    srsiAutoUseCost: true,       // 回测总开关：是否计入交易成本（手续费+滑点+资金费）；false=完全不计（利润最多）
    srsiAutoOpenCapUsdt: 0,      // 单次开仓 USDT 上限（0=不限制；U本位/perp 适用）
    srsiAutoOpenCapCoin: 0,      // 单次开仓 币 数量上限（0=不限制；币本位/现货适用）
    srsiAutoOptEnabled: false,   // 自动优选开关（默认关）：开启后自动优选全部 6 周期并应用，且定时/无成交双触发重优选（防参数过期）
    srsiAutoOptIntervalH: 5,     // 自动重优选间隔（小时）
    srsiAutoOptIntervalOn: false,// 间隔重优选触发开关（默认关）：仅"无成交超h"默认触发；间隔触发需显式开启
    srsiAutoOptNoTradeH: 5,      // 无成交超过该时长（小时）即触发重优选
    srsiOptWinRate: {},          // 各周期已应用参数的样本外胜率（walk-forward 门控用）
    srsiBtCollapsed: true,       // 回测设置区默认收起（点开才显参数/回测/数据），记忆状态
  };
}

export let cfg = defaultKConfig();

// ---- 内部状态 ----
let _cv = null, _ctx = null;
// v1.5.58：行动卡 canvas 热区方案废弃（真机命中不可靠）——「实时监测」改为「主图叠加 SRSI」工具栏药丸按钮（DOM 顶层，见 renderMultiTfChips）
let _hover = null;
let _hoverLock = false;       // GOAL25：长按锁定十字线（再次点按解锁，不清除）
let _resizeObs = null;
let _drag = null;            // 子图拖拽 {startY, curY, moved, fromIdx}
let _suppressClick = false;
let _legendBoxes = [];       // 主图顶部 chip 栏热区 [{tf,x0,x1,y0,y1}]，供点击切换显隐
let _press = null;           // 最近 mousedown 的逻辑坐标，区分点击与拖动
let _pressMoved = false;     // mousedown→mouseup 间是否发生位移（拖动不误判为点击）
let _subRegions = [];        // [{key, tf, y0, y1}]
const _posHits = [];

// ---- 存取（按币对独立存储） ----
// 容器结构: { __v:2, lastSymbol, bySymbol:{ [sym]: cfg } }
// 旧扁平 cfg（无 bySymbol）首次读取时自动迁移为 bySymbol[oldSym]。
let _store = null;
function readStore() {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (!raw) return { __v: 2, lastSymbol: null, bySymbol: {} };
    const o = JSON.parse(raw);
    if (o && o.bySymbol) return Object.assign({ __v: 2 }, o);
    const sym = (o && o.symbol) || 'BTCUSDT';
    return { __v: 2, lastSymbol: sym, bySymbol: { [sym]: o || {} } };
  } catch (e) { return { __v: 2, lastSymbol: null, bySymbol: {} }; }
}
function normalizeCfg(c) {
  if (!c) c = defaultKConfig();
  if (!KLINE_TF.includes(c.mainTF)) c.mainTF = '5m';
  const sel = {}; KLINE_TF.forEach(tf => { sel[tf] = !!c.klineSel[tf]; }); c.klineSel = sel;
  if (!c.srsiByTf) c.srsiByTf = buildSrsiByTf();
  else {
    const base = buildSrsiByTf();
    KLINE_TF.forEach(tf => {
      const stored = c.srsiByTf[tf];
      // 7d/30d 聚合特例：若该 TF 存的是通用默认(85/50/10/5)，说明是每币对重构时期被错误填充的脏值，
      // 需改回长周期专用默认(14/6)，否则 RSI 预热不足 → 7d/30d 永远无 K/D 数据。用户显式改过的值不受影响。
      if (LONG_TF_SRSI[tf] && isOldDirtySrsi(stored)) c.srsiByTf[tf] = { ...LONG_TF_SRSI[tf] };
      else c.srsiByTf[tf] = { ...base[tf], ...(stored || {}) };
    });
  }
  if (!c.srsiAux || Object.keys(c.srsiAux).length === 0) c.srsiAux = { '15m': true };
  if (!c.overlayTfs || typeof c.overlayTfs !== 'object') c.overlayTfs = {};
  if (!c.ovHide || typeof c.ovHide !== 'object') c.ovHide = {};
  else { const oh = {}; KLINE_TF.forEach(tf => { if (c.ovHide[tf]) oh[tf] = true; }); c.ovHide = oh; }
  if (!c.srsiEditTf || !KLINE_TF.includes(c.srsiEditTf)) c.srsiEditTf = '5m';
  if (!c.gateTargetTf || !KLINE_TF.includes(c.gateTargetTf) || c.gateTargetTf === '15m') c.gateTargetTf = '1h';
  if (!c.srsiOptPreview || typeof c.srsiOptPreview !== 'object') c.srsiOptPreview = {};
  // 清理结构不兼容的旧优选预览（避免刷新后崩溃）：swing 需 full、gate 需 stats；
  // 旧 ATR 模式预览(无 full/stats)在此被丢弃，刷新后需重新运行优选。
  Object.keys(c.srsiOptPreview).forEach(tf => {
    const pr = c.srsiOptPreview[tf];
    if (!pr || !pr.role) { delete c.srsiOptPreview[tf]; return; }
    if (pr.role === 'gate' ? !pr.stats : !pr.full) delete c.srsiOptPreview[tf];
    // v6 及更早：swing 预览里的 best 被手册参数强制覆盖（硬编码）；v7 起含 bestSelection 字段，旧结构一律丢弃重算。
    if (pr.role === 'swing' && !('bestSelection' in pr)) delete c.srsiOptPreview[tf];
  });
  if (!c.srsiOptSource || typeof c.srsiOptSource !== 'object') c.srsiOptSource = {};
  if (!c.srsiLead || typeof c.srsiLead !== 'object') c.srsiLead = {};
  if (!c.srsiLeadPrev || typeof c.srsiLeadPrev !== 'object') c.srsiLeadPrev = {};
  { const L = {}; KLINE_TF.forEach(tf => { if (c.srsiLead[tf]) L[tf] = true; }); c.srsiLead = L; }
  if (typeof c.optPreviewOn !== 'boolean') c.optPreviewOn = false;
  if (typeof c.srsiOptDeep !== 'boolean') c.srsiOptDeep = false;
  // 主图快选 chip 栏集合：迁移期用 overlayTfs ∪ srsiAux 回填，并统一按 KLINE_TF 顺序去重
  let quick = Array.isArray(c.ovQuickTfs) ? c.ovQuickTfs.slice() : [];
  Object.keys(c.overlayTfs || {}).forEach(tf => { if (!quick.includes(tf)) quick.push(tf); });
  Object.keys(c.srsiAux || {}).forEach(tf => { if (!quick.includes(tf)) quick.push(tf); });
  c.ovQuickTfs = KLINE_TF.filter(tf => quick.includes(tf));
  if (typeof c.mainOverlay !== 'boolean') c.mainOverlay = false;
  if (typeof c.alphaSignalOn !== 'boolean') c.alphaSignalOn = false; // Alpha(combo) 买卖信号主图叠加开关（PWA，默认关）
  // ---- SRSI 自动交易配置兜底 ----
  if (typeof c.srsiAutoOn !== 'boolean') c.srsiAutoOn = false;
  if (typeof c.srsiAutoApplyBt !== 'boolean') c.srsiAutoApplyBt = false;
  if (!['alpha', 'srsi', 'combo'].includes(c.btStrategy)) c.btStrategy = 'alpha';
  if (typeof c.tradePanelOpen !== 'boolean') c.tradePanelOpen = false; // GOAL13：交易面板默认收缩
  if (typeof c.ruleMonitorOpen !== 'boolean') c.ruleMonitorOpen = false; // 规则监测面板默认收缩
  if (!c.ruleHudPos || typeof c.ruleHudPos !== 'object' || typeof c.ruleHudPos.x !== 'number' || typeof c.ruleHudPos.y !== 'number') c.ruleHudPos = null; // v1.5.52：HUD 位置（保留对象或 null）
  if (typeof c.sigOverlay !== 'boolean') c.sigOverlay = true; // GOAL13：主图实盘信号层总开关
  if (typeof c.alphaLiveOn !== 'boolean') c.alphaLiveOn = false; // GOAL17：Alpha 基石实盘勾选持久
  if (typeof c.ktSafe !== 'boolean') c.ktSafe = false; // GOAL17：防误触持久
  if (typeof c.ktUseFixed !== 'boolean') c.ktUseFixed = false; // GOAL17：固定数额持久
  if (typeof c.tradeOn !== 'boolean') c.tradeOn = true; // GOAL17：快捷交易总开关持久
  if (typeof c.tradeLinked !== 'boolean') c.tradeLinked = true; // GOAL17：联动主系统资金持久
  if (!['follow', 'usdt', 'coin'].includes(c.srsiAutoMode)) c.srsiAutoMode = 'follow';
  if (c.srsiAutoUpper !== 0 && (typeof c.srsiAutoUpper !== 'number' || !(c.srsiAutoUpper >= 50 && c.srsiAutoUpper <= 100))) c.srsiAutoUpper = 90;
  if (c.srsiAutoLower !== 0 && (typeof c.srsiAutoLower !== 'number' || !(c.srsiAutoLower >= 0 && c.srsiAutoLower <= 50))) c.srsiAutoLower = 10;
  if (typeof c.srsiAutoLev !== 'number' || !(c.srsiAutoLev >= 1 && c.srsiAutoLev <= 30)) c.srsiAutoLev = 5;
  if (typeof c.srsiAutoBasePct !== 'number' || !(c.srsiAutoBasePct >= 1 && c.srsiAutoBasePct <= 30)) c.srsiAutoBasePct = 10;
  if (typeof c.srsiAutoMaxSame !== 'number' || !(c.srsiAutoMaxSame >= 1 && c.srsiAutoMaxSame <= 10)) c.srsiAutoMaxSame = 3;
  if (typeof c.srsiAutoStackDecay !== 'number' || !(c.srsiAutoStackDecay >= 0.3 && c.srsiAutoStackDecay <= 1)) c.srsiAutoStackDecay = 1;
  if (typeof c.srsiAutoStackFront !== 'number' || !(c.srsiAutoStackFront >= 1 && c.srsiAutoStackFront <= 10)) c.srsiAutoStackFront = 1;
  if (!['none', 'filter', 'reverse', 'smart', 'revconf'].includes(c.srsiAutoDanger)) c.srsiAutoDanger = 'none';
  if (typeof c.srsiAutoStopPct !== 'number' || !(c.srsiAutoStopPct >= 0 && c.srsiAutoStopPct <= 50)) c.srsiAutoStopPct = 0;
  if (typeof c.srsiAutoAdaptiveLev !== 'boolean') c.srsiAutoAdaptiveLev = false;
  if (typeof c.srsiAutoAdaptiveLevMin !== 'number' || !(c.srsiAutoAdaptiveLevMin >= 1 && c.srsiAutoAdaptiveLevMin <= 30)) c.srsiAutoAdaptiveLevMin = 2;
  if (typeof c.srsiAutoAtrStop !== 'boolean') c.srsiAutoAtrStop = false;
  if (typeof c.srsiAutoAtrStopMult !== 'number' || !(c.srsiAutoAtrStopMult >= 0.1 && c.srsiAutoAtrStopMult <= 20)) c.srsiAutoAtrStopMult = 2.0;
  if (typeof c.srsiAutoExitK !== 'number' || !(c.srsiAutoExitK >= 30 && c.srsiAutoExitK <= 80)) c.srsiAutoExitK = 0;
  if (typeof c.srsiAutoMaxHoldBars !== 'number' || !(c.srsiAutoMaxHoldBars >= 1 && c.srsiAutoMaxHoldBars <= 2000)) c.srsiAutoMaxHoldBars = 0;
  if (typeof c.srsiAutoRevConfirm !== 'number' || !(c.srsiAutoRevConfirm >= 0 && c.srsiAutoRevConfirm <= 20)) c.srsiAutoRevConfirm = 3;
  if (typeof c.srsiAutoConfirmBars !== 'number' || !(c.srsiAutoConfirmBars >= 0 && c.srsiAutoConfirmBars <= 5)) c.srsiAutoConfirmBars = 0;
  if (!['off', 'confirm', 'size', 'block', 'tconf'].includes(c.srsiAutoRegimeGate)) c.srsiAutoRegimeGate = 'off';
  if (typeof c.srsiAutoRegimeW !== 'number' || !(c.srsiAutoRegimeW >= 60 && c.srsiAutoRegimeW <= 2000)) c.srsiAutoRegimeW = 480;
  if (c.srsiAutoRegimeEmaTf !== '1d') c.srsiAutoRegimeEmaTf = '1h';
  if (typeof c.srsiAutoPdBlockOn !== 'boolean') c.srsiAutoPdBlockOn = false;
  if (typeof c.srsiAutoReversePct !== 'number' || !(c.srsiAutoReversePct >= 0 && c.srsiAutoReversePct <= 100)) c.srsiAutoReversePct = 0;
  if (typeof c.srsiAutoReverseLev !== 'number' || !(c.srsiAutoReverseLev >= 0 && c.srsiAutoReverseLev <= 30)) c.srsiAutoReverseLev = 0;
  if (typeof c.srsiAutoDangerAlarm !== 'boolean') c.srsiAutoDangerAlarm = true;
  if (typeof c.srsiAutoHotStop !== 'boolean') c.srsiAutoHotStop = false;
  if (typeof c.srsiAutoCloseManual !== 'boolean') c.srsiAutoCloseManual = false;
  if (typeof c.srsiAutoBonusBig !== 'number' || !(c.srsiAutoBonusBig >= 0 && c.srsiAutoBonusBig <= 30)) c.srsiAutoBonusBig = 3;
  if (typeof c.srsiAutoBonusMid !== 'number' || !(c.srsiAutoBonusMid >= 0 && c.srsiAutoBonusMid <= 30)) c.srsiAutoBonusMid = 2;
  if (typeof c.srsiAutoBonusSmall !== 'number' || !(c.srsiAutoBonusSmall >= 0 && c.srsiAutoBonusSmall <= 30)) c.srsiAutoBonusSmall = 1;
  if (typeof c.srsiAutoW4h !== 'number' || !(c.srsiAutoW4h >= 0 && c.srsiAutoW4h <= 100)) c.srsiAutoW4h = 30;
  if (typeof c.srsiAutoW1h !== 'number' || !(c.srsiAutoW1h >= 0 && c.srsiAutoW1h <= 100)) c.srsiAutoW1h = 20;
  if (typeof c.srsiAutoW30m !== 'number' || !(c.srsiAutoW30m >= 0 && c.srsiAutoW30m <= 100)) c.srsiAutoW30m = 10;
  if (typeof c.srsiAutoPrincipal !== 'number' || !(c.srsiAutoPrincipal >= 10 && c.srsiAutoPrincipal <= 1000000)) c.srsiAutoPrincipal = 1000;
  if (c.srsiAutoBtMode !== 'perp' && c.srsiAutoBtMode !== 'spot') c.srsiAutoBtMode = 'perp';
  if (typeof c.srsiAutoFeeRate !== 'number' || !(c.srsiAutoFeeRate >= 0 && c.srsiAutoFeeRate <= 0.02)) c.srsiAutoFeeRate = 0.00045;
  if (typeof c.srsiAutoSlipBase !== 'number' || !(c.srsiAutoSlipBase >= 0 && c.srsiAutoSlipBase <= 0.02)) c.srsiAutoSlipBase = 0.0002;
  if (typeof c.srsiAutoUseFunding !== 'boolean') c.srsiAutoUseFunding = true;
  if (typeof c.srsiAutoUseCost !== 'boolean') c.srsiAutoUseCost = true;
  if (typeof c.srsiAutoOpenCapUsdt !== 'number' || !(c.srsiAutoOpenCapUsdt >= 0)) c.srsiAutoOpenCapUsdt = 0;
  if (typeof c.srsiAutoOpenCapCoin !== 'number' || !(c.srsiAutoOpenCapCoin >= 0)) c.srsiAutoOpenCapCoin = 0;
  if (typeof c.srsiAutoOptEnabled !== 'boolean') c.srsiAutoOptEnabled = false;
  if (typeof c.srsiAutoOptIntervalH !== 'number' || !(c.srsiAutoOptIntervalH >= 0.5 && c.srsiAutoOptIntervalH <= 168)) c.srsiAutoOptIntervalH = 5;
  if (typeof c.srsiAutoOptIntervalOn !== 'boolean') c.srsiAutoOptIntervalOn = false;
  if (typeof c.srsiAutoOptNoTradeH !== 'number' || !(c.srsiAutoOptNoTradeH >= 0.5 && c.srsiAutoOptNoTradeH <= 168)) c.srsiAutoOptNoTradeH = 5;
  if (!c.srsiOptWinRate || typeof c.srsiOptWinRate !== 'object') c.srsiOptWinRate = {};
  if (typeof c.srsiBtCollapsed !== 'boolean') c.srsiBtCollapsed = true;
  // 迁移：旧全局 mainOverlay=true 且尚无按周期 overlayTfs 时，用当时 klineSel 回填，保持旧观感（用户再手动取消）
  if (c.mainOverlay && c.overlayTfs && Object.keys(c.overlayTfs).length === 0) {
    KLINE_TF.forEach(tf => { if (c.klineSel[tf]) c.overlayTfs[tf] = true; });
  }
  return c;
}
function readSessionBackup() {
  try { const raw = sessionStorage.getItem(STATE_KEY + ':ss'); if (raw) return JSON.parse(raw); } catch (e) {}
  return null;
}

// ===================== PWA 私有持久化（按币对，独立于共享 smartTrader_kchart）=====================
// 根因：SRSI 参数(srsiByTf/optSource/optPreview)与交易设置(srsiAuto*)原存于共享键
// smartTrader_kchart（由主系统 index.html 与 PWA 共用），会被同源主系统/另一标签的 persist() 覆盖，
// 导致刷新/切币后丢失。PWA 模式(_pwaMode)下改存到 PWA 私有键（结构按币对），启动时优先读取，
// 彻底消除跨实例覆盖。主系统不启用 _pwaMode，行为完全不变。
const PWA_SRSI_OPT_KEY = 'pwa_srsi_opt';       // { [sym]: { srsiByTf, srsiOptSource, srsiOptPreview } }
const PWA_SRSI_AUTO_KEY = 'pwa_srsi_auto';     // { [sym]: { srsiAuto* 全部字段 } }
const PWA_LAST_SYM_KEY = 'pwa_last_sym';       // 上次真正使用的币对（PWA 启动恢复用）
let _pwaMode = false;
export function setPwaMode(v) { _pwaMode = !!v; }
export function isPwaMode() { return _pwaMode; }

function _readJson(key) { try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch (e) { return null; } }
// 配额超限时清理**可重建的派生键**并原地重试，避免静默失败导致配置/参数无法持久化。
// 红线：任何配置/数据的本地持久化都不能因配额被静默吞掉（否则后续接交易所真实交易数据同样会丢）。
// v1.6.18：原实现只清 `srsiOptHist:*`；用户实测配额爆满时仍失败（真凶常是回测缓存/日志）
//   → 扩展为清理所有派生/可重建键（回测结果/原始K线/资金费/信号日志/驾驶舱事件/规则监测快照）。
//   绝不清理用户配置与账户数据（smartTrader_kchart / pwa_srsi_opt / pwa_srsi_auto / pwa_paper_state / smartTrader）。
const _REGEN_KEYS = ['smartTrader_kchart_bt', 'smartTrader_kchart_bt_raw', 'smartTrader_kchart_bt_fund', 'pwa_signal_events', 'smartTrader_cockpitEvents', 'smartTrader_ruleMonitor'];
function pruneOptHistory() {
  try {
    const toDel = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      if (k.indexOf('srsiOptHist:') === 0 || _REGEN_KEYS.indexOf(k) >= 0) toDel.push(k);
    }
    toDel.forEach(k => { try { localStorage.removeItem(k); } catch (_) {} });
  } catch (e) {}
}
// 按体积列出最大的 localStorage 键（配额失败时打日志，便于定位真凶）
export function storageTop(n) {
  const arr = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      const v = localStorage.getItem(k) || '';
      arr.push({ k, kb: Math.round(v.length / 1024) });
    }
  } catch (e) {}
  arr.sort((a, b) => b.kb - a.kb);
  return arr.slice(0, n || 8);
}
function _isQuotaErr(e) { return !!e && (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014); }
export function _safeSetItem(key, str) {
  try { localStorage.setItem(key, str); return true; }
  catch (e) {
    if (_isQuotaErr(e)) { pruneOptHistory(); try { localStorage.setItem(key, str); return true; } catch (_) {} }
    try { console.error('[SRSI-PERSIST] 写入失败(已尝试清理配额):', key, (e && e.name) || e, '| 最大键:', JSON.stringify(storageTop(8))); } catch (_) {}
    return false;
  }
}
function _writeJson(key, obj) { _safeSetItem(key, JSON.stringify(obj)); }

// ===================== v1.6.19：主图信号标记持久化（跨刷新/切币可见）=====================
// 背景：`__alphaLiveMarks`/`__srsiLiveTrades` 原为内存，刷新即清空 → 用户“看不到历史标记”。
// 红线：容量封顶 200/类，走 _safeSetItem（配额自愈）；仅存成交/调仓事实，不存行情派生数据。
const MARKS_KEY = 'smartTrader_kchart_marks';
const MARKS_CAP = 200;
export function saveSignalMarks() {
  if (typeof window === 'undefined') return;
  try {
    const a = (window.__alphaLiveMarks || []).slice(-MARKS_CAP);
    const s = (window.__srsiLiveTrades || []).slice(-MARKS_CAP);
    _safeSetItem(MARKS_KEY, JSON.stringify({ alpha: a, srsi: s }));
  } catch (e) {}
}
export function restoreSignalMarks() {
  if (typeof window === 'undefined') return;
  try {
    const o = JSON.parse(localStorage.getItem(MARKS_KEY) || 'null');
    if (!o) return;
    if (!window.__alphaLiveMarks && Array.isArray(o.alpha)) window.__alphaLiveMarks = o.alpha;
    if (!window.__srsiLiveTrades && Array.isArray(o.srsi)) window.__srsiLiveTrades = o.srsi;
  } catch (e) {}
}
// SRSI 成交标记统一入口：push + 持久化（open/close 均走此）
function _pushSrsiMark(obj) {
  if (typeof window === 'undefined') return;
  try { (window.__srsiLiveTrades = window.__srsiLiveTrades || []).push(obj); saveSignalMarks(); } catch (e) {}
}
export function readPwaSrsiOpt() { const o = _readJson(PWA_SRSI_OPT_KEY); return (o && typeof o === 'object') ? o : {}; }
export function readPwaSrsiAuto() { const o = _readJson(PWA_SRSI_AUTO_KEY); return (o && typeof o === 'object') ? o : {}; }
function writePwaSrsiOpt(sym, cfgObj) {
  if (!sym || !cfgObj) return;
  const store = readPwaSrsiOpt();
  store[sym] = { srsiByTf: cfgObj.srsiByTf, srsiOptSource: cfgObj.srsiOptSource, srsiOptPreview: cfgObj.srsiOptPreview };
  _writeJson(PWA_SRSI_OPT_KEY, store);
}
function writePwaSrsiAuto(sym, cfgObj) {
  if (!sym || !cfgObj) return;
  const auto = {};
  Object.keys(cfgObj).forEach(k => { if (k.indexOf('srsiAuto') === 0) auto[k] = cfgObj[k]; });
  if (!Object.keys(auto).length) return;
  const store = readPwaSrsiAuto();
  store[sym] = auto;
  _writeJson(PWA_SRSI_AUTO_KEY, store);
}
// 把所有 SRSI 持久数据按当前 cfg.symbol 同步到 PWA 私有键（smartTrader_kchart 镜像保留以兼容主系统）
function syncPwaKeys() {
  if (!_pwaMode) return;
  writePwaSrsiOpt(cfg.symbol, cfg);
  writePwaSrsiAuto(cfg.symbol, cfg);
}

// 把 PWA 私有键中本次币对的数据覆盖进 cfg（在 normalizeCfg 之前，使校验/钳制对 PWA 值同样生效）
function applyPwaOverlay(sym) {
  if (!_pwaMode) return;
  const opt = readPwaSrsiOpt()[sym];
  const _sharedSym = (_store && _store.bySymbol && _store.bySymbol[sym]) || {};
  const sharedSByTf = _sharedSym.srsiByTf || {};
  const sharedSrc = _sharedSym.srsiOptSource || {};
  if (opt) {
    // 仅当 pwa 该周期非默认才覆盖（避免 pwa 默认值覆盖共享键已有的优选值 —— Fix2 回归修复）
    if (opt.srsiByTf) {
      KLINE_TF.forEach(tf => {
        const v = opt.srsiByTf[tf];
        if (v && !isDefaultSrsi(v)) cfg.srsiByTf[tf] = { ...(cfg.srsiByTf[tf] || {}), ...v };
      });
    }
    if (opt.srsiOptSource) cfg.srsiOptSource = { ...cfg.srsiOptSource, ...opt.srsiOptSource };
    if (opt.srsiOptPreview) cfg.srsiOptPreview = { ...cfg.srsiOptPreview, ...opt.srsiOptPreview };
  }
  const auto = readPwaSrsiAuto()[sym];
  if (auto) { Object.keys(auto).forEach(k => { if (k.indexOf('srsiAuto') === 0) cfg[k] = auto[k]; }); }
  // 关键修复：按优先级回源每个周期的 SRSI 参数，确保任一来源有优选值都不丢：
  //   preview.best（optimizeSrsiForTf 每次都 persist，最不易丢，权威） > pwa 非默认 > 共享键 非默认 > 当前值
  // 双源恢复（Fix2 回归修复）：pwa 被旧逻辑写成默认值/丢失时，从共享键 smartTrader_kchart 回退，反之亦然。
  {
    KLINE_TF.forEach(tf => {
      const best = cfg.srsiOptPreview && cfg.srsiOptPreview[tf] && cfg.srsiOptPreview[tf].best;
      const pwaV = opt && opt.srsiByTf && opt.srsiByTf[tf];
      const shV = sharedSByTf[tf];
      const pwaOptd = !!(opt && opt.srsiOptSource && opt.srsiOptSource[tf] === 'optimized');
      const shOptd = !!(sharedSrc && sharedSrc[tf] === 'optimized');
      let chosen = null, chosenOpt = false;
      if (best) { chosen = best; chosenOpt = true; }
      else if (pwaV && !isDefaultSrsi(pwaV)) { chosen = pwaV; chosenOpt = pwaOptd; }
      else if (shV && !isDefaultSrsi(shV)) { chosen = shV; chosenOpt = shOptd; }
      else if (cfg.srsiByTf[tf] && !isDefaultSrsi(cfg.srsiByTf[tf])) { chosen = cfg.srsiByTf[tf]; chosenOpt = false; }
      if (chosen) {
        cfg.srsiByTf[tf] = { ...DEFAULT_SRSI, ...chosen };
        if (chosenOpt) cfg.srsiOptSource[tf] = 'optimized';
      }
    });
  }
  // 同步全局回退 cfg.srsi：若当前主图周期已优选，用其参数作为全局回退，否则该周期 SRSI 超买/超卖带仍按 DEFAULT 画，与曲线(已用 srsiByTf)不符（修复重载/切币后"画线还是旧的"）
  const mt = cfg.mainTF;
  if (mt && cfg.srsiOptSource && cfg.srsiOptSource[mt] === 'optimized' && cfg.srsiByTf && cfg.srsiByTf[mt]) {
    cfg.srsi = { ...cfg.srsi, ...cfg.srsiByTf[mt] };
  }
}

export function loadCfg(symOverride) {
  _store = readStore();
  const sym = symOverride || cfg.symbol || _store.lastSymbol || 'BTCUSDT';
  const base = defaultKConfig();
  let saved = _store.bySymbol[sym];
  // 兜底：localStorage 在同源刷新间被浏览器清理时，同标签页 sessionStorage 仍在，用它补回已优选数据
  if (!saved || !saved.srsiOptSource || Object.keys(saved.srsiOptSource).length === 0) {
    const bk = readSessionBackup();
    const bks = bk && bk.bySymbol && bk.bySymbol[sym];
    if (bks && bks.srsiOptSource && Object.keys(bks.srsiOptSource).length) {
      saved = saved ? { ...saved, srsiByTf: bks.srsiByTf || saved.srsiByTf, srsiOptSource: bks.srsiOptSource, srsiOptPreview: bks.srsiOptPreview || saved.srsiOptPreview } : bks;
    }
  }
  cfg = saved
    ? { ...base, ...saved, show: { ...base.show, ...(saved.show || {}) }, srsi: { ...DEFAULT_SRSI, ...(saved.srsi || {}) } }
    : base;
  cfg.symbol = sym;
  normalizeCfg(cfg);
  if (_pwaMode) {
    // PWA 模式：srsi 相关字段仅以私有键(pwa_srsi_opt)为权威来源，先清空共享键可能携带的陈旧/被污染值，再叠加私有键
    cfg.srsiByTf = buildSrsiByTf();
    cfg.srsiOptSource = {};
    cfg.srsiOptPreview = {};
    if (cfg.srsiOptWinRate) cfg.srsiOptWinRate = {};
  }
  applyPwaOverlay(sym);   // PWA 模式：用私有键(smartTrader_kchart 之外的按币数据)覆盖，置于 normalize 之后确保为最终权威来源，免疫主系统/跨实例对共享键的覆盖（修复切币丢失优选参数）
  _store.lastSymbol = sym;

  // GOAL21：启动快照固化——浏览器环境下 800ms 后把恢复态重新落盘，防止启动早期其它实例/组件的陈旧写入覆盖用户勾选
  if (typeof document !== 'undefined' && typeof window !== 'undefined' && window.requestAnimationFrame) {
    setTimeout(() => { try { persist(); } catch (e) {} }, 800);
    try {
      // GOAL23：α 信号开启时自动重算 provider——刷新后 A 数据为空=主图「α空7%·54s前」角标不显示（chip 状态其实已恢复）
      if (cfg.alphaSignalOn && typeof window.__alphaSignalProvider === 'function') {
        const pr = window.__alphaSignalProvider();
        if (pr && pr.then) pr.then(() => { try { renderKChart(); } catch (e) {} }).catch(() => {});
      }
    } catch (e) {}
  }

}
export function persist() {
  if (!_store) _store = readStore();
  _store.bySymbol = _store.bySymbol || {};
  // 写前合并最外最新存档（仅并入非当前币的槽位）：防止陈旧内存快照覆盖其它实例(主屏App/另一标签)刚写入的数据；
  // 当前币槽位始终以本实例最新状态为准（本实例正在操作它），也不覆盖调用方"先改 _store 再 persist"的未落盘改动。
  try {
    const latest = readStore();
    if (latest && latest.bySymbol && typeof latest.bySymbol === 'object') {
      for (const k of Object.keys(latest.bySymbol)) {
        if (k !== cfg.symbol && !_store.bySymbol[k]) _store.bySymbol[k] = latest.bySymbol[k];
      }
    }
  } catch (e) {}
  _store.bySymbol[cfg.symbol] = cfg;
  _store.lastSymbol = cfg.symbol;
  _safeSetItem(STATE_KEY, JSON.stringify(_store));
  try { sessionStorage.setItem(STATE_KEY + ':ss', JSON.stringify(_store)); } catch (e) {}
  syncPwaKeys();   // PWA 模式：额外写入私有键（按币对），与共享 smartTrader_kchart 解耦
}
// ---- 跨实例同步：同源另一标签/主屏App 写入存档时，立即重载当前币对配置，避免陈旧实例互相覆盖 ----
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  try {
    window.addEventListener('storage', (ev) => {
      if (!ev || ev.key !== STATE_KEY) return;
      try {
        const latest = readStore();
        if (!latest || !latest.bySymbol) return;
        _store = latest;
        const sym = cfg.symbol || latest.lastSymbol || 'BTCUSDT';
        loadCfg(sym);
        if (typeof document !== 'undefined') {
          try { renderControls(); } catch (e) {}
          try { renderKChart(); } catch (e) {}
        }
      } catch (e) {}
    });
  } catch (e) {}
}
function toast(msg) {
  try {
    let t = document.getElementById('kchartToast');
    if (!t) { t = document.createElement('div'); t.id = 'kchartToast'; t.className = 'kchart-toast'; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('show');
    clearTimeout(t.__t); t.__t = setTimeout(() => t.classList.remove('show'), 2000);
  } catch (e) {}
}

// ---- 周期排序辅助 ----
const minutesOf = (tf) => KLINE_MINUTES[tf] || 1;

// ---- 控件渲染 ----
function renderControls() {
  const sel = document.getElementById('kchartSymbol');
  if (sel && sel.options.length === 0) {
    (window.SYMS || []).forEach(s => {
      const o = document.createElement('option');
      o.value = s.id; o.textContent = s.id.replace('USDT', '') + ' ' + s.name;
      sel.appendChild(o);
    });
  }
  if (sel) sel.value = cfg.symbol;

  // 统一周期选择器（主图 + SRSI 子图）：每个 TF 一个按钮，含主图圆点 + SRSI 方框
  const tfRow = document.getElementById('kchartTFRow');
  if (tfRow && tfRow.children.length === 0) {
    tfRow.innerHTML = KLINE_TF.map(tf => {
      const isMain = tf === cfg.mainTF;
      const isSel = !!cfg.klineSel[tf];
      return `<span class="kchart-tfbtn ${isMain ? 'main' : ''}" data-tf="${tf}">
        <span class="kchart-tfdot"></span>
        <span class="kchart-tfname">${tf}</span>
        <span class="kchart-tfsq ${isSel ? 'on' : ''}"></span>
      </span>`;
    }).join('');
    // 事件委托（绑定一次）
    if (!tfRow.__bound) {
      tfRow.__bound = true;
      tfRow.addEventListener('click', (e) => {
        const btn = e.target.closest('.kchart-tfbtn');
        if (!btn) return;
        const tf = btn.dataset.tf;
        if (!KLINE_TF.includes(tf)) return;
        if (e.target.closest('.kchart-tfsq')) {
          const res = nextKMode(tf, cfg, 'srsi');
          applyKMode(res);
        } else {
          const res = nextKMode(tf, cfg, 'main');
          applyKMode(res);
        }
      });
    }
  } else if (tfRow) {
    // 同步状态
    tfRow.querySelectorAll('.kchart-tfbtn').forEach(btn => {
      const tf = btn.dataset.tf;
      btn.classList.toggle('main', tf === cfg.mainTF);
      const sq = btn.querySelector('.kchart-tfsq');
      if (sq) sq.classList.toggle('on', !!cfg.klineSel[tf]);
    });
  }

  // 预设按钮（选中集合与 mainTF 完全匹配才高亮；「全选」只看是否全部勾选，主图周期不限）
  const selKeys = KLINE_TF.filter(tf => cfg.klineSel[tf]).sort();
  document.querySelectorAll('.kchart-preset').forEach(el => {
    const p = el.dataset && el.dataset.preset;
    const combo = p && kPresetCombos(p);
    const cKeys = combo ? KLINE_TF.filter(tf => combo.sel[tf]).sort() : [];
    const active = combo
      ? (combo.all
          ? selKeys.length === KLINE_TF.length
          : cfg.mainTF === combo.mainTF && selKeys.join(',') === cKeys.join(','))
      : false;
    el.classList.toggle('active', !!active);
  });

  // 速览表折叠状态
  const ovWrap = document.getElementById('kchartOverviewWrap');
  if (ovWrap) ovWrap.classList.toggle('closed', !cfg.overviewOpen);
  const discWrap = document.getElementById('kchartDiscWrap');
  if (discWrap) discWrap.classList.toggle('closed', !cfg.discOpen);
  const tpWrap = document.getElementById('ktPanelWrap');
  if (tpWrap) tpWrap.classList.toggle('closed', !cfg.tradePanelOpen);

  const bars = document.getElementById('kchartBars');
  if (bars) bars.value = cfg.bars;
  const barsLbl = document.getElementById('kchartBarsLbl');
  if (barsLbl) barsLbl.textContent = cfg.bars;

  // 子图显示开关
  const subTog = document.getElementById('kchartSubToggles');
  if (subTog) {
    const labels = { rsi: 'RSI', srsi: 'SRSI', macd: 'MACD' };
    subTog.innerHTML = ['rsi', 'srsi', 'macd'].map(key =>
      `<label class="kchart-tog ${cfg.show[key] ? 'on' : ''}" style="--kct:${SUB_COLORS[key]}">
        <input type="checkbox" ${cfg.show[key] ? 'checked' : ''} onchange="window.setKShow('${key}',this.checked)">
        <span>${labels[key]}</span></label>`
    ).join('');
  }

  // SRSI 参数（每周期独立设置）——渲染到独立的「SRSI 各币对各周期参数」设置卡片
  const srsiBox = document.getElementById('kchartSrsiCard');
  if (srsiBox) {
    const mkNum = (name, min, max, val) =>
      `<input type="number" min="${min}" max="${max}" step="1" value="${val}" onchange="window.setKSrsi('${name}',this.value)" class="kchart-num">`;
    const ep = cfg.srsiByTf[cfg.srsiEditTf] || cfg.srsi;
    const tfTabs = KLINE_TF.map(tf => {
      const optd = cfg.srsiOptSource && cfg.srsiOptSource[tf] === 'optimized';
      return `<button class="kchart-tfbtn ${tf === cfg.srsiEditTf ? 'main' : ''}" onclick="window.kSetSrsiTf('${tf}')">${tf}${optd ? ' ◆' : ''}</button>`;
    }).join('');
    const isAux = !!cfg.srsiAux[cfg.srsiEditTf];
    const isOv = !!cfg.overlayTfs[cfg.srsiEditTf];
    srsiBox.innerHTML =
      `<div class="kchart-srsi-sym">当前币对：<b>${cfg.symbol}</b> · 编辑周期：<b>${cfg.srsiEditTf}</b> · 已优选 <b>${KLINE_TF.filter(t => cfg.srsiOptSource && cfg.srsiOptSource[t] === 'optimized').length}</b>/${KLINE_TF.length}</div>` +
      `<div class="kchart-srsi-tfs">${tfTabs}</div>` +
      `<div class="kchart-srsi-row">` +
        `<span>RSI周期</span>${mkNum('rsiPeriod', 1, 500, ep.rsiPeriod)}` +
        `<span>Stoch</span>${mkNum('stochPeriod', 1, 500, ep.stochPeriod)}` +
      `</div>` +
      `<div class="kchart-srsi-row">` +
        `<span>%K</span>${mkNum('smoothK', 1, 100, ep.smoothK)}` +
        `<span>%D</span>${mkNum('smoothD', 1, 100, ep.smoothD)}` +
      `</div>` +
      `<div class="kchart-srsi-row">` +
        `<span>超买</span>${mkNum('overbought', 1, 100, ep.overbought)}` +
        `<span>超卖</span>${mkNum('oversold', 0, 99, ep.oversold)}` +
        `<label class="kchart-aux ${isAux ? 'on' : ''}"><input type="checkbox" ${isAux ? 'checked' : ''} onchange="window.kSetSrsiAux('${cfg.srsiEditTf}',this.checked)">辅助(只做放行闸门)</label>` +
        `<label class="kchart-aux ${isOv ? 'on' : ''}"><input type="checkbox" ${isOv ? 'checked' : ''} onchange="window.kSetMainOverlayTf('${cfg.srsiEditTf}',this.checked)">主图叠加(本周期)</label>` +
        (roleForTf(cfg.srsiEditTf) === 'gate'
          ? `<label class="kchart-aux">放行对象<select class="kchart-aux-select" onchange="window.kSetGateTarget(this.value)">${GATE_TARGET_OPTIONS.filter(t => tfMs(t) > tfMs(cfg.srsiEditTf)).map(t => `<option value="${t}" ${cfg.gateTargetTf === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>`
          : '') +
        `<button class="kchart-srsi-btn" onclick="window.kResetSrsi()">默认</button>` +
      `</div>` +
       `<div class="kchart-srsi-actions">` +
        `<button class="kchart-srsi-btn kchart-srsi-optbtn" onclick="window.kOptimizeSrsi('${cfg.srsiEditTf}')">⚡ 优选</button>` +
        `<label class="kchart-aux ${cfg.srsiOptDeep ? 'on' : ''}"><input type="checkbox" ${cfg.srsiOptDeep ? 'checked' : ''} onchange="window.kSetSrsiOptDeep(this.checked)">深度全网格</label>` +
        `<button class="kchart-srsi-btn" onclick="window.kCopyCfgToAll()">复制本币对到全部</button>` +
        `<button class="kchart-srsi-btn" onclick="window.kResetSymbolCfg()">重置本币对</button>` +
      `</div>` +
      srsiSpeedHtml(cfg.srsiEditTf, ep) +
      `<div class="kchart-srsi-proj" id="kchartSrsiProj"></div>` +
      srsiLeadNoteHtml() +
      optSectionHtml(cfg.srsiEditTf);
  }
  renderMainTools();
}

// 主图正上方的 SRSI 叠加操作工具条（贴着主图，避免被页面顶部折叠遮挡）
// 复用签名守卫：先以「轻量签名」(状态 + 各周期末值/参数/长度) 判断是否需重建，
// 仅在数据或状态变化时才跑 srsiKD；renderKChart 每帧调用也不抖。
let _mtSig = '';
// v1.6.21：手机 PWA 改为「⚙ 设置」入口放在「主图 ‹ 5m ›」后（原内联 SRSI 小方块在窄屏会挤压卡头导致“主图/‹ 5m ›”变形，已移除）。
// SRSI 叠加周期选择仍在 ⚙ 面板的「主图叠加 SRSI」chips（与桌面同一处）。
function renderMainTools() {
  const el = typeof document !== 'undefined' ? document.getElementById('kchartMainTools') : null;
  if (!el) return;
  const sym = cfg.symbol;
  let cheap = sym + '|rm' + (cfg.ruleMonitorOpen ? 1 : 0) + '|';
  const chips = KLINE_TF.map(tf => {
    const overlay = !!(cfg.overlayTfs && cfg.overlayTfs[tf]);
    const aux = !!(cfg.srsiAux && cfg.srsiAux[tf]);
    const hidden = !!(cfg.ovHide && cfg.ovHide[tf]);
    const closes = getTFData(sym, tf).c;
    const p = perTfSrsi(tf, cfg.srsiByTf, cfg.srsi);
    const last = closes.length ? closes[closes.length - 1] : 0;
    cheap += tf + ':' + (overlay ? 1 : 0) + (aux ? 1 : 0) + (hidden ? 1 : 0) + ':'
      + closes.length + ':' + last + ':'
      + p.rsiPeriod + ',' + p.stochPeriod + ',' + p.smoothK + ',' + p.smoothD + ',' + p.overbought + ',' + p.oversold + ';';
    return { tf, overlay, aux, hidden, on: (overlay || aux) && !hidden, closes, p };
  });
  if (cheap === _mtSig) return; // 数据/状态无变化：跳过 srsiKD 与 DOM 重建
  _mtSig = cheap;
  const html = `<span class="mt-label">主图叠加 SRSI</span>` + chips.map(ch => {
    const col = ch.aux ? '#4dabf7' : tfColor(ch.tf);
    // 辅助身份优先：srsiAux 为真时始终带「辅」徽章，与线条是否显示无关
    const label = ch.tf + (ch.aux ? ' 辅' : '');
    const title = ch.aux
      ? (ch.hidden ? '辅助闸门生效中，主图线条已隐藏，点此显示' : '辅助(放行闸门)周期，点此切换主图线条显隐')
      : (ch.hidden ? '主图叠加已隐藏，点此显示' : '点击叠加该周期 SRSI 到主图');
    const cls = `chip ${ch.on ? 'on' : 'off'}${ch.aux ? ' aux' : ''}${ch.hidden ? ' hidden' : ''}`;
    let bg = '';
    if (ch.closes && ch.closes.length >= 2) {
      const sl = srsiKD(ch.closes, ch.p);
      let k = null, d = null;
      for (let i = sl.k.length - 1; i >= 0; i--) {
        if (sl.k[i] != null && sl.d[i] != null) { k = sl.k[i]; d = sl.d[i]; break; }
      }
      bg = kdTrendColor(k, d);
    }
    return `<span class="${cls}" data-tf="${ch.tf}" style="--c:${col};background:${bg}" title="${title}">${label}</span>`;
  }).join('');
  el.innerHTML = html + `<span class="mt-alpha${cfg.alphaSignalOn ? ' on' : ''}" id="alphaChip" title="主图叠加 Alpha(combo) 买卖信号翻转标记 ▲买/▼卖 + 当前仓位角标（PWA Alpha 实验室同源）" style="margin-left:6px;padding:2px 8px;border-radius:10px;border:1px solid ${cfg.alphaSignalOn ? '#2ecc71' : 'var(--border)'};background:${cfg.alphaSignalOn ? 'rgba(46,204,113,.15)' : 'var(--card2)'};color:${cfg.alphaSignalOn ? '#2ecc71' : 'var(--text2)'};font-size:11px;cursor:pointer;user-select:none;white-space:nowrap">α 信号${cfg.alphaSignalOn ? ' ✓' : ''}</span><span id="sigOverlayChip" title="GOAL13：主图实盘信号层——勾选的策略（Alpha基石实盘/SRSI自动/应用回测参数）的成交信号映射到主图，与真实交易一一对应" style="margin-left:6px;padding:2px 8px;border-radius:10px;border:1px solid ${cfg.sigOverlay ? '#22d3ee' : 'var(--border)'};background:${cfg.sigOverlay ? 'rgba(34,211,238,.15)' : 'var(--card2)'};color:${cfg.sigOverlay ? '#22d3ee' : 'var(--text2)'};font-size:11px;cursor:pointer;user-select:none;white-space:nowrap">实盘信号${cfg.sigOverlay ? ' ✓' : ''}</span><span id="rmChip" title="规则监测 HUD（v1.5.58）：点击在主图上方展开/收起实时监测仪表盘——11 规则链影子计算/预测危险/带态/统计与参数版本，不影响 K 线取值" style="margin-left:6px;padding:2px 8px;border-radius:10px;border:1px solid ${cfg.ruleMonitorOpen ? '#58a6ff' : 'var(--border)'};background:${cfg.ruleMonitorOpen ? 'rgba(88,166,255,.15)' : 'var(--card2)'};color:${cfg.ruleMonitorOpen ? '#58a6ff' : 'var(--text2)'};font-size:11px;cursor:pointer;user-select:none;white-space:nowrap">实时监测${cfg.ruleMonitorOpen ? ' ✓' : ''}</span><span id="maRelChip" title="价格-均线关系盯盘辅助层（默认关，纯显示不接自动交易）：本周期 MA20/60(+MA120) · 日线 MA20/50/200 · 周线 MA20/200 · VWAP；右上角 BULL/BEAR/RANGE 状态 + 均线密集/乖离提示；回踩站上(L1)/密集突破(L2)/4H MA20 突破(L3) 信号 + 结构防守位 + 1R/2R 参考线 + 失效叉" style="margin-left:6px;padding:2px 8px;border-radius:10px;border:1px solid ${cfg.maRelOn ? '#f59e0b' : 'var(--border)'};background:${cfg.maRelOn ? 'rgba(245,158,11,.15)' : 'var(--card2)'};color:${cfg.maRelOn ? '#f59e0b' : 'var(--text2)'};font-size:11px;cursor:pointer;user-select:none;white-space:nowrap">📐 均线关系${cfg.maRelOn ? ' ✓' : ''}</span>${cfg.maRelOn ? `<span id="maRelOpts" class="mt-marel">` +
    `<button data-mr="type" title="均线类型（SMA/EMA）">${cfg.maRelType.toUpperCase()}</button>` +
    `<button data-mr="slow" class="${cfg.maRelShowSlow ? 'on' : ''}" title="本周期 MA120">MA120</button>` +
    `<button data-mr="daily" class="${cfg.maRelShowDaily ? 'on' : ''}" title="日线 MA20/50/200">日线</button>` +
    `<button data-mr="weekly" class="${cfg.maRelShowWeekly ? 'on' : ''}" title="周线 MA20/200">周线</button>` +
    `<button data-mr="vwap" class="${cfg.maRelVwap ? 'on' : ''}" title="本周期累积 VWAP">VWAP</button>` +
    `<button data-mr="short" class="${cfg.maRelAllowShort ? 'on' : ''}" title="是否允许做空信号">做空</button>` +
    `<button data-mr="l3" class="${cfg.maRelL3 ? 'on' : ''}" title="L3：收盘上/下穿 4H MA20">L3</button>` +
    `<button data-mr="info" class="${cfg.maRelShowInfo ? 'on' : ''}" title="右上角状态/距离信息表">信息表</button>` +
    `</span>` : ''}<span class="mt-legend" title="主图信号标记说明（与卡头图例同源）：▲/▼/●=SRSI 自动真实开多/开空/平仓；◆/◇=Alpha 基石实盘调仓/平仓；●=15m SRSI 机会（跌入超卖看多/升入超买看空，非成交）；◆=金钩/死钩（权重大于机会点，同根同侧重叠时只显示钩）。鼠标悬停任意 K 线，浮层会列出该根命中的全部标记含义">${renderLegendHtml()}<span id="sigMarkCount" style="margin-left:6px;color:var(--text2);font-family:var(--mono,monospace)"></span></span>`;
  el.querySelectorAll('.chip').forEach(c => {
    c.addEventListener('click', () => toggleOvQuickTf(c.getAttribute('data-tf')));
  });
  const ac = el.querySelector('#alphaChip');
  if (ac) ac.addEventListener('click', () => setAlphaSignal(!cfg.alphaSignalOn));
  const sc = el.querySelector('#sigOverlayChip');
  if (sc) sc.addEventListener('click', () => setSigOverlay(!cfg.sigOverlay));
  const rc = el.querySelector('#rmChip');
  if (rc) rc.addEventListener('click', () => kToggleRuleMonitor());
  // v1.6.30：价格-均线关系盯盘辅助层开关 + 参数行
  const mc = el.querySelector('#maRelChip');
  if (mc) mc.addEventListener('click', () => setMaRel(!cfg.maRelOn));
  const mo = el.querySelector('#maRelOpts');
  if (mo) {
    mo.addEventListener('click', (e) => {
      const b = e.target && e.target.closest ? e.target.closest('button[data-mr]') : null;
      if (!b) return;
      const k = b.getAttribute('data-mr');
      if (k === 'type') cfg.maRelType = cfg.maRelType === 'sma' ? 'ema' : 'sma';
      else if (k === 'slow') cfg.maRelShowSlow = !cfg.maRelShowSlow;
      else if (k === 'daily') cfg.maRelShowDaily = !cfg.maRelShowDaily;
      else if (k === 'weekly') cfg.maRelShowWeekly = !cfg.maRelShowWeekly;
      else if (k === 'vwap') cfg.maRelVwap = !cfg.maRelVwap;
      else if (k === 'short') cfg.maRelAllowShort = !cfg.maRelAllowShort;
      else if (k === 'l3') cfg.maRelL3 = !cfg.maRelL3;
      else if (k === 'info') cfg.maRelShowInfo = !cfg.maRelShowInfo;
      _maRelCache = { key: '', data: null };
      try { persist(); } catch (e2) {}
      _mtSig = '';   // 强制重建药丸行（参数态变化）
      renderMainTools(); renderKChart();
    });
  }
}

// ---- 多周期 SRSI 速览表渲染（DOM，与 canvas 无关）----
// 用签名守卫：仅当 数据/勾选/SRSI参数/主图 变化时才重建 DOM（hover 触发 renderKChart 不重建）
let _ovSig = '';
let _discSig = '';
let _ovFootTf = null; // 页脚参数行当前显示的 TF（点击速览行/⚙ 时设为该 TF，否则默认主图 TF）

export function renderSrsiOverview(hz, capMin) {
  const box = document.getElementById('kchartOverview');
  if (!box) return;
  const sym = cfg.symbol;
  const footTf = _ovFootTf || cfg.mainTF; // 页脚参数跟随所点击周期，否则跟随主图周期
  const selTfs = KLINE_TF.filter(tf => cfg.klineSel[tf]);
  // 长周期聚合: 7d=周线(每7根日线合1根)、30d=月线(每30根日线合1根)。
  // 用全量日线(S.klines 仍存 500 根日线, 供 macroTrend/tfOverviewStat)聚合出周/月收盘价后算 SRSI,
  // 使 7d/30d 显示真正独立的周/月级 SRSI(不再恒等于 1d); 因聚合后根数少, 用较短 RSI/Stoch 周期保证预热
  // (LONG_TF_SRSI 定义在文件顶部, 亦作为 7d/30d 的出厂默认参数)。
  const LONG_TF_AGG = { '7d': 7, '30d': 30 };
  const priceMap = {};
  let sig = sym + '|' + cfg.mainTF + '|' + cfg.bars + '|ft:' + footTf + '|byTf:' + JSON.stringify(cfg.srsiByTf) + '|aux:' + JSON.stringify(cfg.srsiAux) + '|';
  selTfs.forEach(tf => {
    let c = getTFData(sym, tf).c;
    if (LONG_TF_AGG[tf] && c.length >= LONG_TF_AGG[tf]) c = resample(c, LONG_TF_AGG[tf]);
    priceMap[tf] = c;
    sig += tf + ':' + c.length + ':' + (c[c.length - 1] || 0) + ';';
  });
  sig += '|dz:' + (hz ? hz.deadMode : 'fixed') + ':' + (hz ? hz.deadZone.toFixed(3) : '');
  if (sig === _ovSig) return;
  _ovSig = sig;

  const perTf = (tf) => perTfSrsi(tf, cfg.srsiByTf, cfg.srsi);
  const { rows } = buildSrsiOverview(selTfs, perTf, priceMap, cfg.bars);
  const auxRows = rows.filter(r => cfg.srsiAux[r.tf]);
  const primaryRows = rows.filter(r => !cfg.srsiAux[r.tf]);
  const cb = countBullBear(primaryRows);
  const verdict = overviewVerdict(cb.bull, cb.bear);
  // 方向基准用全部 KLINE_TF（不受当前勾选影响），与纪律面板共用同一 hz（同一 deadZone/同一基准周期）
  const tr = (hz && hz.trend) || horizonTrend(allPriceMapOf(sym), { capMin: capMin != null ? capMin : THRESH.HORIZON_CAP_MIN, deadZone: hz ? hz.deadZone : THRESH.HORIZON_DEAD_FIXED });
  const mt = macroTrend(allPriceMapOf(sym));
  const deadTxt = hz && hz.deadMode === 'adaptive'
    ? ` 死区自适应${hz.deadZone.toFixed(2)}%(${hz.ratio >= 1 ? '高波动' : '低波动'})`
    : ` 死区固定${(hz ? hz.deadZone : THRESH.HORIZON_DEAD_FIXED).toFixed(2)}%`;
  // 脚部把「决策依据(趋势方向)」与「风险背景(大趋势/宏观)」分开标注，避免误读
  // "宏观7d↓=应该看空"。趋势方向决定看多看空；大趋势方向只用于降置信度、不改方向。
  const trendTxt = tr
    ? `<br>【趋势方向·决策】${tr.up === true ? '↑看多' : tr.up === false ? '↓看空' : '—横盘'}(${tr.tf} ${tr.spreadPct.toFixed(1)}%${tr.flat ? ' 横盘' : ''})${mt && mt.up != null ? ` ·【大趋势·仅扣分】${mt.tf}${mt.up === true ? '↑' : '↓'}(${mt.spreadPct.toFixed(1)}%)` : ''}${deadTxt}`
      + `<br><span style="opacity:.8" title="短周期(速览表)只定入场时机与置信度；大趋势与趋势方向相反时仅降低置信度、不改变方向">短周期箭头≠趋势方向，大趋势反向≠翻方向，仅降置信度</span>`
    : '';
  const zoneCls = { overbought: 'ov-bear', oversold: 'ov-bull', neutral: '' };
  const zoneLbl = { overbought: '超买', oversold: '超卖', neutral: '中性' };
  const rowHtml = rows.map(r => {
    const lc = latestCross(r);
    const cv = lc.cv, fv = lc.fv;
    const freshTxt = fv == null ? '—' : (fv === 0 ? '当下' : fv + '根前');
    const freshCls = fv != null && fv <= 3 ? (cv === 'buy' || cv === 'goldHook' ? 'ov-fresh-buy' : 'ov-fresh-sell') : '';
    const crossTxt = cv === 'goldHook' ? '▲金钩' : cv === 'deathHook' ? '▼死钩' : cv === 'buy' ? '▲破超卖' : cv === 'sell' ? '▼破超买' : '无';
    const crossCls = cv === 'goldHook' ? 'ov-hook-gold' : cv === 'deathHook' ? 'ov-hook-death' : cv === 'buy' ? 'ov-cross-buy' : cv === 'sell' ? 'ov-cross-sell' : '';
    const crossTip = cv === 'sell' ? '破超买: K线 上破 80 超买带 → 反手看空信号（注意: 这是 K 破带, 非 K-D 死叉）'
      : cv === 'buy' ? '破超卖: K线 下破 20 超卖带 → 反手看多信号（非 K-D 金叉）'
      : cv === 'deathHook' ? '死钩: K 由 ≥超买 跌破超买带且近15根内 K 下穿 D → 高位死叉+跌破, 偏空'
      : cv === 'goldHook' ? '金钩: K 由 ≤超卖 升破超卖带且近15根内 K 上穿 D → 低位金叉+突破, 偏多'
      : '';
    const cellTip = (crossTip + (r.reversed ? ' · ⚠ 已反转(信号意图与当前K/D相反)' : '')) || '无信号';
    const rowDir = (() => { const lc = latestCross(r); const cv = lc.cv; if (cv === 'buy' || cv === 'goldHook') return 'buy'; if (cv === 'sell' || cv === 'deathHook') return 'sell'; return null; })();
    const gate = cfg.srsiAux[r.tf] ? 'aux' : (auxRows.length ? auxGateStatus(rowDir, auxRows) : 'na');
    const gateTxt = gate === 'released' ? '放行' : gate === 'vetoed' ? '否决' : gate === 'aux' ? '辅助' : '—';
    const gateCls = gate === 'released' ? 'ov-gate-pass' : gate === 'vetoed' ? 'ov-gate-veto' : gate === 'aux' ? 'ov-gate-aux' : '';
    const eng = r.energy || { dir: null, score: 0 };
    const engCls = eng.score >= 60 ? 'ov-eng-hi' : eng.score >= 30 ? 'ov-eng-mid' : 'ov-eng-lo';
    const engTxt = eng.dir ? eng.score : '—';
    const d = getTFData(sym, r.tf);
    const stat = tfOverviewStat(d.c, d.l, d.h, d.t, cfg.bars, minutesOf(r.tf));
    const tfCls = stat.chgPct != null ? (stat.chgPct > 0 ? 'up' : stat.chgPct < 0 ? 'down' : '') : '';
    // 有数据(K线根数≥2)但 K/D 仍为 null：说明 SRSI 参数过大、预热不足（典型 7d/30d 被填了 RSI85）
    const warnInsuf = (r.k == null && r.d == null && d.c.length >= 2);
    return `<div class="kchart-ov-row ${r.tf === cfg.mainTF ? 'ov-main' : ''}" data-tf="${r.tf}">
      <span class="kchart-ov-tf ${tfCls}" data-tf="${r.tf}">${r.tf}</span>
      <span class="kchart-ov-k">${r.k != null ? r.k.toFixed(1) : '--'}</span>
      <span class="kchart-ov-d">${r.d != null ? r.d.toFixed(1) : '--'}</span>
      <span class="kchart-ov-zone ${zoneCls[r.zone]}">${zoneLbl[r.zone]}${warnInsuf ? `<span class="kchart-ov-warn" title="参数过大/样本不足，K/D 无法计算（可调小该周期的 RSI/Stoch 周期）">⚠</span>` : ''}</span>
      <span class="kchart-ov-cross ${crossCls} ${r.reversed ? 'ov-reversed' : ''}" title="${cellTip}" data-tip="${cellTip}">${crossTxt}${r.gapNow != null ? `<span class="kchart-ov-gap">${r.gapNow.toFixed(1)}${r.gapTrend === 'up' ? '↑' : r.gapTrend === 'down' ? '↓' : '–'}</span>` : ''}</span>
      <span class="kchart-ov-eng ${engCls}" title="${r.energy ? r.energy.reason : ''}">${engTxt}</span>
      <span class="kchart-ov-fresh ${freshCls}">${freshTxt}</span>
      <span class="kchart-ov-gate ${gateCls}">${gateTxt}</span>
      <span class="kchart-ov-gear" data-tf="${r.tf}" title="查看/编辑该周期 SRSI 参数">⚙</span>
    </div>`;
  }).join('');
  box.innerHTML =
    `    <div class="kchart-ov-head-row"><span>周期</span><span>K</span><span>D</span><span>区域</span><span>破带/钩</span><span>能量</span><span>新鲜度</span><span>闸门</span><span>参数</span></div>` +
    rowHtml +
    `<div class="kchart-ov-foot">偏多 ${cb.bull} · 偏空 ${cb.bear} · ${verdict}${auxRows.length ? ` · 辅助放行(仅 ${auxRows.map(r => r.tf).join('/')} 同向放行/反向否决)` : ''}<span class="kchart-ov-trend">${trendTxt}</span></div>` +
    (() => {
      const ep = perTfSrsi(footTf, cfg.srsiByTf, cfg.srsi);
      const auxTag = cfg.srsiAux[footTf] ? ' ·辅助' : '';
      return `<div class="kchart-ov-footparams"><span class="kchart-ov-foottf">⚙${footTf}</span> SRSI参数: RSI${ep.rsiPeriod} / Stoch${ep.stochPeriod} / %K${ep.smoothK} / %D${ep.smoothD} / 超买${ep.overbought} · 超卖${ep.oversold}${auxTag}</div>`;
    })() +
    `<div class="kchart-ov-lead" id="kchartOvLead"></div>`;
}

// 速览表行点击 → 切换主图；点「破带/钩」单元格 → 弹出释义（桌面悬停 title + 手机点按，与能量球一致）
export function bindOverviewClick() {
  const box = document.getElementById('kchartOverview');
  if (!box || box.__bound) return;
  box.__bound = true;
  box.addEventListener('click', (e) => {
    const gear = e.target.closest('.kchart-ov-gear');
    if (gear && gear.dataset.tf) { _ovFootTf = gear.dataset.tf; openSrsiCardFor(gear.dataset.tf); return; }
    const cell = e.target.closest('.kchart-ov-cross');
    if (cell && cell.dataset.tip) { showOvCrossTip(cell.dataset.tip); return; }
    const tfCell = e.target.closest('.kchart-ov-tf');
    if (tfCell && tfCell.dataset.tf) showOvTfTip(tfCell.dataset.tf);
    const row = e.target.closest('.kchart-ov-row');
    if (row && row.dataset.tf) { _ovFootTf = row.dataset.tf; setMainTF(row.dataset.tf); }
  });
}

function showOvCrossTip(txt) {
  let tip = document.getElementById('ovCrossTip');
  if (!tip) { tip = document.createElement('div'); tip.id = 'ovCrossTip'; tip.className = 'ov-cross-tip'; document.body.appendChild(tip); }
  if (tip.__txt === txt && tip.style.display === 'block') { tip.style.display = 'none'; tip.__txt = null; clearTimeout(tip.__t); return; }
  tip.textContent = txt;
  tip.__txt = txt;
  tip.style.display = 'block';
  clearTimeout(tip.__t); tip.__t = setTimeout(() => { tip.style.display = 'none'; tip.__txt = null; }, 4000);
}

// 速览周期列点击: 弹「单根回报% + 显示窗口最低/最高价」提示（参考能量球节点提示）
function showOvTfTip(tf) {
  let tip = document.getElementById('ovTfTip');
  if (!tip) { tip = document.createElement('div'); tip.id = 'ovTfTip'; tip.className = 'ov-tf-tip'; document.body.appendChild(tip); }
  const d = getTFData(cfg.symbol, tf);
  const s = tfOverviewStat(d.c, d.l, d.h, d.t, cfg.bars, minutesOf(tf));
  if (!s.ok) {
    tip.innerHTML = `<div class="ov-tf-tip-head">${tf}</div><div>数据不足</div>`;
  } else {
    const up = s.chgPct > 0, down = s.chgPct < 0;
    const cls = up ? 'up' : down ? 'down' : '';
    const dirTxt = up ? '涨' : down ? '跌' : '平';
    const pct = (s.chgPct >= 0 ? '+' : '') + s.chgPct.toFixed(2) + '%';
    tip.innerHTML =
      `<div class="ov-tf-tip-head">${tf} <span class="${cls}">${dirTxt}</span></div>` +
      `<div>涨跌: <b class="${cls}">${pct}</b>（单根${tf}）</div>` +
      `<div>区间 最低 <b>${fmtPrice(s.low)}</b> — 最高 <b>${fmtPrice(s.high)}</b></div>`;
  }
  const oc = document.getElementById('ovCrossTip'); if (oc) oc.style.display = 'none';
  if (tip.__tf === tf && tip.style.display === 'block') { tip.style.display = 'none'; tip.__tf = null; clearTimeout(tip.__t); return; }
  tip.__tf = tf;
  tip.style.display = 'block';
  clearTimeout(tip.__t); tip.__t = setTimeout(() => { tip.style.display = 'none'; tip.__tf = null; }, 5000);
}

// ---- 交易纪律分析面板（DOM 渲染，防 hover 重建）----
// 实时价信息（纯函数，可单测）：读取 window.S.prices[sym] 计算距目标/止损百分比
export function discLiveInfo(sym, analysis) {
  const S = window.S;
  const p = S && S.prices && S.prices[sym];
  if (!p || p.last == null) return null;
  const out = { price: p.last, chg: p.chg || 0, toTarget: null, toStop: null, targetCls: '', stopCls: '', priceCls: '' };
  out.priceCls = p.chg > 0 ? 'disc-up' : p.chg < 0 ? 'disc-down' : '';
  const isLong = !!(analysis && analysis.entry && analysis.entry.dir.startsWith('看多'));
  const isShort = !!(analysis && analysis.entry && analysis.entry.dir.startsWith('看空'));
  const t = analysis && analysis.entry && analysis.entry.target;
  const s = analysis && analysis.entry && analysis.entry.stop;
  if (t != null) { out.toTarget = (t - p.last) / p.last * 100; if ((isLong && p.last >= t) || (isShort && p.last <= t)) out.targetCls = 'disc-pos'; }
  if (s != null) { out.toStop = (s - p.last) / p.last * 100; if ((isLong && p.last <= s) || (isShort && p.last >= s)) out.stopCls = 'disc-neg'; }
  return out;
}

let _lastDiscAnalysis = null;

// ---- 方向基准死区滞回状态（每 币|基准周期 一份，仅内存，不持久化）----
// 由 updateHorizonState 在 renderKChart 每次推进（DOM 未重建也推进，保证 CONFIRM 计数正确），
// renderSrsiOverview 与 renderTradeDiscipline 共用同一 deadZone，保证两面板口径一致。
const __hzLatch = new Map();
const __hzCache = { key: null, trend: null, deadZone: THRESH.HORIZON_DEAD_FIXED, deadMode: 'fixed', ratio: null };

export function updateHorizonState(sym, priceMap, capMin) {
  const cap = capMin != null ? capMin : THRESH.HORIZON_CAP_MIN;
  const trend = horizonTrend(priceMap, { capMin: cap });
  const key = trend ? sym + '|' + trend.tf : null;
  if (key !== __hzCache.key) {
    __hzLatch.delete(__hzCache.key);
    __hzCache.key = key;
  }
  let his = [], ratio = null;
  if (key) {
    his = atrPctHistory(priceMap[trend.tf]);
    if (his.length >= THRESH.HORIZON_ATR_MIN) {
      const s = [...his].filter(v => typeof v === 'number' && isFinite(v) && v > 0).sort((a, b) => a - b);
      const med = s.length ? s[Math.floor(s.length / 2)] : null;
      ratio = med > 0 ? his[his.length - 1] / med : null;
    }
    const st = deadZoneLatch(ratio, __hzLatch.get(key));
    __hzLatch.set(key, st);
    __hzCache.deadMode = st.mode;
  } else {
    __hzCache.deadMode = 'fixed';
  }
  __hzCache.ratio = ratio;
  __hzCache.deadZone = deadZoneValue(__hzCache.deadMode, his);
  // 用当前(可能自适应)死区重算 trend——死区只影响 flat、不影响候选TF；
  // 保证速览页脚(hz.trend)与纪律面板(用 hz.deadZone 重算)口径一致(5.28「两面板口径一致」)
  __hzCache.trend = trend ? horizonTrend(priceMap, { capMin: cap, deadZone: __hzCache.deadZone }) : trend;
  return __hzCache;
}

// 轻量实时价刷新：在 _discSig 守卫之前调用，每 800ms tick 都执行，实现真·实时
// 价跳瞬时驱动能量球颜色（drawEnergyBall 每帧检测 + updateDiscLivePrice 写入；0.6s 内衰减）
let _energyFlash = { t: -1e9, dir: 0 };
let _lastFlashPrice = null;

function updateDiscLivePrice(box) {
  const priceEl = box.querySelector('#kchartDiscPrice');
  if (!priceEl) return;
  const info = discLiveInfo(cfg.symbol, _lastDiscAnalysis);
  if (!info) { priceEl.textContent = '—'; return; }
  priceEl.textContent = info.price.toFixed(2);
  priceEl.className = 'disc-price-val ' + info.priceCls;
  const distEl = box.querySelector('#kchartDiscDist');
  if (distEl) {
    const tTxt = info.toTarget != null ? ('目标 <b class="' + info.targetCls + '">' + (info.toTarget >= 0 ? '+' : '') + info.toTarget.toFixed(2) + '%</b>') : '';
    const sTxt = info.toStop != null ? ('止损 <b class="' + info.stopCls + '">' + (info.toStop >= 0 ? '+' : '') + info.toStop.toFixed(2) + '%</b>') : '';
    distEl.innerHTML = (tTxt + (tTxt && sTxt ? ' · ' : '') + sTxt) || '—';
  }
  // 价跳 → 驱动能量球颜色瞬时偏移（与 drawEnergyBall 每帧检测互补，确保实时）
  if (info && isFinite(info.price)) {
    if (_lastFlashPrice != null && info.price !== _lastFlashPrice) {
      const now = (globalThis.performance && globalThis.performance.now) ? globalThis.performance.now() : Date.now();
      _energyFlash = { t: now, dir: info.price > _lastFlashPrice ? 1 : -1 };
    }
    _lastFlashPrice = info.price;
  }
}

// HTML 转义：纪律面板用 innerHTML 渲染 reason/note/confParts，避免其中的 '<'（如 K<D）被当成标签开头截断
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

export function renderTradeDiscipline(hz, capMin) {
  const box = document.getElementById('kchartDisc');
  if (!box) return;
  const sym = cfg.symbol;
  updateDiscLivePrice(box);
  const selTfs = KLINE_TF.filter(tf => cfg.klineSel[tf]);
  if (!selTfs.length) return;
  const priceMap = {};
  KLINE_TF.forEach(tf => { const c = getTFData(sym, tf).c; priceMap[tf] = c; });

  const deadZone = hz ? hz.deadZone : THRESH.HORIZON_DEAD_FIXED;
  const deadMode = hz ? hz.deadMode : 'fixed';
  const _ls = (typeof globalThis !== 'undefined' && globalThis.__localTsev) ? globalThis.__localTsev.status() : null;
  const sig = buildDiscSig(cfg, priceMap, deadMode, deadZone, _ls);
  if (sig === _discSig) return;
  _discSig = sig;

  const cap = capMin != null ? capMin : THRESH.HORIZON_CAP_MIN;
  const perTf = (tf) => perTfSrsi(tf, cfg.srsiByTf, cfg.srsi);
  const auxTfs = Object.keys(cfg.srsiAux || {}).filter(tf => cfg.srsiAux[tf]);
  const analysis = analyzeTradeDiscipline(priceMap, perTf, { bars: cfg.bars, mainTF: cfg.mainTF, klineSel: cfg.klineSel, capMin: cap, deadZone, deadMode, sym, auxTfs });
  if (!analysis) { box.innerHTML = '<div class="kchart-disc-empty">⏳ 数据不足</div>'; return; }
  _lastDiscAnalysis = analysis;

  const { trend, multiTf, zones, confirm, entry, rules, leading, energyRows, strategy, signalLife, shortFactors } = analysis;
  const stratLabel = strategy === 'energy-leader' ? '能量领跑' : strategy === 'freshest-signal' ? '动量跟随' : '趋势跟随';
  const stratCls = strategy === 'energy-leader' ? 'strat-leader' : strategy === 'freshest-signal' ? 'strat-fresh' : 'strat-baseline';
  const dirColor = entry.dir.startsWith('看多') ? 'disc-bull' : entry.dir.startsWith('看空') ? 'disc-bear' : 'disc-neutral';
  const confColor = entry.confLabel === '高' ? 'conf-high' : entry.confLabel === '中' ? 'conf-mid' : 'conf-low';
  const zoneEmoji = { overbought: '🔴超买', oversold: '🟢超卖', neutral: '⚪中性' };
  const trendEmoji = trend.up === true ? '📈' : trend.up === false ? '📉' : '—';
  const deadTxt = deadMode === 'adaptive'
    ? ` · 死区自适应${deadZone.toFixed(2)}%(${hz && hz.ratio >= 1 ? '高波动' : '低波动'})`
    : ` · 死区固定${deadZone.toFixed(2)}%`;
  const regimeLabel = analysis.regime && analysis.regime.label ? analysis.regime.label : '—';

  const rulesHtml = rules.map(r =>
    `<div class="kchart-disc-rule ${r.ok ? 'disc-rule-ok' : 'disc-rule-warn'}">
      <span class="disc-rule-icon">${r.ok ? '✓' : '⚠'}</span>
      <span class="disc-rule-name">${r.name}</span>
      <span class="disc-rule-note">${esc(r.note)}</span>
    </div>`
  ).join('');
  const confPartsHtml = entry.confParts.length ? entry.confParts.join(' · ') : '基准' + entry.conf;
  const tradeBarHtml = `${leading ? `<div class="disc-lead disc-lead-${leading.dir === 'buy' ? 'bull' : 'bear'}">⚡ 能量领跑: ${leading.tf} (${leading.score}) ${leading.dir === 'buy' ? '偏多' : '偏空'}${leading.isClear ? ' · 独一档' : ''}</div>` : ''}${energyRows && energyRows.length ? `<div class="disc-engbar">${energyRows.map(e => `<span class="disc-eng-cell ${e.score >= 60 ? 'disc-eng-hi' : e.score >= 30 ? 'disc-eng-mid' : 'disc-eng-lo'}">${e.tf} ${e.dir ? (e.dir === 'buy' ? '▲' : '▼') : '—'}${e.score}</span>`).join('')}</div>` : ''}`;

  // ---- 风险带：聚合负向因子 → 一句直觉警告（仅呈现层，不改判断逻辑）----
  const riskItems = [];
  const dirLong = entry.dir.startsWith('看多');
  const dirShort = entry.dir.startsWith('看空');
  if (dirLong && zones.daily === 'overbought') riskItems.push('日线超买(反向)');
  if (dirShort && zones.daily === 'oversold') riskItems.push('日线超卖(反向)');
  if (multiTf.verdict === '分歧') riskItems.push('多周期分歧');
  else if (dirLong && multiTf.bear >= multiTf.bull) riskItems.push('动能偏空');
  else if (dirShort && multiTf.bull >= multiTf.bear) riskItems.push('动能偏多');
  if (analysis.macroConflict) riskItems.push('宏观反向');
  if (confirm.dir && !confirm.confirmed && !confirm.contrarian) {
    riskItems.push(confirm.isHook ? dirName(confirm.dir, true) : dirName(confirm.dir, false) + '未确认');
  }
  if (leading && leading.dir && ((dirLong && leading.dir === 'sell') || (dirShort && leading.dir === 'buy')))
    riskItems.push(leading.tf + '能量反向');
  const riskTag = riskItems.length ? riskItems.slice(0, 4).map(x => `<span class="disc-risk-tag">${x}</span>`).join('') : '<span class="disc-risk-tag disc-risk-clear">暂无显著风险</span>';
  let warnTxt = '无显著风险';
  if (riskItems.length) {
    if (riskItems.includes('日线超买')) warnTxt = dirLong ? '⚠ 日线超买, 仅当回调低吸, 勿追高' : '⚠ 日线超买, 反弹高位, 谨慎';
    else if (riskItems.includes('日线超卖')) warnTxt = dirShort ? '⚠ 日线超卖, 仅当反弹看空, 勿追空' : '⚠ 日线超卖, 回调低位, 谨慎';
    else if (riskItems.includes('宏观反向')) warnTxt = '⚠ 大趋势与方向反向, 仅降置信, 勿满仓';
    else warnTxt = '⚠ ' + riskItems[0] + ', 注意风控';
  }
  const evidenceOpen = cfg.discEvidenceOpen ? ' open' : '';

  // ---- TSEV 数据源 / 样本量 / 实时状态 / 前向准确度（按当前币）----
  const ti = getTsevInfo();
  const psInfo = (ti.perSym && ti.perSym[sym]) || null;
  const srcLabel = (psInfo && psInfo.source === 'local') ? '本机(你的设备·' + sym + ')'
    : (psInfo && psInfo.source === 'global') ? '全局(官方)'
    : (ti.source === 'local' ? '本机(你的设备)' : ti.source === 'global' ? '全局(官方)' : '经典逻辑(未启用)');
  let loopTxt = '';
  let accTxt = '';
  let dbgTxt = '';
  try {
    const loopStat = (typeof globalThis !== 'undefined' && globalThis.__localTsev) ? globalThis.__localTsev.status() : null;
    if (loopStat) {
      const fc = (psInfo && psInfo.factorCount) || loopStat.factorCount || 0;
      const sc = loopStat.sampleCount || 0;
      const active = loopStat.running || loopStat.backfilling;
      const liveDot = loopStat.enabled ? '<span class="disc-tsev-live" title="本机loop 运行中（每60min采样 + 首次载入回补历史）"></span>' : '';
      loopTxt = ` · 本机loop ${loopStat.enabled ? '开' : '关'}${liveDot}${active ? '<span class="disc-tsev-spin"></span>' : ''} · 本机样本 ${sc} · 已学因子(本币) ${fc}`;
      if (loopStat.backfilling) {
        const ps = loopStat.perSym || {};
        const total = Object.keys(ps).length;
        const done = Object.values(ps).filter(p => p && p.backfilled).length;
        loopTxt += ` · 回补中(${done}/${total})`;
        const cur = loopStat.progress && loopStat.progress.sym;
        const pct = (loopStat.progress && typeof loopStat.progress.pct === 'number') ? loopStat.progress.pct : 0;
        if (cur && ps[cur]) {
          if (ps[cur].error) loopTxt += ` ${cur}:${ps[cur].error}`;
          else if (ps[cur].total == null) loopTxt += ` ${cur} ${Math.round(pct * 100)}%`;
          else loopTxt += ` ${cur} ${ps[cur].done || 0}/${ps[cur].total}`;
        }
      }
      // 前向准确度（walk-forward 重放 TSEV 投票）：让用户判断是否可信
      try {
        const fa = globalThis.__localTsev.forwardAccuracy ? globalThis.__localTsev.forwardAccuracy(sym) : null;
        if (fa && fa.n) {
          const pct = Math.round(fa.acc * 100);
          const cls = pct >= 55 ? 'disc-acc-hi' : pct >= 45 ? 'disc-acc-mid' : 'disc-acc-lo';
          let ph = '';
          if (fa.perHorizon) {
            const parts = ['h4', 'd1', 'd3'].filter(h => fa.perHorizon[h] != null)
              .map(h => `${h}:${Math.round(fa.perHorizon[h] * 100)}%`);
            if (parts.length) ph = ` (${parts.join(' ')})`;
          }
          accTxt = ` · <span class="${cls}">本机前向命中率 ${pct}%(${fa.n}笔)${ph}</span>`;
        }
      } catch (e) {}
      // 本机因子明细（诊断用 A）：列出已学因子态的有效样本/命中率/权重，便于肉眼看学到哪几个、质量几何
      dbgTxt = '';
      try {
        const dbg = globalThis.__localTsev.debugTsev ? globalThis.__localTsev.debugTsev(sym) : null;
        if (dbg && dbg.length) {
          const learned = dbg.filter(d => d.passed).slice(0, 8)
            .map(d => `${d.key.replace(/\|/g, '·')} p${d.p} n${d.n} w${d.w > 0 ? '+' : ''}${d.w}`);
          if (learned.length) {
            dbgTxt = `<br><span class="disc-tsev-debug">本机因子明细: ${learned.join(' | ')}</span>`;
            if (!window.__tsevDbgT || Date.now() - window.__tsevDbgT > 15000) {
              window.__tsevDbgT = Date.now();
              console.log('[TSEV因子表]', sym, dbg.filter(d => d.passed).map(d => `${d.key} p=${d.p} n=${d.n} w=${d.w}`).join(' | '));
            }
          }
        }
      } catch (e) {}
    } else {
      const ps = loopStat.perSym || {};
      const errs = Object.entries(ps).filter(([, p]) => p && p.error).map(([s, p]) => `${s}:${p.error}`);
      if (errs.length) loopTxt += ` · 回补异常(${errs.join(',')})`;
      else if (loopStat.running) loopTxt += ` · 采样中`;
    }
  } catch (e) { loopTxt = ''; }
  // TSEV 是否真在发挥作用：与「无 TSEV 权重(经典)」判决对比
  let tsevEffectTxt = 'TSEV 未启用（本机样本不足），当前即经典逻辑';
  if (ti.source === 'local' || ti.source === 'global') {
    try {
      const classicA = analyzeTradeDiscipline(priceMap, perTf, { bars: cfg.bars, mainTF: cfg.mainTF, klineSel: cfg.klineSel, capMin: cap, deadZone, deadMode, weights: null, sym, auxTfs });
      const cDir = classicA && classicA.entry ? classicA.entry.dir : '观察';
      const cConf = classicA && classicA.entry ? classicA.entry.conf : 0;
      const tDir = entry.dir, tConf = entry.conf;
      const same = tDir.slice(0, 2) === cDir.slice(0, 2);
      if (same) tsevEffectTxt = `TSEV 与经典同向，置信 ${cConf}→${tConf}（${tConf >= cConf ? '+' : ''}${tConf - cConf}）`;
      else tsevEffectTxt = `⚡ TSEV 翻转判决：经典 ${cDir}(${cConf}) → TSEV ${tDir}(${tConf})`;
    } catch (e) { tsevEffectTxt = 'TSEV 对比计算失败'; }
  }
  // 行情中立护栏提示：权重只学到单一方向(如仅上涨行情) → 已回退经典逻辑
  let unbalTxt = '';
  try {
    const _curW = getTsevWeights(sym);
    if (_curW && _curW.__unbalanced && Object.keys(_curW).filter(k => !k.startsWith('__')).length) {
      const _posW = _curW.__pos || 0, _negW = _curW.__neg || 0;
      if (_posW < 1e-9 && _negW < 1e-9) {
        unbalTxt = `<br><span class="disc-tsev-unbal">⚠ TSEV 暂无有效方向样本，已回退经典逻辑</span>`;
      } else {
        const _side = (_posW > _negW) ? '涨' : '跌';
        unbalTxt = `<br><span class="disc-tsev-unbal">⚠ TSEV 仅学到看${_side}方向(样本偏${_side}行情)，可给看${_side}、暂不给反向；跨涨跌累积后变完整</span>`;
      }
    }
  } catch (e) {}
  const tsevBar = `<div class="disc-tsev-bar">📊 TSEV 判决权重源: <b>${srcLabel}</b> · 全局样本 ${ti.globalN} / 本机 ${ti.localN}${loopTxt}${accTxt}<br><span class="disc-tsev-effect">${tsevEffectTxt}</span>${unbalTxt}${dbgTxt}<br><span class="disc-tsev-hint">本机样本越多越贴合你的设备行情（PWA 打开期间每 60min 自动累积 + 首次载入全部币种近4年历史回补；桌面重训后可导出 JSON 在手机导入共享）</span></div>`;

  // ---- 信号指示：方向来自经典或 TSEV，避免「看多」头部与「信号不足」矛盾 ----
  const _dirLong = entry.dir.startsWith('看多');
  const _dirShort = entry.dir.startsWith('看空');
  const _dirClear = _dirLong || _dirShort;
  const _tsevAct = analysis.tsev ? analysis.tsev.actionable : null; // null = 未启用
  let _sigCls, _sigTxt;
  if (_dirClear) {
    if (_tsevAct === true) { _sigCls = 'disc-signal-go'; _sigTxt = '✅ 可交易信号（TSEV 置信达标、方向明确）'; }
    else if (_tsevAct === false) { _sigCls = 'disc-signal-wait'; _sigTxt = '⚠ 方向' + (_dirLong ? '偏多' : '偏空') + '（TSEV 置信不足，谨慎轻仓）'; }
    else { _sigCls = 'disc-signal-wait'; _sigTxt = '⏳ 方向' + (_dirLong ? '偏多' : '偏空') + '（经典逻辑，TSEV 未启用）'; }
  } else {
    _sigCls = 'disc-signal-wait'; _sigTxt = '⏸ 观望 / 信号不足（样本少 · 置信低 · 方向分歧）';
  }

  const pathP0 = (function () { const li = discLiveInfo(cfg.symbol, analysis); return li ? li.price : (analysis.entry.target || 0); })();
  const pathForecast = pricePathForecast(analysis, pathP0, { horizonBars: 12 });
  const pathBasisHtml = pathForecast.pullbackBasis.join(' · ');
  const pathDirWord = pathForecast.bullish ? '做多' : (pathForecast.dir.indexOf('看空') >= 0 ? '做空' : '观望');
  const pathDirCls = pathForecast.bullish ? 'disc-pos' : (pathForecast.dir.indexOf('看空') >= 0 ? 'disc-neg' : 'disc-neutral');
  const pathDirBadge = `<span class="disc-dir-badge ${pathDirCls}">方向: ${pathDirWord}</span>`;

  box.innerHTML = `
    <div class="kchart-disc-header">
      <span class="disc-title">📋 交易纪律分析</span>
    </div>

    <div class="disc-blocks">
      <!-- ① 判决 -->
      <div class="disc-block disc-block-verdict">
        <div class="disc-action ${dirColor}">
          <span class="disc-dir">${entry.dir}</span>
          <span class="disc-conf ${confColor}">${entry.confLabel} · ${entry.conf}</span>
          <span class="disc-risk">${entry.risk}</span>
        </div>
        <div class="disc-signal ${_sigCls}">${_sigTxt}</div>
        <div class="disc-reason">${esc(entry.reason)}</div>
        <div class="disc-nowprice">当前价: <span id="kchartDiscPrice">—</span> <span id="kchartDiscDist" class="disc-dist"></span></div>
        <div class="disc-plan"><span class="disc-plan-item">入场: ${entry.entryCue}</span><span class="disc-plan-item">目标: ${entry.target != null ? entry.target.toFixed(2) : '—'}</span><span class="disc-plan-item">止损: ${entry.stop != null ? entry.stop.toFixed(2) : '—'}</span><span class="disc-plan-item disc-plan-size">建议仓位: ×${analysis.sizing.mult}</span></div>
      </div>

      <!-- ①½ 仓位阶梯（长×中×短 三周期对齐） -->
      <div class="disc-block disc-block-sizing ${analysis.sizing.cls}">
        <div class="disc-blk-label">📐 趋势×短线 仓位建议</div>
        <div class="disc-sizing-main">宏观 ${analysis.longUp === true ? '↑看多' : analysis.longUp === false ? '↓看空' : '—中性'} · 中(4h) ${trend.up === true ? '↑看多' : trend.up === false ? '↓看空' : '—横盘'} · 短(SRSI·≤4h含4h+钩反转) ${multiTf.verdict} → <b>${analysis.sizing.label}</b>（×${analysis.sizing.mult}）</div>
        <div class="disc-sizing-hint">${esc(analysis.sizing.hint)}</div>
      </div>

      <!-- ①¾ 短线多空能量场（≤4h 多维加权可视化卡片） -->
      <div class="disc-block disc-block-energyball">
        <div class="disc-blk-label">短线多空能量场（≤4h 多维加权·含钩反转）</div>
        <div class="disc-energy-wrap">
          <canvas id="discEnergyBall" width="300" height="300"></canvas>
          <div id="discEnergyTip" class="disc-energy-tip" style="display:none"></div>
        </div>
        <div class="disc-energy-verdict">${shortFactors && shortFactors.length ? ('短线共识: ' + multiTf.verdict + '（加权' + (multiTf.ratio * 100).toFixed(0) + '%多）' + (multiTf.hookOverride ? ' · ⚠ 低位带+1h钩反转动能' : '')) : '数据不足'}</div>
        <div class="disc-energy-legend">环: 弧长=K位置(满圈100) · 绿涨(K&gt;D)红跌 · 线粗=差距|K−D|大 · ◆钩●钗 · 淡绿超卖带/淡红超买带 · 速览表「破带/钩」列非K-D交叉(破超买=K破80/破超卖=K破20)</div>
        <div class="disc-energy-hint">桌面悬停 / 手机点节点看五因子明细</div>
      </div>

      <!-- ①¾⅛ 短线价格路径预测（主路径·止盈 + 反向·止损备选） -->
      <div class="disc-block disc-block-path">
        <div class="disc-blk-label">短线价格路径预测（主路径·止盈 + 反向·止损备选） ${pathDirBadge}</div>
        <div class="disc-path-wrap">
          <canvas id="discPricePath" width="320" height="200"></canvas>
          <div id="discPathTip" class="disc-path-tip" style="display:none"></div>
        </div>
        <div class="disc-path-basis">${pathBasisHtml}</div>
      </div>

      <!-- ② 市场情境 -->
      <div class="disc-block disc-block-regime">
        <div class="disc-blk-label">市场情境</div>
        <div class="disc-regime">${trendEmoji} ${regimeLabel} · EMA(${trend.tf}) ${trend.up === true ? '↑' : trend.up === false ? '↓' : '—'} ${trend.spreadPct.toFixed(2)}%${deadTxt}</div>
        <div class="disc-strategy ${stratCls}">策略: ${stratLabel}</div>
      </div>
      ${analysis.contraTrade ? `<div class="disc-counter">⚠ 逆势操作：长周期趋势 ${trend.up === true ? '向上' : '向下'} 但短线动能反向，逆势单仅限轻仓/小仓位并严格止损</div>` : ''}

      <!-- ③ 依据 / ④ 时机 / ⑤ 风险（三带） -->
      <div class="disc-bandrow">
        <div class="disc-band disc-band-evidence">
          <div class="disc-blk-label">方向依据</div>
          <div class="disc-band-txt">${analysis.basisNote}</div>
        </div>
        <div class="disc-band disc-band-timing">
          <div class="disc-blk-label">时机(动能)</div>
          <div class="disc-band-txt"><span class="${multiTf.verdict === '分歧' ? 'disc-warn-text' : ''}">共振 ${multiTf.bull}多·${multiTf.bear}空 → ${multiTf.verdict}</span> · 入场确认 ${confirm.contrarian ? '⚠ 反向' : (confirm.confirmed ? '✅ 已确认' : '⏳ 等待')}</div>
          ${signalLife ? `<div class="disc-band-txt disc-sig ${signalLife.cls}">信号生命周期: ${signalLife.txt} · 信号置信 <b>${signalLife.conf}</b>` : ''}</div>
        </div>
        <div class="disc-band disc-band-risk">
          <div class="disc-blk-label">风险</div>
          <div class="disc-risk-tags">${riskTag}</div>
          <div class="disc-warn ${riskItems.length ? '' : 'disc-warn-clear'}">${warnTxt}</div>
        </div>
      </div>

      <!-- ⑥ 证据（可折叠，记住状态） -->
      <div class="disc-block disc-block-evidence">
        <details class="disc-details"${evidenceOpen}>
          <summary class="disc-details-summary" onclick="event.stopPropagation(); window.setDiscEvidence(!this.parentElement.open)">证据详情（规则 · 能量 · 确认 · 调整）<span class="disc-details-arrow">▸</span></summary>
          <div class="disc-details-body">
            ${analysis.conflictNote ? `<div class="disc-conflict">⚠ ${analysis.conflictNote}</div>` : ''}
            ${analysis.macroConflict ? `<div class="disc-conflict">${analysis.macroConflict} 已扣 ` + (entry.confParts.find(p => p.includes('宏观反向')) || '') + `</div>` : ''}
            <div class="disc-zone">${zones.dailyTf === '1d' ? '日线' : (zones.dailyTf || '日线')} ${zoneEmoji[zones.daily] || '—'} · 主周期 ${zoneEmoji[zones.main] || '—'}</div>
            <div class="disc-consensus">多周期(≤4h加权): 偏多${multiTf.bull} 偏空${multiTf.bear} · 加权${(multiTf.ratio * 100).toFixed(0)}%多 → ${multiTf.verdict} · 偏多[${multiTf.bullTfs.join('/')}] 偏空[${multiTf.bearTfs.join('/')}]</div>
            <div class="disc-confirm">入场确认: ${confirm.contrarian ? '⚠ 反向信号' : (confirm.confirmed ? '✅ 已确认' : '⏳ 等待')} ${confirm.tf ? '(' + confirm.tf + ' ' + dirName(confirm.dir, confirm.isHook) + ' ' + confirm.fresh + '根前' + (confirm.isHook ? ' [钩]' : '') + ')' : ''}</div>
            ${signalLife ? `<div class="disc-life">信号生命周期: <b class="${signalLife.cls}">${signalLife.txt}</b> · 信号置信 <b>${signalLife.conf}</b> · 能量 ${signalLife.score}</div>` : ''}
            ${tradeBarHtml}
            <div class="disc-rules">${rulesHtml}</div>
            <div class="disc-conf-detail">调整: ${esc(confPartsHtml)}</div>
          </div>
        </details>
      </div>

      ${tsevBar}
    </div>
  `;

  // v1.5.52：缓存能量场数据（HUD 动力卡用）；面板已收起（HUD 接管）时跳过球初始化，避免抢走 HUD 球的 RAF
  const _discWrapEl = document.getElementById('kchartDiscWrap');
  const _discWrapClosed = !!(_discWrapEl && _discWrapEl.classList.contains('closed'));
  if (!_discWrapClosed) initEnergyBall(box, shortFactors, multiTf, sym);
  initPricePath(box, analysis, sym, pathP0);
}

// ============ 短线多空能量场（Canvas 粒子可视化卡片）============
const fmt2 = v => (v == null || !isFinite(v)) ? '—' : (Math.round(v * 100) / 100).toString();

// 布局（纯函数，可单测）：中心球 + 环绕节点 + 连线。返回坐标模型供绘制/单测。
export function energyBallLayout(shortFactors, multiTf, W, H) {
  W = W || 300; H = H || 300;
  const cx = W / 2, cy = H / 2;
  const wb = (multiTf && multiTf.wbull) || 0, we = (multiTf && multiTf.wbear) || 0;
  const tot = wb + we;
  const ratio = tot > 0 ? wb / tot : 0.5;
  const s = tot > 0 ? (wb - we) / tot : 0;        // 净强度 ∈ [-1,1]
  const verdict = (multiTf && multiTf.verdict) || '分歧';
  const orbR = 26 + Math.abs(s) * 22;
  const nodes = (shortFactors || []).filter(f => f.dir).map(f => Object.assign({}, f));
  const n = nodes.length;
  const ringR = Math.min(W, H) * 0.36;
  const maxW = nodes.reduce((m, f) => Math.max(m, f.w), 0) || 1;
  nodes.forEach((f, i) => {
    const ang = -Math.PI / 2 + (n > 1 ? (i / n) * Math.PI * 2 : 0);
    f.ang = ang;
    f.x = cx + Math.cos(ang) * ringR;
    f.y = cy + Math.sin(ang) * ringR;
    f.r = 6 + (f.w / maxW) * 14;
    f.color = f.dir === 'bull' ? '#00E676' : '#FF5252';
  });
  const edges = nodes.map(f => ({ tf: f.tf, x: f.x, y: f.y, w: f.w, maxW, dir: f.dir }));
  return { cx, cy, orbR, strength: s, ratio, verdict, nodes, edges, W, H };
}

// 能量球节点命中检测（纯函数, 可单测）：模型坐标空间(0~W)内的命中判定。
// 直距放大到 r+14 命中；未中则环带内按角度就近(触屏容错)。返回命中节点或 null。
export function energyBallHitTest(model, mx, my) {
  let best = null, bestD = Infinity;
  for (const f of (model.nodes || [])) {
    const d = Math.hypot(f.x - mx, f.y - my);
    if (d <= f.r + 14 && d < bestD) { best = f; bestD = d; }
  }
  if (!best) {
    const cx = model.cx, cy = model.cy, ringR = (model.W || 300) * 0.36;
    const d = Math.hypot(mx - cx, my - cy);
    if (d >= ringR - 40 && d <= ringR + 44) {
      const ang = Math.atan2(my - cy, mx - cx);
      let bestDA = Infinity;
      for (const f of (model.nodes || [])) {
        const fa = Math.atan2(f.y - cy, f.x - cx);
        let da = Math.abs(ang - fa); if (da > Math.PI) da = 2 * Math.PI - da;
        if (da < 0.5 && da < bestDA) { bestDA = da; best = f; }
      }
    }
  }
  return best;
}

// 反转内点颜色（与节点相反）：看多绿→红，看空红→绿（能量球内点渲染用，纯函数可测）
export function reversalInnerColor(dir) {
  return dir === 'bull' ? [255, 82, 82] : [0, 230, 118];
}

// KD 环形进度：位置占比(满圈=100) 与 带区判定（纯函数可测）
export function kdSweepFrac(kd) {
  const v = Number(kd);
  if (!isFinite(v)) return 0;
  return Math.max(0, Math.min(100, v)) / 100;
}
export function kdZone(kd, ob, os) {
  const O = (ob != null) ? ob : DEFAULT_SRSI.overbought;
  const S = (os != null) ? os : DEFAULT_SRSI.oversold;
  const v = Number(kd);
  if (!isFinite(v)) return 'neutral';
  if (v >= O) return 'overbought';
  if (v <= S) return 'oversold';
  return 'neutral';
}

// 绘制一帧（ctx 已按 DPR scale）。粒子/脉冲由 t 驱动；price 用于价跳微调制。
export function drawEnergyBall(ctx, model, opts) {
  const o = opts || {};
  const t = o.t || 0;
  const price = (o.price != null) ? o.price : null;
  const W = model.W || 300, H = model.H || 300;
  const { cx, cy, orbR, strength, nodes, edges, verdict } = model;
  ctx.clearRect(0, 0, W, H);

  // 背景旋转虚线环
  ctx.save();
  ctx.translate(cx, cy); ctx.rotate(t * 0.3);
  ctx.strokeStyle = 'rgba(255,107,53,0.18)'; ctx.lineWidth = 1; ctx.setLineDash([4, 8]);
  ctx.beginPath(); ctx.arc(0, 0, Math.min(W, H) * 0.42, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();

  // 连线（粗细 ∝ 权重）
  edges.forEach(e => {
    const a = e.w / (e.maxW || 1);
    ctx.strokeStyle = e.dir === 'bull' ? `rgba(0,230,118,${0.15 + a * 0.5})` : `rgba(255,82,82,${0.15 + a * 0.5})`;
    ctx.lineWidth = 1 + a * 4;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(e.x, e.y); ctx.stroke();
  });

  // 能量粒子（绕球漂移，颜色随 verdict；分歧=灰散态: 灰、更散、更暗）
  const isDiv = verdict === '分歧';
  const pc = isDiv ? '120,130,150' : verdict === '一致偏多' ? '0,230,118' : '255,82,82';
  const NP = 60, base = Math.min(W, H);
  for (let i = 0; i < NP; i++) {
    const ph = i * 2.39996;
    const rr = isDiv
      ? base * (0.08 + ((i * 13) % Math.round(base * 0.42)) / base)
      : base * 0.10 + ((i * 7) % (base * 0.30));
    const ang = ph + t * (isDiv ? (0.1 + (i % 7) * 0.03) : (0.2 + (i % 5) * 0.05));
    const px = cx + Math.cos(ang) * rr, py = cy + Math.sin(ang) * rr;
    const alpha = (isDiv ? 0.12 : 0.25) + (isDiv ? 0.1 : 0.25) * Math.sin(t * 2 + i);
    ctx.fillStyle = `rgba(${pc},${Math.max(0, alpha)})`;
    ctx.beginPath(); ctx.arc(px, py, isDiv ? 1.0 : 1.2, 0, Math.PI * 2); ctx.fill();
  }

  // 中心球（脉冲 + 价跳微调制 + 价跳瞬时颜色偏移）
  const nowMs = (globalThis.performance && globalThis.performance.now) ? globalThis.performance.now() : Date.now();
  if (price != null) {
    if (model._lp != null && price !== model._lp) _energyFlash = { t: nowMs, dir: price > model._lp ? 1 : -1 };
    model._lp = price;
  }
  const flashAge = (nowMs - _energyFlash.t) / 1000;
  let baseCol = strength > 0.05 ? [0, 230, 118] : strength < -0.05 ? [255, 82, 82] : [150, 160, 180];
  if (flashAge >= 0 && flashAge < 0.6) {
    const k = 1 - flashAge / 0.6;
    const tgt = _energyFlash.dir > 0 ? [0, 230, 118] : [255, 82, 82];
    baseCol = baseCol.map((c, i) => Math.round(c + (tgt[i] - c) * 0.7 * k));
  }
  const col = baseCol.join(',');
  const pulse = 0.5 + 0.5 * Math.sin(t * 2.2);
  const priceBoost = price != null ? 0.12 * Math.sin(t * 6) : 0;
  const r = orbR * (1 + 0.06 * pulse + priceBoost);
  const grad = ctx.createRadialGradient(cx, cy, r * 0.2, cx, cy, r);
  grad.addColorStop(0, `rgba(${col},0.95)`);
  grad.addColorStop(0.6, `rgba(${col},0.5)`);
  grad.addColorStop(1, `rgba(${col},0.05)`);
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = `rgba(${col},0.9)`; ctx.lineWidth = 1.5; ctx.stroke();

  // 中心净强度%
  ctx.fillStyle = '#0A0E14';
  ctx.font = 'bold 12px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText((strength * 100).toFixed(0), cx, cy);
  ctx.textBaseline = 'alphabetic';

  // 节点 + 标签
  nodes.forEach(f => {
    ctx.fillStyle = f.color; ctx.shadowColor = f.color; ctx.shadowBlur = 8;
    ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    // 反转信号：球内显示相反颜色的脉冲小点（绿→红 / 红→绿），白圈描边保证对比
    if (f.reversed) {
      const ip = 0.85 + 0.15 * Math.sin(t * 4);
      const ir = f.r * 0.42 * ip;
      const [ir_r, ir_g, ir_b] = reversalInnerColor(f.dir);
      ctx.save();
      ctx.beginPath(); ctx.arc(f.x, f.y, f.r * 0.82, 0, Math.PI * 2); ctx.clip();
      ctx.fillStyle = `rgba(${ir_r},${ir_g},${ir_b},0.95)`;
      ctx.beginPath(); ctx.arc(f.x, f.y, ir, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(f.x, f.y, ir, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
    // 球外 KD 环形进度虚线（无文字）：弧长=K在0-100位置；颜色=K>D涨(绿)/K<D跌(红)/平(灰)；线宽∝|K-D|；端点◆钩/●钗；带区0-20%淡绿·80-100%淡红
    if (f.k != null && f.d != null && isFinite(f.k) && isFinite(f.d)) {
      const kd = Math.max(0, Math.min(100, f.k));
      const ringR = f.r + 5;
      const startA = Math.PI;                                  // 球左侧(9点)起
      const endA = startA + kdSweepFrac(kd) * Math.PI * 2;
      const kUp = f.k > f.d, kDn = f.k < f.d;
      const ac = kUp ? '0,230,118' : (kDn ? '255,82,82' : '150,160,180');
      const inBand = kdZone(kd) !== 'neutral';
      const lw = 1.2 + Math.min(Math.abs(f.k - f.d) / 8, 3);
      // 0-100 淡底轨道
      ctx.strokeStyle = 'rgba(120,130,150,0.18)'; ctx.lineWidth = 1; ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(f.x, f.y, ringR, 0, Math.PI * 2); ctx.stroke();
      // 带区底色：0-20% 超卖淡绿 / 80-100% 超买淡红
      ctx.strokeStyle = 'rgba(0,230,118,0.22)';
      ctx.beginPath(); ctx.arc(f.x, f.y, ringR, startA, startA + 0.2 * Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,82,82,0.22)';
      ctx.beginPath(); ctx.arc(f.x, f.y, ringR, startA + 0.8 * Math.PI * 2, startA + Math.PI * 2); ctx.stroke();
      // 20%/80% 刻度
      ctx.strokeStyle = 'rgba(200,210,230,0.5)'; ctx.lineWidth = 1;
      [0.2, 0.8].forEach(p => { const a = startA + p * Math.PI * 2; ctx.beginPath(); ctx.moveTo(f.x + Math.cos(a) * (ringR - 2), f.y + Math.sin(a) * (ringR - 2)); ctx.lineTo(f.x + Math.cos(a) * (ringR + 2), f.y + Math.sin(a) * (ringR + 2)); ctx.stroke(); });
      // 进度弧（虚线）
      ctx.strokeStyle = `rgba(${ac},${inBand ? 0.95 : 0.8})`; ctx.lineWidth = lw; ctx.setLineDash([3, 4]);
      ctx.beginPath(); ctx.arc(f.x, f.y, ringR, startA, endA); ctx.stroke();
      ctx.setLineDash([]);
      // 端点：钩=◆菱形 / 钗=●圆点（带内脉冲）
      const tp = inBand ? (0.85 + 0.15 * Math.sin(t * 4)) : 1;
      const tx = f.x + Math.cos(endA) * ringR, ty = f.y + Math.sin(endA) * ringR;
      ctx.fillStyle = `rgba(${ac},1)`;
      if (f.isHook) {
        const s = 3 * tp; ctx.beginPath(); ctx.moveTo(tx, ty - s); ctx.lineTo(tx + s, ty); ctx.lineTo(tx, ty + s); ctx.lineTo(tx - s, ty); ctx.closePath(); ctx.fill();
      } else {
        ctx.beginPath(); ctx.arc(tx, ty, 2.2 * tp, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.fillStyle = '#E8ECF0'; ctx.font = '9px monospace'; ctx.textAlign = 'center';
    ctx.fillText(f.tf, f.x, f.y - f.r - 6);
    ctx.fillText((f.dir === 'bull' ? '▲' : '▼') + f.w.toFixed(1), f.x, f.y + f.r + 10);
  });
}

let _energyRaf = 0;
let _energyRafOwner = null; // v1.5.52：当前持有能量球 RAF 的 canvas（HUD/纪律面板二选一）
let _energyPulse = 0; // v1.5.61：RAF 停摆兜底定时器（iOS standalone PWA 低电量/无交互节流 → 球永久白屏）
function initEnergyBall(box, shortFactors, multiTf, sym, size) {
  if (_energyRaf) { globalThis.cancelAnimationFrame && globalThis.cancelAnimationFrame(_energyRaf); _energyRaf = 0; }
  if (_energyPulse) { clearInterval(_energyPulse); _energyPulse = 0; }
  const cv = box.querySelector('#discEnergyBall');
  if (!cv) return;
  if (!shortFactors || !shortFactors.length) { cv.style.display = 'none'; return; }
  cv.style.display = '';
  const W = size || 300, H = size || 300;
  const model = energyBallLayout(shortFactors, multiTf, W, H);
  // v1.5.61：iOS PWA 大画布内存压力防御——dpr3 时 900×900 画布分配可能静默失败（iOS Safari 已知坑，失败=球永久白屏）。
  // dpr 封顶 2 省内存；赋值后校验实际分配结果，失败降级 dpr=1 重试，仍失败跳过（保留 verdict 文字兜底）。
  let dpr = Math.min(2, Math.max(1, globalThis.devicePixelRatio || 1));
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  if (cv.width !== Math.round(W * dpr)) { dpr = 1; cv.width = W; cv.height = H; }
  cv.style.width = W + 'px'; cv.style.height = H + 'px';
  try { console.log('[EB-DIAG] init W=' + W + ' dpr=' + dpr + ' canvas=' + cv.width + 'x' + cv.height + ' nodes=' + (model.nodes ? model.nodes.length : '?')); } catch (e) {}
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const tip = box.querySelector('#discEnergyTip');
  // 命中: 直距放大到 r+14; 未中则环带内按角度就近(触屏容错)。
  // 坐标转换在每次事件时实时取 getBoundingClientRect, 避免首屏布局未稳定时 rect 失准导致点节点误判为整体共识。
  const hitTest = (clientX, clientY) => {
    const rc = cv.getBoundingClientRect();
    const sc = (model.W || 300) / (rc.width || model.W || 300);
    const mx = (clientX - rc.left) * sc, my = (clientY - rc.top) * sc;
    const dx = clientX - rc.left, dy = clientY - rc.top;
    return { hit: energyBallHitTest(model, mx, my), dx, dy };
  };
  const showTip = (hit, dx, dy, bottom) => {
    if (!tip || !hit) return;
    const rc = cv.getBoundingClientRect();
    const gapTxt = hit.gapTrend === 'up' ? '拉大(增强)' : hit.gapTrend === 'down' ? '收窄(衰减)' : '持平';
    tip.style.display = 'block';
    if (bottom) {
      // 移动端：固定在卡片底部居中，避免小屏浮层跟随手指超出可视区（即「下面文字提示」）
      tip.style.left = '50%'; tip.style.transform = 'translateX(-50%)';
      tip.style.top = 'auto'; tip.style.bottom = '4px';
    } else {
      tip.style.transform = ''; tip.style.bottom = 'auto';
      tip.style.left = Math.min(dx + 10, rc.width - 140) + 'px';
      tip.style.top = (dy + 8) + 'px';
    }
    tip.innerHTML = `<b>${hit.tf}</b> ${hit.dir === 'bull' ? '▲多' : '▼空'} · 权重 ${hit.w.toFixed(2)}<br>信号:${hit.signal || '—'}${hit.isHook ? ' [钩]' : ''}${hit.reversed ? ' 已反转' : ''}<br>K ${fmt2(hit.k)} / D ${fmt2(hit.d)} · |K-D| ${hit.gap != null ? fmt2(Math.abs(hit.gap)) : '—'}<br>KD间距趋势: ${gapTxt}<br>新鲜度: ${hit.fresh != null ? hit.fresh + '根前' : '—'}`;
  };
  // 桌面: 鼠标悬停显示；移动端: 点击(tap)切换显示。click 在所有设备都可靠触发，不依赖 hover 能力检测
  let shownKey = null;
  cv.addEventListener('pointermove', (e) => {
    if (e.pointerType && e.pointerType !== 'mouse') return;
    const { hit, dx, dy } = hitTest(e.clientX, e.clientY);
    if (hit) showTip(hit, dx, dy); else if (tip) tip.style.display = 'none';
  });
  cv.addEventListener('pointerleave', (e) => {
    if ((!e.pointerType || e.pointerType === 'mouse') && tip) { tip.style.display = 'none'; shownKey = null; }
  });
  cv.addEventListener('click', (e) => {
    const { hit, dx, dy } = hitTest(e.clientX, e.clientY);
    const key = hit ? hit.tf : 'overview';
    if (tip && tip.style.display === 'block' && shownKey === key) { tip.style.display = 'none'; shownKey = null; return; } // 再点同一目标→关闭
    if (hit) { showTip(hit, dx, dy, true); shownKey = hit.tf; }
    else { showOverviewTip(); shownKey = 'overview'; }
  });
  const showOverviewTip = () => {
    if (!tip) return;
    const v = (multiTf && multiTf.verdict) || '分歧';
    tip.style.display = 'block';
    tip.style.left = '50%'; tip.style.transform = 'translateX(-50%)';
    tip.style.top = 'auto'; tip.style.bottom = '4px';
    tip.innerHTML = `<b>整体共识</b> ${v}<br>加权多空比 ${multiTf ? (multiTf.ratio * 100).toFixed(0) + '%多' : '—'}<br>共 ${model.nodes.length} 个短周期因子 · 点环上节点看明细`;
  };

  const getPrice = () => {
    try { const S = globalThis.window && globalThis.window.S; const p = S && S.prices && S.prices[sym]; return p ? p.last : null; } catch (e) { return null; }
  };
  const start = (globalThis.performance && globalThis.performance.now) ? globalThis.performance.now() : Date.now();
  let _lastFrameT = 0;
  function frame(now) {
    _lastFrameT = Date.now();
    const tt = ((globalThis.performance && globalThis.performance.now) ? globalThis.performance.now() : Date.now() - start) / 1000;
    drawEnergyBall(ctx, model, { t: tt, price: getPrice(), W, H });
    _energyRaf = globalThis.requestAnimationFrame ? globalThis.requestAnimationFrame(frame) : 0;
  }
  _energyRafOwner = cv; // v1.5.52：记录当前拥有 RAF 循环的 canvas（renderDiscHud 用它判断 HUD 球是否被抢走）
  _energyRaf = globalThis.requestAnimationFrame ? globalThis.requestAnimationFrame(frame) : 0;
  // v1.5.62：同步首帧——RAF 首帧要等下一个 vsync，主线程被钱包插件注入/alphaLab 调仓计算占满时会被推迟
  //（真机反馈：数据已到、EB-DIAG 已打，球仍几分钟白屏）。init 时立即同步画一帧，球即刻可见，RAF 只负责后续动画。
  try { drawEnergyBall(ctx, model, { t: 0, price: getPrice(), W, H }); _lastFrameT = Date.now(); } catch (e) {}
  // v1.5.61：RAF 停摆兜底——iOS standalone PWA 在低电量/长时间无交互时 requestAnimationFrame 可能被长期节流
  //（真实用户反馈：手机上能量球一直不显示，桌面正常）。可见态且 >800ms 无帧推进时用 250ms 定时器补绘，幂等无副作用。
  _energyPulse = setInterval(() => {
    if (typeof document !== 'undefined' && document.hidden) return;
    if (!_energyRaf || Date.now() - _lastFrameT > 800) {
      try { const tt = ((globalThis.performance && globalThis.performance.now) ? globalThis.performance.now() : Date.now() - start) / 1000;
        drawEnergyBall(ctx, model, { t: tt, price: getPrice(), W, H }); } catch (e) {}
    }
  }, 250);
}

// HUD 事件绑定（幂等）：✕ 关闭 + 标题栏拖动（位置 clamp + cfg.ruleHudPos 持久化）
function bindHudEvents(hud) {
  if (!hud || hud.dataset.hudBound) return;
  hud.dataset.hudBound = '1';
  hud.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act]');
    if (t && (t.dataset.act === 'close' || t.dataset.act === 'toggle')) {
      // 复用既有总开关（window.kToggleRuleMonitor 已双绑 main.js/kchartApp.js — GOAL13 红线）
      if (typeof window !== 'undefined' && window.kToggleRuleMonitor) window.kToggleRuleMonitor();
    }
  });
  const bar = hud.querySelector('#discHudBar');
  if (!bar) return;
  const kbox = hud.parentElement; // .kchart-box（position:relative），offsetLeft/top 相对它
  const clampNow = (x, y, w, h) => hudClampPos(x, y, w, h, kbox ? kbox.clientWidth : 0, kbox ? kbox.clientHeight : 0);
  let drag = null;
  bar.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.hud-min')) return; // v1.5.60：点 ✕ 不拖（原 class 名 .disc-hud-x 写错导致 ✕ 命中拖动分支，preventDefault 抑制真机 tap 的合成 click → ✕ 失效）
    drag = { dx: e.clientX - hud.offsetLeft, dy: e.clientY - hud.offsetTop, w: hud.offsetWidth, h: hud.offsetHeight };
    try { bar.setPointerCapture(e.pointerId); } catch (err) {}
    e.preventDefault();
  });
  bar.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = clampNow(e.clientX - drag.dx, e.clientY - drag.dy, drag.w, drag.h);
    hud.style.left = p.x + 'px'; hud.style.top = p.y + 'px';
  });
  const endDrag = () => {
    if (!drag) return;
    drag = null;
    const p = clampNow(hud.offsetLeft, hud.offsetTop, hud.offsetWidth, hud.offsetHeight);
    hud.style.left = p.x + 'px'; hud.style.top = p.y + 'px';
    cfg.ruleHudPos = { x: p.x, y: p.y };
    persist();
  };
  bar.addEventListener('pointerup', endDrag);
  bar.addEventListener('pointercancel', endDrag);
}

export function renderDiscHud() {
  if (typeof document === 'undefined') return;
  const hud = document.getElementById('discHud');
  if (!hud) return;
  // HUD = 悬浮「规则监测」卡，两态（v1.5.55）：mini=主图左侧居中的「监测」小签；open=仪表盘展开。
  // 能量球/动力卡始终留在交易纪律分析原位（v1.5.53 修正）。
  const body = document.getElementById('discHudRmBody');
  if (!body) return;
  const open = !!cfg.ruleMonitorOpen;
  // v1.5.56：mini DOM 小签取消（收起态 HUD 隐藏，入口=行动卡右上角「监测」canvas 热区）
  if (!open) { hud.style.display = 'none'; hud.classList.remove('mini'); bindHudEvents(hud); return; }
  hud.style.display = '';
  hud.classList.remove('mini');
  const kbox = hud.parentElement;
  // 位置：优先拖动后保存的 cfg.ruleHudPos（相对 .kchart-box px）；否则主图左侧居中（盖住行动卡，展开即全量信息）
  if (cfg.ruleHudPos && typeof cfg.ruleHudPos.x === 'number' && typeof cfg.ruleHudPos.y === 'number') {
    hud.style.left = cfg.ruleHudPos.x + 'px';
    hud.style.top = cfg.ruleHudPos.y + 'px';
  } else if (kbox) {
    hud.style.left = '8px';
    hud.style.top = '8px'; // v1.5.58：默认展开在主图上方（不遮行动卡/K线中点），拖过后 ruleHudPos 优先
  }
  if (open) {
    // 高度上限：容器高与视口高取小（主图容器常远超视口——同屏意义下以视口为准），再减 bar+padding 余量
    const hCap = Math.max(120, Math.min(kbox ? kbox.clientHeight : 99999, (typeof innerHeight !== 'undefined' ? innerHeight : 99999)) - 34);
    if (kbox) body.style.maxHeight = hCap + 'px';
  }
  bindHudEvents(hud);
}

// ============ 短线价格路径预测（主路径·止盈 + 反向·止损备选 + ATR 扇带）============

// 纯函数（可单测）：基于已实现信号推导预测路径要素与回调概率/依据
export function pricePathForecast(analysis, price, opts) {
  opts = opts || {};
  const horizon = opts.horizonBars || 12;
  const fanK = opts.fanK != null ? opts.fanK : 1.5;
  const entry = (analysis && analysis.entry) || {};
  const multiTf = (analysis && analysis.multiTf) || { ratio: 0.5, verdict: '分歧', hookOverride: false };
  const ratio = (multiTf.ratio != null && isFinite(multiTf.ratio)) ? multiTf.ratio : 0.5;
  const verdict = (multiTf.verdict || '分歧');
  let dir = entry.dir || '观望';
  let target = entry.target != null && isFinite(entry.target) ? entry.target : (price != null ? price : 0);
  let support = entry.stop != null && isFinite(entry.stop) ? entry.stop : (price != null ? price : 0);
  // 钩反转: 近线段(≥4h极值带+≤1h钩) → 短线预测改以 SRSI 共识方向呈现(均值回归/见顶回落), 不盲从趋势决策
  if (multiTf.hookOverride) {
    const atrP = (analysis && isFinite(analysis.atrP)) ? analysis.atrP : 0.4;
    const atrAbs = price != null ? price * atrP / 100 : 0;
    if (verdict === '一致偏空') { dir = '看空'; target = price != null ? price - 1.5 * atrAbs : target; support = price != null ? price + 1.5 * atrAbs : support; }
    else if (verdict === '一致偏多') { dir = '看多'; target = price != null ? price + 1.5 * atrAbs : target; support = price != null ? price - 1.5 * atrAbs : support; }
  }
  const shortFactors = (analysis && analysis.shortFactors) || [];
  const obTfs = shortFactors.filter(f => f.k != null && f.k >= 80).length;
  const obShare = shortFactors.length ? obTfs / shortFactors.length : 0;
  let pb = 0.15 + 0.30 * obShare + 0.40 * (1 - ratio);
  if (dir.indexOf('观望') >= 0) pb = Math.max(pb, 0.5);
  pb = Math.max(0, Math.min(0.85, pb));
  const strength = Math.abs(ratio - 0.5) * 2;        // 0(完全分歧)~1(强单边)，等于能量球净强度 |wbull−wbear|/(wbull+wbear)
  const uncertainty = 1 - Math.abs(2 * pb - 1);      // 0(确定)~1(50/50)，弱信号→更大
  const weak = (verdict === '分歧') || strength < 0.3;
  const conflictNote = (analysis && analysis.conflictNote) || null;
  const reason = (entry && entry.reason) || '';
  const shortReason = multiTf.hookOverride ? '短线段反转(≥4h极值带+≤1h钩)→均值回归' : reason.split('；')[0];
  const basis = [];
  if (shortReason) basis.push(`判${dir}：${shortReason}`);
  if (obTfs > 0) basis.push(`短周期超买 ${obTfs}/${shortFactors.length} 个TF K≥80`);
  basis.push(`短周期加权共识 ${(ratio * 100).toFixed(0)}% (${verdict})`);
  if (conflictNote && !multiTf.hookOverride) basis.push(`趋势优先→判${dir}：${conflictNote}`);
  if ((dir.indexOf('看空') >= 0 && verdict === '一致偏多') || (dir.indexOf('看多') >= 0 && verdict === '一致偏空'))
    basis.push(`短周期共识(${verdict}) 与判${dir}相反 → 见首行原因`);
  if (support != null && price != null) basis.push(`ATR支撑≈${support.toFixed(2)} (p−1.5×ATR)`);
  if (weak) basis.push('信号弱·双向可能(扇带加宽)');
  const atrP = analysis && isFinite(analysis.atrP) ? analysis.atrP : (price ? 0.4 : 0);
  const atrAbs = price != null ? price * atrP / 100 : 0;
  return {
    dir, price: price != null ? price : (target + support) / 2, target, support,
    atrP, atrAbs, horizon, fanK, pullbackProb: pb, pullbackBasis: basis,
    bullish: dir.indexOf('看多') >= 0, strength, uncertainty, weak, conflictNote
  };
}

// 绘制（Canvas，rAF 驱动）：ATR 扇带(按不确定性加宽) + 主路径(绿·止盈) + 反向路径(红虚·止损) + 流动粒子 + 止盈/支撑线
export function drawPricePath(ctx, model, opts) {
  const o = opts || {};
  const t = o.t || 0;
  const W = model.W || 320, H = model.H || 200;
  const price = model.price, target = model.target, support = model.support;
  const atrAbs = Math.max(model.atrAbs || 0, (price || 0) * 0.001);   // 兜底 0.1% 价，避免零ATR退化成顶部直线
  const horizon = model.horizon || 12;
  const fanK = model.fanK || 1.5;
  const pb = (model.pullbackProb != null) ? model.pullbackProb : 0;
  ctx.clearRect(0, 0, W, H);
  const padL = 8, padR = 76, padT = 14, padB = 18;
  const x0 = padL, x1 = W - padR;
  const ease = (u) => u * u * (3 - 2 * u);
  const N = 40;
  const uncertainty = model.uncertainty != null ? model.uncertainty : 0.5;
  const wUp = 1 - pb, wDown = pb;
  // 期望价格中心：主/反路径按概率混合 → 弱信号(分歧)时趋平、扇带加宽（与能量球净强度联动）
  const expP = (u) => price + (target - price) * ease(u) * wUp + (support - price) * ease(u) * wDown;
  const halfW = (u) => fanK * atrAbs * Math.sqrt(u) * (1 + 0.8 * uncertainty);
  const xOf = (i) => x0 + (i / horizon) * (x1 - x0);
  // 竖直范围：纳入路径与扇带，并设最小范围（观望/零ATR 时仍为可见对称锥，不退化为顶部直线）
  let pmin = Math.min(price, target, support, expP(1) - halfW(1));
  let pmax = Math.max(price, target, support, expP(1) + halfW(1));
  const minRange = Math.max(atrAbs * fanK * 1.4, (price || 1) * 0.002, 1e-6);
  if (pmax - pmin < minRange) { const mid = (pmax + pmin) / 2; pmin = mid - minRange / 2; pmax = mid + minRange / 2; }
  const range = pmax - pmin;
  const yOf = (p) => padT + (pmax - p) / range * (H - padT - padB);
  // 扇带（以期望价为中心，宽度随 sqrt 展开并按不确定性加宽）
  const upper = [], lower = [];
  for (let i = 0; i <= N; i++) {
    const u = i / N, tt = u * horizon, c = expP(u), h = halfW(u);
    upper.push([xOf(tt), yOf(c + h)]);
    lower.push([xOf(tt), yOf(c - h)]);
  }
  const grad = ctx.createLinearGradient(x0, 0, x1, 0);
  grad.addColorStop(0, 'rgba(0,230,118,0.05)');
  grad.addColorStop(1, 'rgba(255,82,82,0.18)');
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.moveTo(upper[0][0], upper[0][1]);
  for (const p of upper) ctx.lineTo(p[0], p[1]);
  for (let i = lower.length - 1; i >= 0; i--) ctx.lineTo(lower[i][0], lower[i][1]);
  ctx.closePath(); ctx.fill();
  // 主路径 → 止盈（绿实线发光，方向无关：做多=上、做空=下）
  ctx.strokeStyle = 'rgba(0,230,118,0.95)'; ctx.lineWidth = 2;
  ctx.shadowColor = 'rgba(0,230,118,0.6)'; ctx.shadowBlur = 6;
  ctx.beginPath();
  for (let i = 0; i <= N; i++) { const u = i / N, x = xOf(u * horizon), y = yOf(price + (target - price) * ease(u)); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
  ctx.stroke(); ctx.shadowBlur = 0;
  // 反向路径 → 止损（红虚线）
  ctx.strokeStyle = 'rgba(255,82,82,0.9)'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 4]);
  ctx.beginPath();
  for (let i = 0; i <= N; i++) { const u = i / N, x = xOf(u * horizon), y = yOf(price + (support - price) * ease(u)); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
  ctx.stroke(); ctx.setLineDash([]);
  // 流动粒子
  const NP = 40;
  for (let i = 0; i < NP; i++) {
    const u = ((i / NP) + (t * 0.15)) % 1, tt = u * horizon;
    const c = expP(u), h = halfW(u);
    const off = (i % 2 ? 1 : -1) * h * (0.3 + 0.6 * ((i * 7) % 10) / 10);
    const x = xOf(tt), y = yOf(c + off);
    const col = off >= 0 ? '0,230,118' : '255,82,82';
    const a = 0.3 + 0.3 * Math.sin(t * 3 + i);
    ctx.fillStyle = `rgba(${col},${Math.max(0, a)})`;
    ctx.beginPath(); ctx.arc(x, y, 1, 0, Math.PI * 2); ctx.fill();
  }
  // 止盈 / 回调支撑 水平虚线 + 标签（仅当存在真实目标位；观望时 target≈support，仅显示对称扇带）
  if (Math.abs(target - support) > (price || 1) * 0.0005) {
    ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,230,118,0.7)'; ctx.beginPath(); ctx.moveTo(x0, yOf(target)); ctx.lineTo(x1, yOf(target)); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,82,82,0.7)'; ctx.beginPath(); ctx.moveTo(x0, yOf(support)); ctx.lineTo(x1, yOf(support)); ctx.stroke();
    ctx.setLineDash([]);
  ctx.font = '9px monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  const dw = model.dirWord || '';
  ctx.fillStyle = 'rgba(0,230,118,0.95)'; ctx.fillText(`${dw}止盈 ${target.toFixed(2)}`, x1 + 4, yOf(target));
  ctx.fillStyle = 'rgba(255,82,82,0.95)'; ctx.fillText(`${dw}止损 ${support.toFixed(2)} · 反向${(pb * 100).toFixed(0)}%`, x1 + 4, yOf(support));
  }
  // 弱信号提示（与能量球净强度联动：分歧/弱共识→扇带已加宽）
  if (model.weak) {
    ctx.font = '9px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(255,193,7,0.95)';
    ctx.fillText('⚠ 信号弱·双向可能', (x0 + x1) / 2, 2);
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  }
  // 基点脉冲
  const pulse = 0.5 + 0.5 * Math.sin(t * 2.5);
  ctx.fillStyle = `rgba(255,107,53,${0.6 + 0.4 * pulse})`;
  ctx.beginPath(); ctx.arc(x0, yOf(price), 3 + pulse * 1.5, 0, Math.PI * 2); ctx.fill();
  ctx.textBaseline = 'alphabetic';
}

let _pathRaf = 0;
function initPricePath(box, analysis, sym, fallbackPrice) {
  if (_pathRaf) { globalThis.cancelAnimationFrame && globalThis.cancelAnimationFrame(_pathRaf); _pathRaf = 0; }
  const cv = box.querySelector('#discPricePath');
  if (!cv) return;
  const W = 320, H = 200;
  const dpr = Math.max(1, globalThis.devicePixelRatio || 1);
  cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + 'px'; cv.style.height = H + 'px';
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const tip = box.querySelector('#discPathTip');
  let curModel = null;
  const livePrice = () => { try { const S = globalThis.window && globalThis.window.S; const p = S && S.prices && S.prices[sym]; return p ? p.last : null; } catch (e) { return null; } };
  // 提示：桌面 hover 显示；手机/平板 tap 切换显示（pointerup），否则 PWA 移动端看不到
  const showTip = (bottom) => {
    if (!tip || !curModel) return;
    tip.style.display = 'block';
    if (bottom) {
      tip.style.left = '50%'; tip.style.transform = 'translateX(-50%)';
      tip.style.top = 'auto'; tip.style.bottom = '4px';
    } else {
      tip.style.transform = ''; tip.style.bottom = 'auto';
      tip.style.left = '8px'; tip.style.top = '8px';
    }
    const up = curModel.bullish ? '做多' : (curModel.dir.indexOf('看空') >= 0 ? '做空' : '观望');
    tip.innerHTML = `主路径→止盈 ${curModel.target.toFixed(2)} (${up})<br>反向路径→止损 ${curModel.support.toFixed(2)}<br>反向概率 ${(curModel.pullbackProb * 100).toFixed(0)}%` + (curModel.weak ? '<br>⚠ 信号弱·双向可能' : '');
  };
  // 桌面：hover 显示；移动端：点击(tap)切换（click 在所有设备可靠触发）
  cv.addEventListener('pointermove', (e) => { if (e.pointerType && e.pointerType !== 'mouse') return; showTip(false); });
  cv.addEventListener('pointerleave', (e) => { if ((!e.pointerType || e.pointerType === 'mouse') && tip) tip.style.display = 'none'; });
  cv.addEventListener('click', () => {
    if (!tip || !curModel) return;
    if (tip.style.display === 'block') tip.style.display = 'none';
    else showTip(true);
  });
  const start = (globalThis.performance && globalThis.performance.now) ? globalThis.performance.now() : Date.now();
  function frame() {
    const tt = ((globalThis.performance && globalThis.performance.now) ? globalThis.performance.now() : Date.now() - start) / 1000;
    const base = livePrice() != null ? livePrice() : fallbackPrice;
    const model = pricePathForecast(analysis, base != null ? base : 0, { horizonBars: 12 });
    if (base == null) model.price = (model.target + model.support) / 2;
    model.dirWord = model.bullish ? '做多' : (model.dir.indexOf('看空') >= 0 ? '做空' : '观望');
    model.W = W; model.H = H;
    curModel = model;
    drawPricePath(ctx, model, { t: tt, W, H });
    _pathRaf = globalThis.requestAnimationFrame ? globalThis.requestAnimationFrame(frame) : 0;
  }
  _pathRaf = globalThis.requestAnimationFrame ? globalThis.requestAnimationFrame(frame) : 0;
}

// 多周期 SRSI 速览表（纯数据，可单测）

const SUB_COLORS = { rsi: '#ffd740', srsi: '#c58aff', macd: '#ffffff' };

// ---- 计算子图栈：按 show + 顺序，展开 SRSI 多子图 ----
function buildSubList() {
  const list = [];
  const all = ['rsi', 'srsi', 'macd'];
  const order = (cfg.subOrder && cfg.subOrder.length ? cfg.subOrder : all).filter(k => cfg.show[k]);
  // 防御：show 中开启、但不在 subOrder 里的键，补到末尾（避免关闭后重开丢失）
  all.forEach(k => { if (cfg.show[k] && !order.includes(k)) order.push(k); });
  order.forEach(key => {
    if (key === 'srsi') {
      const tfs = KLINE_TF.filter(tf => cfg.klineSel[tf]).slice().sort((a, b) => minutesOf(a) - minutesOf(b));
      tfs.forEach(tf => list.push({ key: 'srsi', tf, name: 'SRSI ' + tf }));
    } else {
      list.push({ key, tf: null, name: key.toUpperCase() });
    }
  });
  return list;
}

// ---- 周期选择器统一状态机（纯函数）----
// 每个 TF 有两种状态：主图(唯一) + SRSI子图(多选)。
// action: 'main' = 设为该 TF 为主图(自动勾选进 SRSI)；'srsi' = 切换该 TF 的 SRSI 勾选。
// 取消勾选当前主图时主图自动退到第一个仍勾选的 TF；若一个都不剩则保持原主图。
export function nextKMode(tf, cur, action) {
  const sel = { ...cur.klineSel };
  let mainTF = cur.mainTF;
  if (action === 'main') {
    mainTF = tf;
    sel[tf] = true;
  } else if (action === 'srsi') {
    sel[tf] = !sel[tf];
    if (!sel[tf] && tf === mainTF) {
      const remain = KLINE_TF.filter(x => sel[x]);
      if (remain.length) mainTF = remain[0];
    }
  }
  return { mainTF, sel };
}

// 快捷预设组合：短线/日内/波段 → { mainTF, sel }；all → 全选全部周期（速览表全显），主图周期保持不变
export function kPresetCombos(name) {
  if (name === 'all') {
    const sel = {};
    KLINE_TF.forEach(tf => { sel[tf] = true; });
    return { mainTF: null, sel, all: true };
  }
  const P = {
    mini:    { tfs: ['15m', '1h'],        main: '15m' },
    scalp:   { tfs: ['1m', '5m', '15m'],   main: '5m' },
    day:     { tfs: ['15m', '1h', '4h'],   main: '1h' },
    swing:   { tfs: ['4h', '1d', '7d'],    main: '1d' }
  };
  const p = P[name] || P.day;
  const sel = {};
  KLINE_TF.forEach(tf => { sel[tf] = p.tfs.includes(tf); });
  return { mainTF: p.main, sel };
}

// ---- 多周期 SRSI 速览表（纯数据，可单测）----
// 对每个已勾选 TF 计算 srsiPanelSeries 的末根 K/D、区域、最近穿越方向与新鲜度(根数)。
// 返回 { rows: [{tf,k,d,zone,crossing,fresh,hook,hookFresh,reversed,gapNow,gapPrev,gapTrend,energy}], bull, bear }
//   reversed: 该周期最近信号是否已被反向动量否决；bull/bear 计数已对反转行做翻转。
export function buildSrsiOverview(selTfs, srsiCfg, priceMap, bars = 150) {
  const rows = [];
  let bull = 0, bear = 0;
  (selTfs || []).slice().sort((a, b) => minutesOf(a) - minutesOf(b)).forEach(tf => {
    const price = (priceMap && priceMap[tf]) || [];
    const useCfg = (typeof srsiCfg === 'function') ? srsiCfg(tf) : srsiCfg;
    const row = { tf, k: null, d: null, zone: 'neutral', crossing: null, fresh: null, hook: null, hookFresh: null };
    if (price.length >= 2) {
      const sl = srsiPanelSeries(price, useCfg, bars);
      const k = sl.k[sl.k.length - 1], d = sl.d[sl.d.length - 1];
      const st = srsiSignal(k, sl.k.length > 1 ? sl.k[sl.k.length - 2] : null, { overbought: useCfg.overbought, oversold: useCfg.oversold });
      row.k = k != null ? k : null;
      row.d = d != null ? d : null;
      row.zone = st.zone;
      for (let i = sl.crossings.length - 1; i >= 0; i--) {
        if (sl.crossings[i]) { row.crossing = sl.crossings[i]; row.fresh = sl.crossings.length - 1 - i; break; }
      }
      for (let i = sl.hooks.length - 1; i >= 0; i--) {
        if (sl.hooks[i]) { row.hook = sl.hooks[i]; row.hookFresh = sl.hooks.length - 1 - i; break; }
      }
      // K-D 间距动能（加速/减弱）：当前间距 vs 前一根间距
      const nSl = sl.k.length;
      const gapNow = (row.k != null && row.d != null) ? Math.abs(row.k - row.d) : null;
      const gapPrev = (nSl >= 2 && sl.k[nSl - 2] != null && sl.d[nSl - 2] != null) ? Math.abs(sl.k[nSl - 2] - sl.d[nSl - 2]) : null;
      let gapTrend = 'flat';
      if (gapNow != null && gapPrev != null) {
        if (gapNow > gapPrev * 1.1) gapTrend = 'up';
        else if (gapNow < gapPrev * 0.9) gapTrend = 'down';
      }
      row.gapNow = gapNow; row.gapPrev = gapPrev; row.gapTrend = gapTrend;
      // 反转判定：信号意图 vs 当前瞬时 K/D 方向（死/金 钩/叉 被反向动量否决 → 已反转）
      row.reversed = isReversed(row);
      row.energy = hookEnergy(row);
    } else {
      row.energy = { dir: null, score: 0, isHook: false, reason: '数据不足' };
    }
    rows.push(row);
  });
  const cb = countBullBear(rows);
  return { rows, bull: cb.bull, bear: cb.bear };
}

// 价格格式化（按量级自适应小数位，纯函数）
export function fmtPrice(v) {
  if (v == null || !isFinite(v)) return '--';
  if (v >= 1000) return v.toFixed(2);
  if (v >= 1) return v.toFixed(3);
  if (v >= 0.01) return v.toFixed(4);
  return v.toFixed(6);
}

// 速览表周期列: 该周期自身时长(真实时间)的回报率 + 同跨度最低/最高价（纯函数, 可单测）
// 用时间戳 t 回看 durMin 分钟前的价格算涨跌%: 1d=最近24h, 10m=最近10min, 30d=最近30天(无论K线粒度)
//   —— 避免"30d K线实际是日线分辨率"时单根邻接误算成1日涨跌。t 缺失时回退单根邻接(c[last] vs c[last-1])。
// low/high: 取 [回看起点, 末根] 同跨度蜡烛 l/h 的 min/max(缺则回退 c)。
export function tfOverviewStat(c, l, h, t, bars = 150, durMin = null) {
  const cl = (c || []).length;
  if (cl < 2) return { ok: false, chgPct: null, low: null, high: null };
  const last = c[cl - 1];
  let refPrice = null, refIdx = cl - 2;
  if (durMin != null && t && t.length === cl) {
    const now = t[cl - 1];
    const target = now - durMin * 60000;
    for (let i = 0; i < cl; i++) {
      const ti = t[i];
      if (ti != null && isFinite(ti)) {
        if (ti <= target) { refPrice = c[i]; refIdx = i; }
        else break;
      }
    }
    if (refPrice == null) { refPrice = c[0]; refIdx = 0; }
  } else {
    refPrice = c[cl - 2]; refIdx = cl - 2;
  }
  const chgPct = (refPrice && isFinite(refPrice) && refPrice !== 0) ? (last - refPrice) / refPrice * 100 : null;
  let low = null, high = null;
  const useL = l && l.length === cl, useH = h && h.length === cl;
  const start = Math.max(0, refIdx);
  for (let i = start; i < cl; i++) {
    if (useL && l[i] != null && isFinite(l[i]) && (low == null || l[i] < low)) low = l[i];
    if (useH && h[i] != null && isFinite(h[i]) && (high == null || h[i] > high)) high = h[i];
  }
  if (low == null || high == null) {
    for (let i = start; i < cl; i++) {
      const v = c[i];
      if (v != null && isFinite(v)) { if (low == null || v < low) low = v; if (high == null || v > high) high = v; }
    }
  }
  return { ok: true, chgPct, low, high };
}

// 由速览表统计 → 聚合结论
export function overviewVerdict(bull, bear) {
  if (bull === 0 && bear === 0) return '中性';
  if (bull > 0 && bear === 0) return '一致偏多';
  if (bear > 0 && bull === 0) return '一致偏空';
  if (bull > 0 && bear > 0) return '分歧';
  return '中性';
}

// 方向 + 是否钩 → 显示名（金叉/死叉 或 金钩/死钩）
export function dirName(dir, isHook) {
  if (dir === 'buy') return isHook ? '金钩' : '金叉';
  if (dir === 'sell') return isHook ? '死钩' : '死叉';
  return '无';
}

// 速览「穿越」列取离当前最近的一根信号：普通带穿越(金叉/死叉) 与 钩(金钩/死钩) 之间比新鲜度，
// 取 bars 数更小（更近）者；同新鲜度时优先钩（更具体）。返回 { cv, fv }。
export function latestCross(row) {
  const crossFresh = (row.crossing != null && row.fresh != null) ? row.fresh : Infinity;
  const hookFresh = (row.hook != null && row.hookFresh != null) ? row.hookFresh : Infinity;
  const useHook = hookFresh <= crossFresh;
  return { cv: useHook ? row.hook : row.crossing, fv: useHook ? row.hookFresh : row.fresh };
}

// 反转判定（纯函数，可单测）：信号意图 vs 当前瞬时 K/D 方向。
// 死叉/死钩(bear) 但当前 K>D → 空头被买回(已反转, 偏多)；金叉/金钩(bull) 但当前 K<D → 多头被砸回(已反转, 偏空)。
export function isReversed(row) {
  if (!row) return false;
  const lc = latestCross(row);
  if (!lc.cv) return false;
  const bear = lc.cv === 'sell' || lc.cv === 'deathHook';
  const bull = lc.cv === 'buy' || lc.cv === 'goldHook';
  if (row.k == null || row.d == null || !isFinite(row.k) || !isFinite(row.d)) return false;
  const EPS = 0.5;
  return bear ? (row.k - row.d > EPS) : bull ? (row.d - row.k > EPS) : false;
}

// 多周期速览共识计数（纯函数，可单测）：按「穿越」列方向计多/空；若该行已反转则翻转贡献（死勾反转→计多 / 金勾反转→计空）。
// 同时按 shortSignalWeight 计算加权多/空(wbull/wbear)，供加权共识判决使用。
export function countBullBear(rows) {
  const higherExtreme = (rows || []).some(r => minutesOf(r.tf) >= 240 && (r.zone === 'overbought' || r.zone === 'oversold'));
  let bull = 0, bear = 0, wbull = 0, wbear = 0;
  (rows || []).forEach(row => {
    const lc = latestCross(row);
    if (!lc.cv) return;
    let contrib = (lc.cv === 'buy' || lc.cv === 'goldHook') ? 'bull'
                : (lc.cv === 'sell' || lc.cv === 'deathHook') ? 'bear' : null;
    if (!contrib) return;
    if (row.reversed) contrib = contrib === 'bull' ? 'bear' : 'bull';
    const w = shortSignalWeight(row, lc.fv, { higherExtreme });
    if (contrib === 'bull') { bull++; wbull += w; } else { bear++; wbear += w; }
  });
  return { bull, bear, wbull, wbear };
}

// 多周期速览共识的 TF 构成（纯函数，可单测）：与 countBullBear 同口径（KD 方向, 跳过 reversed），
// 返回偏多/偏空 TF 名列表，供面板透明展示（如「偏多:1h/4h · 偏空:5m/15m」），
// 避免「一致偏多」与用户实时看到的短周期下跌自相矛盾。
export function bullBearTfs(rows) {
  const bullTfs = [], bearTfs = [];
  (rows || []).forEach(row => {
    if (isReversed(row)) return;
    if (row.k > row.d) bullTfs.push(row.tf); else bearTfs.push(row.tf);
  });
  return { bullTfs, bearTfs };
}

// 加权共识判决（纯函数，可单测）：用加权多/空占比判单边，替代二值(有/无)判定。
// 占比 r = wbull/(wbull+wbear)；r≥th → 一致偏多，r≤1-th → 一致偏空，否则分歧。
export function weightedVerdict(wbull, wbear, opts = {}) {
  const th = opts.threshold != null ? opts.threshold : SHORT_CONSENSUS_TH;
  const tot = (wbull || 0) + (wbear || 0);
  if (tot <= 0) return '中性';
  const r = wbull / tot;
  if (r >= th) return '一致偏多';
  if (r <= 1 - th) return '一致偏空';
  return '分歧';
}

// 加权共识 + 锚定（纯函数，可单测）：单边需至少一个 ≥1h 周期同向，防纯短线(1m/5m)噪音成势。
export function weightedShortVerdict(rows, wbull, wbear, opts = {}) {
  let verdict = weightedVerdict(wbull, wbear, opts);
  const anchorMin = minutesOf(opts.anchorTF || SHORT_ANCHOR_TF);
  if (verdict === '一致偏多' || verdict === '一致偏空') {
    const wantSide = verdict === '一致偏多' ? 'bull' : 'bear';
    const hasAnchor = (rows || []).some(r => {
      const lc = latestCross(r); if (!lc.cv) return false;
      let c = (lc.cv === 'buy' || lc.cv === 'goldHook') ? 'bull' : 'bear';
      if (r.reversed) c = c === 'bull' ? 'bear' : 'bull';
      return c === wantSide && minutesOf(r.tf) >= anchorMin;
    });
    if (!hasAnchor) verdict = '分歧';
  }
  return verdict;
}

// 单周期 SRSI KD 能量分（用户概念：KD 线间距大 + 远离 50 中线 + 钩刚激活 → 能量足）：
//   gapFactor   = clamp(|K-D|/20, 0, 1)    30%  K/D 分得开 → 动量强
//   midFactor   = clamp(距 50 的余量)        30%  信号方向还剩多少空间（卖→离 20 多远 / 买→离 80 多远）
//   freshFactor = clamp(1-fresh/20, 0, 1)   25%  刚激活 → 能量足（>20根前归零）
//   hookBonus   = 钩 +15%, 钗 0%             15%  钩比钗更具体
// 方向取 latestCross（钩/钗孰新取孰）方向。返回 { dir, score:0-100, isHook, reason }。
export function hookEnergy(row) {
  if (!row) return { dir: null, score: 0, isHook: false, reason: '无数据' };
  const lc = latestCross(row);
  if (!lc.cv || lc.fv == null) return { dir: null, score: 0, isHook: false, reason: '无信号' };
  const k = row.k, d = row.d;
  if (k == null || d == null) return { dir: null, score: 0, isHook: false, reason: 'K/D未就绪' };
  const isHook = lc.cv === 'goldHook' || lc.cv === 'deathHook';
  const dir = (lc.cv === 'buy' || lc.cv === 'goldHook') ? 'buy' : 'sell';
  const gapFactor = Math.min(1, Math.abs(k - d) / 20);
  const midFactor = Math.min(1, Math.max(0, dir === 'sell' ? (k - 20) / 40 : (80 - k) / 40));
  const freshFactor = Math.max(0, Math.min(1, 1 - lc.fv / 20));
  const hookBonus = isHook ? 0.15 : 0;
  const score = Math.round((gapFactor * 0.30 + midFactor * 0.30 + freshFactor * 0.25 + hookBonus) * 100);
  const reason = `距${Math.round(gapFactor * 100)}/余量${Math.round(midFactor * 100)}/新鲜${Math.round(freshFactor * 100)}${isHook ? '/钩' : ''}`;
  return { dir, score, isHook, reason };
}

// 从多周期 SRSI 行中找「领跑者」：能量 ≥30 且有方向者取最高分，最高分 ≥50 才认定领跑。
// 返回 { tf, dir, score, isHook, isClear } | null；isClear=最高分 ≥ 次高 1.4 倍（独一档）。
export function leadingTF(rows) {
  const active = (rows || [])
    .map(r => ({ tf: r.tf, energy: hookEnergy(r) }))
    .filter(e => e.energy.dir != null && e.energy.score >= 30);
  if (!active.length) return null;
  active.sort((a, b) => b.energy.score - a.energy.score || minutesOf(a.tf) - minutesOf(b.tf));
  const best = active[0];
  if (best.energy.score < 50) return null;
  const runnerUp = active[1];
  const isClear = !runnerUp || runnerUp.energy.score < best.energy.score * 1.4;
  return { tf: best.tf, dir: best.energy.dir, score: best.energy.score, isHook: best.energy.isHook, isClear };
}

// 入场确认候选选择（纯函数，可单测）：与速览「穿越」列一致——取离当前最近的一根信号（钩或钗），
// 仅当钩是最近事件时才以钩计（isHook），否则以带穿越计。再跨周期按新鲜度取最近。
// rows: [{tf, crossing, fresh, hook, hookFresh}]（已限定短周期）
// expectDir: 期望确认方向('buy'/'sell'/null)。提供时做方向感知——最近信号若与其反向 → 标 contrarian
//   (供「观望」门控用, 不做正向确认, confirmed=false)；expectDir=null 保持原行为(兼容旧调用)。
export function pickConfirm(rows, expectDir) {
  const cands = [];
  (rows || []).forEach(r => {
    const lc = latestCross(r);
    if (lc.cv == null || lc.fv == null) return;
    const isHook = lc.cv === 'goldHook' || lc.cv === 'deathHook';
    const dir = (lc.cv === 'buy' || lc.cv === 'goldHook') ? 'buy' : 'sell';
    cands.push({ dir, fresh: lc.fv, tf: r.tf, isHook, reversed: isReversed(r) });
  });
  cands.sort((a, b) => a.fresh - b.fresh);
  const confirm = cands.length ? cands[0] : { dir: null, fresh: null, tf: null, isHook: false, reversed: false };
  // 已反转信号不作为反向确认（其原方向已被动量否决）：不触发 contrarian 门控、也不计为有效确认
  confirm.contrarian = !!(expectDir && confirm.dir != null && confirm.dir !== expectDir) && !confirm.reversed;
  confirm.confirmed = !confirm.contrarian && confirm.dir != null && confirm.fresh <= 3 && !confirm.reversed;
  return confirm;
}

// ---- 信号生命周期 / 强度（纯函数，可单测）----
// 把「入场确认信号」还原成直观的强弱 + 新鲜度阶段 + 置信度，供纪律面板所有档位统一显示。
// 输入 confirm(最新短周期信号)、leader(能量领跑)、energyRows(各周期能量)。
// 仅呈现层，绝不参与 dir 判定（守 §5.29：不改方向逻辑）。
// 返回 { phase, strength, conf, txt, cls, tf, dir, fresh, isHook } | null
//   phase: 'fresh'(≤3根刚激活) / 'active'(≤8) / 'aging'(≤20) / 'stale'(>20) / 'none'(无信号)
//   strength: '强'(≥70) / '中'(45-69) / '弱'(<45)
//   conf: 信号置信度 5-95（能量基准 + 新鲜 + 钩加成；独立于 entry.conf 判断置信）
export function signalLifecycle(confirm, leader, energyRows) {
  const c = confirm || {};
  const tf = c.tf || (leader ? leader.tf : null);
  const fresh = c.fresh != null ? c.fresh : null;
  const isHook = !!(c.isHook || (leader && leader.isHook));
  const dir = c.dir || (leader ? leader.dir : null);
  if (!tf || dir == null) return null;

  // 能量基准：优先用最新信号所在周期的能量分，缺则用领跑分
  let score = 0;
  if (c.tf && Array.isArray(energyRows)) {
    const e = energyRows.find(x => x && x.tf === c.tf);
    if (e && e.score != null) score = e.score;
  }
  if (!score && leader && leader.score != null) score = leader.score;

  // 新鲜度阶段
  let phase;
  if (fresh == null) phase = 'none';
  else if (fresh <= 3) phase = 'fresh';
  else if (fresh <= 8) phase = 'active';
  else if (fresh <= 20) phase = 'aging';
  else phase = 'stale';

  // 强度分档（能量分）
  const strength = score >= 70 ? '强' : score >= 45 ? '中' : '弱';

  // 信号置信度（纯展示）
  let conf = score;
  if (phase === 'fresh') conf += 10;
  else if (phase === 'active') conf += 5;
  else if (phase === 'stale') conf -= 10;
  if (isHook) conf += 15;
  conf = Math.max(5, Math.min(95, Math.round(conf)));

  const phaseTxt = { fresh: '新鲜', active: '活跃', aging: '衰减', stale: '失效', none: '无信号' }[phase];
  const dirTxt = dir === 'buy' ? '偏多' : dir === 'sell' ? '偏空' : '';
  const hookTxt = isHook ? (dir === 'buy' ? '金钩' : '死钩') : (dir === 'buy' ? '金叉' : '死叉');
  const freshTxt = fresh == null ? '' : (fresh === 0 ? '当下' : fresh + '根前');
  const cls = phase === 'fresh' ? 'disc-sig-fresh' : phase === 'stale' ? 'disc-sig-stale' : phase === 'aging' ? 'disc-sig-aging' : 'disc-sig-active';
  const txt = `${tf} ${hookTxt} ${freshTxt} · ${phaseTxt} ${strength} · ${dirTxt}`.replace(/\s+/g, ' ').trim();

  return { phase, strength, conf, txt, cls, tf, dir, fresh, isHook, score };
}

// ---- 方向基准视野化 + 死区固定/自适应滞回（纯函数，可单测）----
// 方向基准 = 勾选周期中最长、但 ≤ capMin(4h) 且 ≥120 点的 EMA20/120 趋势。
// 7d/30d 归宏观带(macroTrend)，只做冲突扣分，不参与方向判定。
// deadZone: EMA20/120 spread 绝对值低于该 % → flat(横盘/观望)，避免把噪声当方向。
export function horizonTrend(priceMap, opts = {}) {
  const capMin = opts.capMin != null ? opts.capMin : THRESH.HORIZON_CAP_MIN;
  const deadZone = opts.deadZone != null ? opts.deadZone : THRESH.HORIZON_DEAD_FIXED;
  const tfs = Object.keys(priceMap || {})
    .filter(tf => KLINE_TF.includes(tf) && minutesOf(tf) <= capMin)
    .sort((a, b) => minutesOf(a) - minutesOf(b));
  if (!tfs.length) return null;
  let trendTF = tfs[tfs.length - 1];
  for (let i = tfs.length - 1; i >= 0; i--) {
    if ((priceMap[tfs[i]] || []).length >= 120) { trendTF = tfs[i]; break; }
  }
  const tClose = priceMap[trendTF] || [];
  const e20A = ema(tClose, 20), e120A = ema(tClose, 120);
  const te20 = e20A[e20A.length - 1], te120 = e120A[e120A.length - 1];
  let up = null, slowRef = te120;
  if (te20 != null && te120 != null) up = te20 > te120;
  else if (te20 != null) {
    const win = Math.min(60, Math.max(20, Math.floor(tClose.length / 2)));
    slowRef = tClose.slice(-win).reduce((a, b) => a + b, 0) / win;
    up = te20 > slowRef;
  }
  const spreadPct = te20 != null && slowRef != null && slowRef > 0 ? (te20 - slowRef) / slowRef * 100 : 0;
  const flat = up == null || Math.abs(spreadPct) < deadZone;
  let label;
  if (up == null) label = '数据不足';
  else if (flat) label = '横盘';
  else label = up ? '上升' : '下降';
  return {
    tf: trendTF,
    up: flat ? null : up,
    flat,
    label,
    e20: te20, e120: slowRef,
    spreadPct, deadZone
  };
}

// 宏观带趋势(7d/30d 中最长 ≥120 点)，只用于冲突扣分，不参与方向判定。
export function macroTrend(priceMap) {
  const keys = Object.keys(priceMap || {});
  for (const tf of ['30d', '7d']) {
    if (!keys.includes(tf)) continue;
    const c = priceMap[tf] || [];
    if (c.length < 120) continue;
    const e20A = ema(c, 20), e120A = ema(c, 120);
    const te20 = e20A[e20A.length - 1], te120 = e120A[e120A.length - 1];
    let up = null;
    if (te20 != null && te120 != null) up = te20 > te120;
    else if (te20 != null) {
      const win = Math.min(60, Math.max(20, Math.floor(c.length / 2)));
      up = te20 > c.slice(-win).reduce((a, b) => a + b, 0) / win;
    }
    if (up == null) continue;
    return { tf, up, spreadPct: te20 != null && te120 != null && te120 > 0 ? (te20 - te120) / te120 * 100 : 0 };
  }
  return null;
}

// ATR% 历史（无状态，每次从 klines 现算）：atrClose 逐根 ATR/close×100，取末 n 根。
export function atrPctHistory(closes, n) {
  const N = n || THRESH.HORIZON_ATR_HIS;
  const c = closes || [];
  if (c.length < 14) return [];
  const atrA = atrClose(c, 14);
  const out = [];
  for (let i = Math.max(0, c.length - N); i < c.length; i++) {
    const a = atrA[i], cl = c[i];
    if (a != null && isFinite(a) && cl != null && cl > 0) out.push(a / cl * 100);
  }
  return out;
}

// 滞回状态机: ratio(curATR%/medATR%) → mode('fixed'|'adaptive')。
// fixed→adaptive: ratio≥hiEnter 或 ≤loEnter 连续 CONFIRM 帧；
// adaptive→fixed: loExit≤ratio≤hiExit 连续 CONFIRM 帧（滞回带防抖）。
// state={mode,n}；返回新 state。ratio 无效时强制回 fixed。
export function deadZoneLatch(ratio, state, opts = {}) {
  const s = state && state.mode ? state : { mode: 'fixed', n: 0 };
  const hiEnter = opts.hiEnter != null ? opts.hiEnter : THRESH.HORIZON_VOL_HI_ENTER;
  const loEnter = opts.loEnter != null ? opts.loEnter : THRESH.HORIZON_VOL_LO_ENTER;
  const hiExit = opts.hiExit != null ? opts.hiExit : THRESH.HORIZON_VOL_HI_EXIT;
  const loExit = opts.loExit != null ? opts.loExit : THRESH.HORIZON_VOL_LO_EXIT;
  const confirm = opts.confirm != null ? opts.confirm : THRESH.HORIZON_VOL_CONFIRM;
  let mode = s.mode, n = s.n || 0;
  if (ratio == null || !isFinite(ratio)) return { mode: 'fixed', n: 0 };
  if (mode === 'fixed') {
    const extreme = ratio >= hiEnter || ratio <= loEnter;
    n = extreme ? n + 1 : 0;
    if (n >= confirm) { mode = 'adaptive'; n = 0; }
  } else {
    const normal = ratio <= hiExit && ratio >= loExit;
    n = normal ? n + 1 : 0;
    if (n >= confirm) { mode = 'fixed'; n = 0; }
  }
  return { mode, n };
}

// 合成死区: fixed=固定值; adaptive=clamp(中位ATR%×mult, lo, hi)。
// pctHis 样本 < minSamples → 强制 fixed（冷启动保守）。
export function deadZoneValue(mode, pctHis, opts = {}) {
  const fixed = opts.fixed != null ? opts.fixed : THRESH.HORIZON_DEAD_FIXED;
  if (mode !== 'adaptive') return fixed;
  const his = pctHis || [];
  if (his.length < (opts.minSamples != null ? opts.minSamples : THRESH.HORIZON_ATR_MIN)) return fixed;
  const s = [...his].filter(v => typeof v === 'number' && isFinite(v) && v > 0).sort((a, b) => a - b);
  if (!s.length) return fixed;
  const med = s[Math.floor(s.length / 2)];
  const mult = opts.mult != null ? opts.mult : THRESH.HORIZON_DEAD_ATR_MULT;
  const lo = opts.lo != null ? opts.lo : THRESH.HORIZON_DEAD_MIN;
  const hi = opts.hi != null ? opts.hi : THRESH.HORIZON_DEAD_MAX;
  return Math.max(lo, Math.min(hi, med * mult));
}

// 宏观冲突扣分: 方向与宏观反向时按宏观 spread% 缩放, clamp [10,20]; 同向/观望→0。
export function conflictPenalty(mt, dir) {
  if (!mt || mt.up == null || !dir || dir === '观望') return 0;
  const conflict = (dir.startsWith('看多') && mt.up === false) || (dir.startsWith('看空') && mt.up === true);
  if (!conflict) return 0;
  return Math.max(10, Math.min(20, Math.abs(mt.spreadPct) * 0.5));
}

// 趋势(长周期EMA)与动能(SRSI共识)背离时的显式说明——双向对称，避免"速览一致偏多"与"纪律看空"视觉矛盾。
// 仅当两者明确相反时提示；同向/分歧/趋势数据不足均返回 null(避免误报或伪造一致)。
export function trendConflictNote(up, verdict, trendTF) {
  if (up === false && verdict === '一致偏多')
    return 'SRSI 多周期一致偏多，但长周期(' + trendTF + ') EMA 向下=主趋势偏空：金叉/金钩仅视为下跌中的反弹（回调≠反转），不逆势看多，等反转确认';
  if (up === true && verdict === '一致偏空')
    return 'SRSI 多周期一致偏空，但长周期(' + trendTF + ') EMA 向上=主趋势偏多：死叉/死钩仅视为上涨中的回调，不盲目看空';
  return null;
}

// ---- 仓位阶梯：长趋势 × 中趋势 × 短方向 三周期对齐 → 仓位乘数 ----
// 长=7d/30d EMA(macroTrend.up)，中=≤4h EMA(trend.up)，短=多周期SRSI共识(multiTf.verdict)。
// 三连共识=立即加大筹码；中+短对齐=顺势正常做；中短背离=仅轻仓逆势；长反向于中短=不追满。
const SIZE_MULT = { triple: 1.5, aligned: 1.0, alignedShort: 1.2, counter: 0.5, diverge: 0.6 };

// ---- 短线多空共识：多维因子加权（≤4h SRSI 共识轴）----
// 因子排位（乘法关系，①周期时长是量级主轴，②③④⑤为单位乘子）：
//  ① 周期时长：4h→1m 权重递減（sqrt(minutes/240)，4h=1.0）
//  ② 信号类型：钩(金钩/死钩) > 叉(金叉/死叉)
//  ③ KD 间距：|K-D| 振幅 大>小；且"间距拉大"(gapTrend=up)增强、"收窄"(down)衰减
//  ④ 极值突破：刚突破20进金钩 / 刚跌破80进死钩（isHook 且新鲜 fv≤3）→ 加成
//  ⑤ 新鲜度：根越新权重越高，陈旧有地板 0.4
const SHORT_CONSENSUS_TH = 0.60;   // 加权占比≥60% 才判单边（否则分歧）
const SHORT_ANCHOR_TF = '1h';      // 单边需至少一个 ≥1h 周期同向，防纯短线噪音成势

// 单周期信号有效权重（0~约1.6）。供 countBullBear 加权汇总使用。
// opts.higherExtreme: 当集合内存在 ≥4h 周期处于超买/超卖极值带时为真 → 触发钩反转加权。
export function shortSignalWeight(row, fv, opts = null) {
  const m = minutesOf(row.tf);
  const W_tf = Math.sqrt(m / 240);                       // ① 4h=1.0, 1h=0.5, 5m≈0.144, 1m≈0.065
  const isHook = row.hook != null;
  const W_type = isHook ? 1.30 : 1.00;                  // ② 钩 > 叉
  const k = row.k, d = row.d;
  const amp = (k != null && d != null) ? Math.min(1, Math.max(0, Math.abs(k - d) / 20)) : 0;
  const trendM = row.gapTrend === 'up' ? 1.15 : row.gapTrend === 'down' ? 0.70 : 1.00; // ③ 拉大增强/收窄衰减
  const W_gap = (0.50 + 0.50 * amp) * trendM;           // ③ KD间距 大>小
  const W_zone = (isHook && fv != null && fv <= 3) ? 1.15 : 1.00; // ④ 刚突破极值且新鲜 → 加成
  const W_fresh = (fv == null) ? 0.40 : Math.max(0.40, Math.min(1.00, 1 - fv / 20)); // ⑤ 新鲜>老
  let w = W_tf * W_type * W_gap * W_zone * W_fresh;
  // 钩反转加权: ≥4h 极值带 + ≤1h 新鲜钩 → 放大, 使该钩压过 4h 趋势权重(均值回归/见顶回落识别)
  if (opts && opts.higherExtreme && m <= 60 && isHook) {
    w *= (THRESH.HOOK_OVERRIDE_MULT != null ? THRESH.HOOK_OVERRIDE_MULT : 3.0);
  }
  return w;
}

export function positionSizing(longUp, midUp, shortSide, decidedBull = null, opts = null) {
  // shortSide: true=偏多 / false=偏空 / null=中性
  // decidedBull: 已判决方向(true=做多 / false=做空 / null=未定).
  //   提供后 side 强制跟随判决, mult 由与共识轴的对齐度决定（保持三轴上下文）.
  //   null → 原逻辑(共识定方向, 向后兼容).
  // opts.caveat: { present:true, reasons:[...] } 风险/置信不足/未确认/TSEV谨慎 → 不追满(×1.5→×1.0 标准仓)
  const caveat = opts && opts.caveat;
  const cavTxt = (caveat && caveat.reasons && caveat.reasons.length) ? caveat.reasons.join('、') : '风险/未确认';
  const allUp = longUp === true && midUp === true && shortSide === true;
  const allDown = longUp === false && midUp === false && shortSide === false;
  if (allUp) {
    if (caveat && caveat.present) return { mult: SIZE_MULT.aligned, label: '顺势但谨慎(不满攻)', side: 'up', cls: 'disc-size-up', hint: '长↑ 中↑ 短↑ 但' + cavTxt + ' → 不满攻，标准仓位' };
    return { mult: SIZE_MULT.triple, label: '立即加大筹码', side: 'up', cls: 'disc-size-up', hint: '长↑ 中↑ 短↑ 三周期共识，全线看多，满攻' };
  }
  if (allDown) {
    if (caveat && caveat.present) return { mult: SIZE_MULT.aligned, label: '顺势但谨慎(不满攻)', side: 'down', cls: 'disc-size-down', hint: '长↓ 中↓ 短↓ 但' + cavTxt + ' → 不满攻，标准仓位' };
    return { mult: SIZE_MULT.triple, label: '立即加大筹码', side: 'down', cls: 'disc-size-down', hint: '长↓ 中↓ 短↓ 三周期共识，全线看空，满攻' };
  }
  const midShortSame = midUp === true && shortSide === true;
  const midShortSameDn = midUp === false && shortSide === false;
  if (midShortSame) {
    if (longUp === false) {
      const base = { mult: SIZE_MULT.counter, cls: 'disc-size-up', hint: '中↑ 短↑ 但长线↓，反弹/短线顺势，别追满' };
      if (decidedBull === false) return { ...base, label: '逆势轻仓做空(中短共识背离)', side: 'down', cls: 'disc-size-down', hint: '中短共识偏多但判决做空，逆势轻仓，别追满' };
      return { ...base, label: '顺势正常做(长线逆风不追满)', side: decidedBull === null ? 'up' : (decidedBull ? 'up' : 'down') };
    }
    if (decidedBull === false) return { mult: SIZE_MULT.counter, label: '逆势轻仓做空(中短共识背离)', side: 'down', cls: 'disc-size-down', hint: '中短共识偏多但判决做空，逆势轻仓，别追满' };
    return { mult: SIZE_MULT.aligned, label: '顺势正常做', side: 'up', cls: 'disc-size-up', hint: '中↑ 短↑ 顺势，标准仓位' };
  }
  if (midShortSameDn) {
    if (longUp === true) {
      const base = { mult: SIZE_MULT.alignedShort, cls: 'disc-size-down', hint: '中↓ 短↓ 且长线↑，下跌中的顺势做空，可略加' };
      if (decidedBull === true) return { ...base, label: '逆势轻仓做多(中短共识背离)', side: 'up', cls: 'disc-size-up', hint: '中短共识偏空但判决做多，逆势轻仓，别追满' };
      return { ...base, label: '顺势做空(长线顺风可略加)', side: decidedBull === null ? 'down' : (decidedBull ? 'up' : 'down') };
    }
    if (decidedBull === true) return { mult: SIZE_MULT.counter, label: '逆势轻仓做多(中短共识背离)', side: 'up', cls: 'disc-size-up', hint: '中短共识偏空但判决做多，逆势轻仓，别追满' };
    return { mult: SIZE_MULT.aligned, label: '顺势做空', side: 'down', cls: 'disc-size-down', hint: '中↓ 短↓ 顺势做空，标准仓位' };
  }
  if (midUp !== null && shortSide !== null && midUp !== shortSide) {
    if (decidedBull !== null) return { mult: SIZE_MULT.counter, label: '仅轻仓逆势' + (decidedBull ? '做多' : '做空') + '(中短背离)', side: decidedBull ? 'up' : 'down', cls: 'disc-size-' + (decidedBull ? 'up' : 'down'), hint: '中周期与短方向背离，仅轻仓逆势，不重仓' };
    return { mult: SIZE_MULT.counter, label: '仅轻仓逆势反弹/观望', side: null, cls: 'disc-size-neutral', hint: '中周期与短方向背离（如上涨中短线看空），仅轻仓逆势，不重仓' };
  }
  if (decidedBull !== null) return { mult: SIZE_MULT.diverge, label: '基准仓位(观望优先)', side: decidedBull ? 'up' : 'down', cls: 'disc-size-neutral', hint: '多周期未形成明确共识，基准仓位或观望' };
  return { mult: SIZE_MULT.diverge, label: '基准仓位(观望优先)', side: null, cls: 'disc-size-neutral', hint: '多周期未形成明确共识，基准仓位或观望' };
}

// ---- 交易纪律分析引擎（纯函数，可单测）----
// 输入: priceMap={tf:[close,...]}（各周期收盘序列）+ SRSI 配置 + 主图周期。
// 规则硬编码自「交易纪律」百科：顺势交易/多周期共振/逆势信号警惕/回调≠反转/信号只是提示。
// 输出: { trend, multiTf, zones, entry, rules } —— 见预演（BNB/ETH/SOL 三币验证一致）。
export function analyzeTradeDiscipline(priceMap, srsiCfg, opts = {}) {
  const bars = opts.bars || 150;
  const mainTF = opts.mainTF || '4h';
  const klineSel = opts.klineSel || {};
  const weights = opts.weights; // TSEV 权重（不传则运行时取 loadTsevWeights 的缓存；为空 → 走经典逻辑兜底）
  const allTfs = Object.keys(priceMap || {}).filter(tf => KLINE_TF.includes(tf)).sort((a, b) => minutesOf(a) - minutesOf(b));
  if (!allTfs.length) return null;
  // SRSI/共识仅用用户勾选的 TF；被标记「辅助」的周期只参与放行闸门(不进共识/不加权)
  const auxTfsIn = (opts.auxTfs || []).filter(tf => allTfs.includes(tf));
  const useTfs = allTfs.filter(tf => klineSel[tf] !== false && !auxTfsIn.includes(tf));
  if (!useTfs.length && !auxTfsIn.length) return null;
  const gateTfs = [...new Set([...useTfs, ...auxTfsIn])];
  const ov = buildSrsiOverview(gateTfs, srsiCfg, priceMap, bars);
  const rows = ov.rows;
  const consRows = rows.filter(r => !auxTfsIn.includes(r.tf));
  const byTf = {};
  rows.forEach(r => { byTf[r.tf] = r; });
  // 能量/领跑：逐周期 KD 能量分 + 找出最高能量的「领跑者」（供呈现与置信度修正）
  const energyRows = rows.map(r => ({ tf: r.tf, energy: hookEnergy(r) }));
  const leader = leadingTF(rows);

  // 方向基准: 全部 TF 中 ≤capMin(4h)、≥120 点的最长 EMA20/120 趋势；spread < 死区 → flat 观望
  const capMin = opts.capMin != null ? opts.capMin : THRESH.HORIZON_CAP_MIN;
  const deadZone = opts.deadZone != null ? opts.deadZone : THRESH.HORIZON_DEAD_FIXED;
  const trend = horizonTrend(priceMap, { capMin, deadZone })
    || { tf: '—', up: null, flat: true, label: '数据不足', e20: null, e120: null, spreadPct: 0, deadZone };
  const trendTF = trend.tf;
  const up = trend.up;
  const tClose = (trendTF !== '—' && priceMap[trendTF]) || [];
  const mt = macroTrend(priceMap);

  // 市场状态 → 信号策略（用趋势TF 的 AIS 斜率检测 regime）
  const regSeries = trendTF !== '—' && tClose.length >= 30
    ? { price: tClose, aisLine: ais(tClose, 20, 8, 32, 14, 2).line } : null;
  const regimeState = regSeries ? detectRegimeState(regSeries) : null;
  const strategy = regimeStrategy(regimeState);

  // 多周期共识（短线轴锁定 ≤4h SRSI 共识；全量 ov.rows 仍用于速览表显示）
  const shortSrsiTfs = useTfs.filter(tf => minutesOf(tf) <= THRESH.HORIZON_CAP_MIN);
  const ovShort = buildSrsiOverview(shortSrsiTfs, srsiCfg, priceMap, bars);
  const bull = ovShort.bull, bear = ovShort.bear;
  const cb = countBullBear(ovShort.rows);
  let verdict = weightedShortVerdict(ovShort.rows, cb.wbull, cb.wbear);
  const bbTfs = bullBearTfs(ovShort.rows); // 透明化: 偏多/偏空 TF 构成

  // ≤1h 共识（保留字段，供对照/调试；不再单独驱动仓位短轴）
  const short1hTfs = useTfs.filter(tf => minutesOf(tf) <= minutesOf('1h'));
  const ovShort1h = buildSrsiOverview(short1hTfs, srsiCfg, priceMap, bars);
  const cb1h = countBullBear(ovShort1h.rows);
  const verdictShort1h = weightedShortVerdict(ovShort1h.rows, cb1h.wbull, cb1h.wbear);

  // 钩反转标记：≥4h 极值带 + ≤1h 新鲜钩 → 近线段反转被识别（透明展示用）
  const hookOverride = (ovShort.rows).some(r => minutesOf(r.tf) >= 240 && (r.zone === 'overbought' || r.zone === 'oversold'))
    && (ovShort.rows).some(r => minutesOf(r.tf) <= 60 && r.hook != null);

  // 仓位阶梯：长(7d/30d) × 中(≤4h EMA) × 短(≤4h SRSI共识, 含钩反转加权)。
  // 注：早期曾把短轴收窄为 ≤1h（verdictShort1h），已回退——短轴与能量场/预测统一吃 ≤4h 共识。
  const _longUp = (mt && mt.up != null) ? mt.up : null;
  const _shortSide = verdict === '一致偏多' ? true : verdict === '一致偏空' ? false : null;
  // sizing 移至 dir 决策后（见 TSEV 覆盖之后），确保与判决方向一致

  // 趋势与动能背离说明（双向对称）
  const conflictNote = trendConflictNote(trend.up, verdict, trendTF);

  // 关键周期
  const mainRow = byTf[mainTF] || rows[Math.floor(rows.length / 2)] || rows[rows.length - 1];
  const scalpRow = rows[0] || mainRow;
  // 日线槽位 = 真实 1d K线（不受 klineSel/预设影响，与速览同源）；1d 未就绪时回退勾选中最长周期
  const hasDaily = !!(priceMap['1d'] && priceMap['1d'].length >= 2);
  const dailyRow = hasDaily ? buildSrsiOverview(['1d'], srsiCfg, priceMap, bars).rows[0] : (rows[rows.length - 1] || mainRow);
  const dailyTf = hasDaily ? '1d' : dailyRow.tf;
  const mainTFUse = mainRow.tf;
  const zones = { daily: dailyRow.zone, main: mainRow.zone, scalp: scalpRow.zone, dailyTf };

  // 入场确认（方向感知: 门控安全网仍以趋势方向为基准, 策略只在无反向确认时切换方向源）
  const shortTfs = rows.filter(r => !auxTfsIn.includes(r.tf) && minutesOf(r.tf) <= minutesOf(mainTFUse)).map(r => r.tf);
  const shortRows = (shortTfs.length ? shortTfs : [scalpRow.tf]).map(tf => byTf[tf]);
  const want = up === true ? 'buy' : up === false ? 'sell' : null;
  let confirm = pickConfirm(shortRows, want);
  const confirmed = confirm.confirmed;
  // 观望门控: 趋势方向明确(want) 但最近短周期信号已反向确认(≤3根) → 不追不逆, 观望等信号与趋势一致
  const gateWait = !!(want && confirm.contrarian && confirm.fresh != null && confirm.fresh <= 3);

  // 逆势覆盖预判（用于规则与方向依据的诚实标注）：仅当 领跑/动量 与趋势相反 且 信号未被反转 才覆盖
  const _leadBuy = !!(leader && leader.dir === 'buy');
  const _leadAligned = up == null || (up === true) === _leadBuy;
  const _leaderReversed = !!(leader && byTf[leader.tf] && byTf[leader.tf].reversed);
  const _leaderOverride = strategy === 'energy-leader' && !!leader && !!leader.dir && leader.isClear && leader.score >= 70 && !_leadAligned && !_leaderReversed;
  const _fsBuy = confirm.dir === 'buy';
  const _fsAligned = up == null || (up === true) === _fsBuy;
  const _fsOverride = strategy === 'freshest-signal' && !!confirm.dir && confirm.confirmed && !_fsAligned;
  const contraTrade = _leaderOverride || _fsOverride;
  const overrideSrc = _leaderOverride
    ? (leader.tf + ' 能量' + leader.score + ' 偏' + (_leadBuy ? '多' : '空') + '独一档')
    : (_fsOverride ? (confirm.tf + ' ' + dirName(confirm.dir, confirm.isHook) + ' 已确认') : '');

  // 数据驱动: 超买/超卖跨周期广度（仅勾选 TF）
  const obCount = consRows.filter(r => r.zone === 'overbought').length;
  const osCount = consRows.filter(r => r.zone === 'oversold').length;

  // —— 反转 / 全周期K / K-D间距动能（供置信度修正与说明）——
  const allAbove = consRows.length && consRows.every(r => r.k != null && r.d != null && r.k > r.d);
  const allBelow = consRows.length && consRows.every(r => r.k != null && r.d != null && r.k < r.d);
  const allOB = consRows.length && consRows.every(r => r.zone === 'overbought');
  const allOS = consRows.length && consRows.every(r => r.zone === 'oversold');
  // 反转韧性：所选 confirm 已反转 → 原空头被反转(K>D)=偏多韧性 / 原多头被反转(K<D)=偏空韧性
  let reversalAdd = 0; const reversalParts = []; let revNote = null;
  if (confirm.reversed && confirm.dir) {
    const bear = confirm.dir === 'sell';
    if (bear && up !== false) { reversalAdd = 8; reversalParts.push('死信号反转+8(多头韧性)'); }
    else if (!bear && up !== true) { reversalAdd = 8; reversalParts.push('金信号反转+8(空头韧性)'); }
    else if (bear && up === false) { reversalAdd = -8; reversalParts.push('死信号反转-8'); }
    else if (!bear && up === true) { reversalAdd = -8; reversalParts.push('金信号反转-8'); }
    revNote = (bear ? '死钩/死叉' : '金钩/金叉') + '已反转(' + (bear ? 'K>D' : 'K<D') + ')→' + (bear ? '偏多韧性' : '偏空韧性');
  }
  // 全周期 K>D / K<D 强信号
  let periodKAdd = 0;
  if (allAbove) periodKAdd = 10;
  else if (allBelow) periodKAdd = -10;
  // K-D 间距动能（加速/减弱）：与方向基准一致时加速+, 减弱-；超买收窄=背离预警
  let gapAdd = 0; const gapParts = [];
  consRows.forEach(r => {
    if (r.gapNow == null || r.gapPrev == null) return;
    const gdir = r.k > r.d ? 'buy' : (r.k < r.d ? 'sell' : null);
    if (!gdir) return;
    const accel = r.gapNow > r.gapPrev * 1.1;
    const decel = r.gapNow < r.gapPrev * 0.9;
    if (up === true && gdir === 'buy' && accel) gapAdd += 3;
    else if (up === true && gdir === 'buy' && decel) gapAdd -= 3;
    else if (up === false && gdir === 'sell' && accel) gapAdd += 3;
    else if (up === false && gdir === 'sell' && decel) gapAdd -= 3;
    if (r.zone === 'overbought' && decel) gapParts.push(r.tf + '超买动能失速(背离预警)');
  });
  gapAdd = Math.max(-12, Math.min(12, gapAdd));
  // 新鲜信号却动能减弱 → 额外 -5
  if (confirm.dir && !confirm.reversed && confirm.fresh != null && confirm.fresh <= 3) {
    const cr = byTf[confirm.tf];
    if (cr && cr.gapNow != null && cr.gapPrev != null && cr.gapNow < cr.gapPrev * 0.9) gapAdd -= 5;
  }
  let periodRisk = '';
  if (allAbove && allOB) periodRisk = '中(全周期超买,防冲顶)';
  else if (allBelow && allOS) periodRisk = '中(全周期超卖,防赶底)';

  // 纪律清单
  const rules = [];
  let trendNote;
  if (trend.label === '数据不足') trendNote = '数据不足, 无法判断趋势';
  else if (up === true) trendNote = '方向基准(' + trendTF + ') EMA20>EMA120, 顺势看多为主';
  else if (up === false) trendNote = '方向基准(' + trendTF + ') EMA 向下, 顺势看空为主';
  else trendNote = '方向基准(' + trendTF + ') EMA 价差 ' + trend.spreadPct.toFixed(2) + '% 低于死区 ' + deadZone.toFixed(2) + '%, 横盘观望';
  rules.push({ name: '顺势交易', ok: !contraTrade, note: trendNote });

  rules.push({
    name: '多周期共振',
    ok: verdict === '一致偏多' || verdict === '一致偏空',
    note: '偏多' + bull + ' 偏空' + bear + ' → ' + verdict
  });

  let trapNote = '无逆势陷阱';
  let trapOk = true;
  if (up === true && scalpRow.zone === 'overbought') { trapNote = scalpRow.tf + '超买(死叉)多为回调非反转, 勿追空'; trapOk = false; }
  else if (up === false && scalpRow.zone === 'oversold') { trapNote = scalpRow.tf + '超卖(金叉)多为反弹非反转, 勿追多'; trapOk = false; }
  else if (trend.flat && trend.label !== '数据不足' && (scalpRow.zone === 'overbought' || scalpRow.zone === 'oversold')) {
    trapNote = '方向横盘, 无趋势可逆; 超买超卖信号可靠性低, 等 EMA 方向明确';
    trapOk = true;
  }
  rules.push({ name: '逆势信号警惕', ok: trapOk, note: trapNote });

  // 回调≠反转（数据驱动: 实际 SRSI 短/多周期超买超卖广度）
  let prNote, prOk;
  if (up === true) {
    if (mainRow.zone === 'oversold') {
      const depthNote = osCount >= 2 ? '(多周期均超卖, 深度回调)' : '(仅部分超卖, 常规回调)';
      prNote = '下跌中 主周期(' + mainTFUse + ')超卖, 方向基准仍向上 → 视为回调' + depthNote + ', 等金叉低吸, 勿追空';
      prOk = true;
    } else {
      prNote = '方向基准向上, 主周期未超卖, 等回踩低吸';
      prOk = false;
    }
  } else if (up === false) {
    if (mainRow.zone === 'overbought') {
      const depthNote = obCount >= 2 ? '(多周期均超买, 深度反弹)' : '(仅部分超买, 常规反弹)';
      prNote = '反弹中 主周期(' + mainTFUse + ')超买, 方向基准仍向下 → 视为反弹' + depthNote + ', 等死叉看空, 勿追多';
      prOk = true;
    } else {
      prNote = '方向基准向下, 主周期未超买, 等反弹看空';
      prOk = false;
    }
  } else if (trend.label === '数据不足') {
    prNote = '数据不足, 无法判断趋势上下文'; prOk = false;
  } else {
    prNote = '方向基准横盘(价差 < 死区 ' + deadZone.toFixed(2) + '%), 回调≠反转暂不适用, 等 EMA 方向明确';
    prOk = true;
  }
  rules.push({ name: '回调≠反转', ok: prOk, note: prNote });

  rules.push({
    name: '信号只是提示',
    ok: confirmed || gateWait,
    note: confirmed
      ? (confirm.tf + ' ' + dirName(confirm.dir, confirm.isHook) + ' ' + confirm.fresh + '根前 ✅ 已确认')
      : (gateWait
        ? (confirm.tf + ' ' + dirName(confirm.dir, confirm.isHook) + ' ' + confirm.fresh + '根前 ✅ 已确认(反向) → ' + (want === 'buy' ? '回调中勿追多, 等金叉/金钩确认回调结束再低吸' : '反弹中勿追空, 等死叉/死钩确认反弹结束再看空'))
        : (confirm.dir ? (confirm.tf + ' ' + dirName(confirm.dir, confirm.isHook) + ' ' + confirm.fresh + '根前, 需等更新鲜确认') : '近期无穿越信号, 观望'))
  });

  // 反转信号识别：若最近信号已反转，说明原方向被动量否决 → 翻转计入，不作为有效反向确认
  rules.push({
    name: '信号反转识别',
    ok: !confirm.reversed || (confirm.dir === 'sell' ? up !== false : up !== true),
    note: confirm.reversed ? (revNote + ' → 翻转计' + (confirm.dir === 'sell' ? '多' : '空')) : '近期信号未反转'
  });

  // 短周期锚定（能量领跑）：最高能量的周期驱动近期走势，方向与方向基准一致 → 顺势增强，相反 → 动能衰减警惕
  let leadNote, leadOk = true;
  if (leader) {
    const leadDirTxt = leader.dir === 'buy' ? '偏多' : '偏空';
    if (up === true && leader.dir === 'buy') { leadNote = leader.tf + ' 能量 ' + leader.score + ' ' + leadDirTxt + '领跑, 与方向基准一致 → 短线顺势'; leadOk = true; }
    else if (up === false && leader.dir === 'sell') { leadNote = leader.tf + ' 能量 ' + leader.score + ' ' + leadDirTxt + '领跑, 与方向基准一致 → 短线顺势'; leadOk = true; }
    else if (up === true && leader.dir === 'sell') { leadNote = leader.tf + ' 能量 ' + leader.score + ' ' + leadDirTxt + '领跑, 与方向基准相反 → 短线动能衰减, 防回调/反转'; leadOk = false; }
    else if (up === false && leader.dir === 'buy') { leadNote = leader.tf + ' 能量 ' + leader.score + ' ' + leadDirTxt + '领跑, 与方向基准相反 → 短线反弹, 勿追空'; leadOk = false; }
    else { leadNote = leader.tf + ' 能量 ' + leader.score + ' ' + leadDirTxt + '领跑, 方向基准横盘 → 短线动能主导'; leadOk = true; }
  } else {
    leadNote = '无显著领跑周期(各周期能量均 <50 或无信号)';
  }
  rules.push({ name: '短周期锚定', ok: leadOk, note: leadNote });

  // 操作建议（策略感知）
  const p = tClose[tClose.length - 1] || 0;
  const atrP = tClose.length >= 14 ? (atrClose(tClose, 14)[tClose.length - 1] || p * 0.001) : p * 0.001;
  let dir = '观望', base = 30, reason = '多周期分歧/无明确信号', entryCue = '等待共振信号', stop = null, target = null;
  if (trend.label === '数据不足') {
    dir = '观望'; base = 30; reason = '数据不足, 无法判定方向'; entryCue = '等待更多K线';
  } else if (gateWait) {
    dir = '观望'; base = 30;
    reason = want === 'buy'
      ? '方向基准上升(' + trendTF + ') 但 ' + (confirm.tf || '短周期') + ' ' + dirName(confirm.dir, confirm.isHook) + '已确认(反向) → 短线回调中, 观望: 勿追多(下跌未完)亦勿逆势看空(趋势向上), 等金叉/金钩确认回调结束再低吸'
      : '方向基准下降(' + trendTF + ') 但 ' + (confirm.tf || '短周期') + ' ' + dirName(confirm.dir, confirm.isHook) + '已确认(反向) → 短线反弹中, 观望: 勿追空(反弹未完)亦勿逆势看多(趋势向下), 等死叉/死钩确认反弹结束再看空';
    entryCue = confirm.isHook
      ? (want === 'buy' ? '死钩已现，等价格企稳' : '金钩已现，等价格企稳')
      : want === 'buy'
        ? '等 短周期金叉/金钩 确认回调结束, 或 ' + trendTF + ' 方向翻空后再考虑看空'
        : '等 短周期死叉/死钩 确认反弹结束, 或 ' + trendTF + ' 方向翻多后再考虑看多';
    stop = null; target = null;
  } else if (strategy === 'energy-leader' && leader && leader.dir) {
    // 趋势极性约束: 逆势领跑仅当 独一档且能量≥70 才允许覆盖方向(顺势领跑/趋势未明直接用)
    const isBuy = leader.dir === 'buy';
    const aligned = up == null || (up === true) === isBuy;
    const strongOverride = leader.isClear && leader.score >= 70 && !_leaderReversed;
    if (aligned || strongOverride) {
      dir = isBuy ? '看多' : '看空';
      base = Math.max(40, Math.min(70, leader.score));
      reason = '策略[能量领跑]: ' + leader.tf + ' 能量 ' + leader.score + ' ' + (isBuy ? '偏多' : '偏空') + '领跑' + (aligned ? ', 与方向基准一致 → 顺势' : ', 逆势独一档高能, 短线动能反转');
      entryCue = '等 ' + (confirm.tf || '短周期') + ' ' + (confirm.isHook ? (isBuy ? '金钩' : '死钩') : (isBuy ? '金叉' : '死叉')) + '确认 + 价格企稳';
      stop = p - (isBuy ? 1.5 : -1.5) * atrP;
      target = trend.e20 != null && (isBuy ? trend.e20 > p : trend.e20 < p) ? trend.e20 : (isBuy ? p * 1.02 : p * 0.98);
    } else {
      // 弱逆势领跑不覆盖 → 回落到趋势基线逻辑
      if (up === true && mainRow.zone === 'oversold') { dir = '看多'; base = 70; reason = '方向基准向上 + ' + mainTFUse + '超卖回调 → 顺势低吸(策略能量领跑, 但领跑' + leader.tf + '弱逆势不覆盖)'; entryCue = '等 ' + (confirm.tf || '短周期') + ' ' + (confirm.isHook ? '金钩' : '金叉') + '确认 + 价格企稳'; stop = p - 1.5 * atrP; target = trend.e20 != null && trend.e20 > p ? trend.e20 : p * 1.02; }
      else if (up === true) { dir = '看多(观察)'; base = 45; reason = '方向基准向上, 领跑' + leader.tf + '能量' + leader.score + '偏空但不够强(需≥70独一档) → 不逆势, 等回调'; entryCue = '回踩 ' + mainTFUse + ' 支撑或 EMA20 再考虑'; stop = p - 1.0 * atrP; target = trend.e20 != null && trend.e20 > p ? trend.e20 : p * 1.02; }
    }
  } else if (strategy === 'freshest-signal' && confirm.dir) {
    // 趋势极性约束: 逆势动量仅当已确认(≤3根) 才覆盖; 顺势直接用
    const isBuy = confirm.dir === 'buy';
    const aligned = up == null || (up === true) === isBuy;
    if (aligned || confirmed) {
      dir = isBuy ? '看多' : '看空';
      base = 70;
      reason = '策略[动量跟随]: ' + confirm.tf + ' ' + dirName(confirm.dir, confirm.isHook) + ' ' + confirm.fresh + '根前(最新信号)' + (aligned ? ', 与方向基准一致' : ', 已确认动量反转');
      entryCue = (confirm.isHook ? (isBuy ? '金钩' : '死钩') : (isBuy ? '金叉' : '死叉')) + '已确认, 顺势入场';
      stop = p - (isBuy ? 1.0 : -1.0) * atrP;
      target = trend.e20 != null && (isBuy ? trend.e20 > p : trend.e20 < p) ? trend.e20 : (isBuy ? p * 1.02 : p * 0.98);
    } else if (up === false) {
      dir = '看空(观察)'; base = 45; reason = '方向基准向下, ' + confirm.tf + '动量偏多但已' + confirm.fresh + '根前未确认 → 不逆势, 等反弹'; entryCue = '反弹至 ' + mainTFUse + ' 压力或 EMA20 再考虑'; stop = p + 1.0 * atrP; target = trend.e20 != null && trend.e20 < p ? trend.e20 : p * 0.98;
    }
  } else if (trend.flat) {
    dir = '观望'; base = 30;
    reason = '方向基准(' + trendTF + ') EMA 价差仅 ' + trend.spreadPct.toFixed(2) + '% < 死区 ' + deadZone.toFixed(2) + '%, 无明确趋势 → 观望';
    entryCue = '等 ' + trendTF + ' 价差突破死区(' + deadZone.toFixed(2) + '%) 或 SRSI 共振确认';
  } else if (up === true && mainRow.zone === 'oversold') {
    dir = '看多'; base = 70; reason = '方向基准向上 + ' + mainTFUse + '超卖回调 → 顺势低吸';
    entryCue = '等 ' + (confirm.tf || '短周期') + ' ' + (confirm.isHook ? '金钩' : '金叉') + '确认 + 价格企稳';
    stop = p - 1.5 * atrP;
    target = trend.e20 != null && trend.e20 > p ? trend.e20 : p * 1.02;
  } else if (up === false && mainRow.zone === 'overbought') {
    dir = '看空'; base = 70; reason = '方向基准向下 + ' + mainTFUse + '超买反弹 → 顺势看空';
    entryCue = '等 ' + (confirm.tf || '短周期') + ' ' + (confirm.isHook ? '死钩' : '死叉') + '确认 + 价格滞涨';
    stop = p + 1.5 * atrP;
    target = trend.e20 != null && trend.e20 < p ? trend.e20 : p * 0.98;
  } else if (up === true) {
    dir = '看多(观察)'; base = 45; reason = '方向基准向上, 但主周期未超卖, 等回调';
    entryCue = '回踩 ' + mainTFUse + ' 支撑或 EMA20 再考虑';
    stop = p - 1.0 * atrP;
    target = trend.e20 != null && trend.e20 > p ? trend.e20 : p * 1.02;
  } else if (up === false) {
    dir = '看空(观察)'; base = 45; reason = '方向基准向下, 但主周期未超买, 等反弹';
    entryCue = '反弹至 ' + mainTFUse + ' 压力或 EMA20 再考虑';
    stop = p + 1.0 * atrP;
    target = trend.e20 != null && trend.e20 < p ? trend.e20 : p * 0.98;
  }

  // 置信度修正
  let conf = base;
  const confParts = [];
  if (verdict === '一致偏多' && dir.startsWith('看多')) { conf += 10; confParts.push('多周期一致+10'); }
  else if (verdict === '一致偏空' && dir.startsWith('看空')) { conf += 10; confParts.push('多周期一致+10'); }
  else if (verdict === '分歧') { conf -= 15; confParts.push('周期分歧-15'); }
  if (gateWait) {
    // 反向确认已成立 → 观望: 不加分、不当「未确认」, 理由行已说明
  } else if (confirmed) { conf += confirm.isHook ? 15 : 10; confParts.push(confirm.isHook ? '钩确认+15' : '入场已确认+10'); }
  else if (confirm.dir && !confirm.reversed) { conf -= 5; confParts.push('未确认-5'); }
  if (dir.startsWith('看多') && dailyRow.zone === 'overbought') { conf -= 10; confParts.push('日线超买-10'); }
  if (dir.startsWith('看空') && dailyRow.zone === 'oversold') { conf -= 10; confParts.push('日线超卖-10'); }
  // 宏观冲突扣分（方向 vs 宏观 7d/30d 反向）
  const macroPen = conflictPenalty(mt, dir);
  if (macroPen) { conf -= macroPen; confParts.push('宏观反向-' + macroPen); }
  // 能量领跑修正：领跑方向与操作方向一致 → 按能量加分；相反 → 短周期反向动能减分；全线能量枯竭 → 减分
  // （策略为 energy-leader 时 base 已含能量分, 不再重复加分）
  if (strategy !== 'energy-leader' && leader && (dir.startsWith('看多') || dir.startsWith('看空'))) {
    const leadAligned = (dir.startsWith('看多') && leader.dir === 'buy') || (dir.startsWith('看空') && leader.dir === 'sell');
    if (leadAligned) { const add = Math.min(leader.score / 10, 10); conf += add; confParts.push('领跑' + leader.tf + '+' + add); }
    else { conf -= 5; confParts.push('领跑反向-5'); }
  } else if (strategy !== 'energy-leader' && !leader && consRows.length && consRows.every(r => !r.energy || r.energy.score < 30)) {
    conf -= 5; confParts.push('信号耗尽-5');
  }
  // 反转韧性加/扣分
  if (reversalAdd) { conf += reversalAdd; confParts.push(reversalParts[0]); }
  // 全周期 K>D/D 强信号
  if (periodKAdd) { conf += periodKAdd; confParts.push(periodKAdd > 0 ? '全周期K>D 强势+10' : '全周期K<D 强势-10'); }
  // K-D 间距动能（加速/减弱）
  if (gapAdd) { conf += gapAdd; confParts.push('KD间距动能' + (gapAdd > 0 ? '+' : '') + gapAdd); }
  if (gapParts.length) confParts.push(gapParts.join('/'));
  // 全周期超买/超卖护栏：封顶置信度
  if (periodRisk) { conf = Math.min(conf, 80); }
  conf = Math.max(10, Math.min(90, Math.round(conf)));
  let confLabel = conf >= 70 ? '高' : conf >= 45 ? '中' : '低';

  // ---- TSEV 数据门控投票：用数据训练的因子权重覆盖硬 if/else 方向 ----
  // 仅在权重可用（dev 下 /data/discipline-factors.jsonl 经 loadTsevWeights 训练）时启用；
  // 否则保持经典逻辑（其方向精度已证实低于随机，dev 下会用 TSEV 修正）。
  const factors = extractDisciplineFactors({ trend, mt, confirm, leading: leader, reversalAdd, zones, verdict, periodKAdd, gapAdd });
  let tsev = null;
  const _w = (weights !== undefined) ? weights : getTsevWeights(opts.sym);
  if (_w && Object.keys(_w).length) {
    tsev = voteTsev(factors, _w);
    if (tsev.unbalanced && !tsev.partial) {
      // 真正无任何方向样本 → 回退经典逻辑；若是「仅学到一侧权重」(partial)，保留部分投票：
      // 可给看空/看多（已学方向），但不确认未学到的一侧，避免单边样本伪造反向判决。
      tsev = null;
    } else if (tsev.dir !== 0) {
      dir = tsev.dirText;
      conf = Math.round(tsev.conf * 100);
      confLabel = tsev.confLabel;
      // 可交易门控：置信或净票不足 → 保留投票方向(不丢弃, 避免与子信号自相矛盾)，仅标记不可交易（宁缺毋滥，不触发真实交易）
      if (tsev.conf < TSEV_CFG.GATE || Math.abs(tsev.net) < TSEV_CFG.M) {
        tsev.actionable = false;
      } else {
        tsev.actionable = true;
        // 原分支(观望/等确认)未给具体计划 → 补 plan，避免「可交易」却无目标价/止损(面板空白)
        if (target == null) {
          const isBuy = tsev.dir === 1;
          stop = p - (isBuy ? 1.5 : -1.5) * atrP;
          target = trend.e20 != null && (isBuy ? trend.e20 > p : trend.e20 < p) ? trend.e20 : (isBuy ? p * 1.02 : p * 0.98);
          if (entryCue && entryCue.charAt(0) === '等')
            entryCue = 'TSEV 顺势方向, ' + (confirm.isHook ? (isBuy ? '金钩' : '死钩') : (isBuy ? '金叉' : '死叉')) + '确认后入场';
        }
      }
    } else {
      // TSEV 无明确方向票 → 不覆盖经典方向(保留经典 看多/看空/观望)，仅标记不可交易（宁缺毋滥，不触发真实交易）
      tsev.actionable = false;
    }
  }

  // 辅助周期放行闸门（用户标记的周期仅作放行闸门: 与主方向反向 → 否决为观望, 且不进共识/不加权）
  // 放在 TSEV 之后, 确保即使用户数据模型给出方向, 闸门仍优先否决。
  const auxTfs = (opts && opts.auxTfs) || [];
  if (auxTfs.length && dir !== '观望') {
    const sigDir = dir.startsWith('看多') ? 'buy' : dir.startsWith('看空') ? 'sell' : null;
    if (sigDir) {
      const auxRowsForGate = rows.filter(r => auxTfs.includes(r.tf));
      if (auxRowsForGate.length && auxGateStatus(sigDir, auxRowsForGate) === 'vetoed') {
        dir = '观望'; conf = 30; confLabel = '低'; confParts.length = 0; confParts.push('辅助放行闸门否决');
        reason = '辅助周期(' + auxRowsForGate.map(r => r.tf).join('/') + ') 方向与主方向反向 → 放行闸门否决, 转为观望';
        entryCue = '等辅助周期与主方向同向, 再考虑入场';
        stop = null; target = null;
      }
    }
  }

  // 宏观冲突文本（用于额外横幅）
  let macroConflict = null;
  if (mt && mt.up != null && dir.startsWith('看多') && mt.up === false)
    macroConflict = '⚠ 宏观(' + mt.tf + ') EMA 向下与看多方向冲突, 整体观点';
  else if (mt && mt.up != null && dir.startsWith('看空') && mt.up === true)
    macroConflict = '⚠ 宏观(' + mt.tf + ') EMA 向上与看空方向冲突, 整体观点';

  // 仓位门控(②)：置信不足/未确认/TSEV谨慎/动能背离/长周期极端反向/宏观反向 → 不追满（×1.5→×1.0 标准仓）
  // 注：日线超买/超卖仅进「风险」展示，不单独触发降仓（健康上升势中日常超买，不应剥夺满攻）
  const _momentumBear = (dir.startsWith('看多') && bear >= bull) || (dir.startsWith('看空') && bull >= bear);
  const _caveat = {
    present: !!(periodRisk || confLabel !== '高' || (tsev && tsev.actionable === false) || macroConflict || !confirmed || _momentumBear),
    reasons: [
      periodRisk ? '长周期极端反向' : null,
      confLabel !== '高' ? ('置信' + confLabel) : null,
      (tsev && tsev.actionable === false) ? 'TSEV置信不足' : null,
      macroConflict ? '宏观反向' : null,
      !confirmed ? '信号未确认' : null,
      _momentumBear ? '动能背离' : null
    ].filter(Boolean)
  };

  // 仓位阶梯（dir 决策后，确保与判决方向一致）
  const decidedBull = dir.startsWith('看多') ? true : dir.startsWith('看空') ? false : null;
  const sizing = positionSizing(_longUp, up, _shortSide, decidedBull, { caveat: _caveat });

  // 信号生命周期/强度（仅呈现层, 统一追加到所有档位 reason 尾部 + 单独 field 供 DOM）
  const life = signalLifecycle(confirm, leader, energyRows);
  if (life && life.txt) reason += '；信号: ' + life.txt;
  if (revNote) reason += '；' + revNote;

  // 短线各周期因子明细（供能量球卡片渲染：方向/权重/KD/间距趋势/新鲜度/钩叉）
  const _heRows = (ovShort && ovShort.rows) || [];
  const _he = _heRows.some(r => minutesOf(r.tf) >= 240 && (r.zone === 'overbought' || r.zone === 'oversold'));
  const shortFactors = _heRows.map(row => {
    const lc = latestCross(row);
    let dir = null;
    if (lc.cv) {
      let c = (lc.cv === 'buy' || lc.cv === 'goldHook') ? 'bull' : 'bear';
      if (row.reversed) c = c === 'bull' ? 'bear' : 'bull';
      dir = c;
    }
    return {
      tf: row.tf,
      dir,
      w: shortSignalWeight(row, lc.fv, { higherExtreme: _he }),
      k: row.k, d: row.d,
      gap: (row.k != null && row.d != null) ? row.k - row.d : null,
      gapTrend: row.gapTrend || 'flat',
      fresh: lc.fv,
      isHook: row.hook != null,
      signal: lc.cv,
      reversed: !!row.reversed
    };
  });

  return {
    strategy,
    regime: regimeState ? { type: regimeState.type, label: regimeState.label, strength: regimeState.strength, slopePct: regimeState.slopePct } : null,
    macroConflict,
    conflictNote,
    trend,
    contraTrade,
    basisNote: contraTrade
      ? `⚠ 逆势覆盖: 长周期 EMA(${trendTF}) ${up === true ? '↑' : '↓'} 被短线 ${overrideSrc} 逆势覆盖 → ${dir}`
      : `EMA(${trendTF}) ${up === true ? '↑ 看多基准' : up === false ? '↓ 看空基准' : '横盘观望'} ${trend.spreadPct.toFixed(2)}%`,
    longUp: _longUp,
    multiTf: { bull, bear, wbull: cb.wbull, wbear: cb.wbear, ratio: (cb.wbull + cb.wbear) > 0 ? cb.wbull / (cb.wbull + cb.wbear) : 0, verdict, verdictShort1h, hookOverride, bullTfs: bbTfs.bullTfs, bearTfs: bbTfs.bearTfs },
    zones,
    confirm: { dir: confirm.dir, fresh: confirm.fresh, tf: confirm.tf, isHook: confirm.isHook, confirmed, contrarian: confirm.contrarian, reversed: confirm.reversed },
    leading: leader ? { tf: leader.tf, dir: leader.dir, score: leader.score, isHook: leader.isHook, isClear: leader.isClear } : null,
    energyRows: energyRows.map(e => ({ tf: e.tf, dir: e.energy.dir, score: e.energy.score, isHook: e.energy.isHook })),
    signalLife: life,
    entry: {
      dir, conf, confLabel, confParts, reason, entryCue, stop, target,
      risk: periodRisk || ((dir.startsWith('看多') && dailyRow.zone === 'overbought') || (dir.startsWith('看空') && dailyRow.zone === 'oversold') ? '中(长周期极端反向)' : '低')
    },
    factors,
    tsev,
    shortFactors,
    sizing,
    rules,
    atrP
  };
}

// ---- 画布尺寸同步（DPR）----
function syncCanvasSize() {
  if (!_cv) return;
  const nSub = buildSubList().length;
  const H = BASE_H + nSub * (SUB_H + SUB_GAP); // GOAL21：BASE_H 已含 STATUS_H
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  let bw, bh;
  if (typeof _cv.getBoundingClientRect === 'function') {
    const rect = _cv.getBoundingClientRect();
    if (rect.width > 0) {
      bw = Math.max(1, Math.round(rect.width * dpr));
      bh = Math.max(1, Math.round(bw * (H / W)));
    }
  }
  if (!bw || !bh) { bw = W * dpr; bh = H * dpr; }
  _cv.__logicalH = H;
  if (bw === _cv.width && bh === _cv.height) return;
  _cv.width = bw;
  _cv.height = bh;
  _ctx = _cv.getContext('2d');
  _ctx.setTransform(bw / W, 0, 0, bh / H, 0, 0);
}

// ============================================================
// v1.6.23：主图标记光晕/微闪覆盖层 + 行动卡 DOM 浮层
// 两者都挂在 .kchart-box（position:relative）内；覆盖层 pointer-events:none，不参与 canvas 坐标命中。
// ============================================================
let _mainGeom = null;                 // drawMain 缓存的主图几何（供 markFxXY 对齐）
let _fx = null;                       // { cv, ctx, raf, last }  标记光晕层
let _acEl = null;                     // 行动卡 DOM 浮层
let _acDragging = false;              // 拖动中：禁止每秒重定位（否则会把手拖到一半的位置拉回去）

// 主图标记图例（单一数据源，可单测）：卡头 #pwaLegend 与工具栏 .mt-legend 共用，避免两处漂移
// （历史教训：卡头图例曾硬编码在 kchart.html，漏了死钩/平仓/机会点，且把只在 SRSI 子图的钩写成主图标记）
export function legendItems() {
  return [
    { icon: '▲', color: '#00e676', label: 'SRSI开多', title: 'SRSI 自动真实开多（成交）' },
    { icon: '▼', color: '#ff5252', label: 'SRSI开空', title: 'SRSI 自动真实开空（成交）' },
    { icon: '●', color: '#8899aa', label: 'SRSI平仓', title: 'SRSI 自动平仓（成交）' },
    { icon: '◆', color: '#22d3ee', label: 'α多', title: 'Alpha 基石实盘 加多/减空（调仓）' },
    { icon: '◆', color: '#f59e0b', label: 'α空', title: 'Alpha 基石实盘 加空/减多（调仓）' },
    { icon: '◇', color: '#8899aa', label: 'α平', title: 'Alpha 基石实盘 平仓' },
    { icon: '●', color: '#2ecc71', label: '机会多', title: '15m SRSI 看多机会：K 跌入超卖区（穿越下带）' },
    { icon: '●', color: '#ff6b6b', label: '机会空', title: '15m SRSI 看空机会：K 升入超买区（穿越上带）' },
    { icon: '◆', color: '#00E676', label: '金钩', title: '金钩：低位金叉 + 突破超卖线（看多；同根同侧与机会点重叠时只显示钩）' },
    { icon: '◆', color: '#FF5252', label: '死钩', title: '死钩：高位死叉 + 跌破超买线（看空；同根同侧与机会点重叠时只显示钩）' },
  ];
}
export function renderLegendHtml() {
  return legendItems().map(it => '<i style="color:' + it.color + '" title="' + it.title + '">' + it.icon + ' ' + it.label + '</i>').join('');
}
// PWA 卡头图例（静态内容；已渲染则不重建）
function renderPwaLegend() {
  if (typeof document === 'undefined') return;
  const el = document.getElementById('pwaLegend');
  if (!el) return;
  const html = renderLegendHtml();
  if (el.__html !== html) { el.__html = html; el.innerHTML = html; }
}

// ============================================================
// v1.6.30：价格-均线关系盯盘辅助层（默认关，纯显示，不接自动交易）
// 理论：本周期 MA20 主战场 + 日线 MA20/50/200 定向 + 周线 MA20/200 大级别；
//      收盘确认（影线不算）/ 结构防守位 / 同向冷却 / 不追乖离。计算全在 engine/maRelation.js（纯函数）。
// ============================================================
let _maRelCache = { key: '', data: null };
const MA_LINE = {
  fast: { c: '#22d3ee', w: 1.6, dash: null },      // 本周期 MA20（最醒目）
  mid: { c: '#7c4dff', w: 1.0, dash: null },       // 本周期 MA60
  slow: { c: '#f59e0b', w: 1.0, dash: [5, 3] },    // 本周期 MA120（可选）
  d20: { c: '#2ecc71', w: 1.0, dash: [6, 4] },     // 日线 MA20
  d50: { c: '#8899aa', w: 0.9, dash: [6, 4] },     // 日线 MA50
  d200: { c: '#ff6b6b', w: 0.9, dash: [6, 4] },    // 日线 MA200
  w20: { c: '#00E676', w: 2.0, dash: null },       // 周线 MA20（最粗）
  w200: { c: '#ff5252', w: 2.0, dash: null },      // 周线 MA200
  vwap: { c: '#ffd740', w: 1.0, dash: [2, 3] },    // 本周期 VWAP
};

// 日线 → 周线（每 7 根取一根，防前视由 maRelation 内部对齐保证）
function _weeklyFromDaily(c1d, t1d) {
  const c = [], t = [];
  for (let i = 6; i < c1d.length; i += 7) { c.push(c1d[i]); t.push(t1d[i]); }
  return { c, t };
}

// 按需构建（带缓存：仅当 symbol/周期/根数/末根时间/关键参数变化才重算）
function maRelData() {
  if (!cfg.maRelOn) return null;
  const sym = cfg.symbol, tf = cfg.mainTF;
  const d = getTFData(sym, tf);
  const c = (d.c || []).map(Number);
  if (c.length < 30) return null;
  const key = [sym, tf, c.length, d.t && d.t.length ? d.t[d.t.length - 1] : 0,
    cfg.maRelType, cfg.maRelShowSlow ? 1 : 0, cfg.maRelShowDaily ? 1 : 0, cfg.maRelShowWeekly ? 1 : 0,
    cfg.maRelVwap ? 1 : 0, cfg.maRelSqueezePct, cfg.maRelDevAtr, cfg.maRelSwing, cfg.maRelCool,
    cfg.maRelAllowShort ? 1 : 0, cfg.maRelL3 ? 1 : 0].join('|');
  if (_maRelCache.key === key && _maRelCache.data) return _maRelCache.data;
  const d1 = getTFData(sym, '1d'), d4 = getTFData(sym, '4h');
  const wk = _weeklyFromDaily(d1.c || [], d1.t || []);
  const atr = atrClose(c, 14);
  let data = null;
  try {
    data = buildMaRelation({
      closes: c, highs: (d.h || []).map(Number), lows: (d.l || []).map(Number),
      opens: (d.o || []).map(Number), vols: (d.v || []).map(Number), atr, t: d.t || [],
      closes1d: (d1.c || []).map(Number), t1d: d1.t || [],
      closes4h: (d4.c || []).map(Number), t4h: d4.t || [],
      closes1w: wk.c, t1w: wk.t,
      opts: {
        type: cfg.maRelType, daily: cfg.maRelShowDaily ? MA_REL_DEFAULTS.daily : [],
        weekly: cfg.maRelShowWeekly ? MA_REL_DEFAULTS.weekly : [],
        squeezePct: cfg.maRelSqueezePct, devAtr: cfg.maRelDevAtr, swing: cfg.maRelSwing,
        cool: cfg.maRelCool, allowShort: cfg.maRelAllowShort, l3: cfg.maRelL3, vwap: cfg.maRelVwap,
      },
    });
  } catch (e) { data = null; }
  _maRelCache = { key, data };
  return data;
}
export function maRelInfo() { try { const d = maRelData(); return d ? d.info : null; } catch (e) { return null; } }

// 画在主图上（蜡烛之上、标记之下）：均线/VWAP/信号/防守线/信息表
function drawMaRelation(ctx) {
  const g = _mainGeom;
  const m = maRelData();
  if (!g || !m) return;
  const { lo, hi, start, n, xStep, c, t } = g;
  const X = (i) => PAD_L + (i - start) * xStep + xStep / 2;
  const Y = (v) => PAD_T + (hi - v) / (hi - lo) * MAIN_H;
  const inWin = (i) => i >= start && i < c.length;
  const line = (arr, st) => {
    if (!Array.isArray(arr)) return;
    ctx.save();
    ctx.beginPath(); ctx.rect(PAD_L, PAD_T, W - PAD_L - PAD_R, MAIN_H); ctx.clip();
    ctx.strokeStyle = st.c; ctx.lineWidth = st.w; ctx.setLineDash(st.dash || []);
    ctx.beginPath();
    let started = false;
    for (let i = Math.max(0, start); i < c.length; i++) {
      const v = arr[i];
      if (v == null || !Number.isFinite(v)) { started = false; continue; }
      const x = X(i), y = Y(v);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke(); ctx.setLineDash([]); ctx.restore();
  };
  // 均线与 VWAP
  line(m.ma.fast, MA_LINE.fast);
  line(m.ma.mid, MA_LINE.mid);
  if (cfg.maRelShowSlow) line(m.ma.slow, MA_LINE.slow);
  if (cfg.maRelShowDaily) { line(m.daily[20], MA_LINE.d20); line(m.daily[50], MA_LINE.d50); line(m.daily[200], MA_LINE.d200); }
  if (cfg.maRelShowWeekly) { line(m.weekly[20], MA_LINE.w20); line(m.weekly[200], MA_LINE.w200); }
  if (cfg.maRelVwap) line(m.vwap, MA_LINE.vwap);

  // 信号：箭头 + 失效叉 + 防守线 + 1R/2R
  // 信号：箭头 + 失效叉 + 防守线 + 1R/2R（只画窗口内、最多最近 24 个——理论要求「信号要克制」，避免箭头过密）
  const sigs = (m.signals || []).filter(s => inWin(s.i)).slice(-24);
  ctx.save();
  ctx.beginPath(); ctx.rect(PAD_L, PAD_T, W - PAD_L - PAD_R, MAIN_H); ctx.clip();
  for (const s of sigs) {
    const x = X(s.i), yb = Y(c[s.i]);
    const up = s.side === 'long';
    const col = s.invalidIdx != null ? '#8899aa' : (up ? '#2ecc71' : '#ff6b6b');
    const dir = up ? 1 : -1;
    // 箭头（距 K 线外侧 12px）
    const ay = yb + dir * 14;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(x, ay + dir * 6); ctx.lineTo(x - 5, ay - dir * 4); ctx.lineTo(x + 5, ay - dir * 4);
    ctx.closePath(); ctx.fill();
    ctx.font = '8px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(s.type, x, ay + dir * 16);
    // 防守线（从信号根到失效/最后一根）
    const iEnd = s.invalidIdx != null ? s.invalidIdx : c.length - 1;
    if (inWin(iEnd)) {
      ctx.strokeStyle = col; ctx.globalAlpha = .55; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x, Y(s.stop)); ctx.lineTo(X(Math.min(iEnd, c.length - 1)), Y(s.stop)); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
    }
    // 失效叉
    if (s.invalidIdx != null && inWin(s.invalidIdx)) {
      const xi = X(s.invalidIdx), yi = Y(c[s.invalidIdx]);
      ctx.strokeStyle = '#8899aa'; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(xi - 4, yi - 4); ctx.lineTo(xi + 4, yi + 4); ctx.moveTo(xi + 4, yi - 4); ctx.lineTo(xi - 4, yi + 4); ctx.stroke();
      ctx.lineWidth = 1;
    }
  }
  // 最近一个信号的 1R / 2R 参考线
  const last = sigs.length ? sigs[sigs.length - 1] : null;
  if (last && last.r > 0) {
    const iEnd = Math.min(last.invalidIdx != null ? last.invalidIdx : c.length - 1, c.length - 1);
    if (inWin(iEnd)) {
      const dir = last.side === 'long' ? 1 : -1;
      const x1 = X(last.i), x2 = X(iEnd);
      for (const k of [1, 2]) {
        const y = Y(last.entry + dir * last.r * k);
        ctx.strokeStyle = 'rgba(34,211,238,.5)'; ctx.setLineDash([2, 4]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x2, y); ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = '8px sans-serif'; ctx.textAlign = 'left';
        ctx.fillStyle = 'rgba(34,211,238,.8)';
        ctx.fillText(k + 'R', x2 + 3, y + 3);
      }
    }
  }
  ctx.restore();

  // 右上角信息表（状态 / 密集 / 乖离 / 距离%）
  if (cfg.maRelShowInfo) {
    const st = m.market || {};
    const stateCol = st.state === 'BULL' ? '#2ecc71' : st.state === 'BEAR' ? '#ff6b6b' : '#f59e0b';
    const f = (v) => (v == null || !Number.isFinite(v)) ? '--' : (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
    const rows = [
      { t: (st.state || 'RANGE') + ' · 日线 MA20 ' + (st.slopePct >= 0 ? '↑' : '↓') + Math.abs(st.slopePct || 0).toFixed(2) + '%', c: stateCol, b: true },
      { t: '距 本图MA20 ' + f(m.info.distFast) + ' · 日MA20 ' + f(m.info.distDaily20), c: '#c8d4e0' },
      { t: '距 周MA20 ' + f(m.info.distWeekly20) + ' · 周MA200 ' + f(m.info.distWeekly200), c: '#c8d4e0' },
      { t: (m.info.squeezed ? '● 均线密集（等突破）' : '○ 均线未密集') + (m.info.devAtr ? ' · ⚠ 远离均线勿追' : ''), c: m.info.squeezed ? '#ffd740' : 'rgba(160,175,190,.85)' },
    ];
    ctx.save();
    ctx.font = '9px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    let wMax = 0; for (const r of rows) wMax = Math.max(wMax, ctx.measureText(r.t).width);
    const bw = wMax + 14, bh = rows.length * 12 + 8;
    const bx = W - PAD_R - bw - 2, by = PAD_T + 2;
    ctx.fillStyle = 'rgba(16,22,30,.78)';
    ctx.fillRect(bx, by, bw, bh);
    ctx.strokeStyle = 'rgba(255,255,255,.14)'; ctx.strokeRect(bx, by, bw, bh);
    rows.forEach((r, k) => {
      ctx.font = (r.b ? 'bold ' : '') + '9px sans-serif';
      ctx.fillStyle = r.c;
      ctx.fillText(r.t, bx + 7, by + 15 + k * 12);
    });
    ctx.restore();
  }
}

// 标记清单（实时聚合；与 buildMarkList 的纯逻辑同源）
export function mainMarkList(sym) {
  const alphaLive = !!(typeof window !== 'undefined' && window.__alphaLab && window.__alphaLab.isLive && window.__alphaLab.isLive());
  return buildMarkList({
    sigOverlay: !!cfg.sigOverlay,
    srsiAutoOn: !!cfg.srsiAutoOn,
    alphaLive,
    opportunities: mainOpportunityMarks(sym || cfg.symbol),
    srsiTrades: (typeof window !== 'undefined' ? window.__srsiLiveTrades : null),
    alphaMarks: (typeof window !== 'undefined' ? window.__alphaLiveMarks : null),
  });
}

function _drawMarkShape(ctx, p) {
  const { x, y, r } = p;
  ctx.beginPath();
  if (p.shape === 'triUp') { ctx.moveTo(x, y - r); ctx.lineTo(x - r, y + r); ctx.lineTo(x + r, y + r); ctx.closePath(); ctx.fill(); }
  else if (p.shape === 'triDown') { ctx.moveTo(x, y + r); ctx.lineTo(x - r, y - r); ctx.lineTo(x + r, y - r); ctx.closePath(); ctx.fill(); }
  else if (p.shape === 'diamond') { ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); ctx.fill(); }
  else { ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }
}

function _fxReducedMotion() {
  try { return !!(typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; }
}

// 标记光晕层：只画光晕 + 形状微闪（不重画整张图）
function drawMarkFx(nowMs) {
  if (!_fx || !_fx.ctx || !_cv) return;
  const ctx = _fx.ctx;
  const Hlog = _cv.__logicalH || BASE_H;
  ctx.clearRect(0, 0, W, Hlog);
  if (!cfg.sigOverlay) return;
  const g = _mainGeom;
  if (!g || g.sym !== cfg.symbol) return;
  const marks = mainMarkList(cfg.symbol);
  if (!marks.length) return;
  const a = _fxReducedMotion() ? 0.45 : pulseAlpha(nowMs);
  for (const mk of marks) {
    const p = markFxXY(g, mk);
    if (!p) continue;
    // 微光晕：径向渐变（越靠中心越亮）
    const R = 11;
    const grd = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, R);
    grd.addColorStop(0, withAlpha(p.color, 0.55 * a));
    grd.addColorStop(0.55, withAlpha(p.color, 0.2 * a));
    grd.addColorStop(1, withAlpha(p.color, 0));
    ctx.fillStyle = grd;
    ctx.beginPath(); ctx.arc(p.x, p.y, R, 0, Math.PI * 2); ctx.fill();
    // 形状微闪（叠在主 canvas 同位置之上）
    ctx.globalAlpha = a;
    ctx.fillStyle = p.color;
    _drawMarkShape(ctx, p);
    ctx.globalAlpha = 1;
  }
}

// 与主 canvas 像素级对齐的覆盖层（尺寸/位置/transform 全部跟随 _cv）
function ensureMarkFx() {
  if (typeof document === 'undefined' || !_cv) return null;
  const box = _cv.parentElement;
  if (!box || typeof box.appendChild !== 'function') return null;
  if (!_fx || !_fx.cv || !_fx.cv.isConnected) {
    let cv = document.getElementById('kchartMarkFx');
    if (!cv) {
      cv = document.createElement('canvas');
      cv.id = 'kchartMarkFx';
      box.appendChild(cv);
    }
    cv.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;z-index:4';
    _fx = { cv, ctx: cv.getContext('2d'), raf: null, last: 0 };
  }
  const cv = _fx.cv;
  cv.style.left = (_cv.offsetLeft || 0) + 'px';
  cv.style.top = (_cv.offsetTop || 0) + 'px';
  cv.style.width = (_cv.offsetWidth || 0) + 'px';
  cv.style.height = (_cv.offsetHeight || 0) + 'px';
  if (cv.width !== _cv.width || cv.height !== _cv.height) {
    cv.width = _cv.width; cv.height = _cv.height;
    _fx.ctx = cv.getContext('2d');
    const Hlog = _cv.__logicalH || BASE_H;
    _fx.ctx.setTransform(_cv.width / W, 0, 0, _cv.height / Hlog, 0, 0);
  }
  return _fx;
}

function _fxStep(ts) {
  if (!_fx) return;
  _fx.raf = null;
  try {
    if (typeof document === 'undefined' || !document.hidden) {
      if (ts - (_fx.last || 0) >= 50) { _fx.last = ts; drawMarkFx(ts); }   // ~20fps 足够“微闪”，且极轻
    }
  } catch (e) { /* 光晕非关键路径 */ }
  if (_fx && typeof requestAnimationFrame === 'function') _fx.raf = requestAnimationFrame(_fxStep);
}

function startMarkFx() {
  if (!_fx || _fx.raf != null || typeof requestAnimationFrame !== 'function') return;
  _fx.raf = requestAnimationFrame(_fxStep);
}

function stopMarkFx() {
  if (_fx && _fx.raf != null && typeof cancelAnimationFrame === 'function') { try { cancelAnimationFrame(_fx.raf); } catch (e) {} }
  if (_fx) { _fx.raf = null; if (_fx.ctx && _cv) _fx.ctx.clearRect(0, 0, W, _cv.__logicalH || BASE_H); }
}

// 每帧渲染末尾调用：有标记→建层+启动 RAF；无标记→停并清空
function syncMarkFx() {
  let has = false;
  try { has = !!cfg.sigOverlay && mainMarkList(cfg.symbol).length > 0; } catch (e) { has = false; }
  if (!has) { stopMarkFx(); return; }
  if (!ensureMarkFx()) return;
  startMarkFx();
  try { drawMarkFx(_fxReducedMotion() ? 0 : (globalThis.performance && performance.now ? performance.now() : Date.now())); } catch (e) {}
}

// ---------- 行动卡 DOM 浮层（可拖动；默认位置=原 canvas 位置）----------
function _actionCardDefaultPos(box) {
  const Hlog = (_cv && _cv.__logicalH) || BASE_H;
  const sx = (_cv && _cv.offsetWidth ? _cv.offsetWidth / W : 1);
  const sy = (_cv && _cv.offsetHeight ? _cv.offsetHeight / Hlog : 1);
  return { x: (_cv ? _cv.offsetLeft : 0) + (PAD_L + 6) * sx, y: (_cv ? _cv.offsetTop : 0) + ((PAD_T + MAIN_H) / 2 - 40) * sy };
}

function _placeActionCard(el, box) {
  if (!el || !box) return;
  if (_acDragging) return;
  const bw = box.clientWidth, bh = box.clientHeight;
  // 布局未就绪（首帧/隐藏 tab）时容器宽度会远小于卡片 → 此时不定位，等下次渲染（每秒 tick 会重试）
  if (!bw || !bh || bw < el.offsetWidth + 8 || bh < el.offsetHeight + 8) return;
  const def = _actionCardDefaultPos(box);
  const pos = cfg.actionCardPos && typeof cfg.actionCardPos.x === 'number' && typeof cfg.actionCardPos.y === 'number'
    ? { x: cfg.actionCardPos.x, y: cfg.actionCardPos.y } : def;
  const p = clampBoxPos(pos.x, pos.y, el.offsetWidth, el.offsetHeight, bw, bh);
  el.style.left = p.x + 'px';
  el.style.top = p.y + 'px';
}

function bindActionCardDrag(el, box) {
  let drag = null;
  el.addEventListener('pointerdown', (e) => {
    drag = { dx: e.clientX - el.offsetLeft, dy: e.clientY - el.offsetTop };
    _acDragging = true;
    try { el.setPointerCapture(e.pointerId); } catch (err) {}
    el.classList.add('dragging');
    try { e.preventDefault(); } catch (err) {}
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = clampBoxPos(e.clientX - drag.dx, e.clientY - drag.dy, el.offsetWidth, el.offsetHeight, box.clientWidth, box.clientHeight);
    el.style.left = p.x + 'px';
    el.style.top = p.y + 'px';
  });
  const end = (e) => {
    if (!drag) return;
    drag = null;
    _acDragging = false;
    el.classList.remove('dragging');
    try { el.releasePointerCapture(e.pointerId); } catch (err) {}
    cfg.actionCardPos = { x: el.offsetLeft, y: el.offsetTop };
    try { persist(); } catch (err) {}
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  // 双击复位到默认位置（改回 canvas 原位）
  el.addEventListener('dblclick', () => { cfg.actionCardPos = null; try { persist(); } catch (err) {} _placeActionCard(el, box); });
}

// 行动卡 DOM 渲染（签名守卫；内容与 canvas 回退共用 actionCardView）
function renderActionCardDom() {
  if (typeof document === 'undefined' || !_cv) return;
  const box = _cv.parentElement;
  if (!box || typeof box.appendChild !== 'function') return;
  const ac = (typeof window !== 'undefined') ? window.__actionCard : null;
  if (!cfg.sigOverlay || !ac) { if (_acEl) _acEl.style.display = 'none'; return; }
  if (!_acEl || !_acEl.isConnected) {
    let el = document.getElementById('kchartActionCard');
    if (!el) {
      el = document.createElement('div');
      el.id = 'kchartActionCard';
      el.className = 'kchart-acard';
      el.title = '拖动可移动 · 双击复位（数据与主图行动卡一致）';
      box.appendChild(el);
      bindActionCardDrag(el, box);
    } else if (!el.classList || !el.classList.contains('kchart-acard')) {
      el.className = 'kchart-acard';
    }
    _acEl = el;
  }
  const el = _acEl;
  const v = actionCardView(cfg.symbol, ac);
  const sig = JSON.stringify(v);
  if (el.__sig !== sig) {
    el.__sig = sig;
    el.style.borderColor = v.color;
    el.innerHTML = actionCardHtml(v);
  }
  el.style.display = '';
  _placeActionCard(el, box);
}

export function renderKChart() {
  syncCanvasSize();
  renderQuickTrade();
  try { updateSrsiProjLive(); } catch (e) {}
  loadTsevWeights(); // 后台拉取并训练 TSEV 权重（dev 可用；失败则回落经典逻辑）
  if (!_ctx) return;
  const S = window.S;
  const sym = cfg.symbol;
  const ctx = _ctx;
  const H = _cv.__logicalH || BASE_H;
  let bg = '#0a0e17';
  try { bg = getComputedStyle(document.body).backgroundColor || '#0a0e17'; } catch (e) {}
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // 主图周期
  const tf = cfg.mainTF;
  const mainOk = drawMain(ctx, sym, tf, H);
  if (!mainOk) { drawEmpty(ctx, H, '等待 K 线数据（' + tf + '）...'); return; }
  // v1.6.30：价格-均线关系盯盘辅助层（画在蜡烛之上、标记之下）
  try { if (cfg.maRelOn) drawMaRelation(ctx); } catch (e) {}

  // 子图
  const subList = buildSubList();
  let y0 = PAD_T + MAIN_H + STATUS_H + 2; // GOAL21：子图下移，让出主图底部状态带
  const regs = [];
  subList.forEach((sub, idx) => {
    const y1 = y0 + SUB_H;
    drawSub(ctx, sub, sym, y0);
    regs.push({ key: sub.key, tf: sub.tf, y0, y1, idx });
    // 标题栏（可拖拽）
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(PAD_L + 2, y0 + 2, PAD_L, SUB_GAP - 6);
    if (_drag && _suppressClick && _drag.fromIdx === idx) {
      ctx.strokeStyle = 'rgba(0,230,118,0.9)';
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(PAD_L, y0, W - PAD_L - PAD_R, SUB_H);
      ctx.setLineDash([]);
    }
    y0 = y1 + SUB_GAP;
  });
  _subRegions = regs;

  // 拖拽指示线
  if (_drag && _drag.moved && _drag.curY != null) {
    ctx.strokeStyle = 'rgba(0,230,118,0.8)';
    ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(PAD_L, _drag.curY); ctx.lineTo(W - PAD_R, _drag.curY); ctx.stroke();
    ctx.setLineDash([]);
  }

  if (_hover) drawHover(ctx, subList, H);
  // 方向基准死区状态推进（renderSrsiOverview / renderTradeDiscipline 共用同一 deadZone）
  // 方向基准固定 ≤4h（THRESH.HORIZON_CAP_MIN=240）。7d/30d 永远只做宏观冲突扣分，
  // 不因主周期(mainTF)上探而改为更长周期——避免"主周期=1d"时方向基准跳到日线级、
  // 与 AGENTS.md 5.28「方向基准≤4h、7d/30d归宏观带」口径不一致。
  const capMin = THRESH.HORIZON_CAP_MIN;
  const allPriceMap = {};
  KLINE_TF.forEach(tf => { const d = getTFData(sym, tf); if (d.c && d.c.length) allPriceMap[tf] = d.c; });
  const hz = updateHorizonState(sym, allPriceMap, capMin);
  renderSrsiOverview(hz, capMin);
  renderTradeDiscipline(hz, capMin);
  updateRuleMonitorTick(); // 规则监测：影子计算 + 信号簿边沿检测（内2s节流）+ 面板渲染（签名守卫）
  try { renderDiscHud(); } catch (e) {} // v1.5.52：HUD 悬浮卡（动力卡 + 规则监测）
  renderMainTools(); // 同步主图叠加药丸的 K/D 背景色（受签名守卫保护，无变化不重建）
  renderPwaLegend(); // v1.6.25：PWA 卡头图例（动态补全，不再硬编码）
  try { syncMarkFx(); } catch (e) {} // v1.6.23：标记微光晕/微闪覆盖层（有标记才启动 RAF；无标记自动停）
}

// 轻量面板实时刷新：仅重算「方向基准死区 + 速览 + 纪律分析」DOM，不重绘画布。
// 供主系统 / PWA 的周期 tick 调用（renderKChart 每帧都重绘画布较贵，此处只刷面板）。
export function refreshPanels() {
  // v1.6.23：行动卡浮层每秒重定位（首帧布局未就绪时会跳过，靠这里收敛；也随窗口尺寸变化自动修正）
  try { if (_acEl && _acEl.isConnected && _cv && _cv.parentElement) _placeActionCard(_acEl, _cv.parentElement); } catch (e) {}
  const box = document.getElementById('kchartDisc');
  const ov = document.getElementById('kchartOverview');
  if (!box && !ov) return;
  const S = window.S;
  if (!S || !cfg.symbol) return;
  const capMin = THRESH.HORIZON_CAP_MIN;
  const allPriceMap = {};
  KLINE_TF.forEach(tf => { const d = getTFData(cfg.symbol, tf); if (d.c && d.c.length) allPriceMap[tf] = d.c; });
  const hz = updateHorizonState(cfg.symbol, allPriceMap, capMin);
  if (ov) renderSrsiOverview(hz, capMin);
  if (box) renderTradeDiscipline(hz, capMin);
  updateRuleMonitorTick(); // 规则监测：主系统/PWA 每秒 tick 走这里（renderKChart 不每秒重绘）
  try { renderDiscHud(); } catch (e) {} // v1.5.52：HUD 悬浮卡
}

function getTFData(sym, tf) {
  const S = globalThis.S || (typeof window !== 'undefined' ? window.S : undefined) || {};
  const o = (S.klinesO && S.klinesO[sym] && S.klinesO[sym][tf]) || [];
  const h = (S.klinesH && S.klinesH[sym] && S.klinesH[sym][tf]) || [];
  const l = (S.klinesL && S.klinesL[sym] && S.klinesL[sym][tf]) || [];
  const c = (S.klines && S.klines[sym] && S.klines[sym][tf]) || [];
  const v = (S.klinesV && S.klinesV[sym] && S.klinesV[sym][tf]) || [];
  const t = (S.klinesT && S.klinesT[sym] && S.klinesT[sym][tf]) || [];
  return { o, h, l, c, v, t };
}

// 主图专用：7d/30d 在存储层是同一份日线数组（timeframe.js 注释说明日线分辨率才能做时长感知），
// SRSI 速览/纪律分析各自 resample 成周/月。主图若直接画就是和 1d 相同的日线蜡烛。
// 此函数仅在「主图显示」路径调用，把日线按 7/30 根聚合为真正的周/月蜡烛（OHLC+量+末根时间戳），
// 不动 getTFData（SRSI 速览、纪律分析、方向判定仍用原始日线，避免双重聚合）。
export function aggTFData(sym, tf) {
  const base = getTFData(sym, tf);
  if (tf !== '7d' && tf !== '30d') return base;
  const step = tf === '7d' ? 7 : 30;
  const n = base.c.length;
  if (n < step) return base;
  const { o, h, l, c, v, t } = base;
  const O = [], H = [], L = [], C = [], V = [], T = [];
  for (let i = 0; i < n; i += step) {
    const e = Math.min(i + step, n);
    O.push(o[i]);
    let hi = -Infinity, lo = Infinity, vol = 0;
    for (let j = i; j < e; j++) {
      if (h[j] > hi) hi = h[j];
      if (l[j] < lo) lo = l[j];
      vol += (v[j] || 0);
    }
    H.push(hi); L.push(lo); C.push(c[e - 1]); V.push(vol); T.push(t[e - 1]);
  }
  return { o: O, h: H, l: L, c: C, v: V, t: T };
}

// 主图专用：7d/30d 优先用原生周/月线（Binance 1w/1M 直拉，根数充足且对齐交易所），
// 避免日线聚合导致根数过少（500 日线→仅 71 周 / 16 月）。SRSI 速览/纪律分析仍走 getTFData 原始日线（aggTFData），
// 故此处与 aggTFData 分离：主图用原生，子图价格线/悬浮仍用 aggTFData 以保持与子图 SRSI 对齐。
export function nativeMain(sym, tf) {
  const S = globalThis.S || (typeof window !== 'undefined' ? window.S : undefined) || {};
  if (tf === '7d' && S.klinesWeek && S.klinesWeek[sym]) return S.klinesWeek[sym];
  if (tf === '30d' && S.klinesMonth && S.klinesMonth[sym]) return S.klinesMonth[sym];
  return aggTFData(sym, tf);
}


// 全部 KLINE_TF 的收盘序列 map（方向基准/宏观带用，不受勾选影响）
function allPriceMapOf(sym) {
  const m = {};
  KLINE_TF.forEach(tf => { const c = getTFData(sym, tf).c; if (c && c.length) m[tf] = c; });
  return m;
}

// 主图叠加周期列表：优先按周期独立的 overlayTfs；为空时回退到 klineSel（兼容迁移期旧配置）
function overlayTfsList(c) {
  if (c && c.overlayTfs && Object.keys(c.overlayTfs).length) {
    return KLINE_TF.filter(tf => c.overlayTfs[tf]);
  }
  if (c && c.mainOverlay && c.klineSel) {
    return KLINE_TF.filter(tf => c.klineSel[tf]);
  }
  return [];
}

// 主图蜡烛上要叠加 SRSI 的周期计划：主图叠加(overlayTfs) ∪ 辅助(srsiAux)，去重并标 aux。
function mainChartSrsiPlan(c) {
  const plan = [];
  overlayTfsList(c).forEach(tf => plan.push({ tf, aux: false }));
  KLINE_TF.forEach(tf => {
    if (c.srsiAux && c.srsiAux[tf]) {
      const ex = plan.find(p => p.tf === tf);
      if (ex) ex.aux = true; else plan.push({ tf, aux: true });
    }
  });
  return plan;
}

// 主图顶部快选 chip 栏：参与显隐快选的周期集合（overlay/aux 之外的持久记忆，按 KLINE_TF 顺序）
// 兜底：一个都没有时也垫 mainTF（未开态），保证主图永远有一排可点的开关
function keepInOvQuick(tf) {
  cfg.ovQuickTfs = cfg.ovQuickTfs || [];
  if (!cfg.ovQuickTfs.includes(tf)) cfg.ovQuickTfs.push(tf);
}
// 主图快选 chip 栏：参与显隐快选的周期集合（overlay ∪ aux ∪ 兜底 mainTF），返回每颗的状态（on/hidden/aux）
function ovQuickChips(c) {
  const quick = (c.ovQuickTfs || []).slice();
  Object.keys(c.overlayTfs || {}).forEach(tf => { if (!quick.includes(tf)) quick.push(tf); });
  Object.keys(c.srsiAux || {}).forEach(tf => { if (!quick.includes(tf)) quick.push(tf); });
  if (!quick.length && c.mainTF && KLINE_TF.includes(c.mainTF)) quick.push(c.mainTF);
  return KLINE_TF.filter(tf => quick.includes(tf)).map(tf => {
    const overlay = !!(c.overlayTfs && c.overlayTfs[tf]);
    const aux = !!(c.srsiAux && c.srsiAux[tf]);
    const hidden = !!(c.ovHide && c.ovHide[tf]);
    return { tf, overlay, aux, hidden, on: (overlay || aux) && !hidden };
  });
}
// 点击 chip 切换该周期显示（角色保持式）：激活项→记原角色并临时隐藏（仍在栏内置灰）；
// 隐藏项→还原原角色（辅助仍是辅助、叠加仍是叠加）；皆无激活→加入叠加。
function toggleOvQuickTf(tf) {
  if (!KLINE_TF.includes(tf)) return;
  cfg.overlayTfs = cfg.overlayTfs || {};
  cfg.srsiAux = cfg.srsiAux || {};
  cfg.ovHide = cfg.ovHide || {};
  // 仅切换「主图 SRSI 线条」显隐，绝不改动叠加/闸门(辅助)角色：
  // 已显示→隐藏(ovHide=true)；已隐藏→恢复；从未显示→以「主图叠加」角色加入。
  const drawn = (cfg.overlayTfs[tf] || cfg.srsiAux[tf]) && !cfg.ovHide[tf];
  if (drawn) {
    cfg.ovHide[tf] = true;
  } else if (cfg.ovHide[tf]) {
    delete cfg.ovHide[tf];
  } else {
    cfg.overlayTfs[tf] = true;
  }
  keepInOvQuick(tf);
  cfg.mainOverlay = Object.keys(cfg.overlayTfs).length > 0;
  persist(); renderKChart();
  if (typeof document !== 'undefined') renderControls();
}

// 纪律面板签名守卫：含 per-TF 全部 SRSI 参数(byTf) 与 辅助标记(aux)，使改任意参数/切辅助都即时重算
function buildDiscSig(cfg, priceMap, deadMode, deadZone, loopStatus) {
  let sig = cfg.symbol + '|' + cfg.mainTF + '|' + cfg.bars
    + '|byTf:' + JSON.stringify(cfg.srsiByTf || {}) + '|aux:' + JSON.stringify(cfg.srsiAux || {}) + '|';
  KLINE_TF.forEach(tf => {
    const c = (priceMap && priceMap[tf]) || [];
    sig += tf + ':' + (c.length ? c[c.length - 1] : 0) + ';';
  });
  sig += '|dz:' + (deadMode || 'fixed') + ':' + ((deadZone != null) ? deadZone.toFixed(3) : '');
  if (loopStatus) {
    const progSym = (loopStatus.backfilling && loopStatus.progress) ? loopStatus.progress.sym : null;
    const progDone = (progSym && loopStatus.perSym && loopStatus.perSym[progSym]) ? loopStatus.perSym[progSym].done : 0;
    sig += '|loop:' + loopStatus.sampleCount + ':' + loopStatus.factorCount + ':' + (loopStatus.backfilling ? (progSym + ':' + progDone) : 'idle');
  }
  return sig;
}

// ---- 主图蜡烛 ----
function roundRectPath(ctx, x, y, w, h, r) {
  r = Math.min(r, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function drawMain(ctx, sym, tf, H) {
  const S = window.S;
  const { o, h, l, c, t } = nativeMain(sym, tf);
  const bars = cfg.bars;
  const n = Math.min(bars, c.length);
  if (n < 2) return false;
  const start = c.length - n;
  const plotW = W - PAD_L - PAD_R;
  const mainBottom = PAD_T + MAIN_H;
  const xStep = plotW / n;
  const cw = Math.max(1, xStep * 0.72);

  let lo = Infinity, hi = -Infinity;
  for (let i = start; i < c.length; i++) {
    if (l[i] != null && isFinite(l[i]) && l[i] < lo) lo = l[i];
    if (h[i] != null && isFinite(h[i]) && h[i] > hi) hi = h[i];
  }
  if (!isFinite(lo) || !isFinite(hi) || hi <= lo) { lo = c[c.length - 1] * 0.999; hi = c[c.length - 1] * 1.001; }
  const pad = (hi - lo) * 0.08 || hi * 0.001;
  lo -= pad; hi += pad;
  const Y = (v) => PAD_T + (hi - v) / (hi - lo) * MAIN_H;
  const X = (i) => PAD_L + (i - start) * xStep + xStep / 2;
  // v1.6.29：缓存主图几何 → 供标记光晕覆盖层（markFxXY）像素级对齐；含 h/l 供标记按高低点锚定
  _mainGeom = { sym, tf, lo, hi, start, n, xStep, c, h, l, t };

  // 网格
  drawGrid(ctx, PAD_L, PAD_T, plotW, MAIN_H, 5, (p) => { const v = hi - (p / 100) * (hi - lo); return fmt(v); });

  ctx.save();
  ctx.beginPath(); ctx.rect(PAD_L, PAD_T, plotW, MAIN_H); ctx.clip();
  for (let i = start; i < c.length; i++) {
    const x = X(i), oo = o[i], hh = h[i], ll = l[i], cc = c[i];
    if (cc == null) continue;
    const up = cc >= (oo != null ? oo : cc);
    const col = up ? '#00E676' : '#FF5252';
    const x0 = x - cw / 2;
    if (hh != null && ll != null) {
      ctx.strokeStyle = col; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, Y(hh)); ctx.lineTo(x, Y(ll)); ctx.stroke();
    }
    const yO = Y(oo != null ? oo : cc), yC = Y(cc);
    ctx.fillStyle = col;
    const yTop = Math.min(yO, yC), yBot = Math.max(yO, yC);
    ctx.fillRect(x0, yTop, cw, Math.max(1, yBot - yTop));
  }
  // 最新价虚线
  const last = c[c.length - 1];
  ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.setLineDash([4, 4]);
  const ly = Y(last);
  ctx.beginPath(); ctx.moveTo(PAD_L, ly); ctx.lineTo(W - PAD_R, ly); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#fff'; ctx.font = 'bold 11px monospace';
  ctx.fillText(fmt(last), PAD_L + plotW - 70, Math.max(PAD_T + 8, ly - 3));
  ctx.restore();

  // 主图 SRSI 多周期叠加：仅叠加 overlayTfs 中勾选的周期（按周期独立，不再跟随全量 klineSel）；临时隐藏的跳过
  const srsiPlan = mainChartSrsiPlan(cfg).filter(dp => !(cfg.ovHide && cfg.ovHide[dp.tf]));
  const baseT = (t && t.length >= c.length) ? t.slice(start, c.length) : null;
  if (srsiPlan.length) {
    ctx.save();
    ctx.beginPath(); ctx.rect(PAD_L, PAD_T, plotW, MAIN_H); ctx.clip();
    const Y0 = (v) => PAD_T + (100 - (v != null ? v : 50)) / 100 * MAIN_H;
    // 50 中线（极淡，作为唯一通用参考）
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.setLineDash([2, 3]);
    const yMid = Y0(50); ctx.beginPath(); ctx.moveTo(PAD_L, yMid); ctx.lineTo(W - PAD_R, yMid); ctx.stroke();
    ctx.setLineDash([]);
    // 每周期自定义上/下限带（超买/超卖）
    srsiPlan.forEach(dp => {
      const pc = getTFData(sym, dp.tf).c;
      if (!pc || pc.length < 2) return;
      const cfg2 = perTfSrsi(dp.tf, cfg.srsiByTf, cfg.srsi);
      const col = dp.aux ? '#4dabf7' : tfColor(dp.tf);
      [cfg2.overbought, cfg2.oversold].forEach(v => {
        if (v == null || !isFinite(v)) return;
        const y = Y0(v); ctx.strokeStyle = col; ctx.globalAlpha = 0.35; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(PAD_L, y); ctx.lineTo(W - PAD_R, y); ctx.stroke();
      });
      ctx.globalAlpha = 1; ctx.setLineDash([]);
    });

    // SRSI 0-100 副轴参考刻度（右侧淡色，统一读数基准；不替代各周期彩色 over/under 带）
    const axisVals = [0, 25, 50, 75, 100];
    ctx.textBaseline = 'middle'; ctx.font = '9px monospace'; ctx.textAlign = 'right';
    axisVals.forEach(v => {
      const y = Math.max(PAD_T + 6, Math.min(PAD_T + MAIN_H - 6, Y0(v))); // GOAL22：刻度文字钳制在主图区内（顶部100/底部0 原被画布边裁一半）
      if (v !== 50) {
        ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.setLineDash([1, 4]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(PAD_L, y); ctx.lineTo(W - PAD_R, y); ctx.stroke(); ctx.setLineDash([]);
      }
      ctx.fillStyle = v === 50 ? '#8b95a5' : '#5a6675';
      ctx.fillText(String(v), W - PAD_R - 3, y);
    });
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';

    // K/D 叠加线（按主图时间轴对齐；时间数据缺失时回退索引切片）
    srsiPlan.forEach(dp => {
      const pc = getTFData(sym, dp.tf).c;
      if (!pc || pc.length < 2) return;
      const tfT = getTFData(sym, dp.tf).t;
      const cfg2 = perTfSrsi(dp.tf, cfg.srsiByTf, cfg.srsi);
      const col = dp.aux ? '#4dabf7' : tfColor(dp.tf);
      let kArr, dArr, useAlign = false;
      if (baseT && tfT && tfT.length >= pc.length) {
        const al = alignedSrsiOverlay(pc, tfT, baseT, cfg2);
        if (al.k.length === baseT.length) { kArr = al.k; dArr = al.d; useAlign = true; }
      }
      if (useAlign) {
        const drawAlign = (arr, dash, w) => {
          ctx.strokeStyle = col; ctx.lineWidth = w; ctx.setLineDash(dash || []);
          ctx.beginPath(); let started = false;
          for (let vi = 0; vi < baseT.length; vi++) {
            const v = arr[vi]; if (v == null || !isFinite(v)) { started = false; continue; }
            const x = X(start + vi), y = Y0(v);
            if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
          }
          ctx.stroke();
        };
        drawAlign(kArr, dp.aux ? [1, 2] : [], dp.tf === cfg.mainTF ? 1.6 : 1);
        drawAlign(dArr, dp.aux ? [2, 3] : [4, 3], dp.tf === cfg.mainTF ? 1.4 : 0.9);
      } else {
        const sl = srsiPanelSeries(pc, cfg2, bars);
        const off = Math.max(0, pc.length - Math.min(bars, pc.length));
        const drawSlice = (arr, dash, w) => {
          ctx.strokeStyle = col; ctx.lineWidth = w; ctx.setLineDash(dash || []);
          ctx.beginPath(); let started = false;
          for (let i = start; i < c.length; i++) {
            const li = i - off; if (li < 0 || li >= arr.length) continue;
            const v = arr[li]; if (v == null || !isFinite(v)) { started = false; continue; }
            const x = X(i), y = Y0(v);
            if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
          }
          ctx.stroke();
        };
        drawSlice(sl.k, dp.aux ? [1, 2] : [], dp.tf === cfg.mainTF ? 1.6 : 1);
        drawSlice(sl.d, dp.aux ? [2, 3] : [4, 3], dp.tf === cfg.mainTF ? 1.4 : 0.9);
      }
    });
    ctx.setLineDash([]); ctx.globalAlpha = 1;
    ctx.restore();
  }

  // Alpha 信号翻转标记（GOAL6，cfg.alphaSignalOn 默认关=零绘制）：
  // 数据由 PWA alphaLab 用与回测/paper 同源的 runBacktest 逐根权重 ws 重放得到（无前视，i+1 开盘可成交）；
  // 主系统无 window.__alphaSignals 时完全不进入此分支。
  if (cfg.alphaSignalOn && typeof window !== 'undefined' && window.__alphaSignals) {
    const A = window.__alphaSignals;
    if (A.sym === sym && A.tf === tf && A.ts && A.ts.length === t.length && c.length === t.length) {
      ctx.save();
      const vEnd = start + n;
      for (const f of A.flips) {
        const i = f.i;
        if (!Number.isInteger(i) || i < start || i >= vEnd || i >= c.length) continue;
        const x = X(i), y = Y(c[i]);
        ctx.fillStyle = f.dir > 0 ? '#2ecc71' : '#ff6b6b';
        ctx.beginPath();
        if (f.dir > 0) { ctx.moveTo(x, y + 7); ctx.lineTo(x - 5, y + 15); ctx.lineTo(x + 5, y + 15); }
        else { ctx.moveTo(x, y - 7); ctx.lineTo(x - 5, y - 15); ctx.lineTo(x + 5, y - 15); }
        ctx.closePath(); ctx.fill();
      }
      const lw = Number.isFinite(A.lastW) ? A.lastW : 0;
      ctx.font = 'bold 11px sans-serif';
      ctx.fillStyle = lw > 0.02 ? '#2ecc71' : lw < -0.02 ? '#ff6b6b' : '#8899aa';
      ctx.textAlign = 'right';
      // 更新透明化：信号随 K 线刷新周期重算（默认 60s），显示数据年龄避免误以为逐 tick 实时
      const ageS = Math.max(0, Math.round((Date.now() - (A.updatedT || 0)) / 1000));
      const ageTxt = ageS < 60 ? ageS + 's前' : Math.round(ageS / 60) + 'm前';
      ctx.fillText(`α ${lw > 0.02 ? '多' : lw < -0.02 ? '空' : '平'} ${Math.abs(lw * 100).toFixed(0)}% · ${ageTxt}`, W - PAD_R - 4, PAD_T + MAIN_H + 15); // GOAL21：移主图底部状态带右（原右上压 SRSI 上限带）
      ctx.textAlign = 'left';
      ctx.restore();
    }
  }

  // GOAL13：主图实盘信号层（总开关 cfg.sigOverlay，叠加栏「实盘信号」chip）——策略勾选即映射：
  //   SRSI自动开启 → SRSI 信号（▲绿开多/▼红开空 + 灰点平仓）
  //   Alpha基石实盘(live) → Alpha 信号（◆青多/◆橙空 实心菱形 + 空心菱形平仓）
  //   应用回测参数 → 组合角标文字
  // 数据源 = 真实成交动作（placeOrder/exitPosition/alphaLive 调仓），信号与交易一一对应
  const _alphaLiveOn = typeof window !== 'undefined' && window.__alphaLab && window.__alphaLab.isLive && window.__alphaLab.isLive();
  const _showSrsi = cfg.sigOverlay && cfg.srsiAutoOn;   // 勾 SRSI 自动 → 显示 SRSI 信号
  const _showAlpha = cfg.sigOverlay && _alphaLiveOn;    // 勾 Alpha 基石实盘 → 显示 Alpha 信号
  // GOAL21：主图底部状态带（分隔线 + 左右角标区背景，SRSI 0 线下方的专用信息条）
  if (typeof window !== 'undefined') {
    ctx.save();
    ctx.strokeStyle = 'rgba(139,155,180,.25)'; ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(PAD_L, PAD_T + MAIN_H + 2); ctx.lineTo(W - PAD_R, PAD_T + MAIN_H + 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }
  // GOAL16：主图盯盘信号卡（manualSignal：Alpha方向+SRSI带时机+ATR止损止盈，明确三元组）
  if (cfg.sigOverlay && typeof window !== 'undefined') {
    try {
      const sym16 = typeof sym !== 'undefined' ? sym : cfg.sym;
      // GOAL19：srsi 配置防御（老 localStorage 可能缺字段）——逐项深合并默认
      const _raw15 = (cfg.srsiByTf && cfg.srsiByTf['15m']) || cfg.srsi || {};
      const srsi15cfg = { rsiPeriod: _raw15.r || _raw15.rsiPeriod || 14, stochPeriod: _raw15.s || _raw15.stochPeriod || 9, smoothK: _raw15.k != null ? _raw15.k : 2, smoothD: _raw15.d != null ? _raw15.d : 3 };
      const c15 = (getTFData(sym16, '15m') || {}).c || [];
      let k15 = null, d15 = null, prevK15 = null, atr15 = null;
      if (c15.length > 40) {
        const { k: kArr, d: dArr } = srsiKD(c15, srsi15cfg);
        const n = kArr.length;
        k15 = kArr[n - 1]; d15 = dArr[n - 1]; prevK15 = n > 1 ? kArr[n - 2] : null;
        atr15 = atrClose(c15, 14);
      }
      const aw16 = Number.isFinite(window.__alphaLiveW) ? window.__alphaLiveW : 0;
      const alphaDir = aw16 > 0.02 ? 'long' : aw16 < -0.02 ? 'short' : (window.__alphaLab && window.__alphaLab.state && window.__alphaLab.state.dir) || null;
      const pm16 = (typeof series !== 'undefined' && series && series.ema20 != null) ? { emaFast: series.ema20, emaSlow: series.ema120 } : { emaFast: null, emaSlow: null };
      window.__manualSignal = manualSignal({ alphaDir, k15, d15, prevK15, price: c[c.length - 1], atr: Array.isArray(atr15) ? (atr15[atr15.length - 1] || null) : atr15, emaFast: pm16.emaFast, emaSlow: pm16.emaSlow });
      // GOAL28：行动卡数据（带界用 resolveEntryBands 的实际带，含用户自定义带；α权重 aw16 供显示）
      const _eb28 = resolveEntryBands(cfg);
      // v1.6.18：基石信号数据日（已收盘日线）+ 日内趋势（1h 优先、回退 15m）→ 行动卡标注 / 逆势警告
      const _asig28 = (typeof window !== 'undefined' && window.__alphaSignalsBySym && window.__alphaSignalsBySym[sym16]) || (typeof window !== 'undefined' ? window.__alphaSignals : null) || null;
      const _d1h28 = klineDirOf(sym16, '1h');
      const _intradayDir = _d1h28 || klineDirOf(sym16, '15m');
      const _intradayTf = _d1h28 ? '1h' : '15m';
      window.__actionCard = actionCardData({ alphaDir, alphaW: aw16, k15, d15, prevK15, price: c[c.length - 1], atr: Array.isArray(atr15) ? (atr15[atr15.length - 1] || null) : atr15, upper: _eb28.upper, lower: _eb28.lower, alphaDataT: _asig28 && _asig28.d1T, intradayDir: _intradayDir, intradayTf: _intradayTf });
      window.__manualSigErr = null;
    } catch (e) { window.__manualSigErr = String(e && e.message || e).slice(0, 80); if (!window.__manualSigWarned) { window.__manualSigWarned = 1; console.log('[SIG-CARD] 计算失败:', window.__manualSigErr); } }
  }
  // v1.6.23：行动卡改为 DOM 浮层（可拖动、双击复位）——先在 canvas 回退绘制前建层，建层成功则不重复画 canvas 版。
  // 理由（v1.5.58 教训）：悬浮控件必须在 DOM 顶层，不得参与 canvas 坐标命中（真机 tap 不可靠）。
  try { renderActionCardDom(); } catch (e) {}
  if (cfg.sigOverlay && window.__actionCard && !(_acEl && _acEl.isConnected)) {
    const ac = window.__actionCard;
    const _v = actionCardView((typeof sym !== 'undefined' ? sym : cfg.sym), ac);
    const bigTxt = _v.big, col = _v.color, l0 = _v.title, l3 = _v.sub, warnLine = _v.warn, ruleTxt = _v.rule, entryTxt = _v.entry;
    ctx.save();
    ctx.textAlign = 'left';
    ctx.font = '9px sans-serif';
    let w28 = Math.max(Math.max(ctx.measureText(l0).width, ctx.measureText(l3).width), Math.max(ctx.measureText(ruleTxt).width, ctx.measureText(entryTxt).width));
    if (warnLine) w28 = Math.max(w28, ctx.measureText(warnLine).width);
    w28 += 14;
    ctx.font = 'bold 15px sans-serif';
    w28 = Math.max(w28, ctx.measureText(bigTxt).width + 14);
    // GOAL19 基准：Y=主图区（PAD_T→mainBottom）中点（外层已有 mainBottom，勿重复声明）
    const cy28 = (PAD_T + mainBottom) / 2 - 40;
    const h28 = warnLine ? 92 : 80;
    ctx.fillStyle = 'rgba(16,22,30,.8)';
    ctx.fillRect(PAD_L + 6, cy28, w28, h28);
    ctx.strokeStyle = col; ctx.globalAlpha = .65; ctx.strokeRect(PAD_L + 6, cy28, w28, h28); ctx.globalAlpha = 1;
    ctx.font = '9px sans-serif'; ctx.fillStyle = 'rgba(160,175,190,.9)';
    ctx.fillText(l0, PAD_L + 13, cy28 + 13);
    ctx.font = 'bold 15px sans-serif'; ctx.fillStyle = col;
    ctx.fillText(bigTxt, PAD_L + 13, cy28 + 33);
    ctx.font = '9px sans-serif'; ctx.fillStyle = 'rgba(230,238,245,.9)';
    ctx.fillText(l3, PAD_L + 13, cy28 + 49);
    let _yy28 = cy28 + 62;
    if (warnLine) { ctx.fillStyle = '#f59e0b'; ctx.fillText(warnLine, PAD_L + 13, _yy28); _yy28 += 13; }
    ctx.fillStyle = 'rgba(200,212,224,.85)';
    ctx.fillText(ruleTxt, PAD_L + 13, _yy28); _yy28 += 13;
    ctx.fillStyle = _v.entryStrong ? 'rgba(230,238,245,.95)' : 'rgba(160,175,190,.8)';
    ctx.fillText(entryTxt, PAD_L + 13, _yy28);
    ctx.restore();
  }
  // 2026-09-18 审计修复：本块原为「有信号/Alpha live 时才进入」——导致引擎未启动时主图状态带**完全空白**，
  // 被用户误读为「引擎在跑只是没信号」。现改为恒进入（window 可用时）；信号标记仍受各自开关约束，
  // 但「引擎状态角标」恒绘制（未启动→黄色⛔提示）。
  if (typeof window !== 'undefined') {
    ctx.save();
    const LT = (_showSrsi || cfg.srsiAutoApplyBt) ? (window.__srsiLiveTrades || []) : [];
    let lp = 0;
    for (const tr of LT) {
      if (!tr || !Number.isFinite(tr.t) || tr.t < t[0] - 3600e3 * 48) continue;
      const _kind = tr.action === 'open' ? (tr.side === 'long' ? 'srsiLong' : 'srsiShort') : 'srsiClose';
      const p = markFxXY(_mainGeom, { t: tr.t, kind: _kind });
      if (!p) continue;
      ctx.fillStyle = p.color;
      _drawMarkShape(ctx, p);
      lp++;
    }
    const AM = _showAlpha ? (window.__alphaLiveMarks || []) : [];
    let ap = 0, _lastAM = null;
    for (const m3 of AM) {
      if (!m3 || !Number.isFinite(m3.t) || m3.t < t[0]) continue;
      const _kind = (m3.action === 'close' || m3.dir === 0) ? 'alphaClose' : (m3.dir > 0 ? 'alphaLong' : 'alphaShort');
      const p = markFxXY(_mainGeom, { t: m3.t, kind: _kind });
      if (!p) continue;
      if (_kind === 'alphaClose') {
        ctx.strokeStyle = p.color; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(p.x, p.y - 6); ctx.lineTo(p.x + 6, p.y); ctx.lineTo(p.x, p.y + 6); ctx.lineTo(p.x - 6, p.y); ctx.closePath(); ctx.stroke();
        ctx.lineWidth = 1;
      } else {
        ctx.fillStyle = p.color;
        _drawMarkShape(ctx, p);
      }
      ap++;
      _lastAM = { x: p.x, y: p.y, side: p.side, dir: m3.dir, t: m3.t };
    }
    // v1.6.19：最新 α 标记旁注「方向 + 基石数据日」——与行动卡同口径（避免把日线方向误读为实时）
    if (_lastAM && _lastAM.dir !== 0 && typeof window !== 'undefined') {
      try {
        const _as = (window.__alphaSignalsBySym && window.__alphaSignalsBySym[sym]) || window.__alphaSignals || null;
        const _d1 = _as && _as.d1T ? new Date(_as.d1T).toISOString().slice(5, 10) : null;
        const _txt = 'α' + (_lastAM.dir > 0 ? '多' : '空') + (_d1 ? '(' + _d1 + ')' : '');
        ctx.font = '9px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = _lastAM.dir > 0 ? '#22d3ee' : '#f59e0b';
        // v1.6.29：旁注画在标记外侧（多/金钩在下 → 标在菱形下方；空/死钩在上 → 标在上方）
        ctx.fillText(_txt, _lastAM.x, _lastAM.side === 'down' ? _lastAM.y + 16 : _lastAM.y - 9);
        ctx.textAlign = 'left';
      } catch (e) {}
    }
    // v1.6.19：主图「15m SRSI 信号机会」（金叉/死叉/破带/钩，非成交）
    // v1.6.29：形状/位置改由 markFxXY 统一（钩=菱形、穿越=圆点；买侧在 K 线下、卖侧在上）
    if (cfg.sigOverlay) {
      try {
        for (const op of filterOpportunityDraws(mainOpportunityMarks(sym))) {
          if (op.t < t[0]) continue;
          const _kind = op.kind === 'hook' ? (op.side === 'long' ? 'hookGold' : 'hookDeath') : (op.side === 'long' ? 'oppBuy' : 'oppSell');
          const p = markFxXY(_mainGeom, { t: op.t, kind: _kind });
          if (!p) continue;
          ctx.fillStyle = p.color;
          _drawMarkShape(ctx, p);
        }
      } catch (e) {}
    }
    // 2026-09-18 审计修复：状态带左角标**总是**绘制「引擎真实状态」——未启动时必须显式告知
    // （原实现只在有信号/Alpha live 时才画，导致「什么都没显示」被误读为「引擎在跑但没信号」）
    {
      ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; // GOAL22：状态带左角标必须左对齐（残留 right 导致文字向左延伸一半出画布）
      const aw = Number.isFinite(window.__alphaLiveW) ? window.__alphaLiveW : 0;
      let label, col, bg, bd;
      let st = null;
      try { st = signalEngineStatus(); } catch (e) { st = null; }
      if (st && !st.runningHere) {
        label = '⛔ 本币对（' + (st.sym || sym) + '）信号引擎未启动 · 无信号可看（右侧驾驶舱 → ⚡ 启动信号引擎）';
        col = '#FFB300'; bg = 'rgba(255,179,0,.12)'; bd = 'rgba(255,179,0,.5)';
      } else {
        const w = _sigWatch[sym] || null;
        const bandTxt = w ? ('卫星 15m ' + (w.band === 'upper' ? '上带' : w.band === 'lower' ? '下带' : '中性') + ' K' + (w.k != null ? w.k.toFixed(0) : '--') + '/' + (w.d != null ? w.d.toFixed(0) : '--')) : '';
        label = '● 信号引擎 ON' + (bandTxt ? ' · ' + bandTxt : '') +
          (st && st.srsiRunning ? ' · 卫星自动' : '') + (st && st.alphaRunning ? ' · 基石 α' + (aw > 0.02 ? '多' : aw < -0.02 ? '空' : '平') + Math.abs(aw * 100).toFixed(0) + '%' : '') +
          (lp ? ' · SRSI信号' + lp : '') + (ap ? ' · α信号' + ap : '');
        col = '#2ecc71'; bg = 'rgba(16,22,30,.72)'; bd = 'rgba(46,204,113,.35)';
      }
      const tw = ctx.measureText(label).width;
      const bx = PAD_L + 6, by = PAD_T + MAIN_H + 4; // GOAL21：移主图底部状态带左（原主图右下压 SRSI 下限带）
      ctx.fillStyle = bg;
      ctx.fillRect(bx, by, tw + 12, 18);
      ctx.strokeStyle = bd; ctx.strokeRect(bx, by, tw + 12, 18);
      ctx.fillStyle = col;
      ctx.fillText(label, PAD_L + 12, by + 13);
      ctx.textAlign = 'left';
    }
    // v1.6.19：图例旁「当前方向 + 标记计数」（DOM；仅变化时写，便宜）
    try {
      const _el = typeof document !== 'undefined' ? document.getElementById('sigMarkCount') : null;
      if (_el) {
        const aw2 = Number.isFinite(window.__alphaLiveW) ? window.__alphaLiveW : 0;
        const txt = ' α' + (aw2 > 0.02 ? '多' : aw2 < -0.02 ? '空' : '平') + Math.abs(aw2 * 100).toFixed(0) + '% · ◆' + ap + ' · ▲▼' + lp;
        if (_el.__t !== txt) { _el.__t = txt; _el.textContent = txt; }
      }
    } catch (e) {}
    ctx.restore();
  }

  // SRSI 回测信号标记（GOAL8，_btCfg.btMarks 默认关=零绘制）：把最近一次 SRSI 回测的逐笔开/平/爆仓标在主图，
  // 与 α 信号共存。数据源 window.__srsiBtTrades（runSrsiBacktest 结果，无前视重放）。时间→主图 bar：二分找 last idx ≤ trade.t
  if (typeof _btCfg !== 'undefined' && _btCfg.btMarks && typeof window !== 'undefined' && window.__srsiBtTrades && window.__srsiBtSym === sym) {
    const BT = window.__srsiBtTrades;
    ctx.save();
    const vEnd2 = start + n;
    let painted = 0;
    for (const tr of BT) {
      if (!tr || !Number.isFinite(tr.t) || tr.t <= t[0]) continue;
      // 二分：最后一个 t[i] <= tr.t
      let lo = 0, hi = t.length - 1, idx = -1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (t[m] <= tr.t) { idx = m; lo = m + 1; } else hi = m - 1; }
      if (idx < start || idx >= vEnd2 || idx >= c.length) continue;
      const x = X(idx), y = Y(c[idx]);
      const act = tr.action || '';
      if (act === 'open') {
        ctx.fillStyle = tr.side === 'long' ? '#2ecc71' : '#ff6b6b';
        ctx.beginPath();
        if (tr.side === 'long') { ctx.moveTo(x, y + 7); ctx.lineTo(x - 5, y + 15); ctx.lineTo(x + 5, y + 15); }
        else { ctx.moveTo(x, y - 7); ctx.lineTo(x - 5, y - 15); ctx.lineTo(x + 5, y - 15); }
        ctx.closePath(); ctx.fill();
      } else if (act === 'liquidate') {
        ctx.strokeStyle = '#222'; ctx.fillStyle = '#222'; ctx.font = 'bold 11px sans-serif';
        ctx.fillText('×', x - 3, y - 8);
      } else {
        ctx.fillStyle = '#8899aa';
        ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
      }
      painted++;
    }
    if (painted) {
      ctx.font = 'bold 11px sans-serif'; ctx.fillStyle = '#7f8fa6'; ctx.textAlign = 'right';
      ctx.fillText('SRSI回测信号 ' + painted, W - PAD_R - 4, PAD_T + 40); // GOAL28：从 PAD_T+26 下移避让右上角图例行
      ctx.textAlign = 'left';
    }
    ctx.restore();
  }

  // 优化预览叠加（optPreviewOn）：以白色虚线画各已优选周期的 K/D + 上下带（不写入配置，便于看图对比）
  if (cfg.optPreviewOn && cfg.srsiOptPreview) {
    const Y0p = (v) => PAD_T + (100 - (v != null ? v : 50)) / 100 * MAIN_H;
    ctx.save();
    ctx.beginPath(); ctx.rect(PAD_L, PAD_T, plotW, MAIN_H); ctx.clip();
    Object.keys(cfg.srsiOptPreview).forEach(tf => {
      const pr = cfg.srsiOptPreview[tf]; if (!pr || !pr.best) return;
      const pc = getTFData(sym, tf).c; if (!pc || pc.length < 2) return;
      const tfT = getTFData(sym, tf).t;
      const col = '#ffffff';
      [pr.best.overbought, pr.best.oversold].forEach(v => {
        if (v == null || !isFinite(v)) return;
        const y = Y0p(v); ctx.strokeStyle = col; ctx.globalAlpha = 0.25; ctx.setLineDash([3, 4]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(PAD_L, y); ctx.lineTo(W - PAD_R, y); ctx.stroke();
      });
      ctx.globalAlpha = 1; ctx.setLineDash([]);
      let kArr, dArr, useAlign = false;
      if (baseT && tfT && tfT.length >= pc.length) {
        const al = alignedSrsiOverlay(pc, tfT, baseT, pr.best);
        if (al.k.length === baseT.length) { kArr = al.k; dArr = al.d; useAlign = true; }
      }
      if (useAlign) {
        const drawP = (arr, dash, w) => {
          ctx.strokeStyle = col; ctx.lineWidth = w; ctx.setLineDash(dash); ctx.beginPath(); let st = false;
          for (let vi = 0; vi < baseT.length; vi++) { const v = arr[vi]; if (v == null || !isFinite(v)) { st = false; continue; } const x = X(start + vi), y = Y0p(v); if (!st) { ctx.moveTo(x, y); st = true; } else ctx.lineTo(x, y); }
          ctx.stroke();
        };
        drawP(kArr, [2, 3], 1.1); drawP(dArr, [1, 3], 0.8);
      } else {
        const sl = srsiPanelSeries(pc, pr.best, bars);
        const off = Math.max(0, pc.length - Math.min(bars, pc.length));
        const drawS = (arr, dash, w) => {
          ctx.strokeStyle = col; ctx.lineWidth = w; ctx.setLineDash(dash); ctx.beginPath(); let st = false;
          for (let i = start; i < c.length; i++) { const li = i - off; if (li < 0 || li >= arr.length) continue; const v = arr[li]; if (v == null || !isFinite(v)) { st = false; continue; } const x = X(i), y = Y0p(v); if (!st) { ctx.moveTo(x, y); st = true; } else ctx.lineTo(x, y); }
          ctx.stroke();
        };
        drawS(sl.k, [2, 3], 1.1); drawS(sl.d, [1, 3], 0.8);
      }
    });
    ctx.setLineDash([]); ctx.globalAlpha = 1;
    ctx.restore();
  }

  // 标题
  ctx.fillStyle = '#8b95a5'; ctx.font = '9px monospace';
  ctx.fillText(sym + ' · ' + tf + '  最近 ' + n + ' 根', PAD_L + 4, PAD_T + 10);
  // GOAL28 图例已移至「主图叠加 SRSI」工具栏最右（v1.5.57：不再遮挡 K 线/SRSI 线）
  return true;
}

// ---- 子图（RSI / SRSI / MACD），SRSI 按勾选周期 ----
function drawSub(ctx, sub, sym, y0) {
  const plotW = W - PAD_L - PAD_R;
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.strokeRect(PAD_L, y0, plotW, SUB_H);

  const S = window.S;
  // 主图已对 7d/30d 改用原生周/月线（足量根数）；子图 SRSI 价格线与其保持一致，避免 7d/30d 仅 71/16 根导致 SRSI 线不全。
  const price = nativeMain(sym, sub.tf || cfg.mainTF).c;

  if (sub.key === 'rsi') {
    const s = subTf(sym, sub.tf || cfg.mainTF);
    drawOscillator(ctx, s && s.series ? s.series.rsi : [], y0, [30, 50, 70], '#ffd740', sub, cfg.bars);
    drawSubTitle(ctx, sub.name, SUB_COLORS.rsi, y0);
  } else if (sub.key === 'macd') {
    const s = subTf(sym, sub.tf || cfg.mainTF);
    drawMacd(ctx, s && s.series ? s.series : null, y0, sub, cfg.bars);
    drawSubTitle(ctx, sub.name, SUB_COLORS.macd, y0);
  } else if (sub.key === 'srsi') {
    const n = Math.min(cfg.bars, price.length);
    if (n < 2) { drawSubTitle(ctx, sub.name, SUB_COLORS.srsi, y0); return; }
    const srsiCfg = perTfSrsi(sub.tf || cfg.mainTF, cfg.srsiByTf, cfg.srsi);
    const sl = srsiPanelSeries(price, srsiCfg, n);
    drawSrsiPanel(ctx, { k: sl.k, d: sl.d, hooks: sl.hooks }, sl.crossings, y0, n, sub, srsiCfg);
    // 标题：SRSI 周期  Kxx.x Dxx.x ▲金叉/▼死叉  [主图]
    const k = sl.k.length ? sl.k[sl.k.length - 1] : null;
    const d = sl.d.length ? sl.d[sl.d.length - 1] : null;
    const st = srsiSignal(k, sl.k.length > 1 ? sl.k[sl.k.length - 2] : null, { overbought: srsiCfg.overbought, oversold: srsiCfg.oversold });
    let title = sub.name;
    title += '  K' + (k != null ? k.toFixed(1) : '--') + ' D' + (d != null ? d.toFixed(1) : '--');
    if (st.crossing === 'buy') title += ' ▲金叉';
    else if (st.crossing === 'sell') title += ' ▼死叉';
    if (sub.tf === cfg.mainTF) title += '  [主图]';
    drawSubTitle(ctx, title, SUB_COLORS.srsi, y0);
  }
}

function drawSubTitle(ctx, text, color, y0) {
  ctx.fillStyle = color || '#fff';
  ctx.font = 'bold 9px monospace';
  ctx.fillText(text, PAD_L + 4, y0 + 12);
}

// 纯函数：SRSI 面板序列。为避免 RSI(默认85) 长 warmup 吃掉窗口前部导致 KD 只画右侧/10m 完全不显示，
// 先对全量 price 计算 srsiKD，再只截取最近 bars 根用于展示（warmup 用前面历史）。
// 返回 { k, d, crossings }（均已切到最后 bars 根，索引 0..bars-1，可直接按 0 基画）。
export function srsiPanelSeries(price, cfg, bars) {
  const p = Array.isArray(price) ? price : [];
  const n = Math.min(bars, p.length);
  if (!(n >= 2)) return { k: [], d: [], crossings: [], hooks: [] };  // GOAL25：补 hooks，防空结构下 sl.hooks[-1] 崩
  const sl = srsiKD(p, cfg);
  const cross = srsiCrossings(sl.k, cfg);
  const hooks = srsiHooks(sl.k, sl.d, cfg);
  return {
    k: sl.k.slice(-n),
    d: sl.d.slice(-n),
    crossings: cross.slice(-n),
    hooks: hooks.slice(-n)
  };
}

function subTf(sym, tf) {
  const S = window.S;
  return (S.indicators[sym] && S.indicators[sym][tf]) || null;
}

function drawOscillator(ctx, data, y0, refs, color, sub, bars) {
  const n = Math.min(bars, data.length);
  if (n < 2) return;
  const start = data.length - n;
  const plotW = W - PAD_L - PAD_R;
  const xStep = plotW / n;
  const Y = (v) => y0 + (100 - v) / 100 * SUB_H;
  const X = (i) => PAD_L + (i - start) * xStep + xStep / 2;
  refs.forEach(r => {
    const y = Y(r);
    ctx.strokeStyle = r === 50 ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.12)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(PAD_L, y); ctx.lineTo(PAD_L + plotW, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.font = '8px monospace';
    ctx.fillText(String(r), PAD_L + plotW - 18, y - 2);
  });
  ctx.save();
  ctx.beginPath(); ctx.rect(PAD_L, y0, plotW, SUB_H); ctx.clip();
  ctx.strokeStyle = color; ctx.lineWidth = 1.3;
  ctx.beginPath();
  let started = false;
  for (let i = start; i < data.length; i++) {
    const v = data[i];
    if (v == null) { started = false; continue; }
    const x = X(i), y = Y(v);
    if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();
  const cur = data[data.length - 1];
  if (cur != null) {
    ctx.fillStyle = color; ctx.font = 'bold 9px monospace';
    ctx.fillText(fmt(cur), PAD_L + plotW - 46, y0 + SUB_H - 4);
  }
}

function drawMacd(ctx, series, y0, sub, bars) {
  if (!series) return;
  const data = series.macdLine;
  const n = Math.min(bars, data.length);
  if (n < 2) return;
  const start = data.length - n;
  const plotW = W - PAD_L - PAD_R;
  const xStep = plotW / n;
  let m = 1;
  const abs = [];
  for (let i = start; i < series.macdHist.length; i++) { const v = series.macdHist[i]; if (v != null && isFinite(v)) abs.push(Math.abs(v)); }
  if (abs.length) m = Math.max(...abs);
  if (!m) m = 1;
  const lo = -m * 1.1, hi = m * 1.1;
  const Y = (v) => y0 + (hi - v) / (hi - lo) * SUB_H;
  const X = (i) => PAD_L + (i - start) * xStep + xStep / 2;
  const y0z = Y(0);
  ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(PAD_L, y0z); ctx.lineTo(PAD_L + plotW, y0z); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.font = '8px monospace';
  ctx.fillText('0', PAD_L + plotW - 12, y0z - 2);
  ctx.save();
  ctx.beginPath(); ctx.rect(PAD_L, y0, plotW, SUB_H); ctx.clip();
  const bw = Math.max(1, xStep * 0.6);
  for (let i = start; i < series.macdHist.length; i++) {
    const v = series.macdHist[i];
    if (v == null) continue;
    const x = X(i);
    ctx.fillStyle = v >= 0 ? 'rgba(255,82,82,0.6)' : 'rgba(0,230,118,0.6)';
    ctx.fillRect(x - bw / 2, Math.min(Y(v), y0z), bw, Math.max(1, Math.abs(Y(v) - y0z)));
  }
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.2;
  ctx.beginPath(); let started = false;
  for (let i = start; i < data.length; i++) { const v = data[i]; if (v == null) { started = false; continue; } const x = X(i), y = Y(v); if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y); }
  ctx.stroke();
  if (series.macdSignal) {
    ctx.strokeStyle = '#ffd740'; ctx.lineWidth = 1.1;
    ctx.beginPath(); started = false;
    for (let i = start; i < series.macdSignal.length; i++) { const v = series.macdSignal[i]; if (v == null) { started = false; continue; } const x = X(i), y = Y(v); if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y); }
    ctx.stroke();
  }
  ctx.restore();
}

function drawSrsiPanel(ctx, sl, crossings, y0, n, sub, srsiCfg) {
  const plotW = W - PAD_L - PAD_R;
  const xStep = plotW / n;
  const Y = (v) => y0 + (100 - v) / 100 * SUB_H;
  const X = (i) => PAD_L + i * xStep + xStep / 2;
  // 超买/超卖带取自「该周期实际参数」(srsiCfg)，而非全局 cfg.srsi：确保与 K/D 曲线同源（修复重载/切币后带仍按默认画）
  const ob = (srsiCfg && srsiCfg.overbought != null) ? srsiCfg.overbought : cfg.srsi.overbought;
  const os = (srsiCfg && srsiCfg.oversold != null) ? srsiCfg.oversold : cfg.srsi.oversold;
  // 超买/超卖带
  ctx.fillStyle = 'rgba(255,82,82,0.10)';
  ctx.fillRect(PAD_L, Y(100), plotW, Y(ob) - Y(100));
  ctx.fillStyle = 'rgba(0,230,118,0.10)';
  ctx.fillRect(PAD_L, Y(0), plotW, Y(os) - Y(0));
  [50, ob, os].forEach(r => {
    const y = Y(r);
    ctx.strokeStyle = r === 50 ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.14)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(PAD_L, y); ctx.lineTo(PAD_L + plotW, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.font = '8px monospace';
    ctx.fillText(String(r), PAD_L + plotW - 18, y - 2);
  });
  ctx.save();
  ctx.beginPath(); ctx.rect(PAD_L, y0, plotW, SUB_H); ctx.clip();
  const mk = (arr, color, w) => {
    ctx.strokeStyle = color; ctx.lineWidth = w; ctx.beginPath();
    let started = false;
    for (let i = 0; i < arr.length; i++) { const v = arr[i]; if (v == null) { started = false; continue; } const x = X(i), y = Y(v); if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y); }
    ctx.stroke();
  };
  mk(sl.k, '#ffffff', 1.4);
  mk(sl.d, '#ffd740', 1.0);
  // 穿越信号
  for (let i = 0; i < crossings.length; i++) {
    const c = crossings[i];
    if (!c) continue;
    const x = X(i), y = Y(sl.k[i]);
    const sz = 6;
    if (c === 'buy') {
      ctx.fillStyle = '#00E5FF';
      ctx.beginPath(); ctx.moveTo(x, y - sz); ctx.lineTo(x - sz * 0.6, y + sz * 0.6); ctx.lineTo(x + sz * 0.6, y + sz * 0.6); ctx.closePath(); ctx.fill();
    } else {
      ctx.fillStyle = '#FFB300';
      ctx.beginPath(); ctx.moveTo(x, y + sz); ctx.lineTo(x - sz * 0.6, y - sz * 0.6); ctx.lineTo(x + sz * 0.6, y - sz * 0.6); ctx.closePath(); ctx.fill();
    }
  }
  // 钩标记（死钩/金钩）：红/绿菱形 ◆，区别于上方 cyan/amber 三角（带穿越）
  for (let i = 0; i < sl.hooks.length; i++) {
    const h = sl.hooks[i];
    if (!h) continue;
    const x = X(i), y = Y(sl.k[i]);
    const sz = 5;
    ctx.fillStyle = h === 'deathHook' ? '#FF5252' : '#00E676';
    ctx.beginPath();
    ctx.moveTo(x, y - sz); ctx.lineTo(x + sz, y); ctx.lineTo(x, y + sz); ctx.lineTo(x - sz, y); ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  // 当前值
  const curK = sl.k[sl.k.length - 1], curD = sl.d[sl.d.length - 1];
  if (curK != null) {
    ctx.font = 'bold 9px monospace';
    ctx.fillStyle = '#fff'; ctx.fillText('K:' + fmt(curK), PAD_L + plotW - 96, y0 + SUB_H - 4);
    ctx.fillStyle = '#ffd740'; ctx.fillText('D:' + fmt(curD), PAD_L + plotW - 46, y0 + SUB_H - 4);
  }
}

// ---- 悬停：十字线 + 主图价 line + 顶部联动汇总栏 + 命中面板浮动详情 ----
function drawHover(ctx, subList, H) {
  const { lx, ly } = _hover;
  const plotW = W - PAD_L - PAD_R;
  if (lx < PAD_L || lx > PAD_L + plotW || ly < PAD_T) return;
  const mainBottom = PAD_T + MAIN_H;
  const tf = cfg.mainTF;
  const sym = cfg.symbol;
  const { o, h, l, c, v, t } = nativeMain(sym, tf);
  const bars = cfg.bars;
  const frac = (lx - PAD_L) / plotW;
  const i = idxFromFrac(frac, c.length, bars);
  const n = Math.min(bars, c.length);
  const start = c.length - n;
  const xStep = plotW / n;

  // ---- 十字竖线（贯穿全高）----
  ctx.save();
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(lx, PAD_T); ctx.lineTo(lx, H - PAD_B); ctx.stroke();
  ctx.restore();

  // ---- 主图：横虚线 + 价格 chip（hovered 柱 close）----
  if (i >= 0 && i < c.length && c[i] != null) {
    let lo = Infinity, hi = -Infinity;
    for (let k = start; k < c.length; k++) {
      if (l[k] != null && isFinite(l[k]) && l[k] < lo) lo = l[k];
      if (h[k] != null && isFinite(h[k]) && h[k] > hi) hi = h[k];
    }
    if (!isFinite(lo) || !isFinite(hi) || hi <= lo) { lo = c[i] * 0.999; hi = c[i] * 1.001; }
    const pad = (hi - lo) * 0.08 || hi * 0.001;
    lo -= pad; hi += pad;
    const Y = (val) => PAD_T + (hi - val) / (hi - lo) * MAIN_H;
    const yc = Y(c[i]);
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath(); ctx.moveTo(PAD_L, yc); ctx.lineTo(W - PAD_R, yc); ctx.stroke();
    ctx.restore();
    // 价格 chip
    ctx.fillStyle = 'rgba(8,12,20,0.9)';
    ctx.fillRect(PAD_L + plotW - 64, yc - 7, 60, 12);
    ctx.fillStyle = (c[i] >= (o[i] != null ? o[i] : c[i])) ? '#00E676' : '#FF5252';
    ctx.font = '9px monospace';
    ctx.fillText(fmt(c[i]), PAD_L + plotW - 60, yc + 1);
  }

  // ---- 顶部联动汇总栏（任意位置都显示：主图 + 全部子图 在 hovered x 的读数；GOAL25 锁定时加🔒）----
  const m = i >= 0 ? mainHoverAt(frac, sym, tf, bars) : null;
  drawLinkBar(ctx, subList, m, tf, frac, mainBottom);
  if (_hoverLock) {
    ctx.save();
    ctx.font = '10px sans-serif';
    ctx.fillStyle = '#ffd740';
    ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    ctx.fillText('🔒 锁定·点按解锁', W - PAD_R - 4, PAD_T + 4);
    ctx.restore();
  }

  // ---- 命中面板：跟随式浮动详情框 ----
  const hit = panelFromLy(ly, _subRegions, mainBottom);
  if (hit) {
    if (hit.kind === 'main') drawMainDetail(ctx, m, lx, ly, plotW, H);
    else if (hit.kind === 'sub') drawSubDetail(ctx, hit, frac, lx, ly, plotW, H, bars);
  }
}

// 主图 OHLC 浮动详情框
function drawMainDetail(ctx, m, lx, ly, plotW, H) {
  if (!m || m.close == null) return;
  const green = m.close >= (m.open != null ? m.open : m.close);
  const col = green ? '#00E676' : '#FF5252';
  const chg = m.chg != null ? ` ${m.chg >= 0 ? '+' : ''}${m.chg.toFixed(2)}%` : '';
  const lines = [
    '时间  ' + fmtTime(m.time),
    `开 ${fmt(m.open)}  收 ${fmt(m.close)}`,
    `高 ${fmt(m.high)}  低 ${fmt(m.low)}`,
    `量 ${fmtVol(m.vol)}${chg}`
  ];
  // GOAL28 / v1.6.22：hover 标记说明行——该 bar 时间窗内命中的标记（与图例/主图绘制互证）：
  // ◆α调仓（基石实盘）、▲▼SRSI 成交（卫星自动）、●机会点（15m SRSI 穿越/钩，非成交）。
  try {
    if (typeof window !== 'undefined' && m.time != null && cfg.sigOverlay) {
      const t0 = m.time, t1 = m.time + tfMs(cfg.mainTF);
      const alphaLive = !!(window.__alphaLab && window.__alphaLab.isLive && window.__alphaLab.isLive());
      const hits = markHitsInWindow(t0, t1, {
        alphaMarks: alphaLive ? (window.__alphaLiveMarks || []) : [],
        srsiTrades: cfg.srsiAutoOn ? (window.__srsiLiveTrades || []) : [],
        opportunities: mainOpportunityMarks(cfg.symbol)
      });
      if (hits.length) lines.push('标记 ' + hits.slice(0, 3).join(' · ') + (hits.length > 3 ? ' …' : ''));
    }
  } catch (e) { /* 标记行失败不影响 OHLCV 详情 */ }
  drawFloatBox(ctx, lines, lx, ly, plotW, H, { lastCol: col });
}

// 某子图浮动详情框
function drawSubDetail(ctx, hit, frac, lx, ly, plotW, H, bars) {
  const sym = cfg.symbol;
  const tf = hit.tf || cfg.mainTF;
  const d = subHoverAt(frac, sym, tf, hit.key, bars);
  let lines = [];
  let lastCol = '#fff';
  if (hit.key === 'rsi') {
    lines = [`RSI  ${d.rsi != null ? d.rsi.toFixed(2) : '--'}`];
    const r = d.rsi;
    if (r != null) { if (r > 70) lastCol = '#FF5252'; else if (r < 30) lastCol = '#00E676'; else lastCol = '#ffd740'; }
    if (r > 70) lines.push('超买'); else if (r < 30) lines.push('超卖'); else lines.push('中性');
  } else if (hit.key === 'macd') {
    lines = [
      `MACD   ${d.macd != null ? d.macd.toFixed(4) : '--'}`,
      `SIGNAL ${d.signal != null ? d.signal.toFixed(4) : '--'}`,
      `HIST   ${d.hist != null ? d.hist.toFixed(4) : '--'}`
    ];
    if (d.hist != null) lastCol = d.hist >= 0 ? '#FF5252' : '#00E676';
  } else if (hit.key === 'srsi') {
    const cs = d.cross === 'buy' ? '金叉' : d.cross === 'sell' ? '死叉' : '无';
    lines = [
      `K ${d.k != null ? d.k.toFixed(2) : '--'}   D ${d.d != null ? d.d.toFixed(2) : '--'}`,
      '穿越 ' + cs
    ];
    lastCol = d.cross === 'buy' ? '#00E5FF' : d.cross === 'sell' ? '#FFB300' : '#fff';
    if (d.hook === 'deathHook') { lines.push('钩 死钩'); lastCol = '#FF5252'; }
    else if (d.hook === 'goldHook') { lines.push('钩 金钩'); lastCol = '#00E676'; }
  }
  drawFloatBox(ctx, lines, lx, ly, plotW, H, { lastCol });
}

// 通用跟随式浮动框（越界自动翻转），lastCol 用于末行文字着色（如涨跌）
function drawFloatBox(ctx, lines, lx, ly, plotW, H, { lastCol = '#fff' } = {}) {
  if (!lines.length) return;
  ctx.font = '9px monospace';
  let maxW = 0;
  lines.forEach(s => { const w = ctx.measureText(s).width; if (w > maxW) maxW = w; });
  const boxW = maxW + 16, rowH = 13, boxH = lines.length * rowH + 10;
  let bx = lx + 12, by = ly + 12;
  if (bx + boxW > W - 4) bx = lx - boxW - 12;
  if (by + boxH > H - PAD_B) by = ly - boxH - 12;
  if (bx < PAD_L + 2) bx = PAD_L + 2;
  if (by < PAD_T) by = PAD_T;
  ctx.fillStyle = 'rgba(8,12,20,0.94)';
  roundRect(ctx, bx, by, boxW, boxH, 4); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1;
  roundRect(ctx, bx, by, boxW, boxH, 4); ctx.stroke();
  lines.forEach((s, idx) => {
    ctx.fillStyle = idx === lines.length - 1 ? lastCol : '#b8c2d0';
    ctx.fillText(s, bx + 8, by + 14 + idx * rowH);
  });
}

// 顶部联动汇总栏：时间 + 主图OHLC/量 + 各子图读数（命中段高亮，其余置暗）
function drawLinkBar(ctx, subList, m, tf, frac, mainBottom) {
  const sym = cfg.symbol;
  ctx.font = '9px monospace';
  const hit = panelFromLy(_hover.ly, _subRegions, mainBottom);
  let x = PAD_L + 4;
  const y = PAD_T + 36;
  const drawSeg = (text, hl, color) => {
    const w = ctx.measureText(text).width + 10;
    if (x + w > W - PAD_R - 4) return;
    if (hl) {
      ctx.fillStyle = 'rgba(0,230,118,0.18)';
      ctx.fillRect(x - 2, y - 9, w, 13);
      ctx.strokeStyle = 'rgba(0,230,118,0.6)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x - 2, y - 9, w, 13);
    }
    ctx.fillStyle = color || '#b8c2d0';
    ctx.fillText(text, x, y);
    x += w;
  };

  if (m) {
    drawSeg(fmtTime(m.time), false, '#8b95a5');
    const col = m.close >= (m.open != null ? m.open : m.close) ? '#00E676' : '#FF5252';
    const chg = m.chg != null ? ` ${m.chg >= 0 ? '+' : ''}${m.chg.toFixed(2)}%` : '';
    drawSeg(`C ${fmt(m.close)}${chg}`, hit && hit.kind === 'main', col);
    drawSeg(`V ${fmtVol(m.vol)}`, false, '#8b95a5');
  }

  subList.forEach(sub => {
    // v1.5.63：读数按主图 hover K 线时刻跨周期对齐（m.time=null 时回退旧的垂直位置语义）
    const dt = subHoverAt(frac, sym, sub.tf || tf, sub.key, cfg.bars, (m && m.time != null) ? { t: m.time } : null);
    const hl = hit && hit.kind === 'sub' && hit.key === sub.key && (hit.tf === sub.tf);
    if (sub.key === 'rsi') {
      drawSeg(`RSI ${dt.rsi != null ? dt.rsi.toFixed(1) : '--'}`, hl, '#ffd740');
    } else if (sub.key === 'macd') {
      const macd = dt.macd != null ? dt.macd.toFixed(3) : '--';
      const hist = dt.hist != null ? dt.hist.toFixed(3) : '--';
      drawSeg(`MACD ${macd}/${hist}`, hl, '#fff');
    } else if (sub.key === 'srsi') {
      const k = dt.k != null ? dt.k.toFixed(1) : '--';
      const d = dt.d != null ? dt.d.toFixed(1) : '--';
      drawSeg(`SRSI${sub.tf ? sub.tf : ''} ${k}/${d}`, hl, '#c58aff');
    }
  });
}

// ---- 交互：hover / 子图拖拽 ----
export function initKChart() {
  _cv = document.getElementById('kchartCanvas');
  if (!_cv) return;
  _cv.style.width = '100%';
  _cv.style.height = 'auto';
  _ctx = _cv.getContext('2d');
  try { restoreSignalMarks(); } catch (e) {}   // v1.6.19：恢复历史成交/调仓标记（跨刷新可见）
  syncCanvasSize();
  if (!_cv.__kchartResizeBound) {
    _cv.__kchartResizeBound = true;
    if (typeof ResizeObserver !== 'undefined') {
      _resizeObs = new ResizeObserver(() => { syncCanvasSize(); renderKChart(); });
      _resizeObs.observe(_cv);
    }
    window.addEventListener && window.addEventListener('resize', () => { syncCanvasSize(); renderKChart(); });
  }
  if (!_cv.__kchartHoverBound) {
    _cv.__kchartHoverBound = true;
    const toLocal = (e) => {
      const rect = _cv.getBoundingClientRect();
      const H = _cv.__logicalH || BASE_H;
      return { lx: (e.clientX - rect.left) * (W / rect.width), ly: (e.clientY - rect.top) * (H / rect.height) };
    };
    // GOAL18-A/GOAL25：触屏取值（touch→hover 同路径；复用 mainHoverAt/subHoverAt 绘制）
    // GOAL25 新增：单指长按 500ms 锁定十字线（再次点按解锁）；双指捏合缩放可视根数 cfg.bars（60-300）
    const _touchClear = () => { if (_touchT) { clearTimeout(_touchT); _touchT = null; } };
    let _touchT = null;
    let _longT = null;                        // 长按锁定定时器
    let _pinch = null;                        // 双指缩放状态 {d0, bars0}
    const touchLocal = (e) => { const t = e.touches[0] || e.changedTouches[0]; return t ? { x: t.clientX, y: t.clientY, lx: t.clientX - _cv.getBoundingClientRect().left, ly: t.clientY - _cv.getBoundingClientRect().top } : null; };
    const touchDist = (e) => { const a = e.touches, t0 = a[0], t1 = a[1]; return (t0 && t1) ? Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY) : 0; };
    const pinchApply = (e) => {               // 双指：距离比→可视根数
      if (!_pinch) return;
      const nb = barsFromPinch(_pinch.bars0, _pinch.d0, touchDist(e));
      if (nb !== cfg.bars) {
        cfg.bars = nb;
        const bEl = document.getElementById('kchartBars'), bLbl = document.getElementById('kchartBarsLbl');
        if (bEl) bEl.value = nb;
        if (bLbl) bLbl.textContent = nb;
        renderKChart();
      }
    };
    _cv.addEventListener('touchstart', (e) => {
      e.preventDefault();
      if (e.touches.length >= 2) {            // 双指=缩放（取消长按与锁定）
        if (_longT) { clearTimeout(_longT); _longT = null; }
        _hoverLock = false;
        _pinch = { d0: touchDist(e), bars0: cfg.bars };
        _hover = null; renderKChart();
        return;
      }
      const p = touchLocal(e); if (!p) return;
      _hoverLock = false;                     // 再次点按=解锁（并作为新取值点）
      _hover = p; renderKChart();
      if (_longT) clearTimeout(_longT);
      _longT = setTimeout(() => { _hoverLock = true; renderKChart(); }, 500);
    }, { passive: false });
    _cv.addEventListener('touchmove', (e) => {
      e.preventDefault();
      if (_pinch && e.touches.length >= 2) { pinchApply(e); return; }
      const p = touchLocal(e); if (!p) return;
      if (_hover) {
        const dx = Math.abs(p.lx - _hover.lx), dy = Math.abs(p.ly - _hover.ly);
        if (dx > 8 || dy > 8) { if (_longT) { clearTimeout(_longT); _longT = null; } }  // 移动取消长按
      }
      _hover = p; renderKChart();
    }, { passive: false });
    _cv.addEventListener('touchend', (e) => {
      if (_longT) { clearTimeout(_longT); _longT = null; }
      if (e.touches.length === 0 && _pinch) { _pinch = null; persist(); }   // 缩放结束一次性落盘
      _touchClear();
      if (!_hoverLock) _touchT = setTimeout(() => { _hover = null; renderKChart(); }, 2000);  // 锁定时不自动清除
    }, { passive: true });
    // iOS 页面级双指缩放手势拦截（canvas 上双指只用于图表缩放）
    const _gest = (e) => e.preventDefault();
    _cv.addEventListener('gesturestart', _gest);
    _cv.addEventListener('gesturechange', _gest);
    _cv.addEventListener('mousemove', (e) => {
      _hover = toLocal(e);
      // 区分拖动与点击：mousedown 后位移过大视为拖动（点击监听据此忽略）
      if (_press && !_pressMoved) {
        const dx = Math.abs(_hover.lx - _press.lx), dy = Math.abs(_hover.ly - _press.ly);
        if (dx > 6 || dy > 6) _pressMoved = true;
      }
      // 命中标题栏 → 拖拽
      const reg = _subRegions.find(r => _hover.ly >= r.y0 && _hover.ly <= r.y0 + SUB_GAP && _hover.lx >= PAD_L && _hover.lx <= W - PAD_R);
      _cv.style.cursor = _drag ? 'grabbing' : (reg ? 'grab' : 'crosshair'); if (_cv.title) _cv.title = '';
      if (_drag) { if (Math.abs(_hover.ly - _drag.startY) > 8) _drag.moved = true; if (_drag.moved) _drag.curY = _hover.ly; renderKChart(); return; }
      renderKChart();
    });
    _cv.addEventListener('mousedown', (e) => {
      const p = toLocal(e);
      _press = p; _pressMoved = false;
      const reg = _subRegions.find(r => p.ly >= r.y0 && p.ly <= r.y0 + SUB_GAP && p.lx >= PAD_L && p.lx <= W - PAD_R);
      if (reg) _drag = { fromIdx: reg.idx, startX: p.lx, startY: p.ly, curY: p.ly, moved: false };
    });
    const endDrag = () => {
      if (_drag && _drag.moved) {
        const target = _subRegions.find(r => _drag.curY >= r.y0 && _drag.curY <= r.y1);
        if (target && target.idx !== _drag.fromIdx) {
          const list = (cfg.subOrder || ['rsi', 'srsi', 'macd']).slice();
          // 将对应子图（可能展开多 SRSI 面板，这里按相对顺序移动整个子图键）
          const keyToMove = _subRegions[_drag.fromIdx] && _subRegions[_drag.fromIdx].key;
          const fromArr = list.indexOf(keyToMove);
          if (fromArr < 0) { _drag = null; return; }
          list.splice(fromArr, 1);
          let toArr = list.indexOf(target.key);
          if (toArr < 0) toArr = list.length;
          list.splice(toArr, 0, keyToMove);
          cfg.subOrder = list;
          persist();
        }
      } else if (_drag && !_drag.moved) {
        // 单击 SRSI 子图标题栏 → 切换主图为该周期
        const reg = _subRegions[_drag.fromIdx];
        if (reg && reg.key === 'srsi' && reg.tf && reg.tf !== cfg.mainTF) {
          setMainTF(reg.tf);
          _drag = null;
          renderKChart();
          return;
        }
      }
      _drag = null;
      renderKChart();
    };
    _cv.addEventListener('mouseup', endDrag);
    window.addEventListener('mouseup', endDrag);
    _cv.addEventListener('mouseleave', () => { _hover = null; _hoverLock = false; _press = null; _pressMoved = false; renderKChart(); });
    // SRSI 周期切换已迁出 HTML chip 栏（#kchartOvQuick），画布内不再处理点击命中
  }
  renderKChart();
  bindOverviewClick();
  // 加载时自愈：若用户曾优选过任意周期，则对缺失的周期补跑优选（避免刷新后某周期回落为「无优选」）
  try {
    if (cfg.srsiOptSource && Object.keys(cfg.srsiOptSource).some(k => cfg.srsiOptSource[k] === 'optimized')) {
      runSrsiAutoOptimizeAll(false);
    }
  } catch (e) {}
}

// ---- 公共设置 ----
// 诊断：每次切币对后打印当前币对持久化状态（仅 PWA 模式），便于排查「切币丢参」是否真发生
function diagSrsi(sym) {
  try {
    if (!_pwaMode) return;
    const pwa = readPwaSrsiOpt()[sym] || {};
    const sh = _readJson(STATE_KEY) || {};
    const shBy = (sh.bySymbol && sh.bySymbol[sym]) || {};
    const optTfs = Object.keys(cfg.srsiOptSource || {}).filter(t => cfg.srsiOptSource[t] === 'optimized');
    const pwaOpt = Object.keys(pwa.srsiOptSource || {}).filter(t => pwa.srsiOptSource[t] === 'optimized');
    const shOpt = Object.keys(shBy.srsiOptSource || {}).filter(t => shBy.srsiOptSource[t] === 'optimized');
    console.log('[SRSI-DIAG]', sym,
      'cfg.optTfs=', JSON.stringify(optTfs),
      'cfg15=', JSON.stringify(cfg.srsiByTf && cfg.srsiByTf['15m']),
      '| pwa.optTfs=', JSON.stringify(pwaOpt),
      'pwa15=', JSON.stringify(pwa.srsiByTf && pwa.srsiByTf['15m']),
      '| sh.optTfs=', JSON.stringify(shOpt),
      'sh15=', JSON.stringify(shBy.srsiByTf && shBy.srsiByTf['15m']));
  } catch (e) {}
}

function setSym(sym) {
  if (!sym) return;
  if (sym === cfg.symbol) { persist(); renderKChart(); return; }
  persist();                 // 先以旧 symbol 保存当前币对配置
  cfg.symbol = sym;
  _ovFootTf = null;         // 切币对时重置页脚参数周期
  loadCfg();                 // 加载该币对配置（无则默认）
  applyPwaOverlay(sym);     // 防御：再确认 PWA 私有键覆盖（免疫任何路径回退导致优选参数丢失）
  // 面板着陆修复：切币后若当前编辑周期未被优选，而该币对有已优选周期，则跳到第一个已优选周期，
  // 使设置面板一打开即显示已恢复的优参（◆），避免用户误读为"切币丢参数"。
  const _ntf = firstOptimizedTf(cfg);
  if (_ntf && cfg.srsiOptSource && cfg.srsiOptSource[cfg.srsiEditTf] !== 'optimized') cfg.srsiEditTf = _ntf;
  persist();                 // 更新 lastSymbol
  if (typeof document !== 'undefined') renderControls(); // 同步 SRSI 设置卡等控件显示的新币对
  diagSrsi(sym);             // 诊断：打印切币后当前币对持久化状态
  resetSrsiAuto(cfg.symbol); // SRSI 自动交易连开计数随币对重置
  const btEl = (typeof document !== 'undefined') ? document.getElementById('ktSrsiBtResult') : null;
  if (btEl) btEl.innerHTML = ''; // 切币对时清空旧币对的回测结果，强制重新渲染当前币对
  renderKChart();
}
function enumSymbols() {
  try {
    const sel = document.getElementById('kchartSymbol');
    if (sel && sel.options && sel.options.length) return Array.from(sel.options).map(o => o.value).filter(Boolean);
  } catch (e) {}
  if (globalThis.SYMS && globalThis.SYMS.length) return globalThis.SYMS.map(s => (s && s.id) || s);
  return [];
}
function copyCfgToAll(symbols) {
  if (!_store) _store = readStore();
  const list = (symbols && symbols.length) ? symbols : enumSymbols();
  const snap = JSON.parse(JSON.stringify(cfg));
  let n = 0;
  list.forEach(s => { if (s && s !== cfg.symbol) { _store.bySymbol[s] = Object.assign(JSON.parse(JSON.stringify(snap)), { symbol: s }); n++; } });
  persist();
  toast('已复制本币对设置到 ' + n + ' 个币对');
}
function resetSymbolCfg() {
  if (!_store) _store = readStore();
  const sym = cfg.symbol;
  delete _store.bySymbol[sym];
  _safeSetItem(STATE_KEY, JSON.stringify(_store));
  if (_pwaMode) {
    const opt = readPwaSrsiOpt(); delete opt[sym]; _writeJson(PWA_SRSI_OPT_KEY, opt);
    const auto = readPwaSrsiAuto(); delete auto[sym]; _writeJson(PWA_SRSI_AUTO_KEY, auto);
  }
  cfg = defaultKConfig(); cfg.symbol = sym;
  normalizeCfg(cfg);
  if (typeof document !== 'undefined') { renderControls(); renderKChart(); }
}
function openSrsiCardFor(tf) {
  if (!KLINE_TF.includes(tf)) return;
  cfg.srsiEditTf = tf;
  cfg.srsi = { ...cfg.srsiByTf[tf] };
  persist();
  const wrap = document.getElementById('kchartSrsiCardWrap');
  if (wrap) wrap.classList.remove('closed');
  if (typeof document !== 'undefined') { renderControls(); renderKChart(); }
}
function applyKMode(res) {
  if (!res) return;
  if (res.mainTF) cfg.mainTF = res.mainTF;
  cfg.klineSel = res.sel;
  persist();
  renderControls();
  renderKChart();
}
function setMainTF(tf) { if (!KLINE_TF.includes(tf)) return; applyKMode(nextKMode(tf, cfg, 'main')); }
function setKlineSel(tf, on) {
  if (!KLINE_TF.includes(tf)) return;
  const cur = { mainTF: cfg.mainTF, klineSel: { ...cfg.klineSel } };
  cur.klineSel[tf] = !!on;
  applyKMode(nextKMode(tf, cur, 'srsi'));
}
function setKPreset(name) { applyKMode(kPresetCombos(name)); }
function setKOverview(on) { cfg.overviewOpen = !!on; persist(); const wrap = document.getElementById('kchartOverviewWrap'); if (wrap) wrap.classList.toggle('closed', !cfg.overviewOpen); renderControls(); renderKChart(); }
function toggleOverview() { setKOverview(!cfg.overviewOpen); }
function setKDisc(on) { cfg.discOpen = !!on; persist(); const wrap = document.getElementById('kchartDiscWrap'); if (wrap) wrap.classList.toggle('closed', !cfg.discOpen); renderKChart(); }
function toggleKDisc() { setKDisc(!cfg.discOpen); }
// GOAL13：交易面板折叠（默认收缩，cfg 记忆）
function setTradePanelOpen(on) {
  cfg.tradePanelOpen = !!on; persist();
  const wrap = typeof document !== 'undefined' ? document.getElementById('ktPanelWrap') : null;
  if (wrap) wrap.classList.toggle('closed', !cfg.tradePanelOpen);
}
function kToggleTradePanel() { setTradePanelOpen(!cfg.tradePanelOpen); }
// GOAL13：主图实盘信号层总开关
// GOAL15：乐观 UI——点击立即更新 chip 样式并保留当前画面，重绘放下一帧（365d 大数据全量重绘秒级，原同步等待导致“十几秒才熄灭”体感）
function setSigOverlay(on) {
  cfg.sigOverlay = !!on; persist();
  const sc = typeof document !== 'undefined' ? document.getElementById('sigOverlayChip') : null;
  if (sc) {
    sc.style.border = cfg.sigOverlay ? '1px solid #22d3ee' : '1px solid var(--border)';
    sc.style.background = cfg.sigOverlay ? 'rgba(34,211,238,.15)' : 'var(--card2)';
    sc.style.color = cfg.sigOverlay ? '#22d3ee' : 'var(--text2)';
    sc.textContent = '实盘信号' + (cfg.sigOverlay ? ' ✓' : '');
  }
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => { renderKChart(); renderMainTools(); });
  else { renderKChart(); renderMainTools(); }
}
function setBars(v) { cfg.bars = Math.max(60, Math.min(300, parseInt(v) || 150)); persist(); renderKChart(); const lbl = document.getElementById('kchartBarsLbl'); if (lbl) lbl.textContent = cfg.bars; }
function setShow(key, on) {
  if (!(key in cfg.show)) return;
  cfg.show[key] = !!on;
  if (!cfg.subOrder) cfg.subOrder = [];
  if (on) { if (!cfg.subOrder.includes(key)) cfg.subOrder.push(key); }
  else cfg.subOrder = cfg.subOrder.filter(k => k !== key);
  persist();
  renderControls();
  renderKChart();
}
function setSrsi(name, v) {
  const tf = cfg.srsiEditTf;
  if (!cfg.srsiByTf[tf]) cfg.srsiByTf[tf] = { ...DEFAULT_SRSI };
  if (!(name in cfg.srsiByTf[tf])) return;
  const n = parseInt(v, 10);
  cfg.srsiByTf[tf][name] = Number.isNaN(n) ? DEFAULT_SRSI[name] : n;
  cfg.srsi = { ...cfg.srsiByTf[tf] }; // 保持旧全局镜像同步
  persist(); renderKChart();
  try {
    const pwa = readPwaSrsiOpt()[cfg.symbol] || {}; const sh = (_readJson(STATE_KEY) || {}).bySymbol || {};
    console.log('[SRSI-SET] name=' + name + ' v=' + v + ' tf=' + tf + ' -> ' + JSON.stringify(cfg.srsiByTf[tf]) + ' pwa=' + JSON.stringify(pwa.srsiByTf && pwa.srsiByTf[tf]) + ' sh=' + JSON.stringify(sh[cfg.symbol] && sh[cfg.symbol].srsiByTf && sh[cfg.symbol].srsiByTf[tf]));
  } catch (_) {}
}
function resetSrsi() { cfg.srsiByTf[cfg.srsiEditTf] = { ...DEFAULT_SRSI }; cfg.srsi = { ...DEFAULT_SRSI }; persist(); renderKChart(); if (typeof document !== 'undefined') renderControls(); }
function setSrsiTf(tf) { if (KLINE_TF.includes(tf)) { cfg.srsiEditTf = tf; cfg.srsi = { ...cfg.srsiByTf[tf] }; } persist(); if (typeof document !== 'undefined') renderControls(); }
function setSrsiAux(tf, on) { if (KLINE_TF.includes(tf)) { if (on) { cfg.srsiAux[tf] = true; keepInOvQuick(tf); } else delete cfg.srsiAux[tf]; } persist(); renderKChart(); }
function setMainOverlayTf(tf, on) {
  if (!KLINE_TF.includes(tf)) return;
  cfg.overlayTfs = cfg.overlayTfs || {};
  if (on) { cfg.overlayTfs[tf] = true; keepInOvQuick(tf); } else delete cfg.overlayTfs[tf];
  cfg.mainOverlay = Object.keys(cfg.overlayTfs).length > 0; // 兼容镜像
  persist(); renderKChart();
}
// 全局开关语义（兼容旧调用）：打开=按当前 klineSel 全勾；关闭=清空
function setMainOverlay(on) {
  cfg.overlayTfs = {};
  if (on) KLINE_TF.forEach(tf => { if (cfg.klineSel[tf]) { cfg.overlayTfs[tf] = true; keepInOvQuick(tf); } });
  cfg.mainOverlay = !!on;
  persist(); renderKChart();
}

// Alpha(combo) 买卖信号主图叠加开关（GOAL6）：开启时异步向 provider（PWA alphaLab）请求
// window.__alphaSignals {sym,tf,ts,flips[{i,dir,w}],lastW}，随后重绘；主系统无 provider 则仅持久化。
export async function setAlphaSignal(on) {
  cfg.alphaSignalOn = !!on;
  persist();
  // GOAL15：乐观 UI——先立即翻 chip + 重绘（旧的 await provider 同步等待 6 年全量回放=十几秒无响应根因），provider 后台重算完再补一帧
  const ac2 = typeof document !== 'undefined' ? document.getElementById('alphaChip') : null;
  if (ac2) {
    ac2.style.border = cfg.alphaSignalOn ? '1px solid #2ecc71' : '1px solid var(--border)';
    ac2.style.background = cfg.alphaSignalOn ? 'rgba(46,204,113,.15)' : 'var(--card2)';
    ac2.style.color = cfg.alphaSignalOn ? '#2ecc71' : 'var(--text2)';
    ac2.textContent = 'α 信号' + (cfg.alphaSignalOn ? ' ✓' : '');
  }
  renderKChart();
  if (on && typeof window !== 'undefined' && typeof window.__alphaSignalProvider === 'function') {
    window.__alphaSignalProvider().then(() => { try { renderKChart(); } catch (e) {} }).catch(() => {});
  }
}

// GOAL16：盯盘信号纯函数——方向(Alpha 基石) + 时机(15m SRSI 带位置择优，非反手) + 风控(ATR 止损止盈)
// 数学依据 docs/research/GOAL16-FRAMEWORK.md §四：带交叉反手单独使用为负期望（长窗实测 -100%），
// 正确形态=在 Alpha 方向内用 SRSI 带位置择优入场（顺势回调买点/持仓提示），不提供方向
export function manualSignal({ alphaDir, k15, d15, prevK15, price, atr, emaFast, emaSlow, lev }) {
  if (!Number.isFinite(price) || price <= 0) return null;
  const st = (v, lo, hi) => v == null || !Number.isFinite(v) ? 'na' : v > hi ? 'ob' : v < lo ? 'os' : 'mid';
  const zone = st(k15, 20, 80);
  const cross = prevK15 != null && k15 != null ? (prevK15 < 20 && k15 >= 20 ? 'upExit' : prevK15 > 80 && k15 <= 80 ? 'dnExit' : 'none') : 'none';
  const trend = emaFast == null || emaSlow == null ? 'na' : emaFast > emaSlow ? 'up' : emaFast < emaSlow ? 'dn' : 'flat';
  const stopD = Number.isFinite(atr) && atr > 0 ? 1.5 * atr : null;
  const base = {
    long: { action: 'long', stop: stopD != null ? price - stopD : null, target: stopD != null ? price + 2 * stopD : null },
    short: { action: 'short', stop: stopD != null ? price + stopD : null, target: stopD != null ? price - 2 * stopD : null },
  };
  if (alphaDir === 'long') {
    if (cross === 'upExit' || (zone === 'os' && k15 > d15)) return { ...base.long, timing: '优', reason: 'Alpha多头·15m超卖回升=顺势回调买点', trend };
    if (zone === 'ob') return { action: 'hold', timing: '勿追', reason: 'Alpha多头·15m超买：持仓等回落，勿追多开新', trend, stop: null, target: null };
    return { ...base.long, timing: '可', reason: 'Alpha多头·15m中带：持仓/回落后再入', trend };
  }
  if (alphaDir === 'short') {
    if (cross === 'dnExit' || (zone === 'ob' && k15 < d15)) return { ...base.short, timing: '优', reason: 'Alpha空头·15m超买回落=顺势反弹空点', trend };
    if (zone === 'os') return { action: 'hold', timing: '勿追', reason: 'Alpha空头·15m超卖：持仓等反弹，勿追空开新', trend, stop: null, target: null };
    return { ...base.short, timing: '可', reason: 'Alpha空头·15m中带：持仓/反弹后再入', trend };
  }
  return { action: 'wait', timing: '观望', reason: 'Alpha中性：无方向优势，观望', trend, stop: null, target: null };
}

// GOAL28 行动卡数据（纯函数，可单测）：「现在该做什么」三元组 = 基石方向(α权重%) + 用户规则状态(15m带边沿交叉否) + 方向券判定。
// 规则语义与 GOAL16-B 长窗验证版一致：K 从 <lower 升破 ≥lower → upExit(规则开多)；从 >upper 跌破 ≤upper → dnExit(规则开空)。
// 方向券（GOAL16-B 实锤：反向信号免成本皆负 → 反向仅提示勿动）：交叉方向=Alpha 同向 → enter(绿)；反向 → reverse(灰)；
// 基石中性(无方向) → noBase(灰)；无交叉 → idle(等待)。止损=1.5×ATR、目标=2×ATR（GOAL28 定版，区别于 manualSignal 的 3×ATR）。
export function actionCardData({ alphaDir, alphaW, k15, d15, prevK15, price, atr, upper, lower, alphaDataT, intradayDir, intradayTf }) {
  if (!Number.isFinite(price) || price <= 0) return null;
  const u = Number.isFinite(upper) && upper > 0 ? upper : 80;
  const lo = Number.isFinite(lower) && lower > 0 ? lower : 20;
  const cross = (prevK15 != null && Number.isFinite(prevK15) && k15 != null && Number.isFinite(k15))
    ? (prevK15 < lo && k15 >= lo ? 'upExit' : prevK15 > u && k15 <= u ? 'dnExit' : 'none')
    : 'none';
  const inBand = (k15 != null && Number.isFinite(k15) && d15 != null && Number.isFinite(d15))
    ? (k15 < lo && d15 < lo ? 'lower' : k15 > u && d15 > u ? 'upper' : 'mid')
    : 'na';
  const crossDir = cross === 'upExit' ? 'long' : cross === 'dnExit' ? 'short' : null;
  let verdict = 'idle';
  if (crossDir === 'long') verdict = alphaDir === 'long' ? 'enter' : alphaDir === 'short' ? 'reverse' : 'noBase';
  else if (crossDir === 'short') verdict = alphaDir === 'short' ? 'enter' : alphaDir === 'long' ? 'reverse' : 'noBase';
  const atrOk = Number.isFinite(atr) && atr > 0;
  const stop = crossDir && atrOk ? (crossDir === 'long' ? price - 1.5 * atr : price + 1.5 * atr) : null;
  const target = crossDir && atrOk ? (crossDir === 'long' ? price + 2 * atr : price - 2 * atr) : null;
  const aDir = alphaDir === 'long' || alphaDir === 'short' ? alphaDir : null;
  const iDir = intradayDir === 'long' || intradayDir === 'short' ? intradayDir : null;
  return {
    cross, crossDir, inBand, verdict,
    alphaDir: aDir,
    alphaW: Number.isFinite(alphaW) ? alphaW : 0,
    side: crossDir, stop, target, price, upper: u, lower: lo,
    // v1.6.18：基石信号所依据的已收盘日线时间 + 日内趋势（供行动卡标注数据日 / 逆势警告）
    alphaDataT: (alphaDataT != null && Number.isFinite(+alphaDataT)) ? +alphaDataT : null,
    intradayDir: iDir,
    intradayTf: (intradayTf === '15m' || intradayTf === '1h') ? intradayTf : null,
    trendConflict: !!(aDir && iDir && aDir !== iDir)
  };
}

// 某周期优选角色：勾选「辅助(只做放行闸门)」的周期即闸门(gate)，其余为波段(swing)
function roleForTf(tf) { return !!(cfg.srsiAux && cfg.srsiAux[tf]) ? 'gate' : 'swing'; }

// 闸门放行对象可选目标（原生周期，覆盖用户常用场景）；动态过滤为比当前闸门周期更长者。
const GATE_TARGET_OPTIONS = ['30m', '1h', '4h', '8h', '1d'];
// 各 TF 一根 K 线的毫秒数（闸门对齐时间用，避免硬编码 1h 偏移）
const TF_MS = { '1m': 60000, '5m': 300000, '10m': 600000, '15m': 900000, '30m': 1800000, '1h': 3600000, '4h': 14400000, '8h': 28800000, '1d': 86400000, '7d': 604800000, '30d': 2592000000 };
function tfMs(tf) { return TF_MS[tf] || 60000; }

function setGateTarget(tf) {
  if (!KLINE_TF.includes(tf) || tf === cfg.srsiEditTf || tfMs(tf) <= tfMs(cfg.srsiEditTf)) return;
  cfg.gateTargetTf = tf;
  persist();
  if (typeof document !== 'undefined') renderControls();
}

// 目标周期"下游冠军"参数推导（不硬编码逐币参数）：
// 1) 优先用用户已对该目标周期「优选并应用」的参数；
// 2) 否则对目标数据跑轻量 band 优选取数据驱动冠军；
// 3) 都不可用回退 PDF 手册参考基线 / 全默认。
function resolveGateChampion(target, closesT, opensT) {
  if (cfg.srsiOptSource && cfg.srsiOptSource[target] === 'optimized' && cfg.srsiByTf && cfg.srsiByTf[target]) {
    return { params: cfg.srsiByTf[target], origin: 'applied' };
  }
  try {
    const res = optimizeSrsiBand(closesT, opensT, { grid: srsiNeighborhoodGrid(), manualParams: null, defaultParams: DEFAULT_SRSI_BAND, rollingFolds: 1 });
    if (res && res.best && res.decision !== 'reject') return { params: res.best, origin: 'derived' };
  } catch (e) { /* 退化到手册 */ }
  const man = manualSwingParams(cfg.symbol, target);
  if (man) return { params: man, origin: 'manual' };
  return { params: DEFAULT_SRSI_BAND, origin: 'default' };
}

// 长历史拉取（默认 ~2 年，按 TF 分页 fetchKlinesRange；会话级缓存 + localStorage 持久化避免重复拉取）
const _optHistCache = new Map();
let _optFetchImpl = null; // 测试可注入桩
export function __setOptFetch(fn) { _optFetchImpl = fn; }
export function __getOptHistCache() { return _optHistCache; }
// 总时长上限：fetch 在半连接/极慢网络下 abort 可能不及时，用此兜底，超时即放弃并回退屏上 K 线
function withTimeout(promise, ms, msg) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg || 'timeout')), ms);
    Promise.resolve(promise).then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}
// 各周期回测所需「尾切片」根数（来自 PDF 手册验收口径：1h 取末尾 15000 根、4h 取末尾 3500 根；
// 15m 闸门需覆盖 1h 信号跨度 ≈ 625 天 = 60000 根）。拉足历史后只取末尾 N 根，不整段跑。
const OPT_TAIL_BARS = {
  '1m': 144000, '3m': 48000, '5m': 120000, '10m': 60000, '15m': 60000,
  '30m': 30000, '1h': 15000, '2h': 7500, '4h': 3500, '6h': 3500,
  '8h': 1750, '12h': 875, '1d': 730,
};
const OPT_CACHE_VER = 8; // v8：冠军选择对齐 AgentMore 手册规格（t↓排序+两半稳定性+邻域稳健三门槛顺序过滤；闸门=放行子集均值收益最大化），去除旧 walk-forward 覆盖逻辑
const _optStoreKey = (sym, tf, days, maxBars) => 'srsiOptHist:v' + OPT_CACHE_VER + ':' + sym + '|' + tf + '|' + days + '|' + maxBars;
function _optReadStore(sym, tf, days, maxBars) {
  try {
    if (typeof localStorage === 'undefined') return null;
    const c = localStorage.getItem(_optStoreKey(sym, tf, days, maxBars));
    if (!c) return null;
    const o = JSON.parse(c);
    // 校验缓存根数是否达到该 TF 应有根数（版本或旧量缓存一律视为失效，重新拉取）
    return (o && o.closes && o.closes.length >= Math.floor(maxBars * 0.9)) ? o : null;
  } catch (e) { return null; }
}
function _optWriteStore(sym, tf, days, maxBars, obj) {
  // 不再持久化原始 K 线到 localStorage：2 年历史每周期数万根极易撑爆 5MB 配额，
  // 静默失败会拖累所有配置/参数的持久化（正是此前“刷新/切币丢 SRSI 参数”的根因）。
  // 改为仅保留会话内 _optHistCache 秒回；跨会话重新拉取(90–240s)即可。
  return;
}
async function optFetchKlines(sym, tf, days, role) {
  const now = Date.now();
  const startTime = now - days * 86400000;
  // 按 TF 取「尾切片」应有根数并封顶（1h=15000/4h=3500/15m=60000，对齐 PDF 手册验收），不整段跑
  const tfMins = tfMs(tf) / 60000;
  const bars730 = Math.floor(730 * 1440 / tfMins);
  const maxBars = Math.min(OPT_TAIL_BARS[tf] || bars730, 76000);
  const key = sym + '|' + tf + '|' + days + '|' + maxBars;
  if (_optHistCache.has(key)) return _optHistCache.get(key);
  const cached = _optReadStore(sym, tf, days, maxBars); // 持久化命中且根数达标 → 秒回，不重新拉取
  if (cached) { _optHistCache.set(key, cached); return cached; }
  const totalMs = maxBars > 40000 ? 240000 : maxBars > 15000 ? 150000 : 90000; // 总超时兜底（根数越多越宽）
  let raw = null;
  try {
    if (_optFetchImpl) raw = await _optFetchImpl(sym, tf, days);
    else {
      const p = await withTimeout(
        fetchKlinesRange(sym, tf, startTime, now, () => {}, maxBars),
        totalMs, '拉取历史K线超时'
      );
      if (p && p.closes && p.closes.length >= 60) raw = p;
    }
  } catch (e) { raw = null; }
  let parsed = null;
  if (raw && raw.closes && raw.closes.length >= 60) {
    const times = raw.times || [];
    parsed = {
      closes: raw.closes,
      opens: raw.opens || raw.closes,
      times,
      from: raw.from != null ? raw.from : (times.length ? times[0] : now),
      to: raw.to != null ? raw.to : (times.length ? times[times.length - 1] : now)
    };
  }
  if (parsed) { _optHistCache.set(key, parsed); _optWriteStore(sym, tf, days, maxBars, parsed); }
  return parsed;
}

// 对当前币对某周期运行 SRSI 参数优选。
// 异步：先拉取 ~2 年历史 K 线（带进度 loading），再 walk-forward 优选。
// 拉取失败则回退当前屏上 K 线（≤500 根，标注 source:'local'）。
export async function optimizeSrsiForTf(tf, role, opts = {}) {
  tf = tf || cfg.srsiEditTf;
  if (!KLINE_TF.includes(tf)) return null;
  const r = role || roleForTf(tf);
  const days = opts.days != null ? opts.days : 730;
  const deep = !!cfg.srsiOptDeep;
  const grid = deep ? srsiParamGrid() : srsiNeighborhoodGrid();
  const minValSamples = r === 'gate' ? 6 : 15;
  const sym = opts.sym || cfg.symbol;                     // 显式锁定优化目标币对：防异步拉数期间切币导致结果写错币对
  const isCur = sym === cfg.symbol;                       // 优化的是当前展示币对？
  let pv;
  if (isCur) { cfg.srsiOptPreview = cfg.srsiOptPreview || {}; pv = cfg.srsiOptPreview; }
  else pv = {};                                           // 后台优化其它币对：预览走局部对象，不污染当前展示
  pv[tf] = { loading: true, role: r, tf, symbol: sym, ts: Date.now(), days };
  if (isCur && typeof document !== 'undefined') renderControls();

  let data1h = null, dataGate = null, meta = null;
  try {
    if (r === 'gate') {
      const tg = cfg.gateTargetTf || '1h';
      const gateTf = tf; // 闸门周期(被勾选为「辅助只做放行闸门」的周期，默认 15m)，不再硬编码
      const dT = await optFetchKlines(sym, tg, days, 'gate');
      const dG = await optFetchKlines(sym, gateTf, days, 'gate');
      if (dT && dG && dT.closes.length >= 60 && dG.closes.length >= 60) {
        const tail = Math.min(OPT_TAIL_BARS[tg] || dT.closes.length, dT.closes.length); // 目标周期尾窗（1h→15000、4h→3500）
        const startT = Math.max(0, dT.closes.length - tail);
        const closesT = dT.closes.slice(startT), opensT = dT.opens.slice(startT), timesT = dT.times.slice(startT);
        data1h = { closes: closesT, opens: opensT, times: timesT };
        dataGate = { closesG: dG.closes, opensG: dG.opens, timesG: dG.times };
        meta = { bars: closesT.length, from: timesT[0], to: timesT[timesT.length - 1], days, source: 'history', target: tg, gate: gateTf, gateBars: dG.closes.length };
      }
    } else {
      const fetched = await optFetchKlines(sym, tf, days, r);
      if (fetched && fetched.closes && fetched.closes.length >= 60) {
        const tail = Math.min(OPT_TAIL_BARS[tf] || fetched.closes.length, fetched.closes.length);
        const start = Math.max(0, fetched.closes.length - tail);
        const closes = fetched.closes.slice(start);
        const opens = fetched.opens.slice(start);
        const times = fetched.times.slice(start);
        data1h = { closes, opens, times };
        meta = { bars: closes.length, from: times[0] != null ? times[0] : fetched.from, to: times.length ? times[times.length - 1] : fetched.to, days, source: 'history' };
      }
    }
  } catch (e) { data1h = null; }
  if (!data1h || data1h.closes.length < 60) {
    const c = (getTFData(sym, tf).c || []).slice();
    if (c.length >= 60) {
      data1h = { closes: c, opens: (getTFData(sym, tf).o || c).slice(), times: (getTFData(sym, tf).t || []) };
      meta = { bars: c.length, days: 0, source: 'local', note: '无法拉取长历史，已用当前屏上 K 线' };
    }
  }
  if (!data1h || data1h.closes.length < 60 || (r === 'gate' && !dataGate)) {
    delete pv[tf];
    if (isCur && typeof document !== 'undefined') renderControls();
    return null;
  }

  // 记录本次优选覆盖的时间窗口，供回测前「优选过拟合泄漏」自检（A5）
  if (meta && meta.from != null && meta.to != null) {
    setLastOptWindow({ sym, tf, role: r, from: meta.from, to: meta.to, days });
  }

  let res = null;
  try {
    if (r === 'gate') {
      const tg = cfg.gateTargetTf || '1h';
      const targetMs = tfMs(tg);
      const gateMs = tfMs(tf);
      const champ = resolveGateChampion(tg, data1h.closes, data1h.opens);
      // 闸门为固定文献链(15m RSI14/stoch9/K2)放行过滤，非参数优选；见 PDF 手册验收(41笔/73.2%/+1.072%)
      const canonicalGate = { rsiPeriod: 14, stochPeriod: 9, smoothK: 2, smoothD: 2, overbought: 90, oversold: 10 };
      res = optimizeGateBand({
        closesT: data1h.closes, opensT: data1h.opens, timesT: data1h.times,
        closesG: dataGate.closesG, opensG: dataGate.opensG, timesG: dataGate.timesG,
        target: tg, targetMs, gateMs, downstream: champ.params, opts: { grid: GATE_PARAMS_GRID, rollingFolds: 5 }
      });
      res.championOrigin = champ.origin;
      // 先把 best 写入预览（关键：即使下游统计抛异常也不丢闸门优选标记）
      pv[tf] = { ...res, role: r, tf, symbol: sym, ts: Date.now(), ...meta };
      try { res.neighbor = bandNeighborTPos(data1h.closes, data1h.opens, res.best); } catch (_) {}
    } else {
      res = optimizeSrsiBand(data1h.closes, data1h.opens, {
        grid, minValSamples,
        defaultParams: perTfSrsi(tf, cfg.srsiByTf, cfg.srsi)
      });
      // 关键修复（10m 刷新后丢优选）：先把 band 的 best 写入预览。原实现在 optimizeSrsi/ bandNeighborTPos
      // 等后续统计抛异常时整段 catch 返回 null，导致 10m 的 best 永不落盘、永不标记 optimized。
      // 现在 band 一算出 best 就写预览，后续 ATR/邻域统计失败也非致命，10m 仍能被 applySrsiOpt 标记并 persist。
      pv[tf] = { ...res, role: r, tf, symbol: sym, ts: Date.now(), ...meta };
      try {
        const atrRes = optimizeSrsi(data1h.closes, { role: 'swing', grid, minValSamples, defaultParams: perTfSrsi(tf, cfg.srsiByTf, cfg.srsi) });
        res.atr = atrRes;
        res.neighbor = bandNeighborTPos(data1h.closes, data1h.opens, res.best);
      } catch (e2) { /* 非致命：ATR/邻域统计异常不影响主优选(best)落盘 */ }
    }
  } catch (e) {
    // band 主计算异常（真实行情偶发 NaN/数据异常）：回退默认参数，仍写入 best 以便标记 + 持久化
    if (!pv[tf] || !pv[tf].best) {
      const def = perTfSrsi(tf, cfg.srsiByTf, cfg.srsi);
      pv[tf] = { best: def, role: r, tf, symbol: sym, ts: Date.now(), decision: 'fallback', reason: '主优选计算异常，回退默认参数', error: (e && e.message) || String(e), ...meta };
    }
  }
  // Fix3：优选结果直接落盘（去依赖 kOptimizeSrsi 那次异步 apply），防切币竞态/判定跳过丢参数。
  // 仅当 best 非默认时才提交（fallback 的默认 best 不污染 srsiByTf，保留用户既有参数，避免被覆写成默认）。
  if (isCur) {
    const rb = pv[tf] && pv[tf].best;
    if (rb && !isDefaultSrsi(rb)) {
      cfg.srsiByTf[tf] = { ...DEFAULT_SRSI, ...rb };
      cfg.srsiOptSource = cfg.srsiOptSource || {};
      cfg.srsiOptSource[tf] = 'optimized';
    }
    persist();
    try {
      const pwa = readPwaSrsiOpt()[sym] || {}; const sh = (_readJson(STATE_KEY) || {}).bySymbol || {};
      console.log('[SRSI-APPLY] tf=' + tf + ' best=' + JSON.stringify(rb) + ' pwa=' + JSON.stringify(pwa.srsiByTf && pwa.srsiByTf[tf]) + ' sh=' + JSON.stringify(sh[sym] && sh[sym].srsiByTf && sh[sym].srsiByTf[tf]));
    } catch (_) {}
  }
  if (isCur && typeof document !== 'undefined') renderControls();
  return pv[tf] || null;
}
export function applySrsiOpt(tf) {
  tf = tf || cfg.srsiEditTf;
  const p = cfg.srsiOptPreview && cfg.srsiOptPreview[tf];
  // 防御：即便预览缺失 best（极端情况），也用当前参数兜底标记 optimized，保证手动「采用」必落盘
  const best = (p && p.best) ? p.best : perTfSrsi(tf, cfg.srsiByTf, cfg.srsi);
  cfg.srsiByTf[tf] = { ...best };
  cfg.srsi = { ...best };
  cfg.srsiOptSource = cfg.srsiOptSource || {};
  cfg.srsiOptSource[tf] = 'optimized';
  persist(); renderKChart(); if (typeof document !== 'undefined') renderControls();
}
export function clearSrsiOpt(tf) {
  tf = tf || cfg.srsiEditTf;
  cfg.srsiOptPreview = cfg.srsiOptPreview || {};
  cfg.srsiOptSource = cfg.srsiOptSource || {};
  delete cfg.srsiOptPreview[tf]; delete cfg.srsiOptSource[tf];
  persist(); if (typeof document !== 'undefined') renderControls();
}
// 返回该币对配置中第一个已优选的周期（按 KLINE_TF 短→长），无则 null。
// 用于切币/刷新后把「SRSI 各币对各周期参数」面板的编辑周期落在已优选周期上，
// 让用户一打开面板就能看到已恢复的优参（避免落在默认周期位误判"参数丢失"）。
export function firstOptimizedTf(c) {
  const src = c && c.srsiOptSource;
  if (!src || typeof src !== 'object') return null;
  for (const tf of KLINE_TF) { if (src[tf] === 'optimized') return tf; }
  return null;
}
export function setSrsiOptPreview(on) { cfg.optPreviewOn = !!on; persist(); renderKChart(); }
export function setSrsiOptDeep(on) { cfg.srsiOptDeep = !!on; persist(); if (typeof document !== 'undefined') renderControls(); }

// 优选结果卡的 HTML（renderControls 内联渲染）
function fmtDate(ts) {
  if (ts == null) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function optSectionHtml(tf) {
  const p = cfg.srsiOptPreview && cfg.srsiOptPreview[tf];
  if (!p) return '';
  if (p.loading) {
    return `<div class="kchart-srsi-opt"><div class="kchart-srsi-opt-head">⚡ 优选结果 <span class="kchart-srsi-badge warn">拉取历史K线…</span></div>
      <div class="kchart-srsi-opt-metrics">正在拉取约 ${p.days || 730} 天历史 K 线数据，请稍候…</div></div>`;
  }
  if (p.error) {
    return `<div class="kchart-srsi-opt"><div class="kchart-srsi-opt-head">⚡ 优选结果 <span class="kchart-srsi-badge bad">优选失败</span></div>
      <div class="kchart-srsi-opt-metrics">${String(p.error).replace(/</g, '&lt;')}</div></div>`;
  }
  if (!p.best) return '';
  const b = p.best;
  const badge = p.decision === 'adopt' ? '✓ 建议采用' : p.decision === 'caution' ? '⚠ 谨慎采用' : '✗ 不建议';
  const badgeCls = p.decision === 'adopt' ? 'ok' : p.decision === 'caution' ? 'warn' : 'bad';
  const srcTag = cfg.srsiOptSource && cfg.srsiOptSource[tf] === 'optimized' ? ' · 已应用' : '';
  const pct = (x) => (x == null ? '--' : (x >= 0 ? '+' : '') + x.toFixed(1) + '%');
  const f2 = (x) => (x == null ? '--' : (x * 100).toFixed(1) + '%');
  const evStr = (s) => (s && s.ev != null ? (s.ev * 100).toFixed(2) + '%' : '--');
  const tStr = (s) => (s && s.t != null ? s.t.toFixed(2) : '--');
  const ddStr = (s) => (s && s.dd != null ? pct(s.dd * 100) : '--');
  const isGate = p.role === 'gate';
  const paramStr = `${b.rsiPeriod ?? '-'}/${b.stochPeriod ?? '-'}/${b.smoothK ?? '-'}/${b.smoothD ?? '-'} · 带${b.overbought ?? '-'}/${b.oversold ?? '-'}`;
  const defCmp = isGate ? '' : `${p.defFull && p.defFull.stats ? f2(p.defFull.stats.winRate) : '--'} 胜(默认)`;
  const be = p.bestEv, beS = p.bestEvStats;
  const bw = p.bestWin, bwS = p.bestWinStats;
  const evParamStr = be ? `${be.rsiPeriod ?? '-'}/${be.stochPeriod ?? '-'}/${be.smoothK ?? '-'}/${be.smoothD ?? '-'}` : null;
  const winParamStr = bw ? `${bw.rsiPeriod ?? '-'}/${bw.stochPeriod ?? '-'}/${bw.smoothK ?? '-'}/${bw.smoothD ?? '-'}` : null;
  const bestKey = `${b.rsiPeriod}/${b.stochPeriod}/${b.smoothK}/${b.smoothD}`;
  let crossLine = '';
  if (evParamStr && evParamStr !== bestKey) crossLine += `EV最优 ${evParamStr}(${beS ? evStr(beS) : '--'},${beS ? beS.n : '--'}笔) `;
  if (winParamStr && winParamStr !== bestKey && winParamStr !== evParamStr) crossLine += `胜率最优 ${winParamStr}(${bwS ? f2(bwS.winRate) : '--'},${bwS ? bwS.n : '--'}笔)`;

  let dataLine;
  if (p.source === 'history') {
    const spanDays = (p.from && p.to) ? Math.round((p.to - p.from) / 86400000) : (p.days || 0);
    const dataTf = isGate ? (p.target || '1h') : tf;
    const tailBars = OPT_TAIL_BARS[dataTf] || Math.floor((p.days || 730) * 1440 / (tfMs(dataTf) / 60000));
    const reqBars = Math.floor(tailBars * 0.9);
    const full = p.bars >= reqBars;
    const tfLabel = isGate ? `${dataTf}(目标)` : dataTf;
    let s = `数据 ${p.bars} 根 ${tfLabel} (${fmtDate(p.from)}~${fmtDate(p.to)}, ${spanDays}天${full ? '· 满窗口' : `· 不足${tailBars}根请清缓存重拉`})`;
    if (isGate && p.gateBars) {
      const gtf = p.gate || '15m';
      const gtail = OPT_TAIL_BARS[gtf] || Math.floor((p.days || 730) * 1440 / (tfMs(gtf) / 60000));
      const greq = Math.floor(gtail * 0.9);
      s += ` · 闸门${gtf} ${p.gateBars} 根${p.gateBars >= greq ? '· 满' : '· 不足'}`;
    }
    dataLine = s;
  } else {
    dataLine = `数据 ${p.bars} 根（当前屏上 K 线${p.note ? '· ' + p.note : ''}）`;
  }

  let primary, secondary, extra, oosLine = '';
  if (isGate) {
    const tg = p.target || '1h';
    if (!p.stats) {
      primary = '预览数据已过期（结构更新），请重新运行优选';
      secondary = ''; extra = '';    } else {
      const oos = p.oos && p.oos.stats;
      oosLine = oos ? `滚动样本外(${p.oosFolds || 5}折) 胜率${f2(oos.winRate)}/${oos.n}笔/ EV${evStr(oos)}/累计${pct(oos.cum * 100)}/t=${tStr(oos)}` : '';
      primary = `手册离场(闸门放行) 胜率${f2(p.stats.winRate)}/${p.stats.n}笔/ EV${evStr(p.stats)}/累计${pct(p.stats.cum * 100)}/t=${tStr(p.stats)}` +
        (p.downstream ? ` · 下游${tg}冠军 ${p.downstream.rsiPeriod}/${p.downstream.stochPeriod}/${p.downstream.smoothK}/${p.downstream.smoothD}@${p.downstream.overbought}/${p.downstream.oversold}` : '') +
        (p.championOrigin ? ` · 冠军来源(${p.championOrigin})` : '');
      secondary = '';
      extra = '';
    }
  } else {
    const full = p.full ? p.full.stats : null;
    const fullOpen = p.full ? p.full.openCount : 0;
    if (!full) {
      primary = '预览数据已过期（结构更新），请重新运行优选';
      secondary = ''; extra = '';
    } else {
      primary = `手册离场(全样本) 胜率${f2(full.winRate)}/${full.n}笔/ EV${evStr(full)}/累计${pct(full.cum * 100)}/t=${tStr(full)}/回撤${ddStr(full)}${fullOpen ? ` · 持仓中${fullOpen}` : ''}`;
      const atr = p.atr && p.atr.val;
      secondary = atr ? `ATR固定离场(旧) 胜率${f2(atr.winRate)}/${atr.signals}笔/ EV${evStr(atr)}/累计${pct(atr.cumReturnPct)}` : '';
      const oos = p.oos && p.oos.stats;
      oosLine = oos ? `滚动样本外(${p.oosFolds || 5}折) 胜率${f2(oos.winRate)}/${oos.n}笔/ EV${evStr(oos)}/累计${pct(oos.cum * 100)}/t=${tStr(oos)}` : '';
      const nb = p.neighbor;
      extra = nb ? `<br><span class="kchart-srsi-reason">邻域正收益占比 ${nb.pos}/${nb.total} (${(nb.ratio * 100).toFixed(0)}%) · 两半稳定性 ${p.championFilters && p.championFilters.twoHalf ? `h1=${(p.championFilters.twoHalf.h1 * 100).toFixed(2)}%/h2=${(p.championFilters.twoHalf.h2 * 100).toFixed(2)}%` : '—'}</span>` : '';
    }
  }
  const warn = (p.full && p.full.n < 20) || (isGate && p.stats.n < 20) ? `<br><span class="kchart-srsi-warn">⚠ 样本偏少，结论仅供参考（手册 ${p.gate || '15m'} 闸门 2 年亦仅 31 笔）</span>` : '';

  return `<div class="kchart-srsi-opt">
    <div class="kchart-srsi-opt-head">⚡ 优选结果 <span class="kchart-srsi-badge ${badgeCls}">${badge}${srcTag}</span> <span class="kchart-srsi-role">${isGate ? `闸门(${p.gate || '15m'}放行${p.target || '1h'})` : '波段'} · 默认对照 ${defCmp}</span></div>
    <div class="kchart-srsi-opt-params">推荐(样本外最优) ${paramStr}${crossLine ? `<br>${crossLine}` : ''}</div>
    <div class="kchart-srsi-opt-data">${dataLine}</div>
    <div class="kchart-srsi-opt-metrics">${primary}${oosLine ? '<br>' + oosLine : ''}${secondary ? '<br>' + secondary : ''}${extra}<br><span class="kchart-srsi-reason">${p.reason || ''}</span>${warn}</div>
    <div class="kchart-srsi-opt-actions">
      <button class="kchart-srsi-btn" onclick="window.kApplySrsiOpt('${tf}')">应用</button>
      <button class="kchart-srsi-btn" onclick="window.kClearSrsiOpt('${tf}')">放弃</button>
      <button class="kchart-srsi-btn" onclick="window.kSetSrsiOptPreview(true)">预览叠加</button>
      <button class="kchart-srsi-btn" onclick="window.kSetSrsiOptPreview(false)">关预览</button>
    </div>
  </div>`;
}
export function refreshWith(t) { cfg = t || defaultKConfig(); if (!_store) _store = readStore(); _store.lastSymbol = cfg.symbol; persist(); }

// 供 main.js / index.html 暴露
export function kSymbol() { return cfg.symbol; }
export function kConfig() { return cfg; }
export function renderKControls() {
  loadCfg();
  renderControls();
  if (_ctx) { syncCanvasSize(); renderKChart(); }
}

// ---- 工具 ----
function drawGrid(ctx, x0, y0, w, h, rows, labelFn) {
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.fillStyle = '#6b7688';
  ctx.font = '9px monospace';
  for (let r = 0; r <= rows; r++) {
    const y = y0 + (h / rows) * r;
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + w, y); ctx.stroke();
    if (labelFn) { const t = labelFn((r / rows) * 100); ctx.fillText(t, 2, y + 3); }
  }
}
function drawEmpty(ctx, H, msg) {
  ctx.fillStyle = '#6b7688'; ctx.font = '12px monospace';
  ctx.fillText(msg, W / 2 - ctx.measureText(msg).width / 2, H / 2);
}
function fmt(v) {
  if (v == null || !isFinite(v)) return '--';
  if (Math.abs(v) >= 10000) return v.toFixed(0);
  if (Math.abs(v) >= 100) return v.toFixed(2);
  if (Math.abs(v) >= 10) return v.toFixed(2);
  return v.toFixed(4);
}

// ---- hover / 联动读数 纯函数与工具 ----

// 由横向比例 frac(0..1) → 可见窗内柱索引。与绘制一致: start = len - min(bars,len)。
// v1.5.63：时间对齐索引——在 times（升序）中找「时间 <= t 的最后一根」（二分）；无则 -1。
// 用于跨周期 hover 读数：主图某根 K 线时刻 t，在其它周期序列中定位同一时刻的K线。
export function timeAlignIdx(times, t) {
  if (!Array.isArray(times) || !times.length || t == null || !isFinite(t)) return -1;
  let lo = 0, hi = times.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((times[mid] || 0) <= t) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return ans;
}

export function idxFromFrac(frac, len, bars) {
  if (!(len > 0)) return -1;
  const n = Math.min(bars, len);
  if (n < 1) return -1;
  const start = len - n;
  const f = Math.max(0, Math.min(1, frac));
  return start + Math.max(0, Math.min(n - 1, Math.round(f * (n - 1))));
}

// 成交量缩写: >=1e6 → 12.3M, >=1e3 → 4.5K, 否则原样(2位小数)
export function fmtVol(v) {
  if (v == null || !isFinite(v)) return '--';
  const a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(2) + 'K';
  return v.toFixed(2);
}

// 时间戳 → 本地字符串 (ts 毫秒)
export function fmtTime(ts) {
  if (ts == null || !isFinite(ts)) return '--:--:--';
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// 命中面板: 由逻辑 ly 判断落在主图 还是 某个子图区域
function panelFromLy(ly, subRegions, mainBottom) {
  if (ly != null && ly >= PAD_T && ly <= mainBottom) return { kind: 'main' };
  if (subRegions) {
    const reg = subRegions.find(r => ly >= r.y0 && ly <= r.y1);
    if (reg) return { kind: 'sub', key: reg.key, tf: reg.tf };
  }
  return null;
}

// 主图 hover 柱信息 (纯数据)
export function mainHoverAt(frac, sym, tf, bars) {
  const { o, h, l, c, v, t } = nativeMain(sym, tf);
  const i = idxFromFrac(frac, c.length, bars);
  if (i < 0 || i >= c.length) return null;
  const prev = i > 0 ? c[i - 1] : null;
  const chg = (prev != null && isFinite(prev) && prev !== 0) ? (c[i] - prev) / prev * 100 : null;
  return {
    i, time: t[i], open: o[i], high: h[i], low: l[i], close: c[i], vol: v[i], chg
  };
}

// v1.6.22：主图「15m SRSI 机会」点（●，非成交）——由 15m K/D 的穿越/钩信号生成。
// 主图绘制与 hover「标记」行共用同一数据源，保证「看到的点 = 悬停读到的说明」。
// buy 侧：K 跌入超卖区（crossing='buy'）或金钩；sell 侧：K 升入超买区或死钩。
export function srsiOpportunityMarks(c15, t15, bands, srsiParams) {
  const out = [];
  if (!Array.isArray(c15) || !Array.isArray(t15) || c15.length < 2 || t15.length !== c15.length) return out;
  const ob = bands && bands.upper != null ? bands.upper : 80;
  const os = bands && bands.lower != null ? bands.lower : 20;
  const kd = srsiKD(c15.map(Number), srsiParams || {});
  const cross = srsiCrossings(kd.k, { overbought: ob, oversold: os });
  const hooks = srsiHooks(kd.k, kd.d, { overbought: ob, oversold: os });
  for (let i = 0; i < t15.length; i++) {
    const cv = cross[i], hk = hooks[i];
    if (!cv && !hk) continue;
    // 钩信号优先（同时命中时以钩为准），保证 side 与 label 方向永远一致；kind 供主图区分形状（钩=菱形，穿越=圆点）
    let side, label, kind;
    if (hk === 'goldHook') { side = 'long'; kind = 'hook'; label = '◆金钩·看多'; }
    else if (hk === 'deathHook') { side = 'short'; kind = 'hook'; label = '◆死钩·看空'; }
    else if (cv === 'buy') { side = 'long'; kind = 'cross'; label = '●机会 跌入超卖·看多'; }
    else { side = 'short'; kind = 'cross'; label = '●机会 升入超买·看空'; }
    out.push({ t: t15[i], side, kind, label });
  }
  return out;
}

// 主图 hover「标记」行：某根 K 线时间窗 [t0,t1) 内命中的标记文本（α 调仓 / SRSI 成交 / SRSI 机会点）。
// 与主图实际绘制条件一致：α 需基石实盘在跑、SRSI 成交需卫星自动开、机会点需勾选「实盘信号」。
export function markHitsInWindow(t0, t1, { alphaMarks = [], srsiTrades = [], opportunities = [] } = {}) {
  const hits = [];
  const inWin = (t) => Number.isFinite(t) && t >= t0 && t < t1;
  for (const mk of alphaMarks) {
    if (!mk || !inWin(mk.t)) continue;
    hits.push((mk.action === 'close' || mk.dir === 0) ? '◆α平仓(基石)' : mk.dir > 0 ? '◆α开多(基石)' : '◆α开空(基石)');
  }
  for (const tr of srsiTrades) {
    if (!tr || !inWin(tr.t)) continue;
    hits.push(tr.action === 'open' ? (tr.side === 'long' ? '▲SRSI开多(自动)' : '▼SRSI开空(自动)') : '●SRSI平仓(自动)');
  }
  for (const op of opportunities) {
    if (!op || !inWin(op.t)) continue;
    hits.push(op.label);
  }
  return hits;
}

let _oppCache = { key: '', list: [] };
// 主图机会点/钩的最终绘制清单（纯函数，可单测）：**钩优先**——同一根 bar 同侧已有钩时丢弃该侧圆点（用户裁定：钩权重大于机会点）。
// 两侧独立：某根同时有金钩(下)与看空穿越(上)时，金钩留下、上方圆点仍画。
export function filterOpportunityDraws(opps) {
  const list = Array.isArray(opps) ? opps : [];
  const hookKeys = {};
  for (const op of list) if (op && op.kind === 'hook') hookKeys[op.t + '|' + op.side] = 1;
  return list.filter(op => op && (op.kind === 'hook' || !hookKeys[op.t + '|' + op.side]));
}
// 主图机会点访问器（带缓存：500 根 15m 的 srsiKD 不宜每帧重算；hover 与绘制共用 → 一致且便宜）
export function mainOpportunityMarks(sym) {
  const d = getTFData(sym, '15m') || {};
  const c = d.c || [], t = d.t || [];
  const p = perTfSrsi('15m', cfg.srsiByTf, cfg.srsi);
  const bands = resolveEntryBands(cfg);
  const key = sym + '|' + c.length + '|' + (t[t.length - 1] || 0) + '|' + bands.upper + ',' + bands.lower + '|'
    + p.rsiPeriod + ',' + p.stochPeriod + ',' + p.smoothK + ',' + p.smoothD + ',' + p.overbought + ',' + p.oversold;
  if (key === _oppCache.key) return _oppCache.list;
  _oppCache = { key, list: srsiOpportunityMarks(c, t, bands, p) };
  return _oppCache.list;
}

// ============================================================
// v1.6.23：主图标记「微光晕 + 呼吸式微闪」+ 行动卡 DOM 可拖动
// ============================================================
// 呼吸式微闪透明度（纯函数，可单测）：平滑正弦 0..1 → 映射到 [minA,maxA]。
// periodMs 默认 1600ms（“微闪”而非闪烁），非法输入回落默认值。
export function pulseAlpha(tMs, periodMs = 1600, minA = 0.24, maxA = 0.8) {
  const p = (typeof periodMs === 'number' && isFinite(periodMs) && periodMs > 0) ? periodMs : 1600;
  const lo = (typeof minA === 'number' && isFinite(minA)) ? minA : 0.24;
  const hi = (typeof maxA === 'number' && isFinite(maxA)) ? maxA : 0.8;
  const tt = (typeof tMs === 'number' && isFinite(tMs)) ? tMs : 0;
  const ph = ((tt % p) + p) % p / p;
  const s = 0.5 - 0.5 * Math.cos(ph * Math.PI * 2);
  return lo + (hi - lo) * s;
}

// 颜色 → rgba(...,a)（纯函数，可单测）：支持 #rgb / #rrggbb / rgb()/rgba() / 其它（原样加 globalAlpha 不可行时回落 rgba(255,255,255,a)）
export function withAlpha(color, a) {
  const al = (typeof a === 'number' && isFinite(a)) ? Math.max(0, Math.min(1, a)) : 1;
  if (typeof color !== 'string') return 'rgba(255,255,255,' + al + ')';
  const s = color.trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) { const h = m[1]; return 'rgba(' + parseInt(h[0] + h[0], 16) + ',' + parseInt(h[1] + h[1], 16) + ',' + parseInt(h[2] + h[2], 16) + ',' + al + ')'; }
  m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) { const h = m[1]; return 'rgba(' + parseInt(h.slice(0, 2), 16) + ',' + parseInt(h.slice(2, 4), 16) + ',' + parseInt(h.slice(4, 6), 16) + ',' + al + ')'; }
  m = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (m) { const p = m[1].split(',').map(x => x.trim()); if (p.length >= 3) return 'rgba(' + p[0] + ',' + p[1] + ',' + p[2] + ',' + al + ')'; }
  return 'rgba(255,255,255,' + al + ')';
}

// 主图标记样式表（kind → 颜色/形状/半径 + 方向 side）
// v1.6.29：新增 side（'up'|'down'|'none'）——**空/死钩/看空 → 在 K 线上方；多/金钩/看多 → 在 K 线下方**（用户裁定）。
// off 仅作**回退**（geom 缺 h/l 时用）；有 h/l 时改按该根 K 线的高/低点锚定，避免标记落进蜡烛体被覆盖。
const MARK_FX = {
  oppBuy:     { off: 12,  color: '#2ecc71', shape: 'dot',     r: 2.6, side: 'down' },
  oppSell:    { off: -12, color: '#ff6b6b', shape: 'dot',     r: 2.6, side: 'up' },
  hookGold:   { off: 16,  color: '#00E676', shape: 'diamond', r: 5,   side: 'down' },
  hookDeath:  { off: -16, color: '#FF5252', shape: 'diamond', r: 5,   side: 'up' },
  srsiLong:   { off: 26,  color: '#2ecc71', shape: 'triUp',   r: 5,   side: 'down' },
  srsiShort:  { off: -26, color: '#ff6b6b', shape: 'triDown', r: 5,   side: 'up' },
  srsiClose:  { off: 0,   color: '#8899aa', shape: 'dot',     r: 3,   side: 'none' },
  alphaLong:  { off: 36,  color: '#22d3ee', shape: 'diamond', r: 6,   side: 'down' },   // v1.6.29：原在上（-36）→ 改到下（多 → 下方）
  alphaShort: { off: -36, color: '#f59e0b', shape: 'diamond', r: 6,   side: 'up' },
  alphaClose: { off: -36, color: '#8899aa', shape: 'diamond', r: 6,   side: 'none' },
};

// 标记中心 y（纯函数，可单测）：up → 该根 K 线**最高价之上**；down → **最低价之下**；none → 收盘价 + off（旧行为）。
// 有 h/l 时按高低点锚定（避免标记落在蜡烛体内被覆盖）；无 h/l 时回退到 off。结果钳制在主图区内。
export function markAnchorY(geom, kind, ci) {
  if (!geom) return null;
  const { lo, hi, c, h, l } = geom;
  if (!Array.isArray(c) || !Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return null;
  const st = MARK_FX[kind] || MARK_FX.srsiClose;
  const Y = (v) => PAD_T + (hi - v) / (hi - lo) * MAIN_H;
  const cv = c[ci];
  let y = (cv != null && Number.isFinite(cv)) ? Y(cv) + st.off : null;
  const gap = st.r + 5;
  if (st.side === 'up' && Array.isArray(h)) { const hv = h[ci]; if (hv != null && Number.isFinite(hv)) y = Y(hv) - gap; }
  else if (st.side === 'down' && Array.isArray(l)) { const lv = l[ci]; if (lv != null && Number.isFinite(lv)) y = Y(lv) + gap; }
  if (y == null || !Number.isFinite(y)) return null;
  return Math.max(PAD_T + st.r, Math.min(PAD_T + MAIN_H - st.r, y));
}

// 标记清单（纯函数，可单测）：与 drawMain 的绘制条件一致
// opts: { sigOverlay, srsiAutoOn, alphaLive, opportunities, srsiTrades, alphaMarks }
export function buildMarkList({ sigOverlay, srsiAutoOn, alphaLive, opportunities, srsiTrades, alphaMarks } = {}) {
  const out = [];
  if (!sigOverlay) return out;
  for (const op of (opportunities || [])) if (op && Number.isFinite(op.t)) out.push({ t: op.t, kind: op.kind === 'hook' ? (op.side === 'long' ? 'hookGold' : 'hookDeath') : (op.side === 'long' ? 'oppBuy' : 'oppSell') });
  if (srsiAutoOn) for (const tr of (srsiTrades || [])) {
    if (!tr || !Number.isFinite(tr.t)) continue;
    out.push({ t: tr.t, kind: tr.action === 'open' ? (tr.side === 'long' ? 'srsiLong' : 'srsiShort') : 'srsiClose' });
  }
  if (alphaLive) for (const mk of (alphaMarks || [])) {
    if (!mk || !Number.isFinite(mk.t)) continue;
    out.push({ t: mk.t, kind: (mk.action === 'close' || mk.dir === 0) ? 'alphaClose' : mk.dir > 0 ? 'alphaLong' : 'alphaShort' });
  }
  return out;
}

// 标记 → 主图坐标（纯函数，可单测）：geom 为 drawMain 缓存的 { lo,hi,start,n,xStep,c,t }
export function markFxXY(geom, mark) {
  if (!geom || !mark || !Number.isFinite(mark.t)) return null;
  const { lo, hi, start, n, xStep, c, t } = geom;
  if (!Array.isArray(c) || !Array.isArray(t) || !n || !Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return null;
  if (!t.length || mark.t < t[0]) return null;
  let idx = -1;
  for (let i = t.length - 1; i >= start; i--) { if (t[i] <= mark.t) { idx = i; break; } }
  if (idx < start) idx = start;
  const ci = Math.min(idx, c.length - 1);
  const cv = c[ci];
  if (cv == null || !Number.isFinite(cv)) return null;
  const x = PAD_L + (Math.min(idx, start + n - 1) - start) * xStep + xStep / 2;
  const base = PAD_T + (hi - cv) / (hi - lo) * MAIN_H;
  const y = markAnchorY(geom, mark.kind, ci);
  if (y == null) return null;
  const st = MARK_FX[mark.kind] || MARK_FX.srsiClose;
  return { x, base, y, kind: mark.kind, color: st.color, shape: st.shape, r: st.r, side: st.side };
}

// 行动卡视图模型（纯函数，可单测）：canvas 回退与 DOM 浮层共用同一套文案/颜色（避免两处漂移）
export function actionCardView(sym, ac) {
  if (!ac) return null;
  const big = ac.verdict === 'enter' ? ('可入场 ' + (ac.side === 'long' ? '做多' : '做空'))
    : ac.verdict === 'reverse' ? '勿动·与基石反向'
    : ac.verdict === 'noBase' ? '观望·基石中性'
    : '等待 15m 带交叉';
  const color = ac.verdict === 'enter' ? '#2ecc71' : ac.verdict === 'idle' ? '#f59e0b' : '#8899aa';
  const dirTxt = ac.alphaDir === 'long' ? '多' : ac.alphaDir === 'short' ? '空' : '中性';
  const bandTxt = ac.inBand === 'lower' ? 'K,D均在下带(< ' + ac.lower.toFixed(0) + ')'
    : ac.inBand === 'upper' ? 'K,D均在上带(> ' + ac.upper.toFixed(0) + ')'
    : ac.inBand === 'mid' ? 'K,D中带无交叉' : '读数不足';
  const rule = ac.verdict === 'idle' ? '升破 ' + ac.lower.toFixed(0) + ' →多 / 跌破 ' + ac.upper.toFixed(0) + ' →空 · α同向才入场'
    : ac.verdict === 'reverse' ? '反向信号仅提示·勿动（免成本皆负）'
    : ac.verdict === 'noBase' ? '带交叉已现·基石无方向·观望'
    : (ac.cross === 'upExit' ? '升破下带' : '跌破上带') + '·与基石同向·顺势入场';
  const fmtP = (v) => (v != null && Number.isFinite(v)) ? (v >= 100 ? v.toFixed(1) : v.toFixed(3)) : '--';
  const entry = ac.stop != null && ac.target != null
    ? '入场 ' + fmtP(ac.price) + ' / 止损 ' + fmtP(ac.stop) + ' / 目标 ' + fmtP(ac.target) + ' · 仓 卫星 10-15%×5-7x'
    : '入场/止损/目标：待带交叉后给出 · 仓 卫星 10-15%×5-7x';
  const d1 = ac.alphaDataT ? ('日线' + new Date(ac.alphaDataT).toISOString().slice(5, 10) + '收盘') : '';
  // v1.6.24：分段着色——让「不同状态 → 不同颜色」在卡片正文里也看得出来（不只边框+大字）
  //   基石行：α多→绿 / α空→红 / 中性→灰；带态：下带→绿 / 上带→红 / 中带→灰
  //   入场行：可入场时 止损红 / 目标绿（不可入场则整行灰）
  const DIR_GRAY = 'rgba(160,175,190,.85)';
  const SEP = 'rgba(160,175,190,.55)';
  const dirColor = ac.alphaDir === 'long' ? '#2ecc71' : ac.alphaDir === 'short' ? '#ff6b6b' : DIR_GRAY;
  const bandColor = ac.inBand === 'lower' ? '#2ecc71' : ac.inBand === 'upper' ? '#ff6b6b' : 'rgba(200,212,224,.7)';
  const baseTxt = '基石 α' + dirTxt + ' ' + Math.abs((ac.alphaW || 0) * 100).toFixed(0) + '%' + (d1 ? '(' + d1 + ')' : '');
  const subParts = [{ t: baseTxt, c: dirColor }, { t: ' · ', c: SEP }, { t: bandTxt, c: bandColor }];
  const entryStrong = ac.stop != null && ac.target != null;
  const entryParts = entryStrong
    ? [
      { t: '入场 ' + fmtP(ac.price), c: 'rgba(230,238,245,.95)' },
      { t: ' / ', c: SEP },
      { t: '止损 ' + fmtP(ac.stop), c: '#ff6b6b' },
      { t: ' / ', c: SEP },
      { t: '目标 ' + fmtP(ac.target), c: '#2ecc71' },
      { t: ' · 仓 卫星 10-15%×5-7x', c: DIR_GRAY },
    ]
    : [{ t: '入场/止损/目标：待带交叉后给出 · 仓 卫星 10-15%×5-7x', c: 'rgba(160,175,190,.8)' }];
  return {
    color, big,
    title: (sym || cfg.sym) + ' · 15m 带规则',
    sub: baseTxt + ' · ' + bandTxt,
    subParts,
    warn: ac.trendConflict ? ('⚠ 逆日内趋势（' + (ac.intradayTf || '1h') + ' ' + (ac.intradayDir === 'long' ? '↑' : '↓') + '）') : '',
    rule, entry,
    entryParts,
    entryStrong,
    dirColor, bandColor,
  };
}

// 行动卡 HTML（纯函数，可单测）：DOM 浮层用；canvas 回退仍用 actionCardView 的纯文本字段
export function actionCardHtml(v) {
  if (!v) return '';
  const seg = (parts) => (parts || []).map(p => '<span style="color:' + p.c + '">' + p.t + '</span>').join('');
  return '<div class="kac-title">' + v.title + '</div>'
    + '<div class="kac-big" style="color:' + v.color + '">' + v.big + '</div>'
    + '<div class="kac-sub">' + seg(v.subParts) + '</div>'
    + (v.warn ? '<div class="kac-warn">' + v.warn + '</div>' : '')
    + '<div class="kac-rule">' + v.rule + '</div>'
    + '<div class="kac-entry">' + seg(v.entryParts) + '</div>';
}

// 浮层位置钳制（纯函数，可单测）：留 4px 边距，容器小于卡片时贴左上
// （与 ruleMonitor 的 hudClampPos 同语义；不直接复用以免 kchart↔ruleMonitor 静态循环依赖）
export function clampBoxPos(x, y, w, h, bw, bh) {
  if (![x, y, w, h, bw, bh].every(v => typeof v === 'number' && isFinite(v))) return { x: 4, y: 4 };
  const cx = bw - w - 4, cy = bh - h - 4;
  return { x: Math.max(4, Math.min(cx < 4 ? 4 : cx, x)), y: Math.max(4, Math.min(cy < 4 ? 4 : cy, y)) };
}

// 某个子图在 frac 处的读数 (纯数据)
export function subHoverAt(frac, sym, tf, key, bars, opts) {
  const s = subTf(sym, tf);
  const series = s && s.series;
  // v1.5.63：opts.t 存在时按「主图 hover K 线时刻」跨周期时间对齐取值（用户语义：鼠标所指那根 K 线
  // 在各周期的参数值），而非垂直线在子图里的相对位置（不同周期第 p 根时间相差数倍）。
  if (opts && opts.t != null) {
    const base = (key === 'srsi') ? nativeMain(sym, tf) : getTFData(sym, tf);
    const j = timeAlignIdx(base.t, opts.t);
    const safe = (arr) => (j >= 0 && Array.isArray(arr) && j < arr.length) ? arr[j] : null;
    if (key === 'rsi') return { i: j, rsi: safe(series && series.rsi) };
    if (key === 'macd') return { i: j, macd: safe(series && series.macdLine), signal: safe(series && series.macdSignal), hist: safe(series && series.macdHist) };
    if (key === 'srsi') {
      const sl = srsiPanelSeries(base.c, perTfSrsi(tf, cfg.srsiByTf, cfg.srsi), bars) || { k: [], d: [], crossings: [], hooks: [] };
      // sl 是最近 bars 根的局部数组（0..n-1），j 是全量索引 → 局部索引 = j - off
      const off = Math.max(0, base.c.length - Math.min(bars, base.c.length));
      const li = j - off;
      const safeL = (arr) => (li >= 0 && Array.isArray(arr) && li < arr.length) ? arr[li] : null;
      return { i: j, k: safeL(sl.k), d: safeL(sl.d), cross: safeL(sl.crossings) || null, hook: safeL(sl.hooks) || null };
    }
    return { i: j };
  }
  // SRSI 子图已改用原生周/月线（与主图一致）；RSI/MACD 维持原 aggTFData 基准，故按 key 分别取 lenBase。
  const lenBase = (key === 'srsi')
    ? nativeMain(sym, tf).c.length
    : aggTFData(sym, tf).c.length;
  const i = idxFromFrac(frac, lenBase, bars);
  if (key === 'rsi') {
    const v = series && series.rsi ? series.rsi[i] : null;
    return { i, rsi: v };
  }
  if (key === 'macd') {
    return {
      i,
      macd: series && series.macdLine ? series.macdLine[i] : null,
      signal: series && series.macdSignal ? series.macdSignal[i] : null,
      hist: series && series.macdHist ? series.macdHist[i] : null
    };
  }
  if (key === 'srsi') {
    const price = nativeMain(sym, tf).c;
    const sl = srsiPanelSeries(price, perTfSrsi(tf, cfg.srsiByTf, cfg.srsi), bars) || { k: [], d: [], crossings: [], hooks: [] };
    // srsiPanelSeries 把数组切到最后 bars 根(局部索引 0..n-1)，需把绝对索引 i 换算成局部索引
    const off = Math.max(0, price.length - Math.min(bars, price.length));
    const li = i - off;
    // GOAL25：li<0（数据不足 warmup）一律 null，防空数组/缺失字段下负索引崩（触屏取值首次暴露）
    const safe = (arr) => (li >= 0 && Array.isArray(arr) && li < arr.length) ? arr[li] : null;
    return { i, k: safe(sl.k), d: safe(sl.d), cross: safe(sl.crossings) || null, hook: safe(sl.hooks) || null };
  }
  return { i };
}


// 单测导出
export function __buildSubListFor(tfSel, show, order) { const _old = { cfg, klineSel: cfg.klineSel, show: cfg.show, subOrder: cfg.subOrder }; cfg = { ...cfg, klineSel: tfSel, show, subOrder: order }; const list = buildSubList(); cfg.subOrder = _old.subOrder; return list; }
export function __defaultKConfig() { return defaultKConfig(); }
export function __debugKChart() { return { drag: _drag, hover: _hover, hoverBound: _cv ? _cv.__kchartHoverBound : null, subRegions: _subRegions.map(r => ({ key: r.key, tf: r.tf, y0: r.y0, y1: r.y1, idx: r.idx })) }; }

// 对外设置入口（main.js 挂 window）
export const kchartApi = {
  setSymbol: setSym,
  setMainTF,
  setKlineSel,
  setKKMode: (tf, action) => { if (KLINE_TF.includes(tf)) applyKMode(nextKMode(tf, cfg, action)); },
  setKPreset,
  setKOverview,
  toggleOverview,
  setKDisc,
  toggleKDisc,
  kToggleRuleMonitor,
  renderDiscHud,
  hudClampPos,
  renderRuleMonitor,
  ruleMonitorClear,
  ruleOptimizeRun,
  ruleOptimizeApply,
  ruleVersionSwitch,
  srsiAutoStateOf,
  __ruleMonitorTestState,
  manualSignal,
  kToggleTradePanel,
  setSigOverlay,
  setMainTF: (tf) => setMainTF(tf),
  setKlineSel: (tf, on) => setKlineSel(tf, on),
  setDiscEvidence: (v) => { cfg.discEvidenceOpen = !!v; persist(); },
  setBars,
  setShow,
  setSrsi,
  setSrsiTf,
  setSrsiAux,
  setGateTarget,
  setMainOverlay,
  setMainOverlayTf,
  resetSrsi: () => { resetSrsi(); },
  renderControls: renderKControls,
  render: renderKChart,
  renderMainTools,
  refreshPanels,
  init: initKChart,
  getConfig: () => cfg,
  defaultConfig: defaultKConfig,
  debug: __debugKChart,
  setTradeEngine,
  setTradeConfig,
  renderQuickTrade,
  checkUserTpSl,
  openOrderManager,
  closeOrderManager,
  reversePosition,
  copyCfgToAll,
  resetSymbolCfg,
  setPwaMode,
  isPwaMode,
  openSrsiCardFor,
  setSrsiAutoOn,
  setSrsiAutoMode,
  blockReasonText,
  blockGuideText,
  storageTop,
  saveSignalMarks,
  restoreSignalMarks,
  mainOpportunityMarks,
  filterOpportunityDraws,
  markHitsInWindow,
  srsiOpportunityMarks,
  maRelInfo,
  setMaRel,
  __maRelData: () => maRelData(),
  mainMarkList,
  buildMarkList,
  markFxXY,
  markAnchorY,
  __mainGeom: () => _mainGeom,
  pulseAlpha,
  withAlpha,
  legendItems,
  renderLegendHtml,
  actionCardView,
  actionCardHtml,
  clampBoxPos,
  getTradeEngine: () => _tradeEngine,
  toggleOvQuickTf,
  optimizeSrsiForTf,
  applyOptToSym,
  applySrsiOpt,
  clearSrsiOpt,
  setSrsiOptPreview,
  setSrsiOptDeep,
  // 单测钩子
  __testStore: () => _store,
  __clearStore: () => { _store = { __v: 2, lastSymbol: null, bySymbol: {} }; try { localStorage.removeItem(STATE_KEY); } catch (e) {} },
  clearBacktestStore,
  __setCfgForTest: (c) => { cfg = c; },
  __persist: persist,
  __load: loadCfg,
  loadCfg: loadCfg,
  __getCfg: () => cfg,
  __normalizeCfg: normalizeCfg,
  __overlayTfsList: overlayTfsList,
  __mainChartSrsiPlan: mainChartSrsiPlan,
  __buildDiscSig: buildDiscSig,
  __alignedSrsiOverlay: alignedSrsiOverlay,
  __ovQuickChips: ovQuickChips,
  __legendBoxes: () => _legendBoxes,
  __toggleOvQuickTf: toggleOvQuickTf,
  __setOptFetch,
  __getOptHistCache,
  __optimizeSrsiForTf: optimizeSrsiForTf,
  __applySrsiOpt: applySrsiOpt,
  __clearSrsiOpt: clearSrsiOpt,
  __setSrsiOptPreview: setSrsiOptPreview,
  __setSrsiOptDeep: setSrsiOptDeep,
  setSrsiLead,
  setAlphaSignal,
  updateSignalWatch,
  signalEngineStatus,
  __srsiSpeedInfo: srsiSpeedInfo,
  __speedGrade: speedGrade,
  __fmtLag: fmtLag,
  __pickLeadParams: pickLeadParams,
  __srsiLeadInfo: srsiLeadInfo,
  updateSrsiProjLive,
  srsiProximityNow,
  __roleForTf: roleForTf,
  __optSectionHtml: optSectionHtml,
  runSrsiAutoTrade,
  maybeAutoOpt,
  runSrsiAutoOptimizeAll,
  srsiAutoOptStatus,
  computeDirectionScore,
  srsiAutoBandState,
  bandEdge,
  klineDirFromCloses,
  srsiDirFromKD,
  backtestSrsiAuto,
  fetchKlinesRange,
  runSrsiBacktest,
  __setBacktestFetch,
  __getBtStore,
  renderSrsiAutoPanel,
  resetSrsiAuto,
  klineDirOf,
  srsiDirOf
};
if (typeof window !== 'undefined') window.kchartApi = kchartApi;

// ===================== 快捷合约交易（纸面）=====================
// 方向定死：空=U本位 / 多=币本位；平仓利润的 50% 自动再投到另一资产。
// 引擎由主系统 / PWA 各自注入(setTradeEngine)，UI 仅依赖 PaperEngine 接口：
//   engine.S.prices[sym].last / engine.S.pos / engine.getPerpSub() / engine.placeOrder / engine.exitPosition
let _tradeEngine = null;
let _tradeOn = true;
let _tradeLinked = true;
let _lev = 10;
let _sizePct = 50;
let _fixedAmt = 100;
let _useFixed = false;
let _safeguard = true;
let _arm = { side: null, t: 0 };
let _armPos = null, _armT = 0;

export function setTradeEngine(e) { _tradeEngine = e; renderQuickTrade(); }

// GOAL8：供 Alpha 实验室「应用组合策略」一键开启 SRSI 自动交易（与手动勾选 ktSrsiAuto 同路径）
export function setSrsiAutoOn(on) {
  cfg.srsiAutoOn = !!on;
  persist();
  if (!cfg.srsiAutoOn) resetSrsiAuto(cfg.symbol);
  renderSrsiAutoPanel();
  if (typeof document !== 'undefined') {
    const aEl = document.getElementById('ktSrsiAuto');
    if (aEl) aEl.checked = cfg.srsiAutoOn;
  // fix(1.5.50): 原 bar.querySelector —— bar 未定义致 setSrsiAutoOn 必抛 ReferenceError（GOAL9 引入的笔误，元素 id 全局唯一）
  const abEl = document.querySelector('#ktSrsiApplyBt');
  if (abEl) abEl.checked = !!cfg.srsiAutoApplyBt;
  const alEl = document.querySelector('#ktAlphaLive');
  // GOAL17：Alpha 基石实盘勾选持久化——刷新后按 cfg 自动恢复 live
  if (alEl && typeof window !== 'undefined' && window.__alphaLab && window.__alphaLab.startLive) {
    if (cfg.alphaLiveOn && !window.__alphaLab.isLive()) { try { window.__alphaLab.startLive(); } catch (e) {} }
    alEl.checked = cfg.alphaLiveOn && window.__alphaLab.isLive();
  } else if (alEl) alEl.checked = false;
  // GOAL18-B/GOAL24：手机/PAD 拇指区快捷条（触屏设备固定底部，≥44px；强制两段确认 + 状态行）
  syncThumbBar();
  const stEl = document.getElementById('ktPanelState');
  if (stEl) {
    const sOn = cfg.srsiAutoOn, aOn = typeof window !== 'undefined' && window.__alphaLab && window.__alphaLab.isLive && window.__alphaLab.isLive();
    stEl.innerHTML = (aOn ? '<span style="color:#22d3ee">●Alpha实盘</span> ' : '') + (sOn ? '<span style="color:#2ecc71">●SRSI自动</span>' : '') + (!sOn && !aOn ? '<span style="opacity:.6">未启用策略</span>' : '');
  }
  }
}
// GOAL26：拇指条底部叠层偏移 = Tab条(PWA 触屏常驻)可见高 + 安装条可见高；桌面无这些元素返回 0
export function ktStackOffset() {
  if (typeof document === 'undefined') return 0;
  let h = 0;
  const tab = document.getElementById('pwaTabBar');
  if (tab && tab.offsetHeight > 0) h += tab.offsetHeight;
  const inst = document.getElementById('pwaInstall');
  if (inst && !inst.hidden && inst.offsetHeight > 0) h += inst.offsetHeight;
  return h;
}

// GOAL24：拇指条骨架构建 + 就地同步（状态行/arm 确认态/显隐）；与 renderQuickTrade 同数据源、每秒主循环驱动
function syncThumbBar() {
  if (typeof document === 'undefined') return;
  let tb = document.getElementById('ktThumbBar');
  const coarse = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(pointer:coarse)').matches;
  if (!coarse || !_tradeOn || !_tradeEngine) { if (tb) tb.style.display = 'none'; return; }
  if (!tb) {
    tb = document.createElement('div');
    tb.id = 'ktThumbBar';
    tb.innerHTML = '<div id="ktThumbStatus"></div><div id="ktThumbBtns">'
      + '<button id="ktTbLong" class="kt-tb-long">▲ 开多</button>'
      + '<button id="ktTbClose" class="kt-tb-close">平仓</button>'
      + '<button id="ktTbShort" class="kt-tb-short">▼ 开空</button>'
      + '<button id="ktTbOrders" class="kt-tb-panel">☰ 持仓</button></div>';
    document.body.appendChild(tb);
    // 强制防误触：forceArm=true → 无视 _safeguard 开关，首次点=arm，3s 内再点=执行
    tb.querySelector('#ktTbLong').addEventListener('click', () => kchartTradeOpen('long', true));
    tb.querySelector('#ktTbShort').addEventListener('click', () => kchartTradeOpen('short', true));
    tb.querySelector('#ktTbClose').addEventListener('click', () => kchartTradeClose(true));
    tb.querySelector('#ktTbOrders').addEventListener('click', () => openOrderManager({ tab: 'positions' }));
  }
  tb.style.display = 'flex';
  // 2026-09-18：PWA 下把拇指条**并入底部栈**（插到 #pwaTabBar 之前，随文档流排布），
  // 彻底消除「拇指条与底部导航之间的空隙」——此前用 position:fixed + ktStackOffset 计算偏移，
  // 在真机上会被 zoom / safe-area / 安装条高度 / 视口高度差异算出空隙（headless 无 zoom/safe-area 所以复现不出）。
  // 主系统无 #pwaTabBar，保持原 fixed 行为不变。
  const _tabHost = document.getElementById('pwaTabBar');
  const _pwaStack = (_tabHost && _tabHost.parentElement) ? _tabHost.parentElement : null;
  if (_pwaStack) {
    if (tb.parentElement !== _pwaStack || tb.nextElementSibling !== _tabHost) _pwaStack.insertBefore(tb, _tabHost);
    tb.style.position = 'relative'; tb.style.left = 'auto'; tb.style.right = 'auto'; tb.style.bottom = 'auto';
  } else {
    if (tb.parentElement !== document.body) document.body.appendChild(tb);
    tb.style.position = 'fixed'; tb.style.left = '0'; tb.style.right = '0';
    tb.style.bottom = ktStackOffset() + 'px';
  }
  const sym = cfg.symbol;
  const pos = ((_tradeEngine.S && _tradeEngine.S.pos) || []).find(p => p.sym === sym);
  const price = (_tradeEngine.S && _tradeEngine.S.prices && _tradeEngine.S.prices[sym] && _tradeEngine.S.prices[sym].last) || null;
  const st = document.getElementById('ktThumbStatus');
  if (st) {
    const px = price != null ? _fmt(price, price >= 100 ? 1 : 4) : '--';
    let html = '<b>' + sym + '</b> ' + px;
    if (pos) {
      const pnl = _fmt(pos.pnl || 0, 1), pct = _fmt(pos.pnlPct || 0, 1);
      const col = (pos.pnl || 0) >= 0 ? '#2ecc71' : '#ff4d6d';
      html += '　<span style="color:' + col + '">' + (pos.side === 'long' ? '▲多' : '▼空') + pos.lev + 'x ' + pnl + '(' + pct + '%)</span>';
    } else {
      html += '　<span style="opacity:.55">无持仓</span>';
    }
    st.innerHTML = html;
  }
  const armShort = _arm.side === 'short' && Date.now() - _arm.t < 3000;
  const armLong = _arm.side === 'long' && Date.now() - _arm.t < 3000;
  const armClose = _arm.side === 'close' && Date.now() - _arm.t < 3000;
  const bL = tb.querySelector('#ktTbLong'), bS = tb.querySelector('#ktTbShort'), bC = tb.querySelector('#ktTbClose');
  if (bL) { bL.textContent = armLong ? '确认开多?' : '▲ 开多'; bL.classList.toggle('armed', armLong); }
  if (bS) { bS.textContent = armShort ? '确认开空?' : '▼ 开空'; bS.classList.toggle('armed', armShort); }
  if (bC) { bC.textContent = armClose ? '确认平仓?' : '平仓'; bC.classList.toggle('armed', armClose); }
}

// GOAL9：把最近一次回测的参数快照应用到实盘自动交易（bt=_btCfgLoad()，eff=_btOverlayFor 产物）
export function applyBtSnapshot(bt, eff) {
  if (!bt) return false;
  try {
    if (eff && eff.srsiByTf) cfg.srsiByTf = JSON.parse(JSON.stringify(eff.srsiByTf));
    if (eff && eff.srsi) cfg.srsi = { ...cfg.srsi, ...eff.srsi };
    cfg.srsiOptSource = cfg.srsiOptSource || {};
    ['15m', '30m', '1h', '4h'].forEach(tf => { if (cfg.srsiByTf && cfg.srsiByTf[tf]) cfg.srsiOptSource[tf] = 'optimized'; });
    const nums = { lev: 'srsiAutoLev', pct: 'srsiAutoBasePct', maxSame: 'srsiAutoMaxSame', upper: 'srsiAutoUpper', lower: 'srsiAutoLower', reversePct: 'srsiAutoReversePct', reverseLev: 'srsiAutoReverseLev', revConfirm: 'srsiAutoRevConfirm', confirmBars: 'srsiAutoConfirmBars', stopPct: 'srsiAutoStopPct', adaptiveLevMin: 'srsiAutoAdaptiveLevMin', atrStopMult: 'srsiAutoAtrStopMult', capUsdt: 'srsiAutoOpenCapUsdt', capCoin: 'srsiAutoOpenCapCoin' };
    for (const [k, ck] of Object.entries(nums)) if (typeof bt[k] === 'number' && isFinite(bt[k])) cfg[ck] = bt[k];
    const bools = { hotStop: 'srsiAutoHotStop', adaptiveLev: 'srsiAutoAdaptiveLev', atrStop: 'srsiAutoAtrStop' };
    for (const [k, ck] of Object.entries(bools)) if (typeof bt[k] === 'boolean') cfg[ck] = bt[k];
    if (typeof bt.danger === 'string') cfg.srsiAutoDangerAlarm = bt.danger !== 'none';
    cfg.srsiAutoBtSnapAt = Date.now();
    persist();
    renderSrsiAutoPanel();
    return true;
  } catch (e) { return false; }
}
export function setTradeConfig(c) {
  if (c) {
    if (typeof c.on === 'boolean') _tradeOn = c.on;
    if (typeof c.linked === 'boolean') _tradeLinked = c.linked;
    if (typeof c.lev === 'number') _lev = c.lev;
    // GOAL17：快捷交易开关/联动持久化（外部未注入时下次启动从 cfg 恢复）
    if (typeof c.on === 'boolean') cfg.tradeOn = c.on;
    if (typeof c.linked === 'boolean') cfg.tradeLinked = c.linked;
    if (c.on !== undefined || c.linked !== undefined || c.lev !== undefined) persist();
  }
  renderQuickTrade();
}

function _fmt(n, d = 2) { return (n == null || isNaN(n)) ? '0' : Number(n).toFixed(d); }
function _tradeBar() { return typeof document !== 'undefined' ? document.getElementById('kchartTradeBar') : null; }

function renderQuickTrade() {
  const bar = _tradeBar();
  if (!bar) return;
  if (!_tradeOn) { bar.innerHTML = '<div class="kt-off">快捷交易已关闭（设置中可开启）</div>'; bar._built = false; syncThumbBar(); return; }
  const sym = cfg.symbol;
  const engine = _tradeEngine;
  let perp = null, price = null, pos = null, usdt = 0, coin = 0;
  if (engine && engine.S) {
    perp = engine.getPerpSub ? engine.getPerpSub() : null;
    price = (engine.S.prices && engine.S.prices[sym] && engine.S.prices[sym].last) || null;
    pos = (engine.S.pos || []).find(p => p.sym === sym);
    if (perp) { usdt = perp.bal || 0; coin = (perp.coins && perp.coins[sym]) || 0; }
  }
  if (!engine) {
    bar.innerHTML = '<div class="kt-off">交易引擎未连接</div>';
    bar._built = false;
    syncThumbBar();
    return;
  }
  // GOAL24：arm 判定纯时效（_safeguard=false 但 forceArm 的 thumb 路径也能正确显示确认态）
  const armShort = _arm.side === 'short' && Date.now() - _arm.t < 3000;
  const armLong = _arm.side === 'long' && Date.now() - _arm.t < 3000;
  const armClose = _arm.side === 'close' && Date.now() - _arm.t < 3000;
  // 首次构建骨架(含监听)，之后仅就地更新动态值，避免每次 render 重建按钮导致真实点击失效
  if (!bar._built) {
    bar.innerHTML = `
    <div class="kt-row">
      <span class="kt-label">杠杆</span>
      <input id="ktLev" class="kt-lev" type="range" min="1" max="30" />
      <span id="ktLevV" class="kt-val"></span>
      <label class="kt-toggle"><input id="ktFixed" type="checkbox"/>固定数额</label>
      <span id="ktSizeWrap" class="kt-size">
        <input id="ktPct" class="kt-pct" type="range" min="1" max="100" />
        <span id="ktPctV" class="kt-val"></span>
        <input id="ktFixedAmt" class="kt-amt" type="number" min="0" step="any" />
      </span>
      <label class="kt-toggle"><input id="ktSafe" type="checkbox"/>防误触</label>
    </div>
    <div class="kt-row">
      <span id="ktAvail" class="kt-avail"></span>
      <span id="ktPrice" class="kt-price"></span>
    </div>
    <div class="kt-row kt-btns">
      <button id="ktShort" class="kt-btn kt-short"></button>
      <button id="ktLong" class="kt-btn kt-long"></button>
      <button id="ktHistory" class="kt-btn kt-orders"></button>
      <button id="ktOrders" class="kt-btn kt-orders"></button>
    </div>
    <div class="kt-row kt-auto">
      <label class="kt-toggle kt-strat"><input id="ktAlphaLive" type="checkbox"/>Alpha 基石实盘(paper)</label>
      <label class="kt-toggle kt-strat"><input id="ktSrsiAuto" type="checkbox"/>SRSI 自动永续合约(卫星)</label>
      <label class="kt-mini kt-strat" title="GOAL9：勾选后，回测设置里跑完回测会自动把回测参数（SRSI 周期参数+杠杆/仓位/带/防爆等）应用到实盘自动交易，免逐项手配；主图同步显示实时交易信号（与实盘交易一一对应）"><input id="ktSrsiApplyBt" type="checkbox"/>SRSI·应用回测参数</label>
      <label class="kt-toggle">本位
        <select id="ktSrsiMode">
          <option value="follow">跟随</option>
          <option value="usdt">U本位</option>
          <option value="coin">币本位</option>
        </select>
      </label>
    </div>
    <div class="kt-row kt-auto-cfg">
      <label class="kt-mini">本金比例%<input id="ktSrsiBase" class="kt-num" type="number" min="1" max="100" step="1"/></label>
      <label class="kt-mini">杠杆x<input id="ktSrsiLev" class="kt-num" type="number" min="1" max="30" step="1"/></label>
      <label class="kt-mini">同方向最多<input id="ktSrsiMax" class="kt-num" type="number" min="1" max="10" step="1"/>单</label>
      <label class="kt-mini">确认bar<input id="ktSrsiConfirm" class="kt-num" type="number" min="0" max="5" step="1"/> (0=关·GOAL27)</label>
      <label class="kt-mini">regime闸门<select id="ktSrsiRegime" class="kt-sel"><option value="off">关</option><option value="confirm">中波降频</option><option value="size">中波减仓</option><option value="block">仅阴跌禁开</option><option value="tconf">趋势升确认</option></select> (GOAL29)</label>
      <label class="kt-mini">闸门EMA<select id="ktSrsiEmaTf" class="kt-sel"><option value="1h">1h</option><option value="1d">1d</option></select></label>
      <label class="kt-mini" title="GOAL31-D：predictDanger 多因子（1h/15m EMA偏离/K15超买卖/近根振幅/EMA120背离）≥2 命中→拦截该笔普通开仓（反手单不拦）"><input id="ktSrsiPdBlock" type="checkbox"/>危险拦截</label>
      <label class="kt-mini"><input id="ktSrsiCloseManual" type="checkbox"/>自动可平人工单</label>
      <label class="kt-mini">上限带(0=15m优选)<input id="ktSrsiUp" class="kt-num" type="number" min="0" max="100" step="1"/></label>
      <label class="kt-mini">下限带(0=15m优选)<input id="ktSrsiLo" class="kt-num" type="number" min="0" max="50" step="1"/></label>
      <label class="kt-mini">开仓上限U<input id="ktSrsiCapUsdt" class="kt-num" type="number" min="0" step="1"/> (0不限)</label>
      <label class="kt-mini">开仓上限币<input id="ktSrsiCapCoin" class="kt-num" type="number" min="0" step="0.0001"/> (0不限)</label>
    </div>
    <div class="kt-row kt-auto-danger">
      <span class="kt-mini">危险信号防爆
        <label><input type="radio" name="ktSrsiDanger" value="none" checked/>关</label>
        <label><input type="radio" name="ktSrsiDanger" value="filter"/>预防爆仓</label>
        <label><input type="radio" name="ktSrsiDanger" value="smart"/>预防爆仓(智能)</label>
        <label><input type="radio" name="ktSrsiDanger" value="reverse"/>防爆反手</label>
        <label><input type="radio" name="ktSrsiDanger" value="revconf"/>防爆反手(确认)</label>
      </span>
      <label class="kt-mini">反手确认%<input id="ktSrsiRevConfirm" class="kt-num" type="number" min="0" max="20" step="0.5"/> (revconf)</label>
      <label class="kt-mini">反手开仓%<input id="ktSrsiRevPct" class="kt-num" type="number" min="0" max="100" step="1"/> (0=同正常)</label>
      <label class="kt-mini">反手杠杆x<input id="ktSrsiRevLev" class="kt-num" type="number" min="0" max="30" step="1"/></label>
      <label class="kt-mini"><input id="ktSrsiDangerAlarm" type="checkbox"/>危险信号红色提醒</label>
      <label class="kt-mini"><input id="ktSrsiHotStop" type="checkbox"/>热停开(1h ATR 放大禁新仓)</label>
    </div>
    <div class="kt-row kt-auto-risk">
      <label class="kt-mini"><input id="ktSrsiAdaptiveLev" type="checkbox"/>自适应杠杆(波动放大降杠杆)</label>
      <label class="kt-mini">自适应下限x<input id="ktSrsiAdaptiveLevMin" class="kt-num" type="number" min="1" max="30" step="1"/></label>
      <label class="kt-mini"><input id="ktSrsiAtrStop" type="checkbox"/>宽保护性止损(ATR)</label>
      <label class="kt-mini">止损倍数×ATR<input id="ktSrsiAtrStopMult" class="kt-num" type="number" min="0.1" max="20" step="0.1"/></label>
    </div>
    <div class="kt-row kt-auto-opt">
      <label class="kt-mini"><input id="ktSrsiOpt" type="checkbox"/>自动优选4周期</label>
      <label class="kt-mini"><input id="ktSrsiOptIntOn" type="checkbox"/>间隔重优选</label>
      <label class="kt-mini">重优选间隔h<input id="ktSrsiOptInt" class="kt-num" type="number" min="0.5" max="168" step="0.5"/></label>
      <label class="kt-mini">无成交超h<input id="ktSrsiOptNoTr" class="kt-num" type="number" min="0.5" max="168" step="0.5"/></label>
      <button id="ktSrsiOptNow" class="kt-btn kt-bt">立即优选</button>
    </div>
    <div id="ktSrsiAutoPanel" class="kt-auto-panel"></div>
    <div class="kt-bt-section">
      <div class="kt-bt-head"><span>回测设置</span><button id="ktBtClear" class="kt-btn kt-bt" type="button">清空回测</button><button id="ktBtToggle" class="kt-btn kt-bt" type="button">▸</button></div>
      <div id="ktBtBody" class="kt-bt-body">
        <div class="kt-row kt-bt-strategy" title="策略选择：Alpha 为基石策略（GOAL11 长窗验证 2018-2026 跨窗口/跨账户稳定），SRSI 为卫星层（需防爆+regime 闸门验证后配资金）">
          <label class="kt-strat"><input type="radio" name="ktBtStrat" value="alpha"/>Alpha 实验（基石策略 ★ 参数固化）</label>
          <label class="kt-strat"><input type="radio" name="ktBtStrat" value="srsi"/>SRSI 策略（15m 自动交易·卫星层）</label>
          <label class="kt-strat"><input type="radio" name="ktBtStrat" value="combo"/>SRSI + Alpha 组合（vol 倒数 30d 分配）</label>
        </div>
        <div class="kt-row kt-auto-bt">
          <span class="kt-mini">账户类型
            <select id="ktBtMode" class="kt-sel">
              <option value="perp">永续合约</option>
              <option value="spot">现货</option>
            </select>
          </span>
          <span class="kt-mini">本位
            <select id="ktBtMargin" class="kt-sel">
              <option value="follow">跟随</option>
              <option value="usdt">U本位</option>
              <option value="coin">币本位</option>
            </select>
          </span>
          <span class="kt-mini">回测本金U$<input id="ktBtPrincipal" class="kt-num" type="number" min="10" step="10" value="1000"/></span>
          <span class="kt-mini">回测本币<input id="ktBtCoin" class="kt-num" type="number" min="0" step="0.0001" value="0"/> (可选)</span>
          <span class="kt-mini">手续费%<input id="ktBtFee" class="kt-num" type="number" min="0" step="0.001" value="0.045"/></span>
          <span class="kt-mini">滑点%<input id="ktBtSlip" class="kt-num" type="number" min="0" step="0.005" value="0.02"/></span>
          <label class="kt-mini"><input id="ktBtCost" type="checkbox" checked/>含交易成本</label>
        </div>
        <div class="kt-row kt-auto-bt-cfg">
          <label class="kt-mini">开仓比例%<input id="ktBtPct" class="kt-num" type="number" min="1" max="100" step="1"/></label>
          <label class="kt-mini">杠杆x<input id="ktBtLev" class="kt-num" type="number" min="1" max="30" step="1"/></label>
          <label class="kt-mini">同方向最多<input id="ktBtMax" class="kt-num" type="number" min="1" max="10" step="1"/>单</label>
          <label class="kt-mini">确认bar<input id="ktBtConfirm" class="kt-num" type="number" min="0" max="5" step="1"/> (0=关)</label>
          <label class="kt-mini">regime闸门<select id="ktBtRegime" class="kt-sel"><option value="off">关</option><option value="confirm">中波降频</option><option value="size">中波减仓</option><option value="block">仅阴跌禁开</option><option value="tconf">趋势升确认</option></select> (GOAL29)</label>
          <label class="kt-mini">闸门EMA<select id="ktBtEmaTf" class="kt-sel"><option value="1h">1h</option><option value="1d">1d</option></select></label>
          <label class="kt-mini" title="GOAL31-D：predictDanger 多因子≥2 命中→拦截该笔普通开仓（反手单不拦）"><input id="ktBtPdBlock" type="checkbox"/>危险拦截</label>
          <label class="kt-mini">上限带<input id="ktBtUp" class="kt-num" type="number" min="50" max="100" step="1"/></label>
          <label class="kt-mini">下限带<input id="ktBtLo" class="kt-num" type="number" min="0" max="50" step="1"/></label>
          <label class="kt-mini">开仓上限U<input id="ktBtCapU" class="kt-num" type="number" min="0" step="1"/> (0不限)</label>
          <label class="kt-mini">开仓上限币<input id="ktBtCapC" class="kt-num" type="number" min="0" step="0.0001"/> (0不限)</label>
          <label class="kt-mini">开仓下限U<input id="ktBtFloorU" class="kt-num" type="number" min="0" step="1"/> (0不限)</label>
          <label class="kt-mini">开仓下限币<input id="ktBtFloorC" class="kt-num" type="number" min="0" step="0.0001"/> (0不限)</label>
        </div>
        <div class="kt-row kt-auto-danger">
          <span class="kt-mini">危险信号防爆
            <label><input type="radio" name="btSrsiDanger" value="none" checked/>关</label>
            <label><input type="radio" name="btSrsiDanger" value="filter"/>预防爆仓</label>
            <label><input type="radio" name="btSrsiDanger" value="reverse"/>防爆反手</label>
            <label><input type="radio" name="btSrsiDanger" value="smart"/>预防爆仓(智能)</label>
            <label><input type="radio" name="btSrsiDanger" value="revconf"/>防爆反手(确认)</label>
          </span>
          <label class="kt-mini">反手开仓%<input id="btSrsiRevPct" class="kt-num" type="number" min="0" max="100" step="1"/> (0=同正常)</label>
          <label class="kt-mini">反手杠杆x<input id="btSrsiRevLev" class="kt-num" type="number" min="0" max="30" step="1"/></label>
          <label class="kt-mini">反手确认%<input id="btSrsiRevConfirm" class="kt-num" type="number" min="0" max="20" step="0.5"/> (revconf:价格逆向突破才开反)</label>
          <label class="kt-mini">硬止损%<input id="btSrsiStop" class="kt-num" type="number" min="0" max="50" step="0.5"/> (0=关；均值回归策略慎用)</label>
          <label class="kt-mini"><input id="ktBtHotStop" type="checkbox"/>热停开(1h ATR 放大禁新仓)</label>
        </div>
        <div class="kt-row kt-bt-risk">
          <label class="kt-mini"><input id="btBtAdaptiveLev" type="checkbox"/>自适应杠杆(波动放大降杠杆)</label>
          <label class="kt-mini">下限x<input id="btBtAdaptiveLevMin" class="kt-num" type="number" min="1" max="30" step="1"/></label>
          <label class="kt-mini"><input id="btBtAtrStop" type="checkbox"/>宽保护性止损(ATR)</label>
          <label class="kt-mini">×ATR<input id="btBtAtrStopMult" class="kt-num" type="number" min="0.1" max="20" step="0.1"/></label>
        </div>
        <div class="kt-row kt-auto-bt-opt">
          <span class="kt-mini">自动优选周期
            <label><input type="checkbox" id="ktBtOpt15"/>15m</label>
            <label><input type="checkbox" id="ktBtOpt30"/>30m</label>
            <label><input type="checkbox" id="ktBtOpt1h"/>1h</label>
            <label><input type="checkbox" id="ktBtOpt4h"/>4h</label>
          </span>
          <label class="kt-mini"><input id="ktBtMarks" type="checkbox"/>主图标注回测信号</label>
          <label class="kt-mini"><input id="ktBtOptOn" type="checkbox"/>自动优选</label>
          <label class="kt-mini"><input id="ktBtOptIntOn" type="checkbox"/>间隔重优选</label>
          <label class="kt-mini">重优选间隔h<input id="ktBtOptInt" class="kt-num" type="number" min="0.5" max="168" step="0.5"/></label>
          <label class="kt-mini">无成交超h<input id="ktBtOptNoTr" class="kt-num" type="number" min="0.5" max="168" step="0.5"/></label>
        </div>
        <div class="kt-row kt-auto-bt-btns">
          <button id="ktBt24h" class="kt-btn kt-bt">24小时</button>
          <button id="ktBt7d" class="kt-btn kt-bt">7天</button>
          <button id="ktBt30d" class="kt-btn kt-bt">30天</button>
          <button id="ktBt90d" class="kt-btn kt-bt">90天</button>
          <button id="ktBt180d" class="kt-btn kt-bt">180天</button>
          <button id="ktBt365d" class="kt-btn kt-bt">1年</button>
        </div>
        <div id="ktSrsiBtResult" class="kt-bt-result"></div>
        <div id="ktAlphaSlot" class="kt-alpha-slot"></div>
      </div>
    </div>
    <div id="ktPos" class="kt-row kt-pos"></div>`;
    const b = bar;
    b.querySelector('#ktLev').addEventListener('input', () => { _lev = +b.querySelector('#ktLev').value; b.querySelector('#ktLevV').textContent = _lev + 'x'; });
    b.querySelector('#ktFixed').addEventListener('change', () => { _useFixed = b.querySelector('#ktFixed').checked; cfg.ktUseFixed = _useFixed; persist(); renderQuickTrade(); }); // GOAL17
    b.querySelector('#ktPct').addEventListener('input', () => { _sizePct = +b.querySelector('#ktPct').value; b.querySelector('#ktPctV').textContent = _sizePct + '%'; });
    b.querySelector('#ktFixedAmt').addEventListener('input', () => { _fixedAmt = parseFloat(b.querySelector('#ktFixedAmt').value) || 0; });
    b.querySelector('#ktSafe').addEventListener('change', () => { _safeguard = b.querySelector('#ktSafe').checked; cfg.ktSafe = _safeguard; persist(); }); // GOAL17
    b.querySelector('#ktShort').addEventListener('click', () => kchartTradeOpen('short'));
    b.querySelector('#ktLong').addEventListener('click', () => kchartTradeOpen('long'));
    b.querySelector('#ktHistory').addEventListener('click', () => openOrderManager({ tab: 'history' }));
    b.querySelector('#ktOrders').addEventListener('click', () => openOrderManager({ tab: 'positions' }));
    b.querySelector('#ktSrsiAuto').addEventListener('change', () => {
      cfg.srsiAutoOn = b.querySelector('#ktSrsiAuto').checked;
      persist();
      if (!cfg.srsiAutoOn) resetSrsiAuto(cfg.symbol);
      renderSrsiAutoPanel();
    });
    // GOAL12：Alpha 基石实盘开关（接 Alpha 实验室 live；仅 PWA 有 alphaLab）
    b.querySelector('#ktAlphaLive').addEventListener('change', () => {
      const on = b.querySelector('#ktAlphaLive').checked;
      if (typeof window === 'undefined' || !window.__alphaLab || !window.__alphaLab.startLive) {
        b.querySelector('#ktAlphaLive').checked = false;
        renderTradeLog && renderTradeLog('Alpha 基石实盘仅 PWA（kchart.html）可用：未加载 Alpha 实验室');
        return;
      }
      if (on) window.__alphaLab.startLive(); else window.__alphaLab.stopLive();
      cfg.alphaLiveOn = on; persist(); // GOAL17：勾选持久，刷新恢复
    });
    // GOAL9：应用回测参数开关；勾选时若已有回测快照则立即应用
    b.querySelector('#ktSrsiApplyBt').addEventListener('change', () => {
      cfg.srsiAutoApplyBt = b.querySelector('#ktSrsiApplyBt').checked;
      persist();
      if (cfg.srsiAutoApplyBt && typeof window !== 'undefined' && window.__srsiBtEff) {
        applyBtSnapshot(_btCfgLoad(), window.__srsiBtEff);
        renderQuickTrade();
      }
    });
    b.querySelector('#ktSrsiMode').addEventListener('change', () => { cfg.srsiAutoMode = b.querySelector('#ktSrsiMode').value; persist(); });
    const _clampNum = (n, lo, hi, def) => { n = +n; if (!isFinite(n)) n = def; return Math.max(lo, Math.min(hi, Math.round(n))); };
    b.querySelector('#ktSrsiBase').addEventListener('input', () => { cfg.srsiAutoBasePct = _clampNum(b.querySelector('#ktSrsiBase').value, 1, 100, 10); persist(); });
    b.querySelector('#ktSrsiLev').addEventListener('input', () => { cfg.srsiAutoLev = _clampNum(b.querySelector('#ktSrsiLev').value, 1, 30, 5); persist(); });
    b.querySelector('#ktSrsiMax').addEventListener('input', () => { cfg.srsiAutoMaxSame = _clampNum(b.querySelector('#ktSrsiMax').value, 1, 10, 3); persist(); });
    b.querySelector('#ktSrsiCloseManual').addEventListener('change', () => { cfg.srsiAutoCloseManual = b.querySelector('#ktSrsiCloseManual').checked; persist(); renderSrsiAutoPanel(); });
    b.querySelector('#ktSrsiUp').addEventListener('input', () => {
      const v = b.querySelector('#ktSrsiUp').value;
      cfg.srsiAutoUpper = (v === '' || v === '0' || Number(v) === 0) ? 0 : _clampNum(v, 50, 100, 90);
      persist();
    });
    b.querySelector('#ktSrsiLo').addEventListener('input', () => {
      const v = b.querySelector('#ktSrsiLo').value;
      cfg.srsiAutoLower = (v === '' || v === '0' || Number(v) === 0) ? 0 : _clampNum(v, 0, 50, 10);
      persist();
    });
    const _clampNumRaw = (n, lo, def) => { n = +n; if (!isFinite(n)) n = def; return Math.max(lo, n); };
    b.querySelector('#ktSrsiCapUsdt').addEventListener('input', () => { cfg.srsiAutoOpenCapUsdt = _clampNumRaw(b.querySelector('#ktSrsiCapUsdt').value, 0, 0); persist(); });
    b.querySelector('#ktSrsiCapCoin').addEventListener('input', () => { cfg.srsiAutoOpenCapCoin = _clampNumRaw(b.querySelector('#ktSrsiCapCoin').value, 0, 0); persist(); });
    b.querySelectorAll('input[name="ktSrsiDanger"]').forEach(r => r.addEventListener('change', () => {
      const sel = b.querySelector('input[name="ktSrsiDanger"]:checked');
      cfg.srsiAutoDanger = sel ? sel.value : 'none'; persist();
    }));
    b.querySelector('#ktSrsiRevPct').addEventListener('input', () => { cfg.srsiAutoReversePct = Math.max(0, Math.min(100, +b.querySelector('#ktSrsiRevPct').value || 0)); persist(); });
    b.querySelector('#ktSrsiRevLev').addEventListener('input', () => { cfg.srsiAutoReverseLev = Math.max(0, Math.min(30, +b.querySelector('#ktSrsiRevLev').value || 0)); persist(); });
    const _revConfEl = b.querySelector('#ktSrsiRevConfirm');
    if (_revConfEl) _revConfEl.addEventListener('input', () => { cfg.srsiAutoRevConfirm = Math.max(0, Math.min(20, +_revConfEl.value || 0)); persist(); });
    const _confBarsEl = b.querySelector('#ktSrsiConfirm');
    if (_confBarsEl) _confBarsEl.addEventListener('input', () => { cfg.srsiAutoConfirmBars = Math.max(0, Math.min(5, Math.round(+_confBarsEl.value || 0))); persist(); });
    const _regimeEl = b.querySelector('#ktSrsiRegime');
    if (_regimeEl) _regimeEl.addEventListener('change', () => { cfg.srsiAutoRegimeGate = _regimeEl.value; persist(); });
    const _emaTfEl = b.querySelector('#ktSrsiEmaTf');
    if (_emaTfEl) _emaTfEl.addEventListener('change', () => { cfg.srsiAutoRegimeEmaTf = _emaTfEl.value; persist(); });
    const _pdBlockEl = b.querySelector('#ktSrsiPdBlock');
    if (_pdBlockEl) _pdBlockEl.addEventListener('change', () => { cfg.srsiAutoPdBlockOn = !!_pdBlockEl.checked; persist(); });
    b.querySelector('#ktSrsiDangerAlarm').addEventListener('change', () => { cfg.srsiAutoDangerAlarm = !!b.querySelector('#ktSrsiDangerAlarm').checked; persist(); });
    b.querySelector('#ktSrsiHotStop').addEventListener('change', () => { cfg.srsiAutoHotStop = !!b.querySelector('#ktSrsiHotStop').checked; persist(); });
    b.querySelector('#ktSrsiAdaptiveLev').addEventListener('change', () => { cfg.srsiAutoAdaptiveLev = !!b.querySelector('#ktSrsiAdaptiveLev').checked; persist(); });
    b.querySelector('#ktSrsiAdaptiveLevMin').addEventListener('input', () => { cfg.srsiAutoAdaptiveLevMin = _clampNum(b.querySelector('#ktSrsiAdaptiveLevMin').value, 1, 30, 2); persist(); });
    b.querySelector('#ktSrsiAtrStop').addEventListener('change', () => { cfg.srsiAutoAtrStop = !!b.querySelector('#ktSrsiAtrStop').checked; persist(); });
    b.querySelector('#ktSrsiAtrStopMult').addEventListener('input', () => { cfg.srsiAutoAtrStopMult = _clampNum(b.querySelector('#ktSrsiAtrStopMult').value, 0.1, 20, 2.0); persist(); });
    b.querySelector('#ktSrsiOpt').addEventListener('change', () => {
      cfg.srsiAutoOptEnabled = b.querySelector('#ktSrsiOpt').checked;
      persist();
      if (cfg.srsiAutoOptEnabled) runSrsiAutoOptimizeAll(false);
      renderSrsiAutoPanel();
    });
    b.querySelector('#ktSrsiOptInt').addEventListener('input', () => { cfg.srsiAutoOptIntervalH = _clampNum(b.querySelector('#ktSrsiOptInt').value, 0.5, 168, 5); persist(); });
    b.querySelector('#ktSrsiOptIntOn').addEventListener('change', () => { cfg.srsiAutoOptIntervalOn = b.querySelector('#ktSrsiOptIntOn').checked; persist(); });
    b.querySelector('#ktSrsiOptNoTr').addEventListener('input', () => { cfg.srsiAutoOptNoTradeH = _clampNum(b.querySelector('#ktSrsiOptNoTr').value, 0.5, 168, 5); persist(); });
    b.querySelector('#ktSrsiOptNow').addEventListener('click', () => { runSrsiAutoOptimizeAll(true); renderSrsiAutoPanel(); });
    const _btSet = (patch, rerun, force) => { Object.assign(_btCfg, patch); _btCfgSave(); if (rerun) runSrsiBacktest(_btLastDays || 7, { force: !!force }); };
    const _btNum = (id) => { const v = parseFloat(b.querySelector('#' + id).value); return isFinite(v) ? v : 0; };
    b.querySelector('#ktBtPrincipal').addEventListener('input', () => { _btSet({ principal: _clampNum(b.querySelector('#ktBtPrincipal').value, 10, 1000000, 1000) }, true); });
    const modeEl = b.querySelector('#ktBtMode');
    if (modeEl) {
      modeEl.value = _btCfg.accountType === 'spot' ? 'spot' : 'perp';
      modeEl.addEventListener('change', () => { _btSet({ accountType: modeEl.value === 'spot' ? 'spot' : 'perp' }, true); });
    }
    const marginEl = b.querySelector('#ktBtMargin');
    if (marginEl) {
      marginEl.value = _btCfg.marginMode || 'follow';
      marginEl.addEventListener('change', () => { _btSet({ marginMode: marginEl.value }, true); });
    }
    b.querySelector('#ktBtCoin').addEventListener('input', () => { _btSet({ coin: Math.max(0, +b.querySelector('#ktBtCoin').value || 0) }, true); });
    b.querySelector('#ktBtFee').addEventListener('input', () => { _btSet({ feePct: _btNum('ktBtFee') }, true); });
    b.querySelector('#ktBtSlip').addEventListener('input', () => { _btSet({ slipPct: _btNum('ktBtSlip') }, true); });
    b.querySelector('#ktBtCost').addEventListener('change', () => { _btSet({ useCost: b.querySelector('#ktBtCost').checked }, true, true); });
    b.querySelector('#ktBtPct').addEventListener('input', () => { _btSet({ pct: _clampNum(b.querySelector('#ktBtPct').value, 1, 100, 10) }); });
    b.querySelector('#ktBtLev').addEventListener('input', () => { _btSet({ lev: _clampNum(b.querySelector('#ktBtLev').value, 1, 30, 5) }); });
    b.querySelector('#ktBtMax').addEventListener('input', () => { _btSet({ maxSame: _clampNum(b.querySelector('#ktBtMax').value, 1, 10, 3) }); });
    b.querySelector('#ktBtConfirm').addEventListener('input', () => { _btSet({ confirmBars: Math.max(0, Math.min(5, Math.round(+b.querySelector('#ktBtConfirm').value || 0))) }); });
    b.querySelector('#ktBtRegime').addEventListener('change', () => { _btSet({ regimeGate: b.querySelector('#ktBtRegime').value }, true); });
    const _btPdBlockEl = b.querySelector('#ktBtPdBlock');
    if (_btPdBlockEl) _btPdBlockEl.addEventListener('change', () => { _btSet({ pdBlockOn: !!_btPdBlockEl.checked }, true); });
    b.querySelector('#ktBtEmaTf').addEventListener('change', () => { _btSet({ regimeEmaTf: b.querySelector('#ktBtEmaTf').value }, true); });
    b.querySelector('#ktBtUp').addEventListener('input', () => { _btSet({ upper: _clampNum(b.querySelector('#ktBtUp').value, 50, 100, 90) }); });
    b.querySelector('#ktBtLo').addEventListener('input', () => { _btSet({ lower: _clampNum(b.querySelector('#ktBtLo').value, 0, 50, 10) }); });
    b.querySelector('#ktBtCapU').addEventListener('input', () => { _btSet({ capUsdt: Math.max(0, +b.querySelector('#ktBtCapU').value || 0) }); });
    b.querySelector('#ktBtCapC').addEventListener('input', () => { _btSet({ capCoin: Math.max(0, +b.querySelector('#ktBtCapC').value || 0) }); });
    b.querySelector('#ktBtFloorU').addEventListener('input', () => { _btSet({ floorUsdt: Math.max(0, +b.querySelector('#ktBtFloorU').value || 0) }); });
    b.querySelector('#ktBtFloorC').addEventListener('input', () => { _btSet({ floorCoin: Math.max(0, +b.querySelector('#ktBtFloorC').value || 0) }); });
    b.querySelectorAll('input[name="btSrsiDanger"]').forEach(r => r.addEventListener('change', () => {
      const sel = b.querySelector('input[name="btSrsiDanger"]:checked');
      _btSet({ danger: sel ? sel.value : 'none' });
    }));
    b.querySelector('#btSrsiRevPct').addEventListener('input', () => { _btSet({ reversePct: Math.max(0, Math.min(100, +b.querySelector('#btSrsiRevPct').value || 0)) }); });
    b.querySelector('#btSrsiRevLev').addEventListener('input', () => { _btSet({ reverseLev: Math.max(0, Math.min(30, +b.querySelector('#btSrsiRevLev').value || 0)) }); });
    b.querySelector('#btSrsiRevConfirm').addEventListener('input', () => { _btSet({ revConfirm: Math.max(0, Math.min(20, +b.querySelector('#btSrsiRevConfirm').value || 0)) }); });
    b.querySelector('#btSrsiStop').addEventListener('input', () => { _btSet({ stopPct: Math.max(0, Math.min(50, +b.querySelector('#btSrsiStop').value || 0)) }); });
    b.querySelector('#ktBtHotStop').addEventListener('change', () => { _btSet({ hotStop: b.querySelector('#ktBtHotStop').checked }); });
    b.querySelector('#btBtAdaptiveLev').addEventListener('change', () => { _btSet({ adaptiveLev: b.querySelector('#btBtAdaptiveLev').checked }); });
    b.querySelector('#btBtAdaptiveLevMin').addEventListener('input', () => { _btSet({ adaptiveLevMin: _clampNum(b.querySelector('#btBtAdaptiveLevMin').value, 1, 30, 2) }); });
    b.querySelector('#btBtAtrStop').addEventListener('change', () => { _btSet({ atrStop: b.querySelector('#btBtAtrStop').checked }); });
    b.querySelector('#btBtAtrStopMult').addEventListener('input', () => { _btSet({ atrStopMult: _clampNum(b.querySelector('#btBtAtrStopMult').value, 0.1, 20, 2.0) }); });
    const _btOptSync = () => {
      const tfs = [];
      if (b.querySelector('#ktBtOpt15').checked) tfs.push('15m');
      if (b.querySelector('#ktBtOpt30').checked) tfs.push('30m');
      if (b.querySelector('#ktBtOpt1h').checked) tfs.push('1h');
      if (b.querySelector('#ktBtOpt4h').checked) tfs.push('4h');
      return tfs;
    };
    ['ktBtOpt15', 'ktBtOpt30', 'ktBtOpt1h', 'ktBtOpt4h'].forEach((id) => {
      const el = b.querySelector('#' + id);
      if (el) el.addEventListener('change', () => { _btSet({ optTfs: _btOptSync() }, true); });
    });
    b.querySelector('#ktBtOptOn').addEventListener('change', () => { _btSet({ optEnabled: b.querySelector('#ktBtOptOn').checked }); });
    // GOAL12：策略选择（alpha 基石第一；srsi；combo=原 alphaCombo 路径）；不自动重跑
    b.querySelectorAll('input[name=ktBtStrat]').forEach(r => r.addEventListener('change', () => { _btSet({ btStrategy: r.value, alphaCombo: r.value === 'combo' }, false); }));
    b.querySelector('#ktBtMarks').addEventListener('change', () => { _btSet({ btMarks: b.querySelector('#ktBtMarks').checked }, false); renderKChart(); });
    b.querySelector('#ktBtOptIntOn').addEventListener('change', () => { _btSet({ optIntervalOn: b.querySelector('#ktBtOptIntOn').checked }); });
    b.querySelector('#ktBtOptInt').addEventListener('input', () => { _btSet({ optIntervalH: _clampNum(b.querySelector('#ktBtOptInt').value, 0.5, 168, 5) }); });
    b.querySelector('#ktBtOptNoTr').addEventListener('input', () => { _btSet({ optNoTradeH: _clampNum(b.querySelector('#ktBtOptNoTr').value, 0.5, 168, 5) }); });
    b.querySelector('#ktBt24h').addEventListener('click', () => openBacktestConfirm(1));
    b.querySelector('#ktBt7d').addEventListener('click', () => openBacktestConfirm(7));
    b.querySelector('#ktBt30d').addEventListener('click', () => openBacktestConfirm(30));
    b.querySelector('#ktBt90d').addEventListener('click', () => openBacktestConfirm(90));
    b.querySelector('#ktBt180d').addEventListener('click', () => openBacktestConfirm(180));
    b.querySelector('#ktBt365d').addEventListener('click', () => openBacktestConfirm(365));
    b.querySelector('.kt-bt-head').addEventListener('click', () => {
      _btCfg.collapsed = !_btCfg.collapsed;
      _btCfgSave();
      const body = b.querySelector('#ktBtBody'), tog = b.querySelector('#ktBtToggle');
      if (body) body.style.display = _btCfg.collapsed ? 'none' : '';
      if (tog) tog.textContent = _btCfg.collapsed ? '▸' : '▾';
    });
    b.querySelector('#ktBtClear').addEventListener('click', (e) => {
      e.stopPropagation();   // 避免触发外层 .kt-bt-head 的折叠切换
      if (typeof confirm === 'function' && !confirm('清空当前币对「' + cfg.symbol + '」的本地回测数据（结果/原始K线/资金费）？')) return;
      clearBacktestStore(cfg.symbol);
      const el = (typeof document !== 'undefined') ? document.getElementById('ktSrsiBtResult') : null;
      if (el) el.innerHTML = '';
    });
    bar._built = true;
    renderSavedBacktest();
  }
  // ---- 就地更新动态值（不重建 DOM，按钮/监听保持存活）----
  const q = (id) => bar.querySelector('#' + id);
  q('ktLev').value = _lev; q('ktLevV').textContent = _lev + 'x';
  _useFixed = cfg.ktUseFixed; _safeguard = cfg.ktSafe; // GOAL17：从 cfg 恢复
  q('ktFixed').checked = _useFixed; q('ktSafe').checked = _safeguard;
  // GOAL21：策略勾选视觉对齐（用户反馈刷新丢勾选——此前恢复只在 setSrsiAutoOn/alphaLab 路径，主路径缺失）
  const _q = (id) => bar.querySelector('#' + id);
  const sa2 = _q('ktSrsiAuto'); if (sa2) sa2.checked = !!cfg.srsiAutoOn;
  const ab2 = _q('ktSrsiApplyBt'); if (ab2) ab2.checked = !!cfg.srsiAutoApplyBt;
  const al2 = _q('ktAlphaLive'); if (al2) al2.checked = !!(cfg.alphaLiveOn && typeof window !== 'undefined' && window.__alphaLab && window.__alphaLab.isLive && window.__alphaLab.isLive());
  q('ktPct').value = _sizePct; q('ktPctV').textContent = _sizePct + '%';
  q('ktFixedAmt').value = _fixedAmt;
  q('ktPct').style.display = _useFixed ? 'none' : '';
  q('ktPctV').style.display = _useFixed ? 'none' : '';
  q('ktFixedAmt').style.display = _useFixed ? '' : 'none';
  q('ktAvail').innerHTML = `可用USDT <b>${_fmt(usdt)}</b> · 可用${sym} <b>${_fmt(coin, 6)}</b>`;
  q('ktPrice').textContent = price ? '价 $' + _fmt(price) : '无行情';
  const bS = q('ktShort'); bS.textContent = armShort ? '确认开空?' : 'U本位 开空'; bS.classList.toggle('armed', armShort);
  const bL = q('ktLong'); bL.textContent = armLong ? '确认开多?' : '币本位 开多'; bL.classList.toggle('armed', armLong);
  const histCount = (engine && engine.S && engine.S.closed) ? engine.S.closed.filter(c => c.sym === cfg.symbol).length : 0;
  q('ktHistory').textContent = '历史(' + histCount + ')';
  q('ktOrders').textContent = '持仓(' + ((engine && engine.S && engine.S.pos) ? engine.S.pos.length : 0) + ')';
  const curPos = (engine && engine.S && engine.S.pos) ? engine.S.pos.filter(p => p.sym === sym) : [];
  q('ktPos').innerHTML = curPos.length
    ? curPos.map(p => {
        const srcTag = p.src === 'srsiAuto' ? '<span class="kt-src auto">自动</span>' : '<span class="kt-src manual">人工</span>';
        const srcNote = p.reinvest ? ' · 50%再投' : '';
        return `<div class="kt-pos-row">${srcTag} <b class="${p.side === 'long' ? 'up' : 'down'}">${p.side === 'long' ? '多' : '空'}</b> ${p.lev}x @ $${_fmt(p.entry)} · 浮盈 $${_fmt(p.pnl)} · ${p.marginMode === 'coin' ? '币本位' : 'U本位'}${srcNote}<button class="kt-pos-close" onclick="kchartTradeClosePos('${p.orderId}')">平</button></div>`;
      }).join('')
    : '当前币无持仓';
  // SRSI 自动交易 UI 同步
  const aEl = bar.querySelector('#ktSrsiAuto'), mEl = bar.querySelector('#ktSrsiMode');
  if (aEl) aEl.checked = cfg.srsiAutoOn;
  if (mEl) mEl.value = cfg.srsiAutoMode;
  const baseEl = bar.querySelector('#ktSrsiBase'), levEl = bar.querySelector('#ktSrsiLev'), maxEl = bar.querySelector('#ktSrsiMax'), prEl = bar.querySelector('#ktBtPrincipal');
  const upEl = bar.querySelector('#ktSrsiUp'), loEl = bar.querySelector('#ktSrsiLo');
  if (baseEl) baseEl.value = cfg.srsiAutoBasePct;
  if (levEl) levEl.value = cfg.srsiAutoLev;
  if (maxEl) maxEl.value = cfg.srsiAutoMaxSame;
  const cmEl = bar.querySelector('#ktSrsiCloseManual');
  if (cmEl) cmEl.checked = !!cfg.srsiAutoCloseManual;
  if (prEl) prEl.value = _btCfg.principal;
  const feeEl = bar.querySelector('#ktBtFee'), slipEl = bar.querySelector('#ktBtSlip'), costEl = bar.querySelector('#ktBtCost');
  if (feeEl) feeEl.value = ((_btCfg.feePct != null ? _btCfg.feePct : 0.045)).toFixed(3).replace(/\.?0+$/, '');
  if (slipEl) slipEl.value = ((_btCfg.slipPct != null ? _btCfg.slipPct : 0.02)).toFixed(3).replace(/\.?0+$/, '');
  if (costEl) costEl.checked = _btCfg.useCost !== false;
  if (upEl) upEl.value = cfg.srsiAutoUpper;
  if (loEl) loEl.value = cfg.srsiAutoLower;
  const capUsdtEl = bar.querySelector('#ktSrsiCapUsdt'), capCoinEl = bar.querySelector('#ktSrsiCapCoin');
  if (capUsdtEl) capUsdtEl.value = cfg.srsiAutoOpenCapUsdt;
  if (capCoinEl) capCoinEl.value = cfg.srsiAutoOpenCapCoin;
  const dEl = bar.querySelector('input[name="ktSrsiDanger"][value="' + (cfg.srsiAutoDanger || 'none') + '"]');
  if (dEl) dEl.checked = true;
  const revPctEl = bar.querySelector('#ktSrsiRevPct'), revLevEl = bar.querySelector('#ktSrsiRevLev'), alarmEl = bar.querySelector('#ktSrsiDangerAlarm'), revConfEl = bar.querySelector('#ktSrsiRevConfirm');
  if (revPctEl) revPctEl.value = cfg.srsiAutoReversePct;
  if (revLevEl) revLevEl.value = cfg.srsiAutoReverseLev;
  if (revConfEl) revConfEl.value = cfg.srsiAutoRevConfirm;
  const confBarsEl = bar.querySelector('#ktSrsiConfirm');
  if (confBarsEl) confBarsEl.value = cfg.srsiAutoConfirmBars;
  const regimeGateEl = bar.querySelector('#ktSrsiRegime');
  if (regimeGateEl) regimeGateEl.value = cfg.srsiAutoRegimeGate || 'off';
  const emaTfEl = bar.querySelector('#ktSrsiEmaTf');
  if (emaTfEl) emaTfEl.value = cfg.srsiAutoRegimeEmaTf || '1h';
  const pdBlockEl = bar.querySelector('#ktSrsiPdBlock');
  if (pdBlockEl) pdBlockEl.checked = !!cfg.srsiAutoPdBlockOn;
  if (alarmEl) alarmEl.checked = !!cfg.srsiAutoDangerAlarm;
  const hotStopEl = bar.querySelector('#ktSrsiHotStop');
  if (hotStopEl) hotStopEl.checked = !!cfg.srsiAutoHotStop;
  const adpLevEl = bar.querySelector('#ktSrsiAdaptiveLev'), adpLevMinEl = bar.querySelector('#ktSrsiAdaptiveLevMin');
  const atrStopEl = bar.querySelector('#ktSrsiAtrStop'), atrStopMultEl = bar.querySelector('#ktSrsiAtrStopMult');
  if (adpLevEl) adpLevEl.checked = !!cfg.srsiAutoAdaptiveLev;
  if (adpLevMinEl) adpLevMinEl.value = cfg.srsiAutoAdaptiveLevMin;
  if (atrStopEl) atrStopEl.checked = !!cfg.srsiAutoAtrStop;
  if (atrStopMultEl) atrStopMultEl.value = cfg.srsiAutoAtrStopMult;
  const optEl = bar.querySelector('#ktSrsiOpt'), intEl = bar.querySelector('#ktSrsiOptInt'), noTrEl = bar.querySelector('#ktSrsiOptNoTr');
  if (optEl) optEl.checked = cfg.srsiAutoOptEnabled;
  if (intEl) intEl.value = cfg.srsiAutoOptIntervalH;
  const intOnEl = bar.querySelector('#ktSrsiOptIntOn'); if (intOnEl) intOnEl.checked = cfg.srsiAutoOptIntervalOn;
  if (noTrEl) noTrEl.value = cfg.srsiAutoOptNoTradeH;
  // 回测设置面板（独立 btCfg）同步各控件值
  const _btVal = (id, v) => { const el = bar.querySelector('#' + id); if (el) el.value = v; };
  const _btChk = (id, v) => { const el = bar.querySelector('#' + id); if (el) el.checked = !!v; };
  const mEl2 = bar.querySelector('#ktBtMode'); if (mEl2) mEl2.value = _btCfg.accountType === 'spot' ? 'spot' : 'perp';
  const mgEl = bar.querySelector('#ktBtMargin'); if (mgEl) mgEl.value = _btCfg.marginMode || 'follow';
  _btVal('ktBtCoin', _btCfg.coin);
  _btVal('ktBtPct', _btCfg.pct);
  _btVal('ktBtLev', _btCfg.lev);
  _btVal('ktBtMax', _btCfg.maxSame);
  _btVal('ktBtConfirm', _btCfg.confirmBars);
  const _btRegimeEl = bar.querySelector('#ktBtRegime'); if (_btRegimeEl) _btRegimeEl.value = _btCfg.regimeGate || 'off';
  const _btPdBlockSyncEl = bar.querySelector('#ktBtPdBlock'); if (_btPdBlockSyncEl) _btPdBlockSyncEl.checked = !!_btCfg.pdBlockOn;
  const _btEmaTfEl = bar.querySelector('#ktBtEmaTf'); if (_btEmaTfEl) _btEmaTfEl.value = _btCfg.regimeEmaTf || '1h';
  _btVal('ktBtUp', _btCfg.upper);
  _btVal('ktBtLo', _btCfg.lower);
  _btVal('ktBtCapU', _btCfg.capUsdt);
  _btVal('ktBtCapC', _btCfg.capCoin);
  _btVal('ktBtFloorU', _btCfg.floorUsdt);
  _btVal('ktBtFloorC', _btCfg.floorCoin);
  _btChk('ktBtOpt15', _btCfg.optTfs.indexOf('15m') >= 0);
  _btChk('ktBtOpt30', _btCfg.optTfs.indexOf('30m') >= 0);
  _btChk('ktBtOpt1h', _btCfg.optTfs.indexOf('1h') >= 0);
  _btChk('ktBtOpt4h', _btCfg.optTfs.indexOf('4h') >= 0);
  _btChk('ktBtOptOn', _btCfg.optEnabled);
  bar.querySelectorAll('input[name=ktBtStrat]').forEach(r => { r.checked = r.value === (_btCfg.btStrategy || 'alpha'); });
  _btChk('ktBtMarks', !!_btCfg.btMarks);
  _btChk('ktBtOptIntOn', _btCfg.optIntervalOn);
  _btVal('ktBtOptInt', _btCfg.optIntervalH);
  _btVal('ktBtOptNoTr', _btCfg.optNoTradeH);
  const dEl2 = bar.querySelector('input[name="btSrsiDanger"][value="' + (_btCfg.danger || 'none') + '"]');
  if (dEl2) dEl2.checked = true;
  _btVal('btSrsiRevPct', _btCfg.reversePct);
  _btVal('btSrsiRevLev', _btCfg.reverseLev);
  _btVal('btSrsiRevConfirm', _btCfg.revConfirm);
  _btVal('btSrsiStop', _btCfg.stopPct);
  _btChk('ktBtHotStop', _btCfg.hotStop);
  _btChk('btBtAdaptiveLev', _btCfg.adaptiveLev);
  _btVal('btBtAdaptiveLevMin', _btCfg.adaptiveLevMin);
  _btChk('btBtAtrStop', _btCfg.atrStop);
  _btVal('btBtAtrStopMult', _btCfg.atrStopMult);
  // 回测设置面板收起/展开（默认收起，记忆状态）
  const btBody = bar.querySelector('#ktBtBody'), btTog = bar.querySelector('#ktBtToggle');
  if (btBody) btBody.style.display = _btCfg.collapsed ? 'none' : '';
  if (btTog) btTog.textContent = _btCfg.collapsed ? '▸' : '▾';
  renderSrsiAutoPanel();
  syncThumbBar();   // GOAL24：拇指条与交易条同频刷新（每秒主循环驱动）
}

// GOAL24：forceArm=true 时无视 _safeguard 开关强制两段确认（拇指条/手机必经）
export function kchartTradeOpen(side, forceArm) {
  if (!_tradeOn || !_tradeEngine) return;
  const sym = cfg.symbol;
  const mm = side === 'short' ? 'usdt' : 'coin';
  const engine = _tradeEngine;
  const sub = engine.getPerpSub ? engine.getPerpSub() : null;
  if (!sub) { if (typeof alert === 'function') alert('未初始化模拟账户（请先设置初始资金）'); return; }
  const price = (engine.S.prices && engine.S.prices[sym] && engine.S.prices[sym].last);
  if (!price) { if (typeof alert === 'function') alert('无行情价，无法开仓'); return; }
  if (_safeguard || forceArm) {
    const now = Date.now();
    if (_arm.side !== side || now - _arm.t > 3000) { _arm = { side, t: now }; renderQuickTrade(); return; }
    _arm = { side: null, t: 0 };
  }
  const available = mm === 'coin' ? ((sub.coins && sub.coins[sym]) || 0) : (sub.bal || 0);
  const amt = _useFixed ? (parseFloat(_fixedAmt) || 0) : available * _sizePct / 100;
  if (amt <= 0) { if (typeof alert === 'function') alert(insufficientMsg(mm, sym, mm === 'coin' ? ((sub.coins && sub.coins[sym]) || 0) : available)); return; }
  engine.placeOrder({ symbol: sym, side, lev: _lev, amt, marginMode: mm, reinvest: true, src: 'manual', sub: sub.id });
  renderQuickTrade();
}

export function kchartTradeClose(forceArm) {
  if (!_tradeEngine) return;
  const sym = cfg.symbol;
  const pos = (_tradeEngine.S.pos || []).find(p => p.sym === sym);
  if (!pos) return;
  if (_safeguard || forceArm) {
    const now = Date.now();
    if (_arm.side !== 'close' || now - _arm.t > 3000) { _arm = { side: 'close', t: now }; renderQuickTrade(); return; }
    _arm = { side: null, t: 0 };
  }
  _tradeEngine.exitPosition(pos, { reason: '手动平仓' });
  renderQuickTrade();
}

// 行内单笔持仓平仓（按 orderId 精准定位；防误触沿用 _safeguard 两段确认）
function kchartTradeClosePos(orderId) {
  if (!_tradeEngine) return;
  const pos = (_tradeEngine.S.pos || []).find(p => p.orderId === orderId);
  if (!pos) return;
  if (_safeguard) {
    const now = Date.now();
    if (_armPos !== orderId || now - _armT > 3000) { _armPos = orderId; _armT = now; renderQuickTrade(); return; }
    _armPos = null; _armT = 0;
  }
  _tradeEngine.exitPosition(pos, { reason: '手动平仓' });
  renderQuickTrade();
}
if (typeof window !== 'undefined') window.kchartTradeClosePos = kchartTradeClosePos;

// ===================== 订单管理（对冲模式：同币可多空并存，列出全部持仓）=====================
let _omOpen = false;
let _omTimer = null;
let _omTab = 'positions';

// 纯函数：按用户设置的 TP/SL 价位点触发平仓；返回触发笔数。engine 需提供 .S 与 .exitPosition
function checkUserTpSl(engine) {
  if (!engine) return 0;
  const S = engine.S;
  if (!S || !S.pos || !S.pos.length) return 0;
  let n = 0;
  for (let i = S.pos.length - 1; i >= 0; i--) {
    const pos = S.pos[i];
    const c = (S.prices[pos.sym] || {}).last;
    if (!c) continue;
    let hit = null;
    if (pos.tp != null) {
      if ((pos.side === 'long' && c >= pos.tp) || (pos.side === 'short' && c <= pos.tp)) hit = '止盈';
    }
    if (!hit && pos.sl != null) {
      if ((pos.side === 'long' && c <= pos.sl) || (pos.side === 'short' && c >= pos.sl)) hit = '止损';
    }
    if (hit) { engine.exitPosition(pos, { reason: '用户' + hit }); n++; }
  }
  return n;
}

// 反手：平掉当前仓，并按同参数开反向仓
function reversePosition(engine, pos) {
  if (!engine || !pos) return;
  engine.exitPosition(pos, { reason: '反手平仓' });
  engine.placeOrder({
    symbol: pos.sym, side: pos.side === 'long' ? 'short' : 'long',
    lev: pos.lev, marginMode: pos.marginMode, reinvest: !!pos.reinvest,
    sub: pos.sid, amt: pos.amt
  });
}

// ===================== SRSI 自动交易 =====================
// 6 个短线周期全部完成 SRSI 优选才允许自动交易
const SRSI_AUTO_TFS = ['15m', '30m', '1h', '4h']; // 自动 SRSI 永续/回测只用这 4 个周期（5m/10m 不参与自动交易信号，无需优选）
// 模块级状态：每币对记录连开计数与当前 KD 带态（不持久化，重启重建）
const _srsiAuto = {};
function _autoState(sym) {
  if (!_srsiAuto[sym]) _srsiAuto[sym] = { longCount: 0, shortCount: 0, band: 'neutral', lastTradeTs: 0 };
  return _srsiAuto[sym];
}
export function resetSrsiAuto(sym) {
  const _reset = (s) => { s.longCount = 0; s.shortCount = 0; s.band = 'neutral'; s.armed = false; s.pendingConfirm = null; };
  if (sym) {
    const s = _srsiAuto[sym];
    if (s) _reset(s);
  } else {
    Object.keys(_srsiAuto).forEach(k => _reset(_srsiAuto[k]));
  }
}
// 规则监测（影子层）只读读取实盘带状态机状态（不推进；推进只发生在 srsiAutoBandState/runSrsiAutoTrade）
export function srsiAutoStateOf(sym) { return _srsiAuto[sym] || null; }

// 当前危险信号状态（供 SRSI 自动页红色光晕提醒；与防爆/反手开关解耦，仅纯信号识别）
let _dangerNow = false;
export function isDangerNow() { return _dangerNow; }

// 危险信号：≥2 个周期 EMA120 趋势与 side 相反 → 该方向开仓为逆大周期，易爆仓
// emaTf: { '4h': 'long'|'short'|null, '1h':..., '30m':... }
export function emaOpp2(side, emaTf) {
  if (!side || !emaTf) return false;
  const opp = side === 'long' ? 'short' : 'long';
  let c = 0;
  ['4h', '1h', '30m'].forEach(tf => { if (emaTf[tf] === opp) c++; });
  return c >= 2;
}

// 实时危险信号：给定当前 SRSI 带态推断「本应开仓方向」，再判大周期 EMA120 背离
export function computeDangerNow(sym) {
  const kd = { '4h': klineDirOf(sym, '4h'), '1h': klineDirOf(sym, '1h'), '30m': klineDirOf(sym, '30m') };
  const bs = (typeof srsiAutoBandState === 'function') ? srsiAutoBandState(sym, null, { readOnly: true }) : null;
  const side = bs && bs.edge === 'enterUpper' ? 'short' : (bs && bs.edge === 'enterLower' ? 'long' : null);
  if (!side) return false;
  return emaOpp2(side, kd);
}

// 危险信号多因子判定（防爆反手/预防爆仓 共用）：综合 4 类因子，任一命中记 1 分，≥ PREDICT_MIN 即危险。
// ctx: { dir, k15, atrPct15, emaOpp2Weak, priceVsEma1h, priceVsEma15, recentCandlePct }
//   - dir: 拟开仓方向 'long'|'short'
//   - k15: 当前 15m K 值（超买超卖极值）
//   - emaOpp2Weak: 旧 EMA120 背离信号(≥2 周期反向)
//   - priceVsEma1h/priceVsEma15: 现价偏离 1h/15m EMA 的百分比
//   - recentCandlePct: 最近 1 根 15m K 线振幅%
// 返回 { danger, score, reasons[] }。纯函数，可单测。
export function predictDanger(ctx) {
  const dir = ctx && ctx.dir;
  const reasons = [];
  let score = 0;
  if (ctx && ctx.emaOpp2Weak) { score++; reasons.push('ema120背离'); }
  if (ctx && typeof ctx.priceVsEma1h === 'number' && Math.abs(ctx.priceVsEma1h) >= THRESH.PREDICT_EMA1H_PCT) {
    score++; reasons.push('1hEMA偏离' + ctx.priceVsEma1h.toFixed(2) + '%');
  }
  if (ctx && typeof ctx.priceVsEma15 === 'number' && Math.abs(ctx.priceVsEma15) >= THRESH.PREDICT_EMA15_PCT) {
    score++; reasons.push('15mEMA偏离' + ctx.priceVsEma15.toFixed(2) + '%');
  }
  if (ctx && typeof ctx.k15 === 'number') {
    if (dir === 'long' && ctx.k15 <= THRESH.PREDICT_K15_LONG) { score++; reasons.push('超卖K15=' + ctx.k15.toFixed(1)); }
    else if (dir === 'short' && ctx.k15 >= THRESH.PREDICT_K15_SHORT) { score++; reasons.push('超买K15=' + ctx.k15.toFixed(1)); }
  }
  if (ctx && typeof ctx.recentCandlePct === 'number' && Math.abs(ctx.recentCandlePct) >= THRESH.PREDICT_CANDLE_PCT) {
    score++; reasons.push('近根振幅' + ctx.recentCandlePct.toFixed(2) + '%');
  }
  return { danger: score >= THRESH.PREDICT_MIN, score, reasons };
}

// K线方向：close 序列 EMA20 vs EMA120（与纪律分析同口径）
export function klineDirFromCloses(c) {
  if (!c || c.length < 120) return null;
  const e20 = ema(c, 20), e120 = ema(c, 120);
  const a = e20[e20.length - 1], b = e120[e120.length - 1];
  if (a == null || b == null) return null;
  if (a > b) return 'long';
  if (a < b) return 'short';
  return null;
}
export function klineDirOf(sym, tf) {
  const d = getTFData(sym, tf);
  if (!d || !d.c) return null;
  return klineDirFromCloses(d.c);
}

// SRSI 方向（由 K/D 直接判定，与 auxGateDir 核心一致：区域姿态 → KD 瞬时差）
export function srsiDirFromKD(k, d, zone) {
  if (k == null || d == null || !isFinite(k) || !isFinite(d)) return null;
  if (zone === 'oversold') return 'short';
  if (zone === 'overbought') return 'long';
  if (k - d > 0.5) return 'long';
  if (d - k > 0.5) return 'short';
  return null;
}

// SRSI 行方向（复用 auxGateDir：区域姿态 → 钩叉 → KD 瞬时）
export function srsiDirOf(sym, tf) {
  const c = (getTFData(sym, tf) || {}).c;
  if (!c || !c.length) return null;
  const srsiCfgFn = (cfg.srsiByTf && cfg.srsiByTf[tf]) || cfg.srsi;
  const rows = buildSrsiOverview([tf], srsiCfgFn, { [tf]: c }).rows;
  if (!rows || !rows.length) return null;
  return auxGateDir(rows[0]);
}

// 实时/回测共享方向入口：给定各周期收盘价(及配置)返回方向合力所需的两个映射
// （klineDir: 1h/30m/15m 由收盘价 EMA 定；srsiDir: 4h/1h 由 buildSrsiOverview+auxGateDir 定）。
// 实时 runSrsiAutoTrade 与回测 backtestSrsiAuto 均经此口径，确保两套路径方向一致（非两套版本）。
export function srsiAutoDirs(closesByTf, config) {
  const srsiCfgOf = (tf) => (config.srsiByTf && config.srsiByTf[tf]) || config.srsi;
  const klineDir = {};
  ['1h', '30m', '15m'].forEach(tf => { const c = closesByTf[tf]; klineDir[tf] = c && c.length ? klineDirFromCloses(c) : null; });
  const srsiDir = {};
  ['4h', '1h'].forEach(tf => {
    const c = closesByTf[tf];
    if (!c || !c.length) { srsiDir[tf] = null; return; }
    const rows = buildSrsiOverview([tf], srsiCfgOf(tf), { [tf]: c }).rows;
    srsiDir[tf] = rows && rows.length ? auxGateDir(rows[rows.length - 1]) : null;
  });
  return { klineDir, srsiDir };
}

// 6 周期优选是否全部就绪
function _srsiAutoOptReady() {
  return SRSI_AUTO_TFS.every(tf => cfg.srsiOptSource[tf] === 'optimized');
}

// 时间对齐：升序 times 中 openTime <= t 的最大下标（单调，二分）
function idxLe(times, t) {
  if (!times || !times.length) return -1;
  let lo = 0, hi = times.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (times[m] <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}

// 自动优选引擎：开启后自动优选全部 6 周期并应用；定时 + 无成交双触发重优选（防参数过期）
let _autoOptRunning = false;
let _lastAutoOptTs = 0;
const _autoOptLastCheck = { t: 0 };
export function srsiAutoOptStatus() {
  return { running: _autoOptRunning, lastAutoOptTs: _lastAutoOptTs,
    intervalH: cfg.srsiAutoOptIntervalH, noTradeH: cfg.srsiAutoOptNoTradeH, enabled: cfg.srsiAutoOptEnabled };
}
// 取指定币对的配置对象（当前币对=全局 cfg；其它币对从 _store 读，未存则 null）
export function _cfgForSym(sym) {
  if (sym === cfg.symbol) return cfg;
  if (!_store) { try { _store = readStore(); } catch (e) { _store = {}; } }
  return (_store.bySymbol && _store.bySymbol[sym]) || null;
}
// 把优选结果写入指定币对的持久化配置：切币后结果仍归属原币对，不污染当前展示币对
export function applyOptToSym(tf, sym, best, cw, target) {
  const t = target || _cfgForSym(sym) || (() => { const d = defaultKConfig(); d.symbol = sym; return d; })();
  t.srsiOptSource = t.srsiOptSource || {};
  t.srsiOptSource[tf] = 'optimized';
  t.srsiByTf = t.srsiByTf || {};
  t.srsiByTf[tf] = { ...(t.srsiByTf[tf] || {}), ...best };
  if (cw != null) { t.srsiOptWinRate = t.srsiOptWinRate || {}; t.srsiOptWinRate[tf] = cw; }
  if (sym === cfg.symbol) { persist(); }
  else { if (!_store) _store = readStore(); _store.bySymbol = _store.bySymbol || {}; _store.bySymbol[sym] = t; persist(); if (_pwaMode) writePwaSrsiOpt(sym, t); }
  try {
    const pwa = readPwaSrsiOpt()[sym] || {}; const sh = (_readJson(STATE_KEY) || {}).bySymbol || {};
    console.log('[SRSI-APPLY] tf=' + tf + ' sym=' + sym + ' best=' + JSON.stringify(best) + ' -> ' + JSON.stringify(t.srsiByTf[tf]) + ' pwa=' + JSON.stringify(pwa.srsiByTf && pwa.srsiByTf[tf]) + ' sh=' + JSON.stringify(sh[sym] && sh[sym].srsiByTf && sh[sym].srsiByTf[tf]));
  } catch (_) {}
  return t.srsiByTf[tf];
}
async function _autoOptOne(tf, sym, target) {
  const before = (target.srsiOptWinRate && target.srsiOptWinRate[tf] != null) ? target.srsiOptWinRate[tf] : null;
  const r = await optimizeSrsiForTf(tf, roleForTf(tf), { sym });
  if (!r || !r.best) return false;
  // walk-forward 门控：新参数样本外胜率明显低于已应用参数(>2pp)则保留旧参数，不盲目覆盖
  const cw = (r.oos && r.oos.winRate != null) ? r.oos.winRate
    : (r.stats && r.stats.winRate != null ? r.stats.winRate : null);
  if (before != null && cw != null && cw < before - 0.02) return false;
  applyOptToSym(tf, sym, r.best, cw, target);
  return true;
}
// 全部 6 周期优选并应用；force=true 时无视已优选状态全部重跑
export async function runSrsiAutoOptimizeAll(force) {
  if (_autoOptRunning) return false;
  const sym = cfg.symbol;   // 锁定本次优选的目标币对（异步期间切币不丢原币对结果、不写错币对）
  const target = _cfgForSym(sym) || (() => { const d = defaultKConfig(); d.symbol = sym; return d; })();
  _autoOptRunning = true;
  try {
    for (const tf of SRSI_AUTO_TFS) {
      if (!force && target.srsiOptSource && target.srsiOptSource[tf] === 'optimized') continue;
      try { await _autoOptOne(tf, sym, target); } catch (e) { /* 单周期失败不影响其余 */ }
    }
  } finally {
    _autoOptRunning = false;
    _lastAutoOptTs = Date.now();
    // 兜底刷新一次：确保本轮产生的所有 optimized 标记/参数都落盘（修复 10m 等周期偶发未持久化）
    persist();
  }
  return true;
}
// 双触发检查：定时间隔 或 长时间无成交 → 触发重优选；由主循环每 ~60s 调用一次
export function maybeAutoOpt() {
  if (!cfg.srsiAutoOptEnabled || _autoOptRunning) return;
  const now = Date.now();
  if (now - _autoOptLastCheck.t < 60000) return; // 节流：每分钟最多评估一次
  _autoOptLastCheck.t = now;
  const intervalMs = cfg.srsiAutoOptIntervalH * 3600e3;
  const noTradeMs = cfg.srsiAutoOptNoTradeH * 3600e3;
  const st = _autoState(cfg.symbol);
  const staleByInterval = cfg.srsiAutoOptIntervalOn && (now - _lastAutoOptTs) > intervalMs;
  const staleByNoTrade = st.lastTradeTs && (now - st.lastTradeTs) > noTradeMs;
  // 仍有周期未优选（首屏数据未就绪/网络抖动/某周期拉取失败）→ 60s 后补跑，避免长期 ✗（runSrsiAutoOptimizeAll 跳过已优选项，只重试缺失周期）
  const incomplete = !_srsiAutoOptReady();
  if (staleByInterval || staleByNoTrade || incomplete) {
    runSrsiAutoOptimizeAll(false);
  }
}

// 方向合力评分（纯函数，便于单测）：传入预取的方向映射与参数
export function computeDirectionScore(klineDir, srsiDir, opts) {
  const big = !!(klineDir['1h'] && klineDir['1h'] === srsiDir['4h']);
  const mid = !!(klineDir['30m'] && klineDir['30m'] === srsiDir['4h']);
  const small = !!(klineDir['15m'] && klineDir['15m'] === srsiDir['1h']);
  const base = opts.basePct, bB = opts.bonusBig, bM = opts.bonusMid, bS = opts.bonusSmall, cap = (opts.capPct != null ? opts.capPct : 30);
  const posPct = Math.min(cap, base + (big ? bB : 0) + (mid ? bM : 0) + (small ? bS : 0));
  return { big, mid, small, posPct };
}

// #4 仓位缩放因子（纯函数）：以 15m 交易方向(side) 为基准，比对 4h/1h/30m 的 SRSI 方向
//   - 该周期未优选 → 直接扣对应权重（无法确认与 15m 一致）
//   - 已优选且方向与 side 一致 → 加权重；已优选但不一致/未知 → 扣权重
// 返回乘法因子 = 1 + 合计% / 100，钳制 [0.2, 2]（全反向 0.4×，全一致 1.6×）
export function computeSizeScale(side, srsiDirByTf, weights, srsiOptSource) {
  let signed = 0;
  for (const tf of ['4h', '1h', '30m']) {
    const w = (weights && weights[tf]) || 0;
    const opt = srsiOptSource && srsiOptSource[tf] === 'optimized';
    if (!opt) { signed -= w; continue; }
    const dir = srsiDirByTf && srsiDirByTf[tf];
    if (dir === side) signed += w;
    else signed -= w;
  }
  const scale = 1 + signed / 100;
  return Math.max(0.2, Math.min(2, scale));
}

// 本位选择：follow=开空U本位/开多币本位；usdt/coin 固定
function _autoMarginMode(side, config) {
  const c = config || cfg;
  if (c.srsiAutoMode === 'usdt') return 'usdt';
  if (c.srsiAutoMode === 'coin') return 'coin';
  return side === 'short' ? 'usdt' : 'coin';
}

// v1.6.16：SRSI 自动交易「最近一次拦截原因」文案 + 可执行引导（静默拦截留痕，同类 bug 第三次）
export const BLOCK_REASON_TEXT = {
  'no-price': '无行情价格',
  'not-optimized': '15m 未优选（硬约束禁止开仓）',
  'regime-lowdrift': '低波阴跌闸门·禁开新仓',
  'hotstop': '热停开（1h ATR 过高）',
  'same-limit': '同向自动仓已达上限',
  'pd-block': 'PD-A 危险拦截（predictDanger 命中）',
  'danger-block': '防爆过滤·危险单已避开',
  'rev-wait': '防爆反手·等待价格确认破位',
  'coin-inventory-0': '币本位库存为 0',
  'no-balance': '可用保证金为 0',
  'amt-0': '计算仓位为 0（受单笔上限/缩放限制）',
  'confirm-wait': '等待确认 bar（尚未满根数）'
};
export function blockReasonText(reason) { return BLOCK_REASON_TEXT[reason] || reason || '未知'; }
// 针对每种拦截原因给可执行建议（纯文本，供交易面板 / 驾驶舱共用）
export function blockGuideText(reason, sym) {
  switch (reason) {
    case 'coin-inventory-0': return insufficientMsg('coin', sym, 0);
    case 'not-optimized': return '点击「一键优选」完成 15m 优选后自动交易才会启用。';
    case 'same-limit': return '同向自动仓已达上限，等已有仓位平掉后再开。';
    case 'regime-lowdrift': return '当前处于低波阴跌（regime 闸门），禁止开新仓；等行情转好。';
    case 'hotstop': return '1h ATR 过高触发热停开，等波动回落后再开。';
    case 'pd-block': return '危险信号命中，本笔已避开（防爆保护，非故障）。';
    case 'danger-block': return '防爆过滤判定为危险单，已避开（非故障）。';
    case 'rev-wait': return '防爆反手已挂起，等价格逆向突破确认阈值才开反手单。';
    case 'no-balance': return '子账户可用保证金为 0，请在「模拟真实交易设置」里补充资金。';
    case 'amt-0': return '受单笔上限/仓位缩放影响，本次计算仓位为 0（可提高基准%或放宽上限）。';
    case 'confirm-wait': return '信号已捕捉，正在等待确认 bar 收盘（属正常降频，非拦截）。';
    case 'no-price': return '暂无行情价格，等待数据恢复。';
    default: return '';
  }
}
// 切换 SRSI 自动交易本位模式（follow/usdt/coin）—— 库存为 0 时的一键引导入口，不静默改语义
// fix(1.6.16)：新增 window 钩子 kchartSetSrsiAutoMode（供面板内联 onclick 调用）
// v1.6.30：价格-均线关系盯盘辅助层开关（纯显示，不接自动交易）
export function setMaRel(on) {
  cfg.maRelOn = !!on;
  _maRelCache = { key: '', data: null };
  try { persist(); } catch (e) {}
  _mtSig = '';
  renderMainTools();
  renderKChart();
}

export function setSrsiAutoMode(mode) {
  if (['follow', 'usdt', 'coin'].indexOf(mode) < 0) return;
  cfg.srsiAutoMode = mode;
  persist();
  if (typeof document !== 'undefined') {
    const mEl = document.getElementById('ktSrsiMode');
    if (mEl) mEl.value = mode;
  }
  renderSrsiAutoPanel();
  if (typeof renderQuickTrade === 'function') renderQuickTrade();
}

// 读取模拟交易设置（现货USDT池 / 各币本位库存），供现货回测初始化使用。
// 多源合并：主系统实时 S.sim、PWA 的 pwa_sim_settings、主系统持久化 smartTrader→.sim
// （用户在主系统「交易设置·模拟真实交易」填的币库存落在 smartTrader，PWA 也能复用）。
// coin 映射合并；现货 USDT 池取首个非零值。缺省给 {spotUsdt:0, coin:{}}
export function _getSim() {
  const sources = [];
  try {
    if (typeof window !== 'undefined' && window.S && window.S.sim) {
      sources.push({ spotUsdt: window.S.sim.spotUsdt, coin: window.S.sim.coin });
    }
  } catch (e) {}
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem('pwa_sim_settings');
      if (raw) { const o = JSON.parse(raw); sources.push({ spotUsdt: o.spotUsdt, coin: o.coin }); }
    }
  } catch (e) {}
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem('smartTrader');
      if (raw) { const o = JSON.parse(raw); if (o && o.sim) sources.push({ spotUsdt: o.sim.spotUsdt, coin: o.sim.coin }); }
    }
  } catch (e) {}
  if (!sources.length) return { spotUsdt: 0, coin: {} };
  const coin = {};
  let spotUsdt = 0;
  for (const s of sources) {
    if (!spotUsdt && s.spotUsdt != null && s.spotUsdt > 0) spotUsdt = s.spotUsdt;
    if (s.coin) Object.keys(s.coin).forEach(k => { if (s.coin[k] != null && coin[k] == null) coin[k] = s.coin[k]; });
  }
  return { spotUsdt, coin };
}

// KD 带状态机（纯函数，不改模块状态）：返回当前带态与边沿（仅穿越瞬间触发）
export function bandEdge(prevBand, k, d, opts, armed = false) {
  const upper = opts.upper, lower = opts.lower;
  const inUpper = (k != null && d != null && k > upper && d > upper);
  const inLower = (k != null && d != null && k < lower && d < lower);
  let band = 'neutral', edge = null;
  if (inUpper) {
    band = 'upper';
    if (prevBand !== 'upper') armed = false;          // 进入上限带：重置置位（准备，不交易）
    if (!armed && d > k) { edge = 'enterUpper'; armed = true; } // 带内 D>K 交叉 → 空头信号（每次进带仅一次）
  } else if (inLower) {
    band = 'lower';
    if (prevBand !== 'lower') armed = false;          // 进入下限带：重置置位（准备，不交易）
    if (!armed && k > d) { edge = 'enterLower'; armed = true; } // 带内 K>D 交叉 → 多头信号（每次进带仅一次）
  } else {
    armed = false;                                    // 出带进入中性：下次进带再置位
  }
  return { band, edge, armed };
}

// 纯函数：v2 开仓决策（不含同向连开上限，上限由调用方处理）。供 Stage A 单测与 Stage C 接入。
// dangerMode: 'none'=关 / 'filter'=预防爆仓(避开危险单) / 'reverse'=防爆反手(危险信号→自动开反方向)。
// 防爆反手：危险信号命中且模式=reverse → 直接开反方向(反手单，独立类别、不计入同向连开上限)；
//   反向盈利按 srsiAutoReversePct/srsiAutoReverseLev 落仓（为 0 则回退正常%/杠杆）。
// 返回 { open, side, rev, blockedBy }。
export function resolveEntryDecision(side, { danger = false, hotStop = false, dangerMode = 'none' } = {}) {
  // 防爆反手：危险信号命中且模式=reverse → 直接开反方向(反手单)
  if (danger && dangerMode === 'reverse') return { open: true, side: side === 'long' ? 'short' : 'long', rev: true, blockedBy: null };
  // 预防爆仓：危险信号命中且模式=filter/smart → 避开危险单(不开)
  if (danger && (dangerMode === 'filter' || dangerMode === 'smart')) return { open: false, side, rev: false, blockedBy: 'danger' };
  if (hotStop) return { open: false, side, rev: false, blockedBy: 'hotstop' };
  return { open: true, side, rev: false, blockedBy: null };
}

// 预防爆仓(智能)判定：根据归因(liqStudy)真正区分“会被强平”的开仓——
// 强平由价格逆向走满 ~1/lev 触发，与 EMA120 背离几乎无关；真正高命中因子是“接飞刀/追涨杀跌”：
// 价格远离 1h EMA(≥SMART_EMA1H_PCT) 或 近 4 根 15m 累计振幅≥SMART_CANDLE_PCT。
// ctx: { priceVsEma1h, recentCandlePct }。纯函数，可单测。
export function smartDanger(ctx) {
  if (!ctx) return false;
  if (typeof ctx.priceVsEma1h === 'number' && Math.abs(ctx.priceVsEma1h) >= THRESH.SMART_EMA1H_PCT) return true;
  if (typeof ctx.recentCandlePct === 'number' && Math.abs(ctx.recentCandlePct) >= THRESH.SMART_CANDLE_PCT) return true;
  return false;
}

// 进场触发带解析：upper/lower 为 0（或 falsy）= 使用该周期「15m 优选后的上下限带」
// （srsiByTf['15m'].overbought/oversold）；非 0 则作为手动覆盖。返回 { upper, lower, auto }
export function resolveEntryBands(config) {
  const s15 = (config.srsiByTf && config.srsiByTf['15m']) || config.srsi || {};
  let upper = config.srsiAutoUpper;
  let lower = config.srsiAutoLower;
  const uAuto = !upper || upper <= 0;
  const lAuto = !lower || lower <= 0;
  if (uAuto) upper = (typeof s15.overbought === 'number' ? s15.overbought : 80);
  if (lAuto) lower = (typeof s15.oversold === 'number' ? s15.oversold : 20);
  return { upper, lower, auto: uAuto || lAuto };
}

// KD 带状态机：写入模块状态（实盘每秒调用）。row 可选注入用于单测。
// v1.6.22：opts.readOnly=true 时**只计算不写状态**（供 UI 面板读“当前带态/将要触发的边沿”）。
//   背景（真实 bug，v1.6.22 修复）：renderQuickTrade()（每秒）→ renderSrsiAutoPanel() → computeDangerNow()
//   会调本函数推进状态机；而 runSrsiAutoTrade() 在同一 tick 里排在它**之后** → enterUpper/enterLower 边沿
//   被面板先吃掉 → 卫星永不成交（A/B 实验：同 tick 直接执行 opened=1，面板插队后 opened=0）。
//   推进（写 st.band/st.armed）**只允许**发生在 runSrsiAutoTrade 内。
export function srsiAutoBandState(sym, row, opts = {}) {
  const st = _autoState(sym);
  const c = (getTFData(sym, '15m') || {}).c;
  const srsi15 = (cfg.srsiByTf && cfg.srsiByTf['15m']) || cfg.srsi;
  const rows = (row ? [row] : buildSrsiOverview(['15m'], srsi15, { '15m': c || [] }).rows);
  const r = rows && rows[0];
  const k = r && r.k, d = r && r.d;
  const _eb = resolveEntryBands(cfg);
  const be = bandEdge(st.band, k, d, { upper: _eb.upper, lower: _eb.lower }, st.armed);
  if (!opts.readOnly) {
    st.band = be.band;
    st.armed = be.armed;
  }
  return { band: be.band, edge: be.edge, k, d };
}

// GOAL27 确认 bar 纯函数：带边沿信号后，逐根检查「收盘根仍满足带内条件」的确认推进。
// side='short'(上带：K&D 均>upper) / 'long'(下带：K&D 均<lower)；count=已确认根数；confirmBars=所需确认根数(>0)。
// 返回 { inBand, fire, count, active }：inBand=本根是否仍带内；fire=确认已满可执行；
// count=推进后计数（inBand=false→0）；active=挂单是否继续保留（inBand=false→false；fire→消费）。单测进 tests/kchart.test.mjs
export function srsiConfirmPass(k, d, upper, lower, side, count, confirmBars) {
  const inBand = side === 'short'
    ? (k != null && d != null && k > upper && d > upper)
    : (k != null && d != null && k < lower && d < lower);
  if (!inBand) return { inBand: false, fire: false, count: 0, active: false };
  const c = (count|0) + 1;
  const fire = c >= confirmBars;
  return { inBand: true, fire, count: c, active: !fire };
}

// 主执行入口（每秒调用）。inj 仅用于单测注入（engine/band/klineDir/srsiDir）
// GOAL29：SRSI 卫星 regime 三态闸门（纯函数，可单测；回测 backtestSrsiAuto 与实盘 runSrsiAutoTrade 同源口径）。
// 高波(1h ATR% ≥ 滚动P75)→照常开；中波→confirm+1 或 减仓×0.5（由 cfg.srsiAutoRegimeGate 决定）；
// 低波阴跌(<P25 且 价<1h EMA200)→禁开新仓（持仓照常管理）。样本 < REGIME_GATE_MINN → state=null（闸门不生效）。
export function srsiAutoRegime(c1h, price, opts = {}) {
  const W = (opts.w != null) ? Math.max(60, Math.floor(opts.w)) : THRESH.REGIME_GATE_W;
  const c = Array.isArray(c1h) ? c1h : [];
  if (c.length < 14) return { state: null, atrPct: null, p25: null, p75: null, ema200: null, minOk: false };
  const atr = atrClose(c, 14);
  const n = atr.length;
  const last = atr[n - 1];
  const atrPct = (last != null && c[n - 1]) ? last / c[n - 1] * 100 : null;
  // GOAL29-A2：阴跌判定 EMA 周期可选（'1h' 默认 | '1d'）；1d 数据不足(<200 根)安全降级回 1h
  const _emaC = (opts.emaTf === '1d' && Array.isArray(opts.c1d) && opts.c1d.length >= 200) ? opts.c1d : c;
  const emaArr = ema(_emaC, 200);
  const ema200 = (emaArr[_emaC.length - 1] != null && isFinite(emaArr[_emaC.length - 1])) ? emaArr[_emaC.length - 1] : null;
  const vals = [];
  for (let i = Math.max(0, n - W); i < n; i++) { const a = atr[i]; if (a != null && isFinite(a) && c[i] > 0) vals.push(a / c[i] * 100); }
  const minOk = vals.length >= THRESH.REGIME_GATE_MINN;
  if (atrPct == null || !minOk) return { state: null, atrPct, p25: null, p75: null, ema200, minOk };
  const s = vals.slice().sort((a, b) => a - b);
  const p75 = s[Math.floor(0.75 * (s.length - 1))];
  const p25 = s[Math.floor(0.25 * (s.length - 1))];
  let state;
  if (atrPct >= p75) state = 'high';
  else if (atrPct < p25) state = (ema200 != null && price != null && price < ema200) ? 'lowdrift' : 'mid';
  else state = 'mid';
  return { state, atrPct, p25, p75, ema200, minOk };
}

export function runSrsiAutoTrade(sym, inj) {
  sym = sym || cfg.symbol;
  if (!cfg.srsiAutoOn) { resetSrsiAuto(sym); return; }
  const engine = (inj && inj.engine) ? inj.engine : _tradeEngine;
  if (!engine) return;
  const sub = engine.getPerpSub ? engine.getPerpSub() : null;
  if (!sub) return;
  const st = _autoState(sym);
  // 方向合力
  let klineDir, srsiDir;
  if (inj && inj.klineDir && inj.srsiDir) {
    klineDir = inj.klineDir; srsiDir = inj.srsiDir;
  } else {
    klineDir = {}; srsiDir = {};
    ['1h', '30m', '15m'].forEach(tf => { klineDir[tf] = klineDirOf(sym, tf); });
    ['4h', '1h', '30m'].forEach(tf => { srsiDir[tf] = srsiDirOf(sym, tf); });
  }
  klineDir['4h'] = klineDir['4h'] || klineDirOf(sym, '4h');
  const bs = (inj && inj.band) ? inj.band : srsiAutoBandState(sym);
  const price = (engine.S.prices && engine.S.prices[sym] && engine.S.prices[sym].last);
  // 危险信号多因子特征（每 tick 计算一次，供 _attemptOpen 复用）
  const _c15live = (getTFData(sym, '15m') || {}).c || [];
  const _c1hlive = (getTFData(sym, '1h') || {}).c || [];
  const _ema15live = _c15live.length ? ema(_c15live, 20) : null;
  const _ema1hlive = _c1hlive.length ? ema(_c1hlive, 20) : null;
  const _atr15live = _c15live.length ? atrClose(_c15live.map(Number), 14) : null;
  const _e15 = _ema15live ? _ema15live[_ema15live.length - 1] : null;
  const _e1h = _ema1hlive ? _ema1hlive[_ema1hlive.length - 1] : null;
  const _atr15last = _atr15live && _atr15live.length ? _atr15live[_atr15live.length - 1] : null;
  const _recentPct = (_c15live.length >= 5) ? (_c15live[_c15live.length - 1] - _c15live[_c15live.length - 5]) / _c15live[_c15live.length - 5] * 100 : null;
  // GOAL29 regime 三态闸门：高波照常 / 中波降频或减仓 / 低波阴跌禁开新仓（off=关，零行为变化）
  const _rgGate = cfg.srsiAutoRegimeGate !== 'off';
  const _rg = _rgGate ? srsiAutoRegime(_c1hlive.map(Number), price, { w: cfg.srsiAutoRegimeW, emaTf: cfg.srsiAutoRegimeEmaTf, c1d: (getTFData(sym, '1d') || {}).c }) : null;
  if (_rgGate) st.regime = _rg; // 供状态面板显示
  // #1 硬约束：15m 未优选 → 禁止自动交易（其余周期方向信息不足，按 #4 规则该减则减）
  const _canTrade = cfg.srsiOptSource['15m'] === 'optimized';
  const _sizeWeights = { '4h': cfg.srsiAutoW4h, '1h': cfg.srsiAutoW1h, '30m': cfg.srsiAutoW30m };
  // 危险信号：本应开仓方向与大周期(4h/1h/30m) EMA120 趋势背离≥2 → 易爆仓
  const emaTf = { '4h': klineDir['4h'], '1h': klineDir['1h'], '30m': klineDir['30m'] };
  const _danger = (side) => emaOpp2(side, emaTf);
  const _autoSameCount = (side) => (engine.S.pos || []).filter(p => p.sym === sym && p.side === side && p.src === 'srsiAuto' && !p.reverse).length;
  const _barT15 = () => { const tt = (getTFData(sym, '15m') || {}).t || []; return tt.length ? tt[tt.length - 1] : null; };
  // v1.6.16：所有静默 return 留痕（同类静默拦截 bug 第三次）——记录最近一次拦截原因，供交易面板/驾驶舱显示
  const _block = (side, reason) => { st.lastBlock = { side, reason, ts: Date.now() }; };
  const _tryOpen = (side, rev) => {
    if (price == null) { _block(side, 'no-price'); return; }
    if (!_canTrade) { _block(side, 'not-optimized'); return; }
    const isRev = !!rev;
    if (_rg && _rg.state === 'lowdrift') { st.regimeBlocked = (st.regimeBlocked || 0) + 1; _block(side, 'regime-lowdrift'); return; } // GOAL29：低波阴跌禁开新仓（含反手）
    // 热停开：1h ATR > 1.3×sma20(1h ATR) 时禁止新开普通单（反手仍允许），防高波动爆仓
    if (!isRev && cfg.srsiAutoHotStop) {
      const _c1h = (getTFData(sym, '1h') || {}).c;
      if (_c1h && _c1h.length > 30) {
        const _atr = atrClose(_c1h.map(Number), 14);
        const _n = _atr.length;
        if (_n >= 20) {
          let _s = 0; for (let _j = _n - 20; _j < _n; _j++) _s += _atr[_j];
          const _sma = _s / 20;
          if (_sma > 0 && _atr[_n - 1] > 1.3 * _sma) { _block(side, 'hotstop'); return; }
        }
      }
    }
    // 仅约束「自动」开仓的同向数量；反手单为独立类别，不计入也不受此上限约束
    const _same = _autoSameCount(side);
    if (!isRev && _same >= cfg.srsiAutoMaxSame) { _block(side, 'same-limit'); return; }
    // GOAL31-D：PD-A 危险拦截（predictDanger 多因子≥2 命中→拦截该笔普通开仓；反手单不拦；默认 off=零行为变化；ctx 与 fork /tmp/goal31-btsa.mjs 同构）
    if (!isRev && cfg.srsiAutoPdBlockOn) {
      const _pdCtx = { dir: side, k15: bs ? bs.k : null, atrPct15: (_atr15last != null && price) ? _atr15last / price * 100 : null, priceVsEma1h: (_e1h != null && isFinite(_e1h) && _e1h !== 0) ? (price - _e1h) / _e1h * 100 : null, priceVsEma15: (_e15 != null && isFinite(_e15) && _e15 !== 0) ? (price - _e15) / _e15 * 100 : null, recentCandlePct: _recentPct, sameCount: _same, emaAgree: ['4h', '1h', '30m'].filter(tf => emaTf[tf] === side).length, emaOpp2Weak: _danger(side) };
      if (predictDanger(_pdCtx).danger) { st.pdBlocked = (st.pdBlocked || 0) + 1; _block(side, 'pd-block'); return; }
    }
    const mm = _autoMarginMode(side);
    const isCoin = mm === 'coin';
    const avail = isCoin ? ((sub.coins && sub.coins[sym]) || 0) : (sub.bal || 0);
    // #4 乘法缩放：基准% × (1 ± 合计%)，未优选或反向的周期扣对应权重
    const scale = computeSizeScale(side, srsiDir, _sizeWeights, cfg.srsiOptSource);
    const basePct = isRev && cfg.srsiAutoReversePct > 0 ? cfg.srsiAutoReversePct : cfg.srsiAutoBasePct;
    let effPct = basePct;
    if (!isRev && _same > 0 && cfg.srsiAutoStackDecay > 0 && cfg.srsiAutoStackDecay < 1) {
      const front = (typeof cfg.srsiAutoStackFront === 'number' && cfg.srsiAutoStackFront > 1) ? cfg.srsiAutoStackFront : 1;
      const exp = Math.max(0, _same - (front - 1));
      effPct = basePct * Math.pow(cfg.srsiAutoStackDecay, exp);
    }
    let useLev = isRev && cfg.srsiAutoReverseLev > 0 ? cfg.srsiAutoReverseLev : cfg.srsiAutoLev;
    const _atrPctNow = (_atr15last != null && price) ? _atr15last / price * 100 : null;
    // 自适应杠杆：波动放大(当前ATR%>滚动中位)→降杠杆；平静→回到基准。默认关。
    if (cfg.srsiAutoAdaptiveLev) {
      st.atrMed = updateAtrMedian(st.atrMed, _atrPctNow);
      useLev = adaptiveLeverage({ baseLev: useLev, atrPct: _atrPctNow, medianAtrPct: st.atrMed || _atrPctNow, minLev: cfg.srsiAutoAdaptiveLevMin });
    }
    const _rgSize = (_rg && !isRev && cfg.srsiAutoRegimeGate === 'size' && _rg.state === 'mid') ? THRESH.REGIME_GATE_MID_SIZE : 1; // GOAL29：中波减仓
    let amt = avail * effPct / 100 * scale * _rgSize;
    const capUsdt = cfg.srsiAutoOpenCapUsdt > 0 ? cfg.srsiAutoOpenCapUsdt : Infinity;
    const capCoin = cfg.srsiAutoOpenCapCoin > 0 ? cfg.srsiAutoOpenCapCoin : Infinity;
    if (isCoin) amt = Math.min(amt, capCoin, capUsdt / price);
    else amt = Math.min(amt, capUsdt, capCoin * price);
    if (amt <= 0) {
      // 分因留痕：币本位库存 0 / U本位保证金 0 / 受上限缩放后为 0
      _block(side, (isCoin && !(avail > 0)) ? 'coin-inventory-0' : (!isCoin && !(avail > 0)) ? 'no-balance' : 'amt-0');
      return;
    }
    const _order = engine.placeOrder({ symbol: sym, side, lev: useLev, amt, marginMode: mm, reinvest: false, src: 'srsiAuto', reverse: isRev, sub: sub.id });
    if (_order) _pushSrsiMark({ t: Date.now(), side, action: 'open', price, rev: isRev });
    if (cfg.srsiAutoAtrStop && _order && _order.extra && _order.extra.positionIndex != null) {
      const _pos = engine.S.pos[_order.extra.positionIndex];
      if (_pos) _pos.stopPx = protectiveStopPrice(_pos.entry, side, _atrPctNow, cfg.srsiAutoAtrStopMult);
    }
    if (_order && _order.extra && _order.extra.positionIndex != null) {
      const _posK = engine.S.pos[_order.extra.positionIndex];
      if (_posK && bs && bs.k != null) _posK.openK = bs.k; // 信号出口(实验旋钮)：记录开仓时 15m K，供中轨离场判定
    }
    st.lastBlock = null;   // 成功开仓 → 清除最近拦截记录
    st.lastTradeTs = Date.now();
    // 信号提醒：真的下单了 → 推入事件流（与实盘成交一一对应）
    try { pushSignalEvent({ sym, kind: 'srsi-open', side, price, barT: _barT15(), src: 'engine', w: null, text: (isRev ? '防爆反手 · ' : '') + useLev + 'x 仓位' + effPct.toFixed(0) + '%' }); } catch (e) {}
  };
  // 危险信号防爆/反手：none=关；filter=避开危险单(沿用 emaOpp2 基线，保持(9)预防爆仓结果不变)；
  // reverse=防爆反手(用更聪明的 predictDanger 多因子信号→自动开反方向)
  // 防爆反手(确认) 挂单状态：危险触发后记录，价格确认破位才开反手（跨 tick 保留）
  st.pendingRev = (cfg.srsiAutoDanger === 'revconf') ? (st.pendingRev || { long: null, short: null }) : null;
  const _resolvePendingRev = () => {
    if (cfg.srsiAutoDanger !== 'revconf' || !st.pendingRev) return;
    for (const ps of ['long', 'short']) {
      const pend = st.pendingRev[ps]; if (!pend) continue;
      const moved = ps === 'long' ? (price - pend.price) / pend.price * 100 : (pend.price - price) / pend.price * 100; // 危险方向(反向)已走幅度%
      if (moved >= cfg.srsiAutoRevConfirm) { _tryOpen(ps === 'long' ? 'short' : 'long', true); st.pendingRev[ps] = null; }
      else if (Date.now() - pend.ts > 50 * 3600 * 1000) st.pendingRev[ps] = null; // 超时(~50h)未确认作废
    }
  };
  const _attemptOpen = (side) => {
    const _emaDanger = _danger(side);
    const _pd = predictDanger({ dir: side, k15: bs.k, atrPct15: (_atr15last != null && price) ? _atr15last / price * 100 : null, emaOpp2Weak: _emaDanger, priceVsEma1h: (_e1h != null && _e1h !== 0) ? (price - _e1h) / _e1h * 100 : null, priceVsEma15: (_e15 != null && _e15 !== 0) ? (price - _e15) / _e15 * 100 : null, recentCandlePct: _recentPct });
    if (cfg.srsiAutoDanger === 'revconf') {
      // 危险(EMA120 背离≥2)→挂起等确认；非危险→正常开
      if (_emaDanger) { st.pendingRev[side] = { price, ts: Date.now() }; _block(side, 'rev-wait'); return; }
      const dec = resolveEntryDecision(side, { danger: false, hotStop: cfg.srsiAutoHotStop, dangerMode: 'revconf' });
      if (!dec.open) { _block(side, 'hotstop'); return; }
      _tryOpen(dec.side, dec.rev);
      return;
    }
    const danger = cfg.srsiAutoDanger === 'reverse' ? _pd.danger
      : cfg.srsiAutoDanger === 'smart' ? smartDanger({ priceVsEma1h: (_e1h != null && _e1h !== 0) ? (price - _e1h) / _e1h * 100 : null, recentCandlePct: _recentPct, k15: bs.k, dir: side })
      : _emaDanger;
    const dec = resolveEntryDecision(side, {
      danger,
      hotStop: cfg.srsiAutoHotStop,
      dangerMode: cfg.srsiAutoDanger
    });
    if (!dec.open) { _block(side, dec.blockedBy === 'hotstop' ? 'hotstop' : 'danger-block'); return; }
    _tryOpen(dec.side, dec.rev);
  };
  // GOAL27 确认 bar（实盘）：srsiAutoConfirmBars>0 时边沿事件挂起，待 N 根 15m 收盘仍满足带内条件才执行（0=关=立即执行，行为不变）
  const _confirmNL = (cfg.srsiAutoConfirmBars != null) ? Math.max(0, Math.min(5, Math.floor(+cfg.srsiAutoConfirmBars || 0))) : 0;
  // GOAL29：中波降频 = 有效确认根数 +1（挂单创建时捕获当时档位 pc.n；闸门 off 时 pc.n≡_confirmNL 行为不变）
  // GOAL29-A2：tconf = 趋势市(AIS regime)升确认；AIS 类型每 1h 根缓存一次（st._tconfCache）
  const _confirmClass = cfg.srsiAutoRegimeGate === 'confirm' || cfg.srsiAutoRegimeGate === 'tconf';
  const _trendType = () => {
    if (cfg.srsiAutoRegimeGate !== 'tconf' || !_rg) return null;
    const _c1h = _c1hlive;
    if (_c1h.length < 90) return null;
    const _t1h = (getTFData(sym, '1h') || {}).t || [];
    const _key = _t1h[_t1h.length - 1];
    if (st._tconfCache && st._tconfCache.key === _key) return st._tconfCache.type;
    const _cn = _c1h.map(Number);
    const _line = ais(_cn, 20, 8, 32, 14, 2).line;
    const _n = _line.length, _j = _n - 1, _j60 = _n - 61;
    let type = null;
    if (_j60 >= 0 && _line[_j] != null && _line[_j60] != null && _line[_j60] > 0) {
      const slope = (_line[_j] - _line[_j60]) / _line[_j60] * 100;
      if (Math.abs(slope) < THRESH.REGIME_DEAD_SLOPE_PCT) type = 'range';
      else { const above = _cn[_n - 1] > _line[_j]; type = slope > 0 ? (above ? 'trend-up' : 'pullback-up') : (above ? 'pullback-down' : 'trend-down'); }
    }
    st._tconfCache = { key: _key, type };
    return type;
  };
  const _effConfirmNow = () => {
    if (_confirmNL > 0 && !(_confirmClass && _rg)) return _confirmNL;
    if (cfg.srsiAutoRegimeGate === 'confirm' && _rg && _rg.state === 'mid') return _confirmNL + THRESH.REGIME_GATE_MID_CONFIRM;
    if (cfg.srsiAutoRegimeGate === 'tconf' && _rg) { const _ty = _trendType(); if (_ty && _ty.indexOf('trend') === 0) return _confirmNL + THRESH.REGIME_GATE_MID_CONFIRM; }
    return _confirmNL;
  };
  st.pendingConfirm = (_confirmNL > 0 || (_confirmClass && _rg)) ? (st.pendingConfirm || null) : null;
  const _execEdgeLive = (side) => {
    if (side === 'short') {
      // 平盈利多单；多单亏损时仅跳过平仓（不操作），空单照开
      // srsiAutoCloseManual 关：仅平自动单；开：盈利的反向人工单也可被自动平（仍仅净盈利才平）
      const longPos = (engine.S.pos || []).find(p => p.sym === sym && p.side === 'long' && (p.src === 'srsiAuto' || cfg.srsiAutoCloseManual));
      if (longPos && longPos.pnl > 0) { engine.exitPosition(longPos, { reason: 'SRSI自动 上带平多' }); _pushSrsiMark({ t: Date.now(), action: 'close', reason: 'auto' }); try { pushSignalEvent({ sym, kind: 'srsi-close', side: 'long', price, barT: _barT15(), src: 'engine', text: '上带平多' }); } catch (e) {} }
      _attemptOpen('short');
    } else {
      const shortPos = (engine.S.pos || []).find(p => p.sym === sym && p.side === 'short' && (p.src === 'srsiAuto' || cfg.srsiAutoCloseManual));
      if (shortPos && shortPos.pnl > 0) { engine.exitPosition(shortPos, { reason: 'SRSI自动 下带平空' }); _pushSrsiMark({ t: Date.now(), action: 'close', reason: 'auto' }); try { pushSignalEvent({ sym, kind: 'srsi-close', side: 'short', price, barT: _barT15(), src: 'engine', text: '下带平空' }); } catch (e) {} }
      _attemptOpen('long');
    }
  };
  const _t15live = (getTFData(sym, '15m') || {});
  const _ts15 = _t15live.t || [];
  const _effN0 = _effConfirmNow();
  // v1.6.16：未优选时也留痕（原本 _canTrade=false 直接跳过边沿派发，无任何记录）
  if (!_canTrade && (bs.edge === 'enterUpper' || bs.edge === 'enterLower')) _block(bs.edge === 'enterUpper' ? 'short' : 'long', 'not-optimized');
  if (_canTrade && bs.edge === 'enterUpper') {
    if (_effN0 > 0 && _ts15.length) { st.pendingConfirm = { side: 'short', barT: _ts15[_ts15.length - 1], count: 0, setTs: Date.now(), n: _effN0 }; _block('short', 'confirm-wait'); }
    else if (_effN0 <= 0) _execEdgeLive('short');
  } else if (_canTrade && bs.edge === 'enterLower') {
    if (_effN0 > 0 && _ts15.length) { st.pendingConfirm = { side: 'long', barT: _ts15[_ts15.length - 1], count: 0, setTs: Date.now(), n: _effN0 }; _block('long', 'confirm-wait'); }
    else if (_effN0 <= 0) _execEdgeLive('long');
  }
  // 挂单确认推进（每秒检查；新 15m 根出现=前根收盘，检查刚收盘根最终 K/D 仍带内；超时作废）
  if (st.pendingConfirm && _ts15.length >= 2 && (_confirmNL > 0 || _effConfirmNow() > 0)) { // 推进门控与回测 _effConfirmAt(i)>0 同口径
    const pc = st.pendingConfirm;
    const _pcN = pc.n || _confirmNL; // 兼容旧挂单（无 n 字段时回退基础档位）
    const _lastT = _ts15[_ts15.length - 1];
    if (Date.now() - pc.setTs > (_pcN * 15 + 30) * 60 * 1000) st.pendingConfirm = null;
    else if (_lastT > pc.barT) {
      const _sl15 = srsiPanelSeries(_t15live.c || [], (cfg.srsiByTf && cfg.srsiByTf['15m']) || cfg.srsi, 150);
      const _kc = _sl15.k[_sl15.k.length - 2], _dc = _sl15.d[_sl15.d.length - 2];
      const _ebC = resolveEntryBands(cfg);
      const cp = srsiConfirmPass(_kc, _dc, _ebC.upper, _ebC.lower, pc.side, pc.count, _pcN);
      if (cp.fire) { st.pendingConfirm = null; try { pushSignalEvent({ sym, kind: 'srsi-confirm', side: pc.side, price, barT: _lastT, src: 'engine', count: _pcN, need: _pcN, text: '确认满 ' + _pcN + ' 根 → 执行开仓' }); } catch (e) {} _execEdgeLive(pc.side); }        // fire 优先于 active（fire 时 active=false=挂单被消费）
      else if (!cp.active) st.pendingConfirm = null;                            // 收盘根出带→作废
      else { pc.count = cp.count; pc.barT = _lastT; }                           // 未满根数→计数递进
    }
  }
  // 宽保护性止损(ATR)：持仓的 stopPx 被突破即平仓（落于爆仓线内侧，截真趋势破位）。默认关。
  if (cfg.srsiAutoAtrStop) {
    for (const p of (engine.S.pos || []).slice()) {
      if (p.sym !== sym || p.src !== 'srsiAuto' || p.stopPx == null) continue;
      const _hit = p.side === 'long' ? price <= p.stopPx : price >= p.stopPx;
      if (_hit) engine.exitPosition(p, { reason: 'SRSI自动 宽止损(ATR)' }); _pushSrsiMark({ t: Date.now(), action: 'close', reason: 'auto' });
    }
  }
  // SRSI 信号出口（实验旋钮，默认关）：中轨离场 + 超时离场——给亏损单"认输出口"。
  // 原平仓逻辑只平"对面带边沿+浮盈"的单，亏损单永无信号出口（只能扛到强平/ATR止损/期末）。
  if (cfg.srsiAutoExitK > 0 || cfg.srsiAutoMaxHoldBars > 0) {
    for (const p of (engine.S.pos || []).slice()) {
      if (p.sym !== sym || p.src !== 'srsiAuto') continue;
      let _exitReason = null;
      if (cfg.srsiAutoExitK > 0 && p.openK != null && bs && bs.k != null) {
        // 多单在 K 低处开（下带超卖），K 回升到 ≥exitK = 回归到位；空单镜像
        if (p.side === 'long' && p.openK < cfg.srsiAutoExitK && bs.k >= cfg.srsiAutoExitK) _exitReason = 'SRSI自动 中轨离场';
        else if (p.side === 'short' && p.openK > (100 - cfg.srsiAutoExitK) && bs.k <= (100 - cfg.srsiAutoExitK)) _exitReason = 'SRSI自动 中轨离场';
      }
      if (!_exitReason && cfg.srsiAutoMaxHoldBars > 0 && p.openT && (Date.now() - p.openT) >= cfg.srsiAutoMaxHoldBars * 15 * 60 * 1000) _exitReason = 'SRSI自动 超时离场';
      if (_exitReason) engine.exitPosition(p, { reason: _exitReason });
    }
  }
  _resolvePendingRev();
}

// 自动状态面板渲染（每秒刷新）
export function renderSrsiAutoPanel() {
  const el = typeof document !== 'undefined' ? document.getElementById('ktSrsiAutoPanel') : null;
  if (!el) return;
  _dangerNow = computeDangerNow(cfg.symbol);
  const optOk = _srsiAutoOptReady();
  const st = _autoState(cfg.symbol);
  const srsiDir = {};
  ['4h', '1h', '30m'].forEach(tf => { srsiDir[tf] = srsiDirOf(cfg.symbol, tf); });
  const _sizeWeights = { '4h': cfg.srsiAutoW4h, '1h': cfg.srsiAutoW1h, '30m': cfg.srsiAutoW30m };
  const _canTrade = cfg.srsiOptSource['15m'] === 'optimized';
  const _longScale = computeSizeScale('long', srsiDir, _sizeWeights, cfg.srsiOptSource);
  const _shortScale = computeSizeScale('short', srsiDir, _sizeWeights, cfg.srsiOptSource);
  const _longPct = +(cfg.srsiAutoBasePct * _longScale).toFixed(1);
  const _shortPct = +(cfg.srsiAutoBasePct * _shortScale).toFixed(1);
  // 只读计算带态用于显示，不写模块状态（避免“吃掉”实盘边沿信号）
  const _c15 = (getTFData(cfg.symbol, '15m') || {}).c || [];
  const _srsi15 = (cfg.srsiByTf && cfg.srsiByTf['15m']) || cfg.srsi;
  const _rows = buildSrsiOverview(['15m'], _srsi15, { '15m': _c15 });
  const _r = _rows && _rows[0];
    const _eb2 = resolveEntryBands(cfg);
    const _band = bandEdge(_autoState(cfg.symbol).band, _r && _r.k, _r && _r.d, { upper: _eb2.upper, lower: _eb2.lower }).band;
  const bandTxt = _band === 'upper' ? '上限带' : _band === 'lower' ? '下限带' : '中性';
  const dir = (x) => x === 'long' ? '多' : x === 'short' ? '空' : '—';
  const eng = _tradeEngine;
  const sub = eng && eng.getPerpSub ? eng.getPerpSub() : null;
  const price = eng && eng.S && eng.S.prices && eng.S.prices[cfg.symbol] && eng.S.prices[cfg.symbol].last;
  const _pos = (eng && eng.S && eng.S.pos) ? eng.S.pos.filter(p => p.sym === cfg.symbol) : [];
  const aLong = _pos.filter(p => p.side === 'long' && p.src === 'srsiAuto').length;
  const aShort = _pos.filter(p => p.side === 'short' && p.src === 'srsiAuto').length;
  const mLong = _pos.filter(p => p.side === 'long' && p.src !== 'srsiAuto').length;
  const mShort = _pos.filter(p => p.side === 'short' && p.src !== 'srsiAuto').length;
  const optList = SRSI_AUTO_TFS.map(tf => {
    const ok = cfg.srsiOptSource[tf] === 'optimized';
    return `<span class="kt-auto-tf ${ok ? 'ok' : 'no'}">${tf}${ok ? '✓' : '✗'}</span>`;
  }).join('');
  // 自动优选状态 + 阻塞因素状态灯
  const optSt = srsiAutoOptStatus();
  const _last = optSt.lastAutoOptTs ? new Date(optSt.lastAutoOptTs).toLocaleTimeString('zh-CN', { hour12: false }) : '未运行';
  const optStatTxt = `自动优选 ${optSt.enabled ? '开' : '关'}（${optSt.running ? '优选中…' : '空闲'} · 上次 ${_last} · 间隔${optSt.intervalH}h/无成交${optSt.noTradeH}h）`;
  const allAux = SRSI_AUTO_TFS.every(tf => cfg.srsiAuxByTf && cfg.srsiAuxByTf[tf]);
  const auxWarn = allAux ? `<div class="kt-auto-row kt-auto-note">⚠ 全部周期均设为「辅助只放行」→ 无方向信号，自动交易不会触发（至少 1 个周期需作方向源）</div>` : '';
  const _dangerTxt = _dangerNow
    ? `        <div class="kt-auto-row kt-danger-note">🚨 危险信号：当前开仓方向与大周期(4h/1h/30m) EMA120 趋势背离≥2，易爆仓${cfg.srsiAutoDanger === 'reverse' ? '（模型键命中才反手，否则避开）' : cfg.srsiAutoDanger === 'filter' ? '（已避开）' : '（仅提醒）'}。</div>`
    : '';
  // v1.6.16：最近一次拦截原因（静默拦截留痕）——解决「信号被捕捉但永不成交却无任何提示」
  const _blk = st.lastBlock;
  const _blkGuide = _blk ? blockGuideText(_blk.reason, cfg.symbol) : '';
  const _blkTxt = _blk
    ? `<div class="kt-auto-row kt-block-note">⛔ 最近拦截：${_blk.side === 'long' ? '开多' : '开空'} · ${blockReasonText(_blk.reason)} · ${new Date(_blk.ts).toLocaleTimeString('zh-CN', { hour12: false })}</div>`
      + (_blkGuide ? `<div class="kt-auto-row kt-block-guide">💡 ${_blkGuide}${_blk.reason === 'coin-inventory-0' ? ' <button class="kt-mini-btn" onclick="window.kchartSetSrsiAutoMode&&window.kchartSetSrsiAutoMode(\'usdt\')">改用 U 本位开多</button>' : ''}</div>` : '')
    : '';
  const _dataReady = ((getTFData(cfg.symbol, '15m') || {}).c || []).length >= 130;
  const _availOk = sub && ((sub.bal > 0) || ((sub.coins && sub.coins[cfg.symbol] > 0)));
  const _mmOk = aLong < cfg.srsiAutoMaxSame && aShort < cfg.srsiAutoMaxSame;
  const light = (on, t) => `<span class="kt-light ${on ? 'on' : 'off'}">${on ? '●' : '○'} ${t}</span>`;
    const _dangerLabel = cfg.srsiAutoDanger === 'reverse' ? '防爆反手(模型)' : cfg.srsiAutoDanger === 'filter' ? '预防爆仓' : cfg.srsiAutoDanger === 'smart' ? '预防爆仓(智能)' : cfg.srsiAutoDanger === 'revconf' ? '防爆反手(确认)' : '防爆关';
  const _dangerOn = cfg.srsiAutoDanger !== 'none';
  const _regimeLabel = (!cfg.srsiAutoRegimeGate || cfg.srsiAutoRegimeGate === 'off') ? null : (st.regime && st.regime.state ? ({ high: '高波·照常', mid: '中波·' + (cfg.srsiAutoRegimeGate === 'confirm' ? '降频' : cfg.srsiAutoRegimeGate === 'size' ? '减仓' : '观察'), lowdrift: '低波阴跌·禁开' }[st.regime.state] || null) : null);
  const lights = [
    light(!!eng, '引擎'), light(!!sub, '子账户'), light(price != null, '行情'),
    light(!!_availOk, '保证金'), light(_mmOk, '连开未封顶'), light(_dataReady, '数据就绪'),
    light(_dangerOn, _dangerLabel),
    light(_regimeLabel != null, _regimeLabel || '闸门关'),
    light(!!cfg.srsiAutoPdBlockOn, cfg.srsiAutoPdBlockOn ? ('危险拦截' + (st.pdBlocked ? '·' + st.pdBlocked : '')) : '危险拦截关')
  ].join(' ');
  const _pendSide = bandTxt === '下限带' ? 'long' : bandTxt === '上限带' ? 'short' : null;
  const _tfScale = (tf, w) => {
    const d = srsiDir[tf];
    const opt = cfg.srsiOptSource[tf] === 'optimized';
    if (!_pendSide) return `${dir(d)}(${opt ? '±' + w + '%' : '−' + w + '%'})`;
    const ok = opt && d === _pendSide;
    return `${dir(d)}${ok ? '✓+' + w + '%' : '·−' + w + '%'}`;
  };
  el.innerHTML = `
    <div class="kt-auto-row">优选: ${optList}${optOk ? '' : ' <span class="kt-auto-note">（未全优选：用默认 SRSI 参数交易，优选后更准）</span>'}</div>
    ${_canTrade ? '' : '<div class="kt-auto-row kt-auto-note">⛔ 15m 未优选：自动交易已暂停（请先优选 15m 周期）</div>'}
    <div class="kt-auto-row kt-auto-opt-stat">${optStatTxt}</div>
    <div class="kt-auto-row kt-lights">${lights}</div>
    <div class="kt-auto-row">缩放(#4·基准=15m ${dir(_pendSide)}): 4h ${_tfScale('4h', cfg.srsiAutoW4h)} ｜ 1h ${_tfScale('1h', cfg.srsiAutoW1h)} ｜ 30m ${_tfScale('30m', cfg.srsiAutoW30m)} → 因子 多${_longScale}/空${_shortScale}（已参与仓位缩放）</div>
    <div class="kt-auto-row">当前持仓 多${aLong + mLong}(自动${aLong}/人工${mLong}) · 空${aShort + mShort}(自动${aShort}/人工${mShort}) ｜ 仓位 多<b>${_longPct}%</b>/空<b>${_shortPct}%</b> · 杠杆 ${cfg.srsiAutoLev}x ｜ 盯盘 ${bandTxt}</div>
    ${cfg.srsiAutoCloseManual ? '<div class="kt-auto-row kt-auto-note">⚙ 自动可平人工单：开（反向人工单净盈利时也会被动平）</div>' : ''}
    ${auxWarn}
    ${_dangerTxt}
    ${_blkTxt}`;
  el.classList.toggle('kt-danger', !!cfg.srsiAutoDangerAlarm && _dangerNow);
}

// ===================== SRSI 自动交易 · 历史回测 =====================
// fetchKlinesRange 由 ../pwa/data.js 导入（Binance 公开 REST，按 endTime 向前分页）

// 纯函数回测：以 15m 为步进重放 SRSI 自动交易规则（无止损，靠最多同向3单控风险）
// 计入：开/平 taker 手续费、波动滑点、真实历史资金费率（与 PaperEngine 实盘成本模型同源）
// klinesByTf 兼容两种格式：原始 klines 数组([[t,o,h,l,c,...],...]) 或 parseKlines 解析对象({closes,times,...})
// fundingRates: 可选 [{fundingTime, fundingRate}] 升序；config.srsiAutoUseFunding 为真时计入
export function backtestSrsiAuto(sym, klinesByTf, config, principal, windowStart, fundingRates, opts) {
  const mode = (opts && opts.mode) || config.srsiAutoBtMode || 'perp';
  const isSpot = mode === 'spot';
  const norm = (tf) => {
    const x = klinesByTf && klinesByTf[tf];
    if (!x) return { closes: [], times: [] };
    if (Array.isArray(x)) return { closes: x.map(k => +k[4]), times: x.map(k => k[0]) };
    return { closes: (x.closes || []).map(v => +v), times: x.times || [] };
  };
  const n15 = norm('15m'), n1h = norm('1h'), n30 = norm('30m'), n4h = norm('4h');
  const c15 = n15.closes, c1h = n1h.closes, c30 = n30.closes, c4h = n4h.closes;
  const t15 = n15.times;
  if (c15.length < 130) return { error: '15m 数据不足', trades: [] };
  // 回测窗口起点：warmup 段只用于 SRSI 预热，成交只在 windowStart 之后重放
  let lo = 0;
  if (windowStart != null) { lo = t15.findIndex(t => t >= windowStart); if (lo < 0) lo = c15.length; }
  const p15 = config.srsiByTf && config.srsiByTf['15m'] ? config.srsiByTf['15m'] : config.srsi;
  const p4h = config.srsiByTf && config.srsiByTf['4h'] ? config.srsiByTf['4h'] : config.srsi;
  const p1h = config.srsiByTf && config.srsiByTf['1h'] ? config.srsiByTf['1h'] : config.srsi;
  const p30 = config.srsiByTf && config.srsiByTf['30m'] ? config.srsiByTf['30m'] : config.srsi;
  let kd15 = srsiKD(c15, p15);
  const t30 = n30.times, t1h = n1h.times, t4h = n4h.times;
  // 4h/1h/30m 方向行预计算（与实时 srsiDirOf 同一 buildSrsiOverview + auxGateDir 口径）
  let kd4hRows = c4h.length ? buildSrsiOverview(['4h'], p4h, { '4h': c4h }).rows : [];
  let kd1hRows = c1h.length ? buildSrsiOverview(['1h'], p1h, { '1h': c1h }).rows : [];
  let kd30Rows = c30.length ? buildSrsiOverview(['30m'], p30, { '30m': c30 }).rows : [];
  const atr15 = atrClose(c15, 14);
  const medianAtrPct15 = medianOf(atr15.map((a, idx) => (a != null && c15[idx]) ? a / c15[idx] * 100 : null)) || 0; // 全样本中位 ATR%（自适应杠杆基准）
  const ema15 = ema(c15, 120); // 15m EMA120（≈30h 趋势），供强平归因 priceVsEma
  const ema1h = ema(c1h, 120); // 1h EMA120（≈5d 趋势）
  // ---- GOAL29 regime 三态闸门（与实盘 srsiAutoRegime 同口径；off=零行为变化）----
  // 高波(1h ATR%≥滚动P75)→照常；中波→confirm+1 或 减仓×0.5；低波阴跌(<P25 且 价<1h EMA200)→禁开新仓。
  // 分位窗=1h ATR% 滚动 W 根（默认 480≈20d，与实盘 KLINE_LIMIT=500 内可复算一致）；冷启动 <360 样本闸门不生效。
  const gateMode = ['confirm', 'size', 'block', 'tconf'].includes(config.srsiAutoRegimeGate) ? config.srsiAutoRegimeGate : 'off';
  const gateEmaTf = config.srsiAutoRegimeEmaTf === '1d' ? '1d' : '1h';
  const n1d = gateEmaTf === '1d' ? norm('1d') : null; const c1d = n1d ? n1d.closes : null; const t1d = n1d ? n1d.times : null;
  const gateW = (typeof config.srsiAutoRegimeW === 'number' && config.srsiAutoRegimeW >= 60) ? Math.floor(config.srsiAutoRegimeW) : THRESH.REGIME_GATE_W;
  const _gateState = { high: 0, mid: 0, lowdrift: 0, na: 0, blockedOpens: 0, midSizes: 0, midConfirms: 0, pdBlocked: 0 };
  let _gatePct75 = null, _gatePct25 = null, _gateEma = null, _gatePct = null;
  if (gateMode !== 'off') {
    const _atrG = atrClose(c1h, 14);
    const _pct = _atrG.map((a, j) => (a != null && c1h[j]) ? a / c1h[j] * 100 : null);
    _gatePct = _pct;
    _gatePct75 = new Array(_pct.length).fill(null); _gatePct25 = new Array(_pct.length).fill(null);
    const win = []; const fifo = [];
    const MINN = THRESH.REGIME_GATE_MINN;
    for (let j = 0; j < _pct.length; j++) {
      const v = _pct[j];
      if (v != null && isFinite(v) && v > 0) {
        let lo = 0, hi = win.length; while (lo < hi) { const m = (lo + hi) >> 1; if (win[m] < v) lo = m + 1; else hi = m; }
        win.splice(lo, 0, v); fifo.push(v);
        if (fifo.length > gateW) { const old = fifo.shift(); let a = 0, b = win.length; while (a < b) { const m = (a + b) >> 1; if (win[m] < old) a = m + 1; else b = m; } if (win[a] === old) win.splice(a, 1); }
      }
      if (win.length >= MINN) { _gatePct75[j] = win[Math.floor(0.75 * (win.length - 1))]; _gatePct25[j] = win[Math.floor(0.25 * (win.length - 1))]; }
    }
    const _gateC = (gateEmaTf === '1d' && c1d && c1d.length >= 200) ? c1d : c1h;
    _gateEma = _gateC.length ? ema(_gateC, 200) : [];
  }
  const _regimeAt = (i) => {
    if (gateMode === 'off') return null;
    const j = idxLe(t1h, t15[i]);
    if (j < 0 || _gatePct75 == null || _gatePct75[j] == null) { _gateState.na++; return null; }
    const ap = _gatePct[j];
    if (ap == null) { _gateState.na++; return null; }
    if (ap >= _gatePct75[j]) return 'high';
    if (ap < _gatePct25[j]) {
      const je = (gateEmaTf === '1d' && t1d) ? idxLe(t1d, t15[i]) : j;
      const e = (je >= 0 && _gateEma[je] != null && isFinite(_gateEma[je])) ? _gateEma[je] : null;
      if (e != null && c15[i] < e) return 'lowdrift';
      return 'mid';
    }
    return 'mid';
  };
  const _regimeCache = gateMode !== 'off' ? new Array(c15.length).fill(undefined) : null;
  const _regimeCached = (i) => { if (gateMode === 'off') return null; if (_regimeCache[i] === undefined) { const r = _regimeAt(i); if (r) _gateState[r]++; _regimeCache[i] = r || null; } return _regimeCache[i]; };
  // ---- walk-forward SRSI 重优选（镜像实盘"自动优选4周期 + 间隔重优选"；默认关，不影响既有回测）----
  // reoptInBacktest: 在回测中按当时市场技术面，对 15m/30m/1h/4h 周期性重跑 optimizeSrsi 取数据驱动冠军参数，
  // 替换 srsiByTf 并重算 SRSI 数组，"还原现场"使回测与实盘行为一致（验证自动优选功能价值 + 降爆仓）。
  const reopt = !!(opts && opts.reoptInBacktest);
  const reoptIntervalH = (opts && opts.reoptIntervalH) || 24;          // 重优选间隔（小时），默认 24h（5h 太细会极慢）
  const reoptNoTradeH = (opts && opts.reoptNoTradeH) || 5;            // 无成交超该时长也触发重优选
  const intervalBars15 = Math.max(4, Math.round(reoptIntervalH * 4));  // 15m 每根 4 根/小时
  const noTradeMs = reoptNoTradeH * 3600 * 1000;
  const OPT_WIN = { '15m': 3000, '30m': 1500, '1h': 720, '4h': 180 }; // 各周期重优选回看窗口（≈20d/15m，平衡前瞻拟合与速度）
  const reoptTfs = ['15m', '30m', '1h', '4h'];
  const cByTf = { '15m': c15, '30m': c30, '1h': c1h, '4h': c4h };
  const tByTf = { '15m': t15, '30m': t30, '1h': t1h, '4h': t4h };
  let lastReoptBar = lo;
  let lastOpenT = (t15[lo] || 0);
  let reoptCount = 0, reoptAdopt = 0;
  function doReopt(i) {
    for (const tf of reoptTfs) {
      const c = cByTf[tf], t = tByTf[tf];
      const iTf = (tf === '15m') ? i : idxLe(t, t15[i]);
      if (iTf < 0) continue;
      const win = OPT_WIN[tf];
      const hist = c.slice(Math.max(0, iTf - win), iTf + 1);
      if (hist.length < 120) continue;
      let r;
      try { r = optimizeSrsi(hist, { role: 'swing' }); } catch (e) { continue; }
      if (!r || !r.best) continue;
      if (r.decision !== 'adopt' && r.decision !== 'caution') continue; // 仅采纳验证集优于默认的冠军（防过拟合虚高）
      const best = r.best;
      reoptAdopt++;
      if (tf === '15m') kd15 = srsiKD(c15, best);
      else if (tf === '30m') kd30Rows = buildSrsiOverview(['30m'], best, { '30m': c30 }).rows;
      else if (tf === '1h') kd1hRows = buildSrsiOverview(['1h'], best, { '1h': c1h }).rows;
      else if (tf === '4h') kd4hRows = buildSrsiOverview(['4h'], best, { '4h': c4h }).rows;
    }
  }
  // v2 热停开：1h ATR > 1.3×sma20(1h ATR) 时禁止新开普通单（反手仍允许）。
  // opts.hotStop 保留为回测调用方的显式覆盖；常规配置走 srsiAutoHotStop。
  const hotStopEnabled = opts && typeof opts.hotStop === 'boolean' ? opts.hotStop : !!config.srsiAutoHotStop;
  let atr1h = null, sma20atr1h = null;
  if (hotStopEnabled) {
    atr1h = atrClose(c1h, 14);
    sma20atr1h = [];
    for (let i = 0; i < atr1h.length; i++) {
      if (i < 19) { sma20atr1h.push(null); continue; }
      let s = 0; for (let j = i - 19; j <= i; j++) s += atr1h[j];
      sma20atr1h.push(s / 20);
    }
  }
  const _hotStopNow = (i) => {
    if (!hotStopEnabled) return false;
    const i1h = idxLe(t1h, t15[i]);
    return i1h >= 0 && atr1h && atr1h[i1h] != null && sma20atr1h && sma20atr1h[i1h] != null && sma20atr1h[i1h] > 0 && atr1h[i1h] > 1.3 * sma20atr1h[i1h];
  };
  const _eb = resolveEntryBands(config);
  const upper = _eb.upper, lower = _eb.lower, lev = config.srsiAutoLev, maxSame = config.srsiAutoMaxSame;
  const effLev = isSpot ? 1 : lev; // 现货无杠杆
  const openCapUsdt = config.srsiAutoOpenCapUsdt > 0 ? config.srsiAutoOpenCapUsdt : Infinity;
  const openCapCoin = config.srsiAutoOpenCapCoin > 0 ? config.srsiAutoOpenCapCoin : Infinity;
  const useCost = config.srsiAutoUseCost !== false;
  const feeRate = useCost && (typeof config.srsiAutoFeeRate === 'number') ? config.srsiAutoFeeRate : 0;
  const slipBase = useCost && (typeof config.srsiAutoSlipBase === 'number') ? config.srsiAutoSlipBase : 0;
  const useFunding = !isSpot && useCost && config.srsiAutoUseFunding !== false && Array.isArray(fundingRates) && fundingRates.length > 0;
  const slipAt = (i) => {
    if (!useCost) return 0;
    const ap = (i < atr15.length && atr15[i] && c15[i]) ? atr15[i] / c15[i] : 0;
    return Math.min(THRESH.SLIP_CAP, slipBase + THRESH.SLIP_K * ap);
  };
  // 资金费率游标：仅在持仓且结算时刻位于 (上一根, 当前根] 内时计入
  const fundArr = useFunding ? fundingRates.slice().sort((a, b) => a.fundingTime - b.fundingTime) : [];
  let fundIdx = 0;
  // 余额：
  //  - 现货用双余额 uBal(USDT)/coinBal(币)
  //  - 合约用双池真实建模：USDT 池 avail + 币库存池 coinAvail(币单位)，按 srsiAutoMode 播种
  //    usdt: 全 U 本位(avail=P, coinAvail=0) ｜ coin: 全币本位(avail=0, coinAvail=P/startPrice) ｜ follow: 各 P/2
  //    startVal = avail + coinAvail*startPrice ≡ P，pnl% 口径不变
  const initU = isSpot ? (opts && opts.spotUsdt != null ? opts.spotUsdt : principal) : 0;
  const initC = isSpot ? (opts && opts.spotCoin != null ? opts.spotCoin : 0) : 0;
  const startPrice = c15[lo] || 0;
  let avail0 = principal, coinAvail0 = 0;
  if (!isSpot) {
    const bm = config.srsiAutoMode || 'follow';
    const coinSeed = (opts && typeof opts.coinSeed === 'number' && opts.coinSeed > 0) ? opts.coinSeed : 0;
    if (bm === 'usdt') { avail0 = principal; coinAvail0 = 0; }
    else if (bm === 'coin') { avail0 = 0; coinAvail0 = coinSeed > 0 ? coinSeed : (startPrice ? principal / startPrice : 0); }
    else { avail0 = principal / 2; coinAvail0 = coinSeed > 0 ? coinSeed : (startPrice ? (principal / 2) / startPrice : 0); }
  }
  let avail = isSpot ? 0 : avail0, uBal = initU, coinBal = initC, coinAvail = isSpot ? 0 : coinAvail0, positions = [], prevBand = 'neutral', prevArmed = false;
  let maxOpenLong = 0, maxOpenShort = 0;
  const trades = []; const equitySeries = [];
  const startVal = isSpot ? (initU + initC * startPrice) : (avail0 + coinAvail0 * startPrice);
  let peak = startVal, maxDD = 0;
  let totalFee = 0, totalSlip = 0, totalFunding = 0;
  let liqCount = 0, liqLoss = 0;
  let dangerHits = 0, reverseOpens = 0, reversePnl = 0, pdHits = 0; // 危险信号触发次数(emaOpp2基线,跨模式一致) / 防爆反手开单次数 / 反手单累计盈亏 / 多因子预测危险次数(供reverse触发)
  let stopCount = 0, stopLoss = 0; // 硬止损平仓次数/累计盈亏（预防爆仓主力：把 ~14% 强平损失压缩为可控小损）
  const stopPct = (typeof config.srsiAutoStopPct === 'number' && config.srsiAutoStopPct > 0) ? config.srsiAutoStopPct : 0;
  // SRSI 信号出口旋钮（实验，默认关）：中轨离场(K 回归) + 最长持仓根数(超时认输)
  const exitK = (typeof config.srsiAutoExitK === 'number' && config.srsiAutoExitK >= 30) ? config.srsiAutoExitK : 0;
  const holdBars = (typeof config.srsiAutoMaxHoldBars === 'number' && config.srsiAutoMaxHoldBars >= 1) ? config.srsiAutoMaxHoldBars : 0;
  const revConfirm = (typeof config.srsiAutoRevConfirm === 'number' && config.srsiAutoRevConfirm > 0) ? config.srsiAutoRevConfirm : 3;
  const pendingRev = { long: null, short: null }; // revconf：危险信号触发后待价格确认才开的反手挂单
  let pendingConfirm = null; // GOAL27 确认 bar 挂单 {side, idx, count, n}
  const _confirmN = (config.srsiAutoConfirmBars != null) ? Math.max(0, Math.min(5, Math.floor(+config.srsiAutoConfirmBars || 0))) : 0;
  // GOAL29-A2：AIS regime 类型（复刻 detectRegimeState 无 pctHis 路径，因果预计算）——tconf 用
  const _aisLine = gateMode === 'tconf' && c1h.length >= 90 ? ais(c1h, 20, 8, 32, 14, 2).line : null;
  const _typeAt = (i) => {
    const j = idxLe(t1h, t15[i]);
    if (!_aisLine || j < 60 || _aisLine[j] == null || _aisLine[j - 60] == null || !_aisLine[j - 60]) return null;
    const slope = (_aisLine[j] - _aisLine[j - 60]) / _aisLine[j - 60] * 100;
    if (Math.abs(slope) < THRESH.REGIME_DEAD_SLOPE_PCT) return 'range';
    const above = c1h[j] > _aisLine[j];
    return slope > 0 ? (above ? 'trend-up' : 'pullback-up') : (above ? 'pullback-down' : 'trend-down');
  };
  const _typeCache = _aisLine ? new Array(c15.length).fill(undefined) : null;
  const _typeCached = (i) => { if (!_aisLine) return null; if (_typeCache[i] === undefined) _typeCache[i] = _typeAt(i); return _typeCache[i]; };
  const _effConfirmAt = (i) => {
    if (gateMode === 'confirm' && _regimeCached(i) === 'mid') return _confirmN + THRESH.REGIME_GATE_MID_CONFIRM; // GOAL29：中波降频
    if (gateMode === 'tconf' && _typeCached(i) && _typeCached(i).indexOf('trend') === 0) return _confirmN + THRESH.REGIME_GATE_MID_CONFIRM; // GOAL29-A2：趋势市升确认
    return _confirmN;
  };
  const liqLog = []; // 强平单归因日志：开仓/强平时刻的技术面上下文（供第三方 AI 找爆仓共同点）
  const openLog = []; // 全部开仓快照（含未爆仓，作对照组）：开仓时技术面上下文 + 是否最终爆仓
  const grossPnl = (side, entry, exit, amtUsdt, useLev) => (side === 'long' ? (exit - entry) : (entry - exit)) / entry * (useLev || effLev) * amtUsdt;
  for (let i = lo; i < c15.length; i++) {
    const price = c15[i];
    // walk-forward 重优选触发：间隔到期 或 久无成交
    if (reopt && (i - lastReoptBar >= intervalBars15 || t15[i] - lastOpenT >= noTradeMs)) {
      doReopt(i);
      reoptCount++;
      lastReoptBar = i;
      lastOpenT = t15[i];
    }
    const k = kd15.k[i], d = kd15.d[i];
    // 资金费率结算（持仓跨越 8h 整点，仅合约）
    if (!isSpot) {
      for (const p of positions.slice()) {
        while (fundIdx < fundArr.length && fundArr[fundIdx].fundingTime <= t15[i]) {
          const fr = fundArr[fundIdx]; fundIdx++;
          if (fr.fundingTime > p.openT) {
            const notional = p.amtUsdt * (p.lev || lev);
            const pay = fundingPayment({ side: p.side, notional, fundingRate: +fr.fundingRate });
            if (p.marginMode === 'usdt') avail += pay;
            else coinAvail += pay / p.entry;
            p.fundingAcc += pay; totalFunding += pay;
          }
        }
      }
    }
    // 爆仓检查（逐仓 U 本位，按交易所 MMR 真实规则，见 engine/liquidation.js；现货无爆仓）
    if (!isSpot) {
      for (const p of positions.slice()) {
        if (p.liqPrice == null) continue;
        const hit = p.side === 'long' ? price <= p.liqPrice : price >= p.liqPrice;
        if (!hit) continue;
        const closeFee = p.amtUsdt * (p.lev || lev) * feeRate;
        const gp = grossPnl(p.side, p.entry, p.liqPrice, p.amtUsdt, p.lev);
        const pnl = gp - closeFee - (p.openFee || 0) - (p.openSlip || 0) + p.fundingAcc;
        const marginCoin = p.amtUsdt / p.entry;
        if (p.marginMode === 'usdt') { avail += p.amtUsdt + gp; avail -= closeFee; }
        else { coinAvail += marginCoin + (gp - closeFee) / p.liqPrice; }
        totalFee += closeFee;
        liqCount++; liqLoss += pnl;
        if (p.reverse) reversePnl += pnl;
        // 强平归因：开仓+强平时刻大周期技术面上下文（强平块位于循环顶部，需就地用 idxLe 取大周期行）
        const _lj4h = idxLe(t4h, t15[i]), _lj1h = idxLe(t1h, t15[i]), _lj30 = idxLe(t30, t15[i]);
        const _lr4h = _lj4h >= 0 ? kd4hRows[_lj4h] : null, _lr1h = _lj1h >= 0 ? kd1hRows[_lj1h] : null, _lr30 = _lj30 >= 0 ? kd30Rows[_lj30] : null;
        const _adv = p.entry ? (p.side === 'long' ? (p.liqPrice - p.entry) / p.entry : (p.entry - p.liqPrice) / p.entry) * 100 : 0;
        liqLog.push({
          sym, openT: p.openT, openPrice: p.entry, side: p.side, lev: p.lev, reverse: p.reverse,
          marginMode: p.marginMode, amtUsdt: p.amtUsdt, liqT: t15[i], liqPrice: p.liqPrice,
          adverseMovePct: +_adv.toFixed(3),
          openCtx: p.openCtx || null,
          liqCtx: {
            k15: k, d15: d,
            srsi4h: _lr4h ? auxGateDir(_lr4h) : null,
            srsi1h: _lr1h ? auxGateDir(_lr1h) : null,
            srsi30m: _lr30 ? auxGateDir(_lr30) : null,
            ema4h: _lj4h >= 0 ? klineDirFromCloses(c4h.slice(0, _lj4h + 1)) : null,
            ema1h: _lj1h >= 0 ? klineDirFromCloses(c1h.slice(0, _lj1h + 1)) : null,
            ema30m: _lj30 >= 0 ? klineDirFromCloses(c30.slice(0, _lj30 + 1)) : null
          },
          fundingAcc: p.fundingAcc
        });
         trades.push({ t: t15[i], side: p.side, action: 'liquidate', price: p.liqPrice, gross: gp, fee: (p.openFee || 0) + closeFee, slip: (p.openSlip || 0), funding: p.fundingAcc, pnl, bal: (p.marginMode === 'usdt' ? avail : coinAvail * p.liqPrice), k, d, liq: true, liqPrice: p.liqPrice, amt: p.amtUsdt, lev: p.lev, marginMode: p.marginMode, reverse: p.reverse });
        positions = positions.filter(x => x !== p);
      }
    }
    // 硬止损：价格逆向达到 stopPct（固定%）或 ATR 宽止损（srsiAutoAtrStop，mult×受监督ATR%）即平仓。
    // 替代“仅强平”，把 ~14% 强平损失压缩为可控小损。不计入 liquidate（liq 仅指被强平价清零），计入 stopCount/stopLoss 与 reversePnl。
    if (stopPct > 0 || config.srsiAutoAtrStop) {
      for (const p of positions.slice()) {
        if (config.srsiAutoAtrStop && p.stopPx == null) {
          const curAtrPct = (atr15[i] != null && c15[i]) ? atr15[i] / c15[i] * 100 : 0;
          p.stopPx = protectiveStopPrice(p.entry, p.side, curAtrPct, config.srsiAutoAtrStopMult);
        }
        const stopPrice = p.stopPx != null ? p.stopPx
          : (stopPct > 0 ? (p.side === 'long' ? p.entry * (1 - stopPct / 100) : p.entry * (1 + stopPct / 100)) : null);
        if (stopPrice == null) continue;
        const hit = p.side === 'long' ? price <= stopPrice : price >= stopPrice;
        if (!hit) continue;
        const closeFee = p.amtUsdt * (p.lev || lev) * feeRate;
        const slipCost = p.amtUsdt * (p.lev || effLev) * slipAt(i);
        const gp = grossPnl(p.side, p.entry, stopPrice, p.amtUsdt, p.lev);
        const pnl = gp - closeFee - (p.openFee || 0) - (p.openSlip || 0) + p.fundingAcc;
        if (p.marginMode === 'usdt') { avail += p.amtUsdt + gp; avail -= closeFee; }
        else { const mc = p.amtUsdt / p.entry; coinAvail += mc + (gp - closeFee) / stopPrice; }
        totalFee += closeFee; totalSlip += slipCost;
        stopCount++; stopLoss += pnl;
        if (p.reverse) reversePnl += pnl;
        trades.push({ t: t15[i], side: p.side, action: 'stop', price: stopPrice, gross: gp, fee: (p.openFee || 0) + closeFee, slip: slipCost, funding: p.fundingAcc, pnl, bal: (p.marginMode === 'usdt' ? avail : coinAvail * stopPrice), k, d, stop: true, liqPrice: p.liqPrice, amt: p.amtUsdt, lev: p.lev, marginMode: p.marginMode, reverse: p.reverse });
        positions = positions.filter(x => x !== p);
      }
    }
    // SRSI 信号出口（实验旋钮，默认关）：中轨离场 + 超时离场。给亏损单一个"认输出口"——
    // 原平仓逻辑只平"对面带边沿+浮盈"的单（enterUpper 平盈利多单 / enterLower 平盈利空单），
    // 亏损单永无信号出口（只能扛到强平/ATR止损/期末），是低夏普与高强平数的结构性根源。
    // 会计镜像上方硬止损块（盈亏都记账），计入 stopCount/stopLoss；现货路径会计不同，跳过。
    if (exitK > 0 || holdBars > 0) {
      for (const p of positions.slice()) {
        if (p.marginMode === 'spot') continue;
        let exitReason = null;
        if (exitK > 0 && p.openK != null) {
          // 多单在 K 低处开（下带超卖），K 回升到 ≥exitK = 回归到位；空单镜像（K 从高处回落到 ≤100-exitK）
          if (p.side === 'long' && p.openK < exitK && k >= exitK) exitReason = 'SRSI自动 中轨离场';
          else if (p.side === 'short' && p.openK > (100 - exitK) && k <= (100 - exitK)) exitReason = 'SRSI自动 中轨离场';
        }
        if (!exitReason && holdBars > 0 && p.openIdx != null && i - p.openIdx >= holdBars) exitReason = 'SRSI自动 超时离场';
        if (!exitReason) continue;
        const _xlev = p.lev || lev;
        const closeFee = p.amtUsdt * _xlev * feeRate;
        const slipCost = p.amtUsdt * _xlev * slipAt(i);
        const gp = grossPnl(p.side, p.entry, price, p.amtUsdt, _xlev);
        const pnl = gp - closeFee - (p.openFee || 0) - (p.openSlip || 0) + p.fundingAcc;
        const marginCoin = p.amtUsdt / p.entry;
        if (p.marginMode === 'usdt') { avail += p.amtUsdt + gp; avail -= closeFee; }
        else { coinAvail += marginCoin + (gp - closeFee) / price; }
        totalFee += closeFee; totalSlip += slipCost;
        stopCount++; stopLoss += pnl;
        if (p.reverse) reversePnl += pnl;
        trades.push({ t: t15[i], side: p.side, action: 'close', price, gross: gp, fee: (p.openFee || 0) + closeFee, slip: slipCost, funding: p.fundingAcc, pnl, bal: (p.marginMode === 'usdt' ? avail : coinAvail * price), k, d, reason: exitReason, liqPrice: p.liqPrice, amt: p.amtUsdt, lev: p.lev, marginMode: p.marginMode, reverse: p.reverse });
        positions = positions.filter(x => x !== p);
      }
    }
    const be = bandEdge(prevBand, k, d, { upper, lower }, prevArmed);
    prevBand = be.band; prevArmed = be.armed;
    // 方向合力：与实时 runSrsiAutoTrade 同口径（时间对齐到 15m 当前根；auxGateDir 而非 srsiDirFromKD）
    const j4h = idxLe(t4h, t15[i]), j1h = idxLe(t1h, t15[i]), j30 = idxLe(t30, t15[i]);
    const r4h = j4h >= 0 ? kd4hRows[j4h] : null, r1h = j1h >= 0 ? kd1hRows[j1h] : null, r30 = j30 >= 0 ? kd30Rows[j30] : null;
    const klineDir = {
      '4h': klineDirFromCloses(c4h.slice(0, j4h + 1)),
      '1h': klineDirFromCloses(c1h.slice(0, j1h + 1)),
      '30m': klineDirFromCloses(c30.slice(0, j30 + 1)),
      '15m': klineDirFromCloses(c15.slice(0, i + 1))
    };
    const srsiDir = {
      '4h': r4h ? auxGateDir(r4h) : null,
      '1h': r1h ? auxGateDir(r1h) : null,
      '30m': r30 ? auxGateDir(r30) : null
    };
    // 回测为分析工具：srsiOptSource 为空（无显式周期标记）⇒ 视为全部已优选、不施加 15m 硬闸门、
    // 不做 #4 权重缩放（保留旧行为）；仅当传入带键的 srsiOptSource（真实 runSrsiBacktest 路径）才应用
    const _optMap = (config.srsiOptSource && typeof config.srsiOptSource === 'object') ? config.srsiOptSource : null;
    const _optHasKeys = !!(_optMap && Object.keys(_optMap).length > 0);
    const _optTfs = (config.srsiBtOptTfs && Array.isArray(config.srsiBtOptTfs) && config.srsiBtOptTfs.length) ? config.srsiBtOptTfs : SRSI_AUTO_TFS;
    const _isOpt = (tf) => _optHasKeys ? (_optMap[tf] === 'optimized' && _optTfs.indexOf(tf) >= 0) : true;
    const _scaleSource = _optHasKeys ? _optMap : SRSI_AUTO_TFS.reduce((o, tf) => { o[tf] = 'optimized'; return o; }, {});
    const _canTrade = _isOpt('15m');
    const _sizeWeights = { '4h': config.srsiAutoW4h, '1h': config.srsiAutoW1h, '30m': config.srsiAutoW30m };
    let equity = isSpot
      ? uBal + coinBal * c15[i]
      : (avail + coinAvail * c15[i] + positions.reduce((s, p) => s + grossPnl(p.side, p.entry, c15[i], p.amtUsdt), 0));
    equitySeries.push({ t: t15[i], eq: equity });
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? (peak - equity) / peak : 0;
    if (dd > maxDD) maxDD = dd;
    const _ol = positions.filter(p => p.side === 'long').length, _os = positions.filter(p => p.side === 'short').length;
    if (_ol > maxOpenLong) maxOpenLong = _ol;
    if (_os > maxOpenShort) maxOpenShort = _os;
    const _settleClose = (p, exitPrice, slip) => {
      const _lev = p.lev || effLev;
      const exitSlipCost = p.amtUsdt * _lev * slip;
      const closeFee = p.amtUsdt * _lev * feeRate;
      const gp = grossPnl(p.side, p.entry, exitPrice, p.amtUsdt, _lev);
      const fee = (p.openFee || 0) + closeFee;
      const slipCost = (p.openSlip || 0) + exitSlipCost;
      const net = gp - fee - slipCost + p.fundingAcc;
      if (isSpot) {
        // 现货：无论盈亏都平仓（卖币回 U / 买币回库存），诚实计入
        if (p.side === 'long') { uBal += p.qty * exitPrice; uBal -= closeFee; coinBal -= p.qty; }
        else { uBal -= p.qty * exitPrice; uBal -= closeFee; coinBal += p.qty; }
        totalFee += closeFee; totalSlip += exitSlipCost;
        if (p.reverse) reversePnl += net;
        trades.push({ t: t15[i], side: p.side, action: 'close', price: exitPrice, gross: gp, fee, slip: slipCost, funding: p.fundingAcc, pnl: net, bal: uBal, k, d, marginMode: p.marginMode, reverse: p.reverse });
        return true;
      }
      if (net <= 0) return false; // 亏损不平仓：净亏则丢弃仓位、不记账（开仓费已在开仓时扣，作为已实现成本保留）
      const marginCoin = p.amtUsdt / p.entry;
      if (p.marginMode === 'usdt') { avail += p.amtUsdt + gp; avail -= closeFee; }
      else { coinAvail += marginCoin + (gp - closeFee) / exitPrice; }
      totalFee += closeFee; totalSlip += exitSlipCost;
      if (p.reverse) reversePnl += net;
      trades.push({ t: t15[i], side: p.side, action: 'close', price: exitPrice, gross: gp, fee, slip: slipCost, funding: p.fundingAcc, pnl: net, bal: (p.marginMode === 'usdt' ? avail : coinAvail * exitPrice), k, d, marginMode: p.marginMode, reverse: p.reverse });
      return true;
    };
    const _netClose = (p, exit) => grossPnl(p.side, p.entry, exit, p.amtUsdt, p.lev) - (p.openFee || 0) - p.amtUsdt * (p.lev || effLev) * feeRate - p.amtUsdt * (p.lev || effLev) * slipAt(i) + p.fundingAcc;
    const _tryOpen = (side, rev) => {
      if (price == null || !_canTrade) return;
      const isRev = !!rev;
      if (_regimeCached(i) === 'lowdrift') { _gateState.blockedOpens++; return; } // GOAL29：低波阴跌禁开新仓（含反手）
      if (!isRev && _hotStopNow(i)) return; // 热停开：1h ATR 异常放大，禁止新开普通单（反手仍允许）
      // 开仓时刻技术面快照（供强平归因：开单前大周期 SRSI/EMA 是否已有预警）
      const _i1h = idxLe(t1h, t15[i]);
      const openCtx = {
        k15: k, d15: d,
        srsi4h: r4h ? auxGateDir(r4h) : null,
        srsi1h: r1h ? auxGateDir(r1h) : null,
        srsi30m: r30 ? auxGateDir(r30) : null,
        ema4h: klineDir['4h'], ema1h: klineDir['1h'], ema30m: klineDir['30m'],
        atrPct15: (atr15[i] != null && c15[i]) ? +(atr15[i] / c15[i] * 100).toFixed(3) : null,
        priceVsEma15: (ema15[i] != null && isFinite(ema15[i]) && ema15[i] !== 0) ? +((c15[i] - ema15[i]) / ema15[i] * 100).toFixed(3) : null,
        priceVsEma1h: (ema1h[_i1h] != null && isFinite(ema1h[_i1h]) && ema1h[_i1h] !== 0) ? +((c15[i] - ema1h[_i1h]) / ema1h[_i1h] * 100).toFixed(3) : null,
        recentCandlePct: (i >= 4 && c15[i - 4]) ? +((c15[i] - c15[i - 4]) / c15[i - 4] * 100).toFixed(3) : null,
        hotStop: !!_hotStopNow(i)
      };
      // 反手单为独立类别：不计入同向连开上限，也不受其限制
      const sameCount = positions.filter(p => p.side === side && !p.reverse).length;
      if (!isRev && sameCount >= maxSame) return;
      openCtx.sameCountAtOpen = sameCount;
      // GOAL31-D：PD-A 危险拦截（predictDanger 多因子≥2 命中→拦截该笔普通开仓；反手单不拦；默认 off=零行为变化；与 fork /tmp/goal31-btsa.mjs 钩子同位同 ctx）
      if (!isRev && config.srsiAutoPdBlockOn) {
        const _agree = ['4h', '1h', '30m'].filter(tf => openCtx['ema' + tf] === side).length;
        if (predictDanger({ dir: side, k15: openCtx.k15, atrPct15: openCtx.atrPct15, priceVsEma1h: openCtx.priceVsEma1h, priceVsEma15: openCtx.priceVsEma15, recentCandlePct: openCtx.recentCandlePct, sameCount, emaAgree: _agree, emaOpp2Weak: emaOpp2(side, klineDir) }).danger) { _gateState.pdBlocked++; return; }
      }
      // #4 乘法缩放：基准% × (1 ± 合计%)；未优选/反向周期扣对应权重
      const scale = computeSizeScale(side, srsiDir, _sizeWeights, _scaleSource);
      const basePct = (isRev && config.srsiAutoReversePct > 0) ? config.srsiAutoReversePct : config.srsiAutoBasePct;
      let effPct = basePct;
      if (!isRev && sameCount > 0 && config.srsiAutoStackDecay > 0 && config.srsiAutoStackDecay < 1) {
        const front = (typeof config.srsiAutoStackFront === 'number' && config.srsiAutoStackFront > 1) ? config.srsiAutoStackFront : 1;
        const exp = Math.max(0, sameCount - (front - 1));
        effPct = basePct * Math.pow(config.srsiAutoStackDecay, exp);
      }
      const sizePct = effPct * scale * (!isRev && gateMode === 'size' && _regimeCached(i) === 'mid' ? THRESH.REGIME_GATE_MID_SIZE : 1); // GOAL29：中波减仓
      if (!isRev && gateMode === 'size' && _regimeCached(i) === 'mid') _gateState.midSizes++;
      const slip = slipAt(i);
      if (isSpot) {
        if (side === 'long') {
          if (uBal <= 0) return;
          let amtUsdt = uBal * sizePct / 100;
          amtUsdt = Math.min(amtUsdt, openCapUsdt, openCapCoin * price);
          if (amtUsdt <= 0) return;
          if (config.srsiAutoOpenFloorUsdt > 0 && amtUsdt < config.srsiAutoOpenFloorUsdt) return;
          const fill = price * (1 + slip); // 买币滑点
          const qty = amtUsdt / fill;
          const openFee = amtUsdt * feeRate;
          uBal -= amtUsdt; uBal -= openFee;
          coinBal += qty;
          totalFee += openFee;
          positions.push({ side, entry: fill, rawEntry: price, qty, amtUsdt, lev: effLev, openFee, openSlip: 0, fundingAcc: 0, openT: t15[i], openIdx: i, openK: k, src: 'srsiAuto', reverse: isRev, liqPrice: null, marginMode: 'spot', openCtx });
          lastOpenT = t15[i];
          openLog.push({ openT: t15[i], side, lev: effLev, reverse: isRev, openCtx });
          trades.push({ t: t15[i], side, action: 'open', price: fill, pct: sizePct, lev: effLev, amt: amtUsdt, fee: openFee, slip: 0, funding: 0, pnl: null, bal: uBal, k, d, liqPrice: null, marginMode: 'spot', reverse: isRev });
        } else {
          if (coinBal <= 0) return; // 仅卖已有币（现货无借币）
          let amtCoin = coinBal * sizePct / 100;
          amtCoin = Math.min(amtCoin, openCapCoin, openCapUsdt / price);
          if (amtCoin <= 0) return;
          if (config.srsiAutoOpenFloorCoin > 0 && amtCoin < config.srsiAutoOpenFloorCoin) return;
          const fill = price * (1 - slip); // 卖币滑点
          const proceeds = amtCoin * fill;
          const openFee = proceeds * feeRate;
          uBal += proceeds; uBal -= openFee;
          coinBal -= amtCoin;
          totalFee += openFee;
          positions.push({ side, entry: fill, rawEntry: price, qty: amtCoin, amtUsdt: proceeds, lev: effLev, openFee, openSlip: 0, fundingAcc: 0, openT: t15[i], openIdx: i, openK: k, src: 'srsiAuto', reverse: isRev, liqPrice: null, marginMode: 'spot', openCtx });
          lastOpenT = t15[i];
          openLog.push({ openT: t15[i], side, lev: effLev, reverse: isRev, openCtx });
          trades.push({ t: t15[i], side, action: 'open', price: fill, pct: sizePct, lev: effLev, amt: proceeds, fee: openFee, slip: 0, funding: 0, pnl: null, bal: uBal, k, d, liqPrice: null, marginMode: 'spot', reverse: isRev });
        }
        return;
      }
      const mm = _autoMarginMode(side, config);
      const poolAvail = mm === 'usdt' ? avail : coinAvail * price;
      let amtUsdt = poolAvail * sizePct / 100;
      amtUsdt = Math.min(amtUsdt, openCapUsdt, openCapCoin * price);
      if (amtUsdt <= 0) return;
      if (config.srsiAutoOpenFloorUsdt > 0 && amtUsdt < config.srsiAutoOpenFloorUsdt) return;
      const _atrPctNow = (atr15[i] != null && price) ? atr15[i] / price * 100 : null;
      const baseLevForOpen = (isRev && config.srsiAutoReverseLev > 0) ? config.srsiAutoReverseLev : lev;
      const useLev = config.srsiAutoAdaptiveLev ? adaptiveLeverage({ baseLev: baseLevForOpen, atrPct: _atrPctNow, medianAtrPct: medianAtrPct15, minLev: config.srsiAutoAdaptiveLevMin }) : baseLevForOpen;
      const fill = side === 'short' ? price * (1 - slip) : price * (1 + slip);
      const _stopPx = config.srsiAutoAtrStop ? protectiveStopPrice(fill, side, _atrPctNow, config.srsiAutoAtrStopMult) : null;
      const marginCoin = amtUsdt / fill;
      const openFee = amtUsdt * useLev * feeRate;
      const openSlip = amtUsdt * useLev * slip;
      if (mm === 'usdt') { avail -= amtUsdt; avail -= openFee; }
      else { coinAvail -= marginCoin; coinAvail -= openFee / fill; }
      totalFee += openFee; totalSlip += openSlip;
      const liqPrice = liquidationPrice({ exchange: 'Binance', side, entry: fill, lev: useLev, notional: amtUsdt * useLev, symbol: sym });
      positions.push({ side, entry: fill, rawEntry: price, amtUsdt, lev: useLev, openFee, openSlip, fundingAcc: 0, openT: t15[i], openIdx: i, openK: k, src: 'srsiAuto', reverse: isRev, liqPrice, stopPx: _stopPx, marginMode: mm, openCtx });
      lastOpenT = t15[i];
          openLog.push({ openT: t15[i], side, lev: useLev, reverse: isRev, openCtx });
      trades.push({ t: t15[i], side, action: 'open', price: fill, pct: sizePct, lev: useLev, amt: amtUsdt, fee: openFee, slip: openSlip, funding: 0, pnl: null, bal: (mm === 'usdt' ? avail : coinAvail * fill), k, d, liqPrice, marginMode: mm, reverse: isRev });
    };
    const _attemptOpen = (side) => {
      const _i1h = idxLe(t1h, t15[i]);
      const _atrPct15 = (atr15[i] != null && c15[i]) ? atr15[i] / c15[i] * 100 : null;
      const _pve15 = (ema15[i] != null && isFinite(ema15[i]) && ema15[i] !== 0) ? (c15[i] - ema15[i]) / ema15[i] * 100 : null;
      const _pve1h = (ema1h[_i1h] != null && isFinite(ema1h[_i1h]) && ema1h[_i1h] !== 0) ? (c15[i] - ema1h[_i1h]) / ema1h[_i1h] * 100 : null;
      const _recPct = (i >= 4 && c15[i - 4]) ? (c15[i] - c15[i - 4]) / c15[i - 4] * 100 : null;
      const _emaDanger = emaOpp2(side, klineDir);
      const _pd = predictDanger({ dir: side, k15: k, atrPct15: _atrPct15, emaOpp2Weak: _emaDanger, priceVsEma1h: _pve1h, priceVsEma15: _pve15, recentCandlePct: _recPct });
      if (_emaDanger) dangerHits++;        // 危险统计始终用 emaOpp2 基线，跨模式( none/filter/reverse )一致
      if (_pd.danger) pdHits++;            // 多因子预测危险命中(供 reverse 反手触发)
      const mode = config.srsiAutoDanger;
      // revconf：危险信号(emaOpp2)触发→不立即开反向，先挂起待价格逆向确认破位才开反手(避免接飞刀)
      if (mode === 'revconf') {
        if (_emaDanger) { pendingRev[side] = { price: c15[i], idx: i }; return; }
        // 非危险→正常开
      }
      // filter 沿用 emaOpp2 基线(保持(9)预防爆仓结果不变)；reverse 用更聪明的 predictDanger 多因子信号开反方向；
      // smart 用 smartDanger(接飞刀/追涨杀跌) 判定
      let danger;
      if (mode === 'reverse') danger = _pd.danger;
      else if (mode === 'smart') danger = smartDanger({ priceVsEma1h: _pve1h, recentCandlePct: _recPct, k15: k, dir: side });
      else danger = _emaDanger;
      // none=关；filter/smart=避开危险单；reverse=防爆反手(危险→自动开反方向)
      const dec = resolveEntryDecision(side, { danger, hotStop: false, dangerMode: mode });
      if (!dec.open) return;
      if (dec.rev) reverseOpens++;
      _tryOpen(dec.side, dec.rev);
    };
    // revconf：每根检查待确认反手挂单——危险触发后价格逆向突破 revConfirm% 即确认破位，开反手
    if (config.srsiAutoDanger === 'revconf') {
      for (const ps of ['long', 'short']) {
        const pend = pendingRev[ps]; if (!pend) continue;
        const moved = ps === 'long' ? (price - pend.price) / pend.price * 100 : (pend.price - price) / pend.price * 100; // 危险方向(反向)已走幅度%
        if (moved >= revConfirm) { _tryOpen(ps === 'long' ? 'short' : 'long', true); reverseOpens++; pendingRev[ps] = null; }
        else if (i - pend.idx > 200) pendingRev[ps] = null; // 超时(~50h)未确认作废
      }
    }
    // GOAL27 确认 bar：confirmBars>0 时边沿事件挂起，待 N 根 15m 收盘仍满足带内条件才执行（0=立即执行，行为不变）
    const _execEdge = (side) => {
      if (side === 'short') {
        const lp = positions.find(p => p.side === 'long' && _netClose(p, price * (1 - slipAt(i))) > 0);
        if (lp) { const slip = slipAt(i); if (_settleClose(lp, price * (1 - slip), slip)) positions = positions.filter(p => p !== lp); }
        _attemptOpen('short');
      } else {
        const sp = positions.find(p => p.side === 'short' && _netClose(p, price * (1 + slipAt(i))) > 0);
        if (sp) { const slip = slipAt(i); if (_settleClose(sp, price * (1 + slip), slip)) positions = positions.filter(p => p !== sp); }
        _attemptOpen('long');
      }
    };
    // GOAL27 确认 bar + GOAL29 中波动态 confirm（挂单创建时捕获当时档位 pc.n）
    if (_effConfirmAt(i) > 0 && _canTrade) {
      if (be.edge) {
        pendingConfirm = { side: be.edge === 'enterUpper' ? 'short' : 'long', idx: i, count: 0, n: _effConfirmAt(i) };
      } else if (pendingConfirm) {
        const pc = pendingConfirm;
        if (i - pc.idx > pc.n + 5) pendingConfirm = null; // 防御：数据缺口超窗作废
        else {
          const cp = srsiConfirmPass(k, d, upper, lower, pc.side, pc.count, pc.n);
          if (cp.fire) { pendingConfirm = null; _execEdge(pc.side); } // fire 优先于 active（fire 时 active=false=挂单被消费）
          else if (!cp.active) pendingConfirm = null; // 收盘根出带→作废
          else pc.count = cp.count; // 未满根数→计数递进
        }
      }
    } else if (_canTrade && be.edge === 'enterUpper') {
      _execEdge('short');
    } else if (_canTrade && be.edge === 'enterLower') {
      _execEdge('long');
    }
  }
  // ---- 期末：所有未平仓按末价平仓计入（盈+亏都计），并保留明细供「净收益」栏展示 ----
  const _endOpen = [];
  for (const p of positions.slice()) {
    const price = c15[c15.length - 1]; const slip = slipAt(c15.length - 1);
    const exit = p.side === 'short' ? price * (1 + slip) : price * (1 - slip);
    const _levE = p.lev || effLev;
    const exitSlipCost = p.amtUsdt * _levE * slip;
    const closeFee = p.amtUsdt * _levE * feeRate;
    const gp = grossPnl(p.side, p.entry, exit, p.amtUsdt, _levE);
    const fee = (p.openFee || 0) + closeFee;
    const slipCost = (p.openSlip || 0) + exitSlipCost;
    const net = gp - fee - slipCost + p.fundingAcc;
    const lk = kd15.k[kd15.k.length - 1], ld = kd15.d[kd15.d.length - 1];
    const pnlPct = p.entry ? (gp / p.entry / _levE) * 100 : 0;
    if (isSpot) {
      if (p.side === 'long') { uBal += p.qty * exit; uBal -= closeFee; coinBal -= p.qty; }
      else { uBal -= p.qty * exit; uBal -= closeFee; coinBal += p.qty; }
      totalFee += closeFee; totalSlip += exitSlipCost;
      if (p.reverse) reversePnl += net;
      trades.push({ t: t15[t15.length - 1], side: p.side, action: 'close(final)', price: exit, gross: gp, fee, slip: slipCost, funding: p.fundingAcc, pnl: net, bal: uBal, k: lk, d: ld, marginMode: p.marginMode, reverse: p.reverse });
    } else {
      const marginCoin = p.amtUsdt / p.entry;
      if (p.marginMode === 'usdt') { avail += p.amtUsdt + gp; avail -= closeFee; }
      else { coinAvail += marginCoin + (gp - closeFee) / exit; }
      totalFee += closeFee; totalSlip += exitSlipCost;
      if (p.reverse) reversePnl += net;
      trades.push({ t: t15[t15.length - 1], side: p.side, action: 'close(final)', price: exit, gross: gp, fee, slip: slipCost, funding: p.fundingAcc, pnl: net, bal: (p.marginMode === 'usdt' ? avail : coinAvail * exit), k: lk, d: ld, marginMode: p.marginMode, reverse: p.reverse });
    }
    _endOpen.push({ side: p.side, entry: p.entry, exit, lev: p.lev || effLev, marginMode: p.marginMode, amtUsdt: p.amtUsdt, net, pnlPct });
    positions = positions.filter(x => x !== p);
  }
  const finalPrice = c15[c15.length - 1] || 0;
  const finalEquity = isSpot ? (uBal + coinBal * finalPrice) : (avail + coinAvail * finalPrice);
  const closes = trades.filter(t => t.action.indexOf('close') === 0);
  const wins = closes.filter(t => t.pnl > 0).length, losses = closes.filter(t => t.pnl <= 0).length;
  const winRate = closes.length ? wins / closes.length : 0;
  // 对照组标注：openLog 中哪些最终爆仓
  const _liqSet = new Set(liqLog.map(l => l.openT));
  openLog.forEach(o => { o.liquidated = _liqSet.has(o.openT); });
  return {
    finalEquity, principal: startVal, pnlPct: (finalEquity - startVal) / startVal * 100,
    mode, spotInitU: initU, spotInitC: initC,
    finalU: isSpot ? uBal : null, finalC: isSpot ? coinBal : null, finalPrice: isSpot ? finalPrice : null,
    finalAvail: isSpot ? null : avail, finalCoinAvail: isSpot ? null : coinAvail, perpMode: isSpot ? null : (config.srsiAutoMode || 'follow'), lev: isSpot ? 1 : lev,
    trades, winRate, wins, losses, maxDD, endOpen: _endOpen,
    longs: trades.filter(t => t.action === 'open' && t.side === 'long').length,
    shorts: trades.filter(t => t.action === 'open' && t.side === 'short').length,
    equitySeries, totalFee, totalSlip, totalFunding,
    maxOpenLong, maxOpenShort,
    liqCount, liqLoss,
    stopCount, stopLoss,
    liqLog,
    openLog,
    dangerHits, reverseOpens, reversePnl, pdHits, dangerMode: config.srsiAutoDanger || 'none',
    pdBlockOn: !!config.srsiAutoPdBlockOn, pdBlocked: _gateState.pdBlocked || 0,
    regimeStats: gateMode !== 'off' ? { mode: gateMode, w: gateW, emaTf: gateEmaTf, ..._gateState, types: _aisLine ? (() => { const t = { range: 0, 'trend-up': 0, 'trend-down': 0, 'pullback-up': 0, 'pullback-down': 0, na: 0 }; for (let i = lo; i < c15.length; i++) { const ty = _typeCached(i); t[ty || 'na']++; } return t; })() : null } : null,
    reopt: reopt ? { enabled: true, count: reoptCount, adopt: reoptAdopt, intervalH: reoptIntervalH, noTradeH: reoptNoTradeH } : { enabled: false }
  };
}

function _buildSparkline(vals) {
  if (!vals || vals.length < 2) return '—';
  const min = Math.min(...vals), max = Math.max(...vals), range = (max - min) || 1;
  const n = Math.min(48, vals.length), step = vals.length / n;
  let s = '<span style="display:inline-flex;align-items:flex-end;gap:1px;height:18px">';
  for (let i = 0; i < n; i++) {
    const v = vals[Math.floor(i * step)];
    const h = 2 + Math.round((v - min) / range * 14);
    s += `<span style="width:2px;height:${h}px;background:${v >= vals[0] ? 'var(--green)' : 'var(--red)'}"></span>`;
  }
  return s + '</span>';
}

function _btFmtTime(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
const _BT_KEY = 'smartTrader_kchart_bt';
const _BT_RAW_KEY = 'smartTrader_kchart_bt_raw';
const _BT_FUND_KEY = 'smartTrader_kchart_bt_fund';
// ---- 独立回测配置 btCfg（与实盘 SRSI 自动永续合约设置完全解耦；仅共享 cfg.srsi/srsiByTf/srsiOptSource）----
const _BT_CFG_KEY = 'smartTrader_kchart_bt_cfg';
function _btCfgDefaults() {
  return {
    accountType: 'perp',     // perp | spot
    marginMode: 'follow',    // follow | usdt | coin （永续与现货通用；现货仅影响初始种子）
    principal: 1000,         // 回测本金 U
    coin: 0,                 // 回测本币（可选；币本位/跟随 用）
    feePct: 0.045,          // 手续费（百分号数值，如 0.045 = 0.045%；回测中 /100 得 srsiAutoFeeRate=0.00045，即名义价值 0.045%，10x 下约占保证金 0.45%，贴近真实币安 taker）
    slipPct: 0.02,           // 滑点 %
    useCost: true,           // 含交易成本
    pct: 10,                 // 开仓比例 %
    lev: 5,                  // 杠杆 x
    maxSame: 3,              // 同方向最多连开单
    confirmBars: 0,          // GOAL27 确认 bar：边沿信号后需 N 根 15m 收盘仍满足带内条件才执行（0=关=立即执行）
    regimeGate: 'off',       // GOAL29 regime 三态闸门：off / confirm(中波降频+1) / size(中波减仓×0.5) / block(仅低波阴跌禁开) / tconf(趋势市升确认·AIS)
    regimeW: 480,            // regime 分位滚动窗（1h 根数，默认 480≈20 天）
    regimeEmaTf: '1h',       // GOAL29-A2 阴跌判定 EMA 周期：1h / 1d(长窗更优)
    pdBlockOn: false,        // GOAL31-D PD-A 危险拦截（predictDanger 多因子≥2 → 拦截该笔普通开仓；反手单不拦）
    upper: 0,                // 开仓上限带（0=使用 15m 优选带）
    lower: 0,                // 开仓下限带（0=使用 15m 优选带）
    capUsdt: 0,              // 开仓上限 U（0=不限）
    capCoin: 0,              // 开仓上限 币（0=不限）
    floorUsdt: 0,            // 开仓下限 U（0=不限）
    floorCoin: 0,            // 开仓下限 币（0=不限）
    optTfs: ['15m', '30m', '1h', '4h'], // 自动优选周期（参与 #4 权重与 15m 闸门）
    optEnabled: false,
    optIntervalOn: false,
    optIntervalH: 5,
    optNoTradeH: 5,
    w4h: 30, w1h: 20, w30m: 10, // #4 仓位缩放权重（独立于实盘）
    danger: 'none',          // 危险信号防爆：none=关 / filter=预防爆仓 / reverse=防爆反手 / smart=预防爆仓(智能接飞刀过滤) / revconf=防爆反手(确认后开反)
    reversePct: 0,           // 反手单仓位%（0=继承正常开仓%）
    reverseLev: 0,           // 反手单杠杆（0=继承正常杠杆）
    revConfirm: 3,           // 防爆反手确认阈值%：危险触发后价格逆向突破此幅度才开反手(revconf)
    stopPct: 0,              // 硬止损%：价格逆向达此即平仓(0=关)。均值回归 SRSI 策略慎用——易被正常回撤噪声触发
    adaptiveLev: false,      // 自适应杠杆：波动放大→降杠杆(减少单笔爆仓率)；默认关，开=有效
    adaptiveLevMin: 2,       // 自适应杠杆下限(倍数)
    atrStop: false,          // 宽保护性止损(ATR 基准)：mult×受监督ATR% 为价格止损(落于爆仓线内侧)；默认关
    atrStopMult: 2.0,        // 宽止损倍数(×ATR%)，默认 2
    hotStop: false,          // 热停开：1h ATR 放大时禁止新开普通单
    collapsed: true
  };
}
export let _btCfg = _btCfgDefaults();
export function _btCfgLoad() {
  try {
    const raw = localStorage.getItem(_BT_CFG_KEY);
    if (raw) _btCfg = Object.assign(_btCfgDefaults(), JSON.parse(raw));
  } catch (e) {}
  return _btCfg;
}
export function _btCfgSave() {
  _safeSetItem(_BT_CFG_KEY, JSON.stringify(_btCfg));
}
// 将独立的 btCfg 合并进回测用的 config（实盘 srsiAuto* 字段全部被覆盖；srsiByTf/srsiOptSource 保持来自实盘 cfg）
function _btOverlayFor(cfg, bt) {
  return Object.assign({}, cfg, {
    srsiAutoMode: bt.marginMode,
    srsiAutoBtMode: bt.accountType,
    srsiAutoPrincipal: bt.principal,
    srsiAutoBasePct: bt.pct,
    srsiAutoLev: bt.lev,
    srsiAutoMaxSame: bt.maxSame,
    srsiAutoUpper: bt.upper,
    srsiAutoLower: bt.lower,
    srsiAutoOpenCapUsdt: bt.capUsdt,
    srsiAutoOpenCapCoin: bt.capCoin,
    srsiAutoOpenFloorUsdt: bt.floorUsdt,
    srsiAutoOpenFloorCoin: bt.floorCoin,
    srsiAutoFeeRate: bt.useCost ? (bt.feePct / 100) : 0,
    srsiAutoSlipBase: bt.useCost ? (bt.slipPct / 100) : 0,
    srsiAutoUseCost: bt.useCost,
    srsiAutoUseFunding: true,
    srsiAutoW4h: bt.w4h, srsiAutoW1h: bt.w1h, srsiAutoW30m: bt.w30m,
    srsiBtOptTfs: bt.optTfs,
    srsiAutoDanger: bt.danger, srsiAutoReversePct: bt.reversePct, srsiAutoReverseLev: bt.reverseLev, srsiAutoHotStop: !!bt.hotStop,
    srsiAutoStopPct: bt.stopPct || 0, srsiAutoRevConfirm: bt.revConfirm || 3, srsiAutoConfirmBars: bt.confirmBars || 0,
    srsiAutoRegimeGate: bt.regimeGate || 'off', srsiAutoRegimeW: bt.regimeW || THRESH.REGIME_GATE_W,
    srsiAutoRegimeEmaTf: bt.regimeEmaTf === '1d' ? '1d' : '1h',
    srsiAutoPdBlockOn: !!bt.pdBlockOn,
    srsiAutoAdaptiveLev: !!bt.adaptiveLev, srsiAutoAdaptiveLevMin: bt.adaptiveLevMin || THRESH.ADAPTIVE_LEV_MIN,
    srsiAutoAtrStop: !!bt.atrStop, srsiAutoAtrStopMult: bt.atrStopMult || THRESH.ATR_STOP_MULT,
    srsiAutoExitK: bt.exitK || 0, srsiAutoMaxHoldBars: bt.holdBars || 0
  });
}
_btCfgLoad();
 let _btLastDays = 7;
 let _btComboText = ''; // GOAL8：组合行文本（报告导出并入）
 let _btFetchImpl = null; // 测试可注入桩（覆盖 fetchKlinesRange）
 export function __setBacktestFetch(fn) { _btFetchImpl = fn; }
 export function __getBtStore() { try { return JSON.parse(localStorage.getItem(_BT_KEY) || '{}'); } catch { return {}; } }
 function _btFetch(sym, tf, start, end, onP, maxBars) {
   if (_btFetchImpl) return _btFetchImpl(sym, tf, start, end, onP, maxBars);
   return fetchKlinesRange(sym, tf, start, end, onP, maxBars);
 }
function _btReadStore() { try { return JSON.parse(localStorage.getItem(_BT_KEY) || '{}'); } catch { return {}; } }
function _btWriteStore(obj) { _safeSetItem(_BT_KEY, JSON.stringify(obj)); }
// GOAL14：回测原始 K 线=派生数据（35k 根 15m≈1.8MB），按 5.30.1 配额红线不再写 localStorage（曾撑爆配额致 bt 结果也写失败），
// 只保留会话内存缓存（刷新后重新拉取）；并清理历史遗留的 localStorage 大键释放配额
const _btRawMem = {};
function _btReadRaw(sym, days) { return _btRawMem[sym + '|' + days] || null; }
function _btWriteRaw(sym, days, kl) {
  try { localStorage.removeItem(_BT_RAW_KEY); } catch {}
  _btRawMem[sym + '|' + days] = kl;
}
function _btReadFund(sym, days) {
  try { const raw = JSON.parse(localStorage.getItem(_BT_FUND_KEY) || '{}'); return raw[sym + '|' + days] || null; } catch { return null; }
}
function _btWriteFund(sym, days, fr) {
  try { const raw = JSON.parse(localStorage.getItem(_BT_FUND_KEY) || '{}'); raw[sym + '|' + days] = fr; _safeSetItem(_BT_FUND_KEY, JSON.stringify(raw)); } catch {}
}
// 清空本地持久化的回测数据（仅当前币对 sym|* 条目）：结果/原始K线/资金费三键，不动 SRSI 配置与币本金库存
export function clearBacktestStore(sym) {
  const s = (sym || cfg.symbol || '').toString();
  if (!s) return;
  const prefix = s + '|';
  const _filterObj = (key) => {
    try {
      const raw = JSON.parse(localStorage.getItem(key) || '{}');
      let changed = false;
      if (raw && typeof raw === 'object') {
        Object.keys(raw).forEach(k => { if (k.indexOf(prefix) === 0) { delete raw[k]; changed = true; } });
        if (raw.results && typeof raw.results === 'object') {
          Object.keys(raw.results).forEach(k => { if (k.indexOf(prefix) === 0) { delete raw.results[k]; changed = true; } });
          if (Object.keys(raw.results).length === 0) delete raw.results;
        }
        if (raw.lastSym === s) { raw.lastSym = null; raw.lastMode = null; changed = true; }
      }
      if (changed) _safeSetItem(key, JSON.stringify(raw));
    } catch (e) {}
  };
  _filterObj(_BT_KEY);
  _filterObj(_BT_RAW_KEY);
  _filterObj(_BT_FUND_KEY);
  _btLastDays = null;
}

function _btMoney(v, withSign) {
  if (v == null) return '—';
  const s = (Math.abs(v) < 0.05) ? '0.0' : v.toFixed(1);
  if (!withSign) return '$' + s;
  return v >= 0 ? '+$' + s : '-$' + Math.abs(v).toFixed(1);
}
function _btCost(v) {
  if (v == null) return '—';
  const s = (Math.abs(v) < 0.05) ? '0.0' : v.toFixed(1);
  return '-$' + s;
}
export function _renderBacktestResult(res, days) {
  if (res.error) return `<div class="kt-auto-warn">回测失败: ${res.error}</div>`;
  const up = res.pnlPct >= 0, cls = up ? 'up' : 'down';
  const isSpot = res.mode === 'spot';
  const modeBadge = isSpot ? '现货 1x' : ('永续 ' + (res.lev || 1) + 'x');
  const principalTxt = isSpot
    ? `本金 现货USDT池 $${_btMoney(res.spotInitU != null ? res.spotInitU : 0)} + ${cfg.symbol}库存 ${(res.spotInitC != null ? res.spotInitC : 0)}`
    : `本金 $${res.principal}`;
  const rows = res.trades.map(t => {
    const isOpen = t.action === 'open';
    const isLiq = t.action === 'liquidate';
    let actHtml, actCls;
    if (isOpen) {
      actHtml = t.side === 'long' ? '开多' : '开空';
      actCls = t.side === 'long' ? 'up' : 'down';
    } else if (isLiq) {
      const dir = t.side === 'long' ? '多' : '空';
      const dirCls = t.side === 'long' ? 'bt-long' : 'bt-short';
      actHtml = '<b class="bt-liquidate">爆仓</b><b class="' + dirCls + '">' + dir + '</b>';
      actCls = 'down';
    } else {
      const dir = t.side === 'long' ? '多' : '空';
      const dirCls = t.side === 'long' ? 'bt-long' : 'bt-short';
      const lossTag = t.pnl > 0 ? '' : '<b class="bt-loss">亏</b>';
      actHtml = '<b class="bt-ping">平</b><b class="' + dirCls + '">' + dir + '</b>' + lossTag;
      actCls = t.pnl > 0 ? (t.side === 'long' ? 'up' : 'down') : 'down';
    }
    const amt = isOpen && t.amt != null ? _btMoney(t.amt) : '—';
    const fee = t.fee != null ? _btCost(t.fee) : '—';
    const slip = t.slip != null ? _btCost(t.slip) : '—';
    const fund = t.funding != null ? _btMoney(t.funding, true) : '—';
    const pnl = !isOpen && t.pnl != null ? _btMoney(t.pnl, true) : '—';
    const bal = t.bal != null ? _btMoney(t.bal) : '—';
    const kk = t.k != null ? t.k.toFixed(1) : '—';
    const dd = t.d != null ? t.d.toFixed(1) : '—';
    const pnlCls = !isOpen && t.pnl > 0 ? 'up' : (!isOpen && t.pnl < 0 ? 'down' : '');
    const fundCls = !isOpen && t.funding < 0 ? 'down' : (!isOpen && t.funding > 0 ? 'up' : '');
    const _mm = t.marginMode;
    const modeHtml = _mm === 'coin' ? '币本位' : _mm === 'usdt' ? 'U本位' : _mm === 'spot' ? '现货' : '—';
    const modeCls = _mm === 'coin' ? 'bt-coin' : _mm === 'usdt' ? 'bt-usdt' : _mm === 'spot' ? 'bt-spot' : '';
    return `<tr>
      <td>${_btFmtTime(t.t)}</td>
      <td class="${actCls}">${actHtml}</td>
      <td>${_btMoney(t.price)}</td>
      <td>${amt}</td>
      <td>${fee}</td>
      <td>${slip}</td>
      <td class="${fundCls}">${fund}</td>
      <td class="${pnlCls}">${pnl}</td>
      <td>${bal}</td>
      <td>${kk}</td>
      <td>${dd}</td>
      <td class="${modeCls}">${modeHtml}</td>
    </tr>`;
  }).join('');
  const totFee = res.totalFee || 0, totSlip = res.totalSlip || 0, totFund = res.totalFunding || 0;
  const fundTxt = totFund >= 0 ? `资金费净收 ${_btMoney(totFund)}` : `资金费净付 ${_btMoney(-totFund)}`;
  return `
    ${res.optLeak ? `<div class="kt-auto-row kt-bt-leak">⚠ 优选过拟合泄漏自检：${res.optLeak}</div>` : ''}
    <div class="kt-auto-row"><b>回测 ${days}天</b> · <b class="kt-bt-mode">${modeBadge}</b> · ${principalTxt} → 期末 <b class="${cls}">$${res.finalEquity.toFixed(1)}</b> (${up ? '+' : ''}${res.pnlPct.toFixed(1)}%) <span class="kt-bt-saved">(已本地保存)</span></div>
    ${isSpot ? `<div class="kt-auto-row kt-bt-spot-end">现货期末：现金 USDT <b>$${_btMoney(res.finalU)}</b> (期初 $${_btMoney(res.spotInitU)}) ｜ ${cfg.symbol}库存 <b>${res.finalC}</b> (≈$${_btMoney(res.finalC * res.finalPrice)}, 期初 ${res.spotInitC}) ｜ 期末价 $${_btMoney(res.finalPrice)}</div>` : ''}
    <div class="kt-auto-row">${_buildSparkline(res.equitySeries.map(e => e.eq))}</div>
    <div class="kt-auto-row">胜率 ${(res.winRate * 100).toFixed(0)}% (${res.wins}胜/${res.losses}负) ｜ 开多${res.longs}/开空${res.shorts} ｜ 最大回撤 ${(res.maxDD * 100).toFixed(1)}% ｜ 共 ${res.trades.length} 笔 <button id="ktBtExport" class="kt-export-btn">⬇ 导出</button></div>
    <div class="kt-auto-row kt-bt-cost">成本：手续费 <b>${_btMoney(totFee)}</b> ｜ 滑点 <b>${_btMoney(totSlip)}</b> ｜ ${fundTxt} ｜ 净收益 <b class="${cls}">${_btMoney(res.finalEquity - res.principal, true)}</b></div>
    ${(res.liqCount || 0) > 0 ? `<div class="kt-auto-row kt-bt-liq">⚠ 强平 <b>${res.liqCount}</b> 次（价格击穿强平价，保证金基本归零）｜ 爆仓净损失 <b>${_btMoney(res.liqLoss, true)}</b>${res.liqCount ? '（已并入净收益）' : ''}</div>` : ''}
    ${(res.dangerHits || 0) > 0 ? `<div class="kt-auto-row kt-bt-danger">🚨 危险信号触发 <b>${res.dangerHits}</b> 次｜防爆反手开单 <b>${res.reverseOpens || 0}</b> 笔（防爆模式：${(res.dangerMode === 'reverse' ? '防爆反手' : res.dangerMode === 'filter' ? '预防爆仓' : res.dangerMode === 'smart' ? '预防爆仓(智能)' : res.dangerMode === 'revconf' ? '防爆反手(确认)' : '关')}）｜反手盈亏 <b class="${(res.reversePnl || 0) >= 0 ? 'kt-pos' : 'kt-neg'}">${_btMoney(res.reversePnl || 0, true)}</b>${res.stopCount ? `｜硬止损 <b>${res.stopCount}</b> 笔 <b class="${(res.stopLoss || 0) >= 0 ? 'kt-pos' : 'kt-neg'}">${_btMoney(res.stopLoss || 0, true)}</b>` : ''}</div>` : ''}
    ${res.pdBlockOn ? `<div class="kt-auto-row kt-bt-danger">🛡️ PD-A 危险拦截：已拦截 <b>${res.pdBlocked || 0}</b> 笔危险开仓（predictDanger 多因子≥2；反手单不拦）</div>` : ''}
    <div class="kt-bt-scroll"><table class="kt-bt-table">
      <thead><tr><th>时间</th><th>动作</th><th>价格</th><th>金额</th><th>手续费</th><th>滑点</th><th>资金费</th><th>净盈亏</th><th>余额</th><th>K</th><th>D</th><th>模式</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>${(() => {
      const eo = res.endOpen || [];
      if (!eo.length) return '';
      const eoL = eo.filter(x => x.side === 'long').length, eoS = eo.filter(x => x.side === 'short').length;
      const eoNet = eo.reduce((s, x) => s + (x.net || 0), 0);
      const eoHtml = eo.map(x => {
        const dir = x.side === 'long' ? '多' : '空';
        const dirCls = x.side === 'long' ? 'bt-long' : 'bt-short';
        const mm = x.marginMode === 'coin' ? '币本' : x.marginMode === 'usdt' ? 'U本' : x.marginMode === 'spot' ? '现货' : '';
        return `<span class="${x.net >= 0 ? 'up' : 'down'}"><b class="${dirCls}">${dir}</b> ${x.lev}x ${mm} 开${_btMoney(x.entry)}→末${_btMoney(x.exit)} <b>${_btMoney(x.net, true)}</b>(${x.pnlPct >= 0 ? '+' : ''}${x.pnlPct.toFixed(1)}%)</span>`;
      }).join(' ｜ ');
      return `<div class="kt-auto-row kt-bt-endopen">📌 期末未平仓 <b>${eo.length}</b> 单（多${eoL}/空${eoS}）已按末价并入净收益：<br>${eoHtml}<br>合计未实现 <b class="${eoNet >= 0 ? 'up' : 'down'}">${_btMoney(eoNet, true)}</b>（已含在期末权益 ${_btMoney(res.finalEquity)} 中）</div>`;
    })()}`;
}

// ---- 回测条件文本（人类可读 + 机器可读 JSON），弹窗与导出共用 ----
function _btModeLabel(mode, lev) {
  if (mode === 'spot') return '现货 1x（双余额：USDT池 + 币库存）';
  return '永续合约 ' + (lev || 1) + 'x（U本位杠杆，可爆仓）';
}
function _btMarginModeLabel(bt) {
  const m = bt.marginMode || 'follow';
  if (m === 'usdt') return 'U本位（固定）';
  if (m === 'coin') return '币本位（固定）';
  return '跟随快捷交易（开空U本位 / 开多币本位）';
}
// 返回 { human, json, text }：human=可读摘要，json=机器可读快照，text=两者拼接（弹窗/导出复用）
export function buildBacktestConditions(days) {
  const bt = _btCfgLoad();
  const mode = (bt.accountType === 'spot') ? 'spot' : 'perp';
  const principal = (typeof bt.principal === 'number') ? bt.principal : 1000;
  const lev = bt.lev || 1;
  const autoTfs = bt.optTfs && bt.optTfs.length ? bt.optTfs : SRSI_AUTO_TFS;
  const optList = autoTfs.map(tf => tf + ':' + ((cfg.srsiOptSource && cfg.srsiOptSource[tf] === 'optimized') ? '已优选' : '默认')).join(' / ');
  const ver = (typeof globalThis !== 'undefined' && globalThis.APP_VER) || 'dev';
  // 各周期 SRSI 参数（固定，回测中不做自动优选/间隔重优选）
  const tfParamLines = SRSI_AUTO_TFS.map(tf => {
    const p = (cfg.srsiByTf && cfg.srsiByTf[tf]) || DEFAULT_SRSI;
    return `  ${tf}: RSI天数=${p.rsiPeriod} / STOCK长度=${p.stochPeriod} / 平滑K=${p.smoothK} / 平滑D=${p.smoothD} / 上限带=${p.overbought} / 下限带=${p.oversold}`;
  }).join('\n');
  const srsiTfParams = {};
  SRSI_AUTO_TFS.forEach(tf => {
    const p = (cfg.srsiByTf && cfg.srsiByTf[tf]) || DEFAULT_SRSI;
    srsiTfParams[tf] = { rsiPeriod: p.rsiPeriod, stochPeriod: p.stochPeriod, smoothK: p.smoothK, smoothD: p.smoothD, overbought: p.overbought, oversold: p.oversold };
  });
  const human = [
    '【回测条件】',
    '币对：' + cfg.symbol,
    '回测周期：' + days + ' 天',
    '账户类型：' + _btModeLabel(mode, lev),
    '本位模式：' + _btMarginModeLabel(bt),
    '本金：' + principal + ' USDT' + ((mode === 'spot' && bt.coin > 0) ? (' + ' + bt.coin + ' ' + cfg.symbol + '（现货本币种子）') : ''),
    '回测本币种子：' + (bt.coin > 0 ? (bt.coin + ' ' + cfg.symbol) : '无（仅用 USDT 本金）'),
    '仓位基准：' + bt.pct + '%（#4 乘法因子的基准，不叠加额外方向加成）',
    '【实际开仓仓位 = 基准 ' + bt.pct + '% × #4 因子（仅此一项决定仓位大小，与自动面板「缩放(#4)」展示同口径）】',
    '仓位缩放（#4 乘法因子，作用于 15m 交易方向 vs 4h/1h/30m SRSI 方向，在 15m 触发开仓的当刻读取 4h/1h/30m 的 SRSI 方向并即时加权）：4h +' + bt.w4h + '% / 1h +' + bt.w1h + '% / 30m +' + bt.w30m + '%；某周期未优选 → 直接扣该权重；已优选但与 15m 方向相反 → 扣该权重；一致 → 加该权重。因子 = 1 ± 合计%，钳制 [0.2, 2]；最终仓位% = 基准 ' + bt.pct + '% × 因子，区间 [' + (bt.pct * 0.2).toFixed(1) + '%, ' + (bt.pct * 2).toFixed(1) + '%]',
    '15m 交易闸门：15m 未优选 → 自动交易暂停（不触发开仓/平仓）',
    (function () {
      const m = bt.danger || 'none';
      const lbl = m === 'filter' ? '预防爆仓（避开危险单不开仓）' : m === 'reverse' ? '防爆反手（模型键命中才反手；无键则避开危险单）' : m === 'smart' ? '预防爆仓(智能)（接飞刀/追涨杀跌过滤）' : m === 'revconf' ? '防爆反手(确认)（危险后等价格确认破位才开反）' : '关';
      const rp = (bt.reversePct > 0) ? (bt.reversePct + '%') : '（继承正常开仓%）';
      const rl = (bt.reverseLev > 0) ? (bt.reverseLev + 'x') : '（继承正常杠杆）';
      const _crit = m === 'smart' ? ('（危险判定：接飞刀/追涨杀跌 — 价格偏离1h EMA≥' + THRESH.SMART_EMA1H_PCT + '% 或 15m 近4根振幅≥' + THRESH.SMART_CANDLE_PCT + '% 即判危险，回避顺势单边接刀）')
        : m === 'revconf' ? ('（危险判定：4h/1h/30m 的 EMA120 趋势背离≥2 个周期 → 挂起，价格再逆向走出 ' + (cfg.srsiAutoRevConfirm || 3) + '% 确认破位才开反手）')
        : '（危险判定：4h/1h/30m 的 EMA120 趋势与拟开仓方向背离≥2 个周期）';
      return '危险信号防爆：' + lbl + (m === 'reverse' ? ('｜反手单仓位 ' + rp + ' / 杠杆 ' + rl) : '') + _crit;
    })(),
    (bt.pdBlockOn ? ('危险拦截(PD-A)：开（predictDanger 多因子≥2 命中→拦截该笔普通开仓，反手单不拦；因子：1h EMA偏离≥' + THRESH.PREDICT_EMA1H_PCT + '% / 15m EMA偏离≥' + THRESH.PREDICT_EMA15_PCT + '% / K15超买卖(' + THRESH.PREDICT_K15_LONG + '/' + THRESH.PREDICT_K15_SHORT + ') / 近根振幅≥' + THRESH.PREDICT_CANDLE_PCT + '% / EMA120背离；GOAL31-D）') : '危险拦截(PD-A)：关（默认）'),
    '杠杆：' + lev + 'x' + (bt.adaptiveLev ? ('（自适应杠杆开：波动放大自动降杠杆，下限 ' + (bt.adaptiveLevMin || THRESH.ADAPTIVE_LEV_MIN) + 'x）') : ''),
    (function () {
      const g = bt.regimeGate || 'off';
      const lbl = g === 'confirm' ? '中波降频(+1确认bar)' : g === 'size' ? '中波减仓×0.5' : g === 'block' ? '仅低波阴跌禁开' : g === 'tconf' ? '趋势市升确认(AIS regime·tconf，tconfdc2 组合=tconf+1d EMA+确认bar 2)' : '关';
      return 'regime 闸门：' + lbl + '｜分位滚动窗 ' + (bt.regimeW || THRESH.REGIME_GATE_W) + ' 根1h｜阴跌EMA ' + (bt.regimeEmaTf === '1d' ? '1d' : '1h') + '（GOAL29）';
    })(),
    '热停开：' + (bt.hotStop ? '开（1h ATR > 1.3×sma20 时禁止新开普通单，反手仍允许）' : '关'),
    '硬止损%：' + (bt.stopPct || 0) + (bt.stopPct ? '' : '（0=关）'),
    '中轨离场：' + (bt.exitK || 0) + (bt.exitK ? '（K 下穿 100-此值平多 / 上穿此值平空）' : '（0=关）'),
    '最长持仓：' + (bt.holdBars || 0) + (bt.holdBars ? ' 根 15m，超过即市价离场' : '（0=关）'),
    '同向连开递减：每仓 ×' + (cfg.srsiAutoStackDecay != null ? cfg.srsiAutoStackDecay : 1) + '（继承实盘设置；第n笔=基准×decay^(n-1)）｜满仓前保留 ' + (cfg.srsiAutoStackFront != null ? cfg.srsiAutoStackFront : 1) + ' 笔',
    (bt.atrStop ? ('宽保护性止损(ATR)：开，止损距离 = ' + (bt.atrStopMult || THRESH.ATR_STOP_MULT) + '×受监督ATR%（落于爆仓线内侧，截真趋势破位）') : '宽保护性止损(ATR)：关'),
    '同方向最多连开：' + bt.maxSame + ' 单',
    '确认 bar：' + (bt.confirmBars > 0 ? (bt.confirmBars + ' 根 15m 收盘仍带内才执行（GOAL27 降频）') : '关（0=边沿立即执行）'),
    (function () {
      const _eb = resolveEntryBands({ srsiAutoUpper: bt.upper, srsiAutoLower: bt.lower, srsiByTf: cfg.srsiByTf, srsi: cfg.srsi });
      return '上下限带：上 ' + _eb.upper + ' / 下 ' + _eb.lower + (_eb.auto ? '（自动=15m优选带）' : '');
    })(),
    '单次开仓上限：USDT ' + (bt.capUsdt || '不限') + ' / 币 ' + (bt.capCoin || '不限'),
    '开仓下限（不触发小于此额度的开仓）：USDT ' + (bt.floorUsdt || '0（不限制）') + ' / 币 ' + (bt.floorCoin || '0（不限制）'),
    '交易成本：总开关 ' + (bt.useCost ? '开' : '关') + '｜手续费 ' + bt.feePct.toFixed(3) + '%（名义价值，10x 下约占保证金 ' + (bt.feePct * 10).toFixed(3) + '%）｜滑点 ' + bt.slipPct.toFixed(3) + '%（名义价值）｜资金费 ' + (bt.useCost ? '计入' : '不计'),
    'SRSI 参数（固定，回测中不做自动优选/间隔重优选，区别于实时自动任务）：',
    tfParamLines,
    '自动优选（仅影响实时任务，回测固定用上方参数）：' + (bt.optEnabled ? '开' : '关') + (bt.optEnabled ? ('｜重优选间隔 ' + bt.optIntervalH + 'h｜无成交 ' + bt.optNoTradeH + 'h 触发｜间隔触发 ' + (bt.optIntervalOn ? '开' : '关') + '｜优选周期[' + optList + ']') : ''),
    'reoptInBacktest: false（回测全程固定 SRSI 参数，不重新优选）',
    '交易闸门15m（固定引擎逻辑）：15m SRSI 带内交叉信号——进入上限带后，带内出现 D>K 交叉 → 平多+开空；进入下限带后，带内出现 K>D 交叉 → 平空+开多；每次进带仅触发一次（停留带中不重复，出带后重进再触发）',
    '注：无额外「方向合力」方向加成，仓位仅由上方 #4 因子决定；4h/1h/30m 的 SRSI 方向与 15m 交易方向对齐，一致加权(+)/反向或该周期未优选减权(−)，与自动面板「缩放(#4)」展示同口径。',
    '版本：' + ver,
    '数据范围：' + days + ' 天窗口 + 35h 预热；拉取周期 15m/1h/30m/4h（源 Binance 公开 REST）'
  ].join('\n');
  const json = {
    symbol: cfg.symbol, days: days, mode: mode, principal: principal, version: ver, gateTf: '15m',
    reoptInBacktest: false,
    sizing: { method: '#4', baseTf: '15m', basePct: bt.pct, weights: { '4h': bt.w4h, '1h': bt.w1h, '30m': bt.w30m }, rule: '各周期 SRSI 方向与 15m 交易方向一致+权重 / 反向或该周期未优选−权重', factorClamp: [0.2, 2] },
    btCfg: {
      accountType: bt.accountType, marginMode: bt.marginMode, coinSeed: bt.coin, pct: bt.pct, lev: lev, maxSame: bt.maxSame,
      upper: bt.upper, lower: bt.lower, capUsdt: bt.capUsdt, capCoin: bt.capCoin, floorUsdt: bt.floorUsdt, floorCoin: bt.floorCoin,
      useCost: bt.useCost, feePct: bt.feePct, slipPct: bt.slipPct, useFunding: bt.useCost,
      optTfs: autoTfs, optEnabled: bt.optEnabled, optIntervalH: bt.optIntervalH, optIntervalOn: bt.optIntervalOn, optNoTradeH: bt.optNoTradeH,
      danger: bt.danger || 'none', reversePct: bt.reversePct || 0, reverseLev: bt.reverseLev || 0, pdBlockOn: !!bt.pdBlockOn,
      adaptiveLev: !!bt.adaptiveLev, adaptiveLevMin: bt.adaptiveLevMin || THRESH.ADAPTIVE_LEV_MIN, atrStop: !!bt.atrStop, atrStopMult: bt.atrStopMult || THRESH.ATR_STOP_MULT,
      regimeGate: bt.regimeGate || 'off', regimeW: bt.regimeW || THRESH.REGIME_GATE_W, regimeEmaTf: bt.regimeEmaTf === '1d' ? '1d' : '1h',
      hotStop: !!bt.hotStop, stopPct: bt.stopPct || 0, exitK: bt.exitK || 0, holdBars: bt.holdBars || 0,
      stackDecay: (cfg.srsiAutoStackDecay != null ? cfg.srsiAutoStackDecay : 1), stackFront: (cfg.srsiAutoStackFront != null ? cfg.srsiAutoStackFront : 1)
    },
    srsiTfParams: srsiTfParams,
    srsiByTf: cfg.srsiByTf, srsiOptSource: cfg.srsiOptSource, autoTfs: autoTfs
  };
  const text = human + '\n\n--- 机器可读（复制给 AI 复现）---\n' + JSON.stringify(json, null, 2);
  return { human: human, json: json, text: text };
}

// 点击回测周期按钮时，先弹窗展示全部条件，确认后再跑
export function openBacktestConfirm(days) {
  if (typeof document === 'undefined') return;
  const c = buildBacktestConditions(days);
  const ov = document.getElementById('btConfirmModal');
  if (ov) ov.remove();
  const el = document.createElement('div');
  el.className = 'modal-overlay';
  el.id = 'btConfirmModal';
  el.innerHTML = '<div class="modal bt-confirm">' +
    '<h3>回测条件确认（' + days + ' 天）</h3>' +
    '<div class="bt-confirm-note">以下为即将运行的全部回测条件。可复制文本发给我做一致回测；点「确定回测」开始。</div>' +
    '<textarea class="bt-confirm-text" id="btConfirmText" readonly>' + c.text.replace(/</g, '&lt;') + '</textarea>' +
    '<div class="bt-confirm-btns">' +
      '<button class="btn btn-sm" id="btCopy">复制</button>' +
      '<button class="btn btn-sm" id="btCancel">取消</button>' +
      '<button class="btn btn-buy btn-sm" id="btRun">确定回测</button>' +
    '</div></div>';
  document.body.appendChild(el);
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => el.classList.add('show')); else el.classList.add('show');
  const close = () => el.remove();
  el.addEventListener('click', (e) => { if (e.target === el) close(); });
  const ta = el.querySelector('#btConfirmText');
  el.querySelector('#btCopy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(c.text); } catch (e) { try { ta.select(); document.execCommand('copy'); } catch (e2) {} }
    const b = el.querySelector('#btCopy'); b.textContent = '已复制'; setTimeout(() => { b.textContent = '复制'; }, 1200);
  });
  el.querySelector('#btCancel').addEventListener('click', close);
  el.querySelector('#btRun').addEventListener('click', () => { close(); runSrsiBacktest(days, { force: true }); });
  const onKey = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
}

// 将回测结果 + 条件 + 原始K线导出为单份 .md 文档（人类表格 + 机器 JSON）
function _btFmtDate(ts) { const d = new Date(ts); const p = n => String(n).padStart(2, '0'); return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()); }
export function exportBacktestReport(res, days, sym, mode, startMs, endMs) {
  if (typeof document === 'undefined') return;
  const c = buildBacktestConditions(days);
  const isSpot = mode === 'spot';
  const up = res.pnlPct >= 0;
  const modeBadge = isSpot ? '现货 1x' : ('永续 ' + (res.lev || 1) + 'x');
  const principalTxt = isSpot
    ? ('本金 现货USDT池 $' + _btMoney(res.spotInitU != null ? res.spotInitU : 0) + ' + ' + sym + '库存 ' + (res.spotInitC != null ? res.spotInitC : 0))
    : ('本金 $' + res.principal);
  const totFee = res.totalFee || 0, totSlip = res.totalSlip || 0, totFund = res.totalFunding || 0;
  const fundTxt = totFund >= 0 ? ('资金费净收 ' + _btMoney(totFund)) : ('资金费净付 ' + _btMoney(-totFund));
  const head = '| 时间 | 动作 | 价格 | 金额 | 手续费 | 滑点 | 资金费 | 净盈亏 | 余额 | K | D | 模式 |';
  const sep = '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |';
  const rows = res.trades.map(t => {
    const act = t.action === 'open' ? (t.side === 'long' ? '开多' : '开空')
      : t.action === 'liquidate' ? ('爆仓' + (t.side === 'long' ? '多' : '空'))
      : ('平' + (t.side === 'long' ? '多' : '空') + (t.pnl > 0 ? '' : '亏'));
    const amt = t.action === 'open' && t.amt != null ? _btMoney(t.amt) : '—';
    const fee = t.fee != null ? _btCost(t.fee) : '—';
    const slip = t.slip != null ? _btCost(t.slip) : '—';
    const fund = t.funding != null ? _btMoney(t.funding, true) : '—';
    const pnl = t.action !== 'open' && t.pnl != null ? _btMoney(t.pnl, true) : '—';
    const bal = t.bal != null ? _btMoney(t.bal) : '—';
    const kk = t.k != null ? t.k.toFixed(1) : '—';
    const dd = t.d != null ? t.d.toFixed(1) : '—';
    const mm = t.marginMode === 'coin' ? '币本位' : t.marginMode === 'usdt' ? 'U本位' : t.marginMode === 'spot' ? '现货' : '—';
    return '| ' + _btFmtTime(t.t) + ' | ' + act + ' | ' + _btMoney(t.price) + ' | ' + amt + ' | ' + fee + ' | ' + slip + ' | ' + fund + ' | ' + pnl + ' | ' + bal + ' | ' + kk + ' | ' + dd + ' | ' + mm + ' |';
  }).join('\n');
  const raw = _btReadRaw(sym, days);
  const md = [
    '# SRSI 自动回测报告', '',
    '- 生成时间：' + new Date().toLocaleString(),
    '- 币对：' + sym,
    '- 回测周期：' + days + ' 天（' + new Date(startMs).toLocaleString() + ' ~ ' + new Date(endMs).toLocaleString() + '）',
    '- 账户类型：' + modeBadge + ' ｜ ' + principalTxt,
    '- 版本：' + c.json.version, '',
    '## 一、回测条件', c.human, '',
    '## 二、结果概要',
    '- 期末权益：$' + res.finalEquity.toFixed(1) + '（' + (up ? '+' : '') + res.pnlPct.toFixed(1) + '%）｜ 净收益 ' + _btMoney(res.finalEquity - res.principal, true),
    '- 胜率：' + (res.winRate * 100).toFixed(0) + '%（' + res.wins + '胜/' + res.losses + '负）｜ 开多' + res.longs + '/开空' + res.shorts + ' ｜ 最大回撤 ' + (res.maxDD * 100).toFixed(1) + '% ｜ 共 ' + res.trades.length + ' 笔',
    '- 成本：手续费 ' + _btMoney(totFee) + ' ｜ 滑点 ' + _btMoney(totSlip) + ' ｜ ' + fundTxt,
    (res.liqCount || 0) > 0 ? ('- ⚠ 强平 ' + res.liqCount + ' 次，净损失 ' + _btMoney(res.liqLoss, true)) : '',
    isSpot ? ('- 现货期末：现金 USDT $' + _btMoney(res.finalU) + ' ｜ ' + sym + '库存 ' + res.finalC + '（≈$' + _btMoney(res.finalC * res.finalPrice) + '）｜ 期末价 $' + _btMoney(res.finalPrice)) : '', '',
    '## 三、交易明细', head, sep, rows || '（无成交）', '',
    (_btAlphaText ? [_btAlphaText, ''] : []),
    (_btComboText ? ['## 三点五、Alpha 组合（vol 倒数融合，计算见 Alpha 实验室 comboWithSrsi；历史回测非预测）', _btComboText, ''] : []),
    '## 四、强平归因（供第三方 AI 找爆仓信号）',
    '- 强平单数：' + (res.liqLog ? res.liqLog.length : 0) + ' ｜ 全部开仓快照数：' + (res.openLog ? res.openLog.length : 0) + '（对照组：liquidated=false）',
    '- 每笔强平含：开仓时刻 openCtx(k15/d15/srsi4h|1h|30m/ema4h|1h|30m/atrPct15/priceVsEma15|1h/recentCandlePct/hotStop) + 强平时刻 liqCtx + adverseMovePct',
    '--- liqLog JSON ---',
    JSON.stringify(res.liqLog || [], null, 2),
    '--- openLog(对照组) JSON ---',
    JSON.stringify(res.openLog || [], null, 2),
    '',
    '## 五、机器可读数据（复制给 AI 复现）',
    '--- 原始数据 JSON ---',
    JSON.stringify({
      symbol: sym, days: days, mode: mode, startMs: startMs, endMs: endMs, version: c.json.version,
      conditions: c.json,
      summary: {
        finalEquity: res.finalEquity, pnlPct: res.pnlPct, winRate: res.winRate, wins: res.wins, losses: res.losses,
        longs: res.longs, shorts: res.shorts, maxDD: res.maxDD, trades: res.trades.length, totalFee: totFee,
        totalSlip: totSlip, totalFunding: totFund, liqCount: res.liqCount || 0, liqLoss: res.liqLoss || 0, principal: res.principal
      },
      trades: res.trades, rawKlines: raw || null
    }, null, 2),
    '--- 结束 ---'
  ].filter(s => s !== '').join('\n');
  const fname = sym + '-' + _btFmtDate(startMs) + '-' + _btFmtDate(endMs) + '-' + days + 'd-' + mode + '.txt';
  let url = null;
  try {
    const blob = new Blob([md], { type: 'text/plain;charset=utf-8' });
    url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fname;
    document.body.appendChild(a); a.click(); a.remove();
  } catch (e) {}
  if (url) setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 1000);
}

// 页面回测入口：拉取历史 K线并渲染结果（结果按区间本地持久化、原始K线缓存可覆盖）
// GOAL12：基石策略（Alpha）单独回测——参数固化为 GOAL2-4 定版（vt30%/L3/band5%/combo 权重 0.5+0.2+0.3，不参与优选）
export async function runAlphaBacktest(days, opts) {
  const el = typeof document !== 'undefined' ? document.getElementById('ktSrsiBtResult') : null;
  const sym = cfg.symbol;
  const now = Date.now(), endMs = now;
  const start2 = now - days * 86400e3;
  try {
    if (el) el.innerHTML = '<div class="kt-auto-row">Alpha 基石回测中…（拉取 1h/1d 历史）</div>';
    const need1h = Math.ceil(days * 24) + 240, need1d = Math.ceil(days) + 260;
    const [k1h, k1d] = await Promise.all([
      _btFetch(sym, '1h', start2 - 30 * 86400e3, endMs, null, need1h),
      _btFetch(sym, '1d', start2 - 30 * 86400e3, endMs, null, need1d)
    ]);
    if (!k1h || !k1d || k1h.length < 250 || k1d.length < 40) { if (el) el.innerHTML = '<div class="kt-auto-row kt-auto-warn">Alpha 回测：1h/1d 数据不足（1h=' + (k1h || []).length + ' 1d=' + (k1d || []).length + '）</div>'; return null; }
    const toRows = (x) => Array.isArray(x) ? x.map(k => [+k[0], +k[1], +k[2], +k[3], +k[4]]) : x.closes.map((c, i) => [+x.times[i], +x.opens[i], +x.highs[i], +x.lows[i], +c]);
    const r1h = toRows(k1h), r1d = toRows(k1d);
    const h1 = { t: r1h.map(k => k[0]), o: r1h.map(k => k[1]), c: r1h.map(k => k[4]) };
    const d1 = { t: r1d.map(k => k[0]), c: r1d.map(k => k[4]) };
    const r = alphaRunBacktest(h1, d1, { start: start2, end: endMs, band: 0.05, volTarget: 0.3, vtCap: 1.5, levCap: 3, funding: [], useFunding: false });
    if (r.error) { if (el) el.innerHTML = '<div class="kt-auto-row kt-auto-warn">Alpha 回测失败: ' + r.error + '</div>'; return null; }
    const ann = ((Math.pow(r.final, 365 / Math.max(1, r.nBars / 24)) - 1) * 100);
    // GOAL14：年度分解 + 明细（对齐 SRSI 报告可复核性）
    const yr = {};
    let pe = 1;
    for (let i = 0; i < r.ts.length; i++) { const y = new Date(r.ts[i]).getUTCFullYear(); (yr[y] = yr[y] || []).push([i, r.eqs[i]]); }
    let yrTxt = '';
    for (const y of Object.keys(yr).sort()) {
      const seg = yr[y]; const v0 = seg[0][1] > 0 ? seg[0][1] : 1, v1 = seg[seg.length - 1][1];
      yrTxt += y + ': ' + ((v1 / v0 - 1) * 100).toFixed(1) + '%  ';
    }
    let detTxt = '';
    const showN = Math.min(r.trades.length, 10);
    for (const t of r.trades.slice(-showN)) {
      detTxt += new Date(t.tIn).toISOString().slice(5, 16) + ' ' + (t.side || '') + ' w=' + (t.w != null ? (t.w * 100).toFixed(0) + '%' : '-') + ' 入@' + (t.pIn != null ? t.pIn.toFixed(0) : '-') + ' → 出@' + (t.pOut != null ? t.pOut.toFixed(0) : '-') + ' 盈亏 ' + (t.pnlPct != null ? t.pnlPct.toFixed(1) + '%' : '') + '\n';
    }
    _btAlphaText = '## 三、基石策略 Alpha 回测（参数固化 GOAL2-4 定版，历史回测非预测）\n- 窗口: ' + days + 'd (' + new Date(start2).toISOString().slice(0, 10) + ' → ' + new Date(endMs).toISOString().slice(0, 10) + ')\n- 期末权益: ' + (r.final * 100).toFixed(1) + '%（本金 100%）\n- 年化(CAGR): ' + ann.toFixed(1) + '%\n- Sharpe(日): ' + (r.sharpe || 0).toFixed(2) + '\n- maxDD: ' + (r.maxDD || 0).toFixed(1) + '%\n- 调仓次数: ' + r.trades.length + '\n- 费用: ' + (r.fees * 100).toFixed(2) + '%\n- 年度分解: ' + yrTxt + '\n- 参数: vt30% / levCap3 / band5% / combo权重 carry0.5+momo0.2+brk0.3（固化，不优选）\n- 最近调仓明细:\n' + detTxt + '\n';
    if (el) {
      el.innerHTML = '<div class="kt-auto-row"><b>🧭 Alpha 基石策略</b>（参数固化 GOAL2-4 定版·不参与优选·历史回测非预测）</div>'
        + '<div class="kt-auto-row">窗口 ' + days + 'd｜期末权益 <b>' + (r.final * 100).toFixed(1) + '%</b>｜年化 <b>' + ann.toFixed(1) + '%</b>｜Sharpe <b>' + (r.sharpe || 0).toFixed(2) + '</b>｜maxDD <b>' + (r.maxDD || 0).toFixed(1) + '%</b></div>'
        + '<div class="kt-auto-row">调仓 ' + r.trades.length + ' 次｜费用 ' + (r.fees * 100).toFixed(2) + '%｜参数 vt30%/L3/band5%/权重0.5+0.2+0.3（固化）</div>'
        + '<div class="kt-auto-row">年度分解: ' + yrTxt + '</div>'
        + '<div class="kt-auto-row" style="white-space:pre-wrap;font-size:10px;opacity:.85">最近调仓 ' + showN + ' 笔:\n' + detTxt + '（全部 ' + r.trades.length + ' 笔见「📄 导出」报告）</div>';
    }
    window.__alphaBtLast = { sym, days, final: r.final, ann, sharpe: r.sharpe, dd: r.maxDD };
    // GOAL15：导出按钮（基石报告全文 + 全部逐笔调仓）
    if (el) {
      const exA = document.createElement('div');
      exA.className = 'kt-auto-row';
      exA.innerHTML = '<button id="ktBtExportAlpha" class="kt-btn kt-bt">📄 导出基石报告</button><span style="font-size:10px;opacity:.7;margin-left:6px">含年度分解+全部 ' + r.trades.length + ' 笔逐笔调仓</span>';
      el.appendChild(exA);
      exA.querySelector('#ktBtExportAlpha').addEventListener('click', () => {
        const rows2 = r.trades.map(t => '| ' + (t.tIn ? new Date(t.tIn).toISOString().slice(0, 16).replace('T', ' ') : '-') + ' | ' + (t.side || '') + ' | 权重 ' + (t.w != null ? (t.w * 100).toFixed(0) + '%' : '-') + ' | 入 ' + (t.pIn != null ? t.pIn.toFixed(1) : '-') + ' | 出 ' + (t.pOut != null ? t.pOut.toFixed(1) : '-') + ' | 盈亏 ' + (t.pnlPct != null ? t.pnlPct.toFixed(1) + '%' : '-') + ' |');
        const md = [_btAlphaText, '', '## 四、基石逐笔调仓明细', '| 时间 | 方向 | 权重 | 入价 | 出价 | 盈亏 |', '| --- | --- | --- | --- | --- | --- |'].concat(rows2).join('\n');
        const blob = new Blob([md], { type: 'text/plain;charset=utf-8' });
        const a2 = document.createElement('a');
        a2.href = URL.createObjectURL(blob);
        a2.download = 'alpha-' + sym + '-' + new Date(start2).toISOString().slice(0, 10) + '-' + new Date(endMs).toISOString().slice(0, 10) + '-' + days + 'd.txt';
        a2.click(); setTimeout(() => URL.revokeObjectURL(a2.href), 5000);
      });
    }
    return r;
  } catch (e) {
    if (el) el.innerHTML = '<div class="kt-auto-row kt-auto-warn">Alpha 回测失败: ' + (e && e.message) + '</div>';
    return null;
  }
}
let _btAlphaText = ''; // GOAL12：基石报告文本（导出并入）
export async function runSrsiBacktest(days, opts) {
  const el = typeof document !== 'undefined' ? document.getElementById('ktSrsiBtResult') : null;
  const sym = cfg.symbol;
  // GOAL12：策略分流——alpha=基石单独回测；srsi/combo 走原 SRSI 流程
  if ((_btCfg.btStrategy || 'alpha') === 'alpha') return runAlphaBacktest(days, opts);
  const force = !!(opts && opts.force);
  let kl = force ? null : _btReadRaw(sym, days);
  const now = Date.now(), endMs = now, startMs = now - days * 24 * 3600 * 1000;
  // 多往前取一段预热（SRSI 约需 85 根 15m 才出有效 KD），但成交只在窗口内重放
  const warmupMs = 140 * 15 * 60 * 1000; // ≈35h 的 15m 预热
  const fetchStart = startMs - warmupMs;
  // A5：优选过拟合泄漏自检——若回测窗口落在近期「参数优选」覆盖的窗口内，结果不可信
  const _leak = checkOptBacktestLeak(sym, startMs, endMs);
  if (_leak) console.warn('[SRSI-LEAK] ' + _leak);
  try {
    if (!kl) {
      if (el) el.innerHTML = '<div class="kt-auto-row">回测中…（并行拉取历史 K线）</div>';
      // 长周期需按比例放大 maxBars：15m 一年≈35040 根，默认 12000 会截断窗口
      const maxBars = Math.ceil(days * 96) + 256;
      const [k15, k1h, k30, k4h] = await Promise.all([
        _btFetch(sym, '15m', fetchStart, endMs, null, maxBars),
        _btFetch(sym, '1h', fetchStart, endMs, null, maxBars),
        _btFetch(sym, '30m', fetchStart, endMs, null, maxBars),
        _btFetch(sym, '4h', fetchStart, endMs, null, maxBars)
      ]);
      kl = { '15m': k15, '1h': k1h, '30m': k30, '4h': k4h };
      try { const _n = (x) => x ? (Array.isArray(x) ? x.length : (x.closes || []).length) : 0; console.log('[BT-FETCH] 15m=' + _n(k15) + ' 1h=' + _n(k1h) + ' 30m=' + _n(k30) + ' 4h=' + _n(k4h)); } catch (e) {}
      _btWriteRaw(sym, days, kl);
    }
    const bt = _btCfgLoad();
    const mode = (bt.accountType === 'spot') ? 'spot' : 'perp';
    const principal = (typeof bt.principal === 'number') ? bt.principal : 1000;
    let sim = null;
    if (mode === 'spot') { sim = _getSim(); }
    let fund = force ? null : _btReadFund(sym, days);
    if (mode !== 'spot' && !fund && bt.useCost) {
      try {
        fund = await fetchFundingRate(sym, fetchStart, endMs);
        if (fund && fund.length) _btWriteFund(sym, days, fund);
      } catch (e) { fund = null; }
    }
    const effConfig = _btOverlayFor(cfg, bt);
    const btOpts = { mode, coinSeed: (typeof bt.coin === 'number' && bt.coin > 0) ? bt.coin : 0 };
    if (mode === 'spot') {
      // 现货种子完全由独立回测设置决定（不再读主系统模拟池 _getSim）：U本位只看本金、币本位只看本币、跟随二者皆用
      btOpts.spotUsdt = (bt.marginMode === 'coin') ? 0 : principal;
      btOpts.spotCoin = (bt.marginMode === 'usdt') ? 0 : bt.coin;
    }
    const res = backtestSrsiAuto(sym, kl, effConfig, principal, startMs, fund, btOpts);
    res.optLeak = _leak || null;
    _btLastDays = days;
    // GOAL9：暴露回测参数快照 + 勾选「应用回测参数」时自动应用到实盘自动交易
    try {
      if (typeof window !== 'undefined') window.__srsiBtEff = effConfig;
      if (typeof window !== 'undefined' && cfg.srsiAutoApplyBt && applyBtSnapshot(bt, effConfig) && el) {
        el.insertAdjacentHTML('beforeend', '<div class="kt-auto-row kt-bt-cost">⚡ 已应用回测参数到实盘自动交易（SRSI 参数/杠杆/仓位/带/防爆等，' + new Date().toLocaleTimeString() + '）</div>');
      }
    } catch (e) { /* 忽略 */ }
    // GOAL8：向 Alpha 实验室/主图层暴露已实现日权益（仅平/爆事件，平仓点才无歧义）+ 交易明细（主图标注用）
    try {
      if (typeof window !== 'undefined' && res && res.trades) {
        window.__srsiBtDaily = { sym, days, bal: res.trades.filter(t => t.action !== 'open' && t.bal != null).map(t => [t.t, t.bal]) };
        window.__srsiBtTrades = res.trades;
        window.__srsiBtSym = sym;
      }
    } catch (e) { /* 非浏览器环境忽略 */ }
    const store = _btReadStore();
    store.results = store.results || {};
    const slim = Object.assign({}, res); delete slim.eqs; delete slim.ws; delete slim.fund; // GOAL14：大数组不落盘（防配额爆，绘制/报告不依赖）
    store.results[sym + '|' + days + (mode === 'spot' ? '|spot' : '')] = slim;
    store.lastDays = days;
    store.lastSym = sym;
    store.lastMode = mode;
    _btWriteStore(store);
    if (el) {
      el.innerHTML = _renderBacktestResult(res, days);
      const exBtn = el.querySelector('#ktBtExport');
      if (exBtn) exBtn.addEventListener('click', () => exportBacktestReport(res, days, sym, mode, startMs, endMs));
      // GOAL8：勾选「叠加Alpha组合」→ 回测完成后自动计算组合行（vol 倒数融合，GOAL7 实验）
      if (typeof window !== 'undefined' && _btCfg.btStrategy === 'combo' && window.__alphaLab && window.__alphaLab.comboWithSrsi && window.__srsiBtDaily) {
        const comboEl = document.createElement('div');
        comboEl.innerHTML = '<div class="kt-auto-row">🧪 Alpha 组合计算中…（拉取 1h 历史重放 Alpha 子账户）</div>';
        el.appendChild(comboEl);
        window.__alphaLab.comboWithSrsi(window.__srsiBtDaily).then(r => {
          if (r && r.html) { comboEl.innerHTML = r.html; _btComboText = r.text || ''; }
        }).catch(() => { comboEl.innerHTML = '';
        });
      }
    }
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    if (el) el.innerHTML = '<div class="kt-auto-row kt-auto-warn">回测失败: ' + msg + '</div>'
      + '<div class="kt-auto-row">若行情源不可达，可在页面加载前设 window.KCHART_BINANCE_API 换可用端点</div>';
  }
}

// 刷新/重开页面后恢复上次回测结果（按区间覆盖）
export function renderSavedBacktest() {
  const el = typeof document !== 'undefined' ? document.getElementById('ktSrsiBtResult') : null;
  if (!el || el.querySelector('.kt-bt-table')) return;
  const store = _btReadStore();
  if (!store || !store.results) return;
  const key = cfg.symbol + '|' + (store.lastDays || 1) + ((store.lastMode === 'spot') ? '|spot' : '');
  if (store.results[key]) {
    const svRes = store.results[key], svDays = store.lastDays || 1, svSym = store.lastSym || cfg.symbol, svMode = store.lastMode || 'perp';
    const svNow = Date.now(), svEnd = svNow, svStart = svNow - svDays * 24 * 3600 * 1000;
    // GOAL8：恢复保存结果时同步刷新主图标注/组合数据源
    try {
      if (typeof window !== 'undefined' && svRes && svRes.trades) {
        window.__srsiBtDaily = { sym: svSym, days: svDays, bal: svRes.trades.filter(t => t.action !== 'open' && t.bal != null).map(t => [t.t, t.bal]) };
        window.__srsiBtTrades = svRes.trades;
        window.__srsiBtSym = svSym;
      }
    } catch (e) { /* 忽略 */ }
    el.innerHTML = _renderBacktestResult(svRes, svDays);
    const exBtn = el.querySelector('#ktBtExport');
    if (exBtn) exBtn.addEventListener('click', () => exportBacktestReport(svRes, svDays, svSym, svMode, svStart, svEnd));
  }
}

function _buildOrderMgrModal() {
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.id = 'orderMgrModal';
  ov.innerHTML = `
    <div class="modal order-mgr">
      <div class="om-head">
        <h3>订单管理 · 所有币持仓 <span id="omCount" class="om-count"></span></h3>
        <div class="om-head-btns">
          <button id="omCloseAll" class="btn btn-sell btn-sm">一键全平</button>
          <button id="omClose" class="btn btn-sm">关闭</button>
        </div>
      </div>
      <div class="om-note">以下为全部交易对持仓与平仓记录（自动/人工）</div>
      <div class="om-tabs">
        <button id="omTabPos" class="om-tab on" type="button">持仓</button>
        <button id="omTabHist" class="om-tab" type="button">平仓记录</button>
      </div>
      <div id="omPosSection" class="om-section">
        <div class="om-cols">
          <span>交易对</span><span>方向</span><span>模式</span><span>杠杆</span><span>开仓价</span>
          <span>标记价</span><span>浮盈</span><span>TP</span><span>SL</span><span>操作</span>
        </div>
        <div id="omRows" class="om-rows"></div>
        <div id="omEmpty" class="om-empty">暂无持仓</div>
      </div>
      <div id="omHistSection" class="om-section" style="display:none">
        <div class="om-hist-cols">
          <span>交易对</span><span>方向</span><span>杠杆</span><span>开仓价</span><span>平仓价</span>
          <span>盈亏</span><span>来源</span><span>原因</span><span>时间</span>
        </div>
        <div id="omHistory" class="om-rows"></div>
        <div id="omHistEmpty" class="om-empty">暂无平仓记录</div>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.addEventListener('click', (e) => { if (e.target === ov) closeOrderManager(); });
  ov.querySelector('#omClose').addEventListener('click', closeOrderManager);
  ov.querySelector('#omCloseAll').addEventListener('click', () => {
    if (!_tradeEngine) return;
    (_tradeEngine.S.pos || []).slice().forEach(p => _tradeEngine.exitPosition(p, { reason: '一键全平' }));
    _renderOrderMgr(); renderQuickTrade();
  });
  const setTab = (tab) => {
    _omTab = tab;
    ov.querySelector('#omTabPos').classList.toggle('on', tab === 'positions');
    ov.querySelector('#omTabHist').classList.toggle('on', tab === 'history');
    ov.querySelector('#omPosSection').style.display = tab === 'positions' ? '' : 'none';
    ov.querySelector('#omHistSection').style.display = tab === 'history' ? '' : 'none';
    _renderOrderMgr();
  };
  ov.querySelector('#omTabPos').addEventListener('click', () => setTab('positions'));
  ov.querySelector('#omTabHist').addEventListener('click', () => setTab('history'));
  const rows = ov.querySelector('#omRows');
  rows.addEventListener('click', (e) => {
    const row = e.target.closest('.om-row'); if (!row) return;
    const oid = row.dataset.oid;
    const pos = (_tradeEngine.S.pos || []).find(p => p.orderId === oid);
    if (!pos) return;
    if (e.target.classList.contains('om-close')) { _tradeEngine.exitPosition(pos, { reason: '手动平仓(管理)' }); _renderOrderMgr(); renderQuickTrade(); }
    else if (e.target.classList.contains('om-partial')) { _tradeEngine.closePartial(pos, { ratio: 0.5, reason: '部分平仓(管理)' }); _renderOrderMgr(); renderQuickTrade(); }
    else if (e.target.classList.contains('om-rev')) { reversePosition(_tradeEngine, pos); _renderOrderMgr(); renderQuickTrade(); }
  });
  rows.addEventListener('change', (e) => {
    const row = e.target.closest('.om-row'); if (!row) return;
    const oid = row.dataset.oid;
    const pos = (_tradeEngine.S.pos || []).find(p => p.orderId === oid);
    if (!pos) return;
    if (e.target.classList.contains('om-lev')) { const v = Math.max(1, Math.min(30, parseInt(e.target.value) || 1)); pos.lev = v; e.target.value = v; }
    else if (e.target.classList.contains('om-tp')) { const v = parseFloat(e.target.value); pos.tp = (e.target.value === '' || isNaN(v)) ? null : v; }
    else if (e.target.classList.contains('om-sl')) { const v = parseFloat(e.target.value); pos.sl = (e.target.value === '' || isNaN(v)) ? null : v; }
  });
  return ov;
}

function _renderOrderMgr() {
  const ov = document.getElementById('orderMgrModal');
  if (!ov || !_omOpen || !_tradeEngine) return;
  const S = _tradeEngine.S;
  const pos = (S && S.pos) || [];
  const count = ov.querySelector('#omCount');
  if (count) count.textContent = '(' + pos.length + ')';
  if (_omTab === 'history') {
    const hist = (S && S.closed) || [];
    const rows = ov.querySelector('#omHistory');
    const empty = ov.querySelector('#omHistEmpty');
    if (!hist.length) { rows.innerHTML = ''; empty.style.display = ''; return; }
    empty.style.display = 'none';
    rows.innerHTML = hist.slice().reverse().map(c => {
      const pc = c.pnl >= 0 ? 'up' : 'down';
      const d = new Date(c.t);
      const tStr = isNaN(d) ? '' : d.toLocaleString('zh-CN', { hour12: false });
      const srcCls = c.src === 'srsiAuto' ? 'auto' : 'manual';
      const srcTxt = c.src === 'srsiAuto' ? '自动' : '人工';
      return `<div class="om-hist-row">
        <span>${c.sym.replace('USDT', '')}</span>
        <span class="${pc}">${c.side === 'long' ? '多' : '空'}</span>
        <span>${c.lev}x</span>
        <span>$${_fmt(c.entry)}</span>
        <span>$${_fmt(c.exit)}</span>
        <span class="${pc}">${c.pnl >= 0 ? '+' : ''}$${_fmt(c.pnl)}</span>
        <span class="om-src ${srcCls}">${srcTxt}</span>
        <span class="om-reason">${c.reason || ''}</span>
        <span class="om-time">${tStr}</span>
      </div>`;
    }).join('');
    return;
  }
  const rows = ov.querySelector('#omRows');
  const empty = ov.querySelector('#omEmpty');
  if (!pos.length) { rows.innerHTML = ''; empty.style.display = ''; return; }
  empty.style.display = 'none';
  rows.innerHTML = pos.map(p => {
    const c = (S.prices[p.sym] || {}).last;
    const pnl = p.pnl || 0; const pct = p.pnlPct || 0;
    const pc = pnl >= 0 ? 'up' : 'down';
    const sideTxt = p.side === 'long' ? '多单' : '空单';
    const modeTxt = p.marginMode === 'coin' ? '币本位' : 'U本位';
    const srcCls = p.src === 'srsiAuto' ? 'auto' : 'manual';
    const srcTxt = p.src === 'srsiAuto' ? '自动' : '人工';
    return `<div class="om-row" data-oid="${p.orderId}">
      <span>${p.sym.replace('USDT', '')}</span>
      <span class="${pc}">${sideTxt} <span class="om-src ${srcCls}">${srcTxt}</span></span>
      <span>${modeTxt}</span>
      <span data-label="杠杆"><input class="om-lev" type="number" min="1" max="30" value="${p.lev}" style="width:42px"/></span>
      <span data-label="开仓价">$${_fmt(p.entry)}</span>
      <span data-label="标记价">${c != null ? '$' + _fmt(c) : '-'}</span>
      <span class="${pc}">${pnl >= 0 ? '+' : ''}$${_fmt(pnl)} (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)</span>
      <span><input class="om-tp" type="number" step="any" placeholder="TP" value="${p.tp != null ? p.tp : ''}"/></span>
      <span><input class="om-sl" type="number" step="any" placeholder="SL" value="${p.sl != null ? p.sl : ''}"/></span>
      <span class="om-ops">
        <button class="om-close btn btn-sell btn-sm">平</button>
        <button class="om-partial btn btn-sm">平50%</button>
        <button class="om-rev btn btn-sm">反手</button>
      </span>
    </div>`;
  }).join('');
}

function openOrderManager(opts) {
  if (!_tradeEngine) { if (typeof alert === 'function') alert('交易引擎未连接'); return; }
  _omTab = (opts && opts.tab) || 'positions';
  _omOpen = true;
  let ov = document.getElementById('orderMgrModal');
  if (!ov) ov = _buildOrderMgrModal();
  if (ov.querySelector('#omTabPos') && ov.querySelector('#omTabHist')) {
    ov.querySelector('#omTabPos').classList.toggle('on', _omTab === 'positions');
    ov.querySelector('#omTabHist').classList.toggle('on', _omTab === 'history');
    ov.querySelector('#omPosSection').style.display = _omTab === 'positions' ? '' : 'none';
    ov.querySelector('#omHistSection').style.display = _omTab === 'history' ? '' : 'none';
  }
  ov.classList.add('show');
  _renderOrderMgr();
  if (_omTimer) clearInterval(_omTimer);
  _omTimer = setInterval(() => { if (_omOpen) _renderOrderMgr(); }, 800);
}

function closeOrderManager() {
  _omOpen = false;
  if (_omTimer) { clearInterval(_omTimer); _omTimer = null; }
  const ov = document.getElementById('orderMgrModal');
  if (ov) ov.classList.remove('show');
}

function onTradeKey(e) {
  if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
  const bar = _tradeBar();
  if (!bar || bar.offsetParent === null) return;
  if (e.key === 'ArrowUp') { e.preventDefault(); kchartTradeOpen('long'); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); kchartTradeOpen('short'); }
  else if (e.key === ' ') { e.preventDefault(); kchartTradeClose(); }
}
if (typeof document !== 'undefined') document.addEventListener('keydown', onTradeKey);
