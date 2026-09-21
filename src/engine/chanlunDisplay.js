// 缠论（Chanlun）显示层纯函数 —— 只读 chanlun.js 的输出，构造「主图绘制项」与「解读面板模型」。
//
// 设计原则（与 maRelation.js / maRelGauge.js 一致）：
//   * 纯函数、零 DOM / 零网络 / 不读 window；渲染与 UI 由调用方负责。
//   * 只消费 buildChanlun() 的返回值，不写任何引擎/实盘状态（默认 on:false 时调用方不调用本模块）。
//   * 所有数值用 Number.isFinite 防护，非法输入不得抛异常。
//
// ⚠️ 诚实声明（与 chanlun.js 模块头一致，必须随面板一起展示）：
//   仅结构描述 · 无统计优势（实时口径 6.7 年回测为负）。
//   上层（线段/中枢/背驰/买卖点）在原著中留有多处未定义的选择点，不同实现结果不同 —— 多解层；
//   只有底层（包含处理/分型/笔）在给定规则下是确定性的 —— 确定层。
//
// 关于「延迟」：缠论信号不是「假的」，是「迟的」。
//   历史标注口径（用信号自身所在 bar 下单）含未来函数：实测 100% 的信号在标注当天尚不可见，
//   中位提前 ~15 根 K 线；实时口径 6.7 年回测为负。面板必须如实展示每个信号的可见时刻。

export const CHAN_DISCLAIMER = '仅结构描述 · 无统计优势（实时口径 6.7 年回测为负）';
export const CHAN_MULTI_NOTE = '多解层：线段(1+1简化)/中枢/背驰/买卖点判据原著未唯一，不同实现结果不同；仅「笔」是确定性层';

// 显示层开关的元数据（供主图工具栏与面板渲染按钮，避免文案漂移）
export const CHAN_LAYERS = [
  { key: 'showBi', label: '笔', title: '笔（确定性层）：给定分型与最小距离规则后唯一；端点会被后续更极端分型替换 → 末笔永远「待定稿」' },
  { key: 'showSeg', label: '线段', title: '线段（多解层）：本实现为「1+1 终结」简化版，与原著特征序列口径不完全等价' },
  { key: 'showZs', label: '中枢', title: '中枢（多解层）：区间口径可选 前三段(first3)/全部重叠(all)；延伸判定依赖「下一段是否重叠」' },
  { key: 'showDiv', label: '背驰', title: '背驰（多解层）：度量可选 MACD 柱面积(第24课口径) 或 幅度/时间斜率；相邻同向笔创新极值但力度更小才成立' },
  { key: 'showBsp', label: '买卖点', title: '三类买卖点（多解层·依赖上层）：简化判据，完整判据需多级别走势类型递归（未实现）；信号「迟」而非「假」' },
  { key: 'showTrend', label: '走势', title: '走势类型（多解层·继承中枢口径）：1 个中枢=盘整；≥2 个同向不重叠中枢=上涨/下跌' },
];

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const arr = (v) => (Array.isArray(v) ? v : []);

function fmtPrice(v) {
  if (!num(v)) return '--';
  const a = Math.abs(v);
  if (a >= 10000) return v.toFixed(0);
  if (a >= 100) return v.toFixed(2);
  if (a >= 1) return v.toFixed(3);
  return v.toFixed(5);
}
function fmtPct(v) { return num(v) ? (v >= 0 ? '+' : '') + v.toFixed(2) + '%' : '--'; }
function fmtNum(v) {
  if (!num(v)) return '--';
  const a = Math.abs(v);
  return a >= 100 ? v.toFixed(1) : a >= 1 ? v.toFixed(2) : v.toFixed(4);
}

// 买卖点元数据（名称/图标/方向）
const BSP_META = {
  '1b': { name: '一买', icon: '①', side: 'long' },
  '2b': { name: '二买', icon: '②', side: 'long' },
  '3b': { name: '三买', icon: '③', side: 'long' },
  '1s': { name: '一卖', icon: '①', side: 'short' },
  '2s': { name: '二卖', icon: '②', side: 'short' },
  '3s': { name: '三卖', icon: '③', side: 'short' },
};
export function chanBspMeta(kind) {
  return BSP_META[kind] || { name: kind ? String(kind) : '?', icon: '◇', side: 'long' };
}

// 单笔的起止价（makeBi 只存 high/low + dir，这里还原 y0→y1 方向）
function biPrices(bi) {
  const up = bi && bi.dir === 'up';
  return { y0: up ? bi.low : bi.high, y1: up ? bi.high : bi.low };
}
function segPrices(sg) {
  const up = sg && sg.dir === 'up';
  return { y0: up ? sg.low : sg.high, y1: up ? sg.high : sg.low };
}

// ---------------------------------------------------------------------------
// 1. 主图绘制项（只保留与可视窗口 [start, end) 相交的对象；带数量上限防窗口过大）
// ---------------------------------------------------------------------------
export function chanlunWindowItems(chan, opts = {}) {
  const o = {
    start: 0, end: Infinity,
    showBi: true, showSeg: true, showZs: true, showDiv: true, showBsp: true,
    maxBis: 240, maxSegs: 80, maxCenters: 60, maxDivs: 80, maxBsps: 80,
    ...opts,
  };
  const out = { bis: [], segs: [], centers: [], divs: [], bsps: [] };
  if (!chan || !chan.ok) return out;
  const start = num(o.start) ? o.start : 0;
  const end = num(o.end) ? o.end : Infinity;
  const hit = (i0, i1) => num(i0) && num(i1) && i1 >= start && i0 < end;
  const at = (i) => num(i) && i >= start && i < end;

  if (o.showBi) {
    for (const bi of arr(chan.bis)) {
      if (!hit(bi.startIdx, bi.endIdx)) continue;
      const p = biPrices(bi);
      out.bis.push({
        i0: bi.startIdx, i1: bi.endIdx, y0: p.y0, y1: p.y1,
        dir: bi.dir, final: !!bi.final,
      });
    }
    if (out.bis.length > o.maxBis) out.bis = out.bis.slice(-o.maxBis);
  }
  if (o.showSeg) {
    for (const sg of arr(chan.segs)) {
      if (!hit(sg.startIdx, sg.endIdx)) continue;
      const p = segPrices(sg);
      out.segs.push({
        i0: sg.startIdx, i1: sg.endIdx, y0: p.y0, y1: p.y1,
        dir: sg.dir, nBis: sg.nBis, final: !!sg.final,
      });
    }
    if (out.segs.length > o.maxSegs) out.segs = out.segs.slice(-o.maxSegs);
  }
  if (o.showZs) {
    for (const z of arr(chan.centers)) {
      if (!hit(z.startIdx, z.endIdx)) continue;
      out.centers.push({
        i0: z.startIdx, i1: z.endIdx,
        zg: z.zg, zd: z.zd, gg: z.gg, dd: z.dd,
        nMoves: z.nMoves, final: !!z.final,
      });
    }
    if (out.centers.length > o.maxCenters) out.centers = out.centers.slice(-o.maxCenters);
  }
  if (o.showDiv) {
    for (const d of arr(chan.divergences)) {
      if (!at(d.idx)) continue;
      out.divs.push({
        idx: d.idx, kind: d.kind, dir: d.dir, price: d.price,
        power: d.power, prevPower: d.prevPower, ratio: d.ratio,
        measure: d.measure, final: !!d.final,
      });
    }
    if (out.divs.length > o.maxDivs) out.divs = out.divs.slice(-o.maxDivs);
  }
  if (o.showBsp) {
    for (const s of arr(chan.signals)) {
      if (!at(s.idx)) continue;
      const m = chanBspMeta(s.kind);
      out.bsps.push({
        idx: s.idx, kind: s.kind, name: m.name, icon: m.icon, side: s.side,
        price: s.price, final: !!s.final,
        naiveAt: s.naiveAt, detectAt: s.detectAt, finalAt: s.finalAt,
        lagDetect: (num(s.finalAt) && num(s.detectAt)) ? s.finalAt - s.detectAt : null,
      });
    }
    if (out.bsps.length > o.maxBsps) out.bsps = out.bsps.slice(-o.maxBsps);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. 解读面板模型
//    用户要求（详细版）：当前笔向 / 线段 / 中枢区间 / 是否背驰 / 最近买卖点
//      + 延迟状态（信号已可见/待定稿、当前笔已持续多少根、距中枢上/下沿 %）+ 一行结论。
// ---------------------------------------------------------------------------
export function chanlunReadout(chan, opts = {}) {
  const o = {
    showBi: true, showSeg: true, showZs: true, showDiv: true, showBsp: true, showTrend: true,
    livePrice: null,
    ...opts,
  };
  const base = {
    ok: false, tone: 'none', verdict: '数据不足（需要更多 K 线）',
    rows: [], disclaimer: CHAN_DISCLAIMER, multiNote: CHAN_MULTI_NOTE,
    delay: null, stats: null, price: null,
  };
  if (!chan || !chan.ok) return base;
  const bars = chan.bars || {};
  const n = num(bars.n) ? bars.n : 0;
  if (n < 10) return base;
  const last = n - 1;
  const px = num(o.livePrice) ? o.livePrice : (num(bars.c[last]) ? bars.c[last] : null);
  const cfg = chan.cfg || {};

  const bis = arr(chan.bis), segs = arr(chan.segs), zs = arr(chan.centers);
  const tr = chan.trend || { type: 'range', dir: 0, nCenters: zs.length, label: '无中枢' };
  const rows = [];

  // —— 当前笔 ——
  let curBi = null;
  if (o.showBi) {
    const bi = bis.length ? bis[bis.length - 1] : null;
    curBi = bi;
    if (!bi) {
      const minD = cfg.biMode === 'old' ? 5 : 4;
      rows.push({ icon: '—', color: '#8b95a5', label: '当前笔 · 无（K 线不足以成笔）', detail: '笔需要端点合并K线距离 ≥ ' + minD + '（' + (cfg.biMode === 'old' ? '老笔' : '新笔') + '）' });
    } else {
      const up = bi.dir === 'up';
      const p = biPrices(bi);
      const held = num(bi.startIdx) ? Math.max(0, last - bi.startIdx) : null;
      const sinceEnd = num(bi.endIdx) ? Math.max(0, last - bi.endIdx) : null;
      rows.push({
        icon: up ? '↗' : '↘', color: up ? '#2ecc71' : '#ff6b6b',
        label: '当前笔 · ' + (up ? '向上' : '向下') + '（' + (bi.final ? '已定稿' : '待定稿') + '）',
        detail: fmtPrice(p.y0) + ' → ' + fmtPrice(p.y1) + ' · 已持续 ' + (held == null ? '--' : held) + ' 根' +
          (sinceEnd != null ? ' · 终点后已走 ' + sinceEnd + ' 根（待成新笔）' : ''),
      });
    }
  }

  // —— 线段 ——
  let curSeg = null;
  if (o.showSeg) {
    const sg = segs.length ? segs[segs.length - 1] : null;
    curSeg = sg;
    if (!sg) {
      rows.push({ icon: '╱', color: '#8b95a5', label: '线段 · 无', detail: '线段需至少 ' + (cfg.segMinBis || 3) + ' 笔（本实现为 1+1 简化版 · 多解层）' });
    } else {
      const up = sg.dir === 'up';
      const held = num(sg.startIdx) ? Math.max(0, last - sg.startIdx) : null;
      rows.push({
        icon: up ? '↗' : '↘', color: up ? '#2ecc71' : '#ff6b6b',
        label: '线段 · ' + (up ? '向上' : '向下') + '（' + (sg.final ? '已定稿' : '待定稿') + '）',
        detail: '含 ' + sg.nBis + ' 笔 · 已持续 ' + (held == null ? '--' : held) + ' 根 · 1+1 简化版（多解层）',
      });
    }
  }

  // —— 中枢 ——
  let curZs = null, zsPos = null, distUp = null, distDown = null;
  if (o.showZs) {
    const z = zs.length ? zs[zs.length - 1] : null;
    curZs = z;
    if (!z) {
      rows.push({ icon: '▭', color: '#8b95a5', label: '中枢 · 无', detail: '需至少 ' + (cfg.zsMinBis || 3) + ' 段重叠（口径 ' + (cfg.zsGate === 'all' ? '全部重叠' : '前三段') + '）' });
    } else {
      const zg = z.zg, zd = z.zd;
      zsPos = '中枢内';
      let col = '#f59e0b';
      if (num(px) && px > zg) { zsPos = '中枢上方'; col = '#2ecc71'; }
      else if (num(px) && px < zd) { zsPos = '中枢下方'; col = '#ff6b6b'; }
      distUp = (num(px) && px > 0) ? (zg - px) / px * 100 : null;
      distDown = (num(px) && px > 0) ? (px - zd) / px * 100 : null;
      rows.push({
        icon: '▭', color: col,
        label: '最近中枢 · ' + zsPos + '（' + (z.final ? '已定稿' : '待定稿') + '）',
        detail: '区间 ' + fmtPrice(zd) + '–' + fmtPrice(zg) + ' · 距上沿 ' + fmtPct(distUp) + ' · 距下沿 ' + fmtPct(distDown) +
          ' · 含 ' + z.nMoves + ' 段 · 口径 ' + (z.gate === 'all' ? '全部重叠' : '前三段'),
      });
    }
  }

  // —— 背驰 ——
  let curDiv = null;
  if (o.showDiv) {
    const d = arr(chan.divergences).length ? chan.divergences[chan.divergences.length - 1] : null;
    curDiv = d;
    if (!d) {
      rows.push({ icon: '∅', color: '#8b95a5', label: '背驰 · 未检出', detail: '相邻同向笔创新极值但力度更小才成立（度量 ' + (cfg.divMeasure === 'slope' ? '斜率' : 'MACD面积') + ' · 多解层）' });
    } else {
      const top = d.kind === 'top';
      rows.push({
        icon: top ? '⤓' : '⤒', color: top ? '#ff6b6b' : '#2ecc71',
        label: (top ? '顶背驰' : '底背驰') + ' · 力度比 ' + (num(d.ratio) ? d.ratio.toFixed(2) : '--') + '（' + (d.final ? '已定稿' : '待定稿') + '）',
        detail: '第 ' + d.idx + ' 根 · 前段 ' + fmtNum(d.prevPower) + ' → 本段 ' + fmtNum(d.power) + ' · 度量 ' + (d.measure === 'slope' ? '斜率' : 'MACD面积'),
      });
    }
  }

  // —— 最近买卖点 ——
  let lastSig = null;
  if (o.showBsp) {
    const s = arr(chan.signals).length ? chan.signals[chan.signals.length - 1] : null;
    lastSig = s;
    if (!s) {
      rows.push({ icon: '◇', color: '#8b95a5', label: '买卖点 · 无', detail: '三类买卖点为简化判据（多解层），可能漏检；完整判据需多级别递归（未实现）' });
    } else {
      const m = chanBspMeta(s.kind);
      const long = s.side === 'long';
      rows.push({
        icon: m.icon, color: long ? '#2ecc71' : '#ff6b6b',
        label: m.name + ' · ' + (long ? '看多' : '看空') + ' · ' + (s.final ? '已定稿' : '待定稿'),
        detail: '第 ' + s.idx + ' 根 @ ' + fmtPrice(s.price) + ' · ' + chanSignalDelayText(s),
      });
    }
  }

  // —— 走势类型 ——
  if (o.showTrend) {
    const up = tr.dir > 0, down = tr.dir < 0;
    rows.push({
      icon: up ? '▲' : down ? '▼' : '◆', color: up ? '#2ecc71' : down ? '#ff6b6b' : '#f59e0b',
      label: '走势类型 · ' + (tr.label || '—'),
      detail: tr.nCenters ? ('共 ' + tr.nCenters + ' 个中枢 · ' + (up ? '上涨' : down ? '下跌' : '盘整')) : '暂无中枢',
    });
  }

  // —— 延迟状态（本模块的核心诚实项）——
  const delay = chanDelayInfo(chan);
  rows.push({
    icon: '⏳', color: '#58a6ff',
    label: '延迟状态 · 信号已可见 ' + delay.visible + ' · 待定稿 ' + delay.pending,
    detail: (delay.medianLag != null ? ('本图信号中位延迟 ' + delay.medianLag + ' 根（实时可检测 → 定稿）') : '延迟样本不足') +
      ' · 缠论信号不是「假的」，是「迟的」',
  });

  // —— 结论 ——
  const parts = [];
  parts.push(tr.dir > 0 ? '结构偏多' : tr.dir < 0 ? '结构偏空' : '结构盘整');
  if (curBi) parts.push('当前' + (curBi.dir === 'up' ? '向上' : '向下') + '笔');
  if (curZs && zsPos) parts.push('价在' + zsPos);
  if (lastSig) { const m = chanBspMeta(lastSig.kind); parts.push('最近' + m.name + '（' + (lastSig.final ? '已定稿' : '待定稿') + '）'); }
  const verdict = '结构：' + parts.join(' · ') + '（仅结构描述，非交易信号）';

  const tone = tr.dir > 0 ? 'bull' : tr.dir < 0 ? 'bear' : 'range';
  return {
    ok: true, tone, verdict, rows,
    disclaimer: CHAN_DISCLAIMER, multiNote: CHAN_MULTI_NOTE,
    delay,
    price: px,
    stats: {
      nBars: n,
      nBis: bis.length, nSegs: segs.length, nCenters: zs.length,
      nSignals: arr(chan.signals).length, nSignalsCausal: arr(chan.signalsCausal).length,
      visible: delay.visible, pending: delay.pending, medianLag: delay.medianLag,
    },
  };
}

// 单个信号的延迟文案：明确「标注点 → 实时可检测 → 定稿」三段
export function chanSignalDelayText(s) {
  if (!s) return '';
  if (!num(s.finalAt)) return '延迟：待定稿（结构尚未锁定，可能被后续走势改写）';
  const labelLag = num(s.naiveAt) ? (s.finalAt - s.naiveAt) : null;
  if (num(s.detectAt)) {
    const det = s.finalAt - s.detectAt;
    return '延迟：实时可检测后 ' + det + ' 根才定稿' + (labelLag != null ? '（标注点后 ' + labelLag + ' 根）' : '');
  }
  return '延迟：' + (labelLag != null ? labelLag + ' 根后定稿' : '已定稿');
}

// 全序列延迟统计（可见/待定稿/中位延迟）
export function chanDelayInfo(chan) {
  const out = { total: 0, visible: 0, pending: 0, medianLag: null, lags: [] };
  if (!chan || !chan.ok) return out;
  const sigs = arr(chan.signals);
  out.total = sigs.length;
  const lags = [];
  for (const s of sigs) {
    if (num(s.finalAt)) {
      out.visible++;
      if (num(s.detectAt)) lags.push(s.finalAt - s.detectAt);
    } else out.pending++;
  }
  lags.sort((a, b) => a - b);
  out.lags = lags;
  out.medianLag = lags.length ? lags[Math.floor(lags.length / 2)] : null;
  return out;
}
