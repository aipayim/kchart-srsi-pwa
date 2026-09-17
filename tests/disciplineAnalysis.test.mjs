// 交易纪律方向因子消融 · 共享分析核心单元测试
// 覆盖 parseJsonl / dedupeRows / decorrelate / coverageMatrix / buildAblation
import { parseJsonl, dedupeRows, decorrelate, buildAblation, coverageMatrix, MIN_SAMPLE, REGIMES, DIRS, extractDisciplineFactors, trainTsevWeights, voteTsev, TSEV_CFG, wilsonShrink, trainTsevWeightsStats, forwardAccuracy, decayStats } from '../src/engine/disciplineAnalysis.js';

let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log('ok:', name); } else { failed++; console.log('FAIL:', name); } }
function mk(sym, ts, dir, regime, over = {}) {
  return { sym, ts, dir, regime: regime || 'trend-up',
    strategy: 'energy-leader', verdict: '分歧', leadScore: 60, leadIsClear: true,
    cFresh: 5, cIsHook: false, cConfirmed: false, atrPct: 0.5, trendUp: true, trendFlat: false,
    result: 1, pnlPct: 0.1, ...over };
}

// ---- parseJsonl ----
{
  const txt = JSON.stringify(mk('a', 't1', 'buy')) + '\n' + JSON.stringify(mk('b', 't2', 'sell')) + '\n\nbad line\n';
  const rows = parseJsonl(txt);
  ok('parseJsonl 解析有效行', rows.length === 2);
  ok('parseJsonl 跳过坏行', rows.every(r => r.sym && r.dir));
  ok('parseJsonl 空输入→[]', parseJsonl('').length === 0);
}

// ---- dedupeRows (同 sym,ts 去重留最新) ----
{
  const a1 = mk('a', 't1', 'buy', 'trend-up', { result: -1 });
  const a2 = mk('a', 't1', 'buy', 'trend-up', { result: 1 });   // 同 key 更新版
  const b = mk('b', 't2', 'sell');
  const d = dedupeRows([a1, b, a2]);
  ok('dedupe 同(sym,ts)合并', d.length === 2);
  ok('dedupe 保留后者(最新)', d.find(r => r.sym === 'a').result === 1);
}

// ---- decorrelate (连续同向 run 折叠) ----
{
  // 同一 sym: buy,buy,buy,sell,buy → runs: buy(3), sell(1), buy(1)
  const rows = [
    mk('a', 't1', 'buy', 'trend-up', { result: 1 }),
    mk('a', 't2', 'buy', 'trend-up', { result: -1 }),
    mk('a', 't3', 'buy', 'trend-up', { result: 1 }),
    mk('a', 't4', 'sell', 'trend-up', { result: null }),   // 未决 → 不计
    mk('a', 't5', 'buy', 'trend-up', { result: -1 }),
  ];
  const runs = decorrelate(rows);
  // t4 undefined 不计; 前3 buy run → 1 run(win=2,n=3), t5 buy → 1 run(win=0,n=1)
  ok('decorrelate 折叠同向 run', runs.length === 2);
  const first = runs[0];
  ok('decorrelate run 汇总 win/n', first.n === 3 && first.win === 2);
  ok('decorrelate 忽略未决帧', runs.every(r => r.result != null));
}

// ---- coverageMatrix ----
{
  const rows = [
    mk('a', 't1', 'buy', 'trend-up'),
    mk('a', 't2', 'buy', 'trend-up'),
    mk('b', 't1', 'sell', 'trend-up'),
    mk('c', 't1', 'buy', 'pullback-up'),
  ];
  const cov = coverageMatrix(rows);
  const tuB = cov.find(c => c.regime === 'trend-up' && c.dir === 'buy');
  const tuS = cov.find(c => c.regime === 'trend-up' && c.dir === 'sell');
  const pbB = cov.find(c => c.regime === 'pullback-up' && c.dir === 'buy');
  ok('coverage 每 regime×dir 一行', cov.length === REGIMES.length * DIRS.length);
  ok('coverage trend-up/buy=2', tuB.n === 2);
  ok('coverage trend-up/sell=1', tuS.n === 1);
  ok('coverage pullback-up/buy=1', pbB.n === 1);
  ok('coverage 空挡=0', cov.filter(c => c.n === 0).length > 0);
}

// ---- buildAblation ----
{
  const rows = [
    mk('a', 't1', 'buy', 'trend-up', { cIsHook: false, result: 1 }),
    mk('a', 't2', 'buy', 'trend-up', { cIsHook: true, result: -1 }),
    mk('b', 't1', 'sell', 'trend-up', { cIsHook: false, result: 1 }),
    mk('c', 't1', 'buy', 'pullback-up', { cIsHook: true, result: 1 }),
  ];
  const res = buildAblation(rows, { minGroupN: 0 });
  ok('ablation 方向总览 buy n', res.dir.buy.n === 3);
  ok('ablation 方向总览 sell n', res.dir.sell.n === 1);
  const hookF = res.factors.find(f => f.key === 'cIsHook');
  const hookT = hookF.entries.find(e => e.label === 'true');
  const hookF2 = hookF.entries.find(e => e.label === 'false');
  ok('ablation 钩=true 分组存在', !!hookT);
  ok('ablation 钩=true winRate=0.5', hookT && hookT.winRate === 0.5);
  ok('ablation 钩=false winRate=1.0', hookF2 && hookF2.winRate === 1.0);
  ok('ablation sizable 判定用 MIN_SAMPLE', hookT.sizable === (hookT.n >= MIN_SAMPLE));
  ok('ablation 覆盖矩阵内嵌', Array.isArray(res.coverage));
}

// ---- decorr 模式下 buildAblation ----
{
  const rows = [
    mk('a', 't1', 'buy', 'trend-up', { result: 1 }),
    mk('a', 't2', 'buy', 'trend-up', { result: -1 }),  // 折叠进 run
    mk('b', 't1', 'sell', 'trend-up', { result: 1 }),
  ];
  const res = buildAblation(rows, { decorr: true });
  ok('ablation decorr buy 只计 1 个 run', res.dir.buy.n === 1);  ok('ablation decorr sell 计 1', res.dir.sell.n === 1);
}

// ---- MIN_SAMPLE 常量 ----
ok('MIN_SAMPLE=600', MIN_SAMPLE === 600);

// ---- TSEV 因子抽取与投票 ----
{
  // extractDisciplineFactors：基础情形应产出预期因子态
  const trend = { up: false, flat: false, tf: '4h', spreadPct: -2 };
  const mt = { up: true, tf: '30d', spreadPct: 3 };
  const confirm = { dir: 'buy', isHook: true, confirmed: true, fresh: 2, tf: '15m' };
  const leader = { dir: 'buy', score: 80, tf: '15m', isHook: false, isClear: true };
  const zones = { daily: 'overbought', main: 'oversold' };
  const F = extractDisciplineFactors({ trend, mt, confirm, leading: leader, reversalAdd: 8, zones, verdict: '一致偏多', periodKAdd: 10, gapAdd: 5 });
  const names = F.map(f => f.name);
  ok('extract 含 pullback/hook/reversal/periodK/gap/consensus/leader/daily/macro',
    ['pullback','hook','reversal','periodK','gap','consensus','leader','daily','macro'].every(n => names.includes(n)));
  ok('extract hook 金钩→side+1', F.find(f => f.name === 'hook').side === 1);
  ok('extract daily 超买→side-1(勿追多)', F.find(f => f.name === 'daily').side === -1);
  ok('extract macro 反向→side+1(宏观向上)', F.find(f => f.name === 'macro').side === 1);
  ok('extract 无方向因子 side=0', F.find(f => f.name === 'hook') && F.every(f => f.side !== undefined));

  // trainTsevWeights：强信号应得显著正/负权重；样本不足应为 0
  const mkRow = (side, fut) => ({ factors: [{ name: 'pullback', cond: 'up_os', side }], fut: { h4: fut, d1: fut, d3: fut } });
  const strong = [];
  for (let i = 0; i < 600; i++) strong.push(mkRow(1, i === 0 ? -1 : 1));   // 599/600 命中（避免 p 恰好=1）
  const W = trainTsevWeights(strong, { MIN_SAMPLE: 400, Z_THRESH: 1.5, horizon: 'h4' });
  ok('train 强因子得正权重', W['pullback|up_os|1'] > 2);
  ok('train 弱样本(10)→权重0', (() => { const w = trainTsevWeights(Array.from({length:10},()=>mkRow(1,1))); return (w['pullback|up_os|1']||0) === 0; })());
  const noise = [];
  for (let i = 0; i < 600; i++) noise.push(mkRow(1, i % 2 === 0 ? 1 : -1)); // 50/50 噪声
  const Wn = trainTsevWeights(noise, { MIN_SAMPLE: 400, Z_THRESH: 1.5, horizon: 'h4' });
  ok('train 噪声因子→权重0(不入票)', (Wn['pullback|up_os|1']||0) === 0);

  // voteTsev：强权重 + 一致因子 → 看多；反向 → 看空；弱 → 观察
  const Wk = { 'pullback|up_os|1': 3, 'consensus|bull|1': 2 };
  const vB = voteTsev([{name:'pullback',cond:'up_os',side:1},{name:'consensus',cond:'bull',side:1}], Wk);
  ok('vote 一致→看多', vB.dir === 1 && vB.dirText === '看多');
  ok('vote 看多 conf>0.6', vB.conf > 0.6 && vB.confLabel === '高');
  const vS = voteTsev([{name:'consensus',cond:'bear',side:-1}], {'consensus|bear|-1': 3});
  ok('vote 反向→看空', vS.dir === -1 && vS.dirText === '看空');
  const vO = voteTsev([{name:'pullback',cond:'up_os',side:1}], {});
  ok('vote 无权重→观察', vO.dir === 0 && vO.dirText === '观察');
  const vM = voteTsev([{name:'pullback',cond:'up_os',side:1}], {'pullback|up_os|1': 0.1}); // 低于 M
  ok('vote 净票<M→观察', vM.dir === 0);

  // 部分投票（行情中立护栏改进）：仅学到一侧权重时仍可给该侧方向，不整体禁用
  // 仅跌行情：只有空头因子权重 → 空头因子触发给看空
  const Wbear = { '__unbalanced': true, '__pos': 0, '__neg': 2.5, 'consensus|bear|-1': 3, 'pullback|down_os|-1': 2 };
  const vBear = voteTsev([{name:'consensus',cond:'bear',side:-1}], Wbear);
  ok('partial 仅跌→部分投票看空', vBear.dir === -1 && vBear.dirText === '看空' && vBear.partial === true && vBear.unbalanced === true);
  // 仅跌行情下若出现多头因子(无权重)也不确认看多
  const vBearBull = voteTsev([{name:'consensus',cond:'bull',side:1}], Wbear);
  ok('partial 仅跌→不确认看多', vBearBull.dir === 0 && vBearBull.partial === true);
  // 仅涨行情：只有多头因子权重 → 多头因子触发给看多
  const Wbull = { '__unbalanced': true, '__pos': 2.5, '__neg': 0, 'consensus|bull|1': 3 };
  const vBull = voteTsev([{name:'consensus',cond:'bull',side:1}], Wbull);
  ok('partial 仅涨→部分投票看多', vBull.dir === 1 && vBull.dirText === '看多' && vBull.partial === true);
  // 两侧都无有效权重 → 彻底不投票(回退经典)
  const Wnone = { '__unbalanced': true, '__pos': 0, '__neg': 0 };
  const vNone = voteTsev([{name:'consensus',cond:'bear',side:-1}], Wnone);
  ok('partial 无样本→不投票', vNone.dir === 0 && vNone.partial === false && vNone.unbalanced === true);

  // decayStats：整体乘 factor（原地修改）
  const ds = { 'a|b|1': { n: 100, h: 60 }, 'c|d|-1': { n: 40, h: 10 } };
  const dsr = decayStats(ds, 0.5);
  ok('decayStats 乘0.5', dsr['a|b|1'].n === 50 && dsr['a|b|1'].h === 30 && dsr['c|d|-1'].n === 20 && dsr['c|d|-1'].h === 5);
  ok('decayStats 原地修改', ds['a|b|1'].n === 50);
  ok('decayStats factor>=1 不变', decayStats({ 'x|y|1': { n: 10, h: 5 } }, 1)['x|y|1'].n === 10);

  ok('TSEV_CFG 默认门槛', TSEV_CFG.MIN_SAMPLE === 400 && TSEV_CFG.Z_THRESH === 1.5 && TSEV_CFG.M === 0.5);

  // ---- 新增：Wilson 收缩 / 按币种分训 / 前向准确度 ----
  // Wilson 收缩：小样本拉向 0.5（先验），大样本≈观测 p
  ok('wilson 小样本拉向0.5', Math.abs(wilsonShrink(0.7, 8) - 0.5) < Math.abs(0.7 - 0.5));
  ok('wilson 大样本≈p', Math.abs(wilsonShrink(0.7, 2000) - 0.7) < 0.005);
  ok('wilson p=0.5 不变', Math.abs(wilsonShrink(0.5, 5) - 0.5) < 1e-9);

  // trainTsevWeightsStats 收缩：强因子得正权重但比未收缩温和（防过拟合）
  const statsStrong = { 'pullback|up_os|1': { n: 600, h: 420 } }; // p=0.7
  const st = trainTsevWeightsStats(statsStrong, { MIN_SAMPLE: 400, Z_THRESH: 1.5, SHRINK: true });
  ok('trainStats 收缩: 强因子>0 且 < logit(0.7)', st['pullback|up_os|1'] > 0 && st['pullback|up_os|1'] < Math.log(0.7 / 0.3));
  const stN = trainTsevWeightsStats(statsStrong, { MIN_SAMPLE: 400, Z_THRESH: 1.5, SHRINK: false });
  ok('trainStats 无收缩更极端', stN['pullback|up_os|1'] >= st['pullback|up_os|1']);
  const statsSmall = { 'pullback|up_os|1': { n: 10, h: 7 } };
  const stS = trainTsevWeightsStats(statsSmall, { MIN_SAMPLE: 400, Z_THRESH: 1.5, SHRINK: true });
  ok('trainStats 小样本权重0', (stS['pullback|up_os|1'] || 0) === 0);

  // ---- 新增：时间分桶 + 训练期近期加权（TSEV 跟随当前 regime）----
  const WEEK = 7 * 86400000;
  const NOW = 2e9 * 86400000; // 任意大“现在”，避免与真实 Date.now 耦合
  const wkRecent = Math.floor(NOW / WEEK);
  const wkOld = Math.floor((NOW - 3 * 365 * 86400000) / WEEK);
  // 近期桶偏多 + 古老桶偏空(3年前) → 近期主导 → 看多权重
  const statsRecency = { 'consensus|bull|1': { buckets: { [wkRecent]: { n: 600, h: 420 }, [wkOld]: { n: 600, h: 180 } } } };
  const wr = trainTsevWeightsStats(statsRecency, { MIN_SAMPLE: 50, Z_THRESH: 1.5, SHRINK: false, recencyHalfLifeDays: 365, now: NOW });
  ok('recency 近期主导→看多权重', (wr['consensus|bull|1'] || 0) > 0);
  // 仅古老桶(3年前) → 衰减后 n_eff 低于 MIN_SAMPLE → 权重0（旧行情淡出，不污染当前判决）
  const statsOldOnly = { 'consensus|bull|1': { buckets: { [wkOld]: { n: 600, h: 420 } } } };
  const wo = trainTsevWeightsStats(statsOldOnly, { MIN_SAMPLE: 50, Z_THRESH: 1.5, SHRINK: false, recencyHalfLifeDays: 365, now: NOW });
  ok('recency 仅古老桶→权重0(淡出)', (wo['consensus|bull|1'] || 0) === 0);
  // 半衰期越短，古老反向桶越被压制 → 净权重更偏近期
  const statsMix = { 'consensus|bull|1': { buckets: { [wkRecent]: { n: 600, h: 420 }, [wkOld]: { n: 6000, h: 1800 } } } };
  const wLong = trainTsevWeightsStats(statsMix, { MIN_SAMPLE: 50, Z_THRESH: 1.5, SHRINK: false, recencyHalfLifeDays: 365, now: NOW });
  const wShort = trainTsevWeightsStats(statsMix, { MIN_SAMPLE: 50, Z_THRESH: 1.5, SHRINK: false, recencyHalfLifeDays: 90, now: NOW });
  ok('recency 短半衰期→更跟近期(古老反向被压制)', (wShort['consensus|bull|1'] || 0) > (wLong['consensus|bull|1'] || 0));
  // 兼容旧 {n,h} 结构（全局/JSON 快照路径）仍可用
  const statsLegacy = { 'consensus|bull|1': { n: 600, h: 420 } };
  const wl = trainTsevWeightsStats(statsLegacy, { MIN_SAMPLE: 50, Z_THRESH: 1.5, SHRINK: false });
  ok('legacy {n,h} 结构仍训练出权重', (wl['consensus|bull|1'] || 0) > 0);

  // 前向准确度（walk-forward 重放 TSEV 投票）：强因子应高命中率
  const faRows = [];
  for (let i = 0; i < 2000; i++) {
    const side = (i % 2 === 0) ? 1 : -1;
    const f = (side === 1) ? { name: 'consensus', cond: 'bull', side: 1 } : { name: 'consensus', cond: 'bear', side: -1 };
    let lab = side; if (i % 13 === 0) lab = -side; // 固定 ~7.7% 确定性噪声（避免 p=1 被剔除；v1.5.58：Math.random 版本 ~18% 概率 acc<0.9 误报 flaky）
    faRows.push({ sym: 'BTC', ts: i, factors: [f], fut: { h4: lab, d1: lab, d3: lab }, raw: lab });
  }
  const fa = forwardAccuracy(faRows, { split: 0.7, horizon: 'h4', MIN_SAMPLE: 400, Z_THRESH: 1.5, M: 0.5 });
  ok('forwardAccuracy 返回结构', fa && typeof fa.acc === 'number' && fa.n > 0);
  ok('forwardAccuracy 强因子高命中率', fa.acc >= 0.9);
  const faNoise = [];
  for (let i = 0; i < 2000; i++) {
    const rnd = (Math.random() < 0.5) ? 1 : -1;
    const f = (rnd === 1) ? { name: 'consensus', cond: 'bull', side: 1 } : { name: 'consensus', cond: 'bear', side: -1 };
    // 因子方向与真实标签无关（纯随机）→ 期望被 Z 过滤，返回 null 或低命中率（不虚高）
    const lab = (Math.random() < 0.5) ? 1 : -1;
    faNoise.push({ sym: 'BTC', ts: i, factors: [f], fut: { h4: lab, d1: lab, d3: lab }, raw: lab });
  }
  const fa2 = forwardAccuracy(faNoise, { split: 0.7, horizon: 'h4', MIN_SAMPLE: 400, Z_THRESH: 1.5, M: 0.5 });
  ok('forwardAccuracy 噪声因子→null或低命中率(不虚高)', fa2 === null || fa2.acc < 0.65);
}

console.log(`\n=== disciplineAnalysis.test: ${passed} passed, ${failed} failed ===`);
process.exit(failed ? 1 : 0);
