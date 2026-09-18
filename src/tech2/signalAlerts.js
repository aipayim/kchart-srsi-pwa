// 信号提醒总线（PWA 盯盘「实时捕捉信号」的底座）
// 背景（2026-09-18 审计）：用户人工盯盘一整天「看不到任何交易信号」——根因是所有信号引擎默认关闭，
// 且 UI 用装饰性徽章假装在跑。修好开关后还需要：信号一旦产出就必须**被看见、被记住**，
// 不能只在穿越那一根 K 线闪一下。本模块把「引擎真的产出了信号」变成可提醒、可回溯的事件流。
//
// 设计约束：
//  - 无 DOM 依赖：渲染只返回 HTML 字符串，由调用方插入；提醒（toast/通知/声音）由订阅方实现。
//  - 纯函数优先：`signalEventKey`/`kindMeta`/`fmtSignalTime` 可单测；状态只在 `_events` 内存 + localStorage 小缓存。
//  - 幂等去重：同一 (sym, kind, side, barT) 只记一次（避免每 tick 重复刷屏）。
//  - 容量上限：最多保留 MAX_EVENTS 条（时间升序，丢最旧）。

export const SIG_EVENTS_KEY = 'pwa_signal_events';
export const MAX_SIGNAL_EVENTS = 60;

// 事件种类 → 展示元数据（label/side/severity/color）
// severity: 'trade'=真的成交 | 'signal'=策略信号（带边沿/确认/调仓） | 'preview'=预演（尚未确认）
export const SIGNAL_KINDS = {
  'srsi-edge-upper': { label: '卫星·破上带（做空信号）', side: 'short', severity: 'signal', color: '#ff6b6b' },
  'srsi-edge-lower': { label: '卫星·破下带（做多信号）', side: 'long', severity: 'signal', color: '#2ecc71' },
  'srsi-confirm': { label: '卫星·确认推进', side: null, severity: 'signal', color: '#58a6ff' },
  'srsi-open': { label: '卫星·开仓', side: null, severity: 'trade', color: '#22d3ee' },
  'srsi-close': { label: '卫星·平仓', side: null, severity: 'trade', color: '#8899aa' },
  'srsi-preview': { label: '卫星·预演将破带', side: null, severity: 'preview', color: '#FFB300' },
  'alpha-rebal': { label: '基石·调仓', side: null, severity: 'trade', color: '#22d3ee' },
  'alpha-open': { label: '基石·开仓', side: null, severity: 'trade', color: '#22d3ee' },
  'alpha-close': { label: '基石·平仓', side: null, severity: 'trade', color: '#8899aa' }
};

export function kindMeta(kind) {
  return SIGNAL_KINDS[kind] || { label: kind || '未知信号', side: null, severity: 'signal', color: '#8b95a5' };
}

// 去重键：同一币/同一种类/同方向/同一根 bar（或同一毫秒）只算一次
export function signalEventKey(ev) {
  if (!ev) return '';
  return [ev.sym || '', ev.kind || '', ev.side || '', ev.barT != null ? ev.barT : (ev.ts || '')].join('|');
}

export function fmtSignalTime(ts, now) {
  const t = +ts;
  if (!Number.isFinite(t) || t <= 0) return '--';
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  const hm = p(d.getHours()) + ':' + p(d.getMinutes());
  const ref = now != null ? now : Date.now();
  const sameDay = new Date(ref).toDateString() === d.toDateString();
  if (sameDay) return hm;
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + hm;
}

// 方向文本：+多 / -空 / 平
export function sideText(side, w) {
  if (side === 'long') return '多';
  if (side === 'short') return '空';
  if (side === 'flat') return '平';
  if (w != null && Number.isFinite(+w)) { const v = +w; return v > 0.02 ? '多' : v < -0.02 ? '空' : '平'; }
  return '—';
}

// ---- 状态 ----
let _events = null;
let _subs = [];

function readStore() {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(SIG_EVENTS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter(x => x && x.kind) : [];
  } catch (e) { return []; }
}
function writeStore(list) {
  try {
    if (typeof localStorage === 'undefined') return true;
    localStorage.setItem(SIG_EVENTS_KEY, JSON.stringify(list));
    return true;
  } catch (e) {
    // 不静默吞掉（AGENTS §5.30 红线）：配额类失败时降级为仅内存并告警
    try { console.warn('[SIGNAL-ALERT] 事件写入 localStorage 失败（降级为仅内存）:', e && e.name); } catch (_) {}
    return false;
  }
}

export function loadSignalEvents() {
  if (_events === null) _events = readStore();
  return _events;
}
export function recentSignals(n) {
  const list = loadSignalEvents();
  const k = n == null ? 8 : Math.max(0, n | 0);
  return list.slice(Math.max(0, list.length - k)).reverse();   // 最新在前
}
export function clearSignalEvents() {
  _events = [];
  writeStore(_events);
  for (const fn of _subs) { try { fn(null); } catch (e) {} }
}

// 追加一条信号事件；重复（同 key）返回 null。
export function pushSignalEvent(ev) {
  if (!ev || !ev.kind) return null;
  const list = loadSignalEvents();
  const item = {
    ts: Number.isFinite(+ev.ts) ? +ev.ts : Date.now(),
    sym: ev.sym || '',
    kind: ev.kind,
    side: ev.side || null,
    price: (ev.price != null && Number.isFinite(+ev.price)) ? +ev.price : null,
    w: (ev.w != null && Number.isFinite(+ev.w)) ? +ev.w : null,
    count: Number.isFinite(+ev.count) ? +ev.count : null,
    need: Number.isFinite(+ev.need) ? +ev.need : null,
    text: ev.text ? String(ev.text).slice(0, 160) : '',
    barT: Number.isFinite(+ev.barT) ? +ev.barT : null,
    src: ev.src || ''
  };
  const key = signalEventKey(item);
  if (list.some(x => signalEventKey(x) === key)) return null;
  list.push(item);
  while (list.length > MAX_SIGNAL_EVENTS) list.shift();
  _events = list;
  writeStore(list);
  for (const fn of _subs) { try { fn(item); } catch (e) {} }
  return item;
}

export function onSignalEvent(fn) {
  if (typeof fn === 'function' && !_subs.includes(fn)) _subs.push(fn);
}
export function offSignalEvent(fn) {
  const i = _subs.indexOf(fn);
  if (i >= 0) _subs.splice(i, 1);
}

// 一行摘要文本（供 toast / 通知 / 列表复用）
export function signalLine(ev) {
  const m = kindMeta(ev && ev.kind);
  const sym = (ev && ev.sym) || '';
  const parts = [m.label];
  if (ev && ev.count != null && ev.need != null) parts.push(ev.count + '/' + ev.need);
  if (ev && ev.price != null) parts.push('@' + (Math.abs(ev.price) >= 100 ? ev.price.toFixed(0) : ev.price.toFixed(4)));
  if (ev && ev.w != null) parts.push('w ' + (ev.w >= 0 ? '+' : '') + (ev.w * 100).toFixed(0) + '%');
  return (sym ? sym + ' ' : '') + parts.join(' ');
}

// 最近信号列表 HTML（空态明确说明「引擎是否在跑」，不再让用户猜）
export function renderRecentSignalsHtml(n) {
  const list = recentSignals(n == null ? 8 : n);
  if (!list.length) return '<div class="sig-alert-empty">暂无信号记录。若引擎未启动，请点上方「⚡ 启动信号引擎」。</div>';
  return list.map(ev => {
    const m = kindMeta(ev.kind);
    const sev = m.severity === 'trade' ? 'sig-ev-trade' : m.severity === 'preview' ? 'sig-ev-preview' : 'sig-ev-signal';
    return '<div class="sig-ev ' + sev + '">' +
      '<span class="sig-ev-t">' + fmtSignalTime(ev.ts) + '</span>' +
      '<span class="sig-ev-k" style="color:' + m.color + '">' + m.label + '</span>' +
      '<span class="sig-ev-d">' + (ev.side ? '方向 ' + sideText(ev.side) + ' · ' : '') +
        (ev.count != null && ev.need != null ? '确认 ' + ev.count + '/' + ev.need + ' · ' : '') +
        (ev.price != null ? '@' + (Math.abs(ev.price) >= 100 ? ev.price.toFixed(0) : ev.price.toFixed(4)) : '') +
        (ev.w != null ? ' w ' + (ev.w >= 0 ? '+' : '') + (ev.w * 100).toFixed(0) + '%' : '') +
        (ev.text ? ' ' + ev.text : '') + '</span>' +
    '</div>';
  }).join('');
}
