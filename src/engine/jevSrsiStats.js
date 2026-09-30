// ============================================================
// Jev×SRSI 统计裁决核心（GOAL_jev-srsi §4 · P2）—— **纯函数，面板与脚本共用**
//
// ⚠ 红线：「面板与脚本必须复用本模块，禁两侧各写一套」。判定线（`JE_SRSI_DECISION`）
//   **在看到数据之前写死**，之后不得因结果不好而调整（防事后择优，GOAL §4/§8）。
//
// 提供：
//   - 分组指标（命中率 / 均值盈亏 / 扣费后期望 / 95% CI / 二项 p）
//   - 对照：随机标签置换（200 次）/ 时序旋转（200 次）/ walk-forward 4 折 / Bonferroni 校正
//   - `evaluateJevSrsi(pairs)` → 逐项判定 + 结论文本（脚本与面板同源）
//
// 本模块**不依赖浏览器/DOM/IDB**，可被 Node 脚本直接 import。
// ============================================================

// ---------------------------------------------------------------------------
// 判定线（预先声明，写死在代码常量里；改它 = 改判定线，必须有用户显式确认）
// ---------------------------------------------------------------------------
export const JE_SRSI_DECISION = {
  // 业务判定
  MIN_INCREMENT_PP: 5.0,     // ① 同向 − 反向 ≥ 5.0 pp
  MAX_P_ADJ: 0.05,           // ② Bonferroni 校正后 p < 0.05
  MIN_PAIRS: 300,            // ④ 样本 ≥ 300
  MIN_GROUP: 100,            // ④ 且 相比两组（同向/反向）各 ≥ 100
  // 方法参数（同样预先声明）
  PERM_ITERATIONS: 200,      // 随机标签 / 时序旋转 各 200 次
  WALK_FORWARD_K: 4,         // walk-forward 4 折
  BONFERRONI_K: 6,           // 比较维度数 = 3 组 × 2 指标
  FEE_PCT_PER_SIDE: 0.065,   // taker 0.045% + 滑点 0.02%（与 signal-lab 口径一致）
  ROUND_TRIP_PCT: 0.13,      // = 2 × FEE_PCT_PER_SIDE
  SEED: 20260930             // 固定随机种子（置换/旋转可复现）
};

export const JE_SRSI_GROUP_KEYS = ['same', 'reverse', 'flat'];
export const JE_SRSI_GROUP_LABELS = { same: 'Jev 同向', reverse: 'Jev 反向', flat: 'Jev 中性或缺' };

// ---------------------------------------------------------------------------
// 通用
// ---------------------------------------------------------------------------
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** 确定性 PRNG（mulberry32，与 signal-lab 同实现）——保证置换/旋转可复现 */
export function mulberry32(seed) {
  let s = seed | 0;
  return function () {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

/** Wilson 95% 置信区间（wins/n），n<=0 → null */
export function wilsonCI(wins, n, z = 1.96) {
  if (!finite(+n) || +n <= 0) return null;
  const p = Math.max(0, Math.min(1, (+wins) / (+n)));
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const half = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - half) / d), Math.min(1, (c + half) / d)];
}

/** 两比例 z 检验（参考用；判定线主用置换 p）→ {z, p} */
export function twoPropZ(w1, n1, w2, n2) {
  if (!finite(+n1) || !finite(+n2) || n1 <= 0 || n2 <= 0) return { z: null, p: null };
  const p1 = w1 / n1, p2 = w2 / n2;
  const pool = (w1 + w2) / (n1 + n2);
  const se = Math.sqrt(pool * (1 - pool) * (1 / n1 + 1 / n2));
  if (!(se > 0)) return { z: null, p: null };
  const z = (p1 - p2) / se;
  // 双侧 p（正态近似）
  const p = 2 * (1 - normCdf(Math.abs(z)));
  return { z, p: Math.max(0, Math.min(1, p)) };
}
function normCdf(x) {
  // Abramowitz-Stegun 7.1.26
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const cdf = 1 - d * poly;
  return x >= 0 ? cdf : 1 - cdf;
}

/** 分组：Jev 同向 / 反向 / 中性或缺 */
export function pairGroupOf(p) {
  if (!p) return 'flat';
  if (!p.jevSide) return 'flat';
  return p.jevSide === p.side ? 'same' : 'reverse';
}

/** 是否为「已判定」样本（可进命中率/期望统计；pending 与 no-entry 除外） */
export function isDecided(p) {
  const o = p && p.outcome;
  return !!(o && o.status !== 'pending' && o.status !== 'no-entry');
}

// ---------------------------------------------------------------------------
// 分组指标（canonical，jevSrsiAudit 复用本函数）
// ---------------------------------------------------------------------------
function emptyGroup(key) {
  return {
    key, label: JE_SRSI_GROUP_LABELS[key],
    n: 0, decided: 0, wins: 0, losses: 0, expired: 0, pending: 0, noEntry: 0,
    hitRate: null, grossAvgPnl: null, expectancy: null, ci: null,
    _pnlSum: 0, _pnlN: 0
  };
}
function finalizeGroup(g, roundTripPct) {
  const dec = g.wins + g.losses;
  g.hitRate = dec > 0 ? g.wins / dec : null;
  g.grossAvgPnl = g._pnlN > 0 ? g._pnlSum / g._pnlN : null;
  g.expectancy = g.grossAvgPnl != null ? g.grossAvgPnl - roundTripPct : null;
  g.ci = wilsonCI(g.wins, dec);
  delete g._pnlSum; delete g._pnlN;
  return g;
}

/**
 * 配对统计（canonical）。`expectancy` = 均值盈亏 − 往返成本（默认 0.13%）。
 * @returns {total,decided,pending,noEntry,withJev,coverage,days,groups:{same,reverse,flat},increment,enough,minPairs,minGroup}
 */
export function pairStats(pairs, opts = {}) {
  const list = (Array.isArray(pairs) ? pairs : []).filter(Boolean);
  const roundTripPct = finite(+opts.roundTripPct) ? +opts.roundTripPct : JE_SRSI_DECISION.ROUND_TRIP_PCT;
  const groups = { same: emptyGroup('same'), reverse: emptyGroup('reverse'), flat: emptyGroup('flat') };
  let decided = 0, pending = 0, noEntry = 0, withJev = 0;
  let minTs = Infinity, maxTs = -Infinity;
  for (const p of list) {
    if (finite(+p.ts)) { minTs = Math.min(minTs, +p.ts); maxTs = Math.max(maxTs, +p.ts); }
    if (p.jevSide) withJev++;
    const g = groups[pairGroupOf(p)];
    const o = p.outcome;
    if (!o || o.status === 'pending') { pending++; g.pending++; continue; }
    if (o.status === 'no-entry') { noEntry++; g.noEntry++; continue; }
    decided++; g.n++; g.decided++;
    if (o.status === 'win') g.wins++;
    else if (o.status === 'loss') g.losses++;
    else g.expired++;
    if (finite(+o.pnlPct)) { g._pnlSum += +o.pnlPct; g._pnlN++; }
  }
  for (const k of JE_SRSI_GROUP_KEYS) finalizeGroup(groups[k], roundTripPct);
  const inc = (groups.same.hitRate != null && groups.reverse.hitRate != null)
    ? (groups.same.hitRate - groups.reverse.hitRate) * 100 : null;
  const minPairs = finite(+opts.minPairs) ? +opts.minPairs : JE_SRSI_DECISION.MIN_PAIRS;
  const minGroup = finite(+opts.minGroup) ? +opts.minGroup : JE_SRSI_DECISION.MIN_GROUP;
  const enough = list.length >= minPairs && groups.same.decided >= minGroup && groups.reverse.decided >= minGroup;
  return {
    total: list.length, decided, pending, noEntry, withJev,
    coverage: list.length ? withJev / list.length : 0,
    days: (Number.isFinite(minTs) && Number.isFinite(maxTs)) ? (maxTs - minTs) / 86400000 : 0,
    groups, increment: inc, enough, minPairs, minGroup, roundTripPct
  };
}

// ---------------------------------------------------------------------------
// 对照
// ---------------------------------------------------------------------------
function decidedPairs(pairs) {
  return (Array.isArray(pairs) ? pairs : []).filter(isDecided);
}
function sortByTs(list) {
  return list.slice().sort((a, b) => (+a.ts || 0) - (+b.ts || 0));
}
function incrementFromCounts(wS, nS, wR, nR) {
  if (!nS || !nR) return null;
  return ((wS / nS) - (wR / nR)) * 100;
}

/**
 * 随机标签置换对照：打乱 Jev 意见标签（保留标签多重集）→ 增量分布。
 * H0 = 「Jev 标签与结局无关」。p = P(置换增量 ≥ 观测增量)。
 * @returns {observed, p, iterations, dist:{mean,p05,p95,max}, valid}
 */
export function labelPermutation(pairs, opts = {}) {
  const iterations = finite(+opts.iterations) ? Math.max(1, Math.round(+opts.iterations)) : JE_SRSI_DECISION.PERM_ITERATIONS;
  const seed = opts.seed != null ? opts.seed : JE_SRSI_DECISION.SEED;
  const obs = pairStats(pairs).increment;
  const decided = decidedPairs(pairs);
  if (obs == null || decided.length < 4) return { observed: obs, p: null, iterations: 0, dist: { mean: null, p05: null, p95: null, max: null }, valid: false };
  const labels = decided.map(p => p.jevSide || null);
  const rng = mulberry32(seed);
  const incs = [];
  for (let it = 0; it < iterations; it++) {
    shuffleInPlace(labels, rng);
    let wS = 0, wR = 0, nS = 0, nR = 0;
    for (let i = 0; i < decided.length; i++) {
      const lab = labels[i]; if (!lab) continue;               // flat 不参与增量
      const st = decided[i].outcome.status;
      if (st !== 'win' && st !== 'loss') continue;             // expired 不计入命中率分母
      if (lab === decided[i].side) { nS++; if (st === 'win') wS++; }
      else { nR++; if (st === 'win') wR++; }
    }
    const i2 = incrementFromCounts(wS, nS, wR, nR);
    if (i2 != null) incs.push(i2);
  }
  return summarizePerm(obs, incs, iterations);
}

function summarizePerm(obs, incs, iterations) {
  if (!incs.length) return { observed: obs, p: null, iterations, dist: { mean: null, p05: null, p95: null, max: null }, valid: false };
  let ge = 0, sum = 0, max = -Infinity;
  for (const v of incs) { if (v >= obs - 1e-9) ge++; sum += v; if (v > max) max = v; }
  const sorted = incs.slice().sort((a, b) => a - b);
  const q = (f) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(f * (sorted.length - 1))))];
  return {
    observed: obs,
    p: (1 + ge) / (1 + incs.length),
    iterations: incs.length,
    dist: { mean: sum / incs.length, p05: q(0.05), p95: q(0.95), max },
    valid: true
  };
}

/**
 * 时序旋转对照：按时间排序后，把**结局序列**循环右移随机 k 位（保留结局边际与自相关，
 * 破坏「信号时刻 ↔ 未来窗口」的时间对齐）→ 增量分布。用于排除「优势来自与趋势相关性」。
 */
export function rotationTest(pairs, opts = {}) {
  const iterations = finite(+opts.iterations) ? Math.max(1, Math.round(+opts.iterations)) : JE_SRSI_DECISION.PERM_ITERATIONS;
  const seed = opts.seed != null ? opts.seed : JE_SRSI_DECISION.SEED + 1;
  const obs = pairStats(pairs).increment;
  const decided = sortByTs(decidedPairs(pairs));
  if (obs == null || decided.length < 8) return { observed: obs, p: null, iterations: 0, dist: { mean: null, p05: null, p95: null, max: null }, valid: false };
  const outcomes = decided.map(p => p.outcome);
  const rng = mulberry32(seed);
  const incs = [];
  for (let it = 0; it < iterations; it++) {
    const k = 1 + Math.floor(rng() * (decided.length - 1));
    const rotated = outcomes.slice(k).concat(outcomes.slice(0, k));
    const tmp = decided.map((p, i) => ({ side: p.side, jevSide: p.jevSide, outcome: rotated[i] }));
    const inc = pairStats(tmp).increment;
    if (inc != null) incs.push(inc);
  }
  return summarizePerm(obs, incs, iterations);
}

/** 按时间顺序把配对切成 k 个连续折，返回每折的增量与计数 */
export function foldsOf(pairs, opts = {}) {
  const k = finite(+opts.k) ? Math.max(2, Math.round(+opts.k)) : JE_SRSI_DECISION.WALK_FORWARD_K;
  const list = sortByTs((Array.isArray(pairs) ? pairs : []).filter(Boolean));
  const out = [];
  if (!list.length) return out;
  for (let i = 0; i < k; i++) {
    const from = Math.floor(i * list.length / k);
    const to = Math.floor((i + 1) * list.length / k);
    const slice = list.slice(from, to);
    const st = pairStats(slice);
    out.push({
      i, from, to, n: slice.length, decided: st.decided,
      fromTs: slice.length ? (+slice[0].ts || null) : null,
      toTs: slice.length ? (+slice[slice.length - 1].ts || null) : null,
      sameN: st.groups.same.decided, reverseN: st.groups.reverse.decided,
      sameHit: st.groups.same.hitRate, reverseHit: st.groups.reverse.hitRate,
      increment: st.increment
    });
  }
  return out;
}

/**
 * walk-forward：前 k−1 折定阈值（本模块用**预先声明的 5pp**，不另调），最后 1 折验证。
 * 「同号」= 末折增量 > 0 且与汇总增量同号。
 */
export function walkForward(pairs, opts = {}) {
  const k = finite(+opts.k) ? Math.max(2, Math.round(+opts.k)) : JE_SRSI_DECISION.WALK_FORWARD_K;
  const folds = foldsOf(pairs, { k });
  const pooled = pairStats(pairs).increment;
  const last = folds.length ? folds[folds.length - 1] : null;
  const lastInc = last ? last.increment : null;
  const consistent = lastInc != null && pooled != null && lastInc > 0 && Math.sign(lastInc) === Math.sign(pooled);
  return { k, folds, pooled, lastIncrement: lastInc, consistent };
}

/** Bonferroni 校正（k 个比较） */
export function bonferroni(p, k = JE_SRSI_DECISION.BONFERRONI_K) {
  if (p == null || !finite(+p)) return null;
  return Math.min(1, (+p) * (finite(+k) ? +k : 1));
}

// ---------------------------------------------------------------------------
// 总判定
// ---------------------------------------------------------------------------
/**
 * 运行 P2 裁决。样本不足时**不跑重置换/旋转**（早退，零开销）。
 * @returns {spec, stats, increment, controls, pLabel, pRotate, pZ, pAdj, walk, checks, pass, ran, reason, verdict, report}
 */
export function evaluateJevSrsi(pairs, opts = {}) {
  const spec = Object.assign({}, JE_SRSI_DECISION, opts.spec || {});
  const stats = pairStats(pairs, { minPairs: spec.MIN_PAIRS, minGroup: spec.MIN_GROUP, roundTripPct: spec.ROUND_TRIP_PCT });
  const samplesOk = stats.total >= spec.MIN_PAIRS
    && stats.groups.same.decided >= spec.MIN_GROUP
    && stats.groups.reverse.decided >= spec.MIN_GROUP;
  const inc = stats.increment;
  const incrementOk = inc != null && inc >= spec.MIN_INCREMENT_PP;

  let pLabel = null, pRotate = null, pZ = null, pAdj = null, signifOk = false;
  let controls = null, ran = false;
  if (samplesOk && inc != null) {
    ran = true;
    const label = labelPermutation(pairs, { iterations: spec.PERM_ITERATIONS, seed: spec.SEED });
    const rotate = rotationTest(pairs, { iterations: spec.PERM_ITERATIONS, seed: spec.SEED + 1 });
    pLabel = label.p; pRotate = rotate.p;
    const g = stats.groups;
    pZ = twoPropZ(g.same.wins, g.same.decided, g.reverse.wins, g.reverse.decided).p;
    pAdj = bonferroni(pLabel, spec.BONFERRONI_K);
    signifOk = pAdj != null && pAdj < spec.MAX_P_ADJ;
    controls = { label, rotate };
  }
  const walk = walkForward(pairs, { k: spec.WALK_FORWARD_K });
  const walkOk = !!walk.consistent;
  const checks = { samples: samplesOk, increment: incrementOk, signif: signifOk, walkForward: walkOk };
  const pass = ran && checks.samples && checks.increment && checks.signif && checks.walkForward;
  const reason = !checks.samples ? '样本不足（观察期未满）'
    : !checks.increment ? '增量未达 5.0 pp'
    : !checks.signif ? '校正后 p ≥ 0.05（不显著）'
    : !checks.walkForward ? 'walk-forward 末折未同号'
    : '通过';
  const report = { spec, stats, increment: inc, controls, pLabel, pRotate, pZ, pAdj, walk, checks, pass, ran, reason };
  report.verdict = verdictText(report);
  return report;
}

/** 一句话结论（面板/脚本同源） */
export function verdictText(r) {
  if (!r) return '—';
  const c = r.checks || {};
  const mark = (b) => b ? '✓' : '✗';
  const inc = r.increment == null ? '—' : ((r.increment >= 0 ? '+' : '') + r.increment.toFixed(1) + 'pp');
  const pAdj = r.pAdj == null ? '—' : r.pAdj.toFixed(3);
  const head = r.pass ? '✅ 通过（Jev 对 SRSI 有增量信息——仍需用户确认后才可进入 P3）'
    : '⛔ 未通过 → 若观察期已满则按判定线**终止**（只保留 P1 审计 + P4 学习）';
  return head + '\n'
    + '① 增量 ' + inc + (c.increment ? ' ✓' : ' ✗') + '（门槛 ≥' + r.spec.MIN_INCREMENT_PP + 'pp）· '
    + '② 校正后 p ' + pAdj + (c.signif ? ' ✓' : ' ✗') + '（Bonferroni ×' + r.spec.BONFERRONI_K + '）· '
    + '③ walk-forward 末折 ' + (r.walk && r.walk.lastIncrement != null ? ((r.walk.lastIncrement >= 0 ? '+' : '') + r.walk.lastIncrement.toFixed(1) + 'pp') : '—') + (c.walkForward ? ' ✓' : ' ✗') + ' · '
    + '④ 样本 ' + (r.stats ? r.stats.total : 0) + (c.samples ? ' ✓' : ' ✗') + '（需 ≥' + r.spec.MIN_PAIRS + '，同向/反向各 ≥' + r.spec.MIN_GROUP + '）';
}

/** 纯文本报告（Node 脚本 stdout 与面板「报告」共用） */
export function formatReport(r) {
  if (!r) return '';
  const L = [];
  const f2 = (v, d = 1) => (v == null || !finite(+v)) ? '—' : (+v).toFixed(d);
  const pct = (v, d = 1) => (v == null || !finite(+v)) ? '—' : ((+v) * 100).toFixed(d) + '%';
  L.push('=== Jev×SRSI P2 统计裁决 ===');
  L.push('判定线（预先声明）: 增量 ≥ ' + r.spec.MIN_INCREMENT_PP + 'pp · 校正 p < ' + r.spec.MAX_P_ADJ
    + ' · walk-forward 末折同号 · 样本 ≥ ' + r.spec.MIN_PAIRS + '/每组 ≥ ' + r.spec.MIN_GROUP
    + ' · 置换 ' + r.spec.PERM_ITERATIONS + ' 次 · Bonferroni ×' + r.spec.BONFERRONI_K
    + ' · 成本 ' + r.spec.ROUND_TRIP_PCT + '%/往返');
  const s = r.stats || {};
  L.push('样本: total ' + (s.total || 0) + ' · decided ' + (s.decided || 0) + ' · pending ' + (s.pending || 0)
    + ' · no-entry ' + (s.noEntry || 0) + ' · Jev 覆盖 ' + pct(s.coverage, 0) + ' · 跨度 ' + f2(s.days) + ' 天');
  for (const k of JE_SRSI_GROUP_KEYS) {
    const g = (s.groups || {})[k] || {};
    L.push('  [' + (g.label || k) + '] n ' + (g.decided || 0) + ' · 命中 ' + pct(g.hitRate)
      + '（' + (g.wins || 0) + '/' + ((g.wins || 0) + (g.losses || 0)) + '）'
      + ' · 均值 ' + f2(g.grossAvgPnl, 2) + '% · 扣费后期望 ' + f2(g.expectancy, 2) + '%'
      + ' · CI ' + (g.ci ? pct(g.ci[0], 0) + '~' + pct(g.ci[1], 0) : '—')
      + ' · 过期 ' + (g.expired || 0) + ' · 待回填 ' + (g.pending || 0));
  }
  L.push('增量（同向−反向）: ' + f2(r.increment, 2) + ' pp');
  if (r.controls) {
    L.push('对照 随机标签置换: p ' + f2(r.pLabel, 4) + '（置换分布 p05 ' + f2(r.controls.label.dist.p05, 2) + ' / p95 ' + f2(r.controls.label.dist.p95, 2) + '）');
    L.push('对照 时序旋转:     p ' + f2(r.pRotate, 4) + '（分布 p05 ' + f2(r.controls.rotate.dist.p05, 2) + ' / p95 ' + f2(r.controls.rotate.dist.p95, 2) + '）');
    L.push('参考 两比例 z 检验 p: ' + f2(r.pZ, 4) + ' · Bonferroni 校正后 p: ' + f2(r.pAdj, 4));
  } else if (!r.ran) {
    L.push('对照: 未运行（样本不足）');
  }
  if (r.walk) {
    L.push('walk-forward ' + r.walk.k + ' 折增量: ' + r.walk.folds.map(f => (f.increment == null ? '—' : (f.increment >= 0 ? '+' : '') + f.increment.toFixed(1))).join(' | ')
      + '  → 末折同号: ' + (r.walk.consistent ? '是' : '否'));
  }
  L.push('判定: ' + (r.pass ? 'PASS' : 'FAIL') + '（' + r.reason + '）');
  L.push(r.verdict || '');
  return L.join('\n');
}
