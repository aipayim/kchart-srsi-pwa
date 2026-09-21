// 缠论（缠中说禅 / Chanlun）纯函数引擎 —— 结构计算层
// 设计原则（与 maRelation.js 一致）：
//   * 纯函数、零 DOM / 零网络 / 不读 window；渲染与 UI 由调用方负责。
//   * 只用「已收盘」K 线；每个对象都携带 confirmedAt（何时可知）与 finalAt（何时不再变）。
//   * 不做任何「事后重新划分」：调用方若要用信号做回测，必须使用 finalAt，而不是对象自身的时间。
//
// ⚠️ 诚实声明（重要）：
//   - 底层（K线包含处理 / 分型 / 笔）在给定规则下是确定性的，可机械化。
//   - 上层（线段 / 中枢 / 背驰 / 买卖点）在原著中留有多处未定义的选择点，
//     不同实现会得到不同结果。本模块把这些选择点全部做成显式配置项（见 CHAN_DEFAULTS），
//     并把「哪些是近似」写在各函数注释里。禁止把本模块的输出当作「原著的唯一正确解」。
//   - 已知的近似：线段采用「1+1 终结」简化版；背驰用 MACD 柱面积或斜率；
//     三类买卖点采用简化判据（完整判据需要多级别走势类型递归，未实现）。
//
// 术语与流水线：
//   原始K线 → 包含处理 → 分型 → 笔 → 线段 → 中枢 → 走势类型 → 背驰 → 三类买卖点

import { macd } from './indicators.js';

// ---------------------------------------------------------------------------
// 配置（全部选择点显式化；每一层都可单独开关，供显示层做「可选项」）
// ---------------------------------------------------------------------------
export const CHAN_DEFAULTS = {
  // —— 笔：新笔 / 老笔（原著未统一定义，见模块头声明）——
  //   'new'：顶分型最高K与底分型最低K之间（不含端点）至少 3 根合并K线 → 端点距离 >= 4
  //   'old'：两分型之间至少 1 根独立合并K线（更严）                      → 端点距离 >= 5
  biMode: 'new',
  // —— 线段：'simple' = 1+1 终结（确定性简化版）；'feature' = 特征序列近似 ——
  segMode: 'simple',
  // —— 中枢：区间口径 'first3'（前三段固定，原著主流读法）| 'all'（全部重叠段）——
  zsGate: 'first3',
  zsMinBis: 3,            // 构成中枢的最少「笔」数（线段中枢见 useSegForZs）
  useSegForZs: false,     // true → 用线段构造中枢（原著第 83 课称线段中枢更稳定）
  // —— 背驰：'macd'（MACD 柱面积，第 24 课口径）| 'slope'（幅度/时间）——
  divMeasure: 'macd',
  divRatio: 1.0,          // 后段力度 / 前段力度 < divRatio 才算背驰
  // —— MACD 参数（与项目 indicators.macd 一致）——
  macdFast: 12, macdSlow: 26, macdSignal: 9,
  // —— 显示层开关（默认关；开启后主图/面板才绘制）——
  on: false,
  showBi: true,
  showSeg: true,
  showZs: true,
  showDiv: true,
  showBsp: true,
  showTrend: true,
};

function num(v) { return typeof v === 'number' && Number.isFinite(v); }
function arr(v) { return Array.isArray(v) ? v : []; }
function pick(obj, keys) { for (const k of keys) if (num(obj && obj[k])) return obj[k]; return null; }

// ---------------------------------------------------------------------------
// 0. 输入规范化
// 支持：{opens,highs,lows,closes,vols,times} 或 [{o,h,l,c,v,t}] 或 [[t,o,h,l,c,v]]
// ---------------------------------------------------------------------------
export function normalizeBars(input) {
  const src = input || {};
  if (Array.isArray(src)) {
    const o = [], h = [], l = [], c = [], v = [], t = [];
    for (const b of src) {
      if (Array.isArray(b)) { t.push(b[0]); o.push(b[1]); h.push(b[2]); l.push(b[3]); c.push(b[4]); v.push(b[5] == null ? 0 : b[5]); }
      else if (b && typeof b === 'object') {
        t.push(pick(b, ['t', 'time', 'openTime']) ?? 0);
        o.push(pick(b, ['o', 'open'])); h.push(pick(b, ['h', 'high']));
        l.push(pick(b, ['l', 'low'])); c.push(pick(b, ['c', 'close']));
        v.push(pick(b, ['v', 'vol', 'volume']) ?? 0);
      }
    }
    return { o, h, l, c, v, t, n: c.length };
  }
  // 短键形式 {o,h,l,c,v,t}（sliceUpTo 的输出）与长键形式 {opens,highs,...} 均支持
  const c = arr(src.closes).length ? arr(src.closes) : arr(src.c);
  const h = (arr(src.highs).length ? arr(src.highs) : arr(src.h).length ? arr(src.h) : c);
  const l = (arr(src.lows).length ? arr(src.lows) : arr(src.l).length ? arr(src.l) : c);
  const o = (arr(src.opens).length ? arr(src.opens) : arr(src.o).length ? arr(src.o) : c);
  const v = arr(src.vols).length ? arr(src.vols) : arr(src.v);
  const t = arr(src.times).length ? arr(src.times) : arr(src.t);
  return { o, h, l, c, v, t, n: c.length };
}

// 截断到「原始索引 <= asOf」的子序列（用于逐 bar 重算 / 无前视校验）
// 接受 normalizeBars 的输出；若传入原始输入（无 c 字段）则先规范化。
export function sliceUpTo(bars, asOf) {
  const b = bars && Array.isArray(bars.c) ? bars : normalizeBars(bars);
  const n = Math.max(0, Math.min(b.n, asOf + 1));
  const cut = (a) => (Array.isArray(a) && a.length ? a.slice(0, n) : []);
  return { o: cut(b.o), h: cut(b.h), l: cut(b.l), c: cut(b.c), v: cut(b.v), t: cut(b.t), n };
}

// ---------------------------------------------------------------------------
// 1. K 线包含处理（✅ 确定性）
// 规则：若两根相邻 K 线存在包含关系，按当前方向合并——
//   向上：h = max(h)，l = max(l)；向下：h = min(h)，l = min(l)。
// 合并只可能修改「最后一个」合并K线 → 这给了我们精确的「冻结时刻」。
// 返回合并K线：{ h, l, i0, i1, hiIdx, loIdx, dir }
//   i0/i1   = 该合并K线覆盖的原始索引区间
//   hiIdx/loIdx = 最高/最低价所在的原始索引
//   dir     = 该合并K线相对前一根的方向（+1 上 / -1 下 / 0 首根）
// ---------------------------------------------------------------------------
export function mergeInclusion(highs, lows) {
  const H = arr(highs), L = arr(lows);
  const out = [];
  for (let k = 0; k < H.length; k++) {
    if (!num(H[k]) || !num(L[k])) continue;
    let bar = { h: H[k], l: L[k], i0: k, i1: k, hiIdx: k, loIdx: k, dir: 0 };
    let guard = 0;
    while (out.length >= 1 && guard++ < 1000) {
      const prev = out[out.length - 1];
      const contain = (bar.h <= prev.h && bar.l >= prev.l) || (bar.h >= prev.h && bar.l <= prev.l);
      if (!contain) break;
      let dir = prev.dir;
      if (!dir) {
        const pp = out.length >= 2 ? out[out.length - 2] : null;
        dir = pp ? (prev.h > pp.h ? 1 : -1) : (bar.h >= prev.h ? 1 : -1);
      }
      let nh, nl, hiIdx, loIdx;
      if (dir > 0) {
        nh = Math.max(prev.h, bar.h); nl = Math.max(prev.l, bar.l);
        hiIdx = bar.h >= prev.h ? bar.hiIdx : prev.hiIdx;
        loIdx = bar.l >= prev.l ? bar.loIdx : prev.loIdx;
      } else {
        nh = Math.min(prev.h, bar.h); nl = Math.min(prev.l, bar.l);
        hiIdx = bar.h <= prev.h ? bar.hiIdx : prev.hiIdx;
        loIdx = bar.l <= prev.l ? bar.loIdx : prev.loIdx;
      }
      out.pop();
      bar = { h: nh, l: nl, i0: prev.i0, i1: bar.i1, hiIdx, loIdx, dir };
      if (out.length === 0) break;
    }
    out.push(bar);
  }
  // 补齐方向
  for (let i = 0; i < out.length; i++) {
    if (!out[i].dir) {
      const p = out[i - 1];
      out[i].dir = p ? (out[i].h > p.h ? 1 : out[i].h < p.h ? -1 : 0) : 0;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. 分型（✅ 确定性，滞后 1 根）
// 顶分型：中间合并K线的 h 与 l 都高于左右两根；底分型镜像。
// confirmedAt：分型位于合并索引 i，只有当合并K线 i+1 冻结后才成立。
//   由于「合并只改最后一根」，merged[i+1] 在 merged[i+2] 被 push 的那一刻冻结
//   → confirmedAt = merged[i+2].i0（若不存在则 null，表示尚未确认）。
// ---------------------------------------------------------------------------
export function detectFractals(merged) {
  const out = [];
  const m = arr(merged);
  for (let i = 1; i < m.length - 1; i++) {
    const a = m[i - 1], b = m[i], c = m[i + 1];
    const top = b.h > a.h && b.h > c.h && b.l > a.l && b.l > c.l;
    const bot = b.l < a.l && b.l < c.l && b.h < a.h && b.h < c.h;
    const right = m[i + 2] || null;          // 冻结 merged[i+1] 的那根
    const confirmedAt = right ? right.i0 : null;
    if (top) out.push({ mi: i, type: 'top', price: b.h, extremeIdx: b.hiIdx, confirmedAt });
    else if (bot) out.push({ mi: i, type: 'bottom', price: b.l, extremeIdx: b.loIdx, confirmedAt });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. 笔（✅ 给定规则后确定；端点会被后续更极端分型替换 → 见 finalAt）
// 规则：顶↔底交替；两分型不共用合并K线；端点合并索引距离 >= minDist（见 CHAN_DEFAULTS.biMode）。
// finalAt：一笔的终点在「下一笔（反向）形成」之前都可能被替换 → 只有 bis[j+1] 存在时 bis[j] 才定稿。
//   bi[j].finalAt = bis[j+1] ? bis[j+1].confirmedAt : null
// ---------------------------------------------------------------------------
export function buildBi(fractals, merged, opts = {}) {
  const mode = opts.biMode || CHAN_DEFAULTS.biMode;
  const minDist = mode === 'old' ? 5 : 4;
  const fr = arr(fractals), m = arr(merged);
  const raw = [];
  let start = null;
  for (const f of fr) {
    if (!start) { start = f; continue; }
    if (f.type === start.type) {
      // 同类型：取更极端者作为新起点
      if ((f.type === 'top' && f.price > start.price) || (f.type === 'bottom' && f.price < start.price)) start = f;
      continue;
    }
    // 反向分型：距离够才成笔；太近则忽略（等后续更远的反向分型）
    if (f.mi - start.mi >= minDist) {
      raw.push(makeBi(start, f, m));
      start = f;
    }
  }
  // finalAt 回填：最后一笔永远未定稿
  for (let j = 0; j < raw.length; j++) {
    raw[j].finalAt = raw[j + 1] ? raw[j + 1].confirmedAt : null;
    raw[j].final = raw[j].finalAt != null;
  }
  return raw;
}

function makeBi(a, b, merged) {
  const up = b.type === 'top';
  const hiFr = up ? b : a, loFr = up ? a : b;
  return {
    dir: up ? 'up' : 'down',
    startMi: a.mi, endMi: b.mi,
    startIdx: a.extremeIdx, endIdx: b.extremeIdx,
    high: hiFr.price, low: loFr.price,
    highMi: hiFr.mi, lowMi: loFr.mi,
    highIdx: hiFr.extremeIdx, lowIdx: loFr.extremeIdx,
    startType: a.type, endType: b.type,
    confirmedAt: b.confirmedAt,   // 终点分型确认时，该笔才「出现」
    finalAt: null, final: false,
  };
}

// ---------------------------------------------------------------------------
// 4. 线段（⚠️ 多解：本实现为「1+1 终结」简化版）
// 规则：至少 3 笔；方向由首笔决定；当反向笔打破了「前一个同向反向笔」的极值时，线段结束。
// 该简化版是确定性的，但与原著「特征序列」口径不完全等价（见模块头声明）。
// ---------------------------------------------------------------------------
export function buildSegments(bis, opts = {}) {
  const b = arr(bis);
  const minBis = opts.segMinBis || 3;
  const segs = [];
  let i = 0;
  while (i < b.length) {
    const dir = b[i].dir;
    let lastOpp = null;      // 上一个反向笔的极值（上涨线段记低点，下跌记高点）
    let endBi = i;
    let j = i;
    let broken = false;
    for (; j < b.length; j++) {
      const cur = b[j];
      if (cur.dir === dir) { endBi = j; continue; }
      if (lastOpp != null) {
        if (dir === 'up' && cur.low < lastOpp) { broken = true; break; }
        if (dir === 'down' && cur.high > lastOpp) { broken = true; break; }
      }
      lastOpp = dir === 'up' ? cur.low : cur.high;
    }
    // 结束笔 = 破坏发生前最后一根同向笔（至少凑够 minBis）
    if (endBi - i + 1 < minBis) {
      if (!broken) break;             // 尾部不足，结束
      i = endBi + 1 > i ? endBi + 1 : i + 1;
      continue;
    }
    const first = b[i], last = b[endBi];
    const up = dir === 'up';
    segs.push({
      dir,
      startBi: i, endBi,
      startIdx: first.startIdx, endIdx: last.endIdx,
      high: up ? last.high : first.high,
      low: up ? first.low : last.low,
      nBis: endBi - i + 1,
      confirmedAt: last.confirmedAt,
      finalAt: null, final: false,
      approx: true,                   // ⚠️ 简化实现标记
    });
    i = endBi + 1;
  }
  for (let k = 0; k < segs.length; k++) {
    segs[k].finalAt = segs[k + 1] ? segs[k + 1].confirmedAt : null;
    segs[k].final = segs[k].finalAt != null;
  }
  return segs;
}

// ---------------------------------------------------------------------------
// 5. 中枢（⚠️ 多解：区间口径 first3 / all）
// 定义（第 17 课）：至少三个连续次级别走势重叠的部分。
//   ZG = 前三段高点的最小值；ZD = 前三段低点的最大值；ZG > ZD 才成立。
//   GG = 中枢内最高点；DD = 中枢内最低点。
// 延伸：后续走势仍与 [ZD, ZG] 重叠则并入；否则中枢结束。
// ---------------------------------------------------------------------------
export function detectCenters(moves, opts = {}) {
  const mv = arr(moves);
  const minN = opts.zsMinBis || CHAN_DEFAULTS.zsMinBis;
  const gate = opts.zsGate || CHAN_DEFAULTS.zsGate;
  const out = [];
  let i = 0;
  while (i + minN - 1 < mv.length) {
    const first = mv.slice(i, i + minN);
    let zg = Math.min(...first.map((x) => x.high));
    let zd = Math.max(...first.map((x) => x.low));
    if (!(zg > zd)) { i++; continue; }               // 不构成重叠 → 滑动
    let end = i + minN - 1;
    // 延伸：后续走势与 [zd,zg] 有重叠则并入
    for (let j = i + minN; j < mv.length; j++) {
      const x = mv[j];
      if (x.low <= zg && x.high >= zd) { end = j; }
      else break;
    }
    const seg = mv.slice(i, end + 1);
    if (gate === 'all') {
      zg = Math.min(...seg.map((x) => x.high));
      zd = Math.max(...seg.map((x) => x.low));
    }
    const gg = Math.max(...seg.map((x) => x.high));
    const dd = Math.min(...seg.map((x) => x.low));
    out.push({
      zg, zd, gg, dd,
      startMove: i, endMove: end,
      startIdx: seg[0].startIdx, endIdx: seg[seg.length - 1].endIdx,
      nMoves: end - i + 1,
      confirmedAt: seg[minN - 1].confirmedAt,        // 第 minN 段确认时中枢成立
      finalAt: null, final: false,
      gate,
    });
    i = end + 1;
  }
  for (let k = 0; k < out.length; k++) {
    // 中枢的「边界」在其离开段（下一段）确认前仍可能延伸
    out[k].finalAt = out[k + 1] ? out[k + 1].confirmedAt : null;
    out[k].final = out[k].finalAt != null;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 6. 走势类型（✅ 确定性，给定中枢序列）
// 盘整 = 只含 1 个中枢；趋势 = >= 2 个同向且不重叠的中枢（上涨/下跌）。
// ---------------------------------------------------------------------------
export function classifyTrend(centers) {
  const c = arr(centers);
  if (c.length === 0) return { type: 'range', dir: 0, nCenters: 0, label: '无中枢' };
  if (c.length === 1) return { type: 'range', dir: 0, nCenters: 1, label: '盘整（1 个中枢）' };
  let up = 0, down = 0;
  for (let i = 1; i < c.length; i++) {
    if (c[i].zd > c[i - 1].zg) up++;
    else if (c[i].zg < c[i - 1].zd) down++;
  }
  if (up > 0 && up >= down) return { type: 'up', dir: 1, nCenters: c.length, label: `上涨（${up} 段同向中枢）` };
  if (down > 0) return { type: 'down', dir: -1, nCenters: c.length, label: `下跌（${down} 段同向中枢）` };
  return { type: 'range', dir: 0, nCenters: c.length, label: `盘整（${c.length} 个重叠中枢）` };
}

// ---------------------------------------------------------------------------
// 7. 背驰（❌ 度量未固定：macd 面积 / slope）
// 判据：相邻同向笔中，后一笔创了新极值（更高高点 / 更低低点），但力度反而更小。
// ---------------------------------------------------------------------------
export function detectDivergence(closes, bis, opts = {}) {
  const c = arr(closes), b = arr(bis);
  const measure = opts.divMeasure || CHAN_DEFAULTS.divMeasure;
  const ratio = num(opts.divRatio) ? opts.divRatio : CHAN_DEFAULTS.divRatio;
  let hist = null;
  if (measure === 'macd') {
    const m = macd(c, opts.macdFast || CHAN_DEFAULTS.macdFast, opts.macdSlow || CHAN_DEFAULTS.macdSlow, opts.macdSignal || CHAN_DEFAULTS.macdSignal);
    hist = m.hist;
  }
  const power = (bi) => {
    const a = Math.min(bi.startIdx, bi.endIdx), z = Math.max(bi.startIdx, bi.endIdx);
    if (measure === 'slope') {
      const bars = Math.max(1, z - a + 1);
      return Math.abs((c[z] ?? 0) - (c[a] ?? 0)) / bars;
    }
    let s = 0;
    for (let i = a; i <= z; i++) {
      const v = hist ? hist[i] : null;
      if (!num(v)) continue;
      s += bi.dir === 'up' ? Math.max(0, v) : Math.max(0, -v);
    }
    return s;
  };
  const out = [];
  // 相邻「同向」笔才比较（笔序列方向交替，故同向笔在数组中相隔 2）
  const lastByDir = { up: -1, down: -1 };
  for (let i = 0; i < b.length; i++) {
    const cur = b[i];
    const pi = lastByDir[cur.dir];
    lastByDir[cur.dir] = i;
    if (pi < 0) continue;
    const prev = b[pi];
    const newExtreme = cur.dir === 'up' ? cur.high > prev.high : cur.low < prev.low;
    if (!newExtreme) continue;
    const p0 = power(prev), p1 = power(cur);
    if (!(p0 > 0) || !num(p1)) continue;
    if (p1 < p0 * ratio) {
      out.push({
        bi: i, prevBi: pi, dir: cur.dir, kind: cur.dir === 'up' ? 'top' : 'bottom',  // top 背驰=顶背驰
        prevPower: p0, power: p1, ratio: p1 / p0,
        measure, idx: cur.endIdx, price: cur.dir === 'up' ? cur.high : cur.low,
        confirmedAt: cur.confirmedAt, finalAt: cur.finalAt, final: cur.final,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 8. 三类买卖点（❌ 依赖上层；本实现为简化判据）
//   三买：向上离开中枢后，回抽不重新触及中枢（回抽笔低点 > ZG）
//   一买：下跌趋势中跌破最后中枢，且出现底背驰
//   二买：一买之后的回调不破一买低点
//   卖点 = 镜像
// 每个信号都给出：
//   naiveAt   = 信号自身所在 bar（事后标注口径 —— 市面回测常用）
//   finalAt   = 实盘可得时刻（相关笔/中枢都定稿之后）
// ---------------------------------------------------------------------------
export function detectBsp(bis, centers, divergences, opts = {}) {
  const b = arr(bis), zs = arr(centers), dv = arr(divergences);
  const out = [];
  const finalOf = (x) => (x ? x.finalAt : null);
  const maxN = (...xs) => {
    const v = xs.filter(num);
    return v.length ? Math.max(...v) : null;
  };

  // —— 三买 / 三卖：离开中枢 + 回抽不回中枢 ——
  // 原著口径：中枢结束后，**第一个向上离开中枢的笔**（up 且 high > ZG）之后的回抽笔，
  // 若其低点 > ZG → 三买（三卖镜像）。不能用「中枢后第一笔」代替（那一笔可能只是中枢内的震荡）。
  for (let zi = 0; zi < zs.length; zi++) {
    const z = zs[zi];
    const limit = Math.min(b.length - 1, zs[zi + 1] ? zs[zi + 1].startMove : b.length - 1);
    let exit = -1;
    for (let k = z.endMove + 1; k <= limit; k++) {
      const x = b[k];
      if ((x.dir === 'up' && x.high > z.zg) || (x.dir === 'down' && x.low < z.zd)) { exit = k; break; }
    }
    if (exit < 0) continue;
    const e = b[exit], p = b[exit + 1];
    if (!p) continue;
    if (e.dir === 'up' && e.high > z.zg && p.dir === 'down' && p.low > z.zg) {
      out.push(mkSig('3b', 'long', p.low, p.lowIdx, [z, e, p], null, exit + 1));
    }
    if (e.dir === 'down' && e.low < z.zd && p.dir === 'up' && p.high < z.zd) {
      out.push(mkSig('3s', 'short', p.high, p.highIdx, [z, e, p], null, exit + 1));
    }
  }

  // —— 一买 / 一卖：跌破最后中枢 + 背驰 ——
  for (const d of dv) {
    const cur = b[d.bi];
    if (!cur) continue;
    if (d.kind === 'bottom' && d.dir === 'down') {
      // 该笔低点需低于其之前最近中枢的 ZD
      const z = lastCenterBefore(zs, d.bi);
      if (z && cur.low < z.zd) out.push(mkSig('1b', 'long', cur.low, cur.lowIdx, [z, cur], d, d.bi));
    } else if (d.kind === 'top' && d.dir === 'up') {
      const z = lastCenterBefore(zs, d.bi);
      if (z && cur.high > z.zg) out.push(mkSig('1s', 'short', cur.high, cur.highIdx, [z, cur], d, d.bi));
    }
  }

  // —— 二买 / 二卖：一买后的回调不破前低 ——
  const ones = out.filter((s) => s.kind === '1b' || s.kind === '1s');
  for (const s of ones) {
    const j = s.biRef;
    const next = b[j + 2];                        // 一买后：+1 反弹、+2 回调
    if (!next) continue;
    if (s.kind === '1b' && next.dir === 'down' && next.low > s.price) {
      out.push(mkSig('2b', 'long', next.low, next.lowIdx, [next], null, j + 2));
    }
    if (s.kind === '1s' && next.dir === 'up' && next.high < s.price) {
      out.push(mkSig('2s', 'short', next.high, next.highIdx, [next], null, j + 2));
    }
  }

  // 去重 + 排序（同 kind 同 idx 只留一条）
  const seen = new Set();
  const uniq = [];
  for (const s of out.sort((a, c2) => a.idx - c2.idx)) {
    const key = `${s.kind}|${s.idx}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(s);
  }
  return uniq;

  function mkSig(kind, side, price, idx, refs, div, biRef) {
    const naiveAt = idx;                        // ① 模式所在的 bar（历史标注口径回测在此下单）
    const detectAt = maxN(...refs.map((r) => (r ? r.confirmedAt : null)));  // ② 朴素实时算法最早能看见它的时刻
    const finalAt = maxN(...refs.map(finalOf)); // ③ 不再可变的时刻（实盘可安心使用）
    return {
      kind, side, price, idx,
      biRef: num(biRef) ? biRef : -1,
      naiveAt, detectAt, finalAt,
      final: finalAt != null,
      div: div ? { measure: div.measure, ratio: div.ratio } : null,
      refs: refs.map((r) => ({ zg: r.zg ?? null, zd: r.zd ?? null, startIdx: r.startIdx ?? null, endIdx: r.endIdx ?? null })),
    };
  }
}

function lastCenterBefore(zs, biIdx) {
  let best = null;
  for (const z of zs) if (z.endMove < biIdx) best = z; else break;
  return best;
}

// ---------------------------------------------------------------------------
// 9. 总入口
// ---------------------------------------------------------------------------
export function buildChanlun(input, opts = {}) {
  const cfg = { ...CHAN_DEFAULTS, ...(opts || {}) };
  const bars = normalizeBars(input);
  const empty = {
    ok: false, cfg, bars,
    merged: [], fractals: [], bis: [], bisFinal: [], segs: [], centers: [], trend: { type: 'range', dir: 0, nCenters: 0, label: '无数据' },
    divergences: [], signals: [], signalsCausal: [], meta: { reason: 'insufficient' },
  };
  if (bars.n < 10) return empty;

  const merged = mergeInclusion(bars.h, bars.l);
  if (merged.length < 5) return { ...empty, merged };
  const fractals = detectFractals(merged);
  const bis = buildBi(fractals, merged, cfg);
  const bisFinal = bis.filter((x) => x.final);
  const segs = buildSegments(bis, cfg);
  const moves = cfg.useSegForZs ? segs : bis;
  const centers = detectCenters(moves, cfg);
  const trend = classifyTrend(centers);
  const divergences = detectDivergence(bars.c, bis, cfg);
  const signals = detectBsp(bis, centers, divergences, cfg);
  const signalsCausal = signals.filter((s) => s.final);

  return {
    ok: true, cfg, bars, merged, fractals, bis, bisFinal, segs, centers, trend, divergences,
    signals, signalsCausal,
    meta: {
      nBars: bars.n, nMerged: merged.length, nFractals: fractals.length,
      nBis: bis.length, nBisFinal: bisFinal.length, nSegs: segs.length, nCenters: centers.length,
      nSignals: signals.length, nSignalsCausal: signalsCausal.length,
      biMode: cfg.biMode, segMode: cfg.segMode, zsGate: cfg.zsGate, divMeasure: cfg.divMeasure,
    },
  };
}

// ---------------------------------------------------------------------------
// 10. 幻影信号率（本模块的核心研究工具）
//
// 三个时刻（见 detectBsp 的 mkSig）：
//   (1) naiveAt  = 模式所在的 bar     —— 「历史标注口径」回测在此下单（市面上大多数回测）
//   (2) detectAt = 朴素实时算法最早能看见它的时刻
//   (3) finalAt  = 结构不再可变的时刻 —— 实盘可安心使用
//
// 两种「未来函数」程度：
//   lagLabel  = finalAt - naiveAt   → 历史标注口径的虚高幅度（越大越不可信）
//   lagDetect = finalAt - detectAt  → 实时算法还需额外等多少（真正可交易口径的延迟）
//   phantomRate         = finalAt > naiveAt 的占比（在它标注的那天根本不可得）
//   realtimePhantomRate = finalAt > detectAt 的占比（即使实时检测也还要等）
//
// opts.sample > 0 时额外做「逐 bar 截断重算」交叉校验：对抽样信号用 sliceUpTo(detectAt)
// 重跑一次，检查该信号是否真的会出现（硬幻影 = 根本不出现）。
// ---------------------------------------------------------------------------
export function chanPhantomRate(input, opts = {}) {
  const res = buildChanlun(input, opts);
  if (!res.ok) return { ok: false, total: 0, phantom: 0, real: 0, phantomRate: 0, realtimePhantom: 0, realtimePhantomRate: 0, byKind: {}, lag: null, lagDetect: null, buckets: null, verified: null };
  const byKind = {};
  let phantom = 0, real = 0, rtPhantom = 0;
  const lagsLabel = [], lagsDetect = [];
  const buckets = { le2: 0, le5: 0, le10: 0, le20: 0, gt20: 0, unknown: 0 };
  for (const s of res.signals) {
    const k = byKind[s.kind] || (byKind[s.kind] = { total: 0, phantom: 0, realtimePhantom: 0 });
    k.total++;
    const hasFinal = num(s.finalAt);
    if (!hasFinal || s.finalAt > s.naiveAt) { phantom++; k.phantom++; } else { real++; }
    if (!hasFinal || (num(s.detectAt) && s.finalAt > s.detectAt)) { rtPhantom++; k.realtimePhantom++; }
    if (hasFinal) {
      lagsLabel.push(s.finalAt - s.naiveAt);
      if (num(s.detectAt)) lagsDetect.push(s.finalAt - s.detectAt);
      const d = s.finalAt - s.naiveAt;
      if (d <= 2) buckets.le2++; else if (d <= 5) buckets.le5++; else if (d <= 10) buckets.le10++;
      else if (d <= 20) buckets.le20++; else buckets.gt20++;
    } else buckets.unknown++;
  }
  const sortN = (a) => a.slice().sort((x, y) => x - y);
  const pct = (a) => (a.length ? { p50: a[Math.floor(a.length / 2)], p90: a[Math.floor(a.length * 0.9)], max: a[a.length - 1], mean: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) } : null);
  const total = res.signals.length;

  // 可选：逐 bar 截断交叉校验。两个口径：
  //   atDetect：在「朴素实时可检测」那一刻重算 → 信号是否真的存在（不存在 = 硬幻影/伪造）
  //   atNaive ：在「模式所在 bar」重算       → 历史标注口径回测是否在信号尚不可见时就下单
  let verified = null;
  const sampleN = num(opts.sample) ? opts.sample : 0;
  if (sampleN > 0 && total > 0) {
    const bars = normalizeBars(input);
    const step = Math.max(1, Math.floor(total / sampleN));
    const picked = res.signals.filter((_, i) => i % step === 0).slice(0, sampleN);
    const acc = { atDetect: { checked: 0, disappeared: 0 }, atNaive: { checked: 0, disappeared: 0 } };
    const probe = (s, t) => {
      if (!num(t) || t < 10) return null;
      const r2 = buildChanlun(sliceUpTo(bars, t), opts);
      return !r2.ok || !r2.signals.some((x) => x.kind === s.kind && x.idx === s.idx);
    };
    for (const s of picked) {
      const d = probe(s, num(s.detectAt) ? s.detectAt : s.naiveAt);
      if (d != null) { acc.atDetect.checked++; if (d) acc.atDetect.disappeared++; }
      const nv = probe(s, s.naiveAt);
      if (nv != null) { acc.atNaive.checked++; if (nv) acc.atNaive.disappeared++; }
    }
    const rate = (x) => (x.checked ? x.disappeared / x.checked : 0);
    verified = {
      atDetect: { ...acc.atDetect, disappearedRate: rate(acc.atDetect) },
      atNaive: { ...acc.atNaive, disappearedRate: rate(acc.atNaive) },
      // 兼容旧字段
      checked: acc.atDetect.checked,
      disappeared: acc.atDetect.disappeared,
      disappearedRate: rate(acc.atDetect),
    };
  }

  return {
    ok: true, total, phantom, real,
    phantomRate: total ? phantom / total : 0,
    realtimePhantom: rtPhantom,
    realtimePhantomRate: total ? rtPhantom / total : 0,
    byKind,
    lag: pct(sortN(lagsLabel)),
    lagDetect: pct(sortN(lagsDetect)),
    buckets,
    verified,
    meta: res.meta,
  };
}

// ---------------------------------------------------------------------------
// 11. 逐 bar 截断重算（交叉校验用：验证实现是否真的无前视）
// 对给定的一组 asOf 采样点，各跑一次 buildChanlun（只用 <= asOf 的 bar），
// 统计「在 asOf 当天能被确认」的信号集合，与全历史结果的 naiveAt/finalAt 对照。
// 返回每个采样点的 { asOf, nSignals, nCausal }。
// ---------------------------------------------------------------------------
export function chanCausalityProbe(input, asOfList, opts = {}) {
  const bars = normalizeBars(input);
  const out = [];
  for (const asOf of arr(asOfList)) {
    if (!num(asOf) || asOf < 10) continue;
    const sub = sliceUpTo(bars, asOf);
    const r = buildChanlun(sub, opts);
    out.push({ asOf, ok: r.ok, nSignals: r.signals.length, nCausal: r.signalsCausal.length });
  }
  return out;
}
