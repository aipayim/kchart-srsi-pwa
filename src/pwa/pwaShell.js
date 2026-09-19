// PWA 重构外壳控制器（风格 A 霓虹驾驶舱）—— 仅 PWA 使用，不改主系统。
// 职责：① rail/tabbar 四页导航 ② 顶栏实时价 ③ KPI 条（真实数据）
//       ④ 盯盘右栏内联「信号驾驶舱 / 解读卡 / 事件流」（复用 signalCockpit 纯函数与绘制函数）
// 所有数据来自既有引擎：window.S / window.__alphaSignals / ruleMonitor 影子快照 / kchart cfg。
import {
  buildPillarModel, factorShares, drawPosGauge, drawWHistory,
  buildReadoutModel, drawRadar, drawRelVis, proxText, proxWarn,
  loadCockpitEvents, drawEvSpark, renderEventsHtml,
  cockpitNotifOn, setCockpitNotif
} from '../tech2/signalCockpit.js';
import { getLastRuleSnapshot, getCockpitCtx } from '../tech2/ruleMonitor.js';
import { maRelReadout as buildMaRelReadout } from '../engine/maRelation.js';
import { horizonTrend, macroTrend, blockReasonText, blockGuideText } from '../tech2/kchart.js';
import { onSignalEvent, recentSignals, renderRecentSignalsHtml, clearSignalEvents, fmtSignalTime, kindMeta, signalEventKey, signalLine, sideOf } from '../tech2/signalAlerts.js';
import { THRESH } from '../engine/thresholds.js';
import { APP_VERSION, APP_BUILD_TIME } from '../version.generated.js';

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
  setTopCollapsed(false);   // 切页恢复顶部
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
  // v1.6.28：收起态 → 一行极简摘要（趋势 · 基石仓位 · 卫星确认 · 波动分位 · 距上次调仓）
  if (kpiCollapsed()) {
    const sum = '<div class="pwa-kpi-sum">' +
      '<span>趋势 <b style="color:#22d3ee">' + (rd.trendLabel || '—') + '</b></span>' +
      '<span>基石 <b style="color:' + (w >= 0 ? '#00e676' : '#ff5252') + '">' + (wPct >= 0 ? '+' : '') + wPct + '%</b></span>' +
      '<span>卫星 <b>' + (rd.band === 'upper' ? '上带' : rd.band === 'lower' ? '下带' : '中性') + ' ' + rd.confirmN + '/' + rd.confirmNeed + '</b></span>' +
      '<span>波动 <b style="color:#ffd740">' + (rd.volBand || '中') + ' ' + volPct + '%</b></span>' +
      '<span>调仓 <b>' + (pillar.ageTxt || '--') + '</b></span>' +
      '</div>';
    if (box.__sig !== sum) { box.__sig = sum; box.innerHTML = sum; }
    return;
  }
  const kpis = [
    { k: '基石目标仓位', v: (wPct >= 0 ? '+' : '') + wPct, u: '%', c: w >= 0 ? '#00e676' : '#ff5252', ring: Math.abs(w) },
    { k: '趋势方向 · 强度', v: rd.trendLabel, u: '', c: '#22d3ee', ring: rd.trendNorm || 0 },
    { k: '波动分位 · ' + (rd.volBand || '中'), v: String(volPct), u: '%', c: '#ffd740', ring: rd.volNorm || 0 },
    { k: '卫星确认 · ' + (rd.band === 'upper' ? '上带' : rd.band === 'lower' ? '下带' : '中性'), v: rd.confirmN + '/' + rd.confirmNeed, u: '', c: '#22d3ee', ring: confPct },
    { k: '距上次调仓', v: pillar.ageTxt, u: '', c: '#7c8aa3', spark: (alphaSig && alphaSig.ws) || [] }
  ];
  const sig = JSON.stringify(kpis.map(x => [x.k, x.v, x.u, x.c]));
  if (box.__sig !== sig) {
    box.__sig = sig;
    box.innerHTML = kpis.map((x, i) => `
    <div class="pwa-card pwa-kpi">
      <div class="k"><span class="pwa-dot" style="background:${x.c};animation:none;box-shadow:none"></span>${x.k}</div>
      <div class="v" style="color:${x.c}">${x.v}${x.u ? '<small>' + x.u + '</small>' : ''}</div>
      <div class="sp"><canvas class="spark" data-i="${i}" data-kind="${x.ring !== undefined ? 'ring' : 'spark'}" data-c="${x.c}"></canvas></div>
    </div>`).join('');
  }
  // 画布每 tick 重绘（元素在签名未变时保留，不会闪）；滚动隐藏时宽度仍在，照常绘制
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

// v1.6.17：卫星接近度条——稳定 DOM（仅改 width/文本，保留 CSS 过渡与脉冲动画）
function renderProx(p) {
  const host = $('pwaProx');
  if (!host) return;
  if (!p) { host.style.display = 'none'; return; }
  if (!host.__built) {
    host.__built = true;
    host.innerHTML = '<span class="pwa-prox-lbl">③ 卫星 接近度</span>' +
      '<span class="pwa-prox-bar"><i></i></span>' +
      '<span class="pwa-prox-val"></span>' +
      '<span class="pwa-prox-warn"></span>';
  }
  host.style.display = '';
  const barI = host.querySelector('.pwa-prox-bar i');
  const val = host.querySelector('.pwa-prox-val');
  const warn = host.querySelector('.pwa-prox-warn');
  const pct = Math.round(Math.max(0, Math.min(1, p.closeness)) * 100);
  if (barI) barI.style.width = pct + '%';
  if (val) val.textContent = proxText(p);
  if (warn) warn.textContent = proxWarn(p);
  host.className = 'pwa-prox ' + (p.nearest === 'up' ? 'up' : 'down') +
    (p.inBand ? ' inband' : (p.closeness >= 0.75 ? ' near' : '')) + (p.willCross ? ' cross' : '');
}

function renderCockpit(snap, alphaSig, rd, now) {
  // 基石区
  const api0 = globalThis.kchartApi;
  const sym0 = (api0 && api0.getConfig ? api0.getConfig().symbol : null) || '';
  const facs = factorShares(alphaSig && alphaSig.factors);
  const fbox = $('pwaFactors');
  if (fbox) {
    const on = !!(api0 && api0.getConfig && api0.getConfig().alphaSignalOn);
    const emptyMsg = on
      ? '⏳ 正在计算 <b>' + (sym0 || '本币对') + '</b> 的 Alpha 信号…（首次 10~30s）'
      : '⛔ <b>' + (sym0 || '本币对') + '</b> 未启动 Alpha 信号计算 → 点上方「⚡ 启动信号引擎」（引擎开关<b>按币对独立</b>）';
    const html = facs.length ? facs.map(f => {
      const vtxt = (f.val >= 0 ? '+' : '') + f.val.toFixed(2);
      const mt = f.meta || {};
      const tip = (mt.name || f.label) + (mt.weight != null ? '（权重 ' + mt.weight + '）' : '') +
        (mt.desc ? ' — ' + mt.desc : '') + (mt.calc ? ' [' + mt.calc + ']' : '');
      return `<div class="pwa-facwrap" data-fac="${f.key}">` +
        `<div class="pwa-fac sc-${f.key}" title="${tip}"><span class="nm">${f.label}</span>` +
        `<span class="bar"><i style="width:${Math.max(0, Math.min(100, f.sharePct)).toFixed(1)}%"></i></span>` +
        `<span class="vv">${vtxt} · ${Math.round(f.sharePct)}%</span></div>` +
        `<div class="pwa-fac-detail"><b>${mt.name || f.label}</b>${mt.weight != null ? ' · 权重 ' + mt.weight : ''}<br>` +
        `${mt.desc || ''}${mt.calc ? '<br><span class="dim">' + mt.calc + '</span>' : ''}<br>` +
        `<span class="dim">当前贡献 ${vtxt}（${Math.round(f.sharePct)}% 占比，${f.val > 0 ? '偏多' : f.val < 0 ? '偏空' : '中性'}）· 条形宽度 = |贡献| ÷ 三因子|贡献|之和</span></div></div>`;
    }).join('') : '<div class="pwa-dim" style="font-size:10.5px">' + emptyMsg + '</div>';
    if (fbox.__sig !== html) { fbox.__sig = html; fbox.innerHTML = html; }
    if (!fbox.__facBound) {
      fbox.__facBound = true;
      fbox.addEventListener('click', (ev) => {
        const w = ev.target && ev.target.closest ? ev.target.closest('.pwa-facwrap') : null;
        if (!w || !(ev.target.closest('.pwa-fac'))) return;
        const on = !w.classList.contains('open');
        fbox.querySelectorAll('.pwa-facwrap.open').forEach(o => o.classList.remove('open'));
        w.classList.toggle('open', on);
      });
    }
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
  // 不再重复画布上的「w 历史（近 N 根目标仓位）」标题，只留互补信息（标的/等待）
  if (wm) wm.textContent = '组合 · ' + pillar_liveTxt(alphaSig);

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
  // v1.6.17：卫星接近度条（稳定 DOM + 宽度过渡 + 靠近脉冲/预演闪烁）
  renderProx(rd.prox);
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

// ---------- 交易页（账户 + 持仓，只读镜像引擎状态） ----------
const fmtMoney = (v) => (v == null || !isFinite(v)) ? '--' : (v >= 0 ? '' : '-') + '$' + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 2 });

function renderTrade() {
  const api = globalThis.kchartApi;
  const engine = api && api.getTradeEngine ? api.getTradeEngine() : null;
  const S = globalThis.S || {};
  const pos = Array.isArray(S.pos) ? S.pos : [];
  const spot = engine && engine.getSpotSub ? engine.getSpotSub() : null;
  const perp = engine && engine.getPerpSub ? engine.getPerpSub() : null;
  let pnl = 0;
  pos.forEach(p => { pnl += (typeof p.pnl === 'number' && isFinite(p.pnl)) ? p.pnl : 0; });
  const spotBal = spot ? (spot.bal || 0) : 0;
  const perpBal = perp ? (perp.bal || 0) : 0;
  const equity = spotBal + perpBal + pnl;

  const mBox = $('pwaAcctMetrics');
  if (mBox) {
    const pnlCls = pnl >= 0 ? 'up' : 'down';
    const html = [
      { v: (pnl >= 0 ? '+' : '') + fmtMoney(pnl), k: '浮动盈亏', c: pnlCls },
      { v: fmtMoney(equity), k: '权益', c: '' },
      { v: fmtMoney(spotBal), k: '现货 USDT', c: '' },
      { v: fmtMoney(perpBal), k: '永续 USDT', c: '' }
    ].map(m => `<div class="pwa-metric"><div class="v mono ${m.c}">${m.v}</div><div class="k">${m.k}</div></div>`).join('');
    if (mBox.__sig !== html) { mBox.__sig = html; mBox.innerHTML = html; }
  }
  const modeEl = $('pwaAcctMode');
  if (modeEl) modeEl.textContent = engine ? (engine === globalThis.__isolatedPE ? '隔离模拟' : '纸面模拟') : '未连接';

  const cnt = $('pwaPosCount');
  if (cnt) cnt.textContent = pos.length + ' 笔';
  const list = $('pwaPosList');
  if (list) {
    const html = pos.length ? pos.map((p, i) => {
      const px = ((S.prices || {})[p.sym] || {}).last;
      const pnlV = typeof p.pnl === 'number' ? p.pnl : 0;
      const pctV = typeof p.pnlPct === 'number' ? p.pnlPct : 0;
      const cls = pnlV >= 0 ? 'up' : 'down';
      const dir = p.side === 'long' ? 'l' : 's';
      const mode = p.marginMode === 'coin' ? '币本位' : 'U本位';
      return `<div class="pwa-pos">
        <div class="pwa-dirbadge ${dir}">${p.side === 'long' ? '多' : '空'}</div>
        <div class="pwa-pos-mid">
          <div class="pwa-pos-top"><b>${p.sym}</b><span class="pwa-pill">${mode}</span><span class="pwa-pill a">${p.lev || 1}x</span>${p.src === 'srsiAuto' ? '<span class="pwa-pill w">自动</span>' : ''}</div>
          <div class="pwa-pos-meta">开 ${fmtPx(p.entry)}${px != null ? ' · 标 ' + fmtPx(px) : ''}${p.tp ? ' · TP ' + fmtPx(p.tp) : ''}${p.sl ? ' · SL ' + fmtPx(p.sl) : ''}</div>
          <div class="pwa-pos-act"><button type="button" data-act="close" data-i="${i}">平仓</button><button type="button" data-act="mgr">管理</button></div>
        </div>
        <div class="pwa-pos-pnl"><div class="a mono ${cls}">${pnlV >= 0 ? '+' : ''}${fmtMoney(pnlV)}</div><div class="b mono ${cls}">${pctV >= 0 ? '+' : ''}${pctV.toFixed(2)}%</div></div>
      </div>`;
    }).join('') : '<div class="pwa-empty">暂无持仓 · 在左侧快捷合约开多/开空</div>';
    if (list.__sig !== html) { list.__sig = html; list.innerHTML = html; }
  }
}

function bindTrade() {
  const list = $('pwaPosList');
  if (list && !list.__bound) {
    list.__bound = true;
    list.addEventListener('click', (e) => {
      const b = e.target && e.target.closest ? e.target.closest('button[data-act]') : null;
      if (!b) return;
      const api = globalThis.kchartApi;
      const engine = api && api.getTradeEngine ? api.getTradeEngine() : null;
      if (b.getAttribute('data-act') === 'mgr') { if (api && api.openOrderManager) api.openOrderManager(); return; }
      const i = +b.getAttribute('data-i');
      const p = (globalThis.S.pos || [])[i];
      if (p && engine && engine.exitPosition) engine.exitPosition(p, { reason: '手动平仓(交易页)' });
      renderTrade();
    });
  }
  const mgr = $('pwaPosManage');
  if (mgr && !mgr.__bound) {
    mgr.__bound = true;
    mgr.addEventListener('click', () => { const api = globalThis.kchartApi; if (api && api.openOrderManager) api.openOrderManager(); });
  }
  const hm = $('pwaHistMore');
  if (hm && !hm.__bound) {
    hm.__bound = true;
    hm.addEventListener('click', () => { const api = globalThis.kchartApi; if (api && api.openOrderManager) api.openOrderManager({ tab: 'history' }); });
  }
}

// ---------- 回测页：把交易条内的「回测设置」区搬到回测 tab（PWA-only，幂等） ----------
function mountBtSection() {
  const host = $('pwaBtParams');
  if (!host) return;
  const inBar = document.querySelector('#kchartTradeBar .kt-bt-section');
  const inHost = host.querySelector('.kt-bt-section');
  if (inBar && inBar !== inHost) {
    if (inHost) inHost.remove();          // 交易条重建时清掉旧节点，避免两份
    host.appendChild(inBar);
  }
  const sec = inHost || inBar;
  if (sec) bindBtToggle(sec);
  ensureBtOpen();
}
// 搬走后 kchart.js 的原 toggle 处理器按 bar 查不到节点（DOM 已移出）→ 这里补上视觉切换 + 记忆
function bindBtToggle(sec) {
  const tog = sec.querySelector('#ktBtToggle'), body = sec.querySelector('#ktBtBody');
  if (!tog || !body || tog.__pwaBound) return;
  tog.__pwaBound = true;
  tog.addEventListener('click', () => {
    try { localStorage.setItem('pwa_bt_body_touched', '1'); } catch (e) {}
    const show = body.style.display === 'none';
    body.style.display = show ? '' : 'none';
    tog.textContent = show ? '▾' : '▸';
  });
}
// 回测设置默认展开（首次）；用户手动收起过则尊重（pwa_bt_body_touched）
function ensureBtOpen() {
  const tog = $('ktBtToggle'), body = $('ktBtBody');
  if (!tog || !body) return;
  let touched = false;
  try { touched = localStorage.getItem('pwa_bt_body_touched') === '1'; } catch (e) {}
  if (!touched && body.style.display === 'none') { try { tog.click(); } catch (e) {} }
}

// ---------- 最近成交（纸面，来自 S.closed） ----------
function renderTrades() {
  const S = globalThis.S || {};
  const hist = Array.isArray(S.closed) ? S.closed : [];
  const cnt = $('pwaTradeHistCount');
  if (cnt) cnt.textContent = hist.length + ' 笔';
  const box = $('pwaTradeHist');
  if (!box) return;
  const rows = hist.slice().reverse().slice(0, 8);
  const html = rows.length ? rows.map(c => {
    const d = new Date(c.t);
    const ts = isNaN(d.getTime()) ? '' : d.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const pnl = typeof c.pnl === 'number' ? c.pnl : 0;
    const cls = pnl >= 0 ? 'up' : 'down';
    const side = c.side === 'long' ? '<span class="up">多</span>' : '<span class="down">空</span>';
    return `<div class="pwa-hist-row"><span class="ts">${ts}</span><span>${c.sym}</span>${side}` +
      `<span class="mono ${cls}">${pnl >= 0 ? '+' : ''}${fmtMoney(pnl)}</span>` +
      `<span class="rs">${c.reason || ''}</span></div>`;
  }).join('') : '<div class="pwa-empty">暂无成交 · 开仓后平仓会记录在这里</div>';
  if (box.__sig !== html) { box.__sig = html; box.innerHTML = html; }
}

// ---------- 设置页（默认展开 + 通知与外观卡） ----------
const MOTION_KEY = 'pwa_motion';
function setMotion(on) {
  const app = $('pwaApp');
  if (app) app.classList.toggle('no-motion', !on);
  try { localStorage.setItem(MOTION_KEY, on ? '1' : '0'); } catch (e) {}
  const sel = $('pwaMotionSel');
  if (sel) sel.value = on ? '1' : '0';
}

function initSettings() {
  // 三张设置卡默认展开（首次）；用户手动收起后尊重（pwa_set_<id>）
  ['pwaSettings', 'pwaSrcCard', 'kchartSrsiCardWrap'].forEach(id => {
    const el = $(id);
    if (!el) return;
    const head = el.querySelector('.kchart-ovhead');
    if (head && !head.__pwaBound) {
      head.__pwaBound = true;
      head.addEventListener('click', () => { try { localStorage.setItem('pwa_set_' + id, '1'); } catch (e) {} });
    }
    let touched = false;
    try { touched = localStorage.getItem('pwa_set_' + id) === '1'; } catch (e) {}
    if (!touched) el.classList.remove('closed');
  });
  // 动效默认开
  let motionOn = true;
  try { motionOn = localStorage.getItem(MOTION_KEY) !== '0'; } catch (e) {}
  setMotion(motionOn);
  // 渲染外观卡
  const box = $('pwaAppearBody');
  if (box && !box.__built) {
    box.__built = true;
    const notifOn = cockpitNotifOn();
    box.innerHTML =
      '<div class="setting-row"><label>主题</label><span class="pwa-seg"><button type="button" class="on" disabled>霓虹驾驶舱（A）</button></span></div>' +
      '<div class="setting-row"><label>动效 Motion UI</label><select id="pwaMotionSel"><option value="1">开启</option><option value="0">关闭</option></select></div>' +
      '<div class="setting-row"><label>信号通知</label><select id="pwaNotifSel"><option value="0">关闭</option><option value="1">开启（需浏览器授权）</option></select></div>' +
      '<div class="setting-row"><label>信号页面提醒</label><select id="pwaToastSel"><option value="1">开启（顶部提示条 + 最近信号列表）</option><option value="0">关闭</option></select></div>' +
      '<div class="setting-row"><label>信号提示音</label><select id="pwaSoundSel"><option value="1">开启</option><option value="0">关闭</option></select></div>' +
      '<div class="setting-row"><label>页面缩放</label><span class="pwa-zoomctl">' +
        '<button type="button" id="pwaZoomDown">－</button><span class="pwa-dim" id="pwaZoomInfo">100%</span><button type="button" id="pwaZoomUp">＋</button><button type="button" id="pwaZoomReset2">复位</button></span></div>' +
      '<div class="setting-row"><label>本地数据</label><button type="button" id="pwaClearLocal">清空本地设置并重建</button></div>' +
      '<div class="setting-row"><label>版本</label><span class="pwa-dim mono" id="pwaVerInfo"></span></div>';
    const ms = $('pwaMotionSel');
    ms.value = motionOn ? '1' : '0';
    ms.addEventListener('change', () => setMotion(ms.value === '1'));
    const ns = $('pwaNotifSel');
    ns.value = notifOn ? '1' : '0';
    ns.addEventListener('change', () => setCockpitNotif(ns.value === '1'));
    const ts = $('pwaToastSel');
    ts.value = prefOn('toast') ? '1' : '0';
    ts.addEventListener('change', () => setAlertPref('toast', ts.value === '1'));
    const ss = $('pwaSoundSel');
    ss.value = prefOn('sound') ? '1' : '0';
    ss.addEventListener('change', () => { setAlertPref('sound', ss.value === '1'); if (ss.value === '1') unlockAudio(); });
    const zr = $('pwaZoomReset');
    if (zr) zr.addEventListener('click', () => { const l = $('pwaZoomLbl'); if (l) l.click(); });
    const zd = $('pwaZoomDown');
    if (zd) zd.addEventListener('click', () => { if (globalThis.pwaZoomStep) globalThis.pwaZoomStep(-1); syncZoomInfo(); });
    const zu = $('pwaZoomUp');
    if (zu) zu.addEventListener('click', () => { if (globalThis.pwaZoomStep) globalThis.pwaZoomStep(1); syncZoomInfo(); });
    const zr2 = $('pwaZoomReset2');
    if (zr2) zr2.addEventListener('click', () => { if (globalThis.pwaZoomReset) globalThis.pwaZoomReset(); syncZoomInfo(); });
    const cl = $('pwaClearLocal');
    if (cl) cl.addEventListener('click', () => { if (globalThis.pwaClearAll) globalThis.pwaClearAll(); });
    const vi = $('pwaVerInfo');
    if (vi) vi.textContent = 'v' + APP_VERSION + ' · ' + String(APP_BUILD_TIME).slice(0, 10);
  }
  syncZoomInfo();
}
function syncZoomInfo() {
  const zi = $('pwaZoomInfo');
  if (!zi) return;
  const l = $('pwaZoomLbl');
  zi.textContent = l ? l.textContent : '';
}

// ---------- 手机：KPI + 币对条 滚动自动隐藏（仅窄屏 CSS 生效） ----------
// v1.6.28：若用户手动收起了 KPI（.pwa-kpis.collapsed），不再叠加滚动自动隐藏（避免“摘要行也被藏掉”）
const KPI_COL_KEY = 'pwa_kpi_collapsed';
const TOOL_COL_KEY = 'pwa_tool_collapsed';
function _narrow() { try { return !!(window.matchMedia && window.matchMedia('(max-width:900px)').matches); } catch (e) { return false; } }
function _readCol(key) { try { const v = localStorage.getItem(key); return v == null ? null : v === '1'; } catch (e) { return null; } }
function _writeCol(key, on) { try { localStorage.setItem(key, on ? '1' : '0'); } catch (e) {} }
// 默认：手机收起 / 桌面展开
export function kpiCollapsed() { const v = _readCol(KPI_COL_KEY); return v == null ? _narrow() : v; }
export function toolCollapsed() { const v = _readCol(TOOL_COL_KEY); return v == null ? _narrow() : v; }
export function setKpiCollapsed(on) { _writeCol(KPI_COL_KEY, !!on); applyCollapseUI(); }
export function setToolCollapsed(on) { _writeCol(TOOL_COL_KEY, !!on); applyCollapseUI(); }
// 把两个收起状态同步到 DOM（类 + 按钮字形）
export function applyCollapseUI() {
  if (typeof document === 'undefined') return;
  const kc = kpiCollapsed(), tc = toolCollapsed();
  const kb = $('pwaKpis'), kt = $('pwaKpiToggle'), tt = $('pwaToolToggle'), tb = $('pwaToolbar');
  if (kb) kb.classList.toggle('collapsed', kc);
  if (kt) { kt.textContent = kc ? '⌄' : '⌃'; kt.title = kc ? '展开指标栏' : '收起指标栏'; }
  if (tb) tb.classList.toggle('collapsed', tc);
  if (tt) { tt.textContent = tc ? '⌄' : '⌃'; tt.title = tc ? '展开主图工具面板' : '收起主图工具面板（收起后只留信号摘要条）'; }
  if (kc && !tc) setTopCollapsed(false);   // 手动收起 KPI 时不同时叠滚动隐藏
  if (kb) kb.__sig = null;                 // 强制下次 renderKpis 重建（展开/收起切换形态）
}
function bindCollapseToggles() {
  const kt = $('pwaKpiToggle');
  if (kt && !kt.__bound) { kt.__bound = true; kt.addEventListener('click', () => { setKpiCollapsed(!kpiCollapsed()); try { refreshShell(); } catch (e) {} }); }
  const tt = $('pwaToolToggle');
  if (tt && !tt.__bound) { tt.__bound = true; tt.addEventListener('click', () => { setToolCollapsed(!toolCollapsed()); try { refreshShell(); } catch (e) {} }); }
}

function setTopCollapsed(on) {
  const app = $('pwaApp');
  if (!app) return;
  if (on && kpiCollapsed()) return;        // 手动收起时不叠滚动自动隐藏
  app.classList.toggle('pwa-top-collapsed', !!on);
}
function bindTopAutoHide() {
  const scroller = $('pwaContent');
  if (!scroller || scroller.__topBound) return;
  scroller.__topBound = true;
  let lastY = scroller.scrollTop || 0;
  scroller.addEventListener('scroll', () => {
    const y = scroller.scrollTop;
    if (y <= 24) { setTopCollapsed(false); lastY = y; return; }   // 回顶：立即显示
    if (y - lastY > 8) setTopCollapsed(true);                     // 向下：收起
    else if (lastY - y > 8) setTopCollapsed(false);               // 向上：显示
    lastY = y;
  }, { passive: true });
}

// ---------- 主图信号摘要条（不滚动即可见） ----------
function renderSigBar(snap, rd) {
  const box = $('pwaSigBar');
  if (!box) return;
  const api = globalThis.kchartApi;
  const cfg = api && api.getConfig ? api.getConfig() : null;
  const mainTF = (cfg && cfg.mainTF) || '--';
  const t = rd.trendLabel || '--';
  const tCls = t === '趋势上' ? 'long' : t === '趋势下' ? 'short' : '';
  const wDir = rd.wDir === 'long' ? '多' : rd.wDir === 'short' ? '空' : '平';
  const wCls = rd.wDir === 'long' ? 'long' : rd.wDir === 'short' ? 'short' : '';
  const band = rd.band === 'upper' ? '上带' : rd.band === 'lower' ? '下带' : '中性';
  const k = snap && snap.k != null ? snap.k.toFixed(1) : '--';
  const d = snap && snap.d != null ? snap.d.toFixed(1) : '--';
  const html =
    `<span class="sdir ${tCls}">${t}</span>` +
    `<span class="sdir ${wCls}">基石 ${wDir} ${Math.abs((rd.w || 0) * 100).toFixed(0)}%</span>` +
    `<span class="sitem">卫星 <b>${band}</b> 确认 <b>${rd.confirmN}/${rd.confirmNeed}</b></span>` +
    `<span class="sitem">${mainTF} K<b>${k}</b> D<b>${d}</b></span>` +
    `<span class="sitem">PD <b>${rd.pdDanger ? '危险' : rd.pdScore + '/5'}</b></span>` +
    (rd.concl ? `<span class="sconcl">→ ${rd.concl.txt}</span>` : '');
  if (box.__sig !== html) { box.__sig = html; box.innerHTML = html; }
}

// ---------- 主图卡头部：周期切换器（‹ ›） ----------
function cycleMainTF(dir) {
  const api = globalThis.kchartApi;
  if (!api || !api.setMainTF || !api.getConfig) return;
  const cfg = api.getConfig();
  const list = (globalThis.KLINE_TF_LIST || ['1m','5m','10m','15m','30m','1h','4h','8h','1d','7d','30d']);
  const i = list.indexOf(cfg.mainTF);
  const n = list.length;
  const next = list[((i < 0 ? 0 : i) + dir + n) % n];
  api.setMainTF(next);
}
function renderTfCycle() {
  const el = $('pwaTfCur');
  if (!el) return;
  const api = globalThis.kchartApi;
  const cfg = api && api.getConfig ? api.getConfig() : null;
  const tf = (cfg && cfg.mainTF) || '--';
  if (el.textContent !== tf) el.textContent = tf;
}
function bindTfCycle() {
  const prev = $('pwaTfPrev'), next = $('pwaTfNext');
  if (prev && !prev.__bound) { prev.__bound = true; prev.addEventListener('click', () => cycleMainTF(-1)); }
  if (next && !next.__bound) { next.__bound = true; next.addEventListener('click', () => cycleMainTF(1)); }
}

// ---------- 工具栏 ⚙ / 币对弹层 ----------
function bindToolbar() {
  const btn = $('pwaToolMore'), bar = $('pwaToolbar');
  if (btn && bar && !btn.__bound) {
    btn.__bound = true;
    let open = false;
    try { open = localStorage.getItem('pwa_tool_more') === '1'; } catch (e) {}
    const apply = (v) => { bar.classList.toggle('more-open', v); btn.classList.toggle('on', v); btn.setAttribute('aria-expanded', v ? 'true' : 'false'); };
    apply(open);
    btn.addEventListener('click', () => {
      open = !open;
      apply(open);
      try { localStorage.setItem('pwa_tool_more', open ? '1' : '0'); } catch (e) {}
    });
  }
  const tog = $('pwaSymToggle');
  if (tog && !tog.__bound) {
    tog.__bound = true;
    tog.addEventListener('click', (e) => {
      e.stopPropagation();
      const app = $('pwaApp');
      if (app) app.classList.toggle('symopen');
    });
    // 点面板内任意按钮 / 点外部 → 关闭
    document.addEventListener('click', (e) => {
      const app = $('pwaApp');
      if (!app || !app.classList.contains('symopen')) return;
      const t = e.target;
      if (t && t.closest && (t.closest('#pwaSymbar') || t.closest('#pwaSymToggle'))) {
        if (t.closest('#pwaSymbar') && t.closest('button')) setTimeout(() => app.classList.remove('symopen'), 150);
        return;
      }
      app.classList.remove('symopen');
    });
  }
}

// ---------- 首次进入：窄屏默认精简（子图 2 个 / 纪律面板收起 / 驾驶舱收起），减少长页滑动 ----------
function isNarrow() {
  return (typeof window.matchMedia === 'function')
    && (window.matchMedia('(max-width:900px)').matches || window.matchMedia('(pointer:coarse)').matches);
}
function applyPhoneDefaults() {
  const api = globalThis.kchartApi;
  try {
    // ① 子图精简
    if (localStorage.getItem('pwa_sub_default') !== '1') {
      localStorage.setItem('pwa_sub_default', '1');
      if (isNarrow() && api && api.setKPreset) {
        const c = api.getConfig ? api.getConfig() : null;
        const n = c ? Object.keys(c.klineSel || {}).filter(k => c.klineSel[k]).length : 0;
        if (n > 4) api.setKPreset('mini');
      }
    }
    // ② 纪律面板：窄屏首次默认收起（信号摘要条已给结论）
    if (localStorage.getItem('pwa_disc_default') !== '1') {
      localStorage.setItem('pwa_disc_default', '1');
      const c = api && api.getConfig ? api.getConfig() : null;
      if (isNarrow() && c && c.discOpen && api.toggleKDisc) api.toggleKDisc();
    }
    // ③ 驾驶舱三卡：窄屏首次默认收起
    if (localStorage.getItem('pwa_cockpit_acc') !== '1') {
      localStorage.setItem('pwa_cockpit_acc', '1');
      if (isNarrow()) applyCockpitAcc(true);
    }
  } catch (e) { /* ignore */ }
}
function applyCockpitAcc(collapsed) {
  document.querySelectorAll('.pwa-card[data-acc]').forEach(card => {
    card.classList.toggle('closed', !!collapsed);
    try { localStorage.setItem('pwa_acc_' + card.getAttribute('data-acc'), collapsed ? '0' : '1'); } catch (e) {}
  });
}
function bindCockpitAcc() {
  document.querySelectorAll('.pwa-card[data-acc]').forEach(card => {
    const head = card.querySelector('.pwa-acc-h');
    if (!head || head.__bound) return;
    head.__bound = true;
    // 恢复上次状态（窄屏默认收起由 applyPhoneDefaults 处理）
    try {
      const saved = localStorage.getItem('pwa_acc_' + card.getAttribute('data-acc'));
      if (saved === '0') card.classList.add('closed');
      else if (saved === '1') card.classList.remove('closed');
    } catch (e) {}
    head.addEventListener('click', () => {
      const closed = card.classList.toggle('closed');
      try { localStorage.setItem('pwa_acc_' + card.getAttribute('data-acc'), closed ? '0' : '1'); } catch (e) {}
      if (!closed) refreshShell();   // 展开时立即补绘 canvas
    });
  });
}

// ---------- 信号引擎：真实状态 + 一键启动 + 实时提醒（2026-09-18 审计修复） ----------
// 审计根因：4 个开关分散在 3 个 tab 且默认全关，驾驶舱却用装饰性徽章「★基石 ⚠卫星」假装在跑。
// 这里把状态**如实**显示，并提供一次点击把「Alpha 信号 + Alpha paper 实盘 + SRSI 卫星自动 + 15m 优选」全部拉起。
const ALERT_PREFS = {
  toast: { key: 'pwa_alert_toast', def: true },
  sound: { key: 'pwa_alert_sound', def: true }
};
function prefOn(name) {
  const p = ALERT_PREFS[name]; if (!p) return false;
  try { const v = localStorage.getItem(p.key); return v == null ? p.def : v === '1'; } catch (e) { return p.def; }
}
function setAlertPref(name, on) { const p = ALERT_PREFS[name]; if (!p) return; try { localStorage.setItem(p.key, on ? '1' : '0'); } catch (e) {} }

let _toastN = 0;
function showToast(ev) {
  const host = $('pwaToastHost'); if (!host) return;
  const m = kindMeta(ev.kind, sideOf(ev));
  const el = document.createElement('div');
  el.className = 'pwa-toast ' + (m.severity === 'trade' ? 'trade' : m.severity === 'preview' ? 'preview' : 'signal');
  el.style.borderLeftColor = m.color;
  // v1.6.26：主图标记符前缀到信号名前（与「最近信号」/主图图例同形）
  let rest = signalLine(ev);
  if (m.icon && rest.indexOf(m.icon + ' ') === 0) rest = rest.slice(m.icon.length + 1);
  rest = rest.replace(m.label, '').replace(/^\s+/, '');
  el.innerHTML = '<b style="color:' + m.color + '">' + (m.icon ? m.icon + ' ' : '') + m.label + '</b>' +
    (rest ? '<span>' + rest + '</span>' : '') +
    '<span class="pwa-toast-t">' + fmtSignalTime(ev.ts) + '</span>';
  host.appendChild(el);
  _toastN++;
  setTimeout(() => { try { el.classList.add('out'); } catch (e) {} }, 6000);
  setTimeout(() => { try { el.remove(); } catch (e) {} }, 6800);
  while (host.children.length > 4) host.removeChild(host.firstChild);
}

let _audioCtx = null;
// 浏览器策略：AudioContext 必须在**用户手势**里解锁，否则首个信号时的 beep 会被静默阻止。
// 因此在「⚡ 启动信号引擎」/切换提示音开关时调用本函数（带一个 0 音量 blip）。
function unlockAudio() {
  try {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return;
    if (!_audioCtx) _audioCtx = new AC();
    if (_audioCtx.state === 'suspended') { try { _audioCtx.resume(); } catch (e) {} }
    const o = _audioCtx.createOscillator(), g = _audioCtx.createGain();
    g.gain.value = 0.0001;
    o.connect(g); g.connect(_audioCtx.destination);
    o.start(); o.stop(_audioCtx.currentTime + 0.02);
  } catch (e) { /* 无声环境忽略 */ }
}
function beep(sev) {
  try {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return;
    if (!_audioCtx) _audioCtx = new AC();
    if (_audioCtx.state === 'suspended') { try { _audioCtx.resume(); } catch (e) {} }
    const o = _audioCtx.createOscillator(), g = _audioCtx.createGain();
    o.type = 'sine'; o.frequency.value = sev === 'trade' ? 1180 : 880;
    o.connect(g); g.connect(_audioCtx.destination);
    const t = _audioCtx.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.07, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    o.start(t); o.stop(t + 0.36);
  } catch (e) { /* 无声环境忽略 */ }
}
function notifyDesktop(ev) {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    if (!cockpitNotifOn()) return;
    const n = new Notification('信号 · ' + (ev.sym || ''), { body: signalLine(ev), tag: signalEventKey(ev), silent: true });
    setTimeout(() => { try { n.close(); } catch (e) {} }, 9000);
  } catch (e) { /* 通知不可用忽略 */ }
}
// 订阅提醒总线：toast / 声音 / 桌面通知 + 刷新「最近信号」列表
export function installSignalAlertSink() {
  if (globalThis.__signalAlertSink) return;
  globalThis.__signalAlertSink = true;
  onSignalEvent((ev) => {
    if (ev) {
      const sev = kindMeta(ev.kind).severity;
      if (prefOn('toast')) showToast(ev);
      if (prefOn('sound') && sev !== 'preview') beep(sev);
      notifyDesktop(ev);
    }
    renderRecentSignals();
  });
}
function renderMaRel() {
  const card = $('pwaMaRelCard');
  if (!card) return;
  const api = globalThis.kchartApi;
  const cfg = api && api.getConfig ? api.getConfig() : null;
  const on = !!(cfg && cfg.maRelOn);
  card.style.display = on ? '' : 'none';
  if (!on) return;
  let data = null;
  try { data = api.__maRelData ? api.__maRelData() : null; } catch (e) { data = null; }
  const box = $('pwaMaRel');
  const pill = $('pwaMaRelPill');
  const foot = $('pwaMaRelFoot');
  if (!box) return;
  if (!data) {
    if (box.__sig !== 'nodata') { box.__sig = 'nodata'; box.innerHTML = '<div class="sig-alert-empty">⏳ 正在计算均线关系…（需本周期 K 线与日线/周线数据就绪）</div>'; }
    if (pill) pill.textContent = '—';
    if (foot) foot.textContent = '';
    return;
  }
  let ro = null;
  try { ro = buildMaRelReadout(data); } catch (e) { ro = null; }
  if (!ro) return;
  const toneCol = ro.tone === 'bull' ? '#2ecc71' : ro.tone === 'bear' ? '#ff6b6b' : ro.tone === 'range' ? '#f59e0b' : '#8b95a5';
  if (pill) { pill.textContent = (ro.tone === 'bull' ? '偏多' : ro.tone === 'bear' ? '偏空' : ro.tone === 'range' ? '震荡' : '未启用'); pill.style.color = toneCol; }
  // 行样式复用「最近信号」(.sig-ev) 的表达方式：图标 + 彩色标签 + 说明
  const sig = JSON.stringify([ro.tone, ro.verdict, ro.rows.map(r => [r.icon, r.label, r.detail])]);
  if (box.__sig !== sig) {
    box.__sig = sig;
    box.innerHTML = ro.rows.map(r =>
      '<div class="sig-ev sig-ev-signal" style="border-left-color:' + r.color + '">' +
        '<span class="sig-ev-i" style="color:' + r.color + '">' + r.icon + '</span>' +
        '<span class="sig-ev-k" style="color:' + r.color + '">' + r.label + '</span>' +
        '<span class="sig-ev-d">' + (r.detail || '') + '</span>' +
      '</div>').join('');
  }
  if (foot) {
    const t = '→ ' + ro.verdict;
    if (foot.__t !== t) { foot.__t = t; foot.textContent = t; foot.style.color = toneCol; }
  }
}

function renderRecentSignals() {
  const box = $('pwaRecentSig');
  const c = $('pwaSigCount');
  if (c) { c.textContent = recentSignals(999).length + ' 条'; }
  if (!box) return;
  const html = renderRecentSignalsHtml(30);   // v1.6.25：上限 100 条 → 面板多展示（容器可滚动）
  if (box.__sig !== html) { box.__sig = html; box.innerHTML = html; }
}

// 引擎状态行（★/⚠ 徽章 + 一键启动 + 阻塞原因）——「如实显示」是本次修复的核心
function renderEngineBar() {
  const box = $('pwaEngineBar');
  const api = globalThis.kchartApi;
  if (!api || !api.signalEngineStatus) return;
  let st = null;
  try { st = api.signalEngineStatus(); } catch (e) { st = null; }
  if (!st) return;
  const pa = $('pwaPillAlpha'), ps = $('pwaPillSrsi');
  if (pa) { pa.textContent = '★ 基石 ' + (st.alphaRunning ? '●' : '○'); pa.className = 'pwa-pill pwa-eng-pill ' + (st.alphaRunning ? 'on' : 'off'); }
  if (ps) { ps.textContent = '⚠ 卫星 ' + (st.srsiRunning ? '●' : '○'); ps.className = 'pwa-pill pwa-eng-pill ' + (st.srsiRunning ? 'on' : 'off'); }
  if (!box) return;
  const sig = [st.sym, st.runningHere, st.srsiAutoOn, st.optReady15m, st.alphaSignalOn, st.alphaData, st.alphaDataSym, st.alphaLive, st.liveSym, st.blockers.join('|'), st.lastBlock ? st.lastBlock.reason + '@' + st.lastBlock.ts : ''].join('~');
  if (box.__sig === sig) return;
  box.__sig = sig;
  if (st.runningHere) {
    const parts = [];
    parts.push(st.srsiRunning ? '卫星自动 ●' : '卫星 ○（' + (st.srsiAutoOn ? '15m 未优选' : '未开启') + '）');
    parts.push(st.alphaLiveHere ? '基石实盘 ● ' + st.sym : '基石实盘 ○');
    if (st.alphaSignalOn) parts.push('Alpha 信号 ' + (st.alphaData ? '●' : '…'));
    box.className = 'pwa-engine on';
    box.innerHTML = '<div class="pe-row"><span class="pe-state on">● 本币对（' + st.sym + '）信号引擎运行中</span>' +
      '<span class="pe-parts">' + parts.join(' · ') + '</span>' +
      '<button class="pe-btn ghost" id="pwaEngineStop">停止</button></div>' +
      engineNotesHtml(st);
  } else {
    box.className = 'pwa-engine off';
    box.innerHTML = '<div class="pe-row"><span class="pe-state off">⛔ 本币对（' + st.sym + '）信号引擎未启动 — 不会有任何交易信号</span>' +
      '<button class="pe-btn" id="pwaEngineStart">⚡ 启动信号引擎</button></div>' +
      '<div class="pe-why">' + st.blockers.map(b => '· ' + b).join('<br>') + '</div>' +
      engineNotesHtml(st);
  }
  const bs = $('pwaEngineStart'), bp = $('pwaEngineStop'), br = $('pwaEngineRetarget'), bm = $('pwaEngineModeUsdt');
  if (bs) bs.addEventListener('click', () => { startSignalEngine(); });
  if (bp) bp.addEventListener('click', () => { stopSignalEngine(); });
  if (br) br.addEventListener('click', () => { retargetLiveToCurrent(); });
  if (bm) bm.addEventListener('click', () => {
    try { if (api.setSrsiAutoMode) api.setSrsiAutoMode('usdt'); } catch (e) {}
    box.__sig = ''; renderEngineBar();
  });
}
// 状态条下方的「如实说明」：引擎开关与优选**按币对独立**；基石实盘可能盯另一个币对
function engineNotesHtml(st) {
  const notes = [];
  notes.push('引擎开关与 15m 优选<b>按币对独立</b>：每个币对需各自启动一次。');
  if (!st.runningHere && st.alphaLive && st.liveSym && st.liveSym !== st.sym) notes.push('注：其它币对 <b>' + st.liveSym + '</b> 的基石实盘仍在运行（不随切币对停止）。');
  if (st.runningHere && st.liveElsewhere) notes.push('基石实盘正盯 <b>' + st.liveSym + '</b>（与当前查看的 ' + st.sym + ' 不同） <button class="pe-btn tiny" id="pwaEngineRetarget">改为盯本币对</button>');
  if (!st.alphaData && st.alphaSignalOn) notes.push('本币对 <b>' + st.sym + '</b> 的 Alpha 信号正在计算（首次 10~30s）。');
  if (st.alphaStale) notes.push('上次 Alpha 计算的是 <b>' + st.alphaDataSym + '</b>。');
  // v1.6.16：如实显示卫星「最近一次拦截原因」——不再静默
  if (st.lastBlock) {
    const b = st.lastBlock;
    const tm = new Date(b.ts).toLocaleTimeString('zh-CN', { hour12: false });
    notes.push('⛔ <b>卫星最近拦截</b>：' + (b.side === 'long' ? '开多' : '开空') + ' · ' + blockReasonText(b.reason) + ' · ' + tm);
    const g = blockGuideText(b.reason, st.sym);
    if (g) notes.push('💡 ' + g + (b.reason === 'coin-inventory-0' ? ' <button class="pe-btn tiny" id="pwaEngineModeUsdt">改用 U 本位开多</button>' : ''));
  }
  return '<div class="pe-why">' + notes.join('<br>') + '</div>';
}
// 把基石实盘改盯当前币对（显式按钮触发，不静默切换）
function retargetLiveToCurrent() {
  const api = globalThis.kchartApi;
  const sym = api && api.getConfig ? api.getConfig().symbol : null;
  if (!sym) return;
  try { if (globalThis.__alphaLab && globalThis.__alphaLab.retargetLive) globalThis.__alphaLab.retargetLive(sym); } catch (e) {}
  const box = $('pwaEngineBar'); if (box) box.__sig = '';
  renderEngineBar();
}

// 一键启动：Alpha 信号计算 → （缺 15m 优选则自动跑一次）→ SRSI 卫星自动 → Alpha paper 实盘
export async function startSignalEngine() {
  const api = globalThis.kchartApi;
  const box = $('pwaEngineBar');
  const setMsg = (t) => { if (box) { box.className = 'pwa-engine busy'; box.innerHTML = '<div class="pe-row"><span class="pe-state">⏳ ' + t + '</span></div>'; box.__sig = ''; } };
  if (!api) return { ok: false, err: 'kchartApi 未就绪' };
  unlockAudio();   // 用户手势内解锁提示音（否则首个信号无声）
  try {
    setMsg('开启 Alpha 信号计算…');
    if (api.setAlphaSignal) await api.setAlphaSignal(true);
    const cfg = api.getConfig ? api.getConfig() : {};
    if (!(cfg.srsiOptSource && cfg.srsiOptSource['15m'] === 'optimized')) {
      setMsg('15m 未优选 → 自动优选（约 1-3 分钟，期间可继续盯盘）…');
      try { if (api.optimizeSrsiForTf) await api.optimizeSrsiForTf('15m', 'swing', { sym: cfg.symbol }); } catch (e) { /* 优选失败不阻断其它开关 */ }
    }
    setMsg('开启 SRSI 卫星自动交易…');
    try { if (api.setSrsiAutoOn) api.setSrsiAutoOn(true); } catch (e) {}
    setMsg('启动 Alpha 基石 paper 实盘…');
    try {
      const lab = globalThis.__alphaLab;
      if (lab && lab.startLive) {
        // 基石实盘只盯一个币对：一键启动始终把实盘目标设为**当前币对**（显式、可预期）
        if (lab.isLive && lab.isLive() && lab.liveSymbol && lab.liveSymbol() !== cfg.symbol && lab.retargetLive) lab.retargetLive(cfg.symbol);
        else if (!(lab.isLive && lab.isLive())) lab.startLive(cfg.symbol);
      }
    } catch (e) {}
    if (box) box.__sig = '';
    renderEngineBar();
    try { if (api.render) api.render(); } catch (e) {}
    return { ok: true };
  } catch (e) {
    if (box) box.__sig = '';
    renderEngineBar();
    return { ok: false, err: String((e && e.message) || e) };
  }
}
export function stopSignalEngine() {
  const api = globalThis.kchartApi;
  try { if (api && api.setSrsiAutoOn) api.setSrsiAutoOn(false); } catch (e) {}
  // 只停「本币对」的基石实盘：若实盘盯的是别的币对，不越权停止它
  try {
    const lab = globalThis.__alphaLab;
    const sym = api && api.getConfig ? api.getConfig().symbol : null;
    if (lab && lab.isLive && lab.isLive() && (!lab.liveSymbol || !sym || lab.liveSymbol() === sym) && lab.stopLive) lab.stopLive();
  } catch (e) {}
  const box = $('pwaEngineBar'); if (box) box.__sig = '';
  renderEngineBar();
  try { if (api && api.render) api.render(); } catch (e) {}
}
function bindEngine() {
  installSignalAlertSink();
  const clr = $('pwaSigClear');
  if (clr && !clr.__bound) { clr.__bound = true; clr.addEventListener('click', () => { clearSignalEvents(); renderRecentSignals(); }); }
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
  mountBtSection();
  if (_curTab === 'trade') { renderTrade(); renderTrades(); return; }
  if (_curTab !== 'kline') return;   // 其余页只需实时价
  const now = Date.now();
  // 基石(Alpha)信号**按币对**取：切币对后不再显示上一个币对的旧值（2026-09-18 修复）
  const alphaSig = (globalThis.__alphaSignalsBySym || {})[sym] || null;
  let ctx = null;
  try { ctx = getCockpitCtx(); } catch (e) { ctx = null; }
  if (!ctx || !ctx.horizon) ctx = computeCtx(sym);
  let snap = null;
  try { snap = getLastRuleSnapshot(); } catch (e) { snap = null; }
  const pillar = buildPillarModel(alphaSig, now, globalThis.__alphaLiveW);
  const rd = buildReadoutModel({ snap, alphaSig, now, horizon: ctx && ctx.horizon, macro: ctx && ctx.macro, proximity: (() => { try { return api.srsiProximityNow ? api.srsiProximityNow(sym, '15m') : null; } catch (e) { return null; } })() });
  renderKpis(pillar, rd, alphaSig);
  renderCockpit(snap, alphaSig, rd, now);
  renderSigBar(snap, rd);
  renderTfCycle();
  renderEngineBar();
  renderRecentSignals();
  renderMaRel();
}

export function initPwaShell() {
  if (typeof document === 'undefined') return;
  bindNav();
  bindTrade();
  bindTopAutoHide();
  bindToolbar();
  bindTfCycle();
  bindCollapseToggles();
  applyCollapseUI();
  initSettings();
  bindCockpitAcc();
  bindEngine();
  applyPhoneDefaults();
  // 回测页：Alpha 实验室默认展开（首次；用户手动收起后由 __alphaLabHead 写入 pwa_alpha_open 尊重）
  try { if (localStorage.getItem('pwa_alpha_open') == null) localStorage.setItem('pwa_alpha_open', '1'); } catch (e) {}
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
