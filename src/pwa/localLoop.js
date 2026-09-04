// 本机 TSEV 训练 loop（浏览器/PWA 专用，Node 不引入）
// 作用：PWA 打开期间，每 60min 用本机已加载的 K线数据跑「纪律方向 → 前向 ATR 判盈亏」样本，
//       累积进 IndexedDB，并本地训练 TSEV 权重；权重「本机优先」合并进 kchart.js 的投票。
// 这样每个用户的设备都能用自己累积的样本自适应判决（无需任何后端/额外软件）。
import { analyzeTradeDiscipline } from '../tech2/kchart.js';
import { winLossByAtr, atrClose } from '../engine/indicators.js';
import { trainTsevWeights, TSEV_CFG } from '../engine/disciplineAnalysis.js';

const DB_NAME = 'kchart_pwa';
const STORE = 'disc';
const KEY = 'samples';
const TFS = ['15m', '1h', '4h'];
const EVAL_TF = '1h';
const BARS = 300;
const MAIN = '1h';
const STRIDE = 1;
const SRSI_CFG = { rsiPeriod: 85, stochPeriod: 50, smoothK: 10, smoothD: 5, overbought: 80, oversold: 20, lookback: 15 };
const INTERVAL_MS = 60 * 60 * 1000;

let _db = null;
let _samples = [];          // 内存缓存（从 IDB 载入）
let _localWeights = null;   // 训练后的本机权重
let _localN = 0;
let _enabled = true;
let _timer = null;
let _onTrained = null;      // 训练完成回调（用于触发面板重渲染）
let _getSym = null;         // 当前交易对提供器（由 kchartApp 注册）
const _status = { running: false, lastRun: 0, sampleCount: 0, enabled: true };

function hasIDB() { return typeof indexedDB !== 'undefined'; }

function openDB() {
  return new Promise((resolve) => {
    if (!hasIDB()) return resolve(null);
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

function idbGet(key) {
  return new Promise((resolve) => {
    if (!_db) return resolve(null);
    try {
      const tx = _db.transaction(STORE, 'readonly');
      const rq = tx.objectStore(STORE).get(key);
      rq.onsuccess = () => resolve(rq.result != null ? rq.result : null);
      rq.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

function idbSet(key, val) {
  return new Promise((resolve) => {
    if (!_db) return resolve(false);
    try {
      const tx = _db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(val, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch { resolve(false); }
  });
}

async function loadSamples() {
  const v = await idbGet(KEY);
  _samples = Array.isArray(v) ? v : [];
  _status.sampleCount = _samples.length;
}

async function persistSamples() {
  await idbSet(KEY, _samples);
}

// 训练：本机样本 → 权重（仅 fut.h4 方向与纪律方向对齐样本）
function train() {
  const rows = _samples.filter(r => Array.isArray(r.factors) && r.fut && r.fut.h4);
  _localWeights = trainTsevWeights(rows, { horizon: 'h4', MIN_SAMPLE: TSEV_CFG.MIN_SAMPLE, Z_THRESH: TSEV_CFG.Z_THRESH });
  _localN = rows.length;
  _status.sampleCount = _samples.length;
  return _localWeights;
}

// 用本机已加载的 K线（S.klines / S.klinesT）对一个币做 walk-forward 采样
async function collectSymbol(sym) {
  const S = globalThis.S;
  if (!S || !S.klines || !S.klines[sym]) return 0;
  const maps = {};
  for (const tf of TFS) {
    const c = S.klines[sym] && S.klines[sym][tf];
    const t = S.klinesT && S.klinesT[sym] && S.klinesT[sym][tf];
    if (!c || !t || c.length < 2) { maps[tf] = []; continue; }
    maps[tf] = c.map((cc, i) => ({ t: t[i], c: cc }));
  }
  const sev = maps[EVAL_TF];
  if (!sev || sev.length < 80) return 0;
  const startMax = Math.max(...TFS.map(tf => { const a = maps[tf] || []; return a.length ? a[0].t : 0; }));
  const endMin = Math.min(...TFS.map(tf => { const a = maps[tf] || []; return a.length ? a[a.length - 1].t : Infinity; }));

  let added = 0;
  const seen = new Set(_samples.map(s => s.id));
  const fresh = [];
  for (let i = 0; i < sev.length - 80; i += STRIDE) {
    const T = sev[i].t;
    if (T < startMax || T > endMin) continue;
    const priceMap = {};
    let nTf = 0;
    for (const tf of TFS) {
      const arr = (maps[tf] || []).filter(k => k.t < T);
      if (arr.length < 2) continue;
      priceMap[tf] = arr.map(k => k.c).slice(-BARS);
      nTf++;
    }
    if (nTf < 2) continue;
    let disc;
    try { disc = analyzeTradeDiscipline(priceMap, SRSI_CFG, { mainTF: MAIN, bars: BARS, klineSel: {} }); }
    catch { continue; }
    if (!disc || !disc.entry) continue;
    const d = disc.entry.dir;
    let direction = null;
    if (d.startsWith('看多')) direction = 'buy';
    else if (d.startsWith('看空')) direction = 'sell';
    if (!direction) continue;

    const cls = sev.map(k => k.c);
    const futAt = (n) => { const j = i + n; if (j >= cls.length) return null; const dd = cls[j] - cls[i]; if (Math.abs(dd) < 1e-9) return 0; return dd > 0 ? 1 : -1; };
    const fut = { h4: futAt(4), d1: futAt(24), d3: futAt(72) };

    const priceFrom = cls.slice(Math.max(0, i - 14));
    const entryIdx = Math.min(14, i);
    const atrArr = atrClose(priceFrom, 14);
    let wl = { win: null, pnlPct: 0 };
    try { wl = winLossByAtr(priceFrom, atrArr, { entryIdx, direction, tpAtr: 2, slAtr: 1.5, horizon: 60 }); } catch { /* 跳过结果 */ }

    const id = sym + '|' + new Date(T).toISOString();
    if (seen.has(id)) continue;
    seen.add(id);
    fresh.push({ id, sym, ts: new Date(T).toISOString(), dir: direction, factors: disc.factors || [], fut, result: wl.win, pnlPct: wl.pnlPct });
  }
  if (fresh.length) {
    _samples = _samples.concat(fresh);
    added = fresh.length;
  }
  return added;
}

async function runOnce() {
  if (!_enabled) return;
  const S = globalThis.S;
  if (!S) return;
  _status.running = true;
  try {
    const sym = (typeof _getSym === 'function' && _getSym()) || (S.sel) || 'BTCUSDT';
    const n = await collectSymbol(sym);
    if (n > 0) { await persistSamples(); train(); if (_onTrained) { try { _onTrained(); } catch {} } }
    else { train(); } // 无新增也确保权重与已有样本一致
    _status.lastRun = Date.now();
  } finally {
    _status.running = false;
  }
}

export async function init() {
  _db = await openDB();
  await loadSamples();
  train();
  _status.enabled = _enabled;
}

export function start() {
  if (_timer) return;
  _timer = setInterval(() => { runOnce().catch(() => {}); }, INTERVAL_MS);
  // 打开后立即跑一次（数据已加载时）
  runOnce().catch(() => {});
}

export function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

export function setEnabled(v) {
  _enabled = !!v;
  _status.enabled = _enabled;
  if (_enabled) start();
  else stop();
}

export function status() { return { ..._status, sampleCount: _samples.length }; }

export function getWeights() {
  return _localWeights && Object.keys(_localWeights).length ? { weights: _localWeights, n: _localN } : null;
}

export function onTrained(cb) { _onTrained = cb; }

export function setSymbolProvider(fn) { if (typeof fn === 'function') _getSym = fn; }

// 供 kchartApp 注册到 globalThis，供 kchart.js 读取本机权重
export function register() { globalThis.__localTsev = { getWeights, status, setEnabled, start, stop, onTrained }; }
