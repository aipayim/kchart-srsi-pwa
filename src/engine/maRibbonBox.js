// 多均线带 + 箱体（「截图风格」盯盘辅助层）—— 纯函数，零 DOM / 零网络 / 不读 window。
//
// 来源与定位（务必先读）：
//   用户 2026-09-23 提供 5 张 TradingView 截图（BTC 4h / BTC 1W / 布伦特 4h / SP500 4h / 手机 1h+4h），
//   要求「扒出信号识别方式，看能否用在 PWA 主图盯盘」。逐像素分析结论（见 notebook 页 tv-screenshot-signal-analysis）：
//     · 多条均线带（白/银/蓝/红/橙 5 条，饱和色实测 蓝#5566c0 / 红#c0626f / 橙#d37b4d）
//     · 金色实心圆点 = 信号标记（单色、无文字，高位低位都出现）
//     · 橙色边框半透明箱体 + 箱内下降虚线（判定为用户手绘）
//     · 用户自绘注解「突破」「回踩接货」→ 用法 = 突破后回踩均线接货
//     · 图例被折叠成「⌄ 4」徽章 → **原指标名称 / 参数 / 是否重绘（repaint）均无法从截图确定**
//
//   ⇒ 本模块是**行为级近似**，不是原指标复现。所有判定规则都是「把截图的可见行为翻译成可计算规则」，
//     并且**严格无前视**（见下）。
//
// ⚠️ 诚实红线（AGENTS §5.31 / §5.58）：
//   同族（均线回踩）在本项目已做过严格审计——**无统计优势**：
//   BTC 15m 因果修正后胜率 41.8%，随机同方向基线 44.7%（1h 43.6% / 4h 44.0%）。
//   ⇒ 本层只能当**盯盘辅助显示层**：默认关、零行为变化、UI 必须显著标注「未验证·仅结构描述」；
//     **不接自动交易、不配资金**。要接必须先过长窗正贡献 / 防爆 / regime 闸门 / 参数平台四关。
//
// 防前视约定：
//   · 均线值只用到 i 及之前的数据（SMA/EMA 天然因果）。
//   · 箱体 [i0,i1] 与上下沿只用 ≤ i1 的数据；突破与回踩信号只在其**之后**的 bar 上产生（j > i1）。
//   · 趋势回踩信号在每个 bar 上只用「该 bar 的 OHLC + 该 bar 的均线值」，天然因果。
//   · 每个信号都带 `visibleAt = i`（= 信号自身所在 bar），不提前、不回填。
//
// ⚠️ 重绘（repaint）声明（与「原指标是否重绘未知」并列的第二个诚实项）：
//   箱体每次调用都用最新 last 重选「够新且最长」的区间 → **跨调用会移动/消失**，突破点也可能被回填。
//   单次调用内部因果自洽（上下沿只由 [i0,i1] 决定），但历史标记会随新数据变化。
//   ⇒ 本层**只能当当前视图的结构描述**，禁止用于回测、因子消融或自动交易（否则必然被重绘污染）。

export const RB_DISCLAIMER = '行为级近似（原指标名/参数/是否重绘未知）· 同族审计无统计优势 · 仅盯盘辅助';
export const RB_NO_TRADE = '不接自动交易 · 不配资金（要接须先过四关：长窗正贡献/防爆/regime/参数平台）';

// 均线带预设（periods 顺序 = 由快到慢；颜色固定按 RB_MA_COLORS 依次取）
export const RB_MA_PRESETS = [
  { id: '10/20/50/100/200', label: '10/20/50/100/200（截图配色 5 条）', periods: [10, 20, 50, 100, 200] },
  { id: '5/10/20/60/120', label: '5/10/20/60/120（常用 5 条）', periods: [5, 10, 20, 60, 120] },
  { id: '9/21/50/150/200', label: '9/21/50/150/200（EMA 常用 5 条）', periods: [9, 21, 50, 150, 200] },
  { id: '20/60/120', label: '20/60/120（3 条）', periods: [20, 60, 120] },
];
// 截图实测配色（白 / 银灰 / 蓝 / 红 / 橙）
export const RB_MA_COLORS = ['#ffffff', '#b2b6be', '#5566c0', '#c0626f', '#d37b4d'];

export const RB_DEFAULTS = {
  maType: 'sma',                  // 'sma' | 'ema'
  periods: [10, 20, 50, 100, 200],
  lookback: 200,                  // 箱体搜索窗口（根）
  minBars: 20,                    // 箱体最少根数
  tolPct: 4.0,                    // 箱体高度上限（%）
  touchPct: 0.6,                  // 「触及均线」容差（% of price）
  pullbackMinPeriod: 50,          // 只有「回踩到 period ≥ 该值」的均线才算有效回踩（MA10/MA20 贴着价格，不算回踩）
  minDepthAtr: 1.0,               // 回撤深度下限（×ATR）：从近 swing 根的极值回撤，滤掉贴着均线磨的小波动
  swing: 20,                      // 回撤深度参考窗口（根）
  cool: 20,                       // 同向信号冷却（根）
  preBars: 4,                     // 「真回踩」要求：回踩前至少 N 根收在均线同侧
  boxSlack: 15,                   // 箱体「够新」判定的宽松度（根）
  maxAge: null,                   // 箱体「活跃末端」距最新不得超过的根数（null = max(30, lookback*0.4)）
  breakoutBonus: 50,              // 评分加成：有突破的箱体优先（避免把「突破后的行情」当箱体、吞掉突破）
  maxSignals: 24,                 // 最多画/记录多少个信号
  trendPullback: true,            // 是否启用「趋势内均线回踩」
  atrStopMult: 0.5,               // 止损：回踩极值 ∓ 该倍数 × ATR
};

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const toNums = (v) => arr(v).map(Number);

function fmtPrice(v) {
  if (!num(v)) return '--';
  const a = Math.abs(v);
  if (a >= 10000) return v.toFixed(0);
  if (a >= 100) return v.toFixed(2);
  if (a >= 1) return v.toFixed(3);
  return v.toFixed(5);
}
function fmtPct(v) { return num(v) ? (v >= 0 ? '+' : '') + v.toFixed(2) + '%' : '--'; }
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

// ---------------------------------------------------------------------------
// 1. 均线带
// ---------------------------------------------------------------------------
export function maRibbon(closes, periods, opts = {}) {
  const c = toNums(closes);
  const type = String(opts.type || '').toLowerCase() === 'ema' ? 'ema' : 'sma';
  const list = arr(periods).length ? arr(periods) : RB_DEFAULTS.periods;
  const out = [];
  list.forEach((raw, k) => {
    const p = Math.max(1, Math.round(num(raw) ? raw : 20));
    const values = new Array(c.length).fill(null);
    if (c.length >= p) {
      if (type === 'ema') {
        let sum = 0;
        for (let i = 0; i < p; i++) sum += c[i];
        let prev = sum / p;
        values[p - 1] = prev;
        const kk = 2 / (p + 1);
        for (let i = p; i < c.length; i++) { prev = c[i] * kk + prev * (1 - kk); values[i] = prev; }
      } else {
        let sum = 0;
        for (let i = 0; i < c.length; i++) {
          sum += c[i];
          if (i >= p) sum -= c[i - p];
          if (i >= p - 1) values[i] = sum / p;
        }
      }
    }
    out.push({
      period: p, type, label: (type === 'ema' ? 'EMA' : 'MA') + p,
      color: arr(opts.colors).length ? opts.colors[k % opts.colors.length] : RB_MA_COLORS[k % RB_MA_COLORS.length],
      width: num(arr(opts.widths)[k]) ? opts.widths[k] : (k === 0 ? 1.2 : 1.4),
      values,
    });
  });
  return out;
}

// 均线带在某根 bar 的排列（多头/空头/纠缠）+ 人类可读顺序串
export function ribbonOrder(ribbon, i) {
  const rows = arr(ribbon).map((m) => ({ label: m.label, period: m.period, v: m.values && num(m.values[i]) ? m.values[i] : null }));
  const known = rows.filter((r) => num(r.v));
  if (known.length < 2) return { dir: 0, text: '数据不足', rows, asc: [], desc: [] };
  // 由快到慢（period 升序）逐个比较：快 > 慢 = 多头排列
  const fastToSlow = rows.slice().sort((a, b) => a.period - b.period);
  let ups = 0, downs = 0;
  for (let k = 0; k + 1 < fastToSlow.length; k++) {
    const a = fastToSlow[k], b = fastToSlow[k + 1];
    if (!num(a.v) || !num(b.v)) continue;
    if (a.v > b.v) ups++; else if (a.v < b.v) downs++;
  }
  const dir = ups > downs ? 1 : (downs > ups ? -1 : 0);
  const seq = fastToSlow.filter((r) => num(r.v)).map((r) => r.label).join(' > ');
  const text = dir > 0 ? ('多头排列（快>慢：' + seq + '）') : dir < 0 ? ('空头排列（快<慢：' + seq + '）') : '纠缠（无一致排列）';
  return { dir, text, rows, asc: ups, desc: downs };
}

// ---------------------------------------------------------------------------
// 2. 箱体（区间）检测 —— 只用 ≤ last 的数据（last = 当前最新 bar，天然因果）
//    对每个右端 e 向前扩展到高度超限为止，收集候选；优先「够新」的候选里最长的那个。
// ---------------------------------------------------------------------------
export function rangeBox(inp = {}, opts = {}) {
  const o = { ...RB_DEFAULTS, ...opts };
  const H = toNums(inp.highs), L = toNums(inp.lows), C = toNums(inp.closes);
  const n = Math.min(H.length, L.length, C.length);
  if (n < o.minBars + 2) return { ok: false, reason: '数据不足' };
  const last = n - 1;
  const from = Math.max(0, n - Math.max(o.minBars + 1, Math.round(o.lookback)));
  const cands = [];
  for (let e = from + o.minBars - 1; e <= last; e++) {
    let hi = -Infinity, lo = Infinity;
    for (let s = e; s >= from; s--) {
      hi = Math.max(hi, H[s]); lo = Math.min(lo, L[s]);
      const bars = e - s + 1;
      if (bars < o.minBars) continue;
      const hPct = lo > 0 ? ((hi - lo) / lo) * 100 : Infinity;
      if (hPct > o.tolPct) break;         // 再往前只会更高，剪枝
      cands.push({ i0: s, i1: e, top: hi, bottom: lo, bars, heightPct: hPct });
    }
  }
  if (!cands.length) return { ok: false, reason: '未找到高度 ≤ ' + o.tolPct + '% 的区间（可能正在趋势中）' };
  const span0 = (c) => Math.max(1e-9, c.top - c.bottom);
  const maxAge = Math.max(20, Math.round(num(o.maxAge) ? o.maxAge : Math.max(30, o.lookback * 0.4)));
  // 候选评分：长度 + 有突破的加成（长度主导）；并过滤「活跃末端太久远」的箱体
  // activeEnd = 突破根（若有）否则 i1；评分相同时取 activeEnd 更大（更贴近当前）者
  let best = null, bestScore = -Infinity;
  for (const c of cands) {
    let brk = null;
    const lim = Math.min(last, c.i1 + maxAge + 1);   // 突破只可能在 maxAge 内才有意义（剪枝，防 O(n²)）
    for (let i = c.i1 + 1; i <= lim; i++) {
      if (C[i] > c.top) { brk = { i, dir: 'up', price: C[i], level: c.top }; break; }
      if (C[i] < c.bottom) { brk = { i, dir: 'down', price: C[i], level: c.bottom }; break; }
    }
    const activeEnd = brk ? brk.i : c.i1;
    if (last - activeEnd > maxAge) continue;
    const score = c.bars + (brk ? (num(o.breakoutBonus) ? o.breakoutBonus : 50) : 0);
    if (score > bestScore || (score === bestScore && best && activeEnd > best.activeEnd)) {
      bestScore = score;
      best = { ...c, brk, activeEnd };
    }
  }
  if (!best) return { ok: false, reason: '未找到与当前价格相关的箱体（最近 ' + maxAge + ' 根内无高度 ≤ ' + o.tolPct + '% 的区间）' };
  const span = span0(best);
  let tTop = 0, tBot = 0;
  for (let i = best.i0; i <= best.i1; i++) {
    if (H[i] >= best.top - 0.15 * span) tTop++;
    if (L[i] <= best.bottom + 0.15 * span) tBot++;
  }
  // 突破：候选评分时已算出（best.brk）
  const breakout = best.brk || null;
  const px = C[last];
  let state = 'inside';
  if (breakout) state = breakout.dir === 'up' ? 'breakout-up' : 'breakout-down';
  else if (px > best.top) state = 'above';
  else if (px < best.bottom) state = 'below';
  const posPct = ((px - best.bottom) / span) * 100;
  return {
    ok: true,
    i0: best.i0, i1: best.i1, bars: best.bars,
    top: best.top, bottom: best.bottom, mid: (best.top + best.bottom) / 2,
    heightPct: best.heightPct, tTop, tBot, touched: tTop >= 2 && tBot >= 2,
    state, posPct, breakout,
    boxEndIdx: breakout ? breakout.i : last,   // 画箱体时延伸到突破根（视觉上与截图一致）
  };
}

// ---------------------------------------------------------------------------
// 3. 回踩信号
//    A) 箱体突破回踩：突破根之后，价格回踩到带内某条均线并「收盘站回该均线之上」
//    B) 趋势内均线回踩：均线多头/空头排列时，回踩到带内均线后收盘站回（同向冷却）
//    A 的箱体上下沿只用到 ≤ i1 的数据；B 完全逐 bar 因果。
// ---------------------------------------------------------------------------
export function pullbackSignals(inp = {}, opts = {}) {
  const o = { ...RB_DEFAULTS, ...opts };
  const H = toNums(inp.highs), L = toNums(inp.lows), C = toNums(inp.closes);
  const ATR = toNums(inp.atr);
  const ribbon = arr(inp.ribbon);
  const box = inp.box || { ok: false };
  const n = Math.min(H.length, L.length, C.length);
  const signals = [];
  if (n < 30 || !ribbon.length) return { signals, dots: [] };
  const last = n - 1;
  const touch = Math.max(0.05, o.touchPct) / 100;
  const atrAt = (i) => (num(ATR[i]) && ATR[i] > 0 ? ATR[i] : null);

  // 某根 bar 上「被触及」的均线（由快到慢，取最接近低点/高点的那条）
  const minP = Math.max(1, Math.round(num(o.pullbackMinPeriod) ? o.pullbackMinPeriod : 50));
  const touchedMa = (i, side) => {
    let hit = null;
    for (const m of ribbon) {
      if (m.period < minP) continue;      // 快线不算「回踩」（它永远贴着价格）
      const v = m.values && m.values[i];
      if (!num(v) || v <= 0) continue;
      if (side === 'long') {
        if (L[i] <= v * (1 + touch) && L[i] >= v * (1 - touch * 3)) {
          const d = Math.abs(L[i] - v) / v;
          if (!hit || d < hit.d) hit = { m, v, d };
        }
      } else {
        if (H[i] >= v * (1 - touch) && H[i] <= v * (1 + touch * 3)) {
          const d = Math.abs(H[i] - v) / v;
          if (!hit || d < hit.d) hit = { m, v, d };
        }
      }
    }
    return hit;
  };

  // 确认：收盘站回均线另一侧（多：close > ma；空：close < ma）且相对前一根有反转
  const confirmed = (i, side, v) => {
    if (i < 1) return false;
    const c = C[i], pc = C[i - 1];
    if (!num(c) || !num(pc)) return false;
    if (side === 'long') return c > v && c > pc;
    return c < v && c < pc;
  };

  // 回撤深度：从近 swing 根的极值回撤 ≥ minDepthAtr × ATR 才算「真回踩」
  const depthOk = (i, side) => {
    let ref = side === 'long' ? -Infinity : Infinity;
    for (let j = Math.max(0, i - Math.max(1, Math.round(o.swing))); j < i; j++) {
      if (side === 'long') ref = Math.max(ref, H[j]); else ref = Math.min(ref, L[j]);
    }
    if (!num(ref)) return false;
    const depth = side === 'long' ? (ref - L[i]) : (H[i] - ref);
    const a = atrAt(i);
    const need = num(a) ? a * o.minDepthAtr : ref * 0.01;
    return depth >= need;
  };

  const push = (i, side, type, ma, maV, extra = {}) => {
    const entry = C[i];
    if (!num(entry)) return;
    const a = atrAt(i);
    const buf = (num(a) ? a * o.atrStopMult : entry * 0.004);
    const extreme = side === 'long' ? L[i] : H[i];
    // 硬不变量：多头 stop 必须 < 入场价、空头 stop 必须 > 入场价（「待确认」信号的收盘可能已在均线反向侧，
    // 若只用影线极值算 stop 会出现「防守位在入场价之上」的荒谬结构 → 与入场价取更保守者）
    const stop = side === 'long'
      ? Math.min(num(extreme) ? extreme : entry, entry) - buf
      : Math.max(num(extreme) ? extreme : entry, entry) + buf;
    const r = Math.abs(entry - stop);
    const dir = side === 'long' ? 1 : -1;
    const sig = {
      i, visibleAt: i, side, type,
      maLabel: ma ? ma.label : '--', maPeriod: ma ? ma.period : null, maValue: maV,
      price: entry, stop, r,
      t1: entry + dir * r, t2: entry + dir * r * 2,
      atr: a, ...extra,
    };
    // 失效：信号之后第一根「收盘」跌破/涨破防守位
    let invalidIdx = null;
    for (let j = i + 1; j <= last; j++) {
      if (side === 'long' ? C[j] < stop : C[j] > stop) { invalidIdx = j; break; }
    }
    sig.invalidIdx = invalidIdx;
    signals.push(sig);
  };

  // A) 箱体突破回踩（只处理当前这个箱体，且只在突破之后找）
  if (box && box.ok && box.breakout) {
    const bd = box.breakout;
    const side = bd.dir === 'up' ? 'long' : 'short';
    let touchIdx = null, touchInfo = null;
    for (let i = bd.i + 1; i <= last; i++) {
      const hit = touchedMa(i, side);
      if (hit) { touchIdx = i; touchInfo = hit; break; }
    }
    if (touchIdx != null) {
      let sigIdx = null;
      for (let i = touchIdx; i <= last; i++) {
        const v = touchInfo.v;
        if (confirmed(i, side, v)) { sigIdx = i; break; }
        // 价格已经远离均线（>2×容差）→ 放弃这次回踩
        const away = side === 'long' ? (C[i] - v) / v : (v - C[i]) / v;
        if (away > touch * 2) break;
      }
      const i = sigIdx != null ? sigIdx : touchIdx;
      push(i, side, sigIdx != null ? '箱体突破回踩' : '箱体突破回踩(待确认)', touchInfo.m, touchInfo.v,
        { boxed: true, boxTop: box.top, boxBottom: box.bottom, breakoutIdx: bd.i });
    }
  }

  // B) 趋势内均线回踩（同向冷却；无箱体也生效）
  if (o.trendPullback) {
    let lastLong = -Infinity, lastShort = -Infinity;
    for (let i = 1; i <= last; i++) {
      const ord = ribbonOrder(ribbon, i);
      if (ord.dir === 0) continue;
      const side = ord.dir > 0 ? 'long' : 'short';
      if (i - (side === 'long' ? lastLong : lastShort) < o.cool) continue;
      const hit = touchedMa(i, side);
      if (!hit) continue;
      if (!depthOk(i, side)) continue;
      // 要求回踩前至少 preBars 根在均线同侧（真回踩，而非贴着均线磨）
      let ok = true;
      for (let k = 1; k <= Math.max(1, Math.round(o.preBars)); k++) {
        const j = i - k;
        if (j < 0) { ok = false; break; }
        if (side === 'long' ? !(C[j] > hit.v) : !(C[j] < hit.v)) { ok = false; break; }
      }
      if (!ok) continue;
      if (!confirmed(i, side, hit.v)) continue;
      if (side === 'long') lastLong = i; else lastShort = i;
      push(i, side, '趋势回踩', hit.m, hit.v, { boxed: false });
    }
  }

  signals.sort((a, b) => a.i - b.i);
  const capped = signals.length > o.maxSignals ? signals.slice(-o.maxSignals) : signals;

  // 金色圆点 = 突破点 + 回踩信号（与截图一致：单色金点，方向由「画在 K 线上方/下方」区分）
  const dots = [];
  if (box && box.ok && box.breakout) {
    const bd = box.breakout;
    dots.push({ i: bd.i, side: bd.dir === 'up' ? 'long' : 'short', kind: 'breakout', label: bd.dir === 'up' ? '箱体上破' : '箱体下破', price: bd.price });
  }
  for (const s of capped) {
    if (String(s.type).indexOf('待确认') >= 0) continue;
    dots.push({ i: s.i, side: s.side, kind: 'pullback', label: s.type + '·' + s.maLabel, price: s.price });
  }
  dots.sort((a, b) => a.i - b.i);
  return { signals: capped, dots };
}

// ---------------------------------------------------------------------------
// 4. 总入口
// ---------------------------------------------------------------------------
export function buildMaRibbonBox(inp = {}, opts = {}) {
  const o = { ...RB_DEFAULTS, ...opts };
  const C = toNums(inp.closes);
  const base = {
    ok: false, n: 0, last: -1, close: null, ribbon: [], box: { ok: false }, signals: [], dots: [],
    order: { dir: 0, text: '数据不足' }, dist: [], info: null, opts: o,
  };
  if (C.length < 30) return base;
  const ribbon = maRibbon(C, o.periods, { type: o.maType });
  const maTypeNorm = String(o.maType || '').toLowerCase() === 'ema' ? 'ema' : 'sma';
  const box = rangeBox({ highs: inp.highs, lows: inp.lows, closes: inp.closes }, o);
  const { signals, dots } = pullbackSignals({ ...inp, ribbon, box }, o);
  const last = C.length - 1;
  const px = C[last];
  const order = ribbonOrder(ribbon, last);
  const dist = ribbon.map((m) => {
    const v = m.values && m.values[last];
    return { label: m.label, period: m.period, color: m.color, value: num(v) ? v : null, pct: (num(v) && v > 0) ? ((px - v) / v) * 100 : null };
  });
  return {
    ok: true, n: C.length, last, close: px,
    ribbon, box, signals, dots, order, dist,
    info: {
      maType: maTypeNorm, periods: ribbon.map((m) => m.period),
      boxState: box.ok ? box.state : 'none',
      nDots: dots.length,
      nSignals: signals.length,
    },
    opts: o,
  };
}

// ---------------------------------------------------------------------------
// 5. 解读面板模型（供共享 HTML 构建器渲染，字段与 chanlunReadout 对齐）
// ---------------------------------------------------------------------------
export function maRibbonBoxReadout(model, opts = {}) {
  const o = { livePrice: null, showInfo: true, ...opts };
  const rows = [];
  const base = { ok: false, tone: 'none', verdict: '数据不足（需要更多 K 线）', rows, disclaimer: RB_DISCLAIMER, noTrade: RB_NO_TRADE, info: null };
  if (!model || !model.ok) return base;
  const px = num(o.livePrice) ? o.livePrice : model.close;
  const last = model.last;
  const ribbon = arr(model.ribbon), box = model.box || { ok: false };
  const tone = model.order.dir > 0 ? 'bull' : (model.order.dir < 0 ? 'bear' : 'range');

  // 1) 均线带排列
  rows.push({
    icon: model.order.dir > 0 ? '▲' : model.order.dir < 0 ? '▼' : '◆',
    color: model.order.dir > 0 ? '#2ecc71' : model.order.dir < 0 ? '#ff6b6b' : '#f59e0b',
    label: '均线带 · ' + (model.order.dir > 0 ? '多头排列' : model.order.dir < 0 ? '空头排列' : '纠缠'),
    detail: model.order.text + '（' + (model.info ? model.info.maType.toUpperCase() : 'SMA') + ' ' + (model.info ? model.info.periods.join('/') : '') + '）',
  });

  // 2) 价格 vs 均线（最近一条 + 最慢一条）
  const known = arr(model.dist).filter((d) => num(d.pct));
  if (known.length) {
    const nearest = known.reduce((a, b) => (Math.abs(b.pct) < Math.abs(a.pct) ? b : a));
    const slowest = known[known.length - 1];
    const above = known.filter((d) => d.pct > 0).length;
    rows.push({
      icon: '📏', color: above >= known.length / 2 ? '#2ecc71' : '#ff6b6b',
      label: '价格 vs 均线 · 在 ' + above + '/' + known.length + ' 条之上',
      detail: '最近 ' + nearest.label + ' ' + fmtPct(nearest.pct) + ' · 最慢 ' + slowest.label + ' ' + fmtPct(slowest.pct),
    });
  }

  // 3) 箱体
  if (box.ok) {
    const stMap = {
      'breakout-up': { t: '已上破（等回踩）', c: '#2ecc71' },
      'breakout-down': { t: '已下破（等反抽）', c: '#ff6b6b' },
      inside: { t: '箱体内震荡', c: '#f59e0b' },
      above: { t: '箱体上方（已离开）', c: '#2ecc71' },
      below: { t: '箱体下方（已离开）', c: '#ff6b6b' },
    };
    const st = stMap[box.state] || { t: box.state, c: '#8b95a5' };
    rows.push({
      icon: '▭', color: st.c,
      label: '箱体 · ' + st.t,
      detail: '上沿 ' + fmtPrice(box.top) + ' / 下沿 ' + fmtPrice(box.bottom) + ' · 高 ' + box.heightPct.toFixed(2) + '% · ' +
        box.bars + ' 根 · 位置 ' + clamp(box.posPct, -999, 999).toFixed(0) + '%（0=下沿 100=上沿）' +
        (box.breakout ? ' · 突破于第 ' + box.breakout.i + ' 根' : '') +
        (box.touched ? '' : ' · ⚠ 上下沿触及不足（区间特征弱）'),
    });
  } else {
    rows.push({ icon: '▭', color: '#8b95a5', label: '箱体 · 未检出', detail: box.reason || '当前无高度达标的横盘区间（趋势中或数据不足）' });
  }

  // 4) 最近信号
  const sigs = arr(model.signals);
  const sig = sigs.length ? sigs[sigs.length - 1] : null;
  if (sig) {
    const long = sig.side === 'long';
    const pend = String(sig.type).indexOf('待确认') >= 0;
    rows.push({
      icon: long ? '↗' : '↘', color: pend ? '#8b95a5' : (long ? '#2ecc71' : '#ff6b6b'),
      label: '最近信号 · ' + sig.type + ' · ' + (long ? '看多' : '看空') + (sig.invalidIdx != null ? '（已失效）' : ''),
      detail: '第 ' + sig.i + ' 根 @ ' + fmtPrice(sig.price) + ' · 回踩 ' + sig.maLabel + ' ' + fmtPrice(sig.maValue) +
        ' · 防守 ' + fmtPrice(sig.stop) + ' · 1R/2R ' + fmtPrice(sig.t1) + '/' + fmtPrice(sig.t2),
    });
  } else {
    rows.push({ icon: '◇', color: '#8b95a5', label: '信号 · 无', detail: '未出现「突破后回踩均线」或「趋势内均线回踩」的确认 bar' });
  }

  // 5) 金点统计
  const dots = arr(model.dots);
  const longs = dots.filter((d) => d.side === 'long').length;
  rows.push({
    icon: '●', color: '#f0b90b',
    label: '金点（该动手标记）· 共 ' + dots.length + ' 个',
    detail: '看多 ' + longs + ' · 看空 ' + (dots.length - longs) + '（画在 K 线下方=看多 / 上方=看空，与截图同款单色金点）',
  });

  // 6) 诚实声明
  rows.push({ icon: '⚠', color: '#ffd740', label: '未验证 · 仅结构描述', detail: RB_DISCLAIMER + '｜' + RB_NO_TRADE });

  const parts = [];
  parts.push(model.order.dir > 0 ? '均线偏多' : model.order.dir < 0 ? '均线偏空' : '均线纠缠');
  if (box.ok) parts.push('箱体' + (box.state === 'inside' ? '内' : box.state === 'breakout-up' ? '上破' : box.state === 'breakout-down' ? '下破' : box.state === 'above' ? '上方' : '下方'));
  if (sig) parts.push('最近' + sig.type + (sig.invalidIdx != null ? '（失效）' : ''));
  const verdict = '结构：' + parts.join(' · ') + '（行为级近似，非交易信号）';

  return {
    ok: true, tone, verdict, rows,
    disclaimer: RB_DISCLAIMER, noTrade: RB_NO_TRADE,
    price: px,
    info: { ...(model.info || {}), px, order: model.order, box: box.ok ? { top: box.top, bottom: box.bottom, state: box.state, posPct: box.posPct } : null },
  };
}
