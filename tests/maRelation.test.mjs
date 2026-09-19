// 价格与均线关系引擎单元测试（Node 原生，无框架）
// 覆盖：maSeries(SMA/EMA) / vwapSeries / maDistPct / alignClosedIdx(防前视) /
//       squeezeAt / maMarketState(三态) / buildMaRelation 的 L1/L1'/L2/L3 触发与不触发、
//       冷却、stop、r、invalidIdx、allowShort、数据不足与脏输入不抛。
import {
  MA_REL_DEFAULTS, maSeries, vwapSeries, maDistPct, alignClosedIdx,
  squeezeAt, maMarketState, buildMaRelation, maRelReadout,
  standProgress, squeezeBreakout, signalForwardStats,
} from '../src/engine/maRelation.js';

let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log('ok:', name); } else { failed++; console.log('FAIL:', name); } }
const near = (a, b, eps = 1e-6) => typeof a === 'number' && Math.abs(a - b) < eps;

// ---------- 测试用序列构造 ----------
function seq(from, to, step = 1) { const a = []; for (let v = from; step > 0 ? v <= to : v >= to; v += step) a.push(v); return a; }

// L1 回踩站稳（多）：上升趋势中的一次回踩，随后收盘站回 MA 上方且 MA 抬头
const L1_CLOSES = [
  100, 101, 102, 103, 104, 105, 106, 107, 108, 109,
  110, 111, 112, 108, 107, 109, 112, 113, 114, 115,
  116, 117, 118, 119, 120, 105, 121, 122, 123, 124,
  125, 126, 127, 128, 129, 130, 131, 132, 133, 134,
];
const L1_LOWS = L1_CLOSES.map(v => v - 0.5);
const L1_HIGHS = L1_CLOSES.map(v => v + 0.5);
const L1_ATR = new Array(L1_CLOSES.length).fill(1);
const L1_DAILY = seq(100, 139);            // 上升日线 → BULL
const L1_OPTS = { type: 'sma', fast: 3, mid: 5, slow: 8, swing: 2, cool: 1 };

// L2 密集后向上打开（多）：长期走平（均线挤压）后一根大阳线
const L2_CLOSES = new Array(31).fill(100); L2_CLOSES[30] = 103;
const L2_OPENS = new Array(31).fill(100);
const L2_LOWS = L2_CLOSES.map(v => v + 0.5); L2_LOWS[30] = 102.5;
const L2_HIGHS = L2_CLOSES.map(v => v + 0.5);
const L2_ATR = new Array(31).fill(null); L2_ATR[30] = 1;
const L2_DAILY = seq(100, 130);

// L3 4H MA20 突破（多）：4H 均线走平后收盘上穿
const L3_CLOSES = new Array(40).fill(100); for (let i = 30; i < 40; i++) L3_CLOSES[i] = 105;
const L3_LOWS = L3_CLOSES.map(v => v - 0.5);
const L3_HIGHS = L3_CLOSES.map(v => v + 0.5);
const L3_ATR = new Array(40).fill(1);
const L3_4H = new Array(40).fill(100); for (let i = 30; i < 40; i++) L3_4H[i] = 110;
const L3_DAILY = seq(100, 139);
const L3_OPTS = { type: 'sma', fast: 20, mid: 60, slow: 120, swing: 2, cool: 0 };

// L1' 反弹受阻（空）：下跌趋势中的一次反弹，随后收盘跌回 MA 下方且 MA 下行
const S_CLOSES = [200, 199, 198, 197, 196, 195, 194, 193, 192, 191,
  190, 189, 188, 192, 193, 191, 188, 187, 186, 185,
  184, 183, 182, 181, 180, 170, 181, 182, 183, 184,
  185, 186, 187, 188, 189, 190, 191, 192, 193, 194];
const S_LOWS = S_CLOSES.map(v => v - 0.5);
const S_HIGHS = S_CLOSES.map(v => v + 0.5);
const S_ATR = new Array(S_CLOSES.length).fill(1);
const S_DAILY = seq(200, 161, -1);         // 下跌日线 → BEAR
const S_OPTS = { type: 'sma', fast: 3, mid: 5, slow: 8, swing: 2, cool: 1 };

// L2' 密集后向下打开（空）
const L2S_CLOSES = new Array(31).fill(100); L2S_CLOSES[30] = 97;
const L2S_OPENS = new Array(31).fill(100);
const L2S_LOWS = L2S_CLOSES.map(v => v - 0.5); L2S_LOWS[30] = 96.5;
const L2S_HIGHS = L2S_CLOSES.map(v => v + 0.5);
const L2S_ATR = new Array(31).fill(null); L2S_ATR[30] = 1;

// L3' 4H 跌破（空）
const L3S_CLOSES = new Array(40).fill(100); for (let i = 30; i < 40; i++) L3S_CLOSES[i] = 95;
const L3S_LOWS = L3S_CLOSES.map(v => v - 0.5);
const L3S_HIGHS = L3S_CLOSES.map(v => v + 0.5);
const L3S_ATR = new Array(40).fill(1);
const L3S_4H = new Array(40).fill(100); for (let i = 30; i < 40; i++) L3S_4H[i] = 90;

console.log('\n[maRelation: 基础均线]');
{
  ok('DEFAULTS 关键字段', MA_REL_DEFAULTS.type === 'sma' && MA_REL_DEFAULTS.fast === 20 && MA_REL_DEFAULTS.allowShort === true && MA_REL_DEFAULTS.l3 === true);

  const s = maSeries([1, 2, 3, 4, 5], 3, 'sma');
  ok('SMA 等长', s.length === 5);
  ok('SMA 前导 null', s[0] === null && s[1] === null);
  ok('SMA 数值正确', s[2] === 2 && s[3] === 3 && s[4] === 4);

  const e = maSeries([1, 2, 4, 8], 2, 'ema');
  ok('EMA 前导 null', e[0] === null);
  ok('EMA 种子=SMA', e[1] === 1.5);
  ok('EMA 递推正确', near(e[2], 4 * 2 / 3 + 1.5 / 3) && near(e[3], 8 * 2 / 3 + (4 * 2 / 3 + 1.5 / 3) / 3));

  ok('均线不足周期全 null', maSeries([1, 2], 5, 'sma').every(v => v === null));
  ok('maSeries 空数组', maSeries([], 3, 'sma').length === 0);
  ok('maSeries null 输入不抛', maSeries(null, 3, 'sma').length === 0 && maSeries(undefined, 3, 'ema').length === 0);
  ok('maSeries 脏值不抛', maSeries([1, NaN, 3, Infinity], 2, 'sma').every(v => v === null || typeof v === 'number'));

  ok('maDistPct 正乖离', near(maDistPct(110, 100), 10));
  ok('maDistPct 负乖离', near(maDistPct(90, 100), -10));
  ok('maDistPct 无效输入 null', maDistPct(null, 100) === null && maDistPct(100, null) === null && maDistPct(100, 0) === null);
}

console.log('\n[maRelation: VWAP]');
{
  const v1 = vwapSeries([2, 2], [0, 0], [1, 1], [1, 1]);
  ok('VWAP 典型价', near(v1[0], 1) && near(v1[1], 1));
  const v2 = vwapSeries([2, 2], [0, 0], [1, 1], [1, 0]);
  ok('VWAP 无量沿用上一值', near(v2[1], 1));
  const v3 = vwapSeries([2, 2], [0, 0], [1, 1], [0, 1]);
  ok('VWAP 首值 null', v3[0] === null && near(v3[1], 1));
  const v4 = vwapSeries(null, null, [1, 2], [1, 1]);
  ok('VWAP 缺高低回退收盘价', near(v4[1], 1.5));
  ok('VWAP 空输入不抛', vwapSeries([], [], [], []).length === 0);
}

console.log('\n[maRelation: 防前视对齐]');
{
  const idx = alignClosedIdx([1, 5, 10], [0, 1, 4, 5, 9, 10, 11]);
  ok('alignClosedIdx 基本语义', JSON.stringify(idx) === JSON.stringify([-1, 0, 0, 1, 1, 2, 2]));
  ok('alignClosedIdx 早于 T[0] → -1', alignClosedIdx([1, 5], [0])[0] === -1);
  ok('alignClosedIdx 空 T → 全 -1', alignClosedIdx([], [1, 2]).every(v => v === -1));
  ok('alignClosedIdx 空 t → 空', alignClosedIdx([1, 2], []).length === 0);
  ok('alignClosedIdx null 不抛', alignClosedIdx(null, null).length === 0);
  ok('alignClosedIdx 非数字 t → -1', alignClosedIdx([1, 2], [null])[0] === -1);
  // 防前视：t 恰等于更高周期 bar 时间，取该 bar（已收盘）
  ok('alignClosedIdx 等值取当根', alignClosedIdx([100, 200], [200])[0] === 1);
}

console.log('\n[maRelation: 均线密集]');
{
  const flat = new Array(30).fill(100);
  const sq = squeezeAt(flat, 29, { fast: 3, mid: 5, slow: 8 });
  ok('走平均线 → 挤压', sq.squeezed === true && near(sq.spreadPct, 0));
  ok('squeeze vals 三条', Array.isArray(sq.vals) && sq.vals.length === 3);
  const div = seq(1, 40);
  const sq2 = squeezeAt(div, 39, { fast: 3, mid: 5, slow: 8 });
  ok('发散均线 → 不挤压', sq2.squeezed === false && sq2.spreadPct > 1.2);
  const sq3 = squeezeAt([1, 2], 1, { fast: 3, mid: 5, slow: 8 });
  ok('数据不足 → spreadPct null', sq3.spreadPct === null && sq3.squeezed === false);
  const sq4 = squeezeAt(flat, 99, { fast: 3, mid: 5, slow: 8 });
  ok('越界索引 → null', sq4.spreadPct === null);
  ok('squeezeAt null 不抛', squeezeAt(null, 0).spreadPct === null);
}

console.log('\n[maRelation: 市场状态机]');
{
  const bull = maMarketState(seq(100, 139), {});
  ok('BULL 判定', bull.state === 'BULL' && bull.aboveFast === true && bull.slopePct >= 0);
  ok('BULL 收盘价与均线有值', typeof bull.close === 'number' && typeof bull.maFast === 'number');
  const bear = maMarketState(seq(200, 161, -1), {});
  ok('BEAR 判定', bear.state === 'BEAR' && bear.aboveFast === false && bear.slopePct < 0);
  const range = maMarketState(new Array(40).fill(100), {});
  ok('RANGE 判定（走平）', range.state === 'RANGE' && range.slopePct === 0);
  ok('RANGE 时 aboveFast 为 false', range.aboveFast === false);
  ok('maMarketState 空输入不抛', maMarketState([], {}).state === 'RANGE' && maMarketState(null).state === 'RANGE');
  ok('maMarketState slopeBars 影响斜率', Math.abs(maMarketState(seq(100, 139), { slopeBars: 10 }).slopePct - maMarketState(seq(100, 139), { slopeBars: 5 }).slopePct) > 0);
}

console.log('\n[maRelation: L1 回踩站稳（多）]');
{
  const res = buildMaRelation({
    closes: L1_CLOSES, highs: L1_HIGHS, lows: L1_LOWS, atr: L1_ATR,
    closes1d: L1_DAILY, opts: L1_OPTS,
  });
  ok('返回结构完整', !!res.ma && !!res.daily && !!res.weekly && !!res.squeeze && !!res.market && !!res.info);
  ok('market 为 BULL', res.market.state === 'BULL');
  const s = res.signals.find(x => x.type === 'L1' && x.side === 'long' && x.i === 16);
  ok('L1 在 i=16 触发', !!s);
  ok('L1 entry=收盘价', !!s && s.entry === 112);
  ok('L1 stop=最近摆动低点', !!s && near(s.stop, 108.5));
  ok('L1 r=|entry-stop|', !!s && near(s.r, 3.5));
  ok('L1 invalidIdx=首次收盘破 stop', !!s && s.invalidIdx === 25);
  const s26 = res.signals.find(x => x.type === 'L1' && x.side === 'long' && x.i === 26);
  ok('L1 后续 i=26 再触发', !!s26);
  ok('L1 未破 stop → invalidIdx null', !!s26 && s26.invalidIdx === null);
  ok('signals 项结构齐全', res.signals.every(x => ['i', 'side', 'type', 'entry', 'stop', 'r', 'invalidIdx'].every(k => k in x)));
  ok('info.lastSignal 为最后一笔', res.info.lastSignal === res.signals[res.signals.length - 1]);
  ok('info.distFast 有值', typeof res.info.distFast === 'number');
  ok('均线与 closes 等长', res.ma.fast.length === L1_CLOSES.length && res.vwap.length === L1_CLOSES.length);
}

console.log('\n[maRelation: L1 冷却与 BEAR 抑制]');
{
  // cool 很大 → 只应出现 1 笔多头
  const res = buildMaRelation({
    closes: L1_CLOSES, highs: L1_HIGHS, lows: L1_LOWS, atr: L1_ATR,
    closes1d: L1_DAILY, opts: { ...L1_OPTS, cool: 100 },
  });
  const longs = res.signals.filter(x => x.side === 'long');
  ok('冷却过滤同向信号', longs.length === 1 && longs[0].i === 16);
  // BEAR 日线 → L1 多单被抑制
  const bear = buildMaRelation({
    closes: L1_CLOSES, highs: L1_HIGHS, lows: L1_LOWS, atr: L1_ATR,
    closes1d: seq(200, 161, -1), opts: L1_OPTS,
  });
  ok('BEAR 时无 L1 多单', bear.signals.filter(x => x.type === 'L1' && x.side === 'long').length === 0);
  ok('BEAR 时 market 为 BEAR', bear.market.state === 'BEAR');
}

console.log('\n[maRelation: L1\' 反弹受阻（空）]');
{
  const res = buildMaRelation({
    closes: S_CLOSES, highs: S_HIGHS, lows: S_LOWS, atr: S_ATR,
    closes1d: S_DAILY, opts: S_OPTS,
  });
  const s = res.signals.find(x => x.type === 'L1' && x.side === 'short' && x.i === 16);
  ok('L1\' 在 i=16 触发', !!s);
  ok('L1\' entry=收盘价', !!s && s.entry === 188);
  ok('L1\' stop=最近摆动高点', !!s && near(s.stop, 191.5));
  ok('L1\' r 正确', !!s && near(s.r, 3.5));
  ok('L1\' market 非 BULL', res.market.state !== 'BULL');
  // allowShort=false → 无空信号
  const noShort = buildMaRelation({
    closes: S_CLOSES, highs: S_HIGHS, lows: S_LOWS, atr: S_ATR,
    closes1d: S_DAILY, opts: { ...S_OPTS, allowShort: false },
  });
  ok('allowShort=false 无空信号', noShort.signals.every(x => x.side !== 'short'));
  ok('allowShort=false 仍返回结构', Array.isArray(noShort.signals));
}

console.log('\n[maRelation: L2 密集后打开]');
{
  const res = buildMaRelation({
    closes: L2_CLOSES, opens: L2_OPENS, highs: L2_HIGHS, lows: L2_LOWS, atr: L2_ATR,
    closes1d: L2_DAILY, opts: { ...L1_OPTS, cool: 1 },
  });
  const s = res.signals.find(x => x.type === 'L2' && x.side === 'long' && x.i === 30);
  ok('L2 在 i=30 触发', !!s);
  ok('L2 entry=收盘价', !!s && s.entry === 103);
  ok('L2 stop=最近摆动低点', !!s && near(s.stop, 100.5));
  ok('L2 r 正确', !!s && near(s.r, 2.5));
  ok('L2 前一根均线挤压', squeezeAt(L2_CLOSES, 29, L1_OPTS).squeezed === true);
  // atr[i] 为 null 时不误触发：仅把 i=30 的 atr 抹掉
  const noAtr = buildMaRelation({
    closes: L2_CLOSES, opens: L2_OPENS, highs: L2_HIGHS, lows: L2_LOWS,
    atr: new Array(31).fill(null), closes1d: L2_DAILY, opts: L1_OPTS,
  });
  ok('atr null → L2 不触发', noAtr.signals.filter(x => x.type === 'L2').length === 0);
  // 无 opens 时以「前一根收盘」为实体代理（不应抛异常）
  const noOpens = buildMaRelation({
    closes: L2_CLOSES, highs: L2_HIGHS, lows: L2_LOWS, atr: L2_ATR,
    closes1d: L2_DAILY, opts: L1_OPTS,
  });
  ok('缺 opens 不抛异常', Array.isArray(noOpens.signals));
}

console.log('\n[maRelation: L2\' 密集后向下打开（空）]');
{
  const res = buildMaRelation({
    closes: L2S_CLOSES, opens: L2S_OPENS, highs: L2S_HIGHS, lows: L2S_LOWS, atr: L2S_ATR,
    closes1d: L2_DAILY, opts: L1_OPTS,
  });
  const s = res.signals.find(x => x.type === 'L2' && x.side === 'short' && x.i === 30);
  ok('L2\' 在 i=30 触发', !!s);
  ok('L2\' stop=最近摆动高点', !!s && near(s.stop, 100.5));
}

console.log('\n[maRelation: L3 4H MA20 突破]');
{
  const res = buildMaRelation({
    closes: L3_CLOSES, highs: L3_HIGHS, lows: L3_LOWS, atr: L3_ATR,
    closes4h: L3_4H, closes1d: L3_DAILY, opts: L3_OPTS,
  });
  const s = res.signals.find(x => x.type === 'L3' && x.side === 'long' && x.i === 30);
  ok('L3 在 i=30 触发', !!s);
  ok('L3 entry=收盘价', !!s && s.entry === 105);
  ok('L3 stop=结构低点-0.1ATR', !!s && near(s.stop, 99.4));
  ok('L3 r 正确', !!s && near(s.r, 5.6));
  // l3=false → 不触发
  const off = buildMaRelation({
    closes: L3_CLOSES, highs: L3_HIGHS, lows: L3_LOWS, atr: L3_ATR,
    closes4h: L3_4H, closes1d: L3_DAILY, opts: { ...L3_OPTS, l3: false },
  });
  ok('l3=false → 无 L3 信号', off.signals.filter(x => x.type === 'L3').length === 0);
  // 未提供 closes4h → 不触发
  const no4h = buildMaRelation({
    closes: L3_CLOSES, highs: L3_HIGHS, lows: L3_LOWS, atr: L3_ATR,
    closes1d: L3_DAILY, opts: L3_OPTS,
  });
  ok('无 closes4h → 无 L3 信号', no4h.signals.filter(x => x.type === 'L3').length === 0);
  // BEAR 日线 → L3 多单被抑制
  const bear = buildMaRelation({
    closes: L3_CLOSES, highs: L3_HIGHS, lows: L3_LOWS, atr: L3_ATR,
    closes4h: L3_4H, closes1d: S_DAILY, opts: L3_OPTS,
  });
  ok('BEAR 时无 L3 多单', bear.signals.filter(x => x.type === 'L3' && x.side === 'long').length === 0);
  // L3' 空侧
  const shortRes = buildMaRelation({
    closes: L3S_CLOSES, highs: L3S_HIGHS, lows: L3S_LOWS, atr: L3S_ATR,
    closes4h: L3S_4H, closes1d: S_DAILY, opts: L3_OPTS,
  });
  const ss = shortRes.signals.find(x => x.type === 'L3' && x.side === 'short' && x.i === 30);
  ok('L3\' 在 i=30 触发', !!ss);
  ok('L3\' stop=结构高点+0.1ATR', !!ss && near(ss.stop, 100.6));
}

console.log('\n[maRelation: 数据不足与脏输入]');
{
  const small = buildMaRelation({ closes: [1, 2, 3], highs: [1, 2, 3], lows: [1, 2, 3], atr: [1, 1, 1] });
  ok('数据不足不抛', !!small);
  ok('数据不足 signals 为空', Array.isArray(small.signals) && small.signals.length === 0);
  ok('数据不足均线全 null', small.ma.fast.every(v => v === null) && small.ma.mid.every(v => v === null));
  ok('数据不足 daily/weekly 全 null', small.daily[20].every(v => v === null) && small.weekly[200].every(v => v === null));
  ok('数据不足 squeeze 为 null', small.squeeze.spreadPct === null && small.squeeze.squeezed === false);
  ok('数据不足 info 完整', small.info.distFast === null && small.info.lastSignal === null);

  ok('buildMaRelation null 不抛', !!buildMaRelation(null));
  ok('buildMaRelation undefined 不抛', !!buildMaRelation(undefined));
  ok('buildMaRelation 空对象不抛', !!buildMaRelation({}));
  ok('opts 为 null 用默认值', buildMaRelation({ closes: L1_CLOSES, opts: null }).opts.fast === 20);
  ok('opts 部分缺省补齐', (() => { const r = buildMaRelation({ closes: L1_CLOSES, opts: { fast: 3 } }); return r.opts.fast === 3 && r.opts.mid === 60 && r.opts.swing === 15; })());
  ok('长度不齐不抛', !!buildMaRelation({ closes: L1_CLOSES, highs: [1], lows: [1], atr: [1], closes1d: [1, 2] }));
  ok('closes1d null 不抛', !!buildMaRelation({ closes: L1_CLOSES, closes1d: null }));
  ok('全部 null 输入不抛', !!buildMaRelation({ closes: null, highs: null, lows: null, vols: null, atr: null, closes1d: null, closes4h: null, t: null }));
}

console.log('\n[maRelation: 对齐与 info 汇总]');
{
  // 用足够长的原始日线（≥25 根）才能算出日线 MA20
  const c1d = Array.from({ length: 25 }, (_, i) => 100 + i);
  const t1d = c1d.map((_, i) => i * 50);   // 日线每 50 单位一根，保证主图末根能对齐到第 20 根之后
  const mainT = L1_CLOSES.map((_, i) => i * 50);
  const res = buildMaRelation({
    closes: L1_CLOSES, highs: L1_HIGHS, lows: L1_LOWS, atr: L1_ATR,
    closes1d: c1d, t1d,
    t: mainT,
    opts: L1_OPTS,
  });
  ok('原始日线按时间对齐不抛', !!res);
  ok('对齐后 daily 有值', res.daily[20].some(v => v !== null));
  // v1.6.34 回归（重要）：日线均线必须**先在日线自身算完、再对齐到主图**；
  // 旧实现「先前向填充再算均线」→ 同一根日线收盘被重复填充 → 均线恒等于该收盘价（假值）
  const maD = maSeries(c1d, 20, 'sma');
  const j = alignClosedIdx(t1d, [mainT[mainT.length - 1]])[0];
  const lastD = res.daily[20][res.daily[20].length - 1];
  ok('日线 MA20 = 日线均线再对齐（非“收盘价重复填充”）', Math.abs(lastD - maD[j]) < 1e-9);
  ok('日线 MA20 ≠ 日线收盘价（旧 bug 指纹）', lastD !== c1d[c1d.length - 1]);
  // 已对齐周线直接传入
  const aligned = buildMaRelation({
    closes: L1_CLOSES, highs: L1_HIGHS, lows: L1_LOWS, atr: L1_ATR,
    closes1d: L1_DAILY, closes1w: seq(100, 139), opts: L1_OPTS,
  });
  ok('周线已对齐可用', typeof aligned.info.distWeekly20 === 'number');
  ok('周线 MA 数组等长', aligned.weekly[20].length === L1_CLOSES.length);
  ok('日线 MA 数组等长', aligned.daily[50].length === L1_CLOSES.length);
  // devAtr：价格远高于均线且 ATR 很小 → 标“远离均线”
  const far = buildMaRelation({
    closes: L1_CLOSES.map((v, i) => (i === L1_CLOSES.length - 1 ? v * 1.2 : v)),
    highs: L1_HIGHS, lows: L1_LOWS, atr: L1_ATR, closes1d: L1_DAILY, opts: { ...L1_OPTS, devAtr: 0.5 },
  });
  ok('devAtr 标记远离均线', far.info.devAtr === true);
  ok('vwap 开关关闭 → 全 null', buildMaRelation({ closes: L1_CLOSES, opts: { vwap: false } }).vwap.every(v => v === null));
  ok('返回 opts 为归一化对象', (() => { const r = buildMaRelation({ closes: L1_CLOSES, opts: { allowShort: false } }); return r.opts.allowShort === false && r.opts.cool === MA_REL_DEFAULTS.cool; })());
}


// ============================================================
// v1.6.31：maRelReadout —— 均线关系「小白解读」（供 PWA 驾驶舱面板）
// ============================================================
console.log('\n[maRelation: maRelReadout 解读行]');
{
  const mkData = (over) => Object.assign({
    opts: Object.assign({}, MA_REL_DEFAULTS, { showSlow: false, daily: [20,50,200], weekly: [20,200], vwap: true, l3: true, allowShort: true }),
    ma: { fast: [null, 100], mid: [null, 90], slow: [null, 80] },
    vwap: [null, 99],
    daily: { 20: [null, 101], 50: [null, 95], 200: [null, 70] },
    weekly: { 20: [null, 90], 200: [null, 60] },
    squeeze: { spreadPct: 4.2, squeezed: false },
    market: { state: 'BULL', close: 100, maFast: 99, maMid: 95, slopePct: 0.12, aboveFast: true, aboveMid: true },
    signals: [],
    info: { distFast: 0.5, distDaily20: -0.4, distWeekly20: 6.5, distWeekly200: 4.8, devAtr: false, squeezed: false, lastSignal: null, px: 100, atrPct: 2 },
  }, over || {});

  const r0 = maRelReadout(null);
  ok('null → tone none + 空 rows', r0.tone === 'none' && r0.rows.length === 0 && /未启用/.test(r0.verdict));

  const bull = maRelReadout(mkData());
  ok('BULL → tone bull', bull.tone === 'bull');
  ok('含大环境行（只找做多）', bull.rows.some(r => /大环境 BULL/.test(r.label) && /只找做多/.test(r.label)));
  ok('含本周期 MA20 位置行', bull.rows.some(r => /价在本周期MA20 上方/.test(r.label)));
  ok('含均线排列行', bull.rows.some(r => /多头排列|空头排列|纠缠/.test(r.label)));
  ok('含均线密集行', bull.rows.some(r => /均线未密集|均线密集/.test(r.label)));
  ok('含日线/周线参照行', bull.rows.some(r => /日线MA20/.test(r.label)) && bull.rows.some(r => /周线MA20/.test(r.label)));
  ok('含 VWAP 行', bull.rows.some(r => /VWAP/.test(r.label)));
  ok('含等待区行', bull.rows.some(r => /等待区/.test(r.label)));
  ok('BULL 结论含「顺势偏多」', /顺势偏多/.test(bull.verdict));

  const bear = maRelReadout(mkData({ market: { state: 'BEAR', close: 90, maFast: 99, maMid: 95, slopePct: -0.3, aboveFast: false, aboveMid: false } }));
  ok('BEAR → tone bear + 结论顺势偏空', bear.tone === 'bear' && /顺势偏空/.test(bear.verdict));
  const rng = maRelReadout(mkData({ market: { state: 'RANGE', close: 100, maFast: 99, maMid: 95, slopePct: 0, aboveFast: true, aboveMid: true } }));
  ok('RANGE → tone range + 结论震荡观望', rng.tone === 'range' && /震荡观望/.test(rng.verdict));

  // 只解读「已开启」的项
  const off = maRelReadout(mkData({ opts: Object.assign({}, MA_REL_DEFAULTS, { showSlow: false, daily: [], weekly: [], vwap: false }) }));
  ok('关日线 → 无日线参照行', !off.rows.some(r => /日线MA20/.test(r.label)));
  ok('关周线 → 无周线参照行', !off.rows.some(r => /周线MA20/.test(r.label)));
  ok('关 VWAP → 无 VWAP 行', !off.rows.some(r => /VWAP/.test(r.label)));

  // 最近信号行
  const withSig = maRelReadout(mkData({ info: Object.assign({}, mkData().info, { lastSignal: { i: 9, side: 'long', type: 'L1', entry: 100, stop: 98, r: 2, invalidIdx: null } }) }));
  const sigRow = withSig.rows.find(r => /L1/.test(r.label));
  ok('含最近信号行（类型+方向+有效）', !!sigRow && /做多/.test(sigRow.label) && /有效/.test(sigRow.label) && !/已失效/.test(sigRow.label));
  ok('信号行含 入场/防守/1R/2R目标', /入场 100/.test(sigRow.detail) && /防守 98/.test(sigRow.detail) && /1R 2/.test(sigRow.detail) && /2R目标 104/.test(sigRow.detail));
  const invSig = maRelReadout(mkData({ info: Object.assign({}, mkData().info, { lastSignal: { i: 9, side: 'long', type: 'L1', entry: 100, stop: 98, r: 2, invalidIdx: 12 } }) }));
  const invRow = invSig.rows.find(r => /L1/.test(r.label));
  ok('失效信号 → 标签含「已失效」且灰', /已失效/.test(invRow.label) && invRow.color === '#8899aa');
  ok('失效时结论追加认错提示', /已失效/.test(invSig.verdict));
  const noSig = maRelReadout(mkData());
  ok('无信号 → 提示等收盘态度', noSig.rows.some(r => /暂无可执行信号/.test(r.label)));

  // 乖离
  const dev = maRelReadout(mkData({ info: Object.assign({}, mkData().info, { devAtr: true }) }));
  ok('乖离 → 勿追提示行', dev.rows.some(r => /远离均线/.test(r.label)));

  // 健壮性
  ok('缺 info/ma 不抛', (() => { try { const r = maRelReadout({ opts: MA_REL_DEFAULTS, ma: {}, info: {} }); return r && Array.isArray(r.rows); } catch (e) { return false; } })());
  ok('每行都有 icon/label', bull.rows.every(r => r.icon && r.label));
}


// v1.6.32：maRelReadout 的最近信号列表（带时间，最新在前）
console.log('\n[maRelation: maRelReadout 信号列表]');
{
  const base = {
    opts: Object.assign({}, MA_REL_DEFAULTS, { daily: [], weekly: [], vwap: false }),
    ma: { fast: [null, 100], mid: [null, 90], slow: [null, 80] },
    vwap: [], daily: {}, weekly: {}, squeeze: { spreadPct: 2, squeezed: false },
    market: { state: 'BULL', close: 100, maFast: 99, maMid: 95, slopePct: 0.1, aboveFast: true, aboveMid: true },
    t: [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 11000, 12000, 13000, 14000, 15000],
    signals: [],
    info: { distFast: 0.5, distDaily20: null, distWeekly20: null, distWeekly200: null, devAtr: false, squeezed: false, lastSignal: null, px: 100, atrPct: 2 },
  };
  const many = [];
  for (let k = 1; k <= 14; k++) many.push({ i: k, side: k % 2 ? 'long' : 'short', type: ['L1', 'L2', 'L3'][k % 3], entry: 100 + k, stop: 98 + k, r: 2, invalidIdx: k % 5 === 0 ? k + 1 : null });
  const r = maRelReadout(Object.assign({}, base, { signals: many }));
  ok('信号列表默认最多 10 笔', r.signals.length === 10);
  ok('最新在前（i 递减）', r.signals[0].i === 14 && r.signals[1].i === 13 && r.signals[9].i === 5);
  ok('带时间戳（来自 data.t）', r.signals[0].ts === 15000 && r.signals[9].ts === 6000);
  ok('失效标记透传', r.signals.find(x => x.i === 10).invalid === true && r.signals.find(x => x.i === 9).invalid === false);
  ok('字段齐全（side/type/entry/stop/r）', r.signals.every(x => x.side && x.type && x.entry != null && x.stop != null && x.r != null));
  const r3 = maRelReadout(Object.assign({}, base, { signals: many }), { sigLimit: 3 });
  ok('sigLimit 可调（3 笔）', r3.signals.length === 3 && r3.signals[0].i === 14);
  const r0 = maRelReadout(Object.assign({}, base, { signals: many }), { sigLimit: 0 });
  ok('sigLimit=0 → 空列表', r0.signals.length === 0);
  const noT = maRelReadout(Object.assign({}, base, { t: undefined, signals: many }));
  ok('缺 t → ts 为 null 不抛', noT.signals.every(x => x.ts === null));
  const none = maRelReadout(base);
  ok('无信号 → 空列表', none.signals.length === 0);
  ok('未启用时也返回 signals:[]', maRelReadout(null).signals.length === 0);
}

// ============================================================
// v1.6.36：回踩→站稳进度 / 密集突破预告 / 历史信号胜率
// ============================================================
function mkSd({ closes, maFast, atr, state = 'BULL', px = null, squeeze = { spreadPct: 0.5, squeezed: true } }) {
  return {
    ma: { fast: maFast, mid: maFast.slice(), slow: maFast.slice() },
    closes, atr: atr || new Array(closes.length).fill(1),
    market: { state },
    info: { px: px != null ? px : closes[closes.length - 1] },
    squeeze, opts: { squeezePct: 1.2, fast: 20 },
  };
}
console.log('\n[maRelation: v1.6.36 standProgress 回踩→站稳进度]');
{
  // 收盘已站上 MA20 → stand / 100%
  const d1 = mkSd({ closes: [100, 101, 102, 103, 104], maFast: [100, 100, 100, 100, 100], state: 'BULL' });
  const s1 = standProgress(d1);
  ok('stand: 收盘站上 → stage=stand', s1.ok && s1.stage === 'stand');
  ok('stand: progress=1', near(s1.progress, 1));
  ok('stand: 连续根数=4', s1.standBars === 4);
  ok('stand: side=long', s1.side === 'long');
  ok('stand: label 含「已站稳」', s1.label.indexOf('已站稳') >= 0);

  // 已回踩到带内但未站上 → inband（0.6~1）
  const d2 = mkSd({ closes: [100, 100, 99.9, 99.9], maFast: [100, 100, 100, 100], state: 'BULL' });
  const s2 = standProgress(d2);
  ok('stand: 带内未站上 → stage=inband', s2.stage === 'inband');
  ok('stand: 带内 progress 在 0.6~1', s2.progress > 0.6 && s2.progress < 1);
  ok('stand: distStandPct > 0（还没站稳）', s2.distStandPct > 0);
  ok('stand: label 含「距站稳还差」', s2.label.indexOf('距站稳还差') >= 0);

  // 远低于 MA20 → far（progress≈0）
  const d3 = mkSd({ closes: [100, 100, 100, 90], maFast: [100, 100, 100, 100], state: 'BULL' });
  const s3 = standProgress(d3);
  ok('stand: 远离 → stage=far', s3.stage === 'far');
  ok('stand: 远离 progress=0', s3.progress === 0);

  // BEAR 镜像
  const d4 = mkSd({ closes: [100, 99, 98, 97], maFast: [100, 100, 100, 100], state: 'BEAR' });
  const s4 = standProgress(d4);
  ok('stand: BEAR → side=short / stage=stand', s4.side === 'short' && s4.stage === 'stand');
  ok('stand: BEAR label 含「做空」', s4.label.indexOf('做空') >= 0);

  // RANGE → 贴合度
  const d5 = mkSd({ closes: [100, 100, 100, 101], maFast: [100, 100, 100, 100], state: 'RANGE' });
  const s5 = standProgress(d5);
  ok('stand: RANGE → stage=range / side=null', s5.stage === 'range' && s5.side === null);
  ok('stand: RANGE progress = 1-|Δ|/2ATR', near(s5.progress, 0.5));

  // 实时价覆盖（面板用）
  const live = standProgress(d1, { livePrice: 90 });
  ok('stand: livePrice 覆盖 px（进度降到 0）', live.progress === 0 && live.stage === 'far');
  ok('stand: 非法 livePrice 不覆盖', standProgress(d1, { livePrice: NaN }).progress === 1);
  ok('stand: 缺 opts 不抛', standProgress(d1).ok === true);

  // 脏输入
  ok('stand: null → ok=false', standProgress(null).ok === false);
  ok('stand: 数据不足 → ok=false', standProgress(mkSd({ closes: [1], maFast: [1], state: 'BULL' })).ok === false);
  ok('stand: 脏数组不抛', (() => { try { return standProgress({ ma: { fast: [1, 2, 3] }, closes: [1, 2, 3], market: { state: 'BULL' } }).ok === true; } catch (e) { return false; } })());
}

console.log('\n[maRelation: v1.6.36 squeezeBreakout 密集突破预告]');
{
  const mk = (px) => ({ ma: { fast: [100], mid: [101], slow: [99] }, closes: [px], atr: [1], info: { px }, squeeze: { spreadPct: 0.5, squeezed: true } });
  const b1 = squeezeBreakout(mk(101));   // 在区内
  ok('breakout: 在区内 → watching', b1.ok && b1.watching && b1.nearEdge);
  ok('breakout: 上/下沿 = max/min 均线', b1.hi === 101 && b1.lo === 99);
  ok('breakout: closer=up（离上沿更近）', b1.closer === 'up');
  ok('breakout: refUp/refDown', b1.refUp === 101 && b1.refDown === 99);
  ok('breakout: label 含「密集区收窄」', b1.label.indexOf('密集区收窄') >= 0);

  const b2 = squeezeBreakout(mk(120));   // 远离
  ok('breakout: 远离 → watching=false', b2.watching === false && b2.nearEdge === false);
  ok('breakout: 远离（在上方）最近边缘=上沿 → closer=up', b2.closer === 'up' && b2.upPct < 0);

  const b3 = squeezeBreakout({ ma: { fast: [100], mid: [101], slow: [99] }, closes: [101], atr: [1], info: { px: 101 }, squeeze: { spreadPct: 3, squeezed: false } });
  ok('breakout: 未密集 → squeezed=false / watching=false', b3.squeezed === false && b3.watching === false);
  ok('breakout: 未密集 label', b3.label.indexOf('未密集') >= 0);

  const b4 = squeezeBreakout({ ma: { fast: [100], mid: [100] }, closes: [100], atr: [1], info: { px: 100 }, squeeze: { squeezed: true } });
  ok('breakout: 只 2 条均线也可算', b4.ok === true && b4.hi === 100 && b4.lo === 100);
  ok('breakout: null/脏输入不抛', squeezeBreakout(null).ok === false && squeezeBreakout({ ma: {} }).ok === false && squeezeBreakout({ ma: { fast: [null] } }).ok === false);
}

console.log('\n[maRelation: v1.6.36 signalForwardStats 历史信号胜率]');
{
  const closes = [100, 100, 105, 100, 100, 98, 100, 100, 100];
  const atr = new Array(closes.length).fill(1);
  const sigs = [
    { i: 0, side: 'long', type: 'L1' },   // 105 >= 102 → win
    { i: 3, side: 'long', type: 'L1' },   // 98 <= 98.5 → loss
    { i: 6, side: 'long', type: 'L2' },   // 未触发 → unresolved
  ];
  const st = signalForwardStats(sigs, closes, atr);
  ok('stats: n=3', st.n === 3);
  ok('stats: 盈/亏/未定', st.wins === 1 && st.losses === 1 && st.unresolved === 1);
  ok('stats: winRate=0.5', near(st.winRate, 0.5));
  ok('stats: avgPnlPct=(5-2)/2=1.5', near(st.avgPnlPct, 1.5));
  ok('stats: byType L1 有盈有亏', st.byType.L1.n === 2 && st.byType.L1.wins === 1 && st.byType.L1.losses === 1);
  ok('stats: byType L2 全部未定', st.byType.L2.n === 1 && st.byType.L2.unresolved === 1 && st.byType.L2.winRate === null);
  // 做空方向
  const stS = signalForwardStats([{ i: 0, side: 'short', type: 'L1' }], [100, 100, 97], [1, 1, 1]);
  ok('stats: 做空用 sell 方向 → win', stS.wins === 1 && stS.winRate === 1);
  // 空 / 脏
  ok('stats: 空列表 n=0 / winRate=null', signalForwardStats([], closes, atr).n === 0 && signalForwardStats([], closes, atr).winRate === null);
  ok('stats: null 不抛', signalForwardStats(null, null, null).n === 0);
  ok('stats: 缺 i/side 的记录被跳过', signalForwardStats([{ type: 'L1' }, null, { i: 0, side: 'long', type: 'L1' }], closes, atr).n === 1);
  // 自定义参数（收紧止盈 / 放宽止损 → 原本的亏单变未定）
  const st2 = signalForwardStats(sigs, closes, atr, { tpAtr: 0.5, slAtr: 5 });
  ok('stats: 自定义 tpAtr/slAtr 生效（亏单不再触发）', st2.wins === 1 && st2.losses === 0 && st2.unresolved === 2);
}

console.log('\n[maRelation: v1.6.36 maRelReadout 新增行]');
{
  const mkRd = (extra) => Object.assign({
    opts: { fast: 20, mid: 60, slow: 120, daily: [20], weekly: [], vwap: false, squeezePct: 1.2, devAtr: 1.5, showSlow: false },
    ma: { fast: new Array(6).fill(100), mid: new Array(6).fill(100), slow: new Array(6).fill(100) },
    closes: [100, 100, 100, 100, 100, 100], atr: new Array(6).fill(1),
    daily: { 20: new Array(6).fill(100) }, weekly: {}, vwap: [],
    squeeze: { spreadPct: 0.5, squeezed: true },
    market: { state: 'BULL', close: 100, maFast: 100, maMid: 100, slopePct: 0.1, aboveMid: true },
    info: { px: 100, atrPct: 1, distFast: 0, distDaily20: 0, distWeekly20: null, distWeekly200: null, devAtr: false, squeezed: true, lastSignal: null },
    t: [1, 2, 3, 4, 5, 6], signals: [],
  }, extra || {});
  const r = maRelReadout(mkRd());
  ok('readout: 含「回踩→站稳」行', r.rows.some(x => x.label.indexOf('回踩→站稳') === 0));
  ok('readout: 站稳行带进度条字符', r.rows.some(x => x.label.indexOf('▰') >= 0 || x.label.indexOf('▱') >= 0));
  ok('readout: 含「密集突破预告」行', r.rows.some(x => x.label.indexOf('密集突破预告') === 0));
  ok('readout: 返回 stand/breakout/stats', !!r.stand && r.stand.ok && !!r.breakout && !!r.stats);
  ok('readout: 无信号 → 无胜率行', !r.rows.some(x => x.label.indexOf('历史信号胜率') === 0));
  // 带信号 → 有胜率行
  const sigs = [{ i: 0, side: 'long', type: 'L1' }, { i: 3, side: 'long', type: 'L1' }];
  const r2 = maRelReadout(mkRd({ signals: sigs }));
  ok('readout: 有信号 → 含胜率行', r2.rows.some(x => x.label.indexOf('历史信号胜率') === 0));
  ok('readout: 胜率行含「仅历史统计不代表未来」', r2.rows.some(x => x.detail.indexOf('不代表未来') >= 0));
  ok('readout: stats.n=2', r2.stats && r2.stats.n === 2);
  // livePrice 影响站稳行
  const rLive = maRelReadout(mkRd(), { livePrice: 90 });
  const rowA = r.rows.find(x => x.label.indexOf('回踩→站稳') === 0);
  const rowB = rLive.rows.find(x => x.label.indexOf('回踩→站稳') === 0);
  ok('readout: livePrice 改变站稳进度', rowA.label !== rowB.label);
  // 未密集 → 无突破预告行
  const rNoSq = maRelReadout(mkRd({ squeeze: { spreadPct: 3, squeezed: false }, info: { px: 100, atrPct: 1, distFast: 0, devAtr: false, squeezed: false } }));
  ok('readout: 未密集 → 无突破预告行', !rNoSq.rows.some(x => x.label.indexOf('密集突破预告') === 0));
  ok('readout: 未启用时 stand/breakout/stats=null', maRelReadout(null).stand === null && maRelReadout(null).breakout === null && maRelReadout(null).stats === null);
  // RANGE → 措辞改为「均线贴合度」
  const rRange = maRelReadout(mkRd({ market: { state: 'RANGE', close: 100, maFast: 100, slopePct: 0.1 } }));
  ok('readout: RANGE → 「均线贴合度」措辞', rRange.rows.some(x => x.label.indexOf('均线贴合度') === 0));
  // 胜率优势标注（诚实口径）
  const rWin = maRelReadout(mkRd({ closes: [100, 103, 100, 103, 100, 103], signals: [{ i: 0, side: 'long', type: 'L1' }, { i: 2, side: 'long', type: 'L1' }, { i: 4, side: 'long', type: 'L1' }] }));
  ok('readout: 高胜率 → 标「有优势」', rWin.rows.some(x => x.label.indexOf('有优势') >= 0));
  const rLose = maRelReadout(mkRd({ closes: [100, 98, 100, 98, 100, 98], signals: [{ i: 0, side: 'long', type: 'L1' }, { i: 2, side: 'long', type: 'L1' }, { i: 4, side: 'long', type: 'L1' }] }));
  ok('readout: 低胜率 → 标「无优势」', rLose.rows.some(x => x.label.indexOf('无优势') >= 0));
}

console.log(`\n=== maRelation.test: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);