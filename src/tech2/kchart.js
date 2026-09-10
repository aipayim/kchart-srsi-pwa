// ===== K线分析 页面（全新实现，独立于 技术分析 techChart/techPanel）=====
// 复用公开纯函数与数据源，自建精简渲染：
//   - 顶部：交易对 + K线周期多选（决定 SRSI 多子图）+ 主图周期单选 + 根线数 + 子图顺序 + SRSI 参数
//   - 主图：真 OHLC 蜡烛（数据取自 S.klinesO/H/L 与 S.klines（close））
//   - 子图：RSI / SRSI / MACD（顺序可拖拽），SRSI 对每个勾选 K 线周期渲染短→长堆叠
import { srsiKD, srsiCrossings, srsiHooks, srsiSignal, ema, atrClose, ais, detectRegimeState } from '../engine/indicators.js';
import { optimizeSrsi, srsiNeighborhoodGrid, srsiParamGrid, optimizeSrsiBand, optimizeGateBand, rollingGateOos, bandNeighborTPos, MANUAL_SWING_PARAMS, manualSwingParams, DEFAULT_SRSI_BAND, GATE_PARAMS_GRID } from '../engine/srsiOptimizer.js';
import { fetchKlinesRange, fetchFundingRate } from '../pwa/data.js';
export { fetchKlinesRange, fetchFundingRate };
import { KLINE_TF, KLINE_MINUTES, KLINE_INTERVAL, resample } from '../engine/timeframe.js';
import { THRESH } from '../engine/thresholds.js';
import { getFeeRate } from '../engine/fees.js';
import { liquidationPrice } from '../engine/liquidation.js';
import { fundingPayment, FUNDING_HOURS } from '../engine/funding.js';
import { regimeStrategy } from '../engine/regimeParams.js';
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
const BASE_H = MAIN_H + PAD_T + PAD_B;

const STATE_KEY = 'smartTrader_kchart';

const DEFAULT_SRSI = { rsiPeriod: 85, stochPeriod: 50, smoothK: 10, smoothD: 5, overbought: 80, oversold: 20 };

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
    optPreviewOn: false,       // 主图叠加「优化预览」（虚线 K/D + 上下带，不写入配置）
    mainOverlay: false,         // 主图 SRSI 多周期叠加开关
    ovQuickTfs: [],             // 主图顶部 chip 栏：参与显隐快选的周期集合（overlay/aux 之外的持久记忆）
    subOrder: ['rsi', 'srsi', 'macd'],   // 子图顺序（拖拽换序）
    // ---- SRSI 自动交易 ----
    srsiAutoOn: false,          // SRSI 自动交易总开关
    srsiAutoMode: 'follow',     // 本位：follow=跟随快捷交易(开空U本位/开多币本位) / usdt / coin
    srsiAutoUpper: 0,           // 上限带（0=使用 15m 优选带）
    srsiAutoLower: 0,           // 下限带（0=使用 15m 优选带）
    srsiAutoLev: 5,             // 杠杆（固定）
    srsiAutoBasePct: 10,        // 仓位基准（可用余额的 %）
    srsiAutoMaxSame: 3,         // 最多连开同向仓位数
    srsiAutoDanger: 'none',     // 危险信号防爆：none=关 / filter=预防爆仓(避开危险单) / reverse=防爆反手(避开并反向开单)
    srsiAutoReversePct: 0,      // 反手单仓位%（0=继承正常开仓%）
    srsiAutoReverseLev: 0,      // 反手单杠杆（0=继承正常杠杆）
    srsiAutoDangerAlarm: true,  // 危险信号红色光晕提醒（仅提醒，不触发操作）
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
let _hover = null;
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
      if (LONG_TF_SRSI[tf] && isDefaultSrsi(stored)) c.srsiByTf[tf] = { ...LONG_TF_SRSI[tf] };
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
  if (typeof c.optPreviewOn !== 'boolean') c.optPreviewOn = false;
  if (typeof c.srsiOptDeep !== 'boolean') c.srsiOptDeep = false;
  // 主图快选 chip 栏集合：迁移期用 overlayTfs ∪ srsiAux 回填，并统一按 KLINE_TF 顺序去重
  let quick = Array.isArray(c.ovQuickTfs) ? c.ovQuickTfs.slice() : [];
  Object.keys(c.overlayTfs || {}).forEach(tf => { if (!quick.includes(tf)) quick.push(tf); });
  Object.keys(c.srsiAux || {}).forEach(tf => { if (!quick.includes(tf)) quick.push(tf); });
  c.ovQuickTfs = KLINE_TF.filter(tf => quick.includes(tf));
  if (typeof c.mainOverlay !== 'boolean') c.mainOverlay = false;
  // ---- SRSI 自动交易配置兜底 ----
  if (typeof c.srsiAutoOn !== 'boolean') c.srsiAutoOn = false;
  if (!['follow', 'usdt', 'coin'].includes(c.srsiAutoMode)) c.srsiAutoMode = 'follow';
  if (c.srsiAutoUpper !== 0 && (typeof c.srsiAutoUpper !== 'number' || !(c.srsiAutoUpper >= 50 && c.srsiAutoUpper <= 100))) c.srsiAutoUpper = 90;
  if (c.srsiAutoLower !== 0 && (typeof c.srsiAutoLower !== 'number' || !(c.srsiAutoLower >= 0 && c.srsiAutoLower <= 50))) c.srsiAutoLower = 10;
  if (typeof c.srsiAutoLev !== 'number' || !(c.srsiAutoLev >= 1 && c.srsiAutoLev <= 30)) c.srsiAutoLev = 5;
  if (typeof c.srsiAutoBasePct !== 'number' || !(c.srsiAutoBasePct >= 1 && c.srsiAutoBasePct <= 30)) c.srsiAutoBasePct = 10;
  if (typeof c.srsiAutoMaxSame !== 'number' || !(c.srsiAutoMaxSame >= 1 && c.srsiAutoMaxSame <= 10)) c.srsiAutoMaxSame = 3;
  if (!['none', 'filter', 'reverse'].includes(c.srsiAutoDanger)) c.srsiAutoDanger = 'none';
  if (typeof c.srsiAutoReversePct !== 'number' || !(c.srsiAutoReversePct >= 0 && c.srsiAutoReversePct <= 100)) c.srsiAutoReversePct = 0;
  if (typeof c.srsiAutoReverseLev !== 'number' || !(c.srsiAutoReverseLev >= 0 && c.srsiAutoReverseLev <= 30)) c.srsiAutoReverseLev = 0;
  if (typeof c.srsiAutoDangerAlarm !== 'boolean') c.srsiAutoDangerAlarm = true;
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
  _store.lastSymbol = sym;
}
export function persist() {
  if (!_store) _store = readStore();
  _store.bySymbol[cfg.symbol] = cfg;
  _store.lastSymbol = cfg.symbol;
  try { localStorage.setItem(STATE_KEY, JSON.stringify(_store)); } catch (e) {}
  try { sessionStorage.setItem(STATE_KEY + ':ss', JSON.stringify(_store)); } catch (e) {}
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
      optSectionHtml(cfg.srsiEditTf);
  }
  renderMainTools();
}

// 主图正上方的 SRSI 叠加操作工具条（贴着主图，避免被页面顶部折叠遮挡）
// 复用签名守卫：先以「轻量签名」(状态 + 各周期末值/参数/长度) 判断是否需重建，
// 仅在数据或状态变化时才跑 srsiKD；renderKChart 每帧调用也不抖。
let _mtSig = '';
function renderMainTools() {
  const el = typeof document !== 'undefined' ? document.getElementById('kchartMainTools') : null;
  if (!el) return;
  const sym = cfg.symbol;
  let cheap = sym + '|';
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
  el.innerHTML = html;
  el.querySelectorAll('.chip').forEach(c => {
    c.addEventListener('click', () => toggleOvQuickTf(c.getAttribute('data-tf')));
  });
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
    })();
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

  initEnergyBall(box, shortFactors, multiTf, sym);
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
function initEnergyBall(box, shortFactors, multiTf, sym) {
  if (_energyRaf) { globalThis.cancelAnimationFrame && globalThis.cancelAnimationFrame(_energyRaf); _energyRaf = 0; }
  const cv = box.querySelector('#discEnergyBall');
  if (!cv) return;
  if (!shortFactors || !shortFactors.length) { cv.style.display = 'none'; return; }
  cv.style.display = '';
  const W = 300, H = 300;
  const model = energyBallLayout(shortFactors, multiTf, W, H);
  const dpr = Math.max(1, globalThis.devicePixelRatio || 1);
  cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + 'px'; cv.style.height = H + 'px';
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
  function frame(now) {
    const tt = ((globalThis.performance && globalThis.performance.now) ? globalThis.performance.now() : Date.now() - start) / 1000;
    drawEnergyBall(ctx, model, { t: tt, price: getPrice(), W, H });
    _energyRaf = globalThis.requestAnimationFrame ? globalThis.requestAnimationFrame(frame) : 0;
  }
  _energyRaf = globalThis.requestAnimationFrame ? globalThis.requestAnimationFrame(frame) : 0;
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
  const H = BASE_H + nSub * (SUB_H + SUB_GAP);
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

export function renderKChart() {
  syncCanvasSize();
  renderQuickTrade();
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

  // 子图
  const subList = buildSubList();
  let y0 = PAD_T + MAIN_H + 6;
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
  renderMainTools(); // 同步主图叠加药丸的 K/D 背景色（受签名守卫保护，无变化不重建）
}

// 轻量面板实时刷新：仅重算「方向基准死区 + 速览 + 纪律分析」DOM，不重绘画布。
// 供主系统 / PWA 的周期 tick 调用（renderKChart 每帧都重绘画布较贵，此处只刷面板）。
export function refreshPanels() {
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
      const y = Y0(v);
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
  return true;
}

// ---- 子图（RSI / SRSI / MACD），SRSI 按勾选周期 ----
function drawSub(ctx, sub, sym, y0) {
  const plotW = W - PAD_L - PAD_R;
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.strokeRect(PAD_L, y0, plotW, SUB_H);

  const S = window.S;
  const price = aggTFData(sym, sub.tf || cfg.mainTF).c;

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
    drawSrsiPanel(ctx, { k: sl.k, d: sl.d, hooks: sl.hooks }, sl.crossings, y0, n, sub);
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
  if (!(n >= 2)) return { k: [], d: [], crossings: [] };
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

function drawSrsiPanel(ctx, sl, crossings, y0, n, sub) {
  const plotW = W - PAD_L - PAD_R;
  const xStep = plotW / n;
  const Y = (v) => y0 + (100 - v) / 100 * SUB_H;
  const X = (i) => PAD_L + i * xStep + xStep / 2;
  const ob = cfg.srsi.overbought, os = cfg.srsi.oversold;
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

  // ---- 顶部联动汇总栏（任意位置都显示：主图 + 全部子图 在 hovered x 的读数）----
  const m = i >= 0 ? mainHoverAt(frac, sym, tf, bars) : null;
  drawLinkBar(ctx, subList, m, tf, frac, mainBottom);

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
    const dt = subHoverAt(frac, sym, sub.tf || tf, sub.key, cfg.bars);
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
    _cv.addEventListener('mouseleave', () => { _hover = null; _press = null; _pressMoved = false; renderKChart(); });
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
function setSym(sym) {
  if (!sym) return;
  if (sym === cfg.symbol) { persist(); renderKChart(); return; }
  persist();                 // 先以旧 symbol 保存当前币对配置
  cfg.symbol = sym;
  _ovFootTf = null;         // 切币对时重置页脚参数周期
  loadCfg();                 // 加载该币对配置（无则默认）
  persist();                 // 更新 lastSymbol
  if (typeof document !== 'undefined') renderControls(); // 同步 SRSI 设置卡等控件显示的新币对
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
  try { localStorage.setItem(STATE_KEY, JSON.stringify(_store)); } catch (e) {}
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
  cfg.srsiByTf[tf][name] = parseInt(v) || DEFAULT_SRSI[name];
  cfg.srsi = { ...cfg.srsiByTf[tf] }; // 保持旧全局镜像同步
  persist(); renderKChart();
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
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(_optStoreKey(sym, tf, days, maxBars), JSON.stringify(obj));
  } catch (e) { /* 配额超限(如 15m 体量) 静默跳过，仅保留会话缓存 */ }
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
  cfg.srsiOptPreview = cfg.srsiOptPreview || {};
  cfg.srsiOptPreview[tf] = { loading: true, role: r, tf, symbol: cfg.symbol, ts: Date.now(), days };
  if (typeof document !== 'undefined') renderControls();

  let data1h = null, dataGate = null, meta = null;
  try {
    if (r === 'gate') {
      const tg = cfg.gateTargetTf || '1h';
      const gateTf = tf; // 闸门周期(被勾选为「辅助只做放行闸门」的周期，默认 15m)，不再硬编码
      const dT = await optFetchKlines(cfg.symbol, tg, days, 'gate');
      const dG = await optFetchKlines(cfg.symbol, gateTf, days, 'gate');
      if (dT && dG && dT.closes.length >= 60 && dG.closes.length >= 60) {
        const tail = Math.min(OPT_TAIL_BARS[tg] || dT.closes.length, dT.closes.length); // 目标周期尾窗（1h→15000、4h→3500）
        const startT = Math.max(0, dT.closes.length - tail);
        const closesT = dT.closes.slice(startT), opensT = dT.opens.slice(startT), timesT = dT.times.slice(startT);
        data1h = { closes: closesT, opens: opensT, times: timesT };
        dataGate = { closesG: dG.closes, opensG: dG.opens, timesG: dG.times };
        meta = { bars: closesT.length, from: timesT[0], to: timesT[timesT.length - 1], days, source: 'history', target: tg, gate: gateTf, gateBars: dG.closes.length };
      }
    } else {
      const fetched = await optFetchKlines(cfg.symbol, tf, days, r);
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
    const c = (getTFData(cfg.symbol, tf).c || []).slice();
    if (c.length >= 60) {
      data1h = { closes: c, opens: (getTFData(cfg.symbol, tf).o || c).slice(), times: (getTFData(cfg.symbol, tf).t || []) };
      meta = { bars: c.length, days: 0, source: 'local', note: '无法拉取长历史，已用当前屏上 K 线' };
    }
  }
  if (!data1h || data1h.closes.length < 60 || (r === 'gate' && !dataGate)) {
    delete cfg.srsiOptPreview[tf];
    if (typeof document !== 'undefined') renderControls();
    return null;
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
      cfg.srsiOptPreview[tf] = { ...res, role: r, tf, symbol: cfg.symbol, ts: Date.now(), ...meta };
      try { res.neighbor = bandNeighborTPos(data1h.closes, data1h.opens, res.best); } catch (_) {}
    } else {
      res = optimizeSrsiBand(data1h.closes, data1h.opens, {
        grid, minValSamples,
        defaultParams: perTfSrsi(tf, cfg.srsiByTf, cfg.srsi)
      });
      // 关键修复（10m 刷新后丢优选）：先把 band 的 best 写入预览。原实现在 optimizeSrsi/ bandNeighborTPos
      // 等后续统计抛异常时整段 catch 返回 null，导致 10m 的 best 永不落盘、永不标记 optimized。
      // 现在 band 一算出 best 就写预览，后续 ATR/邻域统计失败也非致命，10m 仍能被 applySrsiOpt 标记并 persist。
      cfg.srsiOptPreview[tf] = { ...res, role: r, tf, symbol: cfg.symbol, ts: Date.now(), ...meta };
      try {
        const atrRes = optimizeSrsi(data1h.closes, { role: 'swing', grid, minValSamples, defaultParams: perTfSrsi(tf, cfg.srsiByTf, cfg.srsi) });
        res.atr = atrRes;
        res.neighbor = bandNeighborTPos(data1h.closes, data1h.opens, res.best);
      } catch (e2) { /* 非致命：ATR/邻域统计异常不影响主优选(best)落盘 */ }
    }
  } catch (e) {
    // band 主计算异常（真实行情偶发 NaN/数据异常）：回退默认参数，仍写入 best 以便标记 + 持久化
    if (!cfg.srsiOptPreview[tf] || !cfg.srsiOptPreview[tf].best) {
      const def = perTfSrsi(tf, cfg.srsiByTf, cfg.srsi);
      cfg.srsiOptPreview[tf] = { best: def, role: r, tf, symbol: cfg.symbol, ts: Date.now(), decision: 'fallback', reason: '主优选计算异常，回退默认参数', error: (e && e.message) || String(e), ...meta };
    }
  }
  persist();
  if (typeof document !== 'undefined') renderControls();
  return cfg.srsiOptPreview[tf] || null;
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

// 某个子图在 frac 处的读数 (纯数据)
export function subHoverAt(frac, sym, tf, key, bars) {
  const lenBase = aggTFData(sym, tf).c.length;
  const i = idxFromFrac(frac, lenBase, bars);
  const s = subTf(sym, tf);
  const series = s && s.series;
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
    const price = aggTFData(sym, tf).c;
    const sl = srsiPanelSeries(price, perTfSrsi(tf, cfg.srsiByTf, cfg.srsi), bars);
    // srsiPanelSeries 把数组切到最后 bars 根(局部索引 0..n-1)，需把绝对索引 i 换算成局部索引
    const off = Math.max(0, price.length - Math.min(bars, price.length));
    const li = i - off;
    return { i, k: sl.k[li] != null ? sl.k[li] : null, d: sl.d[li] != null ? sl.d[li] : null, cross: sl.crossings[li] || null, hook: sl.hooks[li] || null };
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
  openSrsiCardFor,
  toggleOvQuickTf,
  optimizeSrsiForTf,
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
  __optimizeSrsiForTf: optimizeSrsiForTf,
  __applySrsiOpt: applySrsiOpt,
  __clearSrsiOpt: clearSrsiOpt,
  __setSrsiOptPreview: setSrsiOptPreview,
  __setSrsiOptDeep: setSrsiOptDeep,
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
export function setTradeConfig(c) {
  if (c) {
    if (typeof c.on === 'boolean') _tradeOn = c.on;
    if (typeof c.linked === 'boolean') _tradeLinked = c.linked;
    if (typeof c.lev === 'number') _lev = c.lev;
  }
  renderQuickTrade();
}

function _fmt(n, d = 2) { return (n == null || isNaN(n)) ? '0' : Number(n).toFixed(d); }
function _tradeBar() { return typeof document !== 'undefined' ? document.getElementById('kchartTradeBar') : null; }

function renderQuickTrade() {
  const bar = _tradeBar();
  if (!bar) return;
  if (!_tradeOn) { bar.innerHTML = '<div class="kt-off">快捷交易已关闭（设置中可开启）</div>'; bar._built = false; return; }
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
    return;
  }
  const armShort = _safeguard && _arm.side === 'short' && Date.now() - _arm.t < 3000;
  const armLong = _safeguard && _arm.side === 'long' && Date.now() - _arm.t < 3000;
  const armClose = _safeguard && _arm.side === 'close' && Date.now() - _arm.t < 3000;
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
      <label class="kt-toggle"><input id="ktSrsiAuto" type="checkbox"/>SRSI自动永续合约</label>
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
        <label><input type="radio" name="ktSrsiDanger" value="reverse"/>防爆反手</label>
      </span>
      <label class="kt-mini">反手开仓%<input id="ktSrsiRevPct" class="kt-num" type="number" min="0" max="100" step="1"/> (0=同正常)</label>
      <label class="kt-mini">反手杠杆x<input id="ktSrsiRevLev" class="kt-num" type="number" min="0" max="30" step="1"/></label>
      <label class="kt-mini"><input id="ktSrsiDangerAlarm" type="checkbox"/>危险信号红色提醒</label>
    </div>
    <div class="kt-row kt-auto-opt">
      <label class="kt-mini"><input id="ktSrsiOpt" type="checkbox"/>自动优选6周期</label>
      <label class="kt-mini"><input id="ktSrsiOptIntOn" type="checkbox"/>间隔重优选</label>
      <label class="kt-mini">重优选间隔h<input id="ktSrsiOptInt" class="kt-num" type="number" min="0.5" max="168" step="0.5"/></label>
      <label class="kt-mini">无成交超h<input id="ktSrsiOptNoTr" class="kt-num" type="number" min="0.5" max="168" step="0.5"/></label>
      <button id="ktSrsiOptNow" class="kt-btn kt-bt">立即优选</button>
    </div>
    <div id="ktSrsiAutoPanel" class="kt-auto-panel"></div>
    <div class="kt-bt-section">
      <div class="kt-bt-head"><span>回测设置</span><button id="ktBtClear" class="kt-btn kt-bt" type="button">清空回测</button><button id="ktBtToggle" class="kt-btn kt-bt" type="button">▸</button></div>
      <div id="ktBtBody" class="kt-bt-body">
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
          </span>
          <label class="kt-mini">反手开仓%<input id="btSrsiRevPct" class="kt-num" type="number" min="0" max="100" step="1"/> (0=同正常)</label>
          <label class="kt-mini">反手杠杆x<input id="btSrsiRevLev" class="kt-num" type="number" min="0" max="30" step="1"/></label>
        </div>
        <div class="kt-row kt-auto-bt-opt">
          <span class="kt-mini">自动优选周期
            <label><input type="checkbox" id="ktBtOpt15"/>15m</label>
            <label><input type="checkbox" id="ktBtOpt30"/>30m</label>
            <label><input type="checkbox" id="ktBtOpt1h"/>1h</label>
            <label><input type="checkbox" id="ktBtOpt4h"/>4h</label>
          </span>
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
      </div>
    </div>
    <div id="ktPos" class="kt-row kt-pos"></div>`;
    const b = bar;
    b.querySelector('#ktLev').addEventListener('input', () => { _lev = +b.querySelector('#ktLev').value; b.querySelector('#ktLevV').textContent = _lev + 'x'; });
    b.querySelector('#ktFixed').addEventListener('change', () => { _useFixed = b.querySelector('#ktFixed').checked; renderQuickTrade(); });
    b.querySelector('#ktPct').addEventListener('input', () => { _sizePct = +b.querySelector('#ktPct').value; b.querySelector('#ktPctV').textContent = _sizePct + '%'; });
    b.querySelector('#ktFixedAmt').addEventListener('input', () => { _fixedAmt = parseFloat(b.querySelector('#ktFixedAmt').value) || 0; });
    b.querySelector('#ktSafe').addEventListener('change', () => { _safeguard = b.querySelector('#ktSafe').checked; });
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
    b.querySelector('#ktSrsiDangerAlarm').addEventListener('change', () => { cfg.srsiAutoDangerAlarm = !!b.querySelector('#ktSrsiDangerAlarm').checked; persist(); });
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
  q('ktFixed').checked = _useFixed; q('ktSafe').checked = _safeguard;
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
  const revPctEl = bar.querySelector('#ktSrsiRevPct'), revLevEl = bar.querySelector('#ktSrsiRevLev'), alarmEl = bar.querySelector('#ktSrsiDangerAlarm');
  if (revPctEl) revPctEl.value = cfg.srsiAutoReversePct;
  if (revLevEl) revLevEl.value = cfg.srsiAutoReverseLev;
  if (alarmEl) alarmEl.checked = !!cfg.srsiAutoDangerAlarm;
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
  _btChk('ktBtOptIntOn', _btCfg.optIntervalOn);
  _btVal('ktBtOptInt', _btCfg.optIntervalH);
  _btVal('ktBtOptNoTr', _btCfg.optNoTradeH);
  const dEl2 = bar.querySelector('input[name="btSrsiDanger"][value="' + (_btCfg.danger || 'none') + '"]');
  if (dEl2) dEl2.checked = true;
  _btVal('btSrsiRevPct', _btCfg.reversePct);
  _btVal('btSrsiRevLev', _btCfg.reverseLev);
  // 回测设置面板收起/展开（默认收起，记忆状态）
  const btBody = bar.querySelector('#ktBtBody'), btTog = bar.querySelector('#ktBtToggle');
  if (btBody) btBody.style.display = _btCfg.collapsed ? 'none' : '';
  if (btTog) btTog.textContent = _btCfg.collapsed ? '▸' : '▾';
  renderSrsiAutoPanel();
}

function kchartTradeOpen(side) {
  if (!_tradeOn || !_tradeEngine) return;
  const sym = cfg.symbol;
  const mm = side === 'short' ? 'usdt' : 'coin';
  const engine = _tradeEngine;
  const sub = engine.getPerpSub ? engine.getPerpSub() : null;
  if (!sub) { if (typeof alert === 'function') alert('未初始化模拟账户（请先设置初始资金）'); return; }
  const price = (engine.S.prices && engine.S.prices[sym] && engine.S.prices[sym].last);
  if (!price) { if (typeof alert === 'function') alert('无行情价，无法开仓'); return; }
  if (_safeguard) {
    const now = Date.now();
    if (_arm.side !== side || now - _arm.t > 3000) { _arm = { side, t: now }; renderQuickTrade(); return; }
    _arm = { side: null, t: 0 };
  }
  const available = mm === 'coin' ? ((sub.coins && sub.coins[sym]) || 0) : (sub.bal || 0);
  const amt = _useFixed ? (parseFloat(_fixedAmt) || 0) : available * _sizePct / 100;
  if (amt <= 0) { if (typeof alert === 'function') alert('可用保证金不足'); return; }
  engine.placeOrder({ symbol: sym, side, lev: _lev, amt, marginMode: mm, reinvest: true, src: 'manual', sub: sub.id });
  renderQuickTrade();
}

function kchartTradeClose() {
  if (!_tradeEngine) return;
  const sym = cfg.symbol;
  const pos = (_tradeEngine.S.pos || []).find(p => p.sym === sym);
  if (!pos) return;
  if (_safeguard) {
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
const SRSI_AUTO_TFS = ['5m', '10m', '15m', '30m', '1h', '4h'];
// 模块级状态：每币对记录连开计数与当前 KD 带态（不持久化，重启重建）
const _srsiAuto = {};
function _autoState(sym) {
  if (!_srsiAuto[sym]) _srsiAuto[sym] = { longCount: 0, shortCount: 0, band: 'neutral', lastTradeTs: 0 };
  return _srsiAuto[sym];
}
export function resetSrsiAuto(sym) {
  if (sym) {
    const s = _srsiAuto[sym];
    if (s) { s.longCount = 0; s.shortCount = 0; s.band = 'neutral'; }
  } else {
    Object.keys(_srsiAuto).forEach(k => { const s = _srsiAuto[k]; s.longCount = 0; s.shortCount = 0; s.band = 'neutral'; });
  }
}

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
  const bs = (typeof srsiAutoBandState === 'function') ? srsiAutoBandState(sym) : null;
  const side = bs && bs.edge === 'enterUpper' ? 'short' : (bs && bs.edge === 'enterLower' ? 'long' : null);
  if (!side) return false;
  return emaOpp2(side, kd);
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
async function _autoOptOne(tf) {
  const before = (cfg.srsiOptWinRate && cfg.srsiOptWinRate[tf] != null) ? cfg.srsiOptWinRate[tf] : null;
  const r = await optimizeSrsiForTf(tf, roleForTf(tf));
  if (!r || !r.best) return false;
  // walk-forward 门控：新参数样本外胜率明显低于已应用参数(>2pp)则保留旧参数，不盲目覆盖
  const cw = (r.oos && r.oos.winRate != null) ? r.oos.winRate
    : (r.stats && r.stats.winRate != null ? r.stats.winRate : null);
  if (before != null && cw != null && cw < before - 0.02) return false;
  applySrsiOpt(tf);
  if (cw != null) { cfg.srsiOptWinRate[tf] = cw; persist(); }
  return true;
}
// 全部 6 周期优选并应用；force=true 时无视已优选状态全部重跑
export async function runSrsiAutoOptimizeAll(force) {
  if (_autoOptRunning) return false;
  _autoOptRunning = true;
  try {
    for (const tf of SRSI_AUTO_TFS) {
      if (!force && cfg.srsiOptSource[tf] === 'optimized') continue;
      try { await _autoOptOne(tf); } catch (e) { /* 单周期失败不影响其余 */ }
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

// KD 带状态机：写入模块状态（实盘每秒调用）。row 可选注入用于单测
export function srsiAutoBandState(sym, row) {
  const st = _autoState(sym);
  const c = (getTFData(sym, '15m') || {}).c;
  const srsi15 = (cfg.srsiByTf && cfg.srsiByTf['15m']) || cfg.srsi;
  const rows = (row ? [row] : buildSrsiOverview(['15m'], srsi15, { '15m': c || [] }).rows);
  const r = rows && rows[0];
  const k = r && r.k, d = r && r.d;
  const _eb = resolveEntryBands(cfg);
  const be = bandEdge(st.band, k, d, { upper: _eb.upper, lower: _eb.lower }, st.armed);
  st.band = be.band;
  st.armed = be.armed;
  return { band: be.band, edge: be.edge, k, d };
}

// 主执行入口（每秒调用）。inj 仅用于单测注入（engine/band/klineDir/srsiDir）
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
  // #1 硬约束：15m 未优选 → 禁止自动交易（其余周期方向信息不足，按 #4 规则该减则减）
  const _canTrade = cfg.srsiOptSource['15m'] === 'optimized';
  const _sizeWeights = { '4h': cfg.srsiAutoW4h, '1h': cfg.srsiAutoW1h, '30m': cfg.srsiAutoW30m };
  // 危险信号：本应开仓方向与大周期(4h/1h/30m) EMA120 趋势背离≥2 → 易爆仓
  const emaTf = { '4h': klineDir['4h'], '1h': klineDir['1h'], '30m': klineDir['30m'] };
  const _danger = (side) => emaOpp2(side, emaTf);
  const _autoSameCount = (side) => (engine.S.pos || []).filter(p => p.sym === sym && p.side === side && p.src === 'srsiAuto' && !p.reverse).length;
  const _tryOpen = (side, rev) => {
    if (price == null || !_canTrade) return;
    const isRev = !!rev;
    // 仅约束「自动」开仓的同向数量；反手单为独立类别，不计入也不受此上限约束
    if (!isRev && _autoSameCount(side) >= cfg.srsiAutoMaxSame) return;
    const mm = _autoMarginMode(side);
    const isCoin = mm === 'coin';
    const avail = isCoin ? ((sub.coins && sub.coins[sym]) || 0) : (sub.bal || 0);
    // #4 乘法缩放：基准% × (1 ± 合计%)，未优选或反向的周期扣对应权重
    const scale = computeSizeScale(side, srsiDir, _sizeWeights, cfg.srsiOptSource);
    const basePct = isRev && cfg.srsiAutoReversePct > 0 ? cfg.srsiAutoReversePct : cfg.srsiAutoBasePct;
    const useLev = isRev && cfg.srsiAutoReverseLev > 0 ? cfg.srsiAutoReverseLev : cfg.srsiAutoLev;
    let amt = avail * basePct / 100 * scale;
    const capUsdt = cfg.srsiAutoOpenCapUsdt > 0 ? cfg.srsiAutoOpenCapUsdt : Infinity;
    const capCoin = cfg.srsiAutoOpenCapCoin > 0 ? cfg.srsiAutoOpenCapCoin : Infinity;
    if (isCoin) amt = Math.min(amt, capCoin, capUsdt / price);
    else amt = Math.min(amt, capUsdt, capCoin * price);
    if (amt <= 0) return;
    engine.placeOrder({ symbol: sym, side, lev: useLev, amt, marginMode: mm, reinvest: false, src: 'srsiAuto', reverse: isRev, sub: sub.id });
    st.lastTradeTs = Date.now();
  };
  // 危险信号防爆/反手：none=旧行为；filter=避开危险单；reverse=避开并反向开单（不计入同向连开上限）
  const _attemptOpen = (side) => {
    const danger = _danger(side);
    const mode = cfg.srsiAutoDanger;
    if (mode === 'none') return _tryOpen(side, false);
    if (mode === 'filter') return danger ? undefined : _tryOpen(side, false);
    // reverse：危险时反向开单（reverse 单独立类别，不计入同向连开上限）
    return danger ? _tryOpen(side === 'long' ? 'short' : 'long', true) : _tryOpen(side, false);
  };
  if (_canTrade && bs.edge === 'enterUpper') {
    // 平盈利多单；多单亏损时仅跳过平仓（不操作），空单照开
    // srsiAutoCloseManual 关：仅平自动单；开：盈利的反向人工单也可被自动平（仍仅净盈利才平）
    const longPos = (engine.S.pos || []).find(p => p.sym === sym && p.side === 'long' && (p.src === 'srsiAuto' || cfg.srsiAutoCloseManual));
    if (longPos && longPos.pnl > 0) engine.exitPosition(longPos, { reason: 'SRSI自动 上带平多' });
    _attemptOpen('short');
  } else if (_canTrade && bs.edge === 'enterLower') {
    const shortPos = (engine.S.pos || []).find(p => p.sym === sym && p.side === 'short' && (p.src === 'srsiAuto' || cfg.srsiAutoCloseManual));
    if (shortPos && shortPos.pnl > 0) engine.exitPosition(shortPos, { reason: 'SRSI自动 下带平空' });
    _attemptOpen('long');
  }
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
    ? `<div class="kt-auto-row kt-danger-note">🚨 危险信号：当前开仓方向与大周期(4h/1h/30m) EMA120 趋势背离≥2，易爆仓${cfg.srsiAutoDanger === 'reverse' ? '（将反向开单）' : cfg.srsiAutoDanger === 'filter' ? '（已避开）' : '（仅提醒）'}。</div>`
    : '';
  const _dataReady = ((getTFData(cfg.symbol, '15m') || {}).c || []).length >= 130;
  const _availOk = sub && ((sub.bal > 0) || ((sub.coins && sub.coins[cfg.symbol] > 0)));
  const _mmOk = aLong < cfg.srsiAutoMaxSame && aShort < cfg.srsiAutoMaxSame;
  const light = (on, t) => `<span class="kt-light ${on ? 'on' : 'off'}">${on ? '●' : '○'} ${t}</span>`;
  const _dangerLabel = cfg.srsiAutoDanger === 'reverse' ? '防爆反手' : cfg.srsiAutoDanger === 'filter' ? '预防爆仓' : '防爆关';
  const _dangerOn = cfg.srsiAutoDanger !== 'none';
  const lights = [
    light(!!eng, '引擎'), light(!!sub, '子账户'), light(price != null, '行情'),
    light(!!_availOk, '保证金'), light(_mmOk, '连开未封顶'), light(_dataReady, '数据就绪'),
    light(_dangerOn, _dangerLabel)
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
    ${_dangerTxt}`;
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
  const kd15 = srsiKD(c15, p15);
  const t30 = n30.times, t1h = n1h.times, t4h = n4h.times;
  // 4h/1h/30m 方向行预计算（与实时 srsiDirOf 同一 buildSrsiOverview + auxGateDir 口径）
  const kd4hRows = c4h.length ? buildSrsiOverview(['4h'], p4h, { '4h': c4h }).rows : [];
  const kd1hRows = c1h.length ? buildSrsiOverview(['1h'], p1h, { '1h': c1h }).rows : [];
  const kd30Rows = c30.length ? buildSrsiOverview(['30m'], p30, { '30m': c30 }).rows : [];
  const atr15 = atrClose(c15, 14);
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
  let dangerHits = 0, reverseOpens = 0, reversePnl = 0; // 危险信号触发次数 / 防爆反手开单次数 / 反手单累计盈亏
  const grossPnl = (side, entry, exit, amtUsdt) => (side === 'long' ? (exit - entry) : (entry - exit)) / entry * effLev * amtUsdt;
  for (let i = lo; i < c15.length; i++) {
    const price = c15[i];
    const k = kd15.k[i], d = kd15.d[i];
    // 资金费率结算（持仓跨越 8h 整点，仅合约）
    if (!isSpot) {
      for (const p of positions.slice()) {
        while (fundIdx < fundArr.length && fundArr[fundIdx].fundingTime <= t15[i]) {
          const fr = fundArr[fundIdx]; fundIdx++;
          if (fr.fundingTime > p.openT) {
            const notional = p.amtUsdt * lev;
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
        const closeFee = p.amtUsdt * lev * feeRate;
        const gp = grossPnl(p.side, p.entry, p.liqPrice, p.amtUsdt);
        const pnl = gp - closeFee - (p.openFee || 0) - (p.openSlip || 0) + p.fundingAcc;
        const marginCoin = p.amtUsdt / p.entry;
        if (p.marginMode === 'usdt') { avail += p.amtUsdt + gp; avail -= closeFee; }
        else { coinAvail += marginCoin + (gp - closeFee) / p.liqPrice; }
        totalFee += closeFee;
        liqCount++; liqLoss += pnl;
        if (p.reverse) reversePnl += pnl;
         trades.push({ t: t15[i], side: p.side, action: 'liquidate', price: p.liqPrice, gross: gp, fee: (p.openFee || 0) + closeFee, slip: (p.openSlip || 0), funding: p.fundingAcc, pnl, bal: (p.marginMode === 'usdt' ? avail : coinAvail * p.liqPrice), k, d, liq: true, liqPrice: p.liqPrice, amt: p.amtUsdt, lev: p.lev, marginMode: p.marginMode, reverse: p.reverse });
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
      const exitSlipCost = p.amtUsdt * effLev * slip;
      const closeFee = p.amtUsdt * effLev * feeRate;
      const gp = grossPnl(p.side, p.entry, exitPrice, p.amtUsdt);
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
    const _netClose = (p, exit) => grossPnl(p.side, p.entry, exit, p.amtUsdt) - (p.openFee || 0) - p.amtUsdt * effLev * feeRate - p.amtUsdt * effLev * slipAt(i) + p.fundingAcc;
    const _tryOpen = (side, rev) => {
      if (price == null || !_canTrade) return;
      const isRev = !!rev;
      // 反手单为独立类别：不计入同向连开上限，也不受其限制
      const sameCount = positions.filter(p => p.side === side && !p.reverse).length;
      if (!isRev && sameCount >= maxSame) return;
      // #4 乘法缩放：基准% × (1 ± 合计%)；未优选/反向周期扣对应权重
      const scale = computeSizeScale(side, srsiDir, _sizeWeights, _scaleSource);
      const basePct = (isRev && config.srsiAutoReversePct > 0) ? config.srsiAutoReversePct : config.srsiAutoBasePct;
      const sizePct = basePct * scale;
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
          positions.push({ side, entry: fill, rawEntry: price, qty, amtUsdt, lev: effLev, openFee, openSlip: 0, fundingAcc: 0, openT: t15[i], src: 'srsiAuto', reverse: isRev, liqPrice: null, marginMode: 'spot' });
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
          positions.push({ side, entry: fill, rawEntry: price, qty: amtCoin, amtUsdt: proceeds, lev: effLev, openFee, openSlip: 0, fundingAcc: 0, openT: t15[i], src: 'srsiAuto', reverse: isRev, liqPrice: null, marginMode: 'spot' });
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
      const useLev = (isRev && config.srsiAutoReverseLev > 0) ? config.srsiAutoReverseLev : lev;
      const fill = side === 'short' ? price * (1 - slip) : price * (1 + slip);
      const marginCoin = amtUsdt / fill;
      const openFee = amtUsdt * useLev * feeRate;
      const openSlip = amtUsdt * useLev * slip;
      if (mm === 'usdt') { avail -= amtUsdt; avail -= openFee; }
      else { coinAvail -= marginCoin; coinAvail -= openFee / fill; }
      totalFee += openFee; totalSlip += openSlip;
      const liqPrice = liquidationPrice({ exchange: 'Binance', side, entry: fill, lev: useLev, notional: amtUsdt * useLev, symbol: sym });
      positions.push({ side, entry: fill, rawEntry: price, amtUsdt, lev: useLev, openFee, openSlip, fundingAcc: 0, openT: t15[i], src: 'srsiAuto', reverse: isRev, liqPrice, marginMode: mm });
      trades.push({ t: t15[i], side, action: 'open', price: fill, pct: sizePct, lev: useLev, amt: amtUsdt, fee: openFee, slip: openSlip, funding: 0, pnl: null, bal: (mm === 'usdt' ? avail : coinAvail * fill), k, d, liqPrice, marginMode: mm, reverse: isRev });
    };
    const _attemptOpen = (side) => {
      const danger = emaOpp2(side, klineDir);
      if (danger) dangerHits++;
      const mode = config.srsiAutoDanger;
      if (mode === 'none') return _tryOpen(side, false);
      if (mode === 'filter') { if (!danger) _tryOpen(side, false); return; }
      if (danger) { reverseOpens++; _tryOpen(side === 'long' ? 'short' : 'long', true); }
      else _tryOpen(side, false);
    };
    if (_canTrade && be.edge === 'enterUpper') {
      const lp = positions.find(p => p.side === 'long' && _netClose(p, price * (1 - slipAt(i))) > 0);
      if (lp) { const slip = slipAt(i); if (_settleClose(lp, price * (1 - slip), slip)) positions = positions.filter(p => p !== lp); }
      _attemptOpen('short');
    } else if (_canTrade && be.edge === 'enterLower') {
      const sp = positions.find(p => p.side === 'short' && _netClose(p, price * (1 + slipAt(i))) > 0);
      if (sp) { const slip = slipAt(i); if (_settleClose(sp, price * (1 + slip), slip)) positions = positions.filter(p => p !== sp); }
      _attemptOpen('long');
    }
  }
  // ---- 期末：所有未平仓按末价平仓计入（盈+亏都计），并保留明细供「净收益」栏展示 ----
  const _endOpen = [];
  for (const p of positions.slice()) {
    const price = c15[c15.length - 1]; const slip = slipAt(c15.length - 1);
    const exit = p.side === 'short' ? price * (1 + slip) : price * (1 - slip);
    const exitSlipCost = p.amtUsdt * effLev * slip;
    const closeFee = p.amtUsdt * effLev * feeRate;
    const gp = grossPnl(p.side, p.entry, exit, p.amtUsdt);
    const fee = (p.openFee || 0) + closeFee;
    const slipCost = (p.openSlip || 0) + exitSlipCost;
    const net = gp - fee - slipCost + p.fundingAcc;
    const lk = kd15.k[kd15.k.length - 1], ld = kd15.d[kd15.d.length - 1];
    const pnlPct = p.entry ? (gp / p.entry / effLev) * 100 : 0;
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
    dangerHits, reverseOpens, reversePnl, dangerMode: config.srsiAutoDanger || 'none'
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
    feePct: 0.045,           // 手续费 %（taker）
    slipPct: 0.02,           // 滑点 %
    useCost: true,           // 含交易成本
    pct: 10,                 // 开仓比例 %
    lev: 5,                  // 杠杆 x
    maxSame: 3,              // 同方向最多连开单
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
    danger: 'none',          // 危险信号防爆：none=关 / filter=预防爆仓 / reverse=防爆反手
    reversePct: 0,           // 反手单仓位%（0=继承正常开仓%）
    reverseLev: 0,           // 反手单杠杆（0=继承正常杠杆）
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
  try { localStorage.setItem(_BT_CFG_KEY, JSON.stringify(_btCfg)); } catch (e) {}
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
    srsiAutoDanger: bt.danger, srsiAutoReversePct: bt.reversePct, srsiAutoReverseLev: bt.reverseLev
  });
}
_btCfgLoad();
 let _btLastDays = 7;
 let _btFetchImpl = null; // 测试可注入桩（覆盖 fetchKlinesRange）
 export function __setBacktestFetch(fn) { _btFetchImpl = fn; }
 export function __getBtStore() { try { return JSON.parse(localStorage.getItem(_BT_KEY) || '{}'); } catch { return {}; } }
 function _btFetch(sym, tf, start, end, onP, maxBars) {
   if (_btFetchImpl) return _btFetchImpl(sym, tf, start, end, onP, maxBars);
   return fetchKlinesRange(sym, tf, start, end, onP, maxBars);
 }
function _btReadStore() { try { return JSON.parse(localStorage.getItem(_BT_KEY) || '{}'); } catch { return {}; } }
function _btWriteStore(obj) { try { localStorage.setItem(_BT_KEY, JSON.stringify(obj)); } catch {} }
function _btReadRaw(sym, days) {
  try { const raw = JSON.parse(localStorage.getItem(_BT_RAW_KEY) || '{}'); return raw[sym + '|' + days] || null; } catch { return null; }
}
function _btWriteRaw(sym, days, kl) {
  try { const raw = JSON.parse(localStorage.getItem(_BT_RAW_KEY) || '{}'); raw[sym + '|' + days] = kl; localStorage.setItem(_BT_RAW_KEY, JSON.stringify(raw)); } catch {}
}
function _btReadFund(sym, days) {
  try { const raw = JSON.parse(localStorage.getItem(_BT_FUND_KEY) || '{}'); return raw[sym + '|' + days] || null; } catch { return null; }
}
function _btWriteFund(sym, days, fr) {
  try { const raw = JSON.parse(localStorage.getItem(_BT_FUND_KEY) || '{}'); raw[sym + '|' + days] = fr; localStorage.setItem(_BT_FUND_KEY, JSON.stringify(raw)); } catch {}
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
      if (changed) localStorage.setItem(key, JSON.stringify(raw));
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
    <div class="kt-auto-row"><b>回测 ${days}天</b> · <b class="kt-bt-mode">${modeBadge}</b> · ${principalTxt} → 期末 <b class="${cls}">$${res.finalEquity.toFixed(1)}</b> (${up ? '+' : ''}${res.pnlPct.toFixed(1)}%) <span class="kt-bt-saved">(已本地保存)</span></div>
    ${isSpot ? `<div class="kt-auto-row kt-bt-spot-end">现货期末：现金 USDT <b>$${_btMoney(res.finalU)}</b> (期初 $${_btMoney(res.spotInitU)}) ｜ ${cfg.symbol}库存 <b>${res.finalC}</b> (≈$${_btMoney(res.finalC * res.finalPrice)}, 期初 ${res.spotInitC}) ｜ 期末价 $${_btMoney(res.finalPrice)}</div>` : ''}
    <div class="kt-auto-row">${_buildSparkline(res.equitySeries.map(e => e.eq))}</div>
    <div class="kt-auto-row">胜率 ${(res.winRate * 100).toFixed(0)}% (${res.wins}胜/${res.losses}负) ｜ 开多${res.longs}/开空${res.shorts} ｜ 最大回撤 ${(res.maxDD * 100).toFixed(1)}% ｜ 共 ${res.trades.length} 笔 <button id="ktBtExport" class="kt-export-btn">⬇ 导出</button></div>
    <div class="kt-auto-row kt-bt-cost">成本：手续费 <b>${_btMoney(totFee)}</b> ｜ 滑点 <b>${_btMoney(totSlip)}</b> ｜ ${fundTxt} ｜ 净收益 <b class="${cls}">${_btMoney(res.finalEquity - res.principal, true)}</b></div>
    ${(res.liqCount || 0) > 0 ? `<div class="kt-auto-row kt-bt-liq">⚠ 强平 <b>${res.liqCount}</b> 次（价格击穿强平价，保证金基本归零）｜ 爆仓净损失 <b>${_btMoney(res.liqLoss, true)}</b>${res.liqCount ? '（已并入净收益）' : ''}</div>` : ''}
    ${(res.dangerHits || 0) > 0 ? `<div class="kt-auto-row kt-bt-danger">🚨 危险信号触发 <b>${res.dangerHits}</b> 次｜防爆反手开单 <b>${res.reverseOpens || 0}</b> 笔（防爆模式：${(res.dangerMode === 'reverse' ? '防爆反手' : res.dangerMode === 'filter' ? '预防爆仓' : '关')}）｜反手盈亏 <b class="${(res.reversePnl || 0) >= 0 ? 'kt-pos' : 'kt-neg'}">${_btMoney(res.reversePnl || 0, true)}</b></div>` : ''}
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
      const lbl = m === 'filter' ? '预防爆仓（避开危险单不开仓）' : m === 'reverse' ? '防爆反手（避开危险单并反向开单）' : '关';
      const rp = (bt.reversePct > 0) ? (bt.reversePct + '%') : '（继承正常开仓%）';
      const rl = (bt.reverseLev > 0) ? (bt.reverseLev + 'x') : '（继承正常杠杆）';
      return '危险信号防爆：' + lbl + (m === 'reverse' ? ('｜反手单仓位 ' + rp + ' / 杠杆 ' + rl) : '') + '（危险判定：4h/1h/30m 的 EMA120 趋势与拟开仓方向背离≥2 个周期）';
    })(),
    '杠杆：' + lev + 'x',
    '同方向最多连开：' + bt.maxSame + ' 单',
    (function () {
      const _eb = resolveEntryBands({ srsiAutoUpper: bt.upper, srsiAutoLower: bt.lower, srsiByTf: cfg.srsiByTf, srsi: cfg.srsi });
      return '上下限带：上 ' + _eb.upper + ' / 下 ' + _eb.lower + (_eb.auto ? '（自动=15m优选带）' : '');
    })(),
    '单次开仓上限：USDT ' + (bt.capUsdt || '不限') + ' / 币 ' + (bt.capCoin || '不限'),
    '开仓下限（不触发小于此额度的开仓）：USDT ' + (bt.floorUsdt || '0（不限制）') + ' / 币 ' + (bt.floorCoin || '0（不限制）'),
    '交易成本：总开关 ' + (bt.useCost ? '开' : '关') + '｜手续费 ' + (bt.feePct * 100).toFixed(3) + '%｜滑点 ' + (bt.slipPct * 100).toFixed(3) + '%｜资金费 ' + (bt.useCost ? '计入' : '不计'),
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
      danger: bt.danger || 'none', reversePct: bt.reversePct || 0, reverseLev: bt.reverseLev || 0
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
    '## 四、机器可读数据（复制给 AI 复现）',
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
export async function runSrsiBacktest(days, opts) {
  const el = typeof document !== 'undefined' ? document.getElementById('ktSrsiBtResult') : null;
  const sym = cfg.symbol;
  const force = !!(opts && opts.force);
  let kl = force ? null : _btReadRaw(sym, days);
  const now = Date.now(), endMs = now, startMs = now - days * 24 * 3600 * 1000;
  // 多往前取一段预热（SRSI 约需 85 根 15m 才出有效 KD），但成交只在窗口内重放
  const warmupMs = 140 * 15 * 60 * 1000; // ≈35h 的 15m 预热
  const fetchStart = startMs - warmupMs;
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
    _btLastDays = days;
    const store = _btReadStore();
    store.results = store.results || {};
    store.results[sym + '|' + days + (mode === 'spot' ? '|spot' : '')] = res;
    store.lastDays = days;
    store.lastSym = sym;
    store.lastMode = mode;
    _btWriteStore(store);
    if (el) {
      el.innerHTML = _renderBacktestResult(res, days);
      const exBtn = el.querySelector('#ktBtExport');
      if (exBtn) exBtn.addEventListener('click', () => exportBacktestReport(res, days, sym, mode, startMs, endMs));
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

