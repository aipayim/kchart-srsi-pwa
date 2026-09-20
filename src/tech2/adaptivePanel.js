// 自适应组合 UI 面板 —— 纯模型 + HTML 构建器 + PWA DOM 渲染。
// 只依赖 globalThis，不 import legacy.js / kchartApp.js / adaptivePortfolio.js（避免循环依赖）。
// 数据源：window.__adaptivePortfolio（API 见 notebook adaptive-portfolio-impl）。
// 设计：$1000 纸面组合，默认 disabled；渲染层只读，不推进引擎状态。
// 关键：渲染必须走签名守卫（值未变不重建 DOM），否则每秒 tick 会闪屏/丢焦点。

const _finite = (v) => (Number.isFinite(v) ? v : null);
const _num = (v, d = 0) => { const n = _finite(v); return n == null ? '—' : n.toFixed(d); };
const _usd = (v, d = 2) => { const n = _finite(v); return n == null ? '—' : '$' + (Math.abs(n) >= 1000 ? n.toFixed(0) : n.toFixed(d)); };
const _pct = (v) => { const n = _finite(v); return n == null ? '—' : (n * 100).toFixed(0) + '%'; };
const _signedPct = (v) => { const n = _finite(v); return n == null ? '—' : (n >= 0 ? '+' : '') + (n * 100).toFixed(0) + '%'; };
const _qty = (v) => { const n = _finite(v); return n == null ? '—' : n.toFixed(4); };
const _esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const _hhmm = (ts) => {
  if (!Number.isFinite(ts)) return '--:--';
  const d = new Date(ts), p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes());
};

/** 波动率分位分桶：q 0..1 → 低波(<1/3) / 中波(<2/3) / 高波 / —（非有限）。 */
export function bucketLabel(q) {
  if (!Number.isFinite(q)) return '—';
  if (q < 1 / 3) return '低波';
  if (q < 2 / 3) return '中波';
  return '高波';
}

// 引擎事件里 from/to 存的是桶枚举 'low'/'mid'/'high'/'na'，这里统一转中文（数字则走 bucketLabel）。
function bucketText(v) {
  if (v === 'low') return '低波';
  if (v === 'mid') return '中波';
  if (v === 'high') return '高波';
  if (v === 'na') return '—';
  if (Number.isFinite(v)) return bucketLabel(v);
  return v == null ? '—' : String(v);
}

/** 事件 → { icon, text, color }（纯函数，缺字段兜底不抛）。 */
export function eventLabel(e) {
  const ev = e || {};
  switch (ev.type) {
    case 'volQ_cross':
      return { icon: '🌡', text: `波动率分位 ${bucketText(ev.from)}→${bucketText(ev.to)}（w_A ${_pct(ev.wA)}%）`, color: '#22d3ee' };
    case 'carry_rebalance':
      return { icon: '⚖', text: `carry 再平衡 名义 ${_finite(ev.notional) == null ? '—' : '$' + Number(ev.notional).toFixed(2)}（w_C ${_pct(ev.wC)}%）`, color: '#f59e0b' };
    case 'alpha_reweight': {
      const n = _finite(ev.notional);
      return { icon: 'α', text: n == null ? 'Alpha 调仓 → —' : `Alpha 调仓 → ${n >= 0 ? '多' : '空'} $${Math.abs(n).toFixed(2)}`, color: '#a78bfa' };
    }
    case 'funding': {
      const pay = _finite(ev.pay), cum = _finite(ev.cum);
      return { icon: '💰', text: pay == null ? '资金费 —' : `资金费 ${pay >= 0 ? '收' : '付'} $${Math.abs(pay).toFixed(2)}（累计 ${cum == null ? '—' : '$' + cum.toFixed(2)}）`, color: '#00E676' };
    }
    case 'enable': return { icon: '▶', text: '组合已启用', color: '#2ecc71' };
    case 'disable': return { icon: '⏸', text: '组合已停用', color: '#8899aa' };
    case 'carry_error': return { icon: '⚠', text: `carry 错误：${ev.reason || ''}`, color: '#ff6b6b' };
    default: return { icon: '·', text: ev.type == null ? '—' : String(ev.type), color: '#8899aa' };
  }
}

/** window.__adaptivePortfolio → 渲染模型（不可用时 { available:false }，不抛）。 */
export function buildAdaptiveModel(ap) {
  if (!ap || typeof ap.getState !== 'function') return { available: false };
  let state = null;
  try { state = ap.getState(); } catch (e) { return { available: false }; }
  if (!state || typeof state !== 'object') return { available: false };
  let events = [];
  try { events = typeof ap.getEvents === 'function' ? ap.getEvents(80) : []; } catch (e) { events = []; }
  if (!Array.isArray(events)) events = [];
  const ps = (state.perSymbol && typeof state.perSymbol === 'object') ? state.perSymbol : {};
  const symbols = Object.keys(ps).map((sym) => {
    const s = ps[sym] || {};
    return {
      sym, volQ: s.volQ, g: s.g, wA: s.wA, wC: s.wC,
      warming: !!s.warming, bucket: s.bucket,
      alphaTarget: s.alphaTarget, alphaW: s.alphaW,
      carry: s.carry || null, err: s.err || null,
    };
  });
  const evs = events.slice(-15).reverse().map((e) => ({
    ts: e && e.ts, type: e && e.type, sym: e && e.sym, label: eventLabel(e),
  }));
  return {
    available: true,
    enabled: !!state.enabled,
    warming: !!state.warming,
    equity: state.equity, realized: state.realized,
    capital: state.capital, w0: state.w0, mode: state.mode,
    symbols, events: evs,
  };
}

/** 顶部指标行：regime 徽章 + 组合权益 + 启用状态 + 启用/重置按钮。 */
export function adaptiveMetricsHtml(m) {
  if (!m || !m.available) return '<div class="adp-empty">自适应组合未初始化</div>';
  const s0 = (m.symbols && m.symbols[0]) || {};
  const bucket = (s0.bucket && s0.bucket !== 'na') ? bucketText(s0.bucket) : bucketLabel(s0.volQ);
  const warm = m.warming || s0.warming;
  const badge = `<span class="adp-badge">${bucket}`
    + `${s0.volQ != null ? ' · volQ ' + _num(s0.volQ, 2) : ''}`
    + `${s0.wA != null ? ' · w_A ' + _pct(s0.wA) : ''}`
    + `${s0.wC != null ? ' · w_C ' + _pct(s0.wC) : ''}`
    + `${warm ? ' · 预热中' : ''}</span>`;
  const eq = `<span class="adp-eq">权益 <b>${_usd(m.equity)}</b> <span class="adp-dim">/ 起始 ${_usd(m.capital)}</span></span>`;
  const st = `<span class="adp-state ${m.enabled ? 'on' : 'off'}">${m.enabled ? '● 运行中' : '○ 未启用'}</span>`;
  const btns = `<button class="adp-btn" onclick="window.adaptiveToggle()">${m.enabled ? '停用' : '启用'}</button>`
    + `<button class="adp-btn adp-btn2" onclick="window.adaptiveReset()">重置</button>`;
  const hint = m.enabled ? '' : '<div class="adp-empty">组合未启用（点启用开始纸面记录）</div>';
  return `<div class="adp-head">${badge}${eq}${st}<span class="adp-spacer"></span>${btns}</div>${hint}`;
}

/** 两腿（每币一行）：权重 + carry 腿明细。 */
export function adaptiveLegsHtml(m) {
  if (!m || !m.available) return '';
  if (!m.symbols || !m.symbols.length) return '<div class="adp-empty">暂无币种</div>';
  const rows = m.symbols.map((s) => {
    const c = s.carry || {};
    const bucket = (s.bucket && s.bucket !== 'na') ? bucketText(s.bucket) : bucketLabel(s.volQ);
    const carryTxt = s.carry
      ? `carry 腿：现货 ${_qty(c.spotQty)} / 永续 ${_qty(c.perpQty)} · 保证金 ${_usd(c.margin)} · 名义 ${_usd(c.notional)} · 资金费 ${_usd(c.fundingCum)} · 再平衡 ${_num(c.rebalCount)}`
      : 'carry 腿：—';
    const at = _finite(s.alphaTarget);
    const dirTxt = at == null ? '' : (Math.abs(at) < 0.02 ? '（空仓）' : (at > 0 ? '（做多）' : '（做空）'));
    const alphaTxt = `Alpha 腿：目标 ${_signedPct(s.alphaTarget)}${dirTxt}→ 有效 ${_signedPct(s.alphaW)}（权重 ${_pct(s.wA)}）`;
    return `<div class="adp-leg"><div class="adp-leg-h">${_esc(s.sym)} `
      + `<span class="adp-dim">${bucket} · volQ ${_num(s.volQ, 2)} · g ${_num(s.g, 2)} · w_A ${_pct(s.wA)} · w_C ${_pct(s.wC)}${s.warming ? ' · 预热中' : ''}</span></div>`
      + `<div class="adp-leg-c adp-leg-alpha">${alphaTxt}</div>`
      + `<div class="adp-leg-c">${carryTxt}</div></div>`;
  });
  return `<div class="adp-legs">${rows.join('')}</div>`;
}

/** 事件流（最新在前，最多 15 条）。 */
export function adaptiveEventsHtml(m) {
  if (!m || !m.available) return '';
  if (!m.events || !m.events.length) return '<div class="adp-empty">暂无事件</div>';
  const rows = m.events.map((e) => {
    const l = e.label || { icon: '·', text: '', color: '#8899aa' };
    const sym = e.sym ? `<span class="adp-ev-s">${_esc(String(e.sym).replace('USDT', ''))}</span> ` : '';
    return `<div class="adp-ev"><span class="adp-ev-i" style="color:${l.color}">${l.icon}</span>`
      + `<span class="adp-ev-t">${_hhmm(e.ts)} ${sym}${_esc(l.text)}</span></div>`;
  });
  return `<div class="adp-evs">${rows.join('')}</div>`;
}

/** 整卡 HTML = 指标 + 两腿 + 事件。 */
export function adaptiveCardHtml(m) {
  return adaptiveMetricsHtml(m) + adaptiveLegsHtml(m) + adaptiveEventsHtml(m);
}

/** 紧凑卡（盯盘右栏用）= 指标 + 两腿（不含事件流，事件流在「组合」tab 完整版）。 */
export function adaptiveCompactHtml(m) {
  return adaptiveMetricsHtml(m) + adaptiveLegsHtml(m);
}

/** 主系统融合页用：读 window.__adaptivePortfolio → 卡片正文 HTML（异常不抛）。 */
export function renderAdaptiveFusion() {
  try {
    const m = buildAdaptiveModel(globalThis.__adaptivePortfolio);
    if (!m.available) return '<div class="adp-empty">自适应组合未初始化（等待引擎挂载）</div>';
    return adaptiveCardHtml(m);
  } catch (e) {
    return '<div class="adp-empty">自适应组合数据读取失败</div>';
  }
}

// ---- PWA DOM 渲染（签名守卫：值未变直接 return，避免每秒重建） ----
// 完整卡（「组合」tab）与紧凑卡（盯盘右栏）各自独立守卫——否则切 tab 时同模型会让另一容器误判“无变化”而留空。
const _sigRefFull = { v: null }, _sigRefCompact = { v: null };

function _sigOf(m) {
  if (!m || !m.available) return 'na';
  return JSON.stringify({
    e: m.enabled ? 1 : 0,
    q: m.equity,
    w: m.warming ? 1 : 0,
    s: (m.symbols || []).map((s) => [s.sym, s.wA, s.wC, s.alphaTarget, s.alphaW, s.carry ? s.carry.notional : null, s.carry ? s.carry.fundingCum : null, s.warming ? 1 : 0]),
    t: (m.events || []).map((e) => e.ts),
  });
}

/** 供测试/重置用：清签名守卫。 */
export function resetAdaptivePanelSig() { _sigRefFull.v = null; _sigRefCompact.v = null; }

function _renderGuarded(el, ref, htmlFn) {
  if (!el) return;
  let m;
  try { m = buildAdaptiveModel(globalThis.__adaptivePortfolio); } catch (e) { m = { available: false }; }
  const sig = _sigOf(m);
  if (sig === ref.v) return;
  ref.v = sig;
  try { el.innerHTML = htmlFn(m); } catch (e) { el.innerHTML = '<div class="adp-empty">自适应组合渲染失败</div>'; }
}

/** 完整卡（「组合」tab，含事件流对账）。 */
export function renderAdaptivePwa(el) { _renderGuarded(el, _sigRefFull, adaptiveCardHtml); }

/** 紧凑卡（盯盘右栏，不含事件流）。 */
export function renderAdaptiveCompactPwa(el) { _renderGuarded(el, _sigRefCompact, adaptiveCompactHtml); }
