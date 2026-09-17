// PWA 重构外壳控制器（风格 A 霓虹驾驶舱）—— 仅 PWA 使用，不改主系统。
// 职责：① rail/tabbar 四页导航 ② 顶栏实时价 ③ KPI 条（真实数据）
//       ④ 盯盘右栏内联「信号驾驶舱 / 解读卡 / 事件流」（复用 signalCockpit 纯函数与绘制函数）
// 所有数据来自既有引擎：window.S / window.__alphaSignals / ruleMonitor 影子快照 / kchart cfg。
import {
  buildPillarModel, factorShares, drawPosGauge, drawWHistory,
  buildReadoutModel, drawRadar, drawRelVis,
  loadCockpitEvents, drawEvSpark, renderEventsHtml
} from '../tech2/signalCockpit.js';
import { getLastRuleSnapshot, getCockpitCtx } from '../tech2/ruleMonitor.js';
import { horizonTrend, macroTrend } from '../tech2/kchart.js';
import { THRESH } from '../engine/thresholds.js';

export const PWA_TABS = [
  { id: 'kline', ic: '📈', nm: '盯盘' },
  { id: 'trade', ic: '🧭', nm: '交易' },
  { id: 'bt', ic: '🧪', nm: '回测' },
  { id: 'settings', ic: '⚙', nm: '设置' }
];
const TAB_KEY = 'pwa_tab';

let _curTab = 'kline';
let _lastPrice = null;
let _flashT = 0;

const $ = (id) => (typeof document !== 'undefined' ? document.getElementById(id) : null);
const fmtPx = (v) => (v == null || !isFinite(v)) ? '—' : (v >= 1000 ? v.toFixed(1) : v >= 1 ? v.toFixed(2) : v.toFixed(4));

// ---------- canvas 高分屏准备 ----------
function prep(cv) {
  if (!cv || !cv.getContext) return null;
  const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
  const w = cv.clientWidth || 0, h = cv.clientHeight || 0;
  if (!w || !h) return null;
  const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
  if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

// ---------- 导航 ----------
function renderNav() {
  const rail = $('pwaRail'), bar = $('pwaTabBar');
  if (rail) {
    rail.innerHTML = PWA_TABS.map(t =>
      `<button class="ritem${t.id === _curTab ? ' on' : ''}" data-tab="${t.id}" type="button"><span class="ic">${t.ic}</span>${t.nm}</button>`).join('');
  }
  if (bar) {
    bar.innerHTML = PWA_TABS.map(t =>
      `<button class="${t.id === _curTab ? 'on' : ''}" data-tab="${t.id}" type="button"><span class="ic">${t.ic}</span>${t.nm}</button>`).join('');
  }
}

export function goTab(tab, opts) {
  if (!PWA_TABS.some(t => t.id === tab)) tab = 'kline';
  _curTab = tab;
  document.querySelectorAll('.pwa-tab').forEach(s => s.classList.toggle('on', s.getAttribute('data-tab') === tab));
  renderNav();
  try { localStorage.setItem(TAB_KEY, tab); } catch (e) {}
  const content = $('pwaContent');
  if (content && !(opts && opts.keepScroll)) content.scrollTop = 0;
  const api = globalThis.kchartApi;
  if (tab === 'kline') {
    if (api && api.render) { try { api.render(); } catch (e) {} }
    startGauge();
  } else {
    stopGauge();
  }
  if (api && api.renderMainTools) { try { api.renderMainTools(); } catch (e) {} }
  // 交易/回测页需要交易条与面板刷新（首次进入时引擎可能刚注入）
  if (tab === 'trade' || tab === 'bt') { if (api && api.renderQuickTrade) { try { api.renderQuickTrade(); } catch (e) {} } }
  refreshShell();
}

function bindNav() {
  const handler = (e) => {
    const b = e.target && e.target.closest ? e.target.closest('[data-tab]') : null;
    if (b) goTab(b.getAttribute('data-tab'));
  };
  const rail = $('pwaRail'), bar = $('pwaTabBar');
  if (rail) rail.addEventListener('click', handler);
  if (bar) bar.addEventListener('click', handler);
}

// ---------- 顶栏实时价 ----------
function renderPrice(sym) {
  const S = globalThis.S || {};
  const p = (S.prices && S.prices[sym]) || null;
  const v = $('pwaPriceV'), c = $('pwaPriceC'), lat = $('pwaLat');
  const nm = $('pwaSymName');
  if (nm && sym) nm.textContent = sym;
  if (!v) return;
  if (!p || p.last == null) { v.textContent = '—'; if (c) c.textContent = '—'; return; }
  const px = p.last;
  v.textContent = '$' + fmtPx(px);
  if (c) {
    const chg = isFinite(p.chg) ? p.chg : 0;
    c.textContent = (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%';
    c.className = 'c mono ' + (chg >= 0 ? 'up' : 'down');
  }
  if (_lastPrice != null && px !== _lastPrice) {
    const now = Date.now();
    if (now - _flashT > 350) {
      _flashT = now;
      v.classList.remove('flash-u', 'flash-d');
      void v.offsetWidth;
      v.classList.add(px >= _lastPrice ? 'flash-u' : 'flash-d');
    }
  }
  _lastPrice = px;
  if (lat) lat.textContent = 'LIVE · ' + new Date().toLocaleTimeString();
}

// ---------- KPI 条 ----------
function drawRing(ctx, w, h, pct, color) {
  const r = Math.max(7, Math.min(h / 2 - 2, 10)), cx = w - r - 3, cy = h / 2;
  ctx.clearRect(0, 0, w, h);
  ctx.lineWidth = 3.2;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0, Math.min(1, pct || 0)));
  ctx.strokeStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 6; ctx.stroke(); ctx.shadowBlur = 0;
}
function drawSpark(ctx, w, h, data, color) {
  ctx.clearRect(0, 0, w, h);
  const arr = (Array.isArray(data) ? data : []).filter(v => typeof v === 'number' && isFinite(v));
  if (arr.length < 2) { ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke(); return; }
  const mn = Math.min(...arr), mx = Math.max(...arr), rg = (mx - mn) || 1;
  const px = i => 2 + (w - 4) * i / (arr.length - 1), py = v => h - 3 - (h - 6) * (v - mn) / rg;
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, 'rgba(34,211,238,.30)'); g.addColorStop(1, 'rgba(34,211,238,0)');
  ctx.beginPath(); ctx.moveTo(px(0), h);
  arr.forEach((v, i) => ctx.lineTo(px(i), py(v)));
  ctx.lineTo(px(arr.length - 1), h); ctx.closePath(); ctx.fillStyle = g; ctx.fill();
  ctx.beginPath(); arr.forEach((v, i) => { i ? ctx.lineTo(px(i), py(v)) : ctx.moveTo(px(i), py(v)); });
  ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.stroke();
}

function renderKpis(pillar, rd, alphaSig) {
  const box = $('pwaKpis');
  if (!box) return;
  const w = isFinite(pillar.w) ? pillar.w : 0;
  const wPct = Math.round(w * 100);
  const volPct = Math.round((rd.volNorm || 0) * 100);
  const confPct = rd.confirmNeed > 0 ? rd.confirmN / rd.confirmNeed : 0;
  const kpis = [
    { k: '基石目标仓位', v: (wPct >= 0 ? '+' : '') + wPct, u: '%', c: w >= 0 ? '#00e676' : '#ff5252', ring: Math.abs(w) },
    { k: '趋势方向 · 强度', v: rd.trendLabel, u: '', c: '#22d3ee', ring: rd.trendNorm || 0 },
    { k: '波动分位 · ' + (rd.volBand || '中'), v: String(volPct), u: '%', c: '#ffd740', ring: rd.volNorm || 0 },
    { k: '卫星确认 · ' + (rd.band === 'upper' ? '上带' : rd.band === 'lower' ? '下带' : '中性'), v: rd.confirmN + '/' + rd.confirmNeed, u: '', c: '#22d3ee', ring: confPct },
    { k: '距上次调仓', v: pillar.ageTxt, u: '', c: '#7c8aa3', spark: (alphaSig && alphaSig.ws) || [] }
  ];
  box.innerHTML = kpis.map((x, i) => `
    <div class="pwa-card pwa-kpi">
      <div class="k"><span class="pwa-dot" style="background:${x.c};animation:none;box-shadow:none"></span>${x.k}</div>
      <div class="v" style="color:${x.c}">${x.v}${x.u ? '<small>' + x.u + '</small>' : ''}</div>
      <div class="sp"><canvas class="spark" data-i="${i}" data-kind="${x.ring !== undefined ? 'ring' : 'spark'}" data-c="${x.c}"></canvas></div>
    </div>`).join('');
  box.querySelectorAll('canvas.spark').forEach(cv => {
    const i = +cv.dataset.i, kind = cv.dataset.kind, c = cv.dataset.c;
    const p = prep(cv); if (!p) return;
    if (kind === 'ring') drawRing(p.ctx, p.w, p.h, kpis[i].ring, c);
    else drawSpark(p.ctx, p.w, p.h, kpis[i].spark, c);
  });
}

// ---------- 信号驾驶舱（内联） ----------
let _gaugeRaf = 0, _animW = 0, _targetW = 0;

function gaugeFrame() {
  _gaugeRaf = 0;
  if (_curTab !== 'kline') return;
  const cv = $('pwaPosGauge');
  if (cv && cv.clientWidth) {
    _animW += (_targetW - _animW) * 0.06;
    const p = prep(cv);
    if (p) { try { drawPosGauge(p.ctx, p.w, p.h, _animW, { hint: '调仓阈值 |Δw|>0.05 · 60s 检查' }); } catch (e) {} }
  }
  _gaugeRaf = requestAnimationFrame(gaugeFrame);
}
export function startGauge() { if (!_gaugeRaf && typeof requestAnimationFrame === 'function') _gaugeRaf = requestAnimationFrame(gaugeFrame); }
export function stopGauge() { if (_gaugeRaf) { try { cancelAnimationFrame(_gaugeRaf); } catch (e) {} _gaugeRaf = 0; } }

function renderCockpit(snap, alphaSig, rd, now) {
  // 基石区
  const facs = factorShares(alphaSig && alphaSig.factors);
  const fbox = $('pwaFactors');
  if (fbox) {
    const html = facs.length ? facs.map(f => {
      const vtxt = (f.val >= 0 ? '+' : '') + f.val.toFixed(2);
      return `<div class="pwa-fac sc-${f.key}"><span class="nm">${f.label}</span>` +
        `<span class="bar"><i style="width:${Math.max(0, Math.min(100, f.sharePct)).toFixed(1)}%"></i></span>` +
        `<span class="vv">${vtxt} · ${Math.round(f.sharePct)}%</span></div>`;
    }).join('') : '<div class="pwa-dim" style="font-size:10.5px">⏳ 等待 Alpha 信号…（进入盯盘页后自动计算）</div>';
    if (fbox.__sig !== html) { fbox.__sig = html; fbox.innerHTML = html; }
  }
  _targetW = Math.max(-1, Math.min(1, isFinite(rd.w) ? rd.w : 0));
  const wc = $('pwaWHist');
  const ws = (alphaSig && alphaSig.ws) || [];
  const wkey = ws.length + '|' + (ws.length ? ws[ws.length - 1] : '');
  if (wc && wc.__key !== wkey) {
    wc.__key = wkey;
    const p = prep(wc);
    if (p) { try { drawWHistory(p.ctx, p.w, p.h, ws, { label: 'w 历史（近 ' + ws.length + ' 根目标仓位）' }); } catch (e) {} }
  }
  const wm = $('pwaWMeta');
  if (wm) wm.textContent = 'w 历史 · 近 ' + ws.length + ' 根目标仓位 · ' + (pillar_liveTxt(alphaSig));

  // 解读卡
  const rel = rd.rel;
  const pill = $('pwaRelPill');
  if (pill) {
    const kind = rel.kind;
    pill.textContent = kind === 'resonance' ? '✓ 共振' : kind === 'conflict' ? '⚠ 冲突' : '中性';
    pill.className = 'pwa-pill ' + (kind === 'resonance' ? 'b' : kind === 'conflict' ? 'w' : '');
  }
  const rc = $('pwaRadar');
  if (rc && rc.clientWidth) {
    const p = prep(rc);
    if (p) { try {
      drawRadar(p.ctx, p.w, p.h, [
        { label: '趋势', val: rd.trendNorm || 0 },
        { label: '波动', val: rd.volNorm || 0 },
        { label: '基石', val: Math.abs(rd.w || 0) },
        { label: '卫星', val: rd.confirmNeed > 0 ? rd.confirmN / rd.confirmNeed : 0 }
      ], 1);
    } catch (e) {} }
  }
  const vc = $('pwaRelVis');
  if (vc && vc.clientWidth) {
    const p = prep(vc);
    if (p) { try { drawRelVis(p.ctx, p.w, p.h, rel, 0.5); } catch (e) {} }
  }
  const qa = $('pwaQa');
  if (qa) {
    const dirTxt = rd.wDir === 'long' ? '多' : rd.wDir === 'short' ? '空' : '平';
    const html = [
      ['① 市场', `${rd.trendLabel} · 波动 ${rd.atrPct != null ? rd.atrPct.toFixed(2) + '%' : '--'}（${rd.volBand}）· 死区 ${rd.deadZone != null ? rd.deadZone.toFixed(2) + '%' : '--'} · ${rd.regimeStateTxt}`],
      ['② 基石', `Alpha ${dirTxt} ${Math.abs((rd.w || 0) * 100).toFixed(0)}% · ${rd.ageTxt} 调仓${rd.mainFac ? ' · 主因 ' + rd.mainFac.label : ''}`],
      ['③ 卫星', `SRSI ${rd.band === 'upper' ? '上带' : rd.band === 'lower' ? '下带' : '中性'} · 确认 ${rd.confirmN}/${rd.confirmNeed} · 闸门 ${rd.regimeGate === 'off' ? '关' : rd.regimeGate} · PD-A ${rd.pdDanger ? '危险 ' + rd.pdScore + '/5' : '无危险 ' + rd.pdScore + '/5'}`],
      ['④ 关系', `${rel.kind === 'resonance' ? '共振' : rel.kind === 'conflict' ? '冲突' : '中性'} 基石${dirTxt}${rel.satDir ? ' ↔ 卫星' + (rel.satDir === 'long' ? '多' : rel.satDir === 'short' ? '空' : '平') : ''}${rd.macroTf ? ' · 宏观 ' + rd.macroTf + (rel.macroAligned === true ? ' 同向' : rel.macroAligned === false ? ' 反向' : '') : ''}`]
    ].map(([b, t], i) => `<div class="pwa-qa"><span class="n">${i + 1}</span><div class="t"><b>${b}</b><p>${t}</p></div></div>`).join('');
    if (qa.__sig !== html) { qa.__sig = html; qa.innerHTML = html; }
  }
  const cl = $('pwaConcl');
  if (cl && rd.concl) {
    cl.className = 'pwa-concl' + (rd.concl.cls === 'bad' ? ' bad' : rd.concl.cls === 'good' ? ' good' : '');
    cl.innerHTML = '→ 结论：<b>' + rd.concl.txt + '</b>';
  }

  // 事件流
  const evs = loadCockpitEvents();
  const sc = $('pwaEvSpark');
  if (sc && sc.clientWidth) {
    const p = prep(sc);
    if (p) { try { drawEvSpark(p.ctx, p.w, p.h, evs, now, 12); } catch (e) {} }
  }
  const el = $('pwaEvList');
  if (el) {
    const html = renderEventsHtml(evs, now);
    if (el.__sig !== html) { el.__sig = html; el.innerHTML = html; }
  }
}

function pillar_liveTxt(alphaSig) {
  const a = alphaSig || {};
  return a.sym ? a.sym + (a.tf ? ' ' + a.tf : '') : '等待信号';
}

// ---------- 周期上下文（与 ruleMonitor.cockpitCtx 同口径） ----------
function computeCtx(sym) {
  const S = globalThis.S || {};
  const priceMap = {};
  for (const tf of ['10m', '15m', '30m', '1h', '4h', '7d', '30d']) {
    const c = S.klines && S.klines[sym] && S.klines[sym][tf];
    if (c && c.length) priceMap[tf] = c;
  }
  let horizon = null, macro = null;
  try { horizon = horizonTrend(priceMap, { capMin: THRESH.HORIZON_CAP_MIN }); } catch (e) {}
  try { macro = macroTrend(priceMap); } catch (e) {}
  return { horizon, macro, macroSpreadPct: macro ? macro.spreadPct : null };
}

// ---------- 主刷新 ----------
export function refreshShell() {
  if (typeof document === 'undefined') return;
  const api = globalThis.kchartApi;
  const cfg = api && api.getConfig ? api.getConfig() : null;
  const S = globalThis.S || {};
  const sym = (cfg && cfg.symbol) || S.sel;
  if (!sym) return;
  renderPrice(sym);
  if (_curTab !== 'kline') return;   // 其余页只需实时价
  const now = Date.now();
  const alphaSig = globalThis.__alphaSignals;
  let ctx = null;
  try { ctx = getCockpitCtx(); } catch (e) { ctx = null; }
  if (!ctx || !ctx.horizon) ctx = computeCtx(sym);
  let snap = null;
  try { snap = getLastRuleSnapshot(); } catch (e) { snap = null; }
  const pillar = buildPillarModel(alphaSig, now, globalThis.__alphaLiveW);
  const rd = buildReadoutModel({ snap, alphaSig, now, horizon: ctx && ctx.horizon, macro: ctx && ctx.macro });
  renderKpis(pillar, rd, alphaSig);
  renderCockpit(snap, alphaSig, rd, now);
}

export function initPwaShell() {
  if (typeof document === 'undefined') return;
  bindNav();
  let saved = null;
  try { saved = localStorage.getItem(TAB_KEY); } catch (e) {}
  goTab(saved || 'kline', { keepScroll: true });
  refreshShell();
  window.addEventListener('resize', () => { if (_curTab === 'kline') { startGauge(); } });
  // 标签页重新可见时补绘（canvas 在后台可能被清）
  document.addEventListener('visibilitychange', () => { if (!document.hidden && _curTab === 'kline') startGauge(); });
}

globalThis.pwaGoTab = goTab;
globalThis.pwaShellRefresh = refreshShell;
