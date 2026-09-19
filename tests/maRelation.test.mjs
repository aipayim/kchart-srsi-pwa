// 价格与均线关系引擎单元测试（Node 原生，无框架）
// 覆盖：maSeries(SMA/EMA) / vwapSeries / maDistPct / alignClosedIdx(防前视) /
//       squeezeAt / maMarketState(三态) / buildMaRelation 的 L1/L1'/L2/L3 触发与不触发、
//       冷却、stop、r、invalidIdx、allowShort、数据不足与脏输入不抛。
import {
  MA_REL_DEFAULTS, maSeries, vwapSeries, maDistPct, alignClosedIdx,
  squeezeAt, maMarketState, buildMaRelation,
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
  // 用原始日线 + 时间戳走 alignClosedIdx：日线时间 [0, 100, 200]，主图时间 [0, 50, 100, 250]
  const res = buildMaRelation({
    closes: L1_CLOSES, highs: L1_HIGHS, lows: L1_LOWS, atr: L1_ATR,
    closes1d: [10, 20, 30], t1d: [0, 100, 200],
    t: L1_CLOSES.map((_, i) => i * 50),
    opts: L1_OPTS,
  });
  ok('原始日线按时间对齐不抛', !!res);
  ok('对齐后 daily 有值', res.daily[20].some(v => v !== null));
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

console.log(`\n=== maRelation.test: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
