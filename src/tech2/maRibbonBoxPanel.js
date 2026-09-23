// 多均线带 + 箱体 解读面板 —— 共享 HTML 构建器 + 签名守卫 DOM 写入
//
// 主系统（index.html 的 #kchartRb）与 PWA（kchart.html 的 #pwaRb）共用同一份渲染，
// 保证双端文案/字段一致。纯字符串构建（无 DOM 依赖）便于单测；写入函数仅做签名守卫。
//
// 行样式复用「最近信号」的 .sig-ev（图标 + 彩色标签 + 说明 + 左侧色条）；
// 警示条/结论行/注脚复用缠论面板的 .chan-disc/.chan-concl/.chan-note（同一视觉角色，零额外 CSS）。
//
// ⚠ 诚实标注：本模块渲染的每份面板都必须包含 RB_DISCLAIMER + RB_NO_TRADE
//   「行为级近似（原指标名/参数/是否重绘未知）· 同族审计无统计优势 · 仅盯盘辅助」
//   「不接自动交易 · 不配资金（要接须先过四关：长窗正贡献/防爆/regime/参数平台）」
import { RB_DISCLAIMER, RB_NO_TRADE } from '../engine/maRibbonBox.js';

export function maRibbonBoxReadoutHtml(ro) {
  if (!ro) return '';
  const head = '<div class="chan-disc">⚠ ' + RB_DISCLAIMER + '</div>';
  if (!ro.ok) return head + '<div class="sig-alert-empty">⏳ ' + (ro.verdict || '数据不足') + '</div>';
  const rows = (ro.rows || []).map((r) =>
    '<div class="sig-ev sig-ev-signal" style="border-left-color:' + r.color + '">' +
      '<span class="sig-ev-i" style="color:' + r.color + '">' + r.icon + '</span>' +
      '<span class="sig-ev-k" style="color:' + r.color + '">' + r.label + '</span>' +
      '<span class="sig-ev-d">' + (r.detail || '') + '</span>' +
    '</div>').join('');
  const concl = '<div class="chan-concl">→ ' + (ro.verdict || '') + '</div>';
  const note = '<div class="chan-note">' + RB_NO_TRADE + '</div>';
  return head + rows + concl + note;
}

// 签名守卫写入：内容未变不重建 DOM（避免每秒 tick 重置滚动/闪烁）
export function renderMaRibbonBoxInto(box, ro) {
  if (!box) return false;
  const html = maRibbonBoxReadoutHtml(ro);
  if (box.__rbSig === html) return false;
  box.__rbSig = html;
  box.innerHTML = html;
  return true;
}
