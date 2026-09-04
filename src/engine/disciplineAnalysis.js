// 交易纪律方向因子消融 · 共享分析纯函数核心
// 同时被 Node 分析器（scripts/analyze-discipline-factors.mjs）与前端融合页面板
// （src/tech2/fusionBacktest.js）导入，保证两侧数字同源一致。
// 纯函数：不做 DOM、不依赖浏览器/Node 特有 API（fetch 在外部完成）。

export const MIN_SAMPLE = 600;

// 因子清单（与测量脚本记录字段对齐）
export const FACTORS = [
  { key: 'regime', label: 'F5 市场状态(regime.type)' },
  { key: 'strategy', label: 'F5 策略切换(strategy)' },
  { key: 'verdict', label: 'F3 多周期一致(verdict)' },
  { key: 'leadScore', label: 'F1 领跑能量(分组)', bounds: [[0,30],[30,50],[50,70],[70,101]] },
  { key: 'leadIsClear', label: 'F1 领跑独一档(isClear)' },
  { key: 'cFresh', label: 'F2 确认新鲜度(分组)', bounds: [[0,4],[4,10],[10,101]] },
  { key: 'cIsHook', label: 'F2 确认是否钩(isHook)' },
  { key: 'cConfirmed', label: 'F2 已确认(confirmed)' },
  { key: 'atrPct', label: 'F4 波动率 ATR%(分组)', bounds: [[0,0.5],[0.5,1],[1,2],[2,101]] },
  { key: 'trendUp', label: 'F7 基准趋势方向(up)' },
  { key: 'trendFlat', label: 'F7 基准横盘(flat)' },
  { key: 'dirAligned', label: '方向 vs 基准趋势一致', derive: r => r.trendUp == null ? null : (r.dir === 'buy') === (r.trendUp === true) },
];

export const REGIMES = ['trend-up', 'pullback-up', 'range', 'pullback-down', 'trend-down'];
export const DIRS = ['buy', 'sell'];

// 解析 JSONL 文本 → 对象数组（逐行容错）
export function parseJsonl(text) {
  const out = [];
  for (const l of String(text).split('\n')) {
    const s = l.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* 跳过坏行 */ }
  }
  return out;
}

// 去重：同 (sym,ts) 只留最新一条
export function dedupeRows(rows) {
  const seen = new Map();
  for (const r of rows) seen.set(r.sym + '|' + r.ts, r);
  return [...seen.values()];
}

// 归一化每行为 { n, win, pnlSum }
function norm(r) {
  if (r.result != null) return { ...r, n: 1, win: r.result === 1 ? 1 : 0, pnlSum: r.pnlPct || 0 };
  return r; // decorr run 已有 n/win/pnlSum
}

// 按 (sym,direction) 连续同向 run 折叠，消除相邻触发自相关（独立交易视角）
export function decorrelate(rows) {
  const sorted = rows.slice().sort((a, b) =>
    a.sym < b.sym ? -1 : a.sym > b.sym ? 1 : (a.ts < b.ts ? -1 : 1));
  const collapsed = [];
  let prevKey = null;
  for (const r of sorted) {
    const key = r.sym + '|' + r.dir;
    if (key === prevKey && collapsed.length) {
      const last = collapsed[collapsed.length - 1];
      last.rawN++;
      if (r.result != null) { last.n++; if (r.result === 1) last.win++; last.pnlSum += r.pnlPct || 0; }
      continue;
    }
    prevKey = key;
    collapsed.push({ ...r, rawN: 1, n: r.result != null ? 1 : 0, win: r.result === 1 ? 1 : 0, pnlSum: r.pnlPct || 0 });
  }
  return collapsed.filter(r => r.result != null);
}

function bucketVal(r, f) {
  if (f.derive) return f.derive(r);
  const v = r[f.key];
  if (f.bounds && typeof v === 'number') {
    for (const [lo, hi] of f.bounds) if (v >= lo && v < hi) return `${lo}-${hi === 101 ? '+' : hi}`;
    return 'other';
  }
  if (v == null) return null;
  return v;
}

// 覆盖矩阵: (regime,dir) → 已决样本数（扁平数组，便于前端/分析器查询）
export function coverageMatrix(rows) {
  const cov = {};
  for (const r of rows) {
    const n = r.n || 1;
    const k = `${r.regime}|${r.dir}`;
    cov[k] = (cov[k] || 0) + n;
  }
  const out = [];
  for (const rg of REGIMES) for (const d of DIRS) out.push({ regime: rg, dir: d, n: cov[rg + '|' + d] || 0 });
  return out;
}

// 逐因子消融：每个因子取值 → { n, win, winRate, avgPnl, sizable }
export function buildAblation(rows, { decorr, minGroupN = 5 } = {}) {
  const base = decorr ? decorrelate(rows) : rows;
  const nr = base.map(norm);
  const seen = new Map(); // 去重（decorr 后 key 已不同，但也兜底）
  const uniq = [];
  for (const r of nr) { const k = r.sym + '|' + r.ts + '|' + r.dir + '|' + (r.rawN||0); if (!seen.has(k)) { seen.set(k, 1); uniq.push(r); } }

  const factors = [];
  for (const f of FACTORS) {
    const groups = {};
    for (const r of uniq) {
      const b = bucketVal(r, f);
      if (b == null) continue;
      if (!groups[b]) groups[b] = { n: 0, win: 0, pnlSum: 0 };
      const g = groups[b];
      g.n += r.n || 1;
      g.win += r.win || 0;
      g.pnlSum += r.pnlSum || 0;
    }
    const entries = Object.keys(groups)
      .filter(k => groups[k].n >= minGroupN)
      .sort()
      .map(k => {
        const g = groups[k];
        return {
          label: k, n: g.n, win: g.win,
          winRate: g.n ? g.win / g.n : null,
          avgPnl: g.n ? g.pnlSum / g.n : null,
          sizable: g.n >= MIN_SAMPLE,
        };
      });
    factors.push({ label: f.label, key: f.key, entries });
  }

  // 方向总览
  const dir = { buy: { n: 0, win: 0 }, sell: { n: 0, win: 0 } };
  for (const r of uniq) { if (dir[r.dir]) { dir[r.dir].n += r.n || 1; dir[r.dir].win += r.win || 0; } }

  return {
    rows: uniq.length,
    factors,
    dir,
    coverage: coverageMatrix(uniq),
  };
}

// ============================================================================
// TSEV 线性加权投票（方向精度提升核心）
// ----------------------------------------------------------------------------
// 思路：把「方向信号」从一堆写死的 if/else 阈值，换成「数据门控的线性加权投票」。
//   每个方向因子态 (name|cond|side) 的权重 = logit(该态在未来 N 周期方向命中率)，
//   仅当样本数 ≥ MIN_SAMPLE 且 |z| ≥ Z_THRESH 才入票（否则权重 0 = 诚实退出）。
//   净票数 net = Σ wᵢ·sideᵢ；net > +M → 看多，net < −M → 看空，否则 观察。
//   置信 = sigmoid(net)，如实反映「微弱边缘」而非伪造高置信。
// 该核心被 kchart.js（实时分析）与 scripts/rehearse-tsev.mjs（推演验证）共用。
// ============================================================================

export const TSEV_CFG = {
  MIN_SAMPLE: 400,   // 训练：单因子态最低样本数（低于则不入票）
  Z_THRESH: 1.5,     // 训练：|z| 阈值（< 则视为噪声，权重归 0）
  M: 0.5,            // 投票：净票数绝对值 > M 才发方向，否则 观察
  CONF_HIGH: 0.60,
  CONF_MID: 0.55,
  LOCAL_MIN_SAMPLE: 400, // 本机优先：本机样本数 ≥ 此值才用本机权重，否则回落全局/经典
};

// TSEV 权重合并（本机优先）：给定全局权重与本机权重，按「本机优先」返回最终权重与来源。
// 返回 { weights, source:'local'|'global'|'classic', n }。
export function combineWeights(globalW, localW, opts = {}) {
  const localMin = opts.localMin != null ? opts.localMin : TSEV_CFG.LOCAL_MIN_SAMPLE;
  const localN = opts.localN || 0;
  const globalN = opts.globalN || 0;
  if (localW && Object.keys(localW).length && localN >= localMin)
    return { weights: localW, source: 'local', n: localN };
  if (globalW && Object.keys(globalW).length)
    return { weights: globalW, source: 'global', n: globalN };
  return { weights: {}, source: 'classic', n: 0 };
}

// 从 analyzeTradeDiscipline 的中间产物抽取方向因子态。
// 入参对象需含：ov(速览) 不必；trend(horizonTrend) / mt(macroTrend) / confirm /
// leading(leader) / reversalAdd / zones / verdict / periodKAdd / gapAdd / mainTFUse
// 每个因子返回 {name, cond, side}，side: +1=支持看多, −1=支持看空, 0=无方向。
export function extractDisciplineFactors({ trend, mt, confirm, leading, reversalAdd, zones, verdict, periodKAdd, gapAdd }) {
  const F = [];
  // F_pullback：主周期超买/超卖回调（顺势低吸/高抛）
  const zr = zones && zones.main;
  if (zr === 'overbought') F.push({ name: 'pullback', cond: 'up_os', side: +1 });
  else if (zr === 'oversold') F.push({ name: 'pullback', cond: 'down_ob', side: -1 });
  // F_hook：金钩/死钩（仅近场确认的钩才算方向证据）
  if (confirm && confirm.isHook) F.push({ name: 'hook', cond: confirm.dir === 'buy' ? 'gold' : 'death', side: confirm.dir === 'buy' ? +1 : -1 });
  else F.push({ name: 'hook', cond: 'none', side: 0 });
  // F_reversal：K/D 反转（非钩）
  if (reversalAdd) F.push({ name: 'reversal', cond: 'reversal', side: reversalAdd > 0 ? +1 : -1 });
  // F_periodK：全周期 K>D / K<D
  if (periodKAdd) F.push({ name: 'periodK', cond: periodKAdd > 0 ? 'kGtD' : 'kLtD', side: periodKAdd > 0 ? +1 : -1 });
  // F_gap：K-D 间距放大/缩小（动能加速/减弱）
  if (gapAdd) F.push({ name: 'gap', cond: gapAdd > 0 ? 'wide' : 'narrow', side: gapAdd > 0 ? +1 : -1 });
  // F_consensus：多周期一致
  if (verdict === '一致偏多') F.push({ name: 'consensus', cond: 'bull', side: +1 });
  else if (verdict === '一致偏空') F.push({ name: 'consensus', cond: 'bear', side: -1 });
  // F_leader：能量领跑方向
  if (leading) F.push({ name: 'leader', cond: leading.dir === 'buy' ? 'up' : 'down', side: leading.dir === 'buy' ? +1 : -1 });
  // F_daily：日线极端（超买→勿追多偏空谨慎；超卖→勿追空偏多谨慎）
  const dz = zones && zones.daily;
  if (dz === 'overbought') F.push({ name: 'daily', cond: 'ob', side: -1 });
  else if (dz === 'oversold') F.push({ name: 'daily', cond: 'os', side: +1 });
  // F_macro：宏观(7d/30d)与基准趋势反向
  if (mt && mt.up != null && trend && trend.up != null && mt.up !== trend.up)
    F.push({ name: 'macro', cond: 'reverse', side: mt.up === true ? +1 : -1 });
  return F;
}

// 由纪律因子 jsonl 训练 TSEV 权重。
// rows: 每行 { factors:[{name,cond,side}], fut:{h4,d1,d3} }，fut 为未来方向 +1/-1/0。
// 返回 weights: { 'name|cond|side': logitWeight }。
export function trainTsevWeights(rows, opts = {}) {
  const MIN_SAMPLE = opts.MIN_SAMPLE ?? TSEV_CFG.MIN_SAMPLE;
  const Z_THRESH = opts.Z_THRESH ?? TSEV_CFG.Z_THRESH;
  const horizon = opts.horizon || 'h4';
  const acc = {};
  for (const r of rows) {
    const fut = r.fut && r.fut[horizon];
    if (!fut) continue;
    const fs = r.factors || [];
    for (const f of fs) {
      if (!f || f.side === 0) continue;
      const key = f.name + '|' + f.cond + '|' + f.side;
      const a = acc[key] || (acc[key] = { n: 0, h: 0 });
      a.n++;
      a.h += (fut === f.side) ? 1 : 0;
    }
  }
  const W = {};
  for (const k in acc) {
    const a = acc[k];
    if (a.n < MIN_SAMPLE) continue;
    const p = a.h / a.n;
    const se = 0.5 / Math.sqrt(a.n);
    const z = (p - 0.5) / se;
    if (Math.abs(z) < Z_THRESH) continue;
    if (p <= 0 || p >= 1) continue;
    W[k] = Math.log(p / (1 - p));
  }
  return W;
}

// TSEV 投票：因子态 × 权重 → 方向。
// 返回 { dir:+1/-1/0, dirText:'看多'/'看空'/'观察', net, conf, confLabel, parts }。
export function voteTsev(factors, weights, opts = {}) {
  const M = opts.M ?? TSEV_CFG.M;
  let net = 0;
  const parts = [];
  const W = weights || {};
  for (const f of factors || []) {
    const w = W[f.name + '|' + f.cond + '|' + f.side];
    if (!w) continue;
    net += w * f.side;
    parts.push(f.name + (w > 0 ? '+' : '') + w.toFixed(2));
  }
  const dir = net > M ? +1 : net < -M ? -1 : 0;
  const conf = 1 / (1 + Math.exp(-net));
  const confLabel = conf >= TSEV_CFG.CONF_HIGH ? '高' : conf >= TSEV_CFG.CONF_MID ? '中' : '低';
  const dirText = dir > 0 ? '看多' : dir < 0 ? '看空' : '观察';
  return { dir, dirText, net, conf, confLabel, parts };
}
