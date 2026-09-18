// 独立迷你 PWA 的入口：挂载 kchart.js 渲染、轮询行情、暴露 window 钩子
// 不依赖 legacy.js / main.js，仅复用共享的 kchart.js（与主系统同一份 K线分析代码）
import '../styles.css'; // 共享样式（与主系统同一份）：Vite 会哈希化并注入 kchart.html 的 <head>
import './pwa.css';     // PWA 重构外壳样式（规则全部限定 body.pwa，主系统零影响；须在 styles.css 之后以覆盖）
import { kchartApi, loadTsevWeights, refreshLocalTsev, ktStackOffset } from '../tech2/kchart.js';
import { refreshKlines, refreshPrice, DEFAULT_TECH } from './data.js';
import { PaperEngine } from '../exchange/PaperEngine.js';
import { positionPnlPct } from '../engine/indicators.js';
import { initAlphaLab, updateAlphaSignal } from './alphaLab.js';
import { initPwaShell, refreshShell, startSignalEngine, stopSignalEngine } from './pwaShell.js';
globalThis.__pwaShell = { initPwaShell, refreshShell, startSignalEngine, stopSignalEngine };
import { APP_BUILD_TIME, APP_TAG, APP_VERSION } from '../version.generated.js';
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
globalThis.kOptimizeSrsi = (tf, role) => {
  const sym = api.getConfig().symbol;   // 调用瞬间锁定目标币对：避免慢拉数期间切币导致 sym 被捕获成当前币对
  return api.optimizeSrsiForTf(tf, role, { sym }).then(r => {
    // 优选失败(fallback 默认 best) 时不覆写：保留用户既有优选参数，避免被默认参数污染
    if (r && r.best && r.decision !== 'fallback') {
      const cw = (r.oos && r.oos.winRate != null) ? r.oos.winRate : (r.stats && r.stats.winRate != null ? r.stats.winRate : null);
      api.applyOptToSym(tf, sym, r.best, cw);   // 始终写回锁定的原币对，不污染/丢失当前展示币对
    } else if (!r || !r.best || r.decision === 'fallback') {
      console.log('[SRSI-OPT-SKIP] tf=' + tf + ' decision=' + (r && r.decision) + ' best=' + JSON.stringify(r && r.best) + '（优选未产出有效参数，保留既有参数）');
    }
    return r;
  });
};
globalThis.kApplySrsiOpt = (tf) => api.applySrsiOpt(tf);
globalThis.kClearSrsiOpt = (tf) => api.clearSrsiOpt(tf);
globalThis.kSetSrsiOptPreview = (on) => api.setSrsiOptPreview(on);
globalThis.kSetSrsiOptDeep = (on) => api.setSrsiOptDeep(on);
globalThis.kSetSrsiLead = (tf, on) => api.setSrsiLead(tf, on);
globalThis.startSignalEngine = () => globalThis.__pwaShell && globalThis.__pwaShell.startSignalEngine
  ? globalThis.__pwaShell.startSignalEngine() : null;
globalThis.kToggleOverview = () => api.toggleOverview();
globalThis.kToggleDisc = () => api.toggleKDisc();
globalThis.kToggleRuleMonitor = () => api.kToggleRuleMonitor();
globalThis.ruleMonitorClear = () => api.ruleMonitorClear();
globalThis.ruleOptimizeRun = () => api.ruleOptimizeRun();
globalThis.ruleOptimizeApply = () => api.ruleOptimizeApply();
globalThis.ruleVersionSwitch = () => api.ruleVersionSwitch();
globalThis.kToggleTradePanel = () => { try { localStorage.setItem('pwa_trade_panel_touched', '1'); } catch (e) {} api.kToggleTradePanel(); };
globalThis.kchartSetSrsiAutoMode = (mode) => api.setSrsiAutoMode(mode);
globalThis.setSigOverlay = (on) => api.setSigOverlay(on);
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

// 彻底清除所有 Service Worker 注册与全部 Cache（不遗留任何旧版本资源）
async function forceClearCaches() {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister().catch(() => {})));
    }
  } catch (e) { /* 忽略 */ }
  try {
    if (window.caches && caches.keys) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k).catch(() => {})));
    }
  } catch (e) { /* 忽略 */ }
}

// 版本戳：取构建时生成的 APP_BUILD_TIME（每次构建都唯一），供版本门控判断“是否发了新版本”
const APP_VER = APP_BUILD_TIME || 'dev';
const VER_KEY = 'kchartVer';
const FORCE_CLEAR_FLAG = 'sw_force_clear';

// 版本门控：新构建发布后首次启动自动清干净旧缓存，并确保加载的是最新资源
// （防止 SW/边缘缓存卡在旧版导致 HTML/JS 错位、按钮消失）。
// 关键修复：版本不一致时不再「只清缓存不重载」（旧 JS 仍驻留），而是带随构建唯一的 _swclear
// 参数强制重定向，绕过 Cloudflare/浏览器边缘缓存拿到最新 HTML+JS（含本修复），杜绝「部署了用户却还在跑旧包」。
async function applyVersionGate() {
  try {
    // 上一轮点「刷新」遗留的双保险标记：新页面启动再清一次，确保无残留
    if (sessionStorage.getItem(FORCE_CLEAR_FLAG)) {
      sessionStorage.removeItem(FORCE_CLEAR_FLAG);
      await forceClearCaches();
    }
    const seen = localStorage.getItem(VER_KEY);
    localStorage.setItem(VER_KEY, APP_VER); // 先记录当前版本，避免重定向后死循环
    if (seen && seen !== APP_VER && !window.location.search.includes('_swclear')) {
      // 新版本已部署：先清掉旧 SW/缓存，再带 _swclear 重定向强制拉取最新 HTML+JS
      await forceClearCaches();
      const url = new URL(window.location.href);
      url.searchParams.set('_swclear', APP_VER);
      window.location.replace(url.pathname + url.search);
      return; // 让新页面接管，下面不再执行
    }
  } catch (e) { /* 忽略 */ }
}

// PWA 页面右下角构建版本徽章：用户可直观确认自己是否在最新构建（排查「部署了却没生效」）
function showVersionBadge() {
  try {
    let b = document.getElementById('kchartVerBadge');
    if (!b) {
      b = document.createElement('div');
      b.id = 'kchartVerBadge';
      b.style.cssText = 'position:fixed;right:8px;bottom:6px;z-index:60;font:11px/1.4 monospace;color:#9aa;background:rgba(0,0,0,.45);padding:2px 6px;border-radius:6px;pointer-events:none;white-space:nowrap';
      document.body.appendChild(b);
    }
    b.textContent = `v${APP_VERSION} · ${APP_BUILD_TIME.slice(0, 10)}`;
    b.title = `构建时间 ${APP_BUILD_TIME}`;
  } catch (e) { /* 忽略 */ }
}

// 清除 PWA Service Worker 缓存并硬刷新（解决 dev/部署后旧缓存不更新）
// 双保险：重载前清一次 + 写入 sessionStorage 标记（新页面启动 applyVersionGate 再清一次）
async function clearCacheAndReload() {
  setFresh('正在刷新缓存…');
  try { sessionStorage.setItem(FORCE_CLEAR_FLAG, '1'); } catch (e) {}
  await forceClearCaches();
  // 强制绕过 SW 与浏览器/边缘 HTTP 缓存：用随构建唯一变化的 _swclear 参数生成新 URL，
  // 确保 Cloudflare/浏览器不会命中旧 HTML 缓存（每次部署 APP_BUILD_TIME 不同 → URL 必为最新）。
  const url = new URL(window.location.href);
  url.searchParams.set('_swclear', APP_VER);
  window.location.replace(url.pathname + url.search);
}

// ---- 页面缩放（＝/－，持久化）----
const ZOOM_MIN = 0.6, ZOOM_MAX = 4, ZOOM_STEP = 0.1;
let zoom = 1;   // PWA 重构：默认 100%（新外壳字号/间距已按设计稿加大，无需再放大；用户可自行 ＋/－ 调整并持久化）
function applyZoom() {
  zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom));
  if (document.body) {
    document.body.style.zoom = String(zoom);
    // PWA 固定外壳：body 高度须按缩放反算（height:calc(100vh / --pwa-z)），否则放大后视口外裁切
    document.body.style.setProperty('--pwa-z', String(zoom));
  }
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
  positionInstallBar();
  setTimeout(positionInstallBar, 400);   // Tab 栏布局完成后纠偏（首帧可能高度为 0）
  syncThumbForInstall();
}
function hideInstall() {
  const bar = document.getElementById('pwaInstall');
  if (bar) bar.hidden = true;
  positionInstallBar();
  syncThumbForInstall();
}
// PWA：安装条叠在底部栈之上（Tab 栏 + 拇指条）；安全区由 Tab 栏统一处理
// 2026-09-18：拇指条已并入文档流（在 Tab 栏之前），因此安装条要额外让出它的高度，否则会盖住拇指条
function positionInstallBar() {
  const bar = document.getElementById('pwaInstall');
  if (!bar) return;
  if (bar.hidden) { bar.style.bottom = ''; return; }
  const tab = document.getElementById('pwaTabBar');
  let h = (tab && tab.offsetHeight) || 0;
  const tb = document.getElementById('ktThumbBar');
  // 仅当拇指条处于「文档流内」（PWA 底部栈）时才计入高度；主系统的 fixed 拇指条不计
  if (tb && tb.parentElement && tb.parentElement !== document.body && tb.offsetHeight > 0 && getComputedStyle(tb).display !== 'none') h += tb.offsetHeight;
  bar.style.bottom = h + 'px';
}
// GOAL26：拇指条底部叠层偏移 = Tab条高 + 安装条可见高（与 kchart.js ktStackOffset 同一公式，此处直接复用）
// 2026-09-18：拇指条在 PWA 下已并入文档流（见 kchart.js syncThumbBar），此时不再设 bottom（否则会把它顶离底部栈）
function syncThumbForInstall() {
  const tb = document.getElementById('ktThumbBar');
  if (!tb) return;
  if (tb.parentElement && tb.parentElement !== document.body) { tb.style.bottom = 'auto'; return; }
  tb.style.bottom = ktStackOffset() + 'px';
}
// GOAL26 → PWA 重构：四页导航（rail 桌面 / tabbar 触屏）由 pwaShell.js 接管（.pwa-tab 分组，不再用 data-tab-block）。
// 保留 syncThumbForInstall 的叠层偏移（仍读 #pwaTabBar 高度，ktStackOffset 同源）。

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
  window.addEventListener('resize', positionInstallBar);
  // Safari / iOS 无该事件：给手动提示
  if (!('onbeforeinstallprompt' in window)) {
    const h = safariHint();
    if (h) showInstall(h);
  }
}

async function loadSymbol(sym) {
  sym = normalize(sym) || 'BTCUSDT';
  curSym = sym;
  try { localStorage.setItem('pwa_last_sym', sym); } catch (e) {}   // 记住真正在用的币对，供下次启动恢复
  if (symInput) symInput.value = sym;
  api.setSymbol(sym);                 // 设置 cfg.symbol 并先渲染（显示"等待数据"）
  setFresh('加载中…');
  try { await refreshKlines(sym, { onTfReady: () => api.render() }); hideSrcErr(); }
  catch (e) {
    setFresh('K线加载失败: ' + e.message);
    if (e && e.sourceUnreachable) showSrcErr(e.message);
  }
  try { await refreshPrice(sym); } catch (e) { /* 价格可选 */ }
  api.render();                       // 用实际数据重绘（含纪律面板实时价）
  // 切币对后立即（重新）计算**本币对**的 Alpha 信号：不等 60s tick，否则驾驶舱会显示上一个币对的旧值
  try {
    const kc = api.getConfig();
    if (kc.alphaSignalOn) { await updateAlphaSignal(sym, kc.mainTF, true); api.render(); }
  } catch (e) { /* 静默：信号缺失时基石区显示「正在计算」 */ }
  if (api.renderMainTools) api.renderMainTools(); // 同步主图叠加药丸的 K/D 背景色
  refreshShell();                     // PWA 外壳：实时价 / KPI / 信号驾驶舱
  localLoop.kick();                   // K线就绪后立刻触发一次本机采样（无需等 60min 周期）
  touchSym(sym);
  renderSymList();
  setFresh('已更新 ' + new Date().toLocaleTimeString());
}

async function tickPrice() {
  try { await refreshPrice(curSym); } catch (e) { /* 忽略 */ }
  api.render();                       // 内部有防抖，仅实时价刷新
  refreshShell();
  setFresh('已更新 ' + new Date().toLocaleTimeString());
}

async function tickKlines() {
  try { await refreshKlines(curSym, { onTfReady: () => api.render() }); hideSrcErr(); }
  catch (e) {
    setFresh('K线刷新失败: ' + e.message);
    if (e && e.sourceUnreachable) showSrcErr(e.message);
  }
  try { // GOAL6：主图 α 信号序列随 K 线刷新重算（开关关时不耗时）
    const kc = api.getConfig();
    if (kc.alphaSignalOn) await updateAlphaSignal(curSym, kc.mainTF);
  } catch (e) { /* 静默 */ }
  api.render();
  if (api.renderMainTools) api.renderMainTools(); // 同步主图叠加药丸的 K/D 背景色（canvas render 不重建 DOM）
  refreshShell();
}

async function init() {
  // 先执行版本门控：若部署了新版本，自动清掉旧 SW/缓存，确保下面渲染的是最新资源
  await applyVersionGate().catch(() => {});
  api.init();                         // 绑定 canvas + 事件
  api.setPwaMode(true);              // 启用 PWA 私有持久化键（srsiByTf/optSource/optPreview/srsiAuto* 按币对独立于共享 smartTrader_kchart）
  let lastSym = null;
  try { lastSym = localStorage.getItem('pwa_last_sym'); } catch (e) {}
  curSym = lastSym || symList[symList.length - 1] || 'BTCUSDT';  // 优先回到真正上次使用的币对
  api.loadCfg(curSym);                // 从 PWA 私有键(优先)+smartTrader_kchart 恢复 K线/SRSI 持久化配置（含各周期优选参数），必须在渲染与切币对之前
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
  // 设置页「通知与外观」卡用的缩放钩子（手机顶栏已隐藏缩放控件，避免窄屏被压扁）
  globalThis.pwaZoomStep = (d) => setZoom(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, +(zoom + d * ZOOM_STEP).toFixed(2))));
  globalThis.pwaZoomReset = () => setZoom(1);
  try { const z = parseFloat(localStorage.getItem('pwa_zoom')); if (z) zoom = z; } catch (e) {}
  applyZoom();
  if (symInput) symInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addSymbol(symInput.value); });
  setupInstallPrompt();
  showVersionBadge();
  renderSymList();
  initPwaShell();
  initPwaTrade();
  initLocalLoop();
  initAlphaLab();
  loadSymbol(curSym);   // 回到上次使用的币对（curSym 已含 pwa_last_sym 优先逻辑）
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
    // 迁移：旧版本自动开仓未写 src 字段 → 补齐为 'srsiAuto'（仅针对缺失项，不影响新开仓的显式 src 标识）
    [globalThis.S.pos, globalThis.S.closed].forEach(arr => {
      if (!Array.isArray(arr)) return;
      arr.forEach(p => { if (p && !p.src) p.src = 'srsiAuto'; });
    });
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
  // GOAL18-C：PAD 横屏自动展开交易面板（触屏+横屏+宽屏一次性检测）
  // PWA 重构：交易页以交易面板为主内容——首次进入默认展开（用户手动收起过则尊重其选择）
  try {
    const touched = localStorage.getItem('pwa_trade_panel_touched') === '1';
    const padLandscape = window.matchMedia && window.matchMedia('(pointer:coarse) and (orientation:landscape) and (min-width:900px)').matches;
    if (!touched || padLandscape) {
      const c = api.getConfig();
      if (c) { c.tradePanelOpen = true; if (api.__persist) api.__persist(); }
      if (api.renderControls) api.renderControls();
    }
  } catch (e) {}
  const onEl = document.getElementById('pwaTradeOn');
  // GOAL17：快捷交易开关持久化（刷新恢复用户选择）
  const savedOn = localStorage.getItem('pwa_trade_on');
  api.setTradeConfig({ on: savedOn != null ? savedOn === '1' : (!onEl || onEl.value !== '0') });
  if (onEl && savedOn != null) onEl.value = savedOn;
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
      const _r = positionPnlPct(pos, c);   // GOAL25：币本位分母=amt×entry，修复 pnl/币数 失真
      pos.pnl = _r.pnl;
      pos.pnlPct = _r.pnlPct;
      if (pos.side === 'long') pos.hi = Math.max(pos.hi || pos.entry, c);
      else pos.lo = Math.min(pos.lo || pos.entry, c);
    });
    if (api && api.checkUserTpSl && localPE) api.checkUserTpSl(localPE);
    if (api && api.renderQuickTrade) api.renderQuickTrade();
    positionInstallBar();   // 安装条位置每秒重算（首次 showInstall 时 Tab 栏可能尚未布局完 → bottom 会算成 0，被 Tab 栏盖住但 ktStackOffset 仍计其高度 → 拇指条被顶高、中间露图表）
    // 纪律/速览面板实时刷新（每秒，_discSig/_ovSig 守卫下轻量；实时价每 tick 更新）
    const wrap = document.getElementById('kchartDiscWrap');
    if (api && api.refreshPanels && wrap && !wrap.classList.contains('closed')) api.refreshPanels();
    // SRSI 自动交易：每秒按 15m KD 带状态机执行开/平仓
    if (api && api.runSrsiAutoTrade) api.runSrsiAutoTrade();
    // 自动优选引擎：定时 + 无成交双触发重优选（防参数过期）
    if (api && api.maybeAutoOpt) api.maybeAutoOpt();
    // PWA 外壳（KPI / 信号驾驶舱 / 事件流）每秒刷新
    try { refreshShell(); } catch (e) {}
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
// 清空全部 PWA 本地持久化（交易对列表 / 模拟设置 / 纸面账户 / K线参数 / 缩放 / 版本标记），用于彻底重置
globalThis.pwaClearAll = function pwaClearAll() {
  const keys = ['pwa_syms', 'pwa_sim_settings', 'pwa_paper_state', 'smartTrader_kchart', 'pwa_zoom', 'kchartVer', 'pwa_srsi_opt', 'pwa_srsi_auto', 'pwa_last_sym'];
  keys.forEach(k => { try { localStorage.removeItem(k); } catch (e) {} });
  try { sessionStorage.removeItem('sw_force_clear'); } catch (e) {}
  if (confirm('确定清空所有本地设置并刷新？此操作不可撤销。')) {
    location.reload(true);
  }
};
globalThis.pwaTradeOn = function pwaTradeOn(v) { try { localStorage.setItem('pwa_trade_on', v); } catch (e) {} api.setTradeConfig({ on: v === '1' }); }; // GOAL17

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}
