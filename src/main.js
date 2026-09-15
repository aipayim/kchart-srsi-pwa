// 开发模式下自动注销残留 Service Worker（WSL dev 无文件监听 + dev SW 缓存会导致浏览器长期跑旧代码，
// 且 Ctrl+Shift+R 不清 SW 缓存）。生产构建（import.meta.env.PROD）不执行，不影响已安装 PWA。
if (import.meta.env.DEV && 'serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((regs) => {
    regs.forEach((r) => { try { r.unregister(); } catch (e) {} });
  });
}

import { initApp } from './legacy.js';
import * as store from './persistence/eventStore.js';
import { initLedger } from './persistence/ledger.js';
import { PaperEngine } from './exchange/PaperEngine.js';
import { restoreState, startSnapshotLoop, exportAll, importAll, wipeAll } from './persistence/backup.js';
import { saveApiKey, getApiKey, hasApiKey, getRealMode, clearApiKey } from './auth/apiKeyStore.js';
import { TestnetAdapter } from './exchange/adapters/TestnetAdapter.js';
import { Reconciler } from './exchange/reconciler.js';
import * as db from './persistence/indexdb.js';
import { initTechCanvas, renderTechCanvas, __getSubRegions } from './tech/techChart.js';
import { kchartApi, loadTsevWeights, refreshLocalTsev, setTsevEnabled } from './tech2/kchart.js';
import * as kchartLocalLoop from './pwa/localLoop.js';
import { renderTech, updateTechPanel, toggleTechIndicator, toggleTechAis, setTechSymbol, toggleTimeframe, setPrimaryTF, setPlanDir, setPlanRisk, setPlanLev, setPlanVisible, setTechSignalSource, setTechMinVotes, setTechConfirm, toggleCfgVisible, setSrsiEnable, setSrsiRsiPeriod, setSrsiStochPeriod, setSrsiSmoothK, setSrsiSmoothD, setSrsiOverbought, setSrsiOversold } from './tech/techPanel.js';

window.__renderTech = () => { initTechCanvas(); renderTech(); };
window.__renderTechCanvas = () => { renderTechCanvas(); };
window.__initTechCanvas = () => { initTechCanvas(); };
window.__updateTechPanel = () => { updateTechPanel(); };
window.__getSubRegions = () => __getSubRegions();
window.toggleTechIndicator = (k, on) => toggleTechIndicator(k, on);
window.toggleTechAis = (k) => toggleTechAis(k);
window.setTechSymbol = (sym) => setTechSymbol(sym);
window.toggleTimeframe = (tf, on) => toggleTimeframe(tf, on);
window.setPrimaryTF = (tf) => setPrimaryTF(tf);
window.setPlanDir = (d) => setPlanDir(d);
window.setPlanRisk = (v) => setPlanRisk(v);
window.setPlanLev = (v) => setPlanLev(v);
window.setPlanVisible = (v) => setPlanVisible(v);
window.toggleCfgVisible = () => toggleCfgVisible();
window.setTechSignalSource = (k) => setTechSignalSource(k);
window.setTechMinVotes = (v) => setTechMinVotes(v);
window.setTechConfirm = (v) => setTechConfirm(v);
window.setSrsiEnable = (v) => setSrsiEnable(v);
window.setSrsiRsiPeriod = (v) => setSrsiRsiPeriod(v);
window.setSrsiStochPeriod = (v) => setSrsiStochPeriod(v);
window.setSrsiSmoothK = (v) => setSrsiSmoothK(v);
window.setSrsiSmoothD = (v) => setSrsiSmoothD(v);
window.setSrsiOverbought = (v) => setSrsiOverbought(v);
window.setSrsiOversold = (v) => setSrsiOversold(v);

// ---- K线分析 页面 ----
// 主程序接入与 PWA 相同的「本机 TSEV 自学习 loop」：各设备用自己 IndexedDB 自训，与主程序共享同一套 kchart.js。
let _kchartLoopInited = false;
function safeRenderK() { try { if (typeof kchartApi.render === 'function') kchartApi.render(); } catch (e) {} }
function initKchartLocalLoop() {
  if (_kchartLoopInited) return;
  _kchartLoopInited = true;
  try {
    kchartLocalLoop.register();
    kchartLocalLoop.setSymbolProvider(() => (window.S && window.S.sel) || (window.SYMS && window.SYMS[0]) || 'BTCUSDT');
    kchartLocalLoop.setSymbolListProvider(() => (window.SYMS && window.SYMS.slice) ? window.SYMS.slice() : ['BTCUSDT']);
    kchartLocalLoop.onTrained(() => { try { refreshLocalTsev().finally(safeRenderK); } catch (e) { safeRenderK(); } });
    kchartLocalLoop.onProgress(safeRenderK);
    const tsevOn = !(window.S && window.S.kchartTsevOn === false);
    setTsevEnabled(tsevOn);
    loadTsevWeights().catch(() => {});
    kchartLocalLoop.init().then(() => {
      kchartLocalLoop.setEnabled(tsevOn);
      kchartLocalLoop.start();
      try { refreshLocalTsev().finally(safeRenderK); } catch (e) {}
      const syms = (window.SYMS && window.SYMS.slice) ? window.SYMS.slice() : ['BTCUSDT'];
      if (syms.length) kchartLocalLoop.backfillAll(syms, 4).catch(() => {});
    }).catch(() => {});
    window.setKLocalLoop = (v) => kchartLocalLoop.setEnabled(!!v);
    window.setTsevEnabled = (v) => setTsevEnabled(!!v);
    window.refreshLocalTsev = (...a) => refreshLocalTsev(...a);
  } catch (e) { /* 无 IDB 环境忽略 */ }
}
window.__initKChart = () => { kchartApi.loadCfg((typeof S !== 'undefined' && S.sel) || undefined); kchartApi.renderControls(); kchartApi.init(); initKchartLocalLoop(); };
window.__renderKChart = () => { kchartApi.loadCfg((typeof S !== 'undefined' && S.sel) || undefined); kchartApi.renderControls(); kchartApi.init(); initKchartLocalLoop(); };
window.__renderKControls = () => kchartApi.renderControls();
window.setKSymbol = (sym) => kchartApi.setSymbol(sym);
window.setKMainTF = (tf) => kchartApi.setMainTF(tf);
window.setKKlineSel = (tf, on) => kchartApi.setKlineSel(tf, on);
window.setKPreset = (p) => kchartApi.setKPreset(p);
window.setKOverview = (v) => kchartApi.setKOverview(v);
window.kToggleOverview = () => kchartApi.toggleOverview();
window.setKDisc = (v) => kchartApi.setKDisc(v);
window.kToggleDisc = () => kchartApi.toggleKDisc();
window.kToggleTradePanel = () => kchartApi.kToggleTradePanel();
window.setSigOverlay = (on) => kchartApi.setSigOverlay(on);
window.setDiscEvidence = (v) => kchartApi.setDiscEvidence(v);
window.setKBars = (v) => kchartApi.setBars(v);
window.setKShow = (key, on) => kchartApi.setShow(key, on);
window.setKSrsi = (name, v) => kchartApi.setSrsi(name, v);
window.kResetSrsi = () => kchartApi.resetSrsi();
window.kSetSrsiTf = (tf) => kchartApi.setSrsiTf(tf);
window.kSetSrsiAux = (tf, on) => kchartApi.setSrsiAux(tf, on);
window.kSetGateTarget = (tf) => kchartApi.setGateTarget(tf);
window.kSetMainOverlay = (on) => kchartApi.setMainOverlay(on);
window.kSetMainOverlayTf = (tf, on) => kchartApi.setMainOverlayTf(tf, on);
window.kCopyCfgToAll = () => kchartApi.copyCfgToAll();
window.kResetSymbolCfg = () => kchartApi.resetSymbolCfg();
window.kOptimizeSrsi = (tf, role) => {
  const sym = kchartApi.getConfig().symbol;   // 调用瞬间锁定目标币对：避免慢拉数期间切币导致 sym 被捕获成当前币对
  return kchartApi.optimizeSrsiForTf(tf, role, { sym }).then(r => {
    if (r && r.best) {
      const cw = (r.oos && r.oos.winRate != null) ? r.oos.winRate : (r.stats && r.stats.winRate != null ? r.stats.winRate : null);
      kchartApi.applyOptToSym(tf, sym, r.best, cw);   // 始终写回锁定的原币对，不污染/丢失当前展示币对
    }
    return r;
  });
};
window.kApplySrsiOpt = (tf) => kchartApi.applySrsiOpt(tf);
window.kClearSrsiOpt = (tf) => kchartApi.clearSrsiOpt(tf);
window.kSetSrsiOptPreview = (on) => kchartApi.setSrsiOptPreview(on);
window.kSetSrsiOptDeep = (on) => kchartApi.setSrsiOptDeep(on);
window.kConfig = () => kchartApi.getConfig();
window.__debugKChart = () => kchartApi.debug();

window.__eventSink = (ev) => store.appendEvent(ev);
initLedger();

window.paperEngine = new PaperEngine({
  stateRef: () => window.S,
  onLog: (tag, msg) => window.log(tag, msg),
  getSlip: () => parseFloat(document.getElementById('setSlipProtect')?.value || 0.0002)
});
window.paperEngine.onOrder((ev) => {
  store.appendEvent({ type: ev.event === 'closed' ? 'trade' : 'order', tag: ev.event, msg: orderMsg(ev) });
});
window.paperEngine.onFunding((ev) => {
  store.appendEvent({ type: 'funding', tag: 'funding', msg: `[资金] ${ev.symbol.replace('USDT','')} ${ev.side==='long'?'多':'空'} 费率${(ev.rate*100).toFixed(4)}% ${ev.payment>=0?'收':'付'}$${Math.abs(ev.payment).toFixed(4)}` });
});
window.paperEngine.onLiquidation((ev) => {
  store.appendEvent({ type: 'liquidation', tag: 'risk', msg: `[强平] ${ev.symbol.replace('USDT','')} ${ev.side==='long'?'多':'空'} 强平价$${ev.liqPrice.toFixed(2)} 盈亏$${ev.pnl.toFixed(2)}` });
});

window.doBackup = () => exportAll();
window.doRestore = async () => {
  const fileInput = document.getElementById('restoreFile');
  if (!fileInput || !fileInput.files || !fileInput.files[0]) return;
  try {
    await importAll(fileInput.files[0]);
    alert('恢复成功，正在刷新页面...');
    location.reload();
  } catch (e) {
    alert('恢复失败: ' + e.message);
  }
};
window.doWipe = async () => {
  if (!confirm('确定清空全部本地数据（状态+账本+K线）？此操作不可恢复！建议先备份。')) return;
  await wipeAll();
  location.reload();
};

// ---- 交易所接入 / 真实资金硬锁 ----
window.saveApiSetting = async (exchange) => {
  const id = (x) => document.getElementById(x);
  if (exchange === 'Binance') {
    const key = id('binApiKey')?.value?.trim() || '';
    const secret = id('binSecret')?.value?.trim() || '';
    if (!key || !secret) { window.log('risk', '[接入] Binance Key 和 Secret 不能为空'); return; }
    await saveApiKey({ exchange: 'Binance', apiKey: key, secret });
  } else {
    const key = id('okxApiKey')?.value?.trim() || '';
    const secret = id('okxSecret')?.value?.trim() || '';
    const pass = id('okxPass')?.value?.trim() || '';
    if (!key || !secret) { window.log('risk', '[接入] OKX Key 和 Secret 不能为空'); return; }
    await saveApiKey({ exchange: 'OKX', apiKey: key, secret, passphrase: pass || undefined });
  }
  refreshApiStatus();
  window.log('sys', `[接入] ${exchange} 测试网 API Key 已加密保存（真实资金仍为硬锁）`);
};
window.__renderSettings = () => { refreshApiStatus(); if (window.refreshLLMKeyStatus) window.refreshLLMKeyStatus(); };

// ---- LLM 接入: API Key 加密存储 (exchange='LLM') ----
// 注意: window.saveLLMKey 由 legacy.js exposeGlobals 提供(读取 DOM -> __saveLLMKey)
// 勿在此处重定义, 否则会覆盖 DOM 读取逻辑
window.__saveLLMKey = async (key) => {
  await saveApiKey({ exchange: 'LLM', apiKey: key || '', secret: '' });
  return true;
};
window.__getLLMKey = async () => getApiKey('LLM');
window.__saveOnChainKey = async (key) => {
  await saveApiKey({ exchange: 'OnChain', apiKey: key || '', secret: '' });
  return true;
};
window.__getOnChainKey = async () => getApiKey('OnChain');

window.runReconciliation = async () => {
  const bin = await getApiKey('Binance');
  const okx = await getApiKey('OKX');
  if (!bin && !okx) { window.log('risk', '[对账] 请先在设置页配置至少一个交易所测试网 API Key'); return; }
  let pass = true;
  let detail = '';
  for (const ex of ['Binance', 'OKX']) {
    const cred = ex === 'Binance' ? bin : okx;
    if (!cred) continue;
    const adapter = new TestnetAdapter({ exchange: ex, apiKey: cred.apiKey, secret: cred.secret, onLog: window.log });
    await adapter.connect();
    const rc = new Reconciler({ paper: window.paperEngine, testnet: adapter, onReport: (r) => { db.add('reconcile', { ...r, ts: r.ts || Date.now() }).catch(() => {}); } });
    try {
      const report = await rc.reconcileOrder({ symbol: 'BTCUSDT', side: 'long', type: 'MARKET', lev: 1, amt: 5 });
      if (!report.pass) { pass = false; detail += ex + ':' + report.diffs.map(d => d.field).join(',') + ' '; }
    } catch (e) {
      pass = false; detail += ex + ':error ';
    }
  }
  window.log(pass ? 'sys' : 'risk', `[对账] ${pass ? '全部通过 ✓' : '存在差异 ' + detail}（真实资金保持硬锁）`);
  refreshApiStatus();
};

async function refreshApiStatus() {
  const set = (id, text, color) => { const el = document.getElementById(id); if (el) { el.textContent = text; el.style.color = color; } };
  set('binStatus', (await hasApiKey('Binance')) ? '已配置 (加密)' : '未配置', (await hasApiKey('Binance')) ? 'var(--green)' : 'var(--text2)');
  set('okxStatus', (await hasApiKey('OKX')) ? '已配置 (加密)' : '未配置', (await hasApiKey('OKX')) ? 'var(--green)' : 'var(--text2)');
  const mode = await getRealMode();
  const labels = { locked: ['硬锁 (locked)', 'var(--red)'], armed: ['对账通过 (armed)', 'var(--gold)'], live: ['真实资金 (live)', 'var(--green)'] };
  const [txt, col] = labels[mode] || labels.locked;
  set('realModeStatus', txt, col);
}

(async () => {
  await restoreState();
  initApp();
  startSnapshotLoop(() => window.S);
  refreshApiStatus();
  // ---- 模拟真实交易 / K线快捷交易 引擎接线 ----
  window.paperEngine.seedSim(window.S.sim || { spotUsdt: 5000, perpUsdt: 5000, coin: {} });
  function refreshKchartTradeEngine() {
    const linked = window.S.kchartTradeLinked !== false;
    let engine;
    if (linked) {
      engine = window.paperEngine;
    } else {
      if (!window.__isolatedState) window.__isolatedState = { subs: [], pos: [], closed: [], realized: 0, ai: {}, prices: window.S.prices, fusion: window.S.fusion };
      if (!window.__isolatedPE) {
        window.__isolatedPE = new PaperEngine({ stateRef: () => window.__isolatedState, onLog: window.log, getSlip: () => 0.0002 });
        window.__isolatedPE.seedSim(window.S.sim || { spotUsdt: 5000, perpUsdt: 5000, coin: {} });
      }
      engine = window.__isolatedPE;
    }
    kchartApi.setTradeEngine(engine);
    kchartApi.setTradeConfig({ on: window.S.kchartTradeOn !== false });
  }
  window.refreshKchartTradeEngine = refreshKchartTradeEngine;
  refreshKchartTradeEngine();
  // K线交易条浮盈浮亏实时刷新（不依赖全局 tick 节流）：每秒按当前价重算持仓 pnl 并刷新交易条
  setInterval(() => {
    const PE = window.paperEngine; if (!PE) return;
    const S = PE.S; if (!S) return;
    if (S.pos && S.pos.length) S.pos.forEach(pos => {
      const c = (S.prices[pos.sym] || {}).last; if (!c) return;
      pos.pnl = pos.side === 'long' ? (c - pos.entry) * pos.qty : (pos.entry - c) * pos.qty;
      pos.pnlPct = pos.amt ? (pos.pnl / pos.amt) * 100 : 0;
      if (pos.side === 'long') pos.hi = Math.max(pos.hi || pos.entry, c);
      else pos.lo = Math.min(pos.lo || pos.entry, c);
    });
    if (window.kchartApi && window.kchartApi.checkUserTpSl) {
      window.kchartApi.checkUserTpSl(window.paperEngine);
      if (window.__isolatedPE) window.kchartApi.checkUserTpSl(window.__isolatedPE);
    }
    if (window.kchartApi && window.kchartApi.renderQuickTrade) window.kchartApi.renderQuickTrade();
    // K线纪律分析/速览面板实时刷新（免刷新页面）：仅刷面板 DOM，不重绘画布。
    // _discSig/_ovSig 守卫保证未变化时 O(1)；实时价经 updateDiscLivePrice 每 tick 更新。
    if (window.kchartApi && window.kchartApi.refreshPanels) {
      const wrap = document.getElementById('kchartDiscWrap');
      if (wrap && !wrap.classList.contains('closed')) window.kchartApi.refreshPanels();
    }
    // SRSI 自动交易：每秒按 15m KD 带状态机执行开/平仓
    if (window.kchartApi && window.kchartApi.runSrsiAutoTrade) window.kchartApi.runSrsiAutoTrade();
    // 自动优选引擎：定时 + 无成交双触发重优选（防参数过期）
    if (window.kchartApi && window.kchartApi.maybeAutoOpt) window.kchartApi.maybeAutoOpt();
  }, 1000);
})();

function orderMsg(ev) {
  const side = ev.side === 'long' ? '做多' : '做空';
  const sym = ev.symbol ? ev.symbol.replace('USDT', '') : '';
  switch (ev.event) {
    case 'filled': return `[订单] ${sym} ${side} ${ev.lev}x 成交 @ $${ev.avgPrice.toFixed(2)} 数量 ${ev.filledQty.toFixed(6)} 手续费 $${ev.cumFee.toFixed(3)}`;
    case 'closed': return `[平仓] ${sym} ${side} ${ev.reason} 盈亏 $${ev.pnl.toFixed(2)}`;
    case 'cancelled': return `[订单] ${sym} ${side} 已取消`;
    case 'rejected': return `[订单] ${sym} ${side} 被拒绝: ${ev.rejectReason || ''}`;
    default: return '[订单] 事件更新';
  }
}
