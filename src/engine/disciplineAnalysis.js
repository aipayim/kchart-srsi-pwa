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
  MIN_SAMPLE: 400,   // 官方训练：单因子态最低样本数（低于则不入票）
  Z_THRESH: 1.5,     // 训练：|z| 阈值（< 则视为噪声，权重归 0）
  M: 0.5,            // 投票：净票数绝对值 > M 才发方向，否则 观察
  GATE: 0.60,        // 可交易门控：TSEV 置信 ≥ 此值 且 |net|≥M 才给 ✅ 可做多/空，否则判观望（宁缺毋滥）
  CONF_HIGH: 0.60,
  CONF_MID: 0.55,
  LOCAL_MIN_SAMPLE: 50,  // 本机优先：本机样本数 ≥ 此值才用本机权重（远低于官方，使少量本机样本即可启用）
  LOCAL_FACTOR_MIN: 50, // 本机训练：单因子态最低样本数（低于则不入票；远低于官方 400 以便首开回补即出权重）
  LOCAL_RECENCY_HALFLIFE_DAYS: 60, // 本机训练近期加权半衰期(天)：远低于官方 365，使 TSEV 跟随当前 regime（如近期多头行情）翻转，而非被 4 年历史稀释
  IMBALANCE_RATIO: 3,   // 行情中立护栏：单边权重总量/反向权重总量 > 此值(或任一边为 0) → 判定样本偏单方向，TSEV 不可信、回退经典逻辑
  SHRINK: true,         // 小样本 Wilson 收缩：把 wr 拉向 0.5，抑制伪显著（确定性、非自适应、不引入不确定性）
  RECENCY_HALFLIFE_DAYS: 365, // 本机训练近期加权半衰期(天)：按样本真实时间分桶，训练期对每桶乘 exp(-桶龄/半衰期)。旧行情(如多年前的 bull/bear 周期)自动淡出、近期 regime 主导，使 TSEV 跟随当前涨跌翻转、对称多空。仅作用于本机 loop(localLoop) 的 buckets 结构，不影响离线快照
};

// 训练期近期加权：把按周分桶的统计聚合成有效 n/h。
// a.buckets: { [周索引]: { n, h } }，周索引 = floor(ts / (7天ms))。旧桶权重随桶龄按半衰期指数衰减。
function aggregateBuckets(a, now, halfLifeDays) {
  let n = 0, h = 0;
  const WEEK_MS = 7 * 86400000;
  for (const wk in a.buckets) {
    const bucketTs = Number(wk) * WEEK_MS;
    const ageDays = (now - bucketTs) / 86400000;
    const w = Math.exp(-ageDays / halfLifeDays);
    n += w * (a.buckets[wk].n || 0);
    h += w * (a.buckets[wk].h || 0);
  }
  return { n, h };
}

// TSEV 权重合并（本机优先）：给定全局权重与本机权重，按「本机优先」返回最终权重与来源。
// 返回 { weights, source:'local'|'global'|'classic', n }。
export function combineWeights(globalW, localW, opts = {}) {
  const localMin = opts.localMin != null ? opts.localMin : TSEV_CFG.LOCAL_MIN_SAMPLE;
  const localN = opts.localN || 0;
  const globalN = opts.globalN || 0;
  const _count = (o) => o ? Object.keys(o).filter(k => !k.startsWith('__')).length : 0;
  if (localW && _count(localW) && localN >= localMin)
    return { weights: localW, source: 'local', n: localN };
  if (globalW && _count(globalW))
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
      const a = acc[key] || (acc[key] = { n: 0, h: 0, side: f.side });
      a.n++;
      a.h += (fut === f.side) ? 1 : 0;
    }
  }
  const W = {};
  let posW = 0, negW = 0;
  for (const k in acc) {
    const a = acc[k];
    if (a.n < MIN_SAMPLE) continue;
    const p = a.h / a.n;
    const se = 0.5 / Math.sqrt(a.n);
    const z = (p - 0.5) / se;
    if (Math.abs(z) < Z_THRESH) continue;
    if (p <= 0 || p >= 1) continue;
    const w = Math.log(p / (1 - p));
    W[k] = w;
    if (a.side > 0) posW += w; else if (a.side < 0) negW += w;
  }
  // 行情中立护栏：若训练样本只覆盖单一方向(如仅上涨行情)，则只有同向因子达到样本阈值，
  // 权重表会天然偏向该方向、永远无法表达反向。此时 TSEV 不可信，应回退经典逻辑。
  const IMBALANCE_RATIO = TSEV_CFG.IMBALANCE_RATIO ?? 3;
  const eps = 1e-9;
  if (posW < eps || negW < eps || Math.max(posW, negW) / (Math.min(posW, negW) + eps) > IMBALANCE_RATIO) {
    W.__unbalanced = true;
    W.__pos = +posW.toFixed(3);
    W.__neg = +negW.toFixed(3);
  }
  return W;
}

// 小样本 Wilson 收缩：把命中率 p 拉向 0.5，抑制伪显著（确定性、非自适应）。
// 返回收缩后的 p（center）。z=1.96 对应 95% 置信。
export function wilsonShrink(p, n, z = 1.96) {
  if (n <= 0) return 0.5;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  return center;
}

// 由「已聚合的每因子统计」训练 TSEV 权重（本机 loop 用，避免存原始样本、节省移动端空间）。
// stats: { 'name|cond|side': { n, h } }，h = 与 side 同向的未来样本数。返回同 trainTsevWeights 的权重表。
// opts.shrink: 是否对 p 做 Wilson 收缩（默认按 TSEV_CFG.SHRINK）。收缩只减小幅度、不改方向符号。
export function trainTsevWeightsStats(stats, opts = {}) {
  const MIN_SAMPLE = opts.MIN_SAMPLE ?? TSEV_CFG.LOCAL_FACTOR_MIN;
  const Z_THRESH = opts.Z_THRESH ?? TSEV_CFG.Z_THRESH;
  const shrink = opts.shrink != null ? opts.shrink : TSEV_CFG.SHRINK;
  const halfLife = opts.recencyHalfLifeDays ?? TSEV_CFG.RECENCY_HALFLIFE_DAYS;
  const now = opts.now != null ? opts.now : Date.now();
  const W = {};
  let posW = 0, negW = 0;
  for (const k in stats) {
    const a = stats[k];
    if (!a) continue;
    // 本机 loop 走时间分桶(近期加权)；全局/JSON 快照走 {n,h} 直接聚合（兼容旧结构）
    let n = 0, h = 0;
    if (a.buckets) {
      const agg = aggregateBuckets(a, now, halfLife);
      n = agg.n; h = agg.h;
    } else {
      n = a.n || 0; h = a.h || 0;
    }
    if (n < MIN_SAMPLE) continue;
    const p = h / n;
    const se = 0.5 / Math.sqrt(n);
    const z = (p - 0.5) / se;
    if (Math.abs(z) < Z_THRESH) continue;
    if (p <= 0 || p >= 1) continue;
    const pAdj = shrink ? wilsonShrink(p, n) : p;
    const w = Math.log(pAdj / (1 - pAdj));
    W[k] = w;
    const side = Number(k.split('|')[2]);
    if (side > 0) posW += w; else if (side < 0) negW += w;
  }
  // 行情中立护栏：权重只覆盖单一方向(如仅上涨行情学到的因子) → 无法表达反向，标记不可信。
  const IMBALANCE_RATIO = TSEV_CFG.IMBALANCE_RATIO ?? 3;
  const eps = 1e-9;
  if (posW < eps || negW < eps || Math.max(posW, negW) / (Math.min(posW, negW) + eps) > IMBALANCE_RATIO) {
    W.__unbalanced = true;
    W.__pos = +posW.toFixed(3);
    W.__neg = +negW.toFixed(3);
  }
  return W;
}

// TSEV 投票：因子态 × 权重 → 方向。
// 返回 { dir:+1/-1/0, dirText:'看多'/'看空'/'观察', net, conf, confLabel, parts }。
export function voteTsev(factors, weights, opts = {}) {
  // 行情中立护栏（部分投票）：若权重只学到单一方向(如仅上涨行情样本)，不整体禁用，
  // 而是仅允许投出「已学到权重的那一侧」（如仅跌行情 → 可给看空，但不给看多），
  // 避免把唯一有用的方向也丢掉。仅当两侧都无任何有效权重(__pos、__neg 均≈0)才彻底不投票(回退经典)。
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
  let dir = net > M ? +1 : net < -M ? -1 : 0;
  let unbalanced = false, partial = false;
  if (W.__unbalanced) {
    const posW = W.__pos || 0, negW = W.__neg || 0;
    if (posW < 1e-9 && negW < 1e-9) {
      return { dir: 0, dirText: '观察', net: 0, conf: 0.5, confLabel: '低', parts: [], unbalanced: true, partial: false };
    }
    // 部分投票：不确认「未学到」的一侧（避免单边样本伪造反向判决）
    if (posW < 1e-9 && dir > 0) dir = 0;
    if (negW < 1e-9 && dir < 0) dir = 0;
    unbalanced = true; partial = true;
  }
  const conf = 1 / (1 + Math.exp(-net));
  const confLabel = conf >= TSEV_CFG.CONF_HIGH ? '高' : conf >= TSEV_CFG.CONF_MID ? '中' : '低';
  const dirText = dir > 0 ? '看多' : dir < 0 ? '看空' : '观察';
  return { dir, dirText, net, conf, confLabel, parts, unbalanced, partial };
}

// 前向准确度回测（供面板信任看板）：把带标签样本按时间切 train/test，用 train 训练权重，
// 在 test 上重放 TSEV 投票，统计「TSEV 方向 = 实际方向(raw)」的命中率。
// rows: [{ factors:[{name,cond,side}], raw:+1/-1/0 }]（raw = 未来真实方向标签，0=无标签跳过）。
// 返回 { acc, n(判决笔数), coverage(test中有标签占比) } 或 null（样本不足）。
// 由已训练/已聚合统计生成可读因子表（诊断用）：列出每个因子态的有效样本数、命中率、z、权重及是否入票。
// 与线上 train() 使用同一套阈值/半衰期，便于肉眼比对。
export function factorStatsTable(stats, opts = {}) {
  const MIN_SAMPLE = opts.MIN_SAMPLE ?? TSEV_CFG.LOCAL_FACTOR_MIN;
  const Z_THRESH = opts.Z_THRESH ?? TSEV_CFG.Z_THRESH;
  const halfLife = opts.recencyHalfLifeDays ?? TSEV_CFG.LOCAL_RECENCY_HALFLIFE_DAYS;
  const now = opts.now != null ? opts.now : Date.now();
  const out = [];
  for (const k in stats) {
    const a = stats[k];
    if (!a) continue;
    let n = 0, h = 0;
    if (a.buckets) { const agg = aggregateBuckets(a, now, halfLife); n = agg.n; h = agg.h; }
    else { n = a.n || 0; h = a.h || 0; }
    const p = n > 0 ? h / n : 0;
    const se = n > 0 ? 0.5 / Math.sqrt(n) : 0;
    const z = se > 0 ? (p - 0.5) / se : 0;
    const passed = n >= MIN_SAMPLE && Math.abs(z) >= Z_THRESH && p > 0 && p < 1;
    const pAdj = p <= 0 ? 1e-6 : p >= 1 ? 1 - 1e-6 : p;
    const w = Math.log(pAdj / (1 - pAdj));
    const side = Number(k.split('|')[2]);
    out.push({ key: k, side, n: Math.round(n), h, p: +p.toFixed(3), z: +z.toFixed(2), w: +w.toFixed(3), passed });
  }
  out.sort((a, b) => b.w - a.w);
  return out;
}

// 前向准确度回测（供面板信任看板）：把带标签样本按时间切 train/test，用 train 训练权重，
// 在 test 上重放 TSEV 投票，统计「TSEV 方向 = 实际方向」的命中率。
// 与线上 train() 严格一致：使用 LOCAL_FACTOR_MIN / LOCAL_RECENCY_HALFLIFE_DAYS / Z_THRESH / SHRINK。
// 改进（A）：非重叠 walk-forward（embargo 间隔，去除 STRIDE=1 相邻强相关）+ 各周期(h4/d1/d3)独立命中率 +
// 覆盖率 + 入票因子数，使「51%」数字真实反映部署模型而非更严的离线默认。
// rows: [{ factors:[{name,cond,side}], raw:+1/-1/0, futDir:{h4,d1,d3} }]
// 返回 { acc, n, coverage, perHorizon:{h4,d1,d3}, factorCount } 或 null（样本不足）。
export function forwardAccuracy(rows, opts = {}) {
  if (!rows || rows.length < 40) return null;
  const split = opts.split != null ? opts.split : 0.7;
  const embargo = opts.embargo != null ? opts.embargo : 24; // 测试集每隔 embargo 根才计一次，去相邻强相关
  const trainOpts = {
    MIN_SAMPLE: TSEV_CFG.LOCAL_FACTOR_MIN,
    Z_THRESH: TSEV_CFG.Z_THRESH,
    recencyHalfLifeDays: TSEV_CFG.LOCAL_RECENCY_HALFLIFE_DAYS,
    shrink: TSEV_CFG.SHRINK
  };
  const HZ = ['h4', 'd1', 'd3'];
  const cut = Math.floor(rows.length * split);
  const gap = embargo; // 训练/测试之间留空窗，避免 STRIDE=1 的价格窗重叠导致泄漏（非重叠 walk-forward）
  const train = rows.slice(0, cut);
  const test = rows.slice(Math.min(rows.length, cut + gap));
  // 按各 horizon 标签分别累积训练统计（各周期独立训一套权重）
  const acc = { h4: {}, d1: {}, d3: {} };
  for (const r of train) {
    const fs = r.factors || [];
    for (const h of HZ) {
      const lab = (r.futDir && r.futDir[h]) || r.raw || 0;
      if (!lab) continue;
      const a = acc[h];
      for (const f of fs) {
        if (!f || f.side === 0) continue;
        const key = f.name + '|' + f.cond + '|' + f.side;
        const s = a[key] || (a[key] = { n: 0, h: 0 });
        s.n++; s.h += (lab === f.side) ? 1 : 0;
      }
    }
  }
  const W = {};
  for (const h of HZ) W[h] = trainTsevWeightsStats(acc[h], trainOpts);
  const per = {}; let n = 0, hit = 0;
  for (const r of test) {
    const lab = (r.futDir && r.futDir.d1) || r.raw || 0; // 主判决用 d1（与线上 addRow 一致）
    if (!lab) continue;
    const v = voteTsev(r.factors || [], W.d1, trainOpts);
    if (v.dir === 0) continue;
    n++;
    if ((v.dir > 0 ? 1 : -1) === lab) hit++;
    for (const h of HZ) {
      const lh = (r.futDir && r.futDir[h]) || r.raw || 0;
      if (!lh) continue;
      const vh = voteTsev(r.factors || [], W[h], trainOpts);
      if (vh.dir === 0) continue;
      per[h] = per[h] || { n: 0, hit: 0 };
      per[h].n++;
      if ((vh.dir > 0 ? 1 : -1) === lh) per[h].hit++;
    }
  }
  if (!n) return null;
  const perHorizon = {};
  for (const h of HZ) perHorizon[h] = per[h] ? +(per[h].hit / per[h].n).toFixed(3) : null;
  return {
    acc: +(hit / n).toFixed(3),
    n,
    coverage: +(n / test.length).toFixed(3),
    perHorizon,
    factorCount: Object.keys(W.d1).filter(k => !k.startsWith('__')).length
  };
}

// 近期衰减：把聚合统计整体乘 factor（factor∈[0,1]），用于本机 loop 让旧行情样本随时间淡出，
// 使 TSEV 权重跟随实时行情（对称地多空、不偏袒任何单边）。原地修改 stats 并返回（便于单测与原地应用）。
export function decayStats(stats, factor) {
  if (!stats || factor == null || factor >= 1) return stats;
  const f = Math.max(0, Math.min(1, factor));
  for (const k in stats) {
    const s = stats[k];
    if (!s) continue;
    s.n *= f; s.h *= f;
  }
  return stats;
}
