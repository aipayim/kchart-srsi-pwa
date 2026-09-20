// 自适应组合 —— 组合状态机（两腿：Alpha 腿 + carry 腿）
// 目标：$1000 纸面本金，跨市场周期自动在「Alpha 基石（方向）」与「carry（非方向）」之间调仓。
//   每市场：volQ = 30d 已实现波动率的 1 年滚动分位 → w_A = min(1, w0·g)，w_C = 1 − w_A
//   Alpha 腿 = 现有 alphaCore 目标权重 × w_A（复用 alphaLab 的实时信号，逐位同源）
//   carry 腿 = 现货多 + 永续空（见 carryLeg.js）
// 设计红线（见 notebook adaptive-portfolio-impl）：
//   - 默认 disabled（tick no-op），用户显式 enable() 才运行；纯纸面，真实资金仍硬锁
//   - 不改 alphaCore.js（只调用 runBacktest）；新增纯函数带单测
//   - 无前视：volQ 右移一根（volQuantile 默认 shift=1）
//   - 持久化走 kchart._safeSetItem（配额自愈，§5.30 红线）；事件明细走 IndexedDB（内存降级）
//   - 独立 $1000 账本（单池子账户），不与现有手动/SRSI/Alpha 纸面账户混算

import { PaperEngine } from '../exchange/PaperEngine.js';
import { crossedFundingBoundary } from '../engine/funding.js';
import {
  volQuantile, adaptiveWeights, adaptiveAlphaWeight, realizedVolSeries, rollingPercentileSeries,
} from '../engine/adaptivePortfolioMath.js';
import { createCarryLeg, CARRY_SRC, CARRY_SPOT_SIG, posPnl } from './carryLeg.js';
import { runBacktest } from './alphaCore.js';
import { fetchKlinesRange, fetchFundingRate, fetchPremiumIndex } from './data.js';
import { _safeSetItem } from '../tech2/kchart.js';

const LS_KEY = 'pwa_adaptive_portfolio';
const IDB_NAME = 'smartTraderAP', IDB_STORE = 'events', DB_VER = 1;
const MAX_EVENTS = 2000;
const HOUR = 3600e3, DAY = 86400e3;

const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 10000) / 10000 : null);

/** 波动率分位分桶（与研究一致：low<1/3, mid<2/3, high）。 */
export function volBucket(q, lo = 1 / 3, hi = 2 / 3) {
  return !Number.isFinite(q) ? 'na' : (q < lo ? 'low' : q < hi ? 'mid' : 'high');
}

// ---------- IndexedDB（自包含轻量封装，内存降级）----------
function idbOpen() {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(IDB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
      setTimeout(() => resolve(req.readyState === 'done' ? (req.result || null) : null), 2000);
    } catch (e) { resolve(null); }
  });
}
function idbPut(db, rec) {
  return new Promise((resolve) => {
    if (!db) return resolve(false);
    try {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(rec);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch (e) { resolve(false); }
  });
}
function idbAll(db) {
  return new Promise((resolve) => {
    if (!db) return resolve(null);
    try {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve(null);
    } catch (e) { resolve(null); }
  });
}

const DEFAULT_FETCHERS = { klinesRange: fetchKlinesRange, fundingRate: fetchFundingRate, premiumIndex: fetchPremiumIndex };

/**
 * @param {object} [o]
 * @param {object} [o.engine] PaperEngine（可选；不给则自建隔离纸面引擎）
 * @param {object} [o.state]  隔离状态（可选；不给则自建）
 * @param {string[]} [o.symbols]
 * @param {number} [o.w0=0.5] Alpha 腿基准权重
 * @param {number} [o.capital=1000] 纸面本金
 * @param {object} [o.cfg] { lev, band, feeReserve, dataRefreshMs, d1RefreshMs, fundingRefreshMs, alphaBand, persist, priceSource, fetchers }
 */
export function createAdaptivePortfolio({ engine, state, symbols: symbolsIn, w0 = 0.5, capital = 1000, cfg = {} } = {}) {
  const conf = {
    lev: 3, band: 0.10, feeReserve: 0.004, frac: null,
    dataRefreshMs: 2 * HOUR, d1RefreshMs: 24 * HOUR, fundingRefreshMs: 12 * HOUR, priceRefreshMs: 60e3,
    alphaBand: 0.05, klinesMaxBars: 18000, klinesDays: 740,
    persist: true, ...cfg,
  };
  // 交易对：默认 BTC/ETH（研究已验证的等权组合）；可由用户增删（非 BTC/ETH 为未验证·仅纸面）。
  const SYMS_KEY = conf.symbolsKey || 'pwa_adaptive_symbols';
  const DEFAULT_SYMS = ['BTCUSDT', 'ETHUSDT'];
  let symbols = (Array.isArray(symbolsIn) && symbolsIn.length) ? symbolsIn.map((s) => String(s).toUpperCase()) : DEFAULT_SYMS.slice();
  if (conf.persist) {
    try {
      if (typeof localStorage !== 'undefined') {
        const saved = JSON.parse(localStorage.getItem(SYMS_KEY) || 'null');
        if (Array.isArray(saved) && saved.length) symbols = saved.map((s) => String(s).toUpperCase()).filter(Boolean);
      }
    } catch (e) { /* 用默认 */ }
  }
  const fetchers = { ...DEFAULT_FETCHERS, ...(cfg.fetchers || {}) };
  const priceSource = cfg.priceSource || (() => {
    const host = (typeof globalThis !== 'undefined' && globalThis.S) || null;
    return (host && host.prices) || {};
  });

  // ---------- 隔离状态 / 引擎 ----------
  let S = state || null;
  if (!S) {
    S = { prices: {}, subs: [], pos: [], closed: [], realized: 0, ai: { atrSuper: {} }, fusion: { fr: {} } };
  }
  if (!S.prices) S.prices = {};
  if (!S.pos) S.pos = [];
  if (!S.closed) S.closed = [];
  if (S.realized == null) S.realized = 0;
  if (!engine) engine = new PaperEngine({ stateRef: () => S, onLog: () => {}, getSlip: () => 0.0002 });

  let sub = (S.subs || []).find((s) => s.adaptive) || (S.subs || [])[0] || null;
  if (!sub) {
    sub = { id: 1, bal: capital, st: 'idle', pnl: 0, ex: 'Binance', tr: 0, w: 0, type: 'perp', coins: {}, sim: true, adaptive: true };
    if (!S.subs) S.subs = [];
    S.subs.push(sub);
  } else {
    sub.adaptive = true;
  }

  // ---------- 每币状态 ----------
  const perSymbol = {};
  symbols.forEach((sym) => {
    perSymbol[sym] = { sym, volQ: NaN, g: 1, wA: w0, wC: 1 - w0, warming: true, alphaTarget: 0, alphaW: 0, carry: null, bucket: 'na', dataT: 0, d1T: 0, frT: 0, err: null };
  });

  // ---------- 事件 / 缓存 ----------
  const _events = [];
  let _evSeq = 0;
  const _idb = { db: null, mode: 'mem', inited: false };
  const _h1 = {}, _d1 = {}, _funding = {}, _premium = {}, _series = {};
  let enabled = false, _lastTickT = 0, _lastFundCheck = Date.now(), _ticking = false, _lastPersistSig = '';
  const log = (tag, msg) => { try { console.log('[ADAPTIVE]', tag, msg && msg.message ? msg.message : msg); } catch (e) {} };

  function recordEvent(type, detail = {}) {
    const ev = { id: ++_evSeq, ts: Date.now(), type, ...detail };
    _events.push(ev);
    if (_events.length > MAX_EVENTS) _events.splice(0, _events.length - MAX_EVENTS);
    if (_idb.db) idbPut(_idb.db, ev);
    _persistSoon();
    return ev;
  }

  async function initIdb() {
    if (_idb.inited) return;
    _idb.inited = true;
    const db = await idbOpen();
    if (db) {
      _idb.db = db; _idb.mode = 'idb';
      const all = await idbAll(db);
      if (all && all.length) {
        all.sort((a, b) => a.ts - b.ts);
        all.forEach((e) => { if (e && e.id > _evSeq) _evSeq = e.id; });
        _events.length = 0;
        all.slice(-MAX_EVENTS).forEach((e) => _events.push(e));
      }
    } else {
      _idb.mode = 'mem';
      try { console.warn('[ADAPTIVE] IndexedDB 不可用，事件簿降级为内存模式（仅本会话）'); } catch (e) {}
    }
  }

  // ---------- 持久化 ----------
  function snapshot() {
    return {
      ver: 1, enabled, capital, w0, symbols,
      perSymbol: Object.fromEntries(symbols.map((sym) => [sym, {
        volQ: perSymbol[sym].volQ, g: perSymbol[sym].g, wA: perSymbol[sym].wA, wC: perSymbol[sym].wC,
        warming: perSymbol[sym].warming, alphaTarget: perSymbol[sym].alphaTarget, bucket: perSymbol[sym].bucket, dataT: perSymbol[sym].dataT,
      }])),
      engine: { subs: S.subs, pos: S.pos, closed: S.closed.slice(-200), realized: S.realized },
      updatedT: Date.now(),
    };
  }
  function _persistSoon() { if (conf.persist) persist(); }
  function persist() {
    if (!conf.persist) return false;
    try {
      const snap = snapshot();
      const sig = JSON.stringify({ e: snap.enabled, p: snap.perSymbol, n: snap.engine.pos.length, r: snap.engine.realized });
      if (sig === _lastPersistSig) return true;
      _lastPersistSig = sig;
      return _safeSetItem(LS_KEY, JSON.stringify(snap));
    } catch (e) { return false; }
  }
  function restore() {
    if (!conf.persist) return;
    try {
      if (typeof localStorage === 'undefined') return;
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const o = JSON.parse(raw);
      if (!o || typeof o !== 'object') return;
      enabled = !!o.enabled;
      if (o.engine && Array.isArray(o.engine.subs) && o.engine.subs.length) {
        // 仅恢复余额/持仓/成交/已实现（价格由行情流实时覆盖）
        S.subs = o.engine.subs;
        sub = S.subs.find((s) => s.adaptive) || S.subs[0] || sub;
        if (sub) sub.adaptive = true;
        S.pos = Array.isArray(o.engine.pos) ? o.engine.pos : [];
        S.closed = Array.isArray(o.engine.closed) ? o.engine.closed : [];
        S.realized = Number.isFinite(o.engine.realized) ? o.engine.realized : 0;
      }
      if (o.perSymbol) {
        symbols.forEach((sym) => {
          const ps = o.perSymbol[sym];
          if (!ps) return;
          const st = perSymbol[sym];
          st.volQ = Number.isFinite(ps.volQ) ? ps.volQ : NaN;
          st.g = Number.isFinite(ps.g) ? ps.g : 1;
          st.wA = Number.isFinite(ps.wA) ? ps.wA : w0;
          st.wC = Number.isFinite(ps.wC) ? ps.wC : 1 - w0;
          st.warming = !!ps.warming;
          st.alphaTarget = Number.isFinite(ps.alphaTarget) ? ps.alphaTarget : 0;
          st.bucket = ps.bucket || 'na';
          st.dataT = Number.isFinite(ps.dataT) ? ps.dataT : 0;
        });
      }
    } catch (e) { log('restore_err', e); }
  }
  restore();

  // ---------- 行情 ----------
  function updatePrices() {
    const host = priceSource() || {};
    for (const sym of symbols) {
      let px = host[sym] && host[sym].last;
      if (!(px > 0) && _premium[sym]) px = _premium[sym].markPrice;
      if (px > 0) {
        if (!S.prices[sym]) S.prices[sym] = {};
        S.prices[sym].last = px;
        if (host[sym] && Number.isFinite(host[sym].chg)) S.prices[sym].chg = host[sym].chg;
      }
    }
  }

  function portfolioEquity() {
    let eq = sub ? (sub.bal || 0) : 0;
    for (const p of (S.pos || [])) {
      const px = (S.prices[p.sym] || {}).last || p.entry;
      if (p.sig === CARRY_SPOT_SIG) eq += p.qty * px;             // 现货多头市值
      else eq += (p.amt || 0) + posPnl(p, px);                    // 永续/Alpha：保证金 + 浮盈
    }
    return eq;
  }

  // ---------- 数据刷新 ----------
  async function refreshSymbolData(sym, now) {
    const st = perSymbol[sym];
    try {
      // 1h K 线（volQ + Alpha 信号共用）
      const start = now - conf.klinesDays * DAY;
      const k = await fetchers.klinesRange(sym, '1h', start, now, null, conf.klinesMaxBars);
      if (k && k.closes && k.closes.length > 60) {
        _h1[sym] = { t: k.times, o: k.opens, h: k.highs, l: k.lows, c: k.closes };
        const q = volQuantile(k.closes, { volWin: 720, rankWin: 8760, shift: 1 });
        st.volQ = q; st.warming = !Number.isFinite(q);
        const w = adaptiveWeights(q, { w0 });
        st.g = w.g; st.wA = w.wA; st.wC = w.wC;
        const nb = volBucket(q);
        if (nb !== st.bucket) { recordEvent('volQ_cross', { sym, from: st.bucket, to: nb, volQ: r4(q), g: r4(w.g), wA: r4(w.wA) }); st.bucket = nb; }
      }
      // 日线（Alpha 的 1d 输入；较慢刷新）
      if (!_d1[sym] || now - (_d1[sym].at || 0) > conf.d1RefreshMs) {
        const kd = await fetchers.klinesRange(sym, '1d', now - 900 * DAY, now, null, 1200);
        if (kd && kd.closes && kd.closes.length > 30) _d1[sym] = { t: kd.times, c: kd.closes, at: now };
      }
      // 资金费历史（Alpha carry z 输入）
      if (!_funding[sym] || now - (_funding[sym].at || 0) > conf.fundingRefreshMs) {
        const rows = await fetchers.fundingRate(sym, now - conf.klinesDays * DAY, now);
        _funding[sym] = { rows: (rows || []).map((r) => [r.fundingTime, r.fundingRate]), at: now };
      }
      // 实时资金费率 + 标记价在 maybeRefreshPremium 中更频（60s）刷新
      // Alpha 目标权重（复用生产 alphaCore.runBacktest，与 alphaLab 同源）
      st.alphaTarget = computeAlphaTarget(sym);
      st.dataT = now; st.err = null;
    } catch (e) {
      st.err = (e && e.message) || String(e);
      st.dataT = now - conf.dataRefreshMs + 60000;   // 1 分钟后重试
      log('refresh_err', sym + ': ' + st.err);
    }
  }

  function computeAlphaTarget(sym) {
    const h1 = _h1[sym], d1 = _d1[sym];
    if (!h1 || h1.t.length < 200 || !d1 || d1.c.length < 30) return 0;
    const funding = (_funding[sym] && _funding[sym].rows) || [];
    try {
      const r = runBacktest(h1, d1, {
        start: h1.t[0], end: h1.t[h1.t.length - 1] + HOUR,
        band: 0.05, funding, useFunding: true, levCap: 1, volTarget: 0.30, vtCap: 1.5, longOnly: false,
      });
      if (!r || r.error || !Number.isFinite(r.lastW)) return 0;
      return r.lastW;
    } catch (e) { log('alpha_err', sym + ': ' + e.message); return 0; }
  }

  async function maybeRefreshPremium(now) {
    for (const sym of symbols) {
      const p = _premium[sym];
      if (now - ((p && p.at) || 0) < conf.priceRefreshMs) continue;
      try { const r = await fetchers.premiumIndex(sym); if (r) _premium[sym] = { ...r, at: now }; } catch (e) { /* fapi 不可达 → 标记价/资金费降级 */ }
      return;   // 一次 tick 只刷一个币
    }
  }

  async function maybeRefreshData(now) {
    for (const sym of symbols) {
      if (now - (perSymbol[sym].dataT || 0) < conf.dataRefreshMs) continue;
      await refreshSymbolData(sym, now);
      return;   // 一次 tick 只刷新一个币，避免阻塞主循环
    }
  }

  // ---------- 两腿 ----------
  // 隔离引擎的强平检查：PaperEngine.checkLiquidations 优先读全局 window.getMarkPrice（主系统的标记价，
  // 对隔离账本会用错价 → 误强平）。此处在该同步调用期间临时用隔离 state 的价格覆盖，调用后立即还原。
  function withIsolatedMark(fn) {
    const g = typeof globalThis !== 'undefined' ? globalThis : null;
    if (!g) return fn();
    const prev = g.getMarkPrice;
    try {
      g.getMarkPrice = (sym) => (S.prices[sym] && S.prices[sym].last) || (typeof prev === 'function' ? prev(sym) : 0);
      return fn();
    } finally {
      if (prev === undefined) { try { delete g.getMarkPrice; } catch (e) { g.getMarkPrice = undefined; } } else g.getMarkPrice = prev;
    }
  }
  function checkLiquidationsIsolated() {
    if (!engine.checkLiquidations) return [];
    return withIsolatedMark(() => engine.checkLiquidations()) || [];
  }

  async function syncAlphaLeg(sym, st, px, now, sleeve) {
    if (!(sleeve > 1)) return;
    const targetNotional = st.wA * st.alphaTarget * sleeve;
    const pos = (S.pos || []).find((p) => p.sym === sym && p.src === 'adaptiveAlpha') || null;
    const curNotional = pos ? pos.qty * px * (pos.side === 'long' ? 1 : -1) : 0;
    if (Math.abs(targetNotional - curNotional) / sleeve <= conf.alphaBand) return;
    if (pos) { try { engine.exitPosition(pos, { reason: '[自适应]Alpha调仓' }); } catch (e) { log('alpha_close_err', e); } }
    if (Math.abs(targetNotional) > 1) {
      try {
        const o = await engine.placeOrder({
          symbol: sym, side: targetNotional > 0 ? 'long' : 'short',
          amt: Math.abs(targetNotional), lev: 1, marginMode: 'usdt', sub, ai: false, sig: '自适应Alpha', src: 'adaptiveAlpha',
        });
        if (o && o.status === 'rejected') log('alpha_rejected', o.rejectReason);
      } catch (e) { log('alpha_open_err', e); }
    }
    recordEvent('alpha_reweight', { sym, wA: r4(st.wA), alphaTarget: r4(st.alphaTarget), notional: r2(targetNotional), prev: r2(curNotional) });
  }

  async function tickSymbol(sym, now) {
    const st = perSymbol[sym];
    const px = S.prices[sym] && S.prices[sym].last;
    if (!(px > 0)) return;
    if (!st.carry) st.carry = createCarryLeg({ engine, symbol: sym, sub, lev: conf.lev, band: conf.band, feeReserve: conf.feeReserve, frac: conf.frac, log });
    const sleeve = Math.max(0, portfolioEquity() / symbols.length);
    const carryEq = sleeve * st.wC;
    const res = await st.carry.sync({ px, equity: carryEq, now });
    if (res.action === 'rebalance') {
      recordEvent('carry_rebalance', { sym, equity: r2(res.equity), wC: r4(st.wC), notional: r2(res.target.notional), reason: res.reason, ok: res.ok !== false });
    } else if (res.action === 'error') {
      recordEvent('carry_error', { sym, reason: res.reason });
    }
    await syncAlphaLeg(sym, st, px, now, sleeve);
    st.alphaW = st.wA * st.alphaTarget;
  }

  function applyFunding(sym, now) {
    const st = perSymbol[sym];
    if (!st.carry) return;
    const px = S.prices[sym] && S.prices[sym].last;
    const rate = _premium[sym] && _premium[sym].lastFundingRate;
    if (!(px > 0) || !Number.isFinite(rate)) return;
    const pay = st.carry.accrueFunding({ rate, px, now });
    if (Math.abs(pay) > 1e-9) recordEvent('funding', { sym, rate: r4(rate), pay: r2(pay), cum: r2(st.carry.state.fundingCum) });
  }

  // ---------- tick ----------
  async function tick(nowMs = Date.now()) {
    if (!enabled) return null;
    if (_ticking) return null;
    _ticking = true;
    try {
      const now = nowMs;
      updatePrices();
      await maybeRefreshPremium(now);
      updatePrices();
      await maybeRefreshData(now);
      for (const sym of symbols) { try { await tickSymbol(sym, now); } catch (e) { log('tick_sym_err', sym + ': ' + e.message); } }
      if (crossedFundingBoundary(_lastFundCheck, now)) { for (const sym of symbols) { try { applyFunding(sym, now); } catch (e) { log('fund_err', e); } } }
      _lastFundCheck = now;
      try { const hits = checkLiquidationsIsolated(); for (const h of hits) { if (h && h.pos && h.pos.src === CARRY_SRC) { const c = perSymbol[h.pos.sym] && perSymbol[h.pos.sym].carry; if (c) c.state.liqCount++; } } } catch (e) { log('liq_err', e); }
      _lastTickT = now;
      persist();
      return getState();
    } finally { _ticking = false; }
  }

  // ---------- 控制 ----------
  function enable() {
    if (enabled) return true;
    enabled = true;
    _lastFundCheck = Date.now();
    symbols.forEach((sym) => { perSymbol[sym].dataT = 0; });   // 触发立即刷新
    recordEvent('enable', { capital, w0, symbols });
    persist();
    return true;
  }
  function disable() {
    if (!enabled) return true;
    enabled = false;
    recordEvent('disable', {});
    persist();
    return true;
  }
  function reset() {
    try { (S.pos || []).slice().forEach((p) => { try { engine.exitPosition(p, { reason: '[自适应]重置' }); } catch (e) {} }); } catch (e) {}
    S.pos = []; S.closed = []; S.realized = 0;
    if (sub) sub.bal = capital;
    _events.length = 0;
    symbols.forEach((sym) => {
      const st = perSymbol[sym];
      st.volQ = NaN; st.g = 1; st.wA = w0; st.wC = 1 - w0; st.warming = true; st.alphaTarget = 0; st.alphaW = 0; st.bucket = 'na'; st.dataT = 0; st.err = null;
      if (st.carry) st.carry.state.fundingCum = 0;
    });
    if (_idb.db) { try { const tx = _idb.db.transaction(IDB_STORE, 'readwrite'); tx.objectStore(IDB_STORE).clear(); } catch (e) {} }
    _lastPersistSig = '';
    persist();
  }

  /** 运行时更改交易对列表（会平掉全部持仓并重置账本）。返回是否生效。 */
  function setSymbols(list) {
    const clean = [...new Set((list || []).map((s) => String(s).toUpperCase().trim()).filter(Boolean))];
    if (!clean.length) return false;
    if (clean.length === symbols.length && clean.every((s, i) => s === symbols[i])) return false;
    try { (S.pos || []).slice().forEach((p) => { try { engine.exitPosition(p, { reason: '[自适应]交易对变更' }); } catch (e) {} }); } catch (e) {}
    S.pos = []; S.closed = []; S.realized = 0;
    if (sub) sub.bal = capital;
    symbols = clean;
    Object.keys(perSymbol).forEach((k) => delete perSymbol[k]);
    symbols.forEach((sym) => { perSymbol[sym] = { sym, volQ: NaN, g: 1, wA: w0, wC: 1 - w0, warming: true, alphaTarget: 0, alphaW: 0, carry: null, bucket: 'na', dataT: 0, d1T: 0, frT: 0, err: null }; });
    [_h1, _d1, _funding, _premium, _series].forEach((o) => { Object.keys(o).forEach((k) => delete o[k]); });
    _lastPersistSig = '';
    try { if (typeof localStorage !== 'undefined') _safeSetItem(SYMS_KEY, JSON.stringify(symbols)); } catch (e) {}
    recordEvent('symbols_change', { symbols: symbols.slice() });
    persist();
    return true;
  }

  function getState() {
    return {
      enabled, capital, w0, symbols, lev: conf.lev, band: conf.band,
      warming: symbols.some((s) => perSymbol[s].warming),
      equity: r2(portfolioEquity()), realized: r2(S.realized), positions: (S.pos || []).length,
      perSymbol: Object.fromEntries(symbols.map((sym) => {
        const st = perSymbol[sym];
        return [sym, {
          volQ: Number.isFinite(st.volQ) ? r4(st.volQ) : null, g: r4(st.g), wA: r4(st.wA), wC: r4(st.wC),
          warming: st.warming, alphaTarget: r4(st.alphaTarget), alphaW: r4(st.alphaW), bucket: st.bucket,
          carry: st.carry ? st.carry.summary((S.prices[sym] || {}).last || 0) : null,
          err: st.err, dataT: st.dataT,
        }];
      })),
      events: _events.length, mode: _idb.mode, updatedT: _lastTickT,
    };
  }

  /**
   * 主图叠加所需的因果时间序列（1h 轴）：{ t, volQ, wA, n }。未启用/无数据 → null。
   * volQ = 30d 已实现波动率的 1 年滚动分位（与实盘同源同算法）；wA = min(1, w0·g(volQ))。
   * 注意：序列本身是因果的（volQ[i] 用 closes[0..i]），主图叠加时仍需右移一根防前视。
   */
  function getSeries(sym) {
    const h1 = _h1[sym];
    if (!h1 || !h1.t || h1.t.length < 200) return null;
    const c = _series[sym];
    if (c && c.n === h1.t.length && c.w0 === w0) return c;
    const rv = realizedVolSeries(h1.c, 720);
    const volQ = rollingPercentileSeries(rv, 8760);
    const wA = new Float64Array(volQ.length);
    for (let i = 0; i < volQ.length; i++) wA[i] = adaptiveAlphaWeight(volQ[i], { w0 });
    _series[sym] = { t: h1.t, volQ, wA, n: h1.t.length, w0 };
    return _series[sym];
  }

  const api = {
    tick, enable, disable, reset, getState,
    isEnabled: () => enabled,
    getEvents: (limit = 100) => _events.slice(-limit),
    getPerSymbol: (sym) => perSymbol[sym] || null,
    getEngine: () => engine,
    getStateRef: () => S,
    getSeries,
    getSymbols: () => symbols.slice(),
    setSymbols,
    recordEvent,
    initIdb,
    _conf: conf,
  };
  initIdb();
  return api;
}

/** 创建隔离组合并挂到 globalThis.__adaptivePortfolio（供 console / 1s 循环使用）。 */
export function installAdaptivePortfolio(opts = {}) {
  if (typeof globalThis === 'undefined') return null;
  if (globalThis.__adaptivePortfolio) return globalThis.__adaptivePortfolio;
  const ap = createAdaptivePortfolio(opts);
  globalThis.__adaptivePortfolio = ap;
  return ap;
}
