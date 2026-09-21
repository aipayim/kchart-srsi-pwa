// 缠论解读面板 —— 共享 HTML 构建器 + 签名守卫 DOM 写入
//
// 主系统（index.html 的 #kchartChan）与 PWA（kchart.html 的 #pwaChan）共用同一份渲染，
// 保证双端文案/字段一致。纯字符串构建（无 DOM 依赖）便于单测；写入函数仅做签名守卫。
//
// ⚠️ 诚实标注：本模块渲染的每份面板都必须包含 CHAN_DISCLAIMER
//   「仅结构描述 · 无统计优势（实时口径 6.7 年回测为负）」。
import { CHAN_DISCLAIMER, CHAN_MULTI_NOTE } from '../engine/chanlunDisplay.js';

// 行样式复用「最近信号」的 .sig-ev（图标 + 彩色标签 + 说明 + 左侧色条）
export function chanlunReadoutHtml(ro) {
  if (!ro) return '';
  const head = '<div class="chan-disc">⚠ ' + CHAN_DISCLAIMER + '</div>';
  if (!ro.ok) return head + '<div class="sig-alert-empty">⏳ ' + (ro.verdict || '数据不足') + '</div>';
  const rows = (ro.rows || []).map((r) =>
    '<div class="sig-ev sig-ev-signal" style="border-left-color:' + r.color + '">' +
      '<span class="sig-ev-i" style="color:' + r.color + '">' + r.icon + '</span>' +
      '<span class="sig-ev-k" style="color:' + r.color + '">' + r.label + '</span>' +
      '<span class="sig-ev-d">' + (r.detail || '') + '</span>' +
    '</div>').join('');
  const concl = '<div class="chan-concl">→ ' + (ro.verdict || '') + '</div>';
  const note = '<div class="chan-note">' + CHAN_MULTI_NOTE + '</div>';
  return head + rows + concl + note;
}

// 签名守卫写入：内容未变不重建 DOM（避免每秒 tick 重置滚动/闪烁）
export function renderChanlunInto(box, ro) {
  if (!box) return false;
  const html = chanlunReadoutHtml(ro);
  if (box.__chanSig === html) return false;
  box.__chanSig = html;
  box.innerHTML = html;
  return true;
}
