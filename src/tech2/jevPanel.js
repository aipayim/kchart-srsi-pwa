// Jev 面板（PWA「信号驾驶舱」下方新卡 + 设置卡）——纯模型/HTML 构建，DOM 绑定在 pwaShell.js
//
// 显示三件事（用户裁定）：
//   ① Jev 判断（短/中/长：方向 + 强度 + 置信 + 驱动 + 新鲜度 + 成本）
//   ② Jev × TSEV 关系（同向/相反 + 本机已学到的 jev|* 权重与样本 + 三态开关当前状态）
//   ③ 三行长/中/短强度滑块（−100…+100：启用 Jev 时 = Jev 强度；关 Jev 后 = 本机 TSEV 已学偏置）
//
// 固定标注「模型判断·非交易建议·未接入执行」（红线）。
import { JEV_HORIZONS, JEV_HORIZON_IDS, JEV_MODES, JEV_DRIVERS } from '../engine/jevState.js';

export const JEV_DISCLAIMER = '模型判断 · 非交易建议 · 未接入执行（只做显示与本地学习）';

const fmtPct = (v, d = 0) => (v == null || !isFinite(v)) ? '—' : (v >= 0 ? '+' : '') + Number(v).toFixed(d) + '%';
const fmtTime = (ts) => {
  if (!ts) return '—';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '—';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  return sameDay ? hm : (String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' ' + hm);
};
const fmtAgo = (ms) => {
  if (ms == null || !isFinite(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 's前';
  if (s < 3600) return Math.round(s / 60) + 'm前';
  if (s < 86400) return Math.round(s / 3600) + 'h前';
  return Math.round(s / 86400) + 'd前';
};
const toneOf = (v) => (v == null ? 'flat' : v >= 15 ? 'long' : v <= -15 ? 'short' : 'flat');

/**
 * 滑块视图（纯函数）：三态开关必须真实生效（不能是装饰性）：
 *  - mode='apply'（学并影响）+ 有 Jev 读数 → 值 = **Jev 强度**（source 'jev'，表示「已计入」），tick = 置信度
 *  - mode='learn'（只学不影响）→ 值 = **仅本机 TSEV 已学偏置**（source 'tsev'）；无权重则 0/none
 *    → 切「只学」↔「学并影响」，滑块会从 TSEV 偏置跳到 Jev 强度（差异可见）
 *  - mode='off' → 同 learn（不记录新样本）
 * 本机 TSEV 偏置 = (wLong − wShort) 归一 → 这就是「关掉 Jev 后权重仍在本地生效/可见」的体现
 */
export function sliderView(jev, tsev, mode) {
  const wl = (tsev && isFinite(tsev.long)) ? tsev.long : null;
  const ws = (tsev && isFinite(tsev.short)) ? tsev.short : null;
  const affecting = (mode || 'off') === 'apply';
  const js = (jev && jev.strength != null) ? Math.max(-100, Math.min(100, Math.round(jev.strength))) : null;
  if (affecting && js != null) {
    return { value: js, source: 'jev', tick: jev.conf != null ? jev.conf : null, tone: toneOf(js), affecting: true, ghostValue: null };
  }
  if (wl != null || ws != null) {
    const bias = (wl || 0) - (ws || 0);
    const v = Math.max(-100, Math.min(100, Math.round(bias / 1.5 * 100)));
    return { value: v, source: 'tsev', tick: null, tone: toneOf(v), affecting: false, ghostValue: js };
  }
  return { value: 0, source: 'none', tick: null, tone: 'flat', affecting: false, ghostValue: js };
}

/** 是否过期（超过 3× 调用间隔视为陈旧） */
export function isStale(ts, freqMs, now) {
  if (!ts) return true;
  if (!isFinite(freqMs) || freqMs <= 0) return false;
  return (now - ts) > freqMs * 3;
}

/** Jev 方向 × 本机 TSEV 已学权重 → 关系 */
export function jevTsevRelation(jevStrength, tsev) {
  const side = jevStrength == null ? null : (jevStrength >= 15 ? 'long' : jevStrength <= -15 ? 'short' : null);
  const w = side ? (side === 'long' ? tsev && tsev.long : tsev && tsev.short) : null;
  if (side == null) return { side: null, w: null, relation: 'na', text: '中性（无方向，不参与对比）' };
  if (w == null || !isFinite(w)) return { side, w: null, relation: 'nodata', text: '本机 TSEV 尚无该方向样本（需累积到训练门槛才开始生效）' };
  if (w > 0) return { side, w, relation: 'agree', text: '本机 TSEV 认同该方向（该方向历史命中偏高）' };
  return { side, w, relation: 'differ', text: '本机 TSEV 反向（该方向历史命中偏低）→ 谨慎' };
}

/**
 * 构建面板模型（纯函数）
 * inp: { sym, cfg, latest, decisions, stats, status, now }
 */
export function buildJevModel(inp) {
  const it = inp || {};
  const cfg = it.cfg || {};
  const now = it.now || Date.now();
  const stats = it.stats || { byHorizon: {}, learned: {}, pending: 0, n: 0 };
  const latest = it.latest || null;
  const rows = [];
  let agree = 0, differ = 0, na = 0, nodata = 0;
  for (const h of JEV_HORIZONS) {
    const d = latest && latest.dirs ? latest.dirs[h.id] : null;
    const strength = d && d.strength != null ? d.strength : null;
    const tsev = (stats.learned && stats.learned[h.id]) ? stats.learned[h.id] : { long: null, short: null };
    const prog = (stats.progress && stats.progress[h.id]) ? stats.progress[h.id] : { long: null, short: null };
    const rel = jevTsevRelation(strength, tsev);
    if (rel.relation === 'agree') agree++;
    else if (rel.relation === 'differ') differ++;
    else if (rel.relation === 'nodata') nodata++;
    else na++;
    const b = (stats.byHorizon && stats.byHorizon[h.id]) || {};
    const slider = sliderView(d ? { strength, conf: d.conf } : null, tsev, cfg.mode);
    rows.push({
      id: h.id, name: h.name, desc: h.desc,
      stale: isStale(latest ? latest.ts : null, it.freqMs, now),
      strength, label: d ? (d.label || '未知') : '—',
      conf: d && d.conf != null ? d.conf : null,
      type: d ? d.type : null,
      tsev, rel, slider, prog,
      hit: { n: b.n || 0, wins: b.wins || 0, losses: b.losses || 0, winRate: b.winRate != null ? b.winRate : null, avgPnl: b.avgPnl != null ? b.avgPnl : null, expired: b.expired || 0 }
    });
  }
  const spend = cfg.spend || {};
  const pIn = (cfg.price && cfg.price.inPer1M) || 0;
  const pOut = (cfg.price && cfg.price.outPer1M) || 0;
  return {
    sym: it.sym || '—',
    enabled: !!cfg.enabled,
    hasToken: !!it.hasToken,
    mode: cfg.mode || 'off',
    modeText: (JEV_MODES[cfg.mode] || JEV_MODES.off).short,
    freq: cfg.freq || '1h',
    model: cfg.model || '—',
    driver: latest ? (latest.driver || null) : null,
    latestTs: latest ? latest.ts : null,
    latestAgo: latest ? fmtAgo(now - latest.ts) : '从未调用',
    latestMs: latest ? latest.ms : null,
    latestErr: latest && latest.err ? latest.err : null,
    rows,
    relation: { agree, differ, na, nodata },
    stats,
    pending: stats.pending || 0,
    total: stats.n || 0,
    history: it.history || null,
    minSample: stats.minSample || 50,
    local: stats.local || null,
    inPer1M: pIn,
    outPer1M: pOut,
    fill: it.fill || null,
    flow: it.flow || null,
    spend: { calls: spend.calls || 0, inTok: spend.inTok || 0, outTok: spend.outTok || 0, cost: spend.cost || 0 },
    status: it.status || {}
  };
}

const relBadge = (rel) => {
  if (rel.relation === 'agree') return '<span class="jev-tag ok">同向</span>';
  if (rel.relation === 'differ') return '<span class="jev-tag bad">相反</span>';
  if (rel.relation === 'nodata') return '<span class="jev-tag mute">样本不足</span>';
  return '<span class="jev-tag mute">中性</span>';
};

function sliderHtml(r) {
  const v = r.slider.value;
  // 0 点在中；条宽 = |v|/2 %（每半侧 50%）
  const half = Math.min(50, Math.abs(v) / 2);
  const left = v >= 0 ? 50 : 50 - half;
  const tick = r.slider.tick != null ? Math.max(0, Math.min(1, r.slider.tick)) : null;
  const srcTxt = r.slider.source === 'jev' ? 'Jev ' + (v >= 0 ? '+' : '') + v + '（已计入）'
    : r.slider.source === 'tsev' ? '本机TSEV偏置 ' + (v >= 0 ? '+' : '') + v + (r.slider.ghostValue != null ? '（Jev ' + (r.slider.ghostValue >= 0 ? '+' : '') + r.slider.ghostValue + ' 未计入）' : '')
      : (r.slider.ghostValue != null ? '本机TSEV 无权重（Jev ' + (r.slider.ghostValue >= 0 ? '+' : '') + r.slider.ghostValue + ' 未计入）' : '无数据');
  const srcTip = r.slider.source === 'jev' ? '来源：Jev 判断强度（当前开「学并影响」→ 已计入强度）'
    : r.slider.source === 'tsev' ? '来源：本机 TSEV 已学到的 jev 因子权重（「只学不影响」时只看它；Jev 关掉后依然保留）；细线 = Jev 当前位置（仅展示）'
      : '暂无数据（需先有 Jev 读数，或累积到 50 条同向样本）；细线 = Jev 当前位置（未计入）';
  const ghost = r.slider.ghostValue != null
    ? '<i class="jev-sld-ghost" style="left:' + (50 + Math.max(-50, Math.min(50, r.slider.ghostValue / 2))) + '%" title="Jev 位置 ' + r.slider.ghostValue + '（未计入强度）"></i>'
    : '';
  return '<div class="jev-slider">' +
    '<span class="jev-sld-name">' + r.name + '</span>' +
    '<span class="jev-sld-track">' +
      '<i class="jev-sld-zero"></i>' +
      '<i class="jev-sld-fill ' + r.slider.tone + '" style="left:' + left + '%;width:' + half + '%"></i>' +
      ghost +
      (tick != null ? '<i class="jev-sld-tick" style="left:' + (50 + (tick * 50)) + '%" title="置信度刻度 ' + Math.round(tick * 100) + '%"></i>' : '') +
    '</span>' +
    '<span class="jev-sld-val ' + r.slider.tone + '">' + srcTxt + '</span>' +
    '<span class="jev-sld-src" title="' + srcTip + '">' + (r.slider.source === 'jev' ? 'J' : r.slider.source === 'tsev' ? 'T' : '–') + '</span>' +
  '</div>';
}

// 「本机 TSEV」行：有权重→显示 w；未达门槛→显示样本进度 n/50（回答「怎样才能生效」）
function tsevLineHtml(r, minSample) {
  const t = r.tsev || {};
  const p = r.prog || {};
  const min = minSample || 50;
  if (t.long != null || t.short != null) {
    return '本机 TSEV: w<sub>多</sub>' + (t.long != null ? t.long.toFixed(2) : '—') + ' / w<sub>空</sub>' + (t.short != null ? t.short.toFixed(2) : '—');
  }
  const parts = [];
  for (const [side, label] of [['long', '看多'], ['short', '看空']]) {
    const x = p[side];
    const n = (x && x.n) || 0;
    parts.push(label + ' ' + n + '/' + min + (x && x.p != null ? '（命中 ' + Math.round(x.p * 100) + '%）' : ''));
  }
  return '本机 TSEV: 未达训练门槛 · 样本 ' + parts.join(' · ');
}

function rowHtml(r, minSample) {
  const s = r.strength;
  const tone = toneOf(s);
  const confTxt = r.conf != null ? '置信 ' + Math.round(r.conf * 100) + '%' : '置信 —';
  return '<div class="jev-row' + (r.stale ? ' stale' : '') + '">' +
    '<div class="jev-row-h"><span class="jev-hname">' + r.name + '线</span>' +
      '<span class="jev-dir ' + tone + '">' + (s == null ? '—' : r.label + ' ' + (s >= 0 ? '+' : '') + Math.round(s)) + '</span>' +
      '<span class="jev-conf">' + confTxt + '</span>' + relBadge(r.rel) + '</div>' +
    '<div class="jev-row-b">' + r.rel.text + '<br><span class="jev-tsev">' + tsevLineHtml(r, minSample) + '</span>' +
      (r.hit.n ? ' · 历史命中 ' + Math.round(r.hit.winRate * 100) + '%(' + r.hit.wins + '/' + r.hit.n + ')' + (r.hit.avgPnl != null ? ' · 均 ' + fmtPct(r.hit.avgPnl, 2) : '') : ' · 暂无已判定样本') +
    '</div></div>';
}

/**
 * 构建「最近 N 笔判断」历史（纯函数，可单测）
 * 一次调用 = 一行（内含短/中/长三档各自的到期结果）；最新在前。
 * 单档状态：win ✓命中 / loss ✗未中 / pending ⏳待回填 / expired ○到期未触发 / flat –中性不计
 */
export function buildJevHistory(decisions, sym, opts = {}) {
  const limit = Math.max(1, opts.limit || 10);
  const rows = (decisions || [])
    .filter(r => r && (!sym || r.sym === sym))
    .slice(0, limit)
    .map(r => {
      const oc = r.outcomes || {};
      const horizons = JEV_HORIZONS.map(h => {
        const d = (r.dirs || {})[h.id];
        if (!d || d.strength == null) return null;
        const s = Math.round(d.strength);
        const side = s >= 15 ? 'long' : s <= -15 ? 'short' : 'flat';
        const o = oc[h.id];
        let status = 'pending', pnl = null, bars = null, tf = null;
        if (o) {
          pnl = (o.pnlPct != null && isFinite(o.pnlPct)) ? o.pnlPct : null;
          bars = o.bars || null;
          tf = o.tf || null;
          if (side === 'flat') status = 'flat';
          else if (o.win === 1) status = 'win';
          else if (o.win === -1) status = 'loss';
          else status = 'expired';
        }
        return {
          id: h.id, name: h.name, side, strength: s, label: d.label || (side === 'long' ? '偏多' : side === 'short' ? '偏空' : '中性'),
          conf: d.conf != null ? d.conf : null, status, pnl, bars, tf, sideNum: side === 'long' ? 1 : side === 'short' ? -1 : 0
        };
      }).filter(Boolean);
      // 主方向（用于行左侧色条）：取第一档有方向的；均为中性→灰
      const main = horizons.find(x => x.side !== 'flat') || null;
      return {
        ts: r.ts, model: r.model || null, driver: r.driver || null, ms: r.ms || null,
        inTok: r.inTok || 0, outTok: r.outTok || 0, err: r.err || null, matured: !!r.matured,
        horizons, mainSide: main ? main.side : 'flat'
      };
    });
  // 汇总（按档计）
  const sum = { win: 0, loss: 0, pending: 0, expired: 0, flat: 0, decided: 0, pnls: 0, pnlN: 0, calls: rows.length };
  for (const r of rows) {
    for (const h of r.horizons) {
      sum[h.status] = (sum[h.status] || 0) + 1;
      if (h.status === 'win' || h.status === 'loss') { sum.decided++; if (h.pnl != null) { sum.pnls += h.pnl; sum.pnlN++; } }
    }
  }
  sum.winRate = sum.decided ? sum.win / sum.decided : null;
  sum.avgPnl = sum.pnlN ? sum.pnls / sum.pnlN : null;
  return { rows, summary: sum, limit, maturityNote: MATURITY_NOTE };
}

const HIST_SYM = { win: '✓', loss: '✗', pending: '⏳', expired: '○', flat: '–' };
const HIST_CLS = { win: 'win', loss: 'loss', pending: 'pending', expired: 'expired', flat: 'flat' };
// 到期口径（与 jevClient.JEV_EVAL + winLossByAtr 同源）——直接回答用户「要等多久才有结果」
export const MATURITY_NOTE = '到期口径：短 ≈24h（1h×24）· 中 ≈5天（4h×30）· 长 ≈30天（1d×30）；TP 2×ATR / SL 1.5×ATR，到期未触发不计胜负 · 样本在到期后才进入 TSEV 学习';

/** 历史列表 HTML（纯函数）：时间 + 三档结果 + 驱动/置信度 */
export function renderJevHistoryHtml(hist) {
  if (!hist || !hist.rows || !hist.rows.length) return '';
  const s = hist.summary || {};
  const sumTxt = '已判定 ' + (s.decided || 0) + ' 档 · 命中 ' + (s.win || 0) + ' · 未中 ' + (s.loss || 0) +
    (s.decided ? ' · 命中率 ' + Math.round((s.winRate || 0) * 100) + '%' + (s.avgPnl != null ? ' · 均盈亏 ' + fmtPct(s.avgPnl, 2) : '') : '') +
    ' · 待回填 ' + (s.pending || 0) + (s.expired ? ' · 到期未触发 ' + s.expired : '') + (s.flat ? ' · 中性 ' + s.flat : '');
  const head = '<div class="mar-sep">── 最近 ' + hist.rows.length + ' 笔判断（一次调用一行）──</div>' +
    '<div class="jev-hist-sum">' + sumTxt + '</div>' +
    '<div class="jev-hist-note">' + (hist.maturityNote || '') + '</div>';
  const rows = hist.rows.map(r => {
    const col = r.mainSide === 'long' ? '#2ecc71' : r.mainSide === 'short' ? '#ff6b6b' : '#8899aa';
    const icon = r.mainSide === 'long' ? '▲' : r.mainSide === 'short' ? '▼' : '·';
    const chips = r.horizons.map(h => {
      const c = h.status === 'win' ? '#2ecc71' : h.status === 'loss' ? '#ff6b6b' : '#8899aa';
      const dirTxt = h.side === 'flat' ? '中性' : h.label + ' ' + (h.strength >= 0 ? '+' : '') + h.strength;
      const tail = h.status === 'pending' ? ' 待回填'
        : h.status === 'expired' ? ' 未触发'
          : h.status === 'flat' ? ''
            : (h.pnl != null ? ' ' + fmtPct(h.pnl, 2) : '');
      return '<i class="jev-hc ' + HIST_CLS[h.status] + '" style="color:' + c + '">' + h.name + ' ' + dirTxt + ' ' + HIST_SYM[h.status] + tail + '</i>';
    }).join('');
    const confs = r.horizons.map(h => h.conf != null ? Math.round(h.conf * 100) + '%' : '—').join('/');
    const meta = [r.driver ? '驱动 ' + r.driver : null, '置信 ' + confs,
      r.err ? '⚠ ' + String(r.err).slice(0, 40) : null].filter(Boolean).join(' · ');
    return '<div class="sig-ev sig-ev-signal" style="border-left-color:' + col + '">' +
      '<span class="sig-ev-t">' + fmtTime(r.ts) + '</span>' +
      '<span class="sig-ev-i" style="color:' + col + '">' + icon + '</span>' +
      '<span class="jev-hist-chips">' + chips + '</span>' +
      '<span class="sig-ev-d">' + meta + '</span>' +
    '</div>';
  }).join('');
  return head + rows;
}

/** 面板 HTML（纯函数，可单测） */
export function renderJevHtml(m) {
  if (!m) return '';
  const modeCls = m.mode === 'apply' ? 'ok' : m.mode === 'learn' ? 'warn' : 'mute';
  const head = '<div class="jev-head">' +
    '<span class="jev-pill ' + (m.enabled ? 'ok' : 'mute') + '">' + (m.enabled ? '● 已启用' : '○ 未启用') + '</span>' +
    '<span class="jev-pill ' + modeCls + '" title="TSEV 学 Jev 三态：关／只学不影响（只记录样本，强度只看本机 TSEV）／学并影响（Jev 计入强度）">TSEV ' + m.modeText + '</span>' +
    '<span class="jev-pill mute" title="调用频率">' + m.freq + '</span>' +
    '<span class="jev-dim">上次 ' + (m.latestTs ? m.latestAgo + '（' + fmtTime(m.latestTs) + '）' : '从未调用') + '</span>' +
  '</div>' +
  '<div class="jev-modehint">' + (m.mode === 'apply'
    ? '「学并影响」：下方滑块 = Jev 强度（已计入）'
    : m.mode === 'learn'
      ? '「只学不影响」：滑块只看本机 TSEV（Jev 读数仅展示、不计入）'
      : '「关」：不记录样本；滑块只看本机 TSEV') + '</div>';

  const rel = '<div class="jev-rel">Jev × TSEV 关系：' +
    '<b class="up">同向 ' + m.relation.agree + '</b> · <b class="down">相反 ' + m.relation.differ + '</b> · ' +
    '中性 ' + m.relation.na + ' · 样本不足 ' + m.relation.nodata + '</div>';

  // 数据填充度（诚实口径：拿不到就写未知，不影响判断/学习）
  const fill = m.fill
    ? '<div class="jev-fill">数据：' + m.fill.text + '</div>'
    : '<div class="jev-fill jev-dim">数据：盘口/新闻未采集（点「立即判断一次」会一并拉取；拉不到即为未知，不影响 Jev 判断）</div>';
  // 因子族说明：本机 TSEV 里「经典纪律因子」的历史样本与「Jev 因子」是**分开计**的
  const loc = m.local || null;
  const fam = loc && (loc.sampleCount || loc.factorCount)
    ? '<div class="jev-fam">本机 TSEV 共 <b>' + loc.sampleCount + '</b> 条样本 / 已学 <b>' + loc.factorCount + '</b> 个<b>经典纪律因子</b>' +
      '（首开时用近 4 年历史 walk-forward 回补所得）· <b>Jev 因子另计</b>（Jev 无法回补历史，只能前向累积）</div>'
    : (loc ? '<div class="jev-fam jev-dim">本机 TSEV 尚未回补（或本机 loop 未开启）→ 设置页可查看本机 loop 状态</div>' : '');

  const driver = m.driver ? '<div class="jev-driver">主要驱动：<b>' + m.driver + '</b>' + (JEV_DRIVERS[m.driver] ? '（' + JEV_DRIVERS[m.driver] + '）' : '') + '</div>' : '';

  const sliders = '<div class="jev-sliders">' + m.rows.map(sliderHtml).join('') + '</div>';

  const rows = m.rows.map(r => rowHtml(r, m.minSample)).join('');

  const foot = '<div class="jev-foot">' +
    '样本 ' + m.total + ' 条（待回填 ' + m.pending + '）· 累计 ' + m.spend.calls + ' 次调用 / ' + (m.spend.inTok + m.spend.outTok) + ' tokens' + (m.spend.cost ? ' · 费用 $' + m.spend.cost.toFixed(4) : (m.inPer1M || m.outPer1M ? ' · 费用 $0' : ' · 费用 $0（未设单价·本地网关免费）')) +
  '</div>' +
  (m.latestErr ? '<div class="jev-err">⚠ 上次调用失败：' + m.latestErr + '</div>' : '') +
  (!m.enabled ? '<div class="jev-hint">未启用：不产生调用与样本。到「设置 → Jev 判断（LLM）」开启。</div>' :
    !m.hasToken ? '<div class="jev-err">⚠ 已启用但未填写 Token（Token 只存本机加密库）</div>' : '') +
  '<div class="jev-foot2">' + JEV_DISCLAIMER + '</div>';

  const hist = m.history ? renderJevHistoryHtml(m.history) : '';
  return head + rel + fill + fam + driver + sliders + rows + hist + foot;
}

/** 设置卡 HTML（纯函数） */
export function renderJevSetHtml(cfg, extra) {
  const c = cfg || {};
  const ex = extra || {};
  const modes = Object.keys(JEV_MODES).map(k =>
    '<option value="' + k + '"' + (c.mode === k ? ' selected' : '') + '>' + JEV_MODES[k].label + '</option>').join('');
  const freqOpts = [['15m', '15 分钟'], ['1h', '1 小时'], ['4h', '4 小时'], ['1d', '1 天'], ['manual', '仅手动']]
    .map(([v, t]) => '<option value="' + v + '"' + (c.freq === v ? ' selected' : '') + '>' + t + '</option>').join('');
  const hz = JEV_HORIZONS.map(h =>
    '<label class="jev-chk"><input type="checkbox" data-hz="' + h.id + '"' + (c.horizons && c.horizons[h.id] ? ' checked' : '') + '>' + h.name + '线（' + h.desc + '）</label>').join('');
  const groupRows = JEV_HORIZONS.map(h =>
    '<div class="setting-row"><label>' + h.name + '线周期</label><input type="text" data-grp="' + h.id + '" value="' +
    ((c.groups && c.groups[h.id]) || []).join(',') + '" placeholder="逗号分隔，如 5m,15m,1h"></div>').join('');
  const spend = c.spend || {};
  return '' +
    '<div class="setting-row"><label>启用 Jev</label><select id="jevEnabled"><option value="0">关闭</option><option value="1">开启</option></select></div>' +
    '<div class="setting-row"><label>base_url</label><input id="jevBase" type="text" style="flex:1;min-width:170px" placeholder="如 http://localhost:3460/v1 或 https://你的Jev地址/v1"></div>' +
    '<div class="setting-row"><label>模型</label><input id="jevModel" type="text" list="jevModels" style="flex:1;min-width:130px"><datalist id="jevModels"><option value="jev-latest"></option><option value="jev-1.13.0"></option></datalist>' +
      '<button id="jevProbe" title="依次试 5 种请求形状，看哪种被接受">探测形状</button></div>' +
    '<div class="setting-row"><label>Token</label><input id="jevToken" type="password" autocomplete="off" spellcheck="false" style="flex:1;min-width:150px" placeholder="' + (ex.hasToken ? '已保存（留空=不修改）' : '未填写') + '">' +
      '<button id="jevTokenSave">保存</button><button id="jevTokenClear">清除</button></div>' +
    '<div class="setting-row"><label></label><span id="jevTokMsg" class="jev-setmsg">' + (ex.hasToken ? '✓ 已保存（AES-GCM 加密，只存本机 IndexedDB）' : '未填写 Token') + '</span></div>' +
    '<div class="setting-row"><label>连接</label><button id="jevTest">测试连接</button><span id="jevTestMsg" class="jev-setmsg"></span></div>' +
    '<div class="setting-row"><label>调用频率</label><select id="jevFreq">' + freqOpts + '</select><button id="jevRunNow">立即判断一次</button></div>' +
    '<div class="setting-row"><label>TSEV 学 Jev</label><select id="jevMode">' + modes + '</select></div>' +
    '<div class="jev-chks">' + hz + '</div>' +
    groupRows +
    '<div class="setting-row"><label>新闻源（可选）</label><input id="jevNews" type="text" style="flex:1;min-width:170px" placeholder="RSS 直链 或 包裹代理 https://代理/?url={url}（空=开发走 /rss-proxy，生产为未知）"></div>' +
    '<div class="setting-row"><label>单价 ($/1M tokens)</label><span class="jev-inline">入 <input id="jevIn" type="number" min="0" step="any" style="width:64px"> 出 <input id="jevOut" type="number" min="0" step="any" style="width:64px"></span></div>' +
    '<div class="jev-dim" style="margin:2px 0 4px">累计：' + (spend.calls || 0) + ' 次调用 · ' + ((spend.inTok || 0) + (spend.outTok || 0)) + ' tokens · ' + ((spend.cost || 0) ? '$' + spend.cost.toFixed(4) : '$0（本地网关免费）') + '</div>' +
    '<details class="jev-adv"><summary>高级：请求体 JSON 模板（{{model}} / {{state}} 占位符；留空用内置）</summary>' +
      '<textarea id="jevTpl" spellcheck="false" placeholder="留空 = 内置（一次调用问短/中/长 + 驱动）"></textarea>' +
      '<div class="jev-dim">上游 schema 变更时，可在这里改形状而无需等更新（配合「探测形状」）。</div></details>' +
    '<div class="jev-dim" style="margin-top:6px">Token 只存本机 IndexedDB（AES-GCM 加密），不进 localStorage/日志/提示词。<br>' +
    'base_url：本机开发可填 http://localhost:3460/v1；手机/其它设备必须填它访问得到的 https Jev 地址（localhost 只指访问者自己）。<br>' +
    JEV_DISCLAIMER + '</div>';
}
