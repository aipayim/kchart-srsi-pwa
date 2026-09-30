// ============================================================
// PWA「👁 Jev×SRSI 裁决审计」面板（GOAL_jev-srsi §3 · P1）—— 纯渲染，可单测
//
// 定位：把 src/pwa/jevSrsiAudit.js 累积的配对样本，按「Jev 同向 / 反向 / 中性或缺」三组展示
//   命中率 / 均值盈亏 / 样本数 / 95% CI，并给出「同向 − 反向」增量（pp）。
//
// 红线：**只观察**——固定标注「模型判断·非交易建议·未接入执行」「不接执行」；
//   样本不足时明确写「暂不结论」，绝不给出可执行建议（P2 判定线通过前不接卫星）。
// 零回归：主系统 index.html 无 #pwaJevAuditCard → pwaShell 渲染器 no-op。
// ============================================================

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

export const AUDIT_DISCLAIMER = '模型判断·非交易建议·未接入执行';
export const AUDIT_GROUP_COLORS = { same: '#2ecc71', reverse: '#ff6b6b', flat: '#8b95a5' };

function pct(v, d = 1) { return finite(v) ? (v * 100).toFixed(d) + '%' : '--'; }
function pp(v, d = 1) { return finite(v) ? ((v >= 0 ? '+' : '') + v.toFixed(d) + ' pp') : '--'; }
function pnl(v) { return finite(v) ? ((v >= 0 ? '+' : '') + v.toFixed(2) + '%') : '--'; }
function ciTxt(ci) { return Array.isArray(ci) && ci.length === 2 ? ('95%CI ' + pct(ci[0], 0) + '~' + pct(ci[1], 0)) : ''; }

/**
 * 构建面板模型（纯函数）。
 * @param input {stats, sym, now, lastErr, available}
 */
export function buildJevAuditModel(input = {}) {
  const st = input.stats || null;
  const rows = ['same', 'reverse', 'flat'].map((k) => {
    const g = (st && st.groups && st.groups[k]) || null;
    const dec = g ? (g.wins + g.losses) : 0;
    return {
      key: k,
      label: g ? g.label : ({ same: 'Jev 同向', reverse: 'Jev 反向', flat: 'Jev 中性或缺' }[k]),
      color: AUDIT_GROUP_COLORS[k],
      n: g ? g.n : 0,
      wins: g ? g.wins : 0,
      losses: g ? g.losses : 0,
      expired: g ? g.expired : 0,
      pending: g ? g.pending : 0,
      hitRate: g ? g.hitRate : null,
      hitTxt: (g && g.hitRate != null) ? (pct(g.hitRate, 1) + '（' + g.wins + '/' + dec + '）') : '（无已判定样本）',
      avgPnl: g ? g.avgPnl : null,
      avgPnlTxt: pnl(g ? g.avgPnl : null),
      ci: g ? g.ci : null,
      ciTxt: ciTxt(g ? g.ci : null)
    };
  });
  const total = st ? st.total : 0;
  const inc = st ? st.increment : null;
  const enough = !!(st && st.enough);
  const minPairs = (st && st.minPairs) || 300;
  const minGroup = (st && st.minGroup) || 100;
  let verdictTxt, verdictClass;
  if (!total) {
    verdictTxt = '暂无配对样本——需 Jev 判断 x SRSI 信号同时发生（保持页面开启以累积）。';
    verdictClass = 'dim';
  } else if (!enough) {
    verdictTxt = '样本不足（需 ≥' + minPairs + ' 对且每组 ≥' + minGroup + '；当前 ' + total + ' 对）→ 暂不结论。';
    verdictClass = 'warn';
  } else {
    verdictTxt = (inc != null)
      ? ('增量 ' + pp(inc) + '（已达门槛；由 P2 判定线：校正后 p<0.05 且 walk-forward 同号才可接入）。')
      : '已达样本门槛，但同向/反向两组尚未都判定完 → 暂不结论。';
    verdictClass = (inc != null && inc > 0) ? 'ok' : 'bad';
  }
  return {
    available: input.available !== false,
    sym: input.sym || null,
    total, decided: st ? st.decided : 0, pending: st ? st.pending : 0,
    noEntry: st ? st.noEntry : 0,
    coveragePct: st ? st.coverage : 0,
    days: st ? st.days : 0,
    rows, increment: inc, incrementTxt: pp(inc), enough,
    minPairs, minGroup,
    verdictTxt, verdictClass,
    lastErr: input.lastErr || null,
    disclaimer: AUDIT_DISCLAIMER
  };
}

/** 渲染面板 HTML（纯函数）。无样本时也给引导，不返回空串（卡片始终可见以提示累积）。 */
export function renderJevAuditHtml(m) {
  if (!m || m.available === false) return '';
  const head = '<div class="ja-head">' +
    '<span class="ja-kv">样本</span><b>' + m.total + '</b> 对' +
    '<span class="ja-sep">·</span>' +
    '<span class="ja-kv">已判定</span><b>' + m.decided + '</b>' +
    '<span class="ja-sep">·</span>' +
    '<span class="ja-kv">待回填</span><b>' + m.pending + '</b>' +
    (m.noEntry ? '<span class="ja-sep">·</span><span class="ja-kv">无法判定</span><b>' + m.noEntry + '</b>' : '') +
    '<span class="ja-sep">·</span>' +
    '<span class="ja-kv">Jev 覆盖</span><b>' + pct(m.coveragePct, 0) + '</b>' +
    '<span class="ja-sep">·</span>' +
    '<span class="ja-kv">观察</span><b>' + (finite(m.days) ? m.days.toFixed(1) : '0.0') + '</b> 天' +
    '</div>';

  const rowsHtml = m.rows.map((r) => {
    const pn = r.pending ? '<span class="ja-pend">待 ' + r.pending + '</span>' : '';
    return '<div class="ja-row ja-' + r.key + '" style="border-left-color:' + r.color + '">' +
      '<span class="ja-lab" style="color:' + r.color + '">' + esc(r.label) + '</span>' +
      '<span class="ja-n">n=' + r.n + '</span>' +
      '<span class="ja-hit">' + esc(r.hitTxt) + '</span>' +
      '<span class="ja-pnl">均值 ' + esc(r.avgPnlTxt) + '</span>' +
      '<span class="ja-ci">' + esc(r.ciTxt) + '</span>' +
      pn +
      '</div>';
  }).join('');

  const incLine = '<div class="ja-inc ja-inc-' + (m.increment == null ? 'na' : (m.increment > 0 ? 'pos' : m.increment < 0 ? 'neg' : 'zero')) + '">' +
    '<span class="ja-kv">增量（同向 − 反向）</span><b>' + esc(m.incrementTxt) + '</b></div>';

  const err = m.lastErr ? '<div class="ja-err">存储告警：' + esc(m.lastErr) + '</div>' : '';
  return '<div class="ja-wrap">' +
    head +
    '<div class="ja-rows">' + rowsHtml + '</div>' +
    incLine +
    '<div class="ja-note ja-' + esc(m.verdictClass) + '">' + esc(m.verdictTxt) + '</div>' +
    err +
    '<div class="ja-disc">' + esc(m.disclaimer) + ' · 仅观察·不接执行（含超时未触发=计入 expired，不计命中率）</div>' +
    '</div>';
}
