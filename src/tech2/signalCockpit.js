// ============================================================
// 信号驾驶舱（Signal Cockpit）—— P0 基石区 + P3 可信度标注（主系统 index.html 与 PWA kchart.html 共享）
//
// 设计（AGENTS.md §5.31/5.32/5.33 + notebook signal-cockpit）：
//  - 基石 Alpha 是配资金的核心策略（长窗 6.7y CAGR+30.3%/DD29%/0 爆仓，参数固化严禁优选），
//    但此前在盯盘界面近乎隐形（只在 console + alphaLab 小字）。本模块把基石信号图形化上 HUD：
//    动态仓位表盘（posGauge）+ 三因子分解条（carry/momo/brk）+ w 历史面积图（wHist）。
//  - P3 可信度标注：每个信号标历史验证状态 ★(已验证可配资金) / ⚠(未过四关仅纸面) / ○(样本累积中)。
//
// 零行为变化红线：本模块只读 globalThis.__alphaSignals / __alphaLiveW 与传入的 snapshot，不写任何
//   引擎/实盘状态；不改 runSrsiAutoTrade / backtestSrsiAuto / Alpha 信号算法本体。
// 纯函数（factorShares/confidenceOf/relationOf/alphaDirOf/bandDir/fmtAge/wHistoryPoints）全部无 DOM，可单测。
// ============================================================

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

// ============================================================
// P3：信号可信度注册表（诚实性设计——历史验证状态）
// ============================================================
export const SIGNAL_CONFIDENCE = {
  alpha: { level: 'ok', sym: '★', title: 'Alpha 基石：永续 6.7y CAGR+30.3% / maxDD29% / 0 爆仓；现货 8.7y +24.6%；参数固化，严禁优选' },
  srsi: { level: 'warn', sym: '⚠', title: 'SRSI 卫星：默认参长窗 -23.4% / 215 次爆仓 / DD99%；四关未过完，仅纸面/小仓' },
  regime: { level: 'o', sym: '○', title: 'regime 闸门：样本累积中，未独立验证' },
  tsev: { level: 'o', sym: '○', title: 'TSEV：样本累积中，未独立验证' },
  three: { level: 'o', sym: '○', title: '三层共振：样本累积中，未独立验证' },
  voldiv: { level: 'o', sym: '○', title: '量价背离：样本累积中，未独立验证' },
  news: { level: 'o', sym: '○', title: '新闻情绪：样本累积中，未独立验证' }
};
export function confidenceOf(name) {
  return SIGNAL_CONFIDENCE[name] || { level: 'o', sym: '○', title: '未验证' };
}
export function confidenceBadge(name) {
  const c = confidenceOf(name);
  return `<i class="conf conf-${c.level}" title="${esc(c.title)}">${c.sym}</i>`;
}

// ============================================================
// 纯函数：方向 / 因子 / 关系
// ============================================================
// 基石方向（阈值 0.05 与 alphaLab 调仓阈值一致）
export function alphaDirOf(w) {
  if (!finite(w)) return 'flat';
  if (w > 0.05) return 'long';
  if (w < -0.05) return 'short';
  return 'flat';
}
// SRSI 带态方向：上带=超买→卫星做空；下带=超卖→卫星做多；中性无信号
export function bandDir(band) {
  if (band === 'upper') return 'short';
  if (band === 'lower') return 'long';
  return null;
}
// 三因子加权贡献 → 占比（按 |贡献| 归一，供条形宽度）
export function factorShares(factors) {
  if (!factors) return [];
  const items = [['carry', 'carry', factors.carry], ['momo', 'momo', factors.momo], ['brk', 'brk', factors.brk]];
  const absSum = items.reduce((s, it) => s + Math.abs(finite(it[2]) ? it[2] : 0), 0);
  return items.map(([key, label, v]) => {
    const val = finite(v) ? v : 0;
    return { key, label, val, sharePct: absSum > 0 ? Math.abs(val) / absSum * 100 : 0, positive: val >= 0 };
  });
}
// 关系判定（P1 新增逻辑）：基石方向 vs 卫星带态方向 → 共振/冲突/中性；宏观带只标同向否
// macroSpreadPct：7d/30d EMA 价差%（>0.1 视为多，<-0.1 视为空，其余 flat）
export function relationOf({ alphaW, band, macroSpreadPct } = {}) {
  const a = alphaDirOf(alphaW);
  const s = bandDir(band);
  const m = finite(macroSpreadPct) ? (macroSpreadPct > 0.1 ? 'long' : macroSpreadPct < -0.1 ? 'short' : 'flat') : 'flat';
  let kind = 'neutral';
  if (a !== 'flat' && s) kind = (a === s) ? 'resonance' : 'conflict';
  const macroAligned = (a !== 'flat' && m !== 'flat') ? (a === m) : null;
  return { kind, alphaDir: a, satDir: s, macroDir: m, macroAligned };
}
// 距今时长文案
export function fmtAge(ms) {
  if (!finite(ms) || ms < 0) return '--';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's 前';
  const m = Math.round(s / 60);
  if (m < 60) return m + 'm 前';
  const h = Math.floor(m / 60), mm = m % 60;
  if (h < 24) return h + 'h' + (mm ? mm + 'm' : '') + ' 前';
  return Math.floor(h / 24) + 'd ' + (h % 24) + 'h 前';
}

// w 历史面积图几何（纯函数，可单测）：ws 序列 → 画布坐标点
export function wHistoryPoints(ws, w, h, opts = {}) {
  const padX = opts.padX != null ? opts.padX : 8, padY = opts.padY != null ? opts.padY : 6;
  const arr = Array.isArray(ws) ? ws.filter(finite) : [];
  if (!arr.length) return { pts: [], baseY: h / 2, range: 1 };
  let mx = 0;
  for (const v of arr) mx = Math.max(mx, Math.abs(v));
  const range = Math.max(0.2, opts.range != null ? opts.range : mx);
  const n = arr.length;
  const X = (i) => padX + (w - padX * 2) * (n === 1 ? 0.5 : i / (n - 1));
  const Y = (v) => padY + (h - padY * 2) * (1 - (clamp(v, -range, range) + range) / (2 * range));
  const pts = arr.map((v, i) => ({ x: X(i), y: Y(v), v }));
  return { pts, baseY: Y(0), range };
}

// ============================================================
// 绘制（纯 ctx 函数，可传 stub ctx 冒烟）
// ============================================================
function rrPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
// 表盘顶部文字布局（纯函数，可单测）：大字 / 目标仓位标签 / 提示三者自适应排布，窄画布下自动换行或隐藏提示。
// 背景：drawPosGauge 原为 640px 宽画布设计，但 PWA 驾驶舱卡里 canvas 仅 200px 宽（手机 170px）→
// 三行文字同一 y 上互相重叠（实测出现 “+0%0.0%目标仓位 空仓” 乱码）。
// 返回 { bigX, labX, labY, hintX, hintY, showHint }；hintX=null 表示提示放不下，应隐藏。
export function posGaugeLayout(W, sizes, padX) {
  const X0 = padX != null ? padX : 28;
  const rightX = Math.max(X0, (finite(W) ? W : 0) - X0);
  const bigW = Math.max(0, finite(sizes && sizes.bigW) ? sizes.bigW : 0);
  const labW = Math.max(0, finite(sizes && sizes.labW) ? sizes.labW : 0);
  const hintW = Math.max(0, finite(sizes && sizes.hintW) ? sizes.hintW : 0);
  const labRow1X = X0 + bigW + 10;
  const hintRow1X = rightX - hintW;
  const hintRow1 = hintRow1X >= X0 + bigW + 8;                 // 提示同行右侧是否放得下
  const labRow1 = hintRow1 ? (labRow1X + labW <= hintRow1X - 8)  // 同行还要避开提示
    : (labRow1X + labW <= rightX);
  const labX = labRow1 ? labRow1X : X0;
  const labY = labRow1 ? 28 : 46;
  let hintX = null, hintY = null;
  if (hintRow1) { hintX = rightX; hintY = 30; }
  else {
    // 下移到第二行右对齐；若会压住已落在第二行的标签，则直接隐藏（提示是次要信息）
    const row2LeftLimit = labRow1 ? X0 : (X0 + labW + 8);
    if (hintRow1X >= row2LeftLimit) { hintX = rightX; hintY = 46; }
  }
  return { bigX: X0, labX, labY, hintX, hintY, showHint: hintX != null };
}
// 基石仓位表盘：横向 -100%..+100%，红/灰/绿分区 + 刻度 + 缓动指针 + 发光大字
export function drawPosGauge(ctx, W, H, w, opts = {}) {
  if (!ctx || !W || !H) return;
  const val = clamp(finite(w) ? w : 0, -1, 1);
  const X0 = opts.padX != null ? opts.padX : 28, X1 = W - X0, yc = H * 0.60;
  const M = (v) => X0 + (X1 - X0) * (v + 1) / 2;
  ctx.clearRect(0, 0, W, H);
  // 分区
  const zx = [M(-1), M(-0.2), M(0.2), M(1)];
  const zones = [[zx[0], zx[1], 'rgba(255,82,82,.18)'], [zx[1], zx[2], 'rgba(255,255,255,.06)'], [zx[2], zx[3], 'rgba(0,230,118,.16)']];
  for (const [a, b, c] of zones) { rrPath(ctx, a, yc - 9, b - a, 18, 6); ctx.fillStyle = c; ctx.fill(); }
  // 刻度
  ctx.strokeStyle = '#4a5568'; ctx.lineWidth = 1;
  for (const v of [-1, -0.5, 0, 0.5, 1]) { const x = M(v); ctx.beginPath(); ctx.moveTo(x, yc + 11); ctx.lineTo(x, yc + (v === 0 ? 20 : 16)); ctx.stroke(); }
  ctx.fillStyle = '#6B7688'; ctx.font = '9px system-ui'; ctx.textAlign = 'center';
  ctx.fillText('-100%', M(-1), yc + 31); ctx.fillText('0', M(0), yc + 31); ctx.fillText('+100%', M(1), yc + 31);
  // 指针（发光）
  const x = M(val);
  ctx.save();
  ctx.shadowColor = val >= 0 ? 'rgba(0,230,118,.9)' : 'rgba(255,82,82,.9)'; ctx.shadowBlur = 12;
  ctx.fillStyle = val >= 0 ? '#00E676' : '#FF5252';
  ctx.beginPath(); ctx.moveTo(x, yc - 13); ctx.lineTo(x - 7, yc - 23); ctx.lineTo(x + 7, yc - 23); ctx.closePath(); ctx.fill();
  ctx.fillRect(x - 1.5, yc - 23, 3, 32);
  ctx.restore();
  // 大字 + 说明（自适应排布：窄画布自动换行/隐藏次要提示，避免文字重叠）
  const tw = (s) => { try { const m = ctx.measureText(s); return (m && finite(m.width)) ? m.width : String(s).length * 6; } catch (e) { return String(s).length * 6; } };
  const bigTxt = (val >= 0 ? '+' : '') + Math.round(val * 100) + '%';
  const labTxt = '目标仓位 · ' + (val > 0.05 ? '多头' : val < -0.05 ? '空头' : '空仓');
  const hintTxt = opts.hint || '调仓阈值 |Δw|>0.05';
  ctx.font = '800 30px system-ui';
  const bigW = tw(bigTxt);
  ctx.font = '10px system-ui';
  const labW = tw(labTxt);
  ctx.font = '9px system-ui';
  const hintW = tw(hintTxt);
  const lay = posGaugeLayout(W, { bigW, labW, hintW }, X0);
  ctx.fillStyle = val >= 0 ? '#00E676' : '#FF5252'; ctx.font = '800 30px system-ui'; ctx.textAlign = 'left';
  ctx.fillText(bigTxt, lay.bigX, 30);
  ctx.fillStyle = '#8b95a5'; ctx.font = '10px system-ui'; ctx.textAlign = 'left';
  ctx.fillText(labTxt, lay.labX, lay.labY);
  if (lay.showHint) {
    ctx.fillStyle = '#6B7688'; ctx.font = '9px system-ui'; ctx.textAlign = 'right';
    ctx.fillText(hintTxt, lay.hintX, lay.hintY);
  }
  ctx.textAlign = 'left';
}
// w 历史面积图
export function drawWHistory(ctx, W, H, ws, opts = {}) {
  if (!ctx || !W || !H) return;
  ctx.clearRect(0, 0, W, H);
  const { pts, baseY, range } = wHistoryPoints(ws, W, H, opts);
  ctx.fillStyle = '#6B7688'; ctx.font = '9px system-ui'; ctx.textAlign = 'left';
  ctx.fillText(opts.label || 'w 历史（目标仓位序列）', 8, 11);
  ctx.textAlign = 'right'; ctx.fillText('±' + Math.round(range * 100) + '%', W - 8, 11);
  // 零轴
  ctx.strokeStyle = 'rgba(255,255,255,.10)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(8, baseY); ctx.lineTo(W - 8, baseY); ctx.stroke();
  if (pts.length < 2) { if (pts.length === 1) { ctx.fillStyle = '#22d3ee'; ctx.beginPath(); ctx.arc(pts[0].x, pts[0].y, 3, 0, 7); ctx.fill(); } return; }
  // 面积（以零轴为基线）
  ctx.beginPath(); ctx.moveTo(pts[0].x, baseY);
  for (const p of pts) ctx.lineTo(p.x, p.y);
  ctx.lineTo(pts[pts.length - 1].x, baseY); ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, 'rgba(34,211,238,.32)'); g.addColorStop(1, 'rgba(34,211,238,0)');
  ctx.fillStyle = g; ctx.fill();
  // 线
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) { i ? ctx.lineTo(pts[i].x, pts[i].y) : ctx.moveTo(pts[i].x, pts[i].y); }
  ctx.strokeStyle = '#22d3ee'; ctx.lineWidth = 1.4; ctx.stroke();
  // 末点
  const last = pts[pts.length - 1];
  ctx.fillStyle = '#22d3ee'; ctx.beginPath(); ctx.arc(last.x, last.y, 3, 0, 7); ctx.fill();
}

// ============================================================
// P0：基石区模型 + HTML
// ============================================================
export function buildPillarModel(alphaSig, now, liveW) {
  const a = alphaSig || {};
  const live = finite(liveW) && Math.abs(liveW) > 0.05;
  const w = finite(a.lastW) ? a.lastW : (finite(liveW) ? liveW : 0);
  const factors = factorShares(a.factors);
  // 上次调仓：优先实盘 marks（真实成交时刻），否则用信号 flips 的 bar 时间
  let lastRebT = null;
  try {
    const marks = globalThis.__alphaLiveMarks;
    if (Array.isArray(marks) && marks.length && finite(marks[marks.length - 1].t)) lastRebT = marks[marks.length - 1].t;
    else if (Array.isArray(a.flips) && a.flips.length && Array.isArray(a.ts)) {
      const f = a.flips[a.flips.length - 1];
      if (f && finite(a.ts[f.i])) lastRebT = a.ts[f.i];
    }
  } catch (e) { lastRebT = null; }
  const ageTxt = lastRebT != null ? fmtAge(now - lastRebT) : '--';
  return { w, live, factors, ageTxt, hasSig: !!a.sym, sym: a.sym || '', tf: a.tf || '' };
}
function pillarHeaderHtml(m) {
  return '⬢ 基石 Alpha <span class="sc-core">CORE</span>' +
    (m.live ? '<span class="sc-live">● 实盘</span>' : '') + confidenceBadge('alpha');
}
function pillarFacsHtml(m) {
  if (!m.factors.length) return '<div class="sc-nodata">⏳ 等待 Alpha 信号…（进入 K 线页后自动计算）</div>';
  return m.factors.map((f) => {
    const cls = 'sc-fac sc-' + f.key + (f.positive ? '' : ' sc-neg');
    const vtxt = (f.val >= 0 ? '+' : '') + f.val.toFixed(2);
    return `<div class="${cls}"><span class="nm">${f.label}</span>` +
      `<span class="bar"><span class="fill" style="width:${clamp(f.sharePct, 0, 100).toFixed(1)}%"></span></span>` +
      `<span class="amt">${vtxt}<span class="share">${Math.round(f.sharePct)}%</span></span></div>`;
  }).join('');
}
function pillarMetaHtml(m) {
  return `上次调仓 <b>${esc(m.ageTxt)}</b>${m.sym ? ' · ' + esc(m.sym) + ' ' + esc(m.tf) : ''}${m.live ? ' · 组合实盘' : ''}`;
}
// 稳定骨架（只建一次）：canvas 不随 tick 重建，避免 wHist 反复空白
const PILLAR_CANVAS = '<canvas id="scPosGauge" width="640" height="150"></canvas>';
const WHIST_CANVAS = '<canvas id="scWHist" width="640" height="72"></canvas>';
export function renderPillarSkeleton() {
  return '<div class="sc-pillar" id="scPillar">' +
    '<div class="sc-pillar-h" id="scPillarH"></div>' + PILLAR_CANVAS +
    '<div class="sc-facs" id="scFacs"></div>' + WHIST_CANVAS +
    '<div class="sc-meta" id="scMeta"></div>' +
    '</div>';
}
// 原地更新（每 tick 调用；内容未变不写 DOM）
export function updatePillar(alphaSig, now, liveW) {
  if (typeof document === 'undefined') return;
  const m = buildPillarModel(alphaSig, now, liveW);
  const h = document.getElementById('scPillarH');
  if (h) { const x = pillarHeaderHtml(m); if (h.innerHTML !== x) h.innerHTML = x; }
  const f = document.getElementById('scFacs');
  if (f) { const x = pillarFacsHtml(m); if (f.innerHTML !== x) f.innerHTML = x; }
  const mt = document.getElementById('scMeta');
  if (mt) { const x = pillarMetaHtml(m); if (mt.innerHTML !== x) mt.innerHTML = x; }
}
// 整段 HTML（单测/无 HUD 回退用）
export function renderPillarHtml(alphaSig, now, liveW) {
  const m = buildPillarModel(alphaSig, now, liveW);
  return '<div class="sc-pillar">' +
    '<div class="sc-pillar-h">' + pillarHeaderHtml(m) + '</div>' + PILLAR_CANVAS +
    '<div class="sc-facs">' + pillarFacsHtml(m) + '</div>' + WHIST_CANVAS +
    '<div class="sc-meta">' + pillarMetaHtml(m) + '</div>' +
    '</div>';
}

// ============================================================
// RAF：基石区动画（posGauge 缓动指针 + wHist 数据变化时重绘）
// ============================================================
let _scRaf = 0;
let _scAnim = { w: 0 };
let _scWsKey = null;
function scReadTarget() {
  const a = globalThis.__alphaSignals || {};
  let w = finite(a.lastW) ? a.lastW : 0;
  try {
    const lab = globalThis.__alphaLab;
    if (lab && typeof lab.isLive === 'function' && lab.isLive() && finite(globalThis.__alphaLiveW)) w = globalThis.__alphaLiveW;
  } catch (e) { /* ignore */ }
  return { w, a };
}
function scFrame() {
  _scRaf = 0;
  const cv = (typeof document !== 'undefined') && document.getElementById('scPosGauge');
  if (!cv) { _scRaf = 0; return; } // 画布没了 → 自停
  const ctx = cv.getContext && cv.getContext('2d');
  const { w, a } = scReadTarget();
  if (ctx) {
    _scAnim.w = lerp(_scAnim.w, clamp(w, -1, 1), 0.06);
    try { drawPosGauge(ctx, cv.width, cv.height, _scAnim.w, { hint: '调仓阈值 |Δw|>0.05 · 60s 检查' }); } catch (e) { /* ignore */ }
  }
  const wc = document.getElementById('scWHist');
  const key = a && (a.updatedT || 0) + '|' + (Array.isArray(a.ws) ? a.ws.length : 0);
  if (wc && key !== _scWsKey) {
    _scWsKey = key;
    const wctx = wc.getContext && wc.getContext('2d');
    if (wctx) { try { drawWHistory(wctx, wc.width, wc.height, a && a.ws, { label: 'w 历史（近 ' + (Array.isArray(a && a.ws) ? a.ws.length : 0) + ' 根目标仓位）' }); } catch (e) { /* ignore */ } }
  }
  _scRaf = (typeof requestAnimationFrame !== 'undefined') ? requestAnimationFrame(scFrame) : 0;
}
export function ensureCockpitAnim() {
  if (_scRaf || typeof requestAnimationFrame === 'undefined') return;
  _scRaf = requestAnimationFrame(scFrame);
}
export function stopCockpitAnim() {
  if (_scRaf && typeof cancelAnimationFrame !== 'undefined') { try { cancelAnimationFrame(_scRaf); } catch (e) { /* ignore */ } }
  _scRaf = 0;
}
export function resetCockpitCache() { _scWsKey = null; }

// ============================================================
// P1：解读卡（行情状态 + 信号关系）—— 雷达图 + 关系图 + 4 问 + 结论
// ============================================================
const fmtN = (v, d = 1) => (v == null || !Number.isFinite(+v)) ? '--' : (+v).toFixed(d);
function relTxt(kind) { return kind === 'resonance' ? '共振' : kind === 'conflict' ? '冲突' : '中性'; }
function sideTxt(dir) { return dir === 'long' ? '多' : dir === 'short' ? '空' : '平'; }

// 结论（纯函数，可单测）：冲突时明确以基石为准
export function conclusionOf(rel, w, confirmN, confirmNeed, pdDanger) {
  if (pdDanger) return { txt: 'PD-A 命中危险因子 → 卫星暂缓开仓；以基石为准', cls: 'warn' };
  if (rel.kind === 'conflict') return { txt: '以基石为准：卫星信号逆基石，仅纸面观察 / 小仓', cls: 'bad' };
  if (rel.kind === 'resonance') {
    const side = sideTxt(rel.alphaDir);
    const done = confirmNeed > 0 && confirmN >= confirmNeed;
    return { txt: done ? `基石与卫星共振做${side}，卫星确认完成 → 可小仓试${side}` : `顺基石头寸持有；卫星确认 ${confirmN}/${confirmNeed} 完成后可小仓试${side}`, cls: 'good' };
  }
  if (alphaDirOf(w) === 'flat') return { txt: '基石空仓；等待方向与带态信号', cls: 'neu' };
  return { txt: `基石主导持${sideTxt(alphaDirOf(w))}；卫星无信号，等待带态穿越`, cls: 'neu' };
}

// 信号接近度（纯函数，可单测）：K 值距上/下带有多近（用于驾驶舱「卫星接近度」条 + 脉冲动画）。
// 返回 { zone, nearest:'up'|'down', distUp, distDown, closeness(0..1, 1=贴带/进带), inBand, willCross }。
// closeness：中性区 = 1 - 距最近带 / 半带宽（中点=0，贴带→1）；已进带 = 1。
// willCross：进行中 K 已进带、而已收盘 K 还在带外（预演将破带，尚未确认）。
export function proximityOf(k, upper, lower, kClosed) {
  if (![k, upper, lower].every((v) => v != null && Number.isFinite(+v))) return null;
  k = +k; upper = +upper; lower = +lower;
  if (!(upper > lower)) return null;
  const zone = k >= upper ? 'upper' : (k <= lower ? 'lower' : 'neutral');
  const distUp = upper - k, distDown = k - lower;
  const nearest = zone === 'upper' ? 'up' : (zone === 'lower' ? 'down' : (distUp <= distDown ? 'up' : 'down'));
  const half = Math.max(1e-6, (upper - lower) / 2);
  const distToBand = zone === 'neutral' ? Math.min(distUp, distDown) : 0;
  const closeness = zone === 'neutral' ? Math.max(0, Math.min(1, 1 - distToBand / half)) : 1;
  const kc = (kClosed != null && Number.isFinite(+kClosed)) ? +kClosed : null;
  const willCross = (zone === 'upper' && kc != null && kc < upper) || (zone === 'lower' && kc != null && kc > lower);
  return { zone, nearest, distUp, distDown, closeness, inBand: zone !== 'neutral', willCross };
}

// 接近度文案（纯函数，可单测）："距下带 6.2" / "已在上带" + 警示语
// 颜色约定与主图一致：nearest='down'（接近下带→看多）绿；'up'（接近上带→看空）红。
export function proxText(p) {
  if (!p) return '';
  const band = p.nearest === 'up' ? '上带' : '下带';
  const dist = Math.abs(p.nearest === 'up' ? p.distUp : p.distDown).toFixed(1);
  return p.inBand ? ('已在' + band) : ('距' + band + ' ' + dist);
}
export function proxWarn(p) {
  if (!p) return '';
  if (p.willCross) return '⚠ 若此刻收盘将进带（未确认）';
  if (!p.inBand && p.closeness >= 0.75) return '接近中';
  return '';
}

// 解读模型（纯函数，可单测）
export function buildReadoutModel({ snap, alphaSig, now, horizon, macro, proximity } = {}) {
  const s = snap || {};
  const reg = s.regime || null;
  const atrPct = reg && finite(reg.atrPct) ? reg.atrPct : null;
  let volBand = '中';
  if (reg && finite(reg.p25) && finite(reg.p75) && atrPct != null) volBand = atrPct >= reg.p75 ? '高' : atrPct < reg.p25 ? '低' : '中';
  const volNorm = (reg && finite(reg.p25) && finite(reg.p75) && atrPct != null && reg.p75 > reg.p25) ? clamp((atrPct - reg.p25) / (reg.p75 - reg.p25), 0, 1) : 0.5;
  const trendLabel = horizon ? (horizon.flat ? '横盘' : (horizon.up ? '趋势上' : '趋势下')) : '数据不足';
  const trendNorm = horizon && finite(horizon.spreadPct) && finite(horizon.deadZone) && horizon.deadZone > 0 ? clamp(Math.abs(horizon.spreadPct) / (horizon.deadZone * 4), 0, 1) : 0;
  const regimeStateTxt = s.regimeState === 'lowdrift' ? '低波阴跌' : s.regimeState === 'high' ? '高波' : s.regimeState === 'mid' ? '中波' : '—';
  const w = alphaSig && finite(alphaSig.lastW) ? alphaSig.lastW : 0;
  const facs = factorShares(alphaSig && alphaSig.factors);
  const mainFac = facs.length ? facs.slice().sort((a, b) => b.sharePct - a.sharePct)[0] : null;
  const pm = buildPillarModel(alphaSig, now, null);
  const band = s.band || 'neutral';
  const confirmN = finite(s.confirmN) ? s.confirmN : 0;
  const confirmNeed = (s.pendConfirmRaw && finite(s.pendConfirmRaw.n) && s.pendConfirmRaw.n > 0) ? s.pendConfirmRaw.n : 2;
  const pdScore = s.pd ? s.pd.score : 0, pdDanger = !!(s.pd && s.pd.danger);
  // v1.6.17：信号接近度（K 距上/下带）——驾驶舱「卫星接近度」条 + 脉冲动画的数据源
  const prox = (proximity && proximity.k != null)
    ? proximityOf(proximity.k, proximity.upper, proximity.lower, proximity.kClosed)
    : null;
  const rel = relationOf({ alphaW: w, band, macroSpreadPct: macro ? macro.spreadPct : null });
  const concl = conclusionOf(rel, w, confirmN, confirmNeed, pdDanger);
  return {
    trendLabel, trendNorm, volBand, volNorm, atrPct, deadZone: horizon ? horizon.deadZone : null,
    regimeStateTxt, regimeGate: s.regimeGate || 'off',
    w, wDir: alphaDirOf(w), mainFac, ageTxt: pm.ageTxt,
    band, confirmN, confirmNeed, pdScore, pdDanger,
    prox, rel, concl, macroTf: macro ? macro.tf : null
  };
}

// 雷达图：axes=[{label,val(0..1)}]，生长动画由传入 grow 控制
export function drawRadar(ctx, W, H, axes, grow = 1) {
  if (!ctx || !W || !H || !Array.isArray(axes) || !axes.length) return;
  const n = axes.length, cx = W / 2, cy = H / 2 + 4, R = Math.min(W, H) * 0.34;
  const ang = (i) => -Math.PI / 2 + i * 2 * Math.PI / n;
  ctx.clearRect(0, 0, W, H);
  for (let ring = 1; ring <= 4; ring++) {
    ctx.beginPath();
    for (let i = 0; i <= n; i++) { const a = ang(i), r = R * ring / 4; const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.closePath(); ctx.strokeStyle = ring === 4 ? '#4a5568' : 'rgba(255,255,255,.07)'; ctx.lineWidth = 1; ctx.stroke();
  }
  for (let i = 0; i < n; i++) { const a = ang(i); ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.stroke(); }
  ctx.beginPath();
  for (let i = 0; i < n; i++) { const a = ang(i), r = R * clamp(axes[i].val || 0, 0, 1) * clamp(grow, 0, 1); const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
  ctx.closePath(); ctx.fillStyle = 'rgba(34,211,238,.22)'; ctx.fill(); ctx.strokeStyle = '#22d3ee'; ctx.lineWidth = 1.6; ctx.stroke();
  for (let i = 0; i < n; i++) { const a = ang(i), r = R * clamp(axes[i].val || 0, 0, 1) * clamp(grow, 0, 1); ctx.fillStyle = '#22d3ee'; ctx.beginPath(); ctx.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 2.6, 0, 7); ctx.fill(); }
  ctx.fillStyle = '#9aa4b2'; ctx.font = '9px system-ui'; ctx.textBaseline = 'middle';
  for (let i = 0; i < n; i++) {
    const a = ang(i), x = cx + Math.cos(a) * (R + 16), y = cy + Math.sin(a) * (R + 16);
    ctx.textAlign = Math.abs(Math.cos(a)) < 0.3 ? 'center' : (Math.cos(a) > 0 ? 'left' : 'right');
    ctx.fillText(axes[i].label, x, y);
  }
}
// 关系图：基石/卫星两箭头，同向=共振（绿）/反向=冲突（红）/无信号=中性（灰）
export function drawRelVis(ctx, W, H, rel, pulse = 0.5) {
  if (!ctx || !W || !H) return;
  ctx.clearRect(0, 0, W, H);
  const kind = rel && rel.kind || 'neutral';
  const color = kind === 'resonance' ? '#00E676' : kind === 'conflict' ? '#FF5252' : '#8b95a5';
  const aDir = rel && rel.alphaDir || 'flat', sDir = rel && rel.satDir || null;
  const sgn = (d) => d === 'short' ? -1 : 1;
  const drawArrow = (y, dir, label) => {
    if (dir == null || dir === 'flat') { ctx.fillStyle = '#6B7688'; ctx.font = '9px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(label + ' 无', 12, y); return; }
    const x0 = 12, x1 = W - 12, y1 = y;
    const d = sgn(dir);
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x0, y1); ctx.lineTo(x1 - 7 * d, y1); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x1 - 8 * d, y1 - 5); ctx.lineTo(x1 - 8 * d, y1 + 5); ctx.closePath(); ctx.fill();
    ctx.font = '9px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(label, x0, y1 - 9);
  };
  ctx.save();
  ctx.shadowColor = kind === 'neutral' ? 'rgba(0,0,0,0)' : color; ctx.shadowBlur = 6 + pulse * 6;
  drawArrow(H * 0.33, aDir, '基石 ' + sideTxt(aDir));
  drawArrow(H * 0.70, sDir, '卫星 ' + (sDir ? sideTxt(sDir) : '无'));
  ctx.restore();
  ctx.fillStyle = color; ctx.font = 'bold 10px system-ui'; ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
  ctx.fillText(relTxt(kind), W - 12, H - 4);
}

export function renderReadoutHtml(m) {
  const pct = (v) => Math.round(clamp(v, 0, 1) * 100);
  const qa = (q, a) => `<div class="sc-qa"><span class="q">${q}</span><span class="a">${a}</span></div>`;
  const meter = (v, color) => `<span class="sc-meter"><i style="width:${pct(v)}%;background:${color || 'var(--cyan,#22d3ee)'}"></i></span>`;
  const relCls = m.rel.kind === 'resonance' ? 'sc-rel-good' : m.rel.kind === 'conflict' ? 'sc-rel-bad' : 'sc-rel-neu';
  const dirTxt = sideTxt(m.wDir);
  return '<div class="sc-rd">' +
    '<div class="sc-rd-top"><canvas id="scRadar" width="300" height="230"></canvas>' +
    '<div class="sc-rd-rel"><canvas id="scRelVis" width="180" height="70"></canvas>' +
    `<div style="text-align:center;margin-top:2px"><span class="sc-rel-badge ${relCls}">${relTxt(m.rel.kind)}</span></div></div></div>` +
    qa('① 市场', `<b>${esc(m.trendLabel)}</b>${meter(m.trendNorm)}波动 ${m.atrPct != null ? fmtN(m.atrPct, 2) + '%' : '--'}（${esc(m.volBand)}）· 死区 <b>${m.deadZone != null ? fmtN(m.deadZone, 2) + '%' : '--'}</b> · ${esc(m.regimeStateTxt)}`) +
    qa('② 基石', `Alpha <b class="${m.wDir === 'long' ? 'g' : m.wDir === 'short' ? 'r' : ''}">${dirTxt} ${Math.abs(m.w * 100).toFixed(0)}%</b>${meter(Math.abs(m.w), 'var(--green,#00E676)')}${esc(m.ageTxt)} 调仓${m.mainFac ? ' · 主因 ' + esc(m.mainFac.label) : ''} ${confidenceBadge('alpha')}`) +
    qa('③ 卫星', `SRSI <b>${m.band === 'upper' ? '上带' : m.band === 'lower' ? '下带' : '中性'}</b>${meter(m.confirmNeed > 0 ? m.confirmN / m.confirmNeed : 0, 'var(--gold,#FFD740)')}确认 <b>${m.confirmN}/${m.confirmNeed}</b> · 闸门 ${m.regimeGate === 'off' ? '关' : '<span class="g">' + esc(m.regimeGate) + '</span>'} · PD-A ${m.pdDanger ? '<span class="r">危险 ' + m.pdScore + '/5</span>' : '<span class="g">无危险 ' + m.pdScore + '/5</span>'} ${confidenceBadge('srsi')}`) +
    qa('④ 关系', `<span class="sc-rel-badge ${relCls}">${relTxt(m.rel.kind)}</span> 基石${dirTxt}${m.rel.satDir ? ' ↔ 卫星' + sideTxt(m.rel.satDir) : ''}${m.macroTf ? ' · 宏观 ' + esc(m.macroTf) + (m.rel.macroAligned === true ? ' <span class="g">同向</span>' : m.rel.macroAligned === false ? ' <span class="r">反向</span>' : '') : ''}`) +
    (m.prox ? `<div class="pwa-prox ${m.prox.nearest === 'up' ? 'up' : 'down'}${m.prox.inBand ? ' inband' : (m.prox.closeness >= 0.75 ? ' near' : '')}${m.prox.willCross ? ' cross' : ''}"><span class="pwa-prox-lbl">③ 卫星 接近度</span><span class="pwa-prox-bar"><i style="width:${pct(m.prox.closeness)}%"></i></span><span class="pwa-prox-val">${proxText(m.prox)}</span>${proxWarn(m.prox) ? `<span class="pwa-prox-warn">${proxWarn(m.prox)}</span>` : ''}</div>` : '') +
    `<div class="sc-concl sc-concl-${m.concl.cls}">→ 结论：<b>${esc(m.concl.txt)}</b></div>` +
    '</div>';
}
export function drawReadoutCanvases(m, grow = 1) {
  if (typeof document === 'undefined') return;
  const rc = document.getElementById('scRadar');
  if (rc && rc.getContext) {
    const ctx = rc.getContext('2d');
    try {
      drawRadar(ctx, rc.width, rc.height, [
        { label: '趋势强度', val: m.trendNorm },
        { label: '波动分位', val: m.volNorm },
        { label: '基石仓位', val: Math.abs(m.w) },
        { label: '卫星确认', val: m.confirmNeed > 0 ? m.confirmN / m.confirmNeed : 0 }
      ], grow);
    } catch (e) { /* ignore */ }
  }
  const vc = document.getElementById('scRelVis');
  if (vc && vc.getContext) { try { drawRelVis(vc.getContext('2d'), vc.width, vc.height, m.rel, 0.5); } catch (e) { /* ignore */ } }
}

// ============================================================
// P2：事件流（变更驱动）+ 微时间轴 + 可选通知
// ============================================================
const EV_KEY = 'smartTrader_cockpitEvents';
const NOTIF_KEY = 'smartTrader_cockpitNotif';
let _scEvents = null, _scLastState = null;

export function loadCockpitEvents() {
  if (_scEvents) return _scEvents;
  try { _scEvents = JSON.parse((typeof localStorage !== 'undefined' && localStorage.getItem(EV_KEY)) || '[]'); } catch (e) { _scEvents = []; }
  if (!Array.isArray(_scEvents)) _scEvents = [];
  return _scEvents;
}
function saveCockpitEvents() {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(EV_KEY, JSON.stringify((_scEvents || []).slice(-50))); } catch (e) { /* KB 级非关键状态，配额失败不影响功能 */ }
}
export function clearCockpitEvents() { _scEvents = []; saveCockpitEvents(); }

export function cockpitNotifOn() {
  try { return (typeof localStorage !== 'undefined') && localStorage.getItem(NOTIF_KEY) === '1'; } catch (e) { return false; }
}
export function setCockpitNotif(on) {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(NOTIF_KEY, on ? '1' : '0'); } catch (e) { /* ignore */ }
  if (on && typeof Notification !== 'undefined' && Notification.permission === 'default') { try { Notification.requestPermission(); } catch (e) { /* ignore */ } }
}
function notifyEvent(ev) {
  try {
    if (!cockpitNotifOn() || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    new Notification('信号驾驶舱 · ' + ev.kind, { body: ev.note + (ev.price != null ? ' @ $' + fmtN(ev.price, ev.price > 100 ? 1 : 4) : ''), tag: 'cockpit' });
  } catch (e) { /* ignore */ }
}

// 关键状态快照（用于变更检测）
export function cockpitStateOf(snap, alphaSig, macroSpreadPct) {
  const w = alphaSig && finite(alphaSig.lastW) ? alphaSig.lastW : 0;
  const band = (snap && snap.band) || 'neutral';
  return {
    sym: (snap && snap.sym) || null,
    band,
    regimeState: (snap && snap.regimeState) || null,
    regimeGate: (snap && snap.regimeGate) || null,
    wBucket: (w >= 0 ? 1 : -1) * Math.floor(Math.abs(w) / 0.05 + 1e-9) * 0.05,
    relKind: relationOf({ alphaW: w, band, macroSpreadPct }).kind
  };
}
// 状态转移 → 事件列表（纯函数，可单测）
export function detectCockpitEvents(prev, next, ctx = {}) {
  const out = [];
  if (!prev || !next) return out;
  const now = ctx.now, price = ctx.price, sym = ctx.sym;
  if (prev.band !== next.band && (next.band === 'upper' || next.band === 'lower')) {
    out.push({ ts: now, sym, kind: '带态切换', side: bandDir(next.band), price, note: `${prev.band}→${next.band} · ${next.band === 'upper' ? '进入上带（超买）' : '进入下带（超卖）'}` });
  }
  if (prev.wBucket !== next.wBucket) {
    out.push({ ts: now, sym, kind: 'Alpha 调仓', side: alphaDirOf(next.wBucket), price, note: `目标 ${(next.wBucket * 100).toFixed(0)}%` });
  }
  if (prev.regimeState !== next.regimeState) {
    out.push({ ts: now, sym, kind: 'regime 翻转', side: null, price, note: `${prev.regimeState || '—'}→${next.regimeState || '—'}` });
  }
  if (prev.regimeGate !== next.regimeGate) {
    out.push({ ts: now, sym, kind: '闸门切换', side: null, price, note: `${prev.regimeGate || '—'}→${next.regimeGate || '—'}` });
  }
  if (prev.relKind && prev.relKind !== next.relKind) {
    out.push({ ts: now, sym, kind: '关系翻转', side: null, price, note: `${relTxt(prev.relKind)}→${relTxt(next.relKind)}` });
  }
  return out;
}
// 每 tick 调用：检测并累积事件（HUD 关着也记录）
export function cockpitEvents(snap, alphaSig, macroSpreadPct, now) {
  const prev = _scLastState;
  const next = cockpitStateOf(snap, alphaSig, macroSpreadPct);
  // 切换币种 → 只重建基线，不产生跨币种假事件
  const evs = (prev && prev.sym === next.sym) ? detectCockpitEvents(prev, next, { now, price: snap && snap.price, sym: snap && snap.sym }) : [];
  _scLastState = next;
  if (evs.length) {
    const arr = loadCockpitEvents();
    for (const e of evs) { arr.push(e); notifyEvent(e); }
    _scEvents = arr.slice(-50); saveCockpitEvents();
  }
  return evs;
}
// 事件微时间轴：近 hours 小时的事件计数柱
export function drawEvSpark(ctx, W, H, events, now, hours = 12) {
  if (!ctx || !W || !H) return;
  const HOUR = 3600e3, buckets = new Array(hours).fill(0);
  const arr = Array.isArray(events) ? events : [];
  for (const e of arr) { if (!finite(e.ts)) continue; const idx = hours - 1 - Math.floor((now - e.ts) / HOUR); if (idx >= 0 && idx < hours) buckets[idx]++; }
  const mx = Math.max(1, ...buckets), bw = (W - 16) / hours;
  ctx.clearRect(0, 0, W, H);
  for (let i = 0; i < hours; i++) {
    const h = (H - 12) * buckets[i] / mx, x = 8 + i * bw + 1;
    ctx.fillStyle = 'rgba(34,211,238,' + (buckets[i] ? (0.25 + 0.65 * buckets[i] / mx) : 0.06) + ')';
    ctx.fillRect(x, H - 6 - h, bw - 2, Math.max(1, h));
  }
  ctx.fillStyle = '#6B7688'; ctx.font = '9px system-ui'; ctx.textAlign = 'left'; ctx.fillText(hours + 'h前', 8, 10);
  ctx.textAlign = 'right'; ctx.fillText('现在', W - 8, 10);
}
const EV_KB = { '带态切换': 'kb-band', 'Alpha 调仓': 'kb-alpha', 'regime 翻转': 'kb-gate', '闸门切换': 'kb-gate', '关系翻转': 'kb-rel' };
export function renderEventsHtml(events, now) {
  const arr = Array.isArray(events) ? events : [];
  if (!arr.length) return '<div class="sc-nodata">暂无事件（状态转移时自动记录：带态切换 / Alpha 调仓 / regime 翻转 / 关系翻转）</div>';
  return arr.slice().reverse().slice(0, 10).map((e) => {
    const t = new Date(e.ts || now);
    const hh = String(t.getHours()).padStart(2, '0'), mm = String(t.getMinutes()).padStart(2, '0');
    const kb = EV_KB[e.kind] || 'kb-rel';
    const dc = e.side === 'long' ? 'ev-up' : e.side === 'short' ? 'ev-dn' : 'ev-neu';
    const d = e.side === 'long' ? '↑' : e.side === 'short' ? '↓' : '◆';
    return `<div class="sc-ev"><span class="t">${hh}:${mm}</span><span class="k"><span class="kbar ${kb}"></span>${esc(e.kind)}</span>` +
      `<span class="d ${dc}">${d}</span><span class="n">${esc(e.note)}${e.price != null ? ' · <b>$' + fmtN(e.price, e.price > 100 ? 1 : 4) + '</b>' : ''}</span></div>`;
  }).join('');
}

// ============================================================
// 骨架 + 绑定（P0 基石 + P1 解读卡 + P2 事件流）
// ============================================================
export function renderCockpitSkeleton() {
  const notifOn = cockpitNotifOn() ? ' on' : '';
  return renderPillarSkeleton() +
    '<div class="sc-acc" id="scAccReadout"><div class="sc-acc-h" data-acc="readout">🧭 当前解读 <span class="sc-caret">▸</span></div>' +
    '<div class="sc-acc-b"><div class="sc-acc-inner" id="scReadoutBody"></div></div></div>' +
    '<div class="sc-acc" id="scAccEvents"><div class="sc-acc-h" data-acc="events">📡 事件流 <span class="sc-caret">▸</span></div>' +
    '<div class="sc-acc-b"><div class="sc-acc-inner">' +
    `<div class="sc-ev-head"><span>近 12h 事件活跃度</span><span class="sc-notif">通知 <span class="sc-switch${notifOn}" id="scNotifSw"></span></span></div>` +
    '<canvas id="scEvSpark" width="640" height="46"></canvas>' +
    '<div class="sc-evlist" id="scEventsBody"></div>' +
    '</div></div></div>';
}
// 折叠状态持久化（模块级 + localStorage）
const OPEN_KEY = 'smartTrader_cockpitOpen';
let _scOpen = null;
function loadOpen() {
  if (_scOpen) return _scOpen;
  try { _scOpen = JSON.parse((typeof localStorage !== 'undefined' && localStorage.getItem(OPEN_KEY)) || '{}') || {}; } catch (e) { _scOpen = {}; }
  return _scOpen;
}
function saveOpen() { try { if (typeof localStorage !== 'undefined') localStorage.setItem(OPEN_KEY, JSON.stringify(_scOpen || {})); } catch (e) { /* ignore */ } }
export function applyCockpitOpen() {
  if (typeof document === 'undefined') return;
  const o = loadOpen();
  const r = document.getElementById('scAccReadout'), e = document.getElementById('scAccEvents');
  if (r) r.classList.toggle('open', !!o.readout);
  if (e) e.classList.toggle('open', !!o.events);
}
// 事件委托：折叠头 + 通知开关（用 addEventListener，避免 onclick 直调 → 无需双绑 window）
export function bindCockpit(box) {
  const root = box || (typeof document !== 'undefined' && document.getElementById('discHudRmBody'));
  if (!root || root.__scBound) return;
  root.__scBound = true;
  root.addEventListener('click', (ev) => {
    const t = ev.target;
    if (!t || !t.closest) return;
    const head = t.closest('.sc-acc-h');
    if (head && head.dataset && head.dataset.acc) {
      const o = loadOpen(); o[head.dataset.acc] = !o[head.dataset.acc]; saveOpen();
      const acc = head.parentElement; if (acc) acc.classList.toggle('open', !!o[head.dataset.acc]);
      return;
    }
    if (t.id === 'scNotifSw') { const on = !cockpitNotifOn(); setCockpitNotif(on); t.classList.toggle('on', on); }
  });
  applyCockpitOpen();
}

// ---- DOM 原地更新（ruleMonitor HUD 每 tick 调用）----
export function updateReadoutDom(snap, alphaSig, ctxC, now) {
  if (typeof document === 'undefined') return;
  const el = document.getElementById('scReadoutBody');
  if (!el) return;
  const m = buildReadoutModel({ snap, alphaSig, now, horizon: ctxC && ctxC.horizon, macro: ctxC && ctxC.macro });
  const sig = JSON.stringify([m.trendLabel, m.trendNorm, m.volBand, m.volNorm, m.atrPct, m.deadZone, m.regimeStateTxt, m.regimeGate,
    m.w, m.ageTxt, m.mainFac && m.mainFac.key, m.band, m.confirmN, m.confirmNeed, m.pdScore, m.pdDanger,
    m.rel.kind, m.rel.alphaDir, m.rel.satDir, m.rel.macroAligned, m.concl.txt]);
  if (el.__sig !== sig) {
    el.__sig = sig;
    el.innerHTML = renderReadoutHtml(m);
    drawReadoutCanvases(m, 1);
  }
}
export function updateEventsDom(now) {
  if (typeof document === 'undefined') return;
  const list = document.getElementById('scEventsBody');
  if (list) {
    const evs = loadCockpitEvents();
    const sig = evs.length + '|' + (evs.length ? evs[evs.length - 1].ts : 0);
    if (list.__sig !== sig) { list.__sig = sig; list.innerHTML = renderEventsHtml(evs, now); }
  }
  const sc = document.getElementById('scEvSpark');
  if (sc && sc.getContext) { try { drawEvSpark(sc.getContext('2d'), sc.width, sc.height, loadCockpitEvents(), now, 12); } catch (e) { /* ignore */ } }
}
