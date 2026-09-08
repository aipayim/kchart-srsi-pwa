// 独立迷你 PWA 的入口：挂载 kchart.js 渲染、轮询行情、暴露 window 钩子
// 不依赖 legacy.js / main.js，仅复用共享的 kchart.js（与主系统同一份 K线分析代码）
import '../styles.css'; // 共享样式（与主系统同一份）：Vite 会哈希化并注入 kchart.html 的 <head>
import { kchartApi, loadTsevWeights, refreshLocalTsev } from '../tech2/kchart.js';
import { refreshKlines, refreshPrice, DEFAULT_TECH } from './data.js';
import { PaperEngine } from '../exchange/PaperEngine.js';
import * as localLoop from './localLoop.js';

// 开发模式下自动注销残留 Service Worker（dev SW 缓存会导致浏览器长期跑旧代码，Ctrl+Shift+R 不清 SW 缓存）。
// 生产构建不执行，不影响已安装 PWA。
if (import.meta.env.DEV && 'serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((regs) => {
    regs.forEach((r) => { try { r.unregister(); } catch (e) {} });
  });
}

// 与主系统默认 techConfig 对齐（ais 全开），保证 RSI/MACD/SRSI 参数一致
globalThis.techConfig = { ...DEFAULT_TECH };

// ---- 全局状态（与 main 系统 S 同形状，供 kchart.js 读取）----
globalThis.S = {
  klines: {}, klinesO: {}, klinesH: {}, klinesL: {}, klinesV: {}, klinesT: {},
  indicators: {}, prices: {}, sel: null,
  subs: [], pos: [], closed: [], realized: 0
};
// ---- PWA 本地交易对列表（独立于主系统的 smartTrader_syms，存 localStorage 跨刷新保留）----
const SYM_KEY = 'pwa_syms';
function loadSymList() {
  try {
    const raw = localStorage.getItem(SYM_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length) return arr.map(normalize).filter(Boolean);
    }
  } catch (e) {}
  return ['BTCUSDT'];
}
function saveSymList() {
  try { localStorage.setItem(SYM_KEY, JSON.stringify(symList)); } catch (e) {}
}
let symList = loadSymList();
globalThis.SYMS = symList;   // 调试用
globalThis.addPSymbol = (s) => addSymbol(s);
globalThis.removePSymbol = (s) => removeSymbol(s);

// 本地交易对列表管理：添加/删除/渲染（持久化在 localStorage['pwa_syms']）
function renderSymList() {
  const box = document.getElementById('symList');
  if (!box) return;
  box.innerHTML = '';
  for (const sym of symList) {
    const chip = document.createElement('span');
    chip.className = 'pwa-sym-chip' + (sym === curSym ? ' active' : '');
    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'pwa-sym-name';
    name.textContent = sym;
    name.addEventListener('click', () => loadSymbol(sym));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'pwa-sym-del';
    del.textContent = '×';
    del.title = '删除 ' + sym;
    del.addEventListener('click', (e) => { e.stopPropagation(); removeSymbol(sym); });
    chip.appendChild(name);
    chip.appendChild(del);
    box.appendChild(chip);
  }
}
function addSymbol(raw) {
  const sym = normalize(raw);
  if (!sym) return;
  if (!symList.includes(sym)) { symList.push(sym); saveSymList(); renderPwaSimCoins(); }
  loadSymbol(sym);   // 切换并刷新；内部会 touchSym + renderSymList
}
function removeSymbol(sym) {
  const i = symList.indexOf(sym);
  if (i < 0) return;
  // 删币前先平掉该币所有模拟仓（自动平，仅在引擎存在且有持仓时执行）
  if (localPE && globalThis.S.pos && globalThis.S.pos.length) {
    globalThis.S.pos.filter(p => p.sym === sym).slice().forEach(p => localPE.exitPosition(p, { reason: '删除交易对自动平仓' }));
  }
  symList.splice(i, 1);
  if (symList.length === 0) { symList.length = 0; symList.push('BTCUSDT'); }  // 原地修改，保持 globalThis.SYMS 引用不失效
  saveSymList();
  // 清理该币币本位库存（仅载入后可设置）
  if (pwaSim.coin) { delete pwaSim.coin[sym]; savePwaSim(); if (localPE) localPE.updateSim(pwaSim); }
  renderSymList();
  renderPwaSimCoins();
  if (curSym === sym) loadSymbol(symList[0]);
}
// 将最近使用的币对移到列表末尾，使 init 重载时回到上次使用的币
function touchSym(sym) {
  const i = symList.indexOf(sym);
  if (i >= 0 && i !== symList.length - 1) { symList.splice(i, 1); symList.push(sym); saveSymList(); }
}

// 暴露 kchart.js 内部需要、但由内联 HTML handler 调用的 window 钩子
const api = kchartApi;
globalThis.setKSymbol = (s) => api.setSymbol(s);
globalThis.setKPreset = (n) => api.setKPreset(n);
globalThis.setKBars = (v) => api.setBars(v);
globalThis.setKShow = (k, on) => api.setShow(k, on);
globalThis.setKSrsi = (name, v) => api.setSrsi(name, v);
globalThis.kResetSrsi = () => api.resetSrsi();
globalThis.kSetSrsiTf = (tf) => api.setSrsiTf(tf);
globalThis.kSetSrsiAux = (tf, on) => api.setSrsiAux(tf, on);
globalThis.kSetGateTarget = (tf) => api.setGateTarget(tf);
globalThis.kSetMainOverlay = (on) => api.setMainOverlay(on);
globalThis.kSetMainOverlayTf = (tf, on) => api.setMainOverlayTf(tf, on);
globalThis.kCopyCfgToAll = () => api.copyCfgToAll();
globalThis.kResetSymbolCfg = () => api.resetSymbolCfg();
globalThis.kOptimizeSrsi = (tf, role) => api.optimizeSrsiForTf(tf, role);
globalThis.kApplySrsiOpt = (tf) => api.applySrsiOpt(tf);
globalThis.kClearSrsiOpt = (tf) => api.clearSrsiOpt(tf);
globalThis.kSetSrsiOptPreview = (on) => api.setSrsiOptPreview(on);
globalThis.kSetSrsiOptDeep = (on) => api.setSrsiOptDeep(on);
globalThis.kToggleOverview = () => api.toggleOverview();
globalThis.kToggleDisc = () => api.toggleKDisc();
globalThis.setDiscEvidence = (v) => api.setDiscEvidence(v);

let curSym = 'BTCUSDT';
const PRICE_REFRESH_MS = 5000;   // 行情/实时价刷新
const KLINE_REFRESH_MS = 60000;  // K线周期回填（与主系统一致）

function normalize(s) { return (s || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, ''); }

const symInput = typeof document !== 'undefined' ? document.getElementById('symInput') : null;
const symBtn = typeof document !== 'undefined' ? document.getElementById('symBtn') : null;
const freshEl = typeof document !== 'undefined' ? document.getElementById('kchartFresh') : null;

function setFresh(t) { if (freshEl) freshEl.textContent = t; }

// 数据源不可达提示条（所有端点失败/被墙时显示，避免用户误以为系统坏了）
function showSrcErr(msg) {
  const bar = document.getElementById('pwaSrcErr');
  const txt = document.getElementById('pwaSrcErrTxt');
  if (!bar || !txt) return;
  txt.innerHTML = '⚠ 数据源不可达：' + (msg || '无法连接 Binance 行情服务器') +
    '。请检查网络，或本地网络对该域名受限（可设 <b>window.KCHART_BINANCE_API</b> 指向可用镜像后刷新）。';
  bar.hidden = false;
}
function hideSrcErr() {
  const bar = document.getElementById('pwaSrcErr');
  if (bar) bar.hidden = true;
}

// 清除 PWA Service Worker 缓存并硬刷新（解决 dev/部署后旧缓存不更新）
async function clearCacheAndReload() {
  setFresh('正在刷新缓存…');
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const r of regs) { try { await r.unregister(); } catch (e) {} }
    }
    if (window.caches) {
      const keys = await caches.keys();
      for (const k of keys) { try { await caches.delete(k); } catch (e) {} }
    }
  } catch (e) { /* 忽略 */ }
  // 强制绕过 SW 与浏览器 HTTP 磁盘缓存：用带时间戳的新 URL 重新加载（SPA fallback 仍返回 kchart.html）
  const url = new URL(window.location.href);
  url.searchParams.set('_swclear', String(Date.now()));
  window.location.replace(url.toString());
}

// ---- 页面缩放（＝/－，持久化）----
const ZOOM_MIN = 0.6, ZOOM_MAX = 4, ZOOM_STEP = 0.1;
let zoom = 1.25;   // 默认放大到 125%，让画布内悬浮文字/指标文字在手机上更易读
function applyZoom() {
  zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom));
  if (document.body) document.body.style.zoom = String(zoom);
  const lbl = document.getElementById('pwaZoomLbl');
  if (lbl) lbl.textContent = Math.round(zoom * 100) + '%';
}
function setZoom(v) { zoom = v; try { localStorage.setItem('pwa_zoom', String(zoom)); } catch (e) {} applyZoom(); }

// ---- PWA 安装提示（底部条）----
let deferredPrompt = null;
const PWA_DISMISS_KEY = 'pwa_install_dismissed';

function isStandalone() {
  return (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches) ||
         window.navigator.standalone === true;
}
function safariHint() {
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod/.test(ua)) return '📲 iOS：用 Safari 打开 → 分享 → <b>添加到主屏幕</b>';
  if (/Macintosh/.test(ua) && /Safari/.test(ua) && !/Chrome|Chromium|Edge|CriOS|FxiOS/.test(ua)) return '🖥️ macOS：Safari 分享 → <b>添加到程序坞</b>';
  return null;
}
function showInstall(text) {
  const bar = document.getElementById('pwaInstall');
  const txt = document.getElementById('pwaInstallTxt');
  if (!bar || !txt) return;
  txt.innerHTML = text;
  bar.hidden = false;
}
function hideInstall() {
  const bar = document.getElementById('pwaInstall');
  if (bar) bar.hidden = true;
}
function setupInstallPrompt() {
  if (isStandalone()) return;                                   // 已作为 PWA 打开，不提示
  try { if (localStorage.getItem(PWA_DISMISS_KEY) === '1') return; } catch (e) {}
  const btn = document.getElementById('pwaInstallBtn');
  const close = document.getElementById('pwaInstallClose');
  if (close) close.addEventListener('click', () => {
    hideInstall();
    try { localStorage.setItem(PWA_DISMISS_KEY, '1'); } catch (e) {}
  });
  if (btn) btn.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    try { deferredPrompt.prompt(); await deferredPrompt.userChoice; } catch (e) {}
    deferredPrompt = null;
    hideInstall();
  });
  // 标准路径：浏览器原生可安装事件（Chrome/Edge 桌面与安卓均触发）
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    showInstall('📲 把本页安装到<b>主屏 / 桌面</b>，像 App 一样离线打开 K线分析');
  });
  window.addEventListener('appinstalled', () => hideInstall());
  // Safari / iOS 无该事件：给手动提示
  if (!('onbeforeinstallprompt' in window)) {
    const h = safariHint();
    if (h) showInstall(h);
  }
}

async function loadSymbol(sym) {
  sym = normalize(sym) || 'BTCUSDT';
  curSym = sym;
  if (symInput) symInput.value = sym;
  api.setSymbol(sym);                 // 设置 cfg.symbol 并先渲染（显示"等待数据"）
  setFresh('加载中…');
  try { await refreshKlines(sym); hideSrcErr(); }
  catch (e) {
    setFresh('K线加载失败: ' + e.message);
    if (e && e.sourceUnreachable) showSrcErr(e.message);
  }
  try { await refreshPrice(sym); } catch (e) { /* 价格可选 */ }
  api.render();                       // 用实际数据重绘（含纪律面板实时价）
  localLoop.kick();                   // K线就绪后立刻触发一次本机采样（无需等 60min 周期）
  touchSym(sym);
  renderSymList();
  setFresh('已更新 ' + new Date().toLocaleTimeString());
}

async function tickPrice() {
  try { await refreshPrice(curSym); } catch (e) { /* 忽略 */ }
  api.render();                       // 内部有防抖，仅实时价刷新
  setFresh('已更新 ' + new Date().toLocaleTimeString());
}

async function tickKlines() {
  try { await refreshKlines(curSym); hideSrcErr(); }
  catch (e) {
    setFresh('K线刷新失败: ' + e.message);
    if (e && e.sourceUnreachable) showSrcErr(e.message);
  }
  api.render();
}

function init() {
  api.init();                         // 绑定 canvas + 事件
  api.renderControls();               // 渲染 TF 按钮/预设/子图/SRSI 参数
  if (symBtn) symBtn.addEventListener('click', () => addSymbol(symInput.value));
  const refreshBtn = document.getElementById('pwaRefreshBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', clearCacheAndReload);
  const srcErrBtn = document.getElementById('pwaSrcErrBtn');
  if (srcErrBtn) srcErrBtn.addEventListener('click', () => { hideSrcErr(); loadSymbol(curSym); });
  const srcErrClose = document.getElementById('pwaSrcErrClose');
  if (srcErrClose) srcErrClose.addEventListener('click', hideSrcErr);
  const zoomIn = document.getElementById('pwaZoomIn');
  const zoomOut = document.getElementById('pwaZoomOut');
  const zoomLbl = document.getElementById('pwaZoomLbl');
  if (zoomIn) zoomIn.addEventListener('click', () => setZoom(Math.min(ZOOM_MAX, +(zoom + ZOOM_STEP).toFixed(2))));
  if (zoomOut) zoomOut.addEventListener('click', () => setZoom(Math.max(ZOOM_MIN, +(zoom - ZOOM_STEP).toFixed(2))));
  if (zoomLbl) zoomLbl.addEventListener('click', () => setZoom(1));
  try { const z = parseFloat(localStorage.getItem('pwa_zoom')); if (z) zoom = z; } catch (e) {}
  applyZoom();
  if (symInput) symInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addSymbol(symInput.value); });
  setupInstallPrompt();
  renderSymList();
  initPwaTrade();
  initLocalLoop();
  loadSymbol(symList[symList.length - 1] || 'BTCUSDT');   // 回到上次使用的币对
  setInterval(tickPrice, PRICE_REFRESH_MS);
  setInterval(tickKlines, KLINE_REFRESH_MS);
}

// ---- 本机 TSEV 训练 loop（PWA 打开期间每 60min 累积样本并本地训练，权重本机优先合并）----
function initLocalLoop() {
  localLoop.register();                       // 注册到 globalThis.__localTsev，供 kchart.js 读取本机权重
  localLoop.setSymbolProvider(() => curSym);  // 用当前交易对采样
  localLoop.setSymbolListProvider(() => symList); // 首次回补覆盖全部可选币
  localLoop.onTrained(() => { try { refreshLocalTsev().finally(() => api.render()); } catch (e) { try { api.render(); } catch {} } }); // 训练完刷新本机权重并触发面板重绘（实时显示新样本/权重源，不重新拉取全局权重）
  localLoop.onProgress(() => { try { api.render(); } catch (e) {} }); // 回补进度实时刷新面板
  localLoop.init().then(() => {
    localLoop.setEnabled(true);               // 默认开启；用户可在设置关闭以省流量
    localLoop.start();
    try { refreshLocalTsev().finally(() => api.render()); } catch (e) {}
    // 首次回补：对全部可选币拉取最近 4 年历史(4h粒度)，离线训练本机权重（分块异步，不冻屏）
    if ((symList || []).length) localLoop.backfillAll(symList.slice(), 4).catch(() => {});
  }).catch(() => {});
  globalThis.setKLocalLoop = (v) => localLoop.setEnabled(!!v);  // 供 UI 开关调用
}

// ===================== PWA 本地纸面交易引擎（模拟真实交易）=====================
const PWA_SIM_KEY = 'pwa_sim_settings';
const PWA_PAPER_KEY = 'pwa_paper_state';
let pwaSim = loadPwaSim();
let localPE = null;

function loadPwaSim() {
  try {
    const raw = localStorage.getItem(PWA_SIM_KEY);
    if (raw) { const o = JSON.parse(raw); if (o && o.spotUsdt != null) return o; }
  } catch (e) {}
  return { spotUsdt: 5000, perpUsdt: 5000, coin: {} };
}
function savePwaSim() { try { localStorage.setItem(PWA_SIM_KEY, JSON.stringify(pwaSim)); } catch (e) {} }

function loadPwaPaper() {
  try {
    const raw = localStorage.getItem(PWA_PAPER_KEY);
    if (raw) {
      const o = JSON.parse(raw);
      if (o && o.subs) {
        globalThis.S.subs = o.subs;
        globalThis.S.pos = o.pos || [];
        globalThis.S.closed = o.closed || [];
        globalThis.S.realized = o.realized || 0;
      }
    }
  } catch (e) {}
}
function savePwaPaper() {
  try {
    localStorage.setItem(PWA_PAPER_KEY, JSON.stringify({
      subs: globalThis.S.subs || [], pos: globalThis.S.pos || [],
      closed: globalThis.S.closed || [], realized: globalThis.S.realized || 0
    }));
  } catch (e) {}
}

function initPwaTrade() {
  if (!globalThis.S.subs) globalThis.S.subs = [];
  if (!globalThis.S.pos) globalThis.S.pos = [];
  if (!globalThis.S.closed) globalThis.S.closed = [];
  if (globalThis.S.realized == null) globalThis.S.realized = 0;
  loadPwaPaper();
  localPE = new PaperEngine({ stateRef: () => globalThis.S, onLog: () => {}, getSlip: () => 0.0002 });
  localPE.seedSim(pwaSim);
  api.setTradeEngine(localPE);
  const onEl = document.getElementById('pwaTradeOn');
  api.setTradeConfig({ on: !onEl || onEl.value !== '0' });
  renderPwaSimCoins();
  setInterval(savePwaPaper, 5000);
  document.addEventListener('visibilitychange', () => { if (document.hidden) savePwaPaper(); });
  // PWA 无全局 tick：每秒刷新持仓浮盈浮亏并刷新交易条
  setInterval(() => {
    const S = globalThis.S;
    if (!S) return;
    if (S.pos && S.pos.length) S.pos.forEach(pos => {
      const c = (S.prices[pos.sym] || {}).last;
      if (!c) return;
      pos.pnl = pos.side === 'long' ? (c - pos.entry) * pos.qty : (pos.entry - c) * pos.qty;
      pos.pnlPct = pos.amt ? (pos.pnl / pos.amt) * 100 : 0;
      if (pos.side === 'long') pos.hi = Math.max(pos.hi || pos.entry, c);
      else pos.lo = Math.min(pos.lo || pos.entry, c);
    });
    if (api && api.checkUserTpSl && localPE) api.checkUserTpSl(localPE);
    if (api && api.renderQuickTrade) api.renderQuickTrade();
    // 纪律/速览面板实时刷新（每秒，_discSig/_ovSig 守卫下轻量；实时价每 tick 更新）
    const wrap = document.getElementById('kchartDiscWrap');
    if (api && api.refreshPanels && wrap && !wrap.classList.contains('closed')) api.refreshPanels();
  }, 1000);
  savePwaPaper();
}

function renderPwaSimCoins() {
  const box = document.getElementById('pwaSimCoins');
  if (!box) return;
  box.innerHTML = '';
  symList.forEach((sym) => {
    const w = document.createElement('div'); w.className = 'sim-coin-row';
    const l = document.createElement('label'); l.textContent = sym; l.style.flex = '0 0 96px';
    const i = document.createElement('input'); i.type = 'number'; i.min = '0'; i.step = 'any';
    i.value = (pwaSim.coin[sym] != null ? pwaSim.coin[sym] : 0);
    i.addEventListener('input', () => { pwaSim.coin[sym] = parseFloat(i.value) || 0; savePwaSim(); if (localPE) localPE.updateSim(pwaSim); });
    w.appendChild(l); w.appendChild(i); box.appendChild(w);
  });
}

globalThis.pwaSimChange = function pwaSimChange() {
  const e1 = document.getElementById('pwaSimSpot'); if (e1) pwaSim.spotUsdt = parseFloat(e1.value) || 0;
  const e2 = document.getElementById('pwaSimPerp'); if (e2) pwaSim.perpUsdt = parseFloat(e2.value) || 0;
  savePwaSim();
  if (localPE) localPE.resetSim(pwaSim);
  savePwaPaper();
};
globalThis.pwaSimReset = function pwaSimReset() {
  pwaSim = { spotUsdt: 5000, perpUsdt: 5000, coin: {} };
  savePwaSim();
  if (localPE) localPE.resetSim(pwaSim);
  renderPwaSimCoins();
  savePwaPaper();
};
globalThis.pwaTradeOn = function pwaTradeOn(v) { api.setTradeConfig({ on: v === '1' }); };

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}
