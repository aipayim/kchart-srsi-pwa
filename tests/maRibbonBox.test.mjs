// 多均线带 + 箱体 + 回踩信号（盯盘辅助显示层）单元测试（Node 原生，无框架）
// 覆盖：maRibbon(SMA/EMA/顺序/颜色/数据不足) / ribbonOrder(多头/空头/纠缠/数据不足) /
//       rangeBox(合成箱体/上破/下破/趋势不成立/因果性/容差/posPct) /
//       pullbackSignals(箱体突破回踩确认与待确认/下破对称/深度过滤/快线不算回踩/冷却/invalidIdx/dots/脏输入) /
//       buildMaRibbonBox(数据不足安全默认/正常模型/不改输入/确定性) /
//       maRibbonBoxReadout(数据不足/正常/有箱体/无箱体/livePrice/verdict)。
import {
  RB_DISCLAIMER, RB_NO_TRADE, RB_MA_PRESETS, RB_MA_COLORS, RB_DEFAULTS,
  maRibbon, ribbonOrder, rangeBox, pullbackSignals,
  buildMaRibbonBox, maRibbonBoxReadout,
} from '../src/engine/maRibbonBox.js';

let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log('ok:', name); } else { failed++; console.log('FAIL:', name); } }
const near = (a, b, eps = 1e-9) => typeof a === 'number' && Math.abs(a - b) < eps;
const someRow = (rows, frag) => rows.some((r) => String(r.label).indexOf(frag) >= 0);

// ---------- 测试用序列构造 ----------
function seq(from, to, step = 1) { const a = []; for (let v = from; step > 0 ? v <= to : v >= to; v += step) a.push(v); return a; }

// 合成箱体：60 根在 100~102 震荡 + 第 60 根收盘 105 上破
function boxBreakoutSeries() {
  const n = 61; const closes = [], highs = [], lows = [];
  for (let i = 0; i < 60; i++) { closes.push(101); highs.push(102); lows.push(100); }
  closes.push(105); highs.push(105.5); lows.push(104);
  return { closes, highs, lows, atr: new Array(n).fill(1) };
}
// 箱体内震荡（无突破）
function boxInsideSeries() {
  return { closes: new Array(60).fill(101), highs: new Array(60).fill(102), lows: new Array(60).fill(100), atr: new Array(60).fill(1) };
}
// 单调上涨 500 根（几何增长 → 任意 20 根高度都 > 4%）
function trendSeries(n = 500) {
  const closes = Array.from({ length: n }, (_, i) => 100 * Math.pow(1.01, i));
  return { closes, highs: closes.map((v) => v * 1.001), lows: closes.map((v) => v * 0.999) };
}

// 手工箱体对象（用于隔离 pullbackSignals 的 A 路径）
const BOX_UP = { ok: true, top: 102, bottom: 100, mid: 101, i0: 0, i1: 59, bars: 60, heightPct: 2, tTop: 60, tBot: 60, touched: true, state: 'breakout-up', posPct: 250, breakout: { i: 60, dir: 'up', price: 105, level: 102 } };
const BOX_DN = { ok: true, top: 102, bottom: 100, mid: 101, i0: 0, i1: 59, bars: 60, heightPct: 2, tTop: 60, tBot: 60, touched: true, state: 'breakout-down', posPct: -150, breakout: { i: 60, dir: 'down', price: 97, level: 100 } };
const ribbon50 = () => [{ period: 50, label: 'MA50', values: new Array(70).fill(100) }];

// 箱体突破后回踩到 MA50 并收盘站回（确认）
function pbConfirmedSeries() {
  const n = 70; const closes = [], highs = [], lows = [];
  for (let i = 0; i < 60; i++) { closes.push(101); highs.push(102); lows.push(100); }
  closes.push(105); highs.push(105.5); lows.push(104);      // 60 突破
  closes.push(101); highs.push(103); lows.push(100.2);      // 61 触及 MA50
  closes.push(101.5); highs.push(102.5); lows.push(100.1);  // 62 收盘站回
  for (let i = 63; i < n; i++) { closes.push(101.5); highs.push(102); lows.push(100.5); }
  return { closes, highs, lows, atr: new Array(n).fill(1), ribbon: ribbon50() };
}
// 突破后回踩但收盘始终在均线下方（未确认）
function pbUnconfirmedSeries() {
  const n = 70; const closes = [], highs = [], lows = [];
  for (let i = 0; i < 60; i++) { closes.push(101); highs.push(102); lows.push(100); }
  closes.push(105); highs.push(105.5); lows.push(104);
  closes.push(99.5); highs.push(103); lows.push(100.2);
  for (let i = 62; i < n; i++) { closes.push(99.4); highs.push(101); lows.push(100.1); }
  return { closes, highs, lows, atr: new Array(n).fill(1), ribbon: ribbon50() };
}
// 箱体下破后反抽到 MA50 并收盘跌回（确认空）
function pbDownSeries() {
  const n = 70; const closes = [], highs = [], lows = [];
  for (let i = 0; i < 60; i++) { closes.push(101); highs.push(102); lows.push(100); }
  closes.push(97); highs.push(98); lows.push(96.5);       // 60 下破
  closes.push(99.5); highs.push(99.8); lows.push(98);     // 61 反抽触及 MA50
  closes.push(98.5); highs.push(99.5); lows.push(98);     // 62 收盘跌回
  for (let i = 63; i < n; i++) { closes.push(98.5); highs.push(99); lows.push(98); }
  return { closes, highs, lows, atr: new Array(n).fill(1), ribbon: ribbon50() };
}
// 趋势内均线回踩：40 根 104 → 第 40 根低点 100.5 触及 MA50=100 且收盘站回
const RIBBON_TREND = [
  { period: 50, label: 'MA50', values: new Array(70).fill(100) },
  { period: 60, label: 'MA60', values: new Array(70).fill(95) },
];
function trendPullbackSeries() {
  const n = 70; const closes = [], highs = [], lows = [];
  for (let i = 0; i < 40; i++) { closes.push(104); highs.push(104.5); lows.push(103.5); }
  closes.push(105); highs.push(105.5); lows.push(100.5);   // 40 回踩 + 站回
  for (let i = 41; i < n; i++) { closes.push(104); highs.push(104.5); lows.push(103.5); }
  return { closes, highs, lows, atr: new Array(n).fill(1), ribbon: RIBBON_TREND };
}
// 两次独立回踩（间隔 21 根）
function twoPullbacksSeries() {
  const n = 70; const closes = [], highs = [], lows = [];
  for (let i = 0; i < 40; i++) { closes.push(104); highs.push(104.5); lows.push(103.5); }
  closes.push(105); highs.push(105.5); lows.push(100.5);   // 40
  for (let i = 41; i < 61; i++) { closes.push(104); highs.push(104.5); lows.push(103.5); }
  closes.push(105); highs.push(105.5); lows.push(100.5);   // 61
  for (let i = 62; i < n; i++) { closes.push(104); highs.push(104.5); lows.push(103.5); }
  return { closes, highs, lows, atr: new Array(n).fill(1), ribbon: RIBBON_TREND };
}
// 完整模型序列（可被 rangeBox 检出箱体 + 上破）
function modelSeries() {
  const n = 70; const closes = [], highs = [], lows = [];
  for (let i = 0; i < 60; i++) { closes.push(101); highs.push(102); lows.push(100); }
  closes.push(105); highs.push(105.5); lows.push(104);
  closes.push(101); highs.push(103); lows.push(100.2);
  closes.push(101.5); highs.push(102.5); lows.push(100.1);
  for (let i = 63; i < n; i++) { closes.push(101.5); highs.push(102); lows.push(100.5); }
  return { closes, highs, lows, atr: new Array(n).fill(1) };
}

console.log('\n[maRibbonBox: 导出常量与默认值]');
{
  ok('RB_DISCLAIMER 为非空字符串', typeof RB_DISCLAIMER === 'string' && RB_DISCLAIMER.length > 10);
  ok('RB_NO_TRADE 含「不接自动交易」', typeof RB_NO_TRADE === 'string' && RB_NO_TRADE.indexOf('不接自动交易') >= 0);
  ok('RB_MA_COLORS 有 5 条配色', Array.isArray(RB_MA_COLORS) && RB_MA_COLORS.length === 5);
  ok('RB_MA_PRESETS 有 4 个预设', Array.isArray(RB_MA_PRESETS) && RB_MA_PRESETS.length === 4);
  ok('默认 pullbackMinPeriod=50', RB_DEFAULTS.pullbackMinPeriod === 50);
  ok('默认 minDepthAtr=1.0', RB_DEFAULTS.minDepthAtr === 1.0);
  ok('默认 maType=sma', RB_DEFAULTS.maType === 'sma');
}

console.log('\n[maRibbon: SMA / EMA / 顺序 / 颜色]');
{
  const closes = seq(1, 10);
  const r = maRibbon(closes, [3]);
  ok('SMA 返回 1 条', r.length === 1);
  ok('SMA values 与 closes 等长', r[0].values.length === 10);
  ok('SMA 前导 null（索引 0/1）', r[0].values[0] === null && r[0].values[1] === null);
  ok('SMA 索引 2 = 2', r[0].values[2] === 2);
  ok('SMA 索引 3 = 3', r[0].values[3] === 3);
  ok('SMA 索引 9 = 9', r[0].values[9] === 9);
  ok('SMA label = MA3', r[0].label === 'MA3');
  ok('SMA type 标记为 sma', r[0].type === 'sma');

  // EMA：种子=SMA(p) 于索引 p-1，递推 k=2/(p+1)
  const ec = [1, 2, 3, 4, 10, 6];
  const e = maRibbon(ec, [3], { type: 'ema' });
  ok('EMA 前导 null（索引 0/1）', e[0].values[0] === null && e[0].values[1] === null);
  ok('EMA 种子（索引 2）= SMA3 = 2', near(e[0].values[2], 2));
  ok('EMA 索引 3 = 4*0.5+2*0.5 = 3', near(e[0].values[3], 3));
  ok('EMA 索引 4 = 10*0.5+3*0.5 = 6.5', near(e[0].values[4], 6.5));
  ok('EMA 索引 5 = 6*0.5+6.5*0.5 = 6.25', near(e[0].values[5], 6.25));
  ok('EMA label = EMA3', e[0].label === 'EMA3');

  // 多周期顺序 / 颜色 / 标签
  const m = maRibbon(seq(1, 60), [10, 20, 50]);
  ok('返回顺序 = periods 顺序（period 字段）', m[0].period === 10 && m[1].period === 20 && m[2].period === 50);
  ok('颜色按 RB_MA_COLORS 依次取', m[0].color === RB_MA_COLORS[0] && m[1].color === RB_MA_COLORS[1] && m[2].color === RB_MA_COLORS[2]);
  ok('label 依次 MA10/MA20/MA50', m[0].label === 'MA10' && m[1].label === 'MA20' && m[2].label === 'MA50');
  ok('MA50 在索引 49 起有值', m[2].values[48] === null && typeof m[2].values[49] === 'number');

  // 自定义颜色 / 宽度
  const cu = maRibbon(seq(1, 30), [10, 20], { colors: ['#111', '#222'], widths: [3, 4] });
  ok('自定义 colors 生效', cu[0].color === '#111' && cu[1].color === '#222');
  ok('自定义 widths 生效', cu[0].width === 3 && cu[1].width === 4);

  // period 钳制到最小 1
  const p1 = maRibbon([1, 2, 3], [0]);
  ok('period=0 被钳制为 1', p1[0].period === 1 && p1[0].values[0] === 1 && p1[0].values[2] === 3);

  // 数据不足 → 全 null
  const short = maRibbon([1, 2], [5]);
  ok('数据不足（len<period）→ values 全 null', short[0].values.every((v) => v === null));
  // 空数组 / 非法输入不抛
  ok('空 closes → values 空数组', maRibbon([], [3])[0].values.length === 0);
  ok('periods=[] → 回退默认 5 条', maRibbon(seq(1, 30), []).length === RB_DEFAULTS.periods.length);
  ok('closes=undefined 不抛', (() => { try { return maRibbon(undefined, [3]).length === 1; } catch { return false; } })());
  ok('periods=undefined 不抛且用默认', (() => { try { return maRibbon(seq(1, 30)).length === RB_DEFAULTS.periods.length; } catch { return false; } })());
}

console.log('\n[ribbonOrder: 多头 / 空头 / 纠缠 / 数据不足]');
{
  const mk = (vals) => [
    { label: 'MA10', period: 10, values: [vals[0]] },
    { label: 'MA20', period: 20, values: [vals[1]] },
    { label: 'MA50', period: 50, values: [vals[2]] },
  ];
  const bull = ribbonOrder(mk([10, 9, 8]), 0);
  ok('多头排列 dir=1', bull.dir === 1);
  ok('多头排列 text 含「多头排列」', bull.text.indexOf('多头排列') >= 0);
  ok('多头排列 asc=2/desc=0', bull.asc === 2 && bull.desc === 0);

  const bear = ribbonOrder(mk([8, 9, 10]), 0);
  ok('空头排列 dir=-1', bear.dir === -1);
  ok('空头排列 text 含「空头排列」', bear.text.indexOf('空头排列') >= 0);
  ok('空头排列 asc=0/desc=2', bear.asc === 0 && bear.desc === 2);

  const mix = ribbonOrder(mk([10, 8, 9]), 0);
  ok('纠缠（1 升 1 降）dir=0', mix.dir === 0);
  ok('纠缠 text 含「纠缠」', mix.text.indexOf('纠缠') >= 0);

  const few = ribbonOrder([{ label: 'MA10', period: 10, values: [5] }, { label: 'MA20', period: 20, values: [null] }], 0);
  ok('有值不足 2 条 → dir=0', few.dir === 0);
  ok('有值不足 2 条 → text=数据不足', few.text === '数据不足');
  ok('rows 反映各均线值（null 保留）', few.rows.length === 2 && few.rows[1].v === null);

  // 按 period 升序比较，而非数组顺序
  const unsorted = ribbonOrder([
    { label: 'MA50', period: 50, values: [8] },
    { label: 'MA10', period: 10, values: [10] },
    { label: 'MA20', period: 20, values: [9] },
  ], 0);
  ok('按 period 升序比较（乱序输入仍判多头）', unsorted.dir === 1);
}

console.log('\n[rangeBox: 合成箱体 / 上破 / 下破 / 趋势 / 因果性]');
{
  const up = rangeBox(boxBreakoutSeries());
  ok('箱体检出 ok=true', up.ok === true);
  ok('上沿 top≈102', near(up.top, 102));
  ok('下沿 bottom≈100', near(up.bottom, 100));
  ok('中轴 mid≈101', near(up.mid, 101));
  ok('高度 heightPct≈2', near(up.heightPct, 2));
  ok('箱体根数 bars=60', up.bars === 60);
  ok('i0=0 / i1=59', up.i0 === 0 && up.i1 === 59);
  ok('上破 breakout.dir=up', up.breakout && up.breakout.dir === 'up');
  ok('breakout.i 指向突破根（60）', up.breakout && up.breakout.i === 60);
  ok('breakout.price=105 / level=102', up.breakout && up.breakout.price === 105 && up.breakout.level === 102);
  ok('state=breakout-up', up.state === 'breakout-up');
  ok('posPct=250（收于上沿之上）', near(up.posPct, 250));
  ok('boxEndIdx 延伸到突破根', up.boxEndIdx === 60);
  ok('tTop>0 且 tBot>0', up.tTop > 0 && up.tBot > 0);
  ok('touched 为布尔且为 true', up.touched === true);

  // 因果性硬断言：上下沿只由 [i0,i1] 内数据决定（不含突破根）
  const s = boxBreakoutSeries();
  ok('top === max(highs[i0..i1])', up.top === Math.max(...s.highs.slice(up.i0, up.i1 + 1)));
  ok('bottom === min(lows[i0..i1])', up.bottom === Math.min(...s.lows.slice(up.i0, up.i1 + 1)));
  ok('top < 突破根高点（上沿不含突破后数据）', up.top < s.highs[60]);

  // 下破对称
  const dn = boxBreakoutSeries();
  dn.closes[60] = 97; dn.highs[60] = 98; dn.lows[60] = 96.5;
  const dnBox = rangeBox(dn);
  ok('下破 breakout.dir=down', dnBox.ok && dnBox.breakout && dnBox.breakout.dir === 'down');
  ok('下破 state=breakout-down', dnBox.state === 'breakout-down');
  ok('下破 top/bottom 不变', near(dnBox.top, 102) && near(dnBox.bottom, 100));

  // 箱体内震荡（无突破）→ posPct≈50
  const inside = rangeBox(boxInsideSeries());
  ok('箱体内 ok=true 且无突破', inside.ok === true && inside.breakout === null);
  ok('箱体内 state=inside', inside.state === 'inside');
  ok('箱体内 posPct≈50', near(inside.posPct, 50));
  ok('无突破时 boxEndIdx=last', inside.boxEndIdx === 59);

  // 趋势序列 → ok=false 且有 reason
  const tr = rangeBox(trendSeries());
  ok('趋势序列 ok=false', tr.ok === false);
  ok('趋势序列 reason 存在且含「趋势」', typeof tr.reason === 'string' && tr.reason.indexOf('趋势') >= 0);

  // 数据不足
  const tiny = rangeBox({ closes: seq(1, 21), highs: seq(1, 21).map((v) => v + 0.5), lows: seq(1, 21).map((v) => v - 0.5) });
  ok('数据不足（< minBars+2）ok=false', tiny.ok === false);
  ok('数据不足 reason=数据不足', tiny.reason === '数据不足');

  // 容差收紧 → 同一个横盘序列不成立（高度超限）
  const tight = rangeBox(boxInsideSeries(), { tolPct: 0.5 });
  ok('tolPct=0.5 收紧 → ok=false', tight.ok === false);
  ok('tolPct=0.5 收紧 reason 存在', typeof tight.reason === 'string' && tight.reason.length > 0);

  // 空/脏输入不抛
  ok('rangeBox() 不抛', (() => { try { return rangeBox().ok === false; } catch { return false; } })());
  ok('rangeBox({}) 不抛', (() => { try { return rangeBox({}).ok === false; } catch { return false; } })());
}

console.log('\n[pullbackSignals: 箱体突破回踩]');
{
  const box = pbConfirmedSeries(); box.box = BOX_UP;
  const r2 = pullbackSignals(box, { trendPullback: false });
  ok('确认回踩 → 恰好 1 个信号', r2.signals.length === 1);
  const sig = r2.signals[0];
  ok('信号 type=箱体突破回踩', sig && sig.type === '箱体突破回踩');
  ok('信号 side=long', sig && sig.side === 'long');
  ok('信号 maPeriod>=50', sig && sig.maPeriod >= 50);
  ok('信号 stop<price', sig && sig.stop < sig.price);
  ok('信号 r>0', sig && sig.r > 0);
  ok('t1 = price + r', sig && near(sig.t1, sig.price + sig.r, 1e-9));
  ok('t2 = price + 2r', sig && near(sig.t2, sig.price + 2 * sig.r, 1e-9));
  ok('信号带 visibleAt=i（无前视）', sig && sig.visibleAt === sig.i && sig.i === 62);
  ok('信号 boxed=true 且记录箱体上下沿', sig && sig.boxed === true && sig.boxTop === 102 && sig.boxBottom === 100);
  ok('未跌破防守 → invalidIdx=null', sig && sig.invalidIdx === null);

  // dots：突破点 + 回踩
  ok('dots 含 kind=breakout', r2.dots.some((d) => d.kind === 'breakout'));
  ok('dots 含 kind=pullback', r2.dots.some((d) => d.kind === 'pullback'));
  ok('breakout dot 标签=箱体上破', r2.dots.some((d) => d.kind === 'breakout' && d.label === '箱体上破'));
  ok('dots 按 i 升序', r2.dots.every((d, k) => k === 0 || d.i >= r2.dots[k - 1].i));
}

console.log('\n[pullbackSignals: 待确认 / 下破 / 深度 / 快线 / 冷却 / invalidIdx]');
{
  // 未确认（回踩后收盘仍在均线下方）→ 只出「待确认」，不进 dots
  const un = pbUnconfirmedSeries(); un.box = BOX_UP;
  const ru = pullbackSignals(un, { trendPullback: false });
  ok('未确认 → 产生「待确认」信号', ru.signals.length >= 1 && String(ru.signals[0].type).indexOf('待确认') >= 0);
  ok('「待确认」不进 dots（dots 只有突破点）', ru.dots.every((d) => d.kind !== 'pullback'));

  // 下破对称
  const dn = pbDownSeries(); dn.box = BOX_DN;
  const rd = pullbackSignals(dn, { trendPullback: false });
  const dsig = rd.signals[0];
  ok('下破 → 恰好 1 个信号', rd.signals.length === 1);
  ok('下破信号 side=short', dsig && dsig.side === 'short');
  ok('下破信号 stop>price', dsig && dsig.stop > dsig.price);
  ok('下破 t1<price / t2<t1', dsig && dsig.t1 < dsig.price && dsig.t2 < dsig.t1);
  ok('下破 dots 含箱体下破', rd.dots.some((d) => d.kind === 'breakout' && d.label === '箱体下破'));
  ok('下破 dots 含 pullback', rd.dots.some((d) => d.kind === 'pullback'));

  // 深度过滤（趋势回踩路径）：默认 minDepthAtr=1 出信号，调大到 5 不出
  const t = trendPullbackSeries();
  const rDef = pullbackSignals(t, { trendPullback: true });
  ok('趋势回踩（深度 4×ATR≥1）→ 出信号', rDef.signals.length === 1 && rDef.signals[0].type === '趋势回踩');
  const rDeep = pullbackSignals(t, { trendPullback: true, minDepthAtr: 5 });
  ok('minDepthAtr=5（深度 4 不足）→ 不发信号', rDeep.signals.length === 0);

  // 快线不算回踩：只有 MA20 被触及 → 不发（pullbackMinPeriod=50 跳过 period<50）
  const fast = trendPullbackSeries();
  fast.ribbon = [
    { period: 20, label: 'MA20', values: new Array(70).fill(100) },
    { period: 60, label: 'MA60', values: new Array(70).fill(95) },
  ];
  const rFast = pullbackSignals(fast, { trendPullback: true });
  ok('仅快线（period<50）被触及 → 不发信号', rFast.signals.length === 0);
  // 同一数据把门槛提到 60 → 连 MA50 也不认
  const rHigh = pullbackSignals(trendPullbackSeries(), { trendPullback: true, pullbackMinPeriod: 60 });
  ok('pullbackMinPeriod=60 → MA50 不算回踩，不发信号', rHigh.signals.length === 0);

  // 冷却
  const two = twoPullbacksSeries();
  const rCoolBig = pullbackSignals(two, { trendPullback: true, cool: 1000 });
  ok('cool=1000 → 连续两次回踩只出第一个', rCoolBig.signals.length === 1);
  const rCoolSmall = pullbackSignals(two, { trendPullback: true, cool: 1 });
  ok('cool=1 → 两次回踩都出', rCoolSmall.signals.length === 2);
  ok('冷却保留的是第一个（i=40）', rCoolBig.signals[0].i === 40);

  // invalidIdx
  const inv = twoPullbacksSeries();
  inv.closes[60] = 99.5;   // 收盘跌破 stop=100
  const rInv = pullbackSignals(inv, { trendPullback: true, cool: 1000 });
  ok('信号后收盘跌破 stop → invalidIdx 指向该根', rInv.signals[0] && rInv.signals[0].invalidIdx === 60);
  const rNoInv = pullbackSignals(twoPullbacksSeries(), { trendPullback: true, cool: 1000 });
  ok('未跌破 stop → invalidIdx=null', rNoInv.signals[0] && rNoInv.signals[0].invalidIdx === null);

  // maxSignals 截断
  const many = pullbackSignals(twoPullbacksSeries(), { trendPullback: true, cool: 1, maxSignals: 1 });
  ok('maxSignals=1 截断为 1 个', many.signals.length === 1);

  // 空/脏输入不抛
  ok('pullbackSignals() 不抛且返回空', (() => { try { const x = pullbackSignals(); return x.signals.length === 0 && x.dots.length === 0; } catch { return false; } })());
  ok('pullbackSignals({}) 不抛', (() => { try { return pullbackSignals({}).signals.length === 0; } catch { return false; } })());
  ok('空数组输入不抛', (() => { try { return pullbackSignals({ highs: [], lows: [], closes: [] }).signals.length === 0; } catch { return false; } })());
  ok('ribbon 为空 → 返回空', (() => { try { return pullbackSignals({ highs: seq(1, 40), lows: seq(1, 40), closes: seq(1, 40), ribbon: [] }).signals.length === 0; } catch { return false; } })());
}

console.log('\n[buildMaRibbonBox: 数据不足 / 正常模型 / 不改输入 / 确定性]');
{
  // 数据不足
  const few = buildMaRibbonBox({ closes: seq(1, 29), highs: seq(1, 29), lows: seq(1, 29) });
  ok('closes<30 → ok=false', few.ok === false);
  ok('数据不足 → ribbon=[]', Array.isArray(few.ribbon) && few.ribbon.length === 0);
  ok('数据不足 → box 安全默认', few.box && few.box.ok === false);
  ok('数据不足 → signals/dots 为数组', Array.isArray(few.signals) && Array.isArray(few.dots));
  ok('buildMaRibbonBox() 不抛', (() => { try { return buildMaRibbonBox().ok === false; } catch { return false; } })());

  // 正常模型
  const inp = modelSeries();
  const m = buildMaRibbonBox(inp);
  ok('正常输入 ok=true', m.ok === true);
  ok('n === closes.length', m.n === inp.closes.length);
  ok('last === n-1', m.last === m.n - 1);
  ok('close === closes[last]', m.close === inp.closes[m.last]);
  ok('ribbon.length === periods.length', m.ribbon.length === RB_DEFAULTS.periods.length);
  ok('dist.length === ribbon.length', m.dist.length === m.ribbon.length);
  ok('info.periods 与 ribbon 一致', JSON.stringify(m.info.periods) === JSON.stringify(m.ribbon.map((x) => x.period)));
  ok('info.maType 反映 opts', m.info.maType === 'sma');
  ok('order 为对象且带 dir', m.order && typeof m.order.dir === 'number');
  ok('dist 每项含 label/period/value/pct', m.dist.every((d) => 'label' in d && 'period' in d && 'value' in d && 'pct' in d));
  ok('box.ok=true（合成箱体被检出）', m.box.ok === true);
  ok('info.boxState 反映箱体状态', typeof m.info.boxState === 'string' && m.info.boxState !== 'none');

  // 自定义 periods
  const m3 = buildMaRibbonBox(inp, { periods: [20, 60, 120] });
  ok('自定义 periods → ribbon 3 条', m3.ribbon.length === 3);
  ok('自定义 periods → info.periods=[20,60,120]', JSON.stringify(m3.info.periods) === JSON.stringify([20, 60, 120]));

  // 不修改输入数组
  const before = JSON.stringify({ closes: inp.closes, highs: inp.highs, lows: inp.lows, atr: inp.atr });
  buildMaRibbonBox(inp);
  const after = JSON.stringify({ closes: inp.closes, highs: inp.highs, lows: inp.lows, atr: inp.atr });
  ok('不修改输入数组（调用前后快照一致）', before === after);

  // 确定性（排除 opts 里的共享对象引用）
  const pick = (x) => JSON.stringify({ n: x.n, last: x.last, close: x.close, ribbon: x.ribbon, box: x.box, signals: x.signals, dots: x.dots, order: x.order, dist: x.dist, info: x.info });
  ok('同输入两次调用结果一致（确定性）', pick(buildMaRibbonBox(inp)) === pick(buildMaRibbonBox(inp)));
}

console.log('\n[maRibbonBoxReadout: 数据不足 / 正常 / 箱体 / livePrice / verdict]');
{
  // 数据不足
  const bad = maRibbonBoxReadout({ ok: false });
  ok('ok=false 模型 → readout ok=false', bad.ok === false);
  ok('ok=false → verdict 含「数据不足」', String(bad.verdict).indexOf('数据不足') >= 0);
  ok('ok=false → rows 为数组', Array.isArray(bad.rows));
  ok('maRibbonBoxReadout(null) 不抛', (() => { try { return maRibbonBoxReadout(null).ok === false; } catch { return false; } })());
  ok('maRibbonBoxReadout() 不抛', (() => { try { return maRibbonBoxReadout().ok === false; } catch { return false; } })());

  // 正常模型（有箱体）
  const model = buildMaRibbonBox(modelSeries());
  const rd = maRibbonBoxReadout(model);
  ok('正常模型 readout ok=true', rd.ok === true);
  ok('rows.length>=4', rd.rows.length >= 4);
  ok('每行含 icon/color/label/detail', rd.rows.every((r) => typeof r.icon === 'string' && typeof r.color === 'string' && typeof r.label === 'string' && typeof r.detail === 'string'));
  ok('disclaimer 非空字符串', typeof rd.disclaimer === 'string' && rd.disclaimer.length > 0);
  ok('noTrade 非空字符串', typeof rd.noTrade === 'string' && rd.noTrade.length > 0);
  ok('tone ∈ bull/bear/range', ['bull', 'bear', 'range'].indexOf(rd.tone) >= 0);
  ok('verdict 含「行为级近似」', String(rd.verdict).indexOf('行为级近似') >= 0);
  ok('有箱体 → rows 出现「箱体 ·」', someRow(rd.rows, '箱体 ·'));
  ok('有箱体 → 不是「未检出」', !someRow(rd.rows, '箱体 · 未检出'));
  ok('rows 含诚实声明行', someRow(rd.rows, '未验证'));
  ok('rows 含金点统计行', someRow(rd.rows, '金点'));

  // livePrice
  const withLive = maRibbonBoxReadout(model, { livePrice: 12345.678 });
  ok('livePrice 传入 → price === livePrice', withLive.price === 12345.678);
  const noLive = maRibbonBoxReadout(model);
  ok('未传 livePrice → price === model.close', noLive.price === model.close);
  ok('livePrice 影响 info.px', withLive.info.px === 12345.678);

  // 无箱体模型（趋势序列）
  const noBoxModel = buildMaRibbonBox(trendSeries(), { trendPullback: false });
  ok('趋势序列模型 box.ok=false', noBoxModel.box.ok === false);
  const rdNo = maRibbonBoxReadout(noBoxModel);
  ok('无箱体 → rows 出现「箱体 · 未检出」', someRow(rdNo.rows, '箱体 · 未检出'));
  ok('无箱体 → info.box=null', rdNo.info.box === null);

  // 无信号模型 → rows 出现「信号 · 无」
  ok('无信号模型 → rows 出现「信号 · 无」', someRow(rdNo.rows, '信号 · 无'));
}

console.log(`\n=== maRibbonBox.test: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
