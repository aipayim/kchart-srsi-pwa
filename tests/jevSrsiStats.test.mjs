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
  evaluateJevSrsi, verdictText, formatReport
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

console.log(`\n=== jevSrsiStats: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
