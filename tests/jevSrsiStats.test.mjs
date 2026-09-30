/**
 * Jev×SRSI P2 统计裁决核心 —— 纯函数单元测试 (Node 原生, 无框架)
 *
 * 覆盖：
 *   mulberry32                    —— 确定性 PRNG
 *   wilsonCI / pairGroupOf / pairStats —— 分组指标（canonical，含扣费后期望）
 *   twoPropZ                      —— 两比例 z 检验
 *   labelPermutation              —— 随机标签置换（强效应 → p 小；无效应 → p 大；同种子可复现）
 *   rotationTest                  —— 时序旋转对照
 *   foldsOf / walkForward         —— 4 折 / 末折同号
 *   bonferroni                    —— 多重比较校正
 *   evaluateJevSrsi               —— 样本不足早退 / 全通过 / 增量不足失败 / 末折不同号失败
 *   verdictText / formatReport    —— 结论文本（面板与脚本同源）
 */

import { strictEqual, deepStrictEqual, ok as assertOk } from 'assert';
import {
  JE_SRSI_DECISION, JE_SRSI_GROUP_KEYS, mulberry32, wilsonCI, twoPropZ, pairGroupOf,
  pairStats, isDecided, labelPermutation, rotationTest, foldsOf, walkForward, bonferroni,
  evaluateJevSrsi, verdictText, formatReport,
  checkpointOf, formatCheckpoint, JE_SRSI_CHECKPOINT
} from '../src/engine/jevSrsiStats.js';

let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log('ok:', name); } else { failed++; console.log('FAIL:', name); } }

// ---------- 判定线常量（预先声明；改它必须有用户显式确认） ----------
{
  strictEqual(JE_SRSI_DECISION.MIN_INCREMENT_PP, 5.0);
  strictEqual(JE_SRSI_DECISION.MAX_P_ADJ, 0.05);
  strictEqual(JE_SRSI_DECISION.MIN_PAIRS, 300);
  strictEqual(JE_SRSI_DECISION.MIN_GROUP, 100);
  strictEqual(JE_SRSI_DECISION.PERM_ITERATIONS, 200);
  strictEqual(JE_SRSI_DECISION.WALK_FORWARD_K, 4);
  strictEqual(JE_SRSI_DECISION.BONFERRONI_K, 6);
  strictEqual(JE_SRSI_DECISION.ROUND_TRIP_PCT, 0.13);
  deepStrictEqual(JE_SRSI_GROUP_KEYS, ['same', 'reverse', 'flat']);
  ok('判定线常量写死', true);
}

// ---------- mulberry32 ----------
{
  const a = mulberry32(42), b = mulberry32(42), c = mulberry32(43);
  const seqA = [a(), a(), a()], seqB = [b(), b(), b()];
  deepStrictEqual(seqA, seqB);
  assertOk(seqA.every(v => v >= 0 && v < 1));
  assertOk(seqA[0] !== c());
  ok('mulberry32 确定性 + 范围', true);
}

// ---------- 数据构造 ----------
const t0 = 1_700_000_000_000;
function mk(i, side, jevSide, status) {
  const o = status === 'win' ? { status: 'win', win: 1, pnlPct: 2 }
    : status === 'loss' ? { status: 'loss', win: -1, pnlPct: -1.5 }
    : status === 'expired' ? { status: 'expired', win: 0, pnlPct: 0 }
    : status === 'no-entry' ? { status: 'no-entry', win: 0, pnlPct: null }
    : null;
  return { id: 'p' + i, ts: t0 + i * 3600000, sym: 'S' + (i % 2), kind: 'k', side, jevSide, outcome: o };
}

// ---------- isDecided / pairGroupOf ----------
{
  assertOk(isDecided({ outcome: { status: 'win' } }));
  assertOk(isDecided({ outcome: { status: 'expired' } }));
  strictEqual(isDecided({ outcome: { status: 'pending' } }), false);
  strictEqual(isDecided({ outcome: { status: 'no-entry' } }), false);
  strictEqual(isDecided(null), false);
  strictEqual(pairGroupOf({ side: 'long', jevSide: 'long' }), 'same');
  strictEqual(pairGroupOf({ side: 'long', jevSide: 'short' }), 'reverse');
  strictEqual(pairGroupOf({ side: 'short', jevSide: null }), 'flat');
  strictEqual(pairGroupOf(null), 'flat');
  ok('isDecided / pairGroupOf', true);
}

// ---------- wilsonCI ----------
{
  const ci = wilsonCI(60, 100);
  assertOk(Array.isArray(ci) && ci[0] < 0.6 && ci[1] > 0.6);
  strictEqual(wilsonCI(0, 0), null);
  ok('wilsonCI', true);
}

// ---------- pairStats（canonical，含 expectancy） ----------
{
  const list = [
    mk(0, 'long', 'long', 'win'),
    mk(1, 'long', 'long', 'loss'),
    mk(2, 'long', 'short', 'loss'),
    mk(3, 'short', 'long', 'win'),
    mk(4, 'long', null, 'expired'),
    mk(5, 'long', 'long', null),
    mk(6, 'short', 'short', 'no-entry')
  ];
  const st = pairStats(list);
  strictEqual(st.total, 7);
  strictEqual(st.decided, 5);
  strictEqual(st.pending, 1);
  strictEqual(st.noEntry, 1);
  strictEqual(st.withJev, 6);
  strictEqual(st.groups.same.n, 2);
  strictEqual(st.groups.same.hitRate, 0.5);
  strictEqual(st.groups.reverse.n, 2);
  strictEqual(st.groups.flat.n, 1);
  strictEqual(st.groups.flat.hitRate, null);
  strictEqual(st.increment, 0);
  // 期望 = 均值 − 往返成本
  const sameExp = st.groups.same.grossAvgPnl - JE_SRSI_DECISION.ROUND_TRIP_PCT;
  assertOk(Math.abs(st.groups.same.expectancy - sameExp) < 1e-9);
  ok('pairStats 分组/命中率/增量/扣费后期望', true);
}

// ---------- twoPropZ ----------
{
  const a = twoPropZ(80, 100, 50, 100);   // 80% vs 50%
  assertOk(a.z > 0 && a.p < 0.01);
  const b = twoPropZ(50, 100, 50, 100);
  strictEqual(b.z, 0);
  assertOk(b.p > 0.9);
  strictEqual(twoPropZ(0, 0, 1, 10).p, null);
  ok('twoPropZ', true);
}

// ---------- 强效应 / 无效应数据集 ----------
function strongPairs(n) {   // 同向全胜 / 反向全负 → 增量 100pp，四折都同向
  const out = [];
  for (let i = 0; i < n; i++) out.push(i % 2 === 0 ? mk(i, 'long', 'long', 'win') : mk(i, 'long', 'short', 'loss'));
  return out;
}
function flatPairs(n) {     // 同向/反向命中率都是 50% → 增量 ≈ 0
  const out = [];
  for (let i = 0; i < n; i++) {
    const side = 'long';
    if (i % 2 === 0) out.push(mk(i, side, 'long', i % 4 === 0 ? 'win' : 'loss'));
    else out.push(mk(i, side, 'short', i % 4 === 1 ? 'win' : 'loss'));
  }
  return out;
}
// 效应集中在前 3 折，末折反向 → 汇总仍正（50pp）但末折 -100pp → walk-forward 不同号
const mixed = (() => {
  const out = [];
  for (let i = 0; i < 320; i++) {
    const jev = i % 2 === 0 ? 'long' : 'short';
    const st = i < 240 ? (i % 2 === 0 ? 'win' : 'loss') : (i % 2 === 0 ? 'loss' : 'win');
    out.push(mk(i, 'long', jev, st));
  }
  return out;
})();

// ---------- labelPermutation ----------
{
  const strong = strongPairs(320);
  const p1 = labelPermutation(strong, { iterations: 200, seed: 1 });
  assertOk(p1.valid);
  assertOk(p1.p <= 0.06, '强效应 p 应很小，实际 ' + p1.p);
  strictEqual(p1.observed, 100);
  const p1b = labelPermutation(strong, { iterations: 200, seed: 1 });
  strictEqual(p1.p, p1b.p);                      // 同种子可复现
  const flat = labelPermutation(flatPairs(320), { iterations: 200, seed: 1 });
  assertOk(flat.p > 0.2, '无效应 p 应较大，实际 ' + flat.p);
  const bad = labelPermutation([mk(0, 'long', 'long', 'win'), mk(1, 'long', 'short', 'loss')], {});
  strictEqual(bad.valid, false);
  ok('labelPermutation 强/无效应 + 可复现 + 样本不足', true);
}

// ---------- rotationTest ----------
{
  const strong = rotationTest(strongPairs(320), { iterations: 100, seed: 2 });
  assertOk(strong.valid);
  assertOk(strong.p >= 0 && strong.p <= 1);
  const again = rotationTest(strongPairs(320), { iterations: 100, seed: 2 });
  strictEqual(strong.p, again.p);
  const few = rotationTest(strongPairs(4), {});
  strictEqual(few.valid, false);
  ok('rotationTest 可复现 + 样本不足', true);
}

// ---------- foldsOf / walkForward ----------
{
  const folds = foldsOf(strongPairs(320), { k: 4 });
  strictEqual(folds.length, 4);
  strictEqual(folds.reduce((a, f) => a + f.n, 0), 320);
  assertOk(folds.every(f => f.increment === 100));
  const wf = walkForward(strongPairs(320), { k: 4 });
  strictEqual(wf.consistent, true);
  strictEqual(wf.lastIncrement, 100);
  ok('foldsOf 等分 + walkForward 同号', true);

  // 效应只在前 3 折 → 末折反向 → 不同号
  const wf2 = walkForward(mixed, { k: 4 });
  strictEqual(wf2.consistent, false);
  assertOk(wf2.lastIncrement < 0);
  ok('walkForward 末折不同号 → false', true);
}

// ---------- bonferroni ----------
{
  strictEqual(bonferroni(0.01, 6), 0.06);
  strictEqual(bonferroni(0.001, 6), 0.006);
  strictEqual(bonferroni(0.5, 6), 1);            // 封顶 1
  strictEqual(bonferroni(null), null);
  ok('bonferroni', true);
}

// ---------- evaluateJevSrsi ----------
{
  // ① 样本不足 → 早退（不跑置换），FAIL
  const r0 = evaluateJevSrsi(strongPairs(50));
  strictEqual(r0.pass, false);
  strictEqual(r0.ran, false);
  assertOk(r0.reason.includes('样本不足'));
  strictEqual(r0.controls, null);
  assertOk(r0.checks.samples === false);
  ok('样本不足 → 早退/FAIL', true);

  // ② 强效应 + 达样本 → PASS
  const r1 = evaluateJevSrsi(strongPairs(320));
  assertOk(r1.ran);
  strictEqual(r1.checks.samples, true);
  strictEqual(r1.checks.increment, true);
  strictEqual(r1.checks.signif, true);
  strictEqual(r1.checks.walkForward, true);
  strictEqual(r1.pass, true);
  assertOk(r1.pAdj < 0.05);
  assertOk(r1.controls && r1.controls.label && r1.controls.rotate);
  ok('强效应 + 达样本 → PASS（四项全过）', true);

  // ③ 达样本但增量不足 → FAIL(increment)
  const small = [];
  for (let i = 0; i < 640; i++) {
    const side = 'long';
    const jev = i % 2 === 0 ? 'long' : 'short';
    // same: 52% 胜；reverse: 50% 胜
    const winSame = (i % 100) < 52;
    const winRev = (i % 100) < 50;
    small.push(mk(i, side, jev, (jev === 'long' ? winSame : winRev) ? 'win' : 'loss'));
  }
  const r2 = evaluateJevSrsi(small);
  strictEqual(r2.checks.samples, true);
  strictEqual(r2.checks.increment, false);
  strictEqual(r2.pass, false);
  assertOk(r2.reason.includes('增量'));
  ok('增量不足 → FAIL(increment)', true);

  // ④ 效应只在前期 → walk-forward 末折不同号 → FAIL
  const r3 = evaluateJevSrsi(mixed);
  strictEqual(r3.checks.samples, true);
  strictEqual(r3.checks.walkForward, false);
  strictEqual(r3.pass, false);
  assertOk(r3.reason.includes('walk-forward'));
  ok('末折不同号 → FAIL(walk-forward)', true);
}

// ---------- verdictText / formatReport ----------
{
  const r = evaluateJevSrsi(strongPairs(320));
  const vt = verdictText(r);
  assertOk(vt.includes('通过') || vt.includes('未通过'));
  assertOk(vt.includes('walk-forward'));
  assertOk(vt.includes('样本'));
  const rep = formatReport(r);
  assertOk(rep.includes('判定线（预先声明）'));
  assertOk(rep.includes('随机标签置换'));
  assertOk(rep.includes('时序旋转'));
  assertOk(rep.includes('walk-forward'));
  assertOk(rep.includes('判定: ' + (r.pass ? 'PASS' : 'FAIL')));
  assertOk(rep.includes('扣费后期望'));
  strictEqual(formatReport(null), '');
  ok('verdictText / formatReport', true);
}


// ---------- checkpointOf / formatCheckpoint（观察期检查点，v1.6.79） ----------
{
  // 构造样本：d 天内 n 对，同向/反向按比例，可选带 Jev 意见（覆盖率）
  const mk = (opts) => {
    const list = [];
    const { n = 0, days = 1, same = 0, reverse = 0, flat = 0, withJev = null, t0 = 1700000000000 } = opts;
    const span = days * 86400000;
    let i = 0;
    const push = (side, jevSide) => {
      const ts = t0 + (n <= 1 ? 0 : span * i / (n - 1)); i++;
      list.push({ id: 'p' + i, sym: 'BTCUSDT', side, ts, barT: ts, jevSide: jevSide || null, outcome: { status: 'win', win: 1, pnlPct: 1 }, matured: true });
    };
    for (let k = 0; k < same; k++) push('long', 'long');
    for (let k = 0; k < reverse; k++) push('long', 'short');
    for (let k = 0; k < flat; k++) push('long', null);
    if (withJev != null && list.length) {
      // 调整覆盖率：把前 (1-withJev) 比例的 jevSide 置空
      const drop = Math.round(list.length * (1 - withJev));
      for (let k = 0; k < drop && k < list.length; k++) list[k].jevSide = null;
    }
    // n 用于控制总条数（不足部分补 flat）
    while (list.length < n) push('long', null);
    return list;
  };

  // 空输入
  const c0 = checkpointOf([]);
  ok('checkpoint 空输入安全', c0.total === 0 && c0.eta === null && c0.rate.reliable === false && c0.midTerm.length === 0);
  ok('checkpoint 空输入文本不抛', typeof formatCheckpoint(c0) === 'string' && formatCheckpoint(c0).includes('观察期检查点'));

  // 短窗口（<0.2 天）→ 速率不可靠、不报 ETA（防几分钟外推几周）
  const cShort = checkpointOf(mk({ n: 8, days: 0.1, same: 5, reverse: 3 }));
  ok('checkpoint 短窗口 → 速率不可靠 + 无 ETA', cShort.rate.reliable === false && cShort.eta === null);
  ok('checkpoint 短窗口文本写明"不可用"', formatCheckpoint(cShort).includes('累积速率: 不可用'));

  // 长窗口：100 对 / 10 天 → 10 对/天；缺口 200 → ETA ≈ 20 天；瓶颈 total
  const cLong = checkpointOf(mk({ n: 100, days: 10, same: 60, reverse: 40 }), { now: 1700000000000 + 10 * 86400000 });
  ok('checkpoint 速率计算', cLong.rate.reliable === true && cLong.rate.total === 10);
  ok('checkpoint ETA 取瓶颈（total：缺 200 / 10 每天 = 20 天）', !!cLong.eta && cLong.eta.days === 20 && cLong.eta.bottleneck === 'total');
  ok('checkpoint ETA 日期 = now + days', cLong.eta.date === new Date(1700000000000 + 30 * 86400000).toISOString().slice(0, 10));
  ok('checkpoint ETA 低置信标注（跨度 <0.5 天时）', checkpointOf(mk({ n: 6, days: 0.3, same: 4, reverse: 2 })).eta.lowConfidence === true);

  // 已达标 → ETA 0 / bottleneck done
  const cDone = checkpointOf(mk({ n: 400, days: 40, same: 150, reverse: 150, flat: 100 }));
  ok('checkpoint 已达标 → eta.days 0 / bottleneck done', !!cDone.eta && cDone.eta.days === 0 && cDone.eta.bottleneck === 'done' && cDone.enough === true);

  // 瓶颈在同向组：total 已够但同向不足
  const cSame = checkpointOf(mk({ n: 320, days: 32, same: 40, reverse: 200, flat: 80 }), { now: 1700000000000 + 32 * 86400000 });
  ok('checkpoint 瓶颈=同向组', !!cSame.eta && (cSame.eta.bottleneck === 'same'));
  ok('checkpoint 同向不足 → 未达门槛', cSame.enough === false);

  // 中期检查条款
  const c13 = checkpointOf(mk({ n: 50, days: 13, same: 30, reverse: 20 }));
  ok('checkpoint 跨度<14 天 → 无中期检查条款', c13.midTerm.length === 0);
  ok('checkpoint 下一次检查=第 2 周 + 剩余天数', !!c13.nextCheck && c13.nextCheck.kind === 'midterm' && c13.nextCheck.inDays === 1);
  const c14ok = checkpointOf(mk({ n: 60, days: 15, same: 35, reverse: 25, withJev: 1 }));
  ok('checkpoint 第 2 周覆盖率达标 ✓', c14ok.midTerm.some(m => m.id === 'coverage' && m.ok === true));
  const c14bad = checkpointOf(mk({ n: 60, days: 15, same: 35, reverse: 25, withJev: 0.3 }));
  ok('checkpoint 第 2 周覆盖率不足 ✗ + 建议修时效', c14bad.midTerm.some(m => m.id === 'coverage' && m.ok === false && m.text.includes('修 P0 的时效')));
  const c30 = checkpointOf(mk({ n: 60, days: 30, same: 35, reverse: 25, withJev: 1 }));
  ok('checkpoint 第 4 周样本<100 ✗ + 建议换标的且不改判定线', c30.midTerm.some(m => m.id === 'volume' && m.ok === false && m.text.includes('不改判定线')));
  ok('checkpoint 跨度>28 天 → 无 nextCheck', c30.nextCheck === null);
  const c30ok = checkpointOf(mk({ n: 400, days: 30, same: 200, reverse: 180, flat: 20, withJev: 1 }));
  ok('checkpoint 第 4 周样本达标 ✓', c30ok.midTerm.some(m => m.id === 'volume' && m.ok === true));

  // 覆盖率口径（withJev / total）
  const cCov = checkpointOf(mk({ n: 100, days: 5, same: 50, reverse: 50, withJev: 0.8 }));
  ok('checkpoint 覆盖率 = 带 Jev 意见占比', Math.abs(cCov.coverage - 0.8) < 0.03);

  // 文本包含关键行（门槛单一来源）
  const txt = formatCheckpoint(cLong);
  ok('checkpoint 文本含速率/ETA/判定线/门槛', txt.includes('对/天') && txt.includes('预计达标') && txt.includes('判定线（预先声明') && txt.includes(String(JE_SRSI_DECISION.MIN_PAIRS)));
  ok('checkpoint 常量已声明', JE_SRSI_CHECKPOINT.MIDTERM_DAYS === 14 && JE_SRSI_CHECKPOINT.SECOND_MIN_PAIRS === 100);
}

console.log(`\n=== jevSrsiStats: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
