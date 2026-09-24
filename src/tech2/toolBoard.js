// ============================================================
// PWA「工具一览（Tool Board）」—— 盯盘右栏工具汇总卡（v1.6.50）
//
// 设计（notebook pwa-tool-board + AGENTS §5.36）：
//  - 把当前**已开启**的盯盘工具各占一行，显示：工具名 · 它自己的周期 · **原样引用**该工具的结构性结论 · 方向标记。
//  - 关系行只统计「偏多/偏空/中性」计数 + 列出冲突对（如「均线关系多 vs 缠论空」）。
//    **禁止给融合方向 / 综合评分**——21 个工具类信号在 signal-lab 全部 FAIL（≈随机，见 notebook signal-lab-results），
//    聚合会变成 §5.36 警告的「装饰性 UI」，误导用户。
//  - 过滤开关 cfg.toolBoardTfOnly（默认 false）：开启后只列 nativeTf === mainTF 的工具（固定周期工具会消失）。
//
// 零行为变化红线：本模块只读传入的快照/结论，不写任何引擎/实盘状态；纯函数无 DOM，可单测。
// 主系统 index.html 无 #pwaToolBoard → pwaShell 渲染器 no-op（零回归）。
// ============================================================

import { alphaDirOf, bandDir } from './signalCockpit.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

// tone（bull/bear/range/none）→ 方向（long/short/flat/none）
export function toneDir(tone) {
  if (tone === 'bull') return 'long';
  if (tone === 'bear') return 'short';
  if (tone === 'range') return 'flat';
  return 'none';
}
export const DIR_MARK = { long: '▲ 多', short: '▼ 空', flat: '— 中', none: '·' };
export const DIR_TXT = { long: '多', short: '空', flat: '中', none: '—' };
export function dirMark(dir) { return DIR_MARK[dir] || DIR_MARK.none; }

// 计数：只统计有方向（long/short/flat）的行；none（展示层/监测）不计入关系
export function toolBoardCounts(rows) {
  const c = { long: 0, short: 0, flat: 0 };
  for (const r of (rows || [])) { if (r && (r.dir === 'long' || r.dir === 'short' || r.dir === 'flat')) c[r.dir]++; }
  return c;
}
// 冲突对：方向相反（long vs short）的两两组合；顺序按行序
export function toolBoardConflicts(rows) {
  const out = [];
  const arr = (rows || []).filter((r) => r && (r.dir === 'long' || r.dir === 'short'));
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) {
      if (arr[i].dir !== arr[j].dir) out.push(arr[i].name + DIR_TXT[arr[i].dir] + ' vs ' + arr[j].name + DIR_TXT[arr[j].dir]);
    }
  }
  return out;
}

// 各工具的静态身份（name 固定，nativeTf 见下：跟随 mainTF 的传 'mainTF' 占位）
const TOOL_ORDER = ['alpha', 'srsi', 'adaptive', 'maRel', 'rb', 'chan', 'live', 'monitor'];

// 主入口：构建工具一览模型
// 入参：
//   cfg      配置对象（含各工具开关 + symbol）
//   alphaSig Alpha 信号快照 {lastW, sym, tf} 或 null
//   maRel/chan/rb  各面板的 readout（{tone, verdict}）或 null
//   adaptive 自适应组合摘要 {enabled, bucket, wA, wC, alphaW} 或 null
//   srsi     规则快照 {band} 或 null
//   mainTF   主图周期（用于「跟随」类工具与过滤）
export function buildToolBoardModel(input = {}) {
  const cfg = input.cfg || {};
  const mainTF = input.mainTF || cfg.mainTF || '5m';
  const alphaSig = input.alphaSig || null;
  const maRel = input.maRel || null;
  const chan = input.chan || null;
  const rb = input.rb || null;
  const adaptive = input.adaptive || null;
  const srsi = input.srsi || null;
  const tfOnly = !!cfg.toolBoardTfOnly;

  const rows = [];
  const push = (id, name, nativeTf, concl, dir) => {
    if (id === 'maRel' && !cfg.maRelOn) return;
    if (id === 'rb' && !cfg.rbOn) return;
    if (id === 'chan' && !cfg.chanOn) return;
    if (id === 'alpha' && !cfg.alphaSignalOn) return;
    if (id === 'srsi' && !(cfg.srsiAutoOn || cfg.srsiAutoApplyBt)) return;
    if (id === 'adaptive' && !cfg.adaptiveOverlay) return;
    if (id === 'live' && !cfg.sigOverlay) return;
    if (id === 'monitor' && !cfg.ruleMonitorOpen) return;
    const tf = nativeTf === 'mainTF' ? mainTF : nativeTf;
    rows.push({ id, name, tf, nativeTf: tf, concl: concl || '—', dir: dir || 'none', aligned: tf === mainTF });
  };

  // α 信号 / Alpha 基石（1h + 已收盘日线）
  {
    const w = alphaSig && finite(alphaSig.lastW) ? alphaSig.lastW : null;
    const has = !!(alphaSig && alphaSig.sym);
    const concl = has
      ? ('目标仓位 ' + (w >= 0 ? '+' : '') + Math.round((w || 0) * 100) + '%' + (alphaSig.sym ? ' · ' + alphaSig.sym + (alphaSig.tf ? ' ' + alphaSig.tf : '') : ''))
      : '未计算（点「⚡ 启动信号引擎」）';
    push('alpha', 'α 信号 · Alpha 基石', '1h+日线', concl, has ? alphaDirOf(w) : 'none');
  }
  // 卫星 SRSI（固定 15m）
  {
    const band = srsi && srsi.band ? srsi.band : 'neutral';
    const concl = band === 'upper' ? '上带（超买 → 卫星做空）' : band === 'lower' ? '下带（超卖 → 卫星做多）' : '中性（无带态信号）';
    push('srsi', '卫星 SRSI', '15m', concl, bandDir(band) || 'flat');
  }
  // 自适应组合（1h）
  {
    const en = !!(adaptive && adaptive.enabled);
    const bucketTxt = adaptive && adaptive.bucket === 'high' ? '高波' : adaptive && adaptive.bucket === 'low' ? '低波' : adaptive && adaptive.bucket === 'mid' ? '中波' : null;
    const concl = en
      ? ((bucketTxt ? bucketTxt + ' · ' : '') + 'w_A ' + (finite(adaptive.wA) ? Math.round(adaptive.wA * 100) + '%' : '--') + ' · w_C ' + (finite(adaptive.wC) ? Math.round(adaptive.wC * 100) + '%' : '--'))
      : '未启用（console 启用 window.__adaptivePortfolio）';
    const dir = en ? alphaDirOf(adaptive && finite(adaptive.alphaW) ? adaptive.alphaW : 0) : 'none';
    push('adaptive', '自适应组合', '1h', concl, dir);
  }
  // 跟随 mainTF 的三层（原样引用各面板 verdict）
  push('maRel', '📐 均线关系', 'mainTF', maRel && maRel.verdict, toneDir(maRel && maRel.tone));
  push('rb', '📊 均线带·箱体', 'mainTF', rb && rb.verdict, toneDir(rb && rb.tone));
  push('chan', '🧩 缠论', 'mainTF', chan && chan.verdict, toneDir(chan && chan.tone));
  // 展示层（无方向）
  push('live', '实盘信号', '成交', '实际成交标记（SRSI 15m · Alpha 1h·日线）', 'none');
  push('monitor', '实时监测', '—', '11 条规则链只读镜像（不产生交易信号）', 'none');

  rows.sort((a, b) => TOOL_ORDER.indexOf(a.id) - TOOL_ORDER.indexOf(b.id));
  const shown = tfOnly ? rows.filter((r) => r.nativeTf === mainTF) : rows;
  const counts = toolBoardCounts(shown);
  const conflicts = toolBoardConflicts(shown);
  return { rows: shown, allRows: rows, counts, conflicts, tfOnly, mainTF };
}

// 渲染（纯函数，可单测）：行 + 关系行。无工具开启 → 返回 ''（卡片由 pwaShell 隐藏）。
export function renderToolBoardHtml(model) {
  if (!model || !model.rows || !model.rows.length) return '';
  const rowsHtml = model.rows.map((r) => {
    const cls = r.dir === 'long' ? 'tb-long' : r.dir === 'short' ? 'tb-short' : r.dir === 'flat' ? 'tb-flat' : 'tb-none';
    const tfCls = r.aligned ? ' tb-tf-on' : '';
    return '<div class="tb-row ' + cls + '">' +
      '<span class="tb-name">' + esc(r.name) + '</span>' +
      '<span class="tb-tf' + tfCls + '">' + esc(r.tf) + '</span>' +
      '<span class="tb-concl" title="' + esc(r.concl) + '">' + esc(r.concl) + '</span>' +
      '<span class="tb-dir">' + dirMark(r.dir) + '</span>' +
      '</div>';
  }).join('');
  const c = model.counts;
  const relParts = [];
  if (c.long) relParts.push('<b class="tb-c-long">偏多 ' + c.long + '</b>');
  if (c.short) relParts.push('<b class="tb-c-short">偏空 ' + c.short + '</b>');
  if (c.flat) relParts.push('<b class="tb-c-flat">中性 ' + c.flat + '</b>');
  const relTxt = relParts.length ? relParts.join(' · ') : '无方向型工具开启';
  const conflictHtml = model.conflicts.length
    ? '<div class="tb-conflicts">⚠ 方向冲突：' + model.conflicts.map(esc).join('；') + '</div>'
    : '';
  return '<div class="tb-list">' + rowsHtml + '</div>' +
    '<div class="tb-rel"><span class="tb-rel-k">关系</span><span class="tb-rel-v">' + relTxt + '</span></div>' +
    conflictHtml +
    '<div class="tb-note">各工具结论原样引用、互不融合（工具类信号历史命中≈随机，不做综合评分/方向）</div>';
}

// 测试钩子：工具顺序常量
export const __TOOL_ORDER = TOOL_ORDER.slice();
