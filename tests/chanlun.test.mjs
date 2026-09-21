// 缠论引擎单元测试（Node 原生，无框架）
// 覆盖：normalizeBars / sliceUpTo / mergeInclusion(包含处理) / detectFractals(分型+confirmedAt) /
//       buildBi(新笔/老笔、交替、finalAt) / buildSegments / detectCenters( first3/all、延伸、ZG/ZD) /
//       classifyTrend / detectDivergence(macd/slope) / detectBsp(一/二/三买) /
//       buildChanlun 端到端不变量 / chanPhantomRate(幻影信号率) / chanCausalityProbe(无前视)。
import {
  CHAN_DEFAULTS, normalizeBars, sliceUpTo, mergeInclusion, detectFractals, buildBi,
  buildSegments, detectCenters, classifyTrend, detectDivergence, detectBsp,
  buildChanlun, chanPhantomRate, chanCausalityProbe,
} from '../src/engine/chanlun.js';

let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log('ok:', name); } else { failed++; console.log('FAIL:', name); } }
const near = (a, b, eps = 1e-9) => typeof a === 'number' && Math.abs(a - b) < eps;

// 手工构造合并K线（绕过包含处理，便于精确断言）
const M = (h, l, i) => ({ h, l, i0: i, i1: i, hiIdx: i, loIdx: i, dir: 0 });

// 一个规则锯齿：顶在 3/11/19/27，底在 7/15/23（端点间隔均为 4）
const ZIG = [
  M(1, 0, 0), M(2, 1, 1), M(3, 2, 2), M(4, 3, 3),
  M(3, 2, 4), M(2, 1, 5), M(1, 0, 6), M(0.5, -0.5, 7),
  M(1, 0, 8), M(2, 1, 9), M(3, 2, 10), M(4, 3, 11),
  M(3, 2, 12), M(2, 1, 13), M(1, 0, 14), M(0.5, -0.5, 15),
  M(1, 0, 16), M(2, 1, 17), M(3, 2, 18), M(4, 3, 19),
  M(3, 2, 20), M(2, 1, 21), M(1, 0, 22), M(0.5, -0.5, 23),
  M(1, 0, 24), M(2, 1, 25), M(3, 2, 26), M(4, 3, 27), M(3, 2, 28),
];

// 合成行情：趋势 + 盘整 + 趋势（用于端到端）
function synthCloses(n = 600) {
  const out = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const seg = Math.floor(i / 200);
    const drift = seg === 0 ? 0.35 : seg === 1 ? 0.02 : -0.30;
    p = Math.max(5, p + drift + Math.sin(i / 6) * 0.9 + Math.sin(i / 23) * 0.4);
    out.push(+p.toFixed(4));
  }
  return out;
}
function ohlcFromCloses(closes) {
  return {
    opens: closes.map((v, i) => (i ? closes[i - 1] : v)),
    highs: closes.map((v) => v + 0.5),
    lows: closes.map((v) => v - 0.5),
    closes,
    vols: closes.map(() => 100),
    times: closes.map((_, i) => i * 3600_000),
  };
}

// ---------- 0. normalizeBars / sliceUpTo ----------
{
  const a = normalizeBars({ opens: [1, 2], highs: [2, 3], lows: [0, 1], closes: [1.5, 2.5] });
  ok('normalizeBars: 对象形式', a.n === 2 && a.h[1] === 3 && a.l[0] === 0 && a.c[1] === 2.5);
  const b = normalizeBars([[1000, 1, 2, 0, 1.5, 7], [2000, 2, 3, 1, 2.5, 8]]);
  ok('normalizeBars: 数组形式([t,o,h,l,c,v])', b.n === 2 && b.t[1] === 2000 && b.v[0] === 7 && b.c[1] === 2.5);
  const c = normalizeBars([{ o: 1, h: 2, l: 0, c: 1.5, v: 3, t: 9 }]);
  ok('normalizeBars: 对象数组', c.n === 1 && c.t[0] === 9 && c.v[0] === 3);
  ok('normalizeBars: 空输入不抛', normalizeBars(null).n === 0 && normalizeBars({}).n === 0);
  const s = sliceUpTo(a, 0);
  ok('sliceUpTo: 截断到 asOf', s.n === 1 && s.c[0] === 1.5 && s.h.length === 1);
  ok('sliceUpTo: asOf 超界不抛', sliceUpTo(a, 99).n === 2 && sliceUpTo(a, -5).n === 0);
}

// ---------- 1. mergeInclusion（包含处理，✅ 确定性）----------
{
  const m = mergeInclusion([10, 12, 11, 15], [5, 6, 7, 8]);
  ok('包含处理: 第二三根合并 → 3 根', m.length === 3);
  ok('包含处理: 合并后低点取高(向上)', near(m[1].l, 7) && near(m[1].h, 12));
  ok('包含处理: 覆盖区间 i0/i1 正确', m[1].i0 === 1 && m[1].i1 === 2);
  ok('包含处理: hiIdx/loIdx 指向真实极值', m[1].hiIdx === 1 && m[1].loIdx === 2);
  // 下降方向：低点取低、高点取低
  const d = mergeInclusion([15, 11, 12, 8], [8, 7, 6, 5]);
  ok('包含处理: 下降方向合并', d.length === 3 && near(d[1].h, 11) && near(d[1].l, 6));
  ok('包含处理: 空输入不抛', mergeInclusion([], []).length === 0);
  const flat = mergeInclusion([5, 5, 5, 5], [1, 1, 1, 1]);
  ok('包含处理: 全等 K 线合并为 1 根', flat.length === 1);
}

// ---------- 2. detectFractals（分型 + confirmedAt，✅ 确定性）----------
{
  const fr = detectFractals(ZIG);
  const types = fr.map((f) => `${f.type}@${f.mi}`).join(',');
  ok('分型: 序列正确(顶3/底7/顶11/底15/顶19/底23/顶27)',
    types === 'top@3,bottom@7,top@11,bottom@15,top@19,bottom@23,top@27');
  const top3 = fr.find((f) => f.mi === 3);
  ok('分型: 价格取极值', near(top3.price, 4));
  ok('分型: confirmedAt = 右侧合并K线冻结时刻(i0 of m[i+2])', top3.confirmedAt === 5);
  const top27 = fr.find((f) => f.mi === 27);
  ok('分型: 最后一根分型尚未确认 → confirmedAt=null', top27.confirmedAt === null);
  ok('分型: 全部 confirmedAt 均为 null 或非负', fr.every((f) => f.confirmedAt === null || f.confirmedAt >= 0));
}

// ---------- 3. buildBi（新笔/老笔、交替、finalAt）----------
{
  const fr = detectFractals(ZIG);
  const bisNew = buildBi(fr, ZIG, { biMode: 'new' });
  ok('笔(新笔, 端点距>=4): 6 笔', bisNew.length === 6);
  ok('笔: 方向严格交替', bisNew.every((b, i) => i === 0 || b.dir !== bisNew[i - 1].dir));
  ok('笔: 首笔为下跌(顶3→底7)', bisNew[0].dir === 'down' && bisNew[0].startIdx === 3 && bisNew[0].endIdx === 7);
  ok('笔: high/low 与端分型一致', near(bisNew[0].high, 4) && near(bisNew[0].low, -0.5));
  const bisOld = buildBi(fr, ZIG, { biMode: 'old' });
  ok('笔(老笔, 端点距>=5): 更少笔', bisOld.length === 2 && bisOld.length < bisNew.length);
  // finalAt：一笔只有在「下一笔」出现后才定稿
  ok('笔: 非末笔 finalAt = 下一笔 confirmedAt', bisNew[0].finalAt === bisNew[1].confirmedAt && bisNew[0].final === true);
  ok('笔: 末笔永远未定稿', bisNew[bisNew.length - 1].finalAt === null && bisNew[bisNew.length - 1].final === false);
  ok('笔: 空输入不抛', buildBi([], []).length === 0);
}

// ---------- 4. buildSegments（>=3 笔）----------
{
  const fr = detectFractals(ZIG);
  const bis = buildBi(fr, ZIG, { biMode: 'new' });
  const segs = buildSegments(bis, {});
  ok('线段: 至少 3 笔才成段', segs.every((s) => s.nBis >= 3));
  ok('线段: 标记为近似实现(approx)', segs.every((s) => s.approx === true));
  ok('线段: 方向合法', segs.every((s) => s.dir === 'up' || s.dir === 'down'));
  ok('线段: 空输入不抛', buildSegments([]).length === 0);
}

// ---------- 5. detectCenters（first3 / all / 延伸 / ZG-ZD）----------
{
  const moves = [
    { dir: 'up', high: 10, low: 1, startIdx: 0, endIdx: 2, confirmedAt: 2 },
    { dir: 'down', high: 8, low: 2, startIdx: 2, endIdx: 4, confirmedAt: 4 },
    { dir: 'up', high: 9, low: 3, startIdx: 4, endIdx: 6, confirmedAt: 6 },
    { dir: 'down', high: 11, low: 4, startIdx: 6, endIdx: 8, confirmedAt: 8 },
    { dir: 'up', high: 12, low: 5, startIdx: 8, endIdx: 10, confirmedAt: 10 },
  ];
  const zs = detectCenters(moves, { zsGate: 'first3' });
  ok('中枢: 形成 1 个', zs.length === 1);
  ok('中枢: ZG=前三段高点最小值=8', near(zs[0].zg, 8));
  ok('中枢: ZD=前三段低点最大值=3', near(zs[0].zd, 3));
  ok('中枢: GG/DD 取全区间', near(zs[0].gg, 12) && near(zs[0].dd, 1));
  ok('中枢: 延伸并入全部重叠段(nMoves=5)', zs[0].nMoves === 5 && zs[0].endMove === 4);
  ok('中枢: 成立时刻 = 第 minN 段确认', zs[0].confirmedAt === 6);
  const zsAll = detectCenters(moves, { zsGate: 'all' });
  ok('中枢: all 口径 ZG/ZD 与 first3 不同', zsAll.length === 1 && (zsAll[0].zg !== zs[0].zg || zsAll[0].zd !== zs[0].zd));
  // 无重叠 → 不构成中枢
  const flat = detectCenters([
    { dir: 'up', high: 10, low: 9, startIdx: 0, endIdx: 1, confirmedAt: 1 },
    { dir: 'down', high: 20, low: 19, startIdx: 1, endIdx: 2, confirmedAt: 2 },
    { dir: 'up', high: 30, low: 29, startIdx: 2, endIdx: 3, confirmedAt: 3 },
  ], {});
  ok('中枢: 无重叠区间 → 不构成', flat.length === 0);
  ok('中枢: 空输入不抛', detectCenters([]).length === 0);
}

// ---------- 6. classifyTrend ----------
{
  ok('走势: 无中枢 → range', classifyTrend([]).type === 'range');
  ok('走势: 1 个中枢 → 盘整', classifyTrend([{ zg: 8, zd: 3 }]).type === 'range');
  const up = classifyTrend([{ zg: 8, zd: 3 }, { zg: 18, zd: 12 }]);
  ok('走势: 两个上移不重叠中枢 → 上涨', up.type === 'up' && up.dir === 1);
  const down = classifyTrend([{ zg: 18, zd: 12 }, { zg: 8, zd: 3 }]);
  ok('走势: 两个下移不重叠中枢 → 下跌', down.type === 'down' && down.dir === -1);
}

// ---------- 7. detectDivergence（slope / macd）----------
{
  const closes = new Array(41).fill(0);
  closes[0] = 0; closes[10] = 10;           // 第一段上涨力度 = 10/11
  closes[20] = 10; closes[40] = 15;         // 第二段创新高但力度 = 5/21（更小）
  const bis = [
    { dir: 'up', startIdx: 0, endIdx: 10, high: 10, low: 0, confirmedAt: 10, finalAt: 12, final: true },
    { dir: 'down', startIdx: 10, endIdx: 20, high: 10, low: 8, confirmedAt: 20, finalAt: 22, final: true },
    { dir: 'up', startIdx: 20, endIdx: 40, high: 15, low: 10, confirmedAt: 40, finalAt: null, final: false },
  ];
  const dv = detectDivergence(closes, bis, { divMeasure: 'slope', divRatio: 1 });
  ok('背驰(slope): 检出 1 个顶背驰', dv.length === 1 && dv[0].kind === 'top');
  ok('背驰: 指向后一笔且力度更小', dv[0].bi === 2 && dv[0].power < dv[0].prevPower);
  ok('背驰: ratio 记录', near(dv[0].ratio, dv[0].power / dv[0].prevPower));
  // 不创新高 → 无背驰
  const bis2 = [bis[0], bis[1], { ...bis[2], high: 5 }];
  ok('背驰: 未创新极值 → 不触发', detectDivergence(closes, bis2, { divMeasure: 'slope' }).length === 0);
  // macd 口径可运行且返回 measure
  const dvM = detectDivergence(closes, bis, { divMeasure: 'macd' });
  ok('背驰(macd): 可运行且标记 measure', dvM.every((d) => d.measure === 'macd'));
  ok('背驰: 空输入不抛', detectDivergence([], []).length === 0);
}

// ---------- 8. detectBsp（三买 / 一买 / 二买）----------
{
  const z = { zg: 100, zd: 90, gg: 105, dd: 88, startMove: 0, endMove: 2, confirmedAt: 6, finalAt: 10, final: true };
  const bis = [
    { dir: 'up', high: 105, low: 88, startIdx: 0, endIdx: 2, confirmedAt: 2, finalAt: 6, final: true },
    { dir: 'down', high: 104, low: 91, startIdx: 2, endIdx: 4, confirmedAt: 4, finalAt: 8, final: true },
    { dir: 'up', high: 101, low: 92, startIdx: 4, endIdx: 6, confirmedAt: 6, finalAt: 10, final: true },
    { dir: 'up', high: 120, low: 95, startIdx: 6, endIdx: 8, highIdx: 8, lowIdx: 6, confirmedAt: 8, finalAt: 12, final: true },
    { dir: 'down', high: 118, low: 102, startIdx: 8, endIdx: 10, highIdx: 8, lowIdx: 10, confirmedAt: 10, finalAt: 14, final: true },
  ];
  const sigs = detectBsp(bis, [z], [], {});
  const t3 = sigs.find((s) => s.kind === '3b');
  ok('买卖点: 三买触发', !!t3 && t3.side === 'long' && near(t3.price, 102));
  ok('买卖点: 三买 naiveAt=回抽低点 bar', t3.naiveAt === 10);
  ok('买卖点: 三买 finalAt 取相关对象最大 finalAt', t3.finalAt === 14 && t3.final === true);
  // 回抽跌破中枢 → 不是三买
  const bis2 = bis.slice(0, 4).concat([{ ...bis[4], low: 95 }]);
  ok('买卖点: 回抽回中枢 → 不构成三买', !detectBsp(bis2, [z], [], {}).some((s) => s.kind === '3b'));
  // 一买：跌破最后中枢 + 底背驰
  const bis3 = [
    { dir: 'up', high: 105, low: 88, startIdx: 0, endIdx: 2, confirmedAt: 2, finalAt: 6, final: true },
    { dir: 'down', high: 104, low: 91, startIdx: 2, endIdx: 4, confirmedAt: 4, finalAt: 8, final: true },
    { dir: 'up', high: 101, low: 92, startIdx: 4, endIdx: 6, confirmedAt: 6, finalAt: 10, final: true },
    { dir: 'down', high: 100, low: 70, startIdx: 6, endIdx: 10, lowIdx: 10, highIdx: 6, confirmedAt: 10, finalAt: 16, final: true },
  ];
  const dv = [{ bi: 3, dir: 'down', kind: 'bottom', idx: 10, price: 70, measure: 'slope', ratio: 0.5, confirmedAt: 10, finalAt: 16, final: true }];
  const one = detectBsp(bis3, [z], dv, {}).find((s) => s.kind === '1b');
  ok('买卖点: 一买触发(跌破中枢+底背驰)', !!one && one.side === 'long' && near(one.price, 70));
  // 二买：一买后回调不破前低
  const bis4 = bis3.concat([
    { dir: 'up', high: 85, low: 70, startIdx: 10, endIdx: 12, confirmedAt: 12, finalAt: 18, final: true },
    { dir: 'down', high: 84, low: 74, startIdx: 12, endIdx: 14, lowIdx: 14, highIdx: 12, confirmedAt: 14, finalAt: 20, final: true },
  ]);
  const two = detectBsp(bis4, [z], dv, {}).find((s) => s.kind === '2b');
  ok('买卖点: 二买触发(回调不破一买低点)', !!two && near(two.price, 74));
  ok('买卖点: 空输入不抛', detectBsp([], [], []).length === 0);
}

// ---------- 9. buildChanlun 端到端 ----------
{
  const closes = synthCloses(600);
  const res = buildChanlun(ohlcFromCloses(closes), { biMode: 'new' });
  ok('buildChanlun: ok 且各层非空', res.ok && res.merged.length > 0 && res.bis.length > 0 && res.centers.length > 0);
  ok('buildChanlun: meta 记录配置', res.meta.biMode === 'new' && res.meta.divMeasure === 'macd');
  ok('buildChanlun: 笔方向交替', res.bis.every((b, i) => i === 0 || b.dir !== res.bis[i - 1].dir));
  ok('buildChanlun: 中枢 ZG>ZD', res.centers.every((z) => z.zg > z.zd));
  ok('buildChanlun: 中枢 GG>=ZG 且 DD<=ZD', res.centers.every((z) => z.gg >= z.zg && z.dd <= z.zd));
  // 无前视不变量：所有 confirmedAt 必须 <= 最后一根 bar
  const allConf = [...res.fractals, ...res.bis, ...res.centers, ...res.segs].map((x) => x.confirmedAt).filter((v) => v != null);
  ok('buildChanlun: confirmedAt 全部落在数据范围内(无前视)', allConf.every((v) => v >= 0 && v <= closes.length - 1));
  // causal 信号是 naive 的子集
  ok('buildChanlun: signalsCausal ⊆ signals',
    res.signalsCausal.every((s) => res.signals.some((t) => t.kind === s.kind && t.idx === s.idx)));
  ok('buildChanlun: 数据不足 → ok=false 不抛', buildChanlun({ closes: [1, 2, 3] }).ok === false);
  ok('buildChanlun: 空输入不抛', buildChanlun({}).ok === false);
  // 配置切换不抛且改变结果
  const oldRes = buildChanlun(ohlcFromCloses(closes), { biMode: 'old', zsGate: 'all', useSegForZs: true, divMeasure: 'slope' });
  ok('buildChanlun: 切换全部选项可运行', oldRes.ok && oldRes.meta.biMode === 'old' && oldRes.meta.zsGate === 'all' && oldRes.meta.divMeasure === 'slope');
  ok('buildChanlun: 老笔的笔数 <= 新笔', oldRes.bis.length <= res.bis.length);
}

// ---------- 10. chanPhantomRate（核心研究工具）----------
{
  const res = buildChanlun(ohlcFromCloses(synthCloses(600)));
  const ph = chanPhantomRate(ohlcFromCloses(synthCloses(600)));
  ok('幻影率: ok 且 total = 信号数', ph.ok && ph.total === res.signals.length);
  ok('幻影率: phantom + real = total', ph.phantom + ph.real === ph.total);
  ok('幻影率: 取值在 [0,1]', ph.phantomRate >= 0 && ph.phantomRate <= 1);
  ok('幻影率: byKind 覆盖全部信号种类', Object.values(ph.byKind).reduce((a, k) => a + k.total, 0) === ph.total);
  ok('幻影率: 有真实可得信号时给出 lag 分布', ph.lag == null || (ph.lag.p50 >= 0 && ph.lag.max >= ph.lag.p50));
  ok('幻影率: lagDetect <= lagLabel（实时口径延迟更小）', ph.lag == null || ph.lagDetect == null || ph.lagDetect.p50 <= ph.lag.p50);
  ok('幻影率: 延迟分桶覆盖全部信号', Object.values(ph.buckets).reduce((a, b) => a + b, 0) === ph.total);
  ok('幻影率: realtimePhantomRate 在 [0,1]', ph.realtimePhantomRate >= 0 && ph.realtimePhantomRate <= 1);
  // 逐 bar 截断交叉校验（硬幻影）
  const ph2 = chanPhantomRate(ohlcFromCloses(synthCloses(300)), { sample: 40 });
  ok('幻影率: sample>0 时给出 verified 校验', ph2.verified && ph2.verified.checked > 0 && ph2.verified.disappearedRate >= 0);
  // 关键性质：未定稿的笔产生的信号必然是幻影（naiveAt < finalAt 或 finalAt=null）
  const unfinal = res.signals.filter((s) => !s.final);
  ok('幻影率: 未定稿信号计入 phantom', unfinal.length === 0 || unfinal.every((s) => !(s.finalAt != null && s.finalAt <= s.naiveAt)));
  ok('幻影率: 每个信号都有 naiveAt/detectAt/finalAt 三时刻',
    res.signals.every((s) => typeof s.naiveAt === 'number' && (s.detectAt == null || s.detectAt >= s.naiveAt) && (s.finalAt == null || s.finalAt >= s.detectAt)));
  ok('幻影率: 数据不足 → ok=false 不抛', chanPhantomRate({ closes: [1, 2, 3] }).ok === false);
  ok('幻影率: 空输入不抛', chanPhantomRate({}).phantomRate === 0);
  ok('幻影率: 空输入 verified 为 null', chanPhantomRate({}, { sample: 10 }).verified === null);
}

// ---------- 11. chanCausalityProbe（逐 bar 截断，无前视校验）----------
{
  const bars = normalizeBars(ohlcFromCloses(synthCloses(400)));
  const probe = chanCausalityProbe(bars, [50, 150, 250, 350], {});
  ok('截断探针: 每个 asOf 一条记录', probe.length === 4 && probe.every((p) => p.asOf >= 50));
  ok('截断探针: 数据够时 ok=true', probe.filter((p) => p.asOf >= 150).every((p) => p.ok === true));
  // 截断后所有对象的 confirmedAt 必须 <= asOf（真正的无前视校验）
  let violated = 0;
  for (const p of probe) {
    const r = buildChanlun(sliceUpTo(bars, p.asOf), {});
    const conf = [...r.fractals, ...r.bis, ...r.centers].map((x) => x.confirmedAt).filter((v) => v != null);
    if (!conf.every((v) => v <= p.asOf)) violated++;
  }
  ok('截断探针: 无任何对象越过 asOf（无前视）', violated === 0);
  ok('截断探针: 非法 asOf 被忽略', chanCausalityProbe(bars, [null, -1, 5, 'x']).length === 0);
  ok('截断探针: 空列表不抛', chanCausalityProbe(bars, []).length === 0);
}

// ---------- 12. CHAN_DEFAULTS 形状 ----------
{
  ok('默认配置: 全部选择点显式化',
    CHAN_DEFAULTS.biMode === 'new' && CHAN_DEFAULTS.segMode === 'simple' &&
    CHAN_DEFAULTS.zsGate === 'first3' && CHAN_DEFAULTS.divMeasure === 'macd');
  ok('默认配置: 显示层默认关闭', CHAN_DEFAULTS.on === false);
  ok('默认配置: 各层显示开关存在', ['showBi', 'showSeg', 'showZs', 'showDiv', 'showBsp', 'showTrend'].every((k) => typeof CHAN_DEFAULTS[k] === 'boolean'));
}

console.log(`\n=== chanlun.test: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
