// Alpha 同源核心测试：fixture 自检（期望常量来自 Node 权威框架 goal2-bt.mjs，逐位对齐验证见
// scripts/goal4-run-align.mjs 与 scripts/goal5-fixture.mjs）+ 因果性/钳制/确定性断言。不依赖 /tmp 数据。
import assert from 'node:assert/strict';
import { buildFixture, fixtureSelfCheck } from '../src/pwa/alphaLab.js';
import { runBacktest, alignClosed, carryZSeries, comboWeight, maxDD, annualized } from '../src/pwa/alphaCore.js';

let count = 0;

// 1) fixture 自检：浏览器核心 vs Node 权威常量（容差 1e-6）
for (const r of fixtureSelfCheck()) {
  assert.ok(r.ok, `fixture 自检失败: ${r.label} got final=${r.got}`);
  count++;
}

// 2) alignClosed 因果性：对齐到的日线 bar 必须已收盘（T[j]+86400e3 ≤ t[i]）且单调不减
const fx = buildFixture();
const ad = alignClosed(fx.d1.t, 86400e3, fx.h1.t);
for (let i = 0; i < fx.h1.t.length; i++) {
  const j = ad[i];
  if (j < 0) continue; // 窗口起点前无已收盘日线 → -1（策略退化为 carry-only，因果安全）
  assert.ok(fx.d1.t[j] + 86400e3 <= fx.h1.t[i] + 1, `alignClosed 前视: i=${i} 日线未收盘`);
  if (i > 0 && ad[i - 1] >= 0) assert.ok(ad[i] >= ad[i - 1], `alignClosed 非单调: i=${i}`);
  count++;
}
count++; // 单调性整段

// 3) carryZSeries：常数序列 sd=0 → z=0；极端 funding → |z| 大
const t1h = fx.h1.t;
const flat = Array.from({ length: 200 }, (_, i) => [t1h[0] - (200 - i) * 8 * 3600e3, 0.0001]);
const zFlat = carryZSeries([t1h[t1h.length - 1]], flat);
assert.ok(Math.abs(zFlat[0]) < 1e-9, `常数 funding 序列 z 应≈0（got ${zFlat[0]}）`);
const extreme = Array.from({ length: 200 }, (_, i) => [t1h[0] - (200 - i) * 8 * 3600e3, i < 190 ? 0.0001 : 0.01]);
const zEx = carryZSeries([t1h[t1h.length - 1]], extreme);
assert.ok(zEx[0] > 2, `极端 funding 应产生显著 z（got ${zEx[0]}）`);
count += 2;

// 4) comboWeight 钳制：|w| ≤ 1；z=null → 仅 momo/brk 项
const c1d = fx.d1.c;
for (const z of [-100, 100, null, 0]) {
  const w = comboWeight(z, c1d, c1d.length - 1);
  assert.ok(Math.abs(w) <= 1 + 1e-12, `comboWeight 越界: ${w}`);
}
count += 4;

// 5) longOnly：只多模式 lastW ≥ 0（永不允许净空头）
const end = fx.h1.t[fx.h1.t.length - 1] + 3600e3;
const rLO = runBacktest(fx.h1, fx.d1, { start: fx.h1.t[0], end, band: 0.05, funding: fx.funding, useFunding: false, levCap: 1, volTarget: 0.30, vtCap: 1.0, longOnly: true });
assert.ok(rLO.lastW >= -1e-12, `longOnly 出现负仓位: ${rLO.lastW}`);
assert.ok(rLO.liq === 0, 'L1 现货不应爆仓');
count += 2;

// 6) 确定性：同参重跑 final 逐位一致
const r2 = runBacktest(fx.h1, fx.d1, { start: fx.h1.t[0], end, band: 0.05, funding: fx.funding, useFunding: false, levCap: 1, volTarget: 0.30, vtCap: 1.0, longOnly: true });
assert.equal(r2.final, rLO.final, '同参重跑应逐位一致');

// 7b) ws 逐根目标权重（GOAL6 主图 α 信号数据源）：与 eqs 等长且范围合理
assert.ok(rLO.ws && rLO.ws.length === rLO.eqs.length, `ws 与 eqs 等长（${rLO.ws && rLO.ws.length} vs ${rLO.eqs.length}）`);
for (const w of rLO.ws) assert.ok(Number.isFinite(w) && Math.abs(w) <= 3, `ws 越界: ${w}`);
count += rLO.ws.length;
count++;

// 7) 指标边界：maxDD ∈ [0,100]、annualized 负权益保护
const dd = maxDD(rLO.eqs);
assert.ok(dd >= 0 && dd <= 1, `maxDD 越界: ${dd}`);
assert.equal(annualized(0, 2, [0, 86400e3]), -1, 'eq0≤0 应回退 -1');
count += 2;

console.log(`✅ pwaAlphaCore: ${count} 项断言通过（浏览器核心 = Node 权威框架，fixture 2 用例 + 因果/钳制/确定性）`);
