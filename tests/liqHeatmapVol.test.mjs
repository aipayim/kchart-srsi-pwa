// 清算热图（成交量代理 OI）纯函数单元测试（Node 原生，无框架）
// 覆盖：空/单根/NaN 输入安全；清算价公式（多/空各杠杆）；扫价清除方向（下跌清多头/上涨清空头，清掉的量确实消失）；
//       指数衰减单调；因果性（同坐标轴下截断输入，前面列逐位不变）；topZones（score∈[0,100]、lo<hi、=桶边界）；
//       确定性（两次结果逐位相同）；不改输入；sideRatio/levs/colStep；fmtLiqUsd 边界。
import { LH_DEF, volCohorts, liqGrid, zonesAtCol, topZones, fmtLiqUsd, radarModel, fmtLiqRange, clampCardPos } from '../src/engine/liqHeatmapVol.js';

let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log('ok:', name); } else { failed++; console.log('FAIL:', name); } }
const near = (a, b, eps = 1e-6) => typeof a === 'number' && Math.abs(a - b) < eps;

// rows: [{h,l,c,v}] → {o,h,l,c,v,t}（o/t 可选，引擎不用）
function mkBars(rows) {
  const o = [], h = [], l = [], c = [], v = [], t = [];
  rows.forEach((r, i) => {
    o.push(r.o != null ? r.o : r.c);
    h.push(r.h); l.push(r.l); c.push(r.c);
    v.push(r.v != null ? r.v : 1);
    t.push(r.t != null ? r.t : 1_700_000_000_000 + i * 60_000);
  });
  return { o, h, l, c, v, t };
}
function sliceBars(bars, a, b) {
  const out = {};
  ['o', 'h', 'l', 'c', 'v', 't'].forEach((k) => { if (bars[k]) out[k] = bars[k].slice(a, b); });
  return out;
}
const binOf = (res, p) => Math.floor((Math.log(p) - Math.log(res.pLo)) / (Math.log(res.pHi) - Math.log(res.pLo)) * res.bins);
const DOW = { h: 125, l: 75, c: 100, v: 1 };   // 宽幅单根，E=(125+75+100)/3=100，价格轴覆盖 [~75,~125]

// ============ 1) 空 / 单根 / NaN 输入安全 ============
{
  const a = volCohorts(null);
  ok('volCohorts(null) 不抛异常且 bins=180', !!a && a.bins === LH_DEF.bins);
  ok('volCohorts(null).cols=0 且 maxV=0', a.cols === 0 && a.maxV === 0);
  ok('volCohorts(null).liq 长度为 bins', a.liq && a.liq.length === LH_DEF.bins);

  const b = volCohorts({});
  ok('volCohorts({}) 不抛异常 cols=0', !!b && b.cols === 0);

  const c = volCohorts({ c: [] });
  ok('volCohorts(空数组) 不抛异常 cols=0', !!c && c.cols === 0);

  const g = liqGrid(null);
  ok('liqGrid(null) 不抛异常 grid 长度 0', !!g && g.grid.length === 0);
  ok('liqGrid(null).levelsAtCol 可调用且返回空', typeof g.levelsAtCol === 'function' && g.levelsAtCol(0).length === 0);

  const one = mkBars([DOW]);
  const r1 = liqGrid(one);
  ok('单根 → cols=1', r1.cols === 1);
  ok('单根 → grid 长度 = bins', r1.grid.length === r1.bins);
  ok('单根 → maxV>0', r1.maxV > 0);

  const nan = mkBars([
    { h: NaN, l: NaN, c: NaN, v: 1 },
    { h: 125, l: 75, c: 100, v: 1 },
    { h: NaN, l: NaN, c: NaN, v: 1 },
  ]);
  let threw = false; let rn = null;
  try { rn = liqGrid(nan); } catch (e) { threw = true; }
  ok('含 NaN 的输入不抛异常', !threw && !!rn);
  ok('含 NaN 时仍产出 cols=3', rn && rn.cols === 3);

  const allNan = mkBars([{ h: NaN, l: NaN, c: NaN, v: 1 }, { h: NaN, l: NaN, c: NaN, v: 1 }]);
  let threw2 = false; let r2 = null;
  try { r2 = liqGrid(allNan); } catch (e) { threw2 = true; }
  ok('全 NaN 不抛异常（cols=0）', !threw2 && r2 && r2.cols === 0);

  const noV = liqGrid({ h: [125], l: [75], c: [100] });
  ok('缺 v 数组不抛异常且 maxV=0', !!noV && noV.maxV === 0);
}

// ============ 2) 清算价公式（多/空 × 各杠杆） ============
{
  const bars = mkBars([DOW]);            // 单根 → 无衰减、无扫价
  const res = liqGrid(bars, { sideRatio: 0.5 });
  const E = (125 + 75 + 100) / 3;        // 100
  let allLong = true, allShort = true, allMass = true;
  for (const L of LH_DEF.levs) {
    const pL = E * (1 - 1 / L + LH_DEF.mmr);
    const pS = E * (1 + 1 / L - LH_DEF.mmr);
    const bL = binOf(res, pL), bS = binOf(res, pS);
    if (!(res.long[bL] > 0)) allLong = false;
    if (!(res.short[bS] > 0)) allShort = false;
    // 质量 = v(=1) · 典型价 E(=100) · 侧占比(0.5) · w_L（单根、无衰减）
    // 注意：v 是**基础币成交量**，须 ×典型价换算成 USDT 名义（否则卡片会把 BTC 数量显示成 "$73"）
    if (!near(res.long[bL], 1 * E * 0.5 * LH_DEF.wL[L], 1e-4)) allMass = false;
    if (!near(res.short[bS], 1 * E * 0.5 * LH_DEF.wL[L], 1e-4)) allMass = false;
  }
  ok('多头清算价公式命中（各杠杆）', allLong);
  ok('空头清算价公式命中（各杠杆）', allShort);
  ok('建仓质量 = v·典型价·侧占比·w_L（USDT 名义，单根）', allMass);
  // 显式：mass 必须是 USDT 量级，而不是基础币数量（宽幅 bar 才能让清算档落在价格轴内）
  {
    const volBtc = 100, price = 100000;
    const gg = liqGrid({ h: [price * 1.2], l: [price * 0.8], c: [price], v: [volBtc] }, { sideRatio: 0.5, range: [price * 0.6, price * 1.4] });
    ok('mass 为 USDT 名义（100 币 @100000 → 量级 ≫ 1e5，不是 100）', gg.maxV > 1e5);
  }

  // 自定义杠杆档
  const r1lev = liqGrid(bars, { levs: [10], sideRatio: 0.5 });
  ok('levs=[10] → 多头只落在 L10 清算价', r1lev.long[binOf(r1lev, E * 0.904)] > 0);
  const otherBins = LH_DEF.levs.filter((L) => L !== 10).some((L) => r1lev.long[binOf(r1lev, E * (1 - 1 / L + LH_DEF.mmr))] > 0);
  ok('levs=[10] → 其它杠杆档无质量', !otherBins);
}

// ============ 3) 扫价清除方向 ============
{
  const bar0 = DOW;
  const down = { h: 100, l: 80, c: 85, v: 0 };   // 下跌 → 清多头带 [80,100]（v=0 隔离扫价，无新仓补回）
  const full = mkBars([bar0, down]);
  const auto = liqGrid(full);
  const range = { pLo: auto.pLo, pHi: auto.pHi };
  const r1 = liqGrid(mkBars([bar0]), { range });
  const r2 = liqGrid(full, { range });
  const dk = Math.exp(-1 / LH_DEF.decayBars);

  const bLong = binOf(r1, 80.4);      // L5 多头清算价
  const bShort = binOf(r1, 100.4);    // L100 空头清算价（≈100.4）
  ok('下跌前：多头 L5 档有质量', r1.long[bLong] > 0);
  ok('下跌后：多头 L5 档被清除（=0）', r2.long[bLong] === 0);
  ok('下跌前：空头档有质量', r1.short[bShort] > 0);
  ok('下跌不清空头：空头档仍>0', r2.short[bShort] > 0);
  ok('下跌不清空头：空头档 ≈ 衰减后原值', near(r2.short[bShort], r1.short[bShort] * dk, 1e-5));

  const up = { h: 120, l: 100, c: 115, v: 0 };   // 上涨 → 清空头带 [100,120]（v=0 隔离扫价）
  const fullU = mkBars([bar0, up]);
  const autoU = liqGrid(fullU);
  const rangeU = { pLo: autoU.pLo, pHi: autoU.pHi };
  const r1u = liqGrid(mkBars([bar0]), { range: rangeU });
  const r2u = liqGrid(fullU, { range: rangeU });
  const bLongU = binOf(r1u, 80.4);
  const bShortU = binOf(r1u, 100.4);
  ok('上涨前：空头档有质量', r1u.short[bShortU] > 0);
  ok('上涨后：空头档被清除（=0）', r2u.short[bShortU] === 0);
  ok('上涨不清多头：多头档仍>0', r2u.long[bLongU] > 0);
  ok('上涨不清多头：多头档 ≈ 衰减后原值', near(r2u.long[bLongU], r1u.long[bLongU] * dk, 1e-5));

  // 扫价确实减少了总量（多头总量下跌后 < 衰减预期）
  let sum1 = 0, sum2 = 0;
  for (let i = 0; i < r1.bins; i++) sum1 += r1.long[i];
  for (let i = 0; i < r2.bins; i++) sum2 += r2.long[i];
  ok('下跌后多头总量显著减少', sum2 < sum1 * dk * 0.9);
}

// ============ 4) 指数衰减单调 ============
{
  const rows = [DOW];
  for (let i = 1; i < 6; i++) rows.push({ h: 125, l: 75, c: 100, v: 0 });  // v=0：不再建仓；c 不变：不扫价
  const res = liqGrid(mkBars(rows));
  const b = binOf(res, 80.4);
  const vals = [];
  for (let col = 0; col < res.cols; col++) vals.push(res.grid[col * res.bins + b]);
  let mono = true;
  for (let i = 1; i < vals.length; i++) if (!(vals[i] < vals[i - 1])) mono = false;
  ok('无新仓时质量逐列严格递减（衰减单调）', mono);
  const dk = Math.exp(-1 / LH_DEF.decayBars);
  ok('第 1 列 ≈ 第 0 列 × 每 bar 衰减因子', near(vals[1], vals[0] * dk, 1e-6));
  ok('衰减由 decayBars 控制（decayBars=5 衰减更快）', (() => {
    const r5 = liqGrid(mkBars(rows), { decayBars: 5 });
    return r5.grid[5 * r5.bins + binOf(r5, 80.4)] < res.grid[5 * res.bins + b];
  })());
}

// ============ 5) 因果性（同坐标轴下，截断输入前面列逐位不变） ============
{
  // 确定性伪随机序列（无 Math.random）
  const rows = [];
  let p = 100;
  for (let i = 0; i < 10; i++) {
    p = p * (1 + Math.sin(i * 1.7) * 0.01);
    rows.push({ h: p * 1.01, l: p * 0.99, c: p, v: 1 + (i % 3) });
  }
  const bars = mkBars(rows);
  const full = liqGrid(bars);
  const cut = 5;
  const trunc = liqGrid(sliceBars(bars, 0, cut), { range: { pLo: full.pLo, pHi: full.pHi }, bins: full.bins });
  let same = true;
  for (let col = 0; col < cut; col++) {
    for (let b = 0; b < full.bins; b++) {
      if (full.grid[col * full.bins + b] !== trunc.grid[col * trunc.bins + b]) { same = false; break; }
    }
    if (!same) break;
  }
  ok('因果性：截断输入后，前 5 列逐位不变', same);
  ok('因果性：截断输入列数更少', trunc.cols === cut && full.cols === 10);
}

// ============ 6) topZones / zonesAtCol ============
{
  const bars = mkBars([DOW]);
  const res = liqGrid(bars);
  const col = res.cols - 1;
  const zones = zonesAtCol(res, col);
  ok('zonesAtCol 返回非空区间', zones.length >= 2);
  ok('区间 lo<hi', zones.every((z) => z.lo < z.hi));
  ok('区间边界 = 网格桶边界', zones.every((z) => near(z.lo, res.pLo * Math.pow(res.ratio, z.b0), 1e-6) && near(z.hi, res.pLo * Math.pow(res.ratio, z.b1 + 1), 1e-6)));
  ok('区间 score ∈ [0,100]', zones.every((z) => Number.isInteger(z.score) && z.score >= 0 && z.score <= 100));
  ok('levelsAtCol 与 zonesAtCol 一致', res.levelsAtCol(col).length === zones.length);

  const z = topZones(res, col, 100, 2);
  ok('topZones 上方有区间', z.above.length >= 1);
  ok('topZones 下方有区间', z.below.length >= 1);
  ok('topZones 上限 n=2', z.above.length <= 2 && z.below.length <= 2);
  ok('topZones score ∈ [0,100]', z.above.concat(z.below).every((x) => x.score >= 0 && x.score <= 100));
  ok('topZones lo<hi', z.above.concat(z.below).every((x) => x.lo < x.hi));
  ok('上方 distPct>0', z.above.every((x) => x.distPct > 0));
  ok('下方 distPct<0', z.below.every((x) => x.distPct < 0));
  ok('按 mass 降序', z.above.every((x, i) => i === 0 || z.above[i - 1].mass >= x.mass) && z.below.every((x, i) => i === 0 || z.below[i - 1].mass >= x.mass));
  ok('n=1 时每组 ≤1', (() => { const z1 = topZones(res, col, 100, 1); return z1.above.length <= 1 && z1.below.length <= 1; })());
  ok('price=null → 全部归上方', (() => { const zn = topZones(res, col, null, 99); return zn.below.length === 0 && zn.above.length >= 2; })());
  ok('topZones(null) → 空结果', (() => { const e = topZones(null, 0, 100, 2); return e.above.length === 0 && e.below.length === 0; })());
}

// ============ 7) 确定性 + 不修改输入 ============
{
  const rows = [];
  for (let i = 0; i < 8; i++) rows.push({ h: 100 + i, l: 90 - i, c: 95 + (i % 3), v: 1 + i });
  const bars = mkBars(rows);
  const snap = ['o', 'h', 'l', 'c', 'v', 't'].map((k) => bars[k].slice());
  const a = liqGrid(bars);
  const b = liqGrid(bars);
  let bit = a.cols === b.cols && a.grid.length === b.grid.length;
  if (bit) for (let i = 0; i < a.grid.length; i++) if (a.grid[i] !== b.grid[i]) { bit = false; break; }
  ok('确定性：两次结果逐位相同', bit);
  const after = ['o', 'h', 'l', 'c', 'v', 't'].map((k) => bars[k]);
  ok('不修改输入数组', after.every((arr, i) => arr.length === snap[i].length && arr.every((x, j) => x === snap[i][j])));
  const av = volCohorts(bars);
  ok('volCohorts 与 liqGrid 末列一致', (() => {
    const last = a.cols - 1;
    for (let i = 0; i < a.bins; i++) if (a.grid[last * a.bins + i] !== av.liq[i]) return false;
    return true;
  })());
}

// ============ 8) sideRatio / colStep ============
{
  const bars = mkBars([DOW]);
  const allLong = liqGrid(bars, { sideRatio: 1 });
  let shortSum = 0; for (let i = 0; i < allLong.bins; i++) shortSum += allLong.short[i];
  let longSum = 0; for (let i = 0; i < allLong.bins; i++) longSum += allLong.long[i];
  ok('sideRatio=1 → 无空头质量', shortSum === 0);
  ok('sideRatio=1 → 有多头质量', longSum > 0);
  const allShort = liqGrid(bars, { sideRatio: 0 });
  let l2 = 0; for (let i = 0; i < allShort.bins; i++) l2 += allShort.long[i];
  ok('sideRatio=0 → 无多头质量', l2 === 0);

  const many = mkBars(Array.from({ length: 6 }, () => ({ h: 125, l: 75, c: 100, v: 1 })));
  const cs2 = liqGrid(many, { colStep: 2 });
  ok('colStep=2 → cols=3', cs2.cols === 3);
  ok('colStep=2 → grid 长度 = cols*bins', cs2.grid.length === 3 * cs2.bins);
  const cs1 = liqGrid(many, { colStep: 1 });
  ok('colStep=1 → cols=6', cs1.cols === 6);
}

// ============ 9) fmtLiqUsd 边界 ============
{
  ok('fmtLiqUsd(null) → --', fmtLiqUsd(null) === '--');
  ok('fmtLiqUsd(NaN) → --', fmtLiqUsd(NaN) === '--');
  ok('fmtLiqUsd(0) → $0.00', fmtLiqUsd(0) === '$0.00');
  ok('fmtLiqUsd(999) → $999', fmtLiqUsd(999) === '$999');
  ok('fmtLiqUsd(1234) → $1.2K', fmtLiqUsd(1234) === '$1.2K');
  ok('fmtLiqUsd(1.2e6) → $1.20M', fmtLiqUsd(1.2e6) === '$1.20M');
  ok('fmtLiqUsd(1.2e9) → $1.20B', fmtLiqUsd(1.2e9) === '$1.20B');
  ok('fmtLiqUsd(-5000) → -$5.0K', fmtLiqUsd(-5000) === '-$5.0K');
}

// ============ 10) radarModel（清算雷达数据源） ============
// 手工构造可控网格：bins=10，pLo=100 / pHi=200（ratio=2^(1/10)），单列 col=0
const RB = 2 ** (1 / 10);
function mkRes(gridVals, cols = 1, bins = 10, pLo = 100, pHi = 200) {
  return {
    cols, bins, pLo, pHi,
    ratio: Math.exp((Math.log(pHi) - Math.log(pLo)) / bins),
    grid: Float32Array.from(gridVals),
    maxV: Math.max(0, ...gridVals),
  };
}
const bucketMid = (b) => Math.sqrt(100 * RB ** b * 100 * RB ** (b + 1));
{
  // 档位：b0=5（下方） b2=3（下方） b5=8（上方） b9=2（上方）；price=130
  const res = mkRes([5, 0, 3, 0, 0, 8, 0, 0, 0, 2]);
  const r = radarModel(res, 0, 130, { n: 3 });
  ok('radarModel 返回 price', r.price === 130);
  ok('radarModel 分组：up 2 条 / down 2 条', r.up.length === 2 && r.down.length === 2);
  ok('radarModel 按 mass 降序 + rank 1..n', r.up[0].mass === 8 && r.up[0].rank === 1 && r.up[1].rank === 2);
  ok('radarModel 上方第一条 = b5（质量最大）', near(r.up[0].lo, 100 * RB ** 5) && near(r.up[0].hi, 100 * RB ** 6));
  ok('radarModel 下方第一条 = b0（质量 5 > 3）', r.down[0].mass === 5 && r.down[0].rank === 1);
  ok('radarModel nearest 标记 = 组内距离最近（上方 b5 / 下方 b2）', r.up[0].nearest === true && r.up[1].nearest === false && r.down[0].nearest === false && r.down[1].nearest === true);
  ok('radarModel nearUp = 距离最近（b5）', r.nearUp && r.nearUp.mass === 8);
  ok('radarModel nearDown = 距离最近（b2，不是 mass 最大的 b0）', r.nearDown && r.nearDown.mass === 3 && near(r.nearDown.lo, 100 * RB ** 2));
  ok('radarModel distPct 符号：上方为正 / 下方为负', r.up[0].distPct > 0 && r.down[0].distPct < 0);
  ok('radarModel distPct 数值 = (中点-价)/价*100', near(r.up[0].distPct, (bucketMid(5) - 130) / 130 * 100, 1e-9));
  ok('radarModel maxMass/totalMass', r.maxMass === 8 && near(r.totalMass, 18, 1e-9));
  ok('radarModel score ∈ [0,100] 且相对 maxV', r.up[0].score === 100 && r.down[0].score === Math.round(5 / 8 * 100));
  ok('radarModel score 下限（小质量不为负）', r.down[1].score >= 0 && r.down[1].score <= 100);
  // n=1 时 near 仍独立于前 n 条
  const r1 = radarModel(res, 0, 130, { n: 1 });
  ok('radarModel n=1 → up/down 各 1 条', r1.up.length === 1 && r1.down.length === 1);
  ok('radarModel n=1 时 nearDown 仍为距离最近的 b2', r1.nearDown && r1.nearDown.mass === 3);
  ok('radarModel 默认 n=3', radarModel(res, 0, 130).up.length === 2);   // 仅 2 个上方档位
  // 空 / 越界 / 非法价
  const e0 = radarModel(null, 0, 130);
  ok('radarModel(null) → 空结构', e0.up.length === 0 && e0.down.length === 0 && e0.nearUp === null && e0.nearDown === null && e0.maxMass === 0 && e0.totalMass === 0);
  const e1 = radarModel(res, 5, 130);
  ok('radarModel col 越界 → 空结构', e1.up.length === 0 && e1.down.length === 0 && e1.nearUp === null);
  const e2 = radarModel(res, -1, 130);
  ok('radarModel col=-1 → 空结构', e2.up.length === 0 && e2.nearUp === null);
  const e3 = radarModel(res, 0, 0);
  ok('radarModel price=0 → 空结构', e3.up.length === 0 && e3.nearUp === null);
  const e4 = radarModel(res, 0, NaN);
  ok('radarModel price=NaN → 空结构', e4.up.length === 0 && e4.nearDown === null);
  const e5 = radarModel(res, 0, 130);
  ok('radarModel 不抛异常且不改输入', e5.up.length === 2 && res.grid[5] === 8);
}

// ============ 11) fmtLiqRange ============
{
  ok('fmtLiqRange 千分位', fmtLiqRange(84786, 85002) === '84,786 – 85,002');
  ok('fmtLiqRange 四舍五入', fmtLiqRange(84786.4, 85002.6) === '84,786 – 85,003');
  ok('fmtLiqRange lo>hi 自动交换', fmtLiqRange(85002, 84786) === '84,786 – 85,002');
  ok('fmtLiqRange 小数值', fmtLiqRange(0.5, 1.4) === '1 – 1');
  ok('fmtLiqRange 非法 NaN → --', fmtLiqRange(NaN, 100) === '--');
  ok('fmtLiqRange 非法 null → --', fmtLiqRange(null, undefined) === '--');
  ok('fmtLiqRange 负值千分位', fmtLiqRange(-1234, -9876) === '-9,876 – -1,234');
}

// ============ 12) clampCardPos（拖拽钳位纯函数） ============
{
  const p = clampCardPos(100, 60, 180, 120, 800, 600);
  ok('clampCardPos 正常位置原样返回', p.x === 100 && p.y === 60);
  const l = clampCardPos(-50, -30, 180, 120, 800, 600);
  ok('clampCardPos 左上越界 → 贴 4px', l.x === 4 && l.y === 4);
  const rb = clampCardPos(9999, 9999, 180, 120, 800, 600);
  ok('clampCardPos 右下越界 → 贴容器内边距', rb.x === 800 - 180 - 4 && rb.y === 600 - 120 - 4);
  const small = clampCardPos(50, 50, 900, 700, 800, 600);
  ok('clampCardPos 容器小于卡片 → 贴左上', small.x === 4 && small.y === 4);
  const bad = clampCardPos(NaN, 1, 10, 10, 100, 100);
  ok('clampCardPos 非法输入 → {4,4}', bad.x === 4 && bad.y === 4);
  const bad2 = clampCardPos('a', 1, 10, 10, 100, 100);
  ok('clampCardPos 非数字 → {4,4}', bad2.x === 4 && bad2.y === 4);
}

console.log(`\n=== liqHeatmapVol.test: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
