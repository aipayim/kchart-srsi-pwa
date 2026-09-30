/**
 * Jev×SRSI 裁决审计（P1）—— 纯函数单元测试 (Node 原生, 无框架)
 *
 * 覆盖：
 *   isPairableKind / PAIR_KINDS          —— 可配对信号种类
 *   pickJevOpinion                        —— 超短档优先/回退短档/超时 stale/跨币拒绝/中性
 *   pairFromEvent / pairKey               —— 方向映射 + 去重键 + 币对校验
 *   alignIdx / lastFiniteAtr              —— 时间对齐（非位置）/ ATR 回推
 *   evalPairOutcome                       —— ⭐ 方向映射回归（long→buy / short→sell）+ 5 种状态
 *   mergePairs / trimPairList             —— 去重合并 / 容量裁剪
 *   wilsonCI / pairGroupOf / pairStats    —— 95% CI / 分组 / 命中率/均值/覆盖率/增量/门槛
 *   aggregateSnapshot                     —— KB 级聚合快照
 *   buildJevAuditModel / renderJevAuditHtml —— 面板模型与 HTML
 */

import { strictEqual, deepStrictEqual, ok as assertOk } from 'assert';
import {
  PAIR_KINDS, AUDIT_TF, AUDIT_TP_ATR, AUDIT_SL_ATR, AUDIT_BARS_DEFAULT,
  JEV_AUDIT_MIN_PAIRS, JEV_AUDIT_MIN_GROUP, JEV_AUDIT_CAP,
  isPairableKind, pairKey, pickJevOpinion, pairFromEvent, alignIdx, lastFiniteAtr,
  evalPairOutcome, mergePairs, trimPairList, wilsonCI, pairGroupOf, pairStats,
  aggregateSnapshot, auditBars, setAuditBars, tsevSampleOf, applyTsevFeed, TSEV_TD
} from '../src/pwa/jevSrsiAudit.js';
import { buildJevAuditModel, renderJevAuditHtml, AUDIT_DISCLAIMER } from '../src/tech2/jevAuditPanel.js';

let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log('ok:', name); } else { failed++; console.log('FAIL:', name); } }

// ---------- isPairableKind / 常量 ----------
{
  assertOk(isPairableKind('srsi-edge-upper'));
  assertOk(isPairableKind('srsi-edge-lower'));
  assertOk(isPairableKind('srsi-cross-buy'));
  assertOk(isPairableKind('srsi-cross-sell'));
  assertOk(isPairableKind('srsi-hook-gold'));
  assertOk(isPairableKind('srsi-hook-death'));
  strictEqual(isPairableKind('srsi-preview'), false);
  strictEqual(isPairableKind('srsi-confirm'), false);
  strictEqual(isPairableKind('srsi-open'), false);          // 成交事件不配对（配对的是信号）
  strictEqual(isPairableKind('alpha-rebal'), false);
  strictEqual(PAIR_KINDS['srsi-edge-upper'], 'short');
  strictEqual(PAIR_KINDS['srsi-edge-lower'], 'long');
  strictEqual(AUDIT_TF, '15m');
  strictEqual(AUDIT_TP_ATR, 2);
  strictEqual(AUDIT_SL_ATR, 1.5);
  strictEqual(AUDIT_BARS_DEFAULT, 8);
  strictEqual(JEV_AUDIT_MIN_PAIRS, 300);
  strictEqual(JEV_AUDIT_MIN_GROUP, 100);
  ok('可配对种类 + 常量', true);
}

// ---------- pickJevOpinion ----------
{
  const base = Date.now();
  const mk = (strength, sym = 'BTCUSDT') => ({ sym, ts: base, freqMs: 3600000, dirs: { scalp: { strength, conf: 0.7, label: '偏多' } } });
  const o1 = pickJevOpinion(mk(40), base + 60000, { sym: 'BTCUSDT' });
  strictEqual(o1.dir, 'long');
  strictEqual(o1.stale, false);
  strictEqual(o1.source, 'scalp');
  const o2 = pickJevOpinion(mk(-40), base + 60000, { sym: 'BTCUSDT' });
  strictEqual(o2.dir, 'short');
  const o3 = pickJevOpinion(mk(10), base + 60000, { sym: 'BTCUSDT' });   // |10|<15 → 中性
  strictEqual(o3.dir, null);
  strictEqual(o3.strength, 10);
  ok('pickJevOpinion 方向/中性', true);

  // 超时 → stale 且 dir 置空（归入"中性或缺"组）
  const o4 = pickJevOpinion(mk(80), base + 5 * 3600000, { sym: 'BTCUSDT' });
  strictEqual(o4.stale, true);
  strictEqual(o4.dir, null);
  strictEqual(o4.strength, 80);        // 原始强度保留（供展示）
  ok('超时 → stale 且 dir=null', true);

  // 跨币拒绝（全局单例防串味）
  strictEqual(pickJevOpinion(mk(80), base + 60000, { sym: 'ETHUSDT' }), null);
  ok('跨币拒绝', true);

  // 无 scalp → 回退 short
  const o5 = pickJevOpinion({ sym: 'BTCUSDT', ts: base, freqMs: 3600000, dirs: { short: { strength: -50, conf: 0.6 } } }, base + 1000, { sym: 'BTCUSDT' });
  strictEqual(o5.dir, 'short');
  strictEqual(o5.source, 'short');
  ok('无 scalp 回退 short', true);

  // 空/缺
  strictEqual(pickJevOpinion(null, base, {}), null);
  strictEqual(pickJevOpinion({ sym: 'BTCUSDT' }, base, {}), null);
  ok('空输入安全', true);

  // 窗口 = max(2×freqMs, scalp 窗口, 1h)；freqMs=1h → 2h
  const justIn = pickJevOpinion(mk(40), base + 119 * 60000, { sym: 'BTCUSDT' });
  strictEqual(justIn.stale, false);
  const justOut = pickJevOpinion(mk(40), base + 121 * 60000, { sym: 'BTCUSDT' });
  strictEqual(justOut.stale, true);
  ok('时效窗口 = max(2×freq, 1h)', true);
}

// ---------- auditBars / setAuditBars ----------
{
  const d = auditBars();
  strictEqual(d, AUDIT_BARS_DEFAULT);
  setAuditBars(16);
  strictEqual(auditBars(), 16);
  setAuditBars(3);            // clamp ≥4
  strictEqual(auditBars(), 4);
  setAuditBars(999);          // clamp ≤32
  strictEqual(auditBars(), 32);
  setAuditBars('bogus');      // 非法保留原值
  strictEqual(auditBars(), 32);
  setAuditBars(AUDIT_BARS_DEFAULT);   // 复位
  ok('auditBars/setAuditBars 钳制', true);
}

// ---------- pairFromEvent / pairKey ----------
{
  const now = 1_700_000_000_000;
  const latest = { sym: 'BTCUSDT', ts: now - 60000, freqMs: 3600000, dirs: { scalp: { strength: 60, conf: 0.8 } } };
  const ev = { ts: now, sym: 'BTCUSDT', kind: 'srsi-edge-lower', side: 'long', price: 100, w: 0.2, barT: now - 300000, src: 'engine' };
  const p = pairFromEvent(ev, { now, latest });
  strictEqual(p.side, 'long');
  strictEqual(p.jevSide, 'long');            // 同向
  strictEqual(p.jev.dir, 'long');
  strictEqual(p.evalTf, '15m');
  strictEqual(p.outcome, null);
  strictEqual(p.id, 'BTCUSDT|srsi-edge-lower|long|' + (now - 300000));
  strictEqual(pairKey(p), p.id);
  ok('pairFromEvent 基本/去重键', true);

  // 反向
  const p2 = pairFromEvent({ ...ev, kind: 'srsi-edge-upper', side: 'short' }, { now, latest });
  strictEqual(p2.jevSide, 'long');
  strictEqual(pairGroupOf(p2), 'reverse');
  ok('反向配对', true);

  // 无 Jev 意见 → jev=null / jevSide=null → flat 组
  const p3 = pairFromEvent(ev, { now, latest: null });
  strictEqual(p3.jev, null);
  strictEqual(p3.jevSide, null);
  strictEqual(pairGroupOf(p3), 'flat');
  ok('无 Jev → flat 组', true);

  // 跨币 latest → 不得配对成本币意见
  const p4 = pairFromEvent({ ...ev, sym: 'ETHUSDT' }, { now, latest });
  strictEqual(p4.jev, null);
  strictEqual(p4.jevSide, null);
  ok('当前币无 Jev 意见 → flat（不串味）', true);

  // 不可配对种类
  strictEqual(pairFromEvent({ ...ev, kind: 'srsi-preview' }, { now, latest }), null);
  strictEqual(pairFromEvent(null, { now, latest }), null);
  // 无方向
  strictEqual(pairFromEvent({ ...ev, side: null, w: null }, { now, latest }), null);
  ok('不可配对/无方向 → null', true);

  // side 由 w 推导（sideOf 回退）
  const p5 = pairFromEvent({ ts: now, sym: 'BTCUSDT', kind: 'srsi-cross-sell', price: 100, w: -0.3, barT: now }, { now, latest });
  strictEqual(p5.side, 'short');
  ok('side 由 w 推导', true);
}

// ---------- alignIdx / lastFiniteAtr ----------
{
  const times = [1000, 2000, 3000, 4000];
  strictEqual(alignIdx(times, 2500), 1);
  strictEqual(alignIdx(times, 1000), 0);
  strictEqual(alignIdx(times, 999), -1);
  strictEqual(alignIdx(times, 999999), 3);
  strictEqual(alignIdx(null, 1000), -1);
  strictEqual(alignIdx([], 1000), -1);
  ok('alignIdx（时间对齐，含边界）', true);

  const closes = [];
  for (let i = 0; i < 40; i++) closes.push(100 + i);
  const a = lastFiniteAtr(closes, 39);
  assertOk(a > 0 && Number.isFinite(a));
  strictEqual(lastFiniteAtr(closes, -1), null);
  strictEqual(lastFiniteAtr([], 0), null);
  ok('lastFiniteAtr', true);
}

// ---------- evalPairOutcome：⭐ 方向映射回归 ----------
{
  const up = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109];
  const down = [100, 99, 98, 97, 96, 95, 94, 93, 92, 91];
  const flat = [100, 100.5, 100.4, 100.3, 100.2, 100.1];
  const mkP = (side, atr = 1, bars = 3) => ({ sym: 'X', side, barT: 1000, ts: 1000, entryIdx: 0, atr, evalBars: bars });

  // long 涨 → win（若误映射为 sell 会变成 loss）
  const w1 = evalPairOutcome(mkP('long'), { closes: up });
  strictEqual(w1.status, 'win');
  strictEqual(w1.win, 1);
  assertOk(w1.pnlPct > 0);
  ok('long + 涨 → win（direction=buy 回归）', true);

  // short 跌 → win（direction=sell）
  const w2 = evalPairOutcome(mkP('short'), { closes: down });
  strictEqual(w2.status, 'win');
  ok('short + 跌 → win（direction=sell 回归）', true);

  // long 跌 → loss
  const l1 = evalPairOutcome(mkP('long'), { closes: down });
  strictEqual(l1.status, 'loss');
  strictEqual(l1.win, -1);
  ok('long + 跌 → loss', true);

  // short 涨 → loss
  const l2 = evalPairOutcome(mkP('short'), { closes: up });
  strictEqual(l2.status, 'loss');
  ok('short + 涨 → loss', true);

  // 到期未触发 → expired（atr 大 → 无 TP/SL）
  const e1 = evalPairOutcome(mkP('long', 5, 3), { closes: flat });
  strictEqual(e1.status, 'expired');
  strictEqual(e1.win, 0);
  ok('窗口内未触发 → expired', true);

  // 未走满 → pending
  const p1 = evalPairOutcome(mkP('long', 1, 8), { closes: [100, 101, 102, 103] });
  strictEqual(p1.status, 'pending');
  strictEqual(p1.bars, 8);
  assertOk(p1.barsDone < 8);
  ok('未走满 → pending', true);

  // 无 K 线 / 越界 → no-entry
  strictEqual(evalPairOutcome(mkP('long'), { closes: [] }).status, 'no-entry');
  strictEqual(evalPairOutcome(mkP('long'), null).status, 'no-entry');
  strictEqual(evalPairOutcome({ sym: 'X', side: 'long', barT: 0, ts: 0, atr: 1, evalBars: 1 }, { closes: up, times: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }).status, 'no-entry');   // barT 早于所有 times → idx=-1
  ok('no-entry 三种情形', true);

  // opts.idx 覆盖 + 时间对齐（不按位置）
  const viaTime = evalPairOutcome({ sym: 'X', side: 'long', barT: 4000, ts: 4000, atr: 1, evalBars: 2 }, { closes: up, times: [1000, 2000, 3000, 4000, 5000, 6000, 7000] });
  strictEqual(viaTime.status, 'win');
  ok('时间对齐取入场 idx', true);

  // ⭐ 回归：entryIdx=null 不得被当成 0（+null===0 陷阱）
  // closes 20 根，barT=times[15]：若误用 idx=0 → lastFiniteAtr 不足 → no-entry-data；正确对齐 idx=15 → 可判定
  const c20 = []; for (let i = 0; i < 20; i++) c20.push(100 + i);
  const t20 = []; for (let i = 0; i < 20; i++) t20.push(i * 900000);
  const rNull = evalPairOutcome({ sym: 'X', side: 'long', barT: t20[15], ts: t20[15], entryIdx: null, atr: null, evalBars: 2 }, { closes: c20, times: t20 });
  strictEqual(rNull.status, 'win');
  ok('entryIdx=null → 用时间对齐（非 0）', true);

  const rNull2 = evalPairOutcome({ sym: 'X', side: 'short', barT: t20[15], ts: t20[15], entryIdx: null, atr: null, evalBars: 2 }, { closes: c20, times: t20 });
  strictEqual(rNull2.status, 'loss');   // 上涨序列 + 做空 → loss（证明用的是 idx=15 的价格 115，非 0）
  ok('entryIdx=null 对齐点在 barT 处（非 0）', true);
}

// ---------- mergePairs / trimPairList ----------
{
  const a = { id: 'a', ts: 1 }, b = { id: 'b', ts: 2 };
  const r1 = mergePairs([a], [b]);
  strictEqual(r1.list.length, 2);
  strictEqual(r1.added, 1);
  const upd = { id: 'a', ts: 9, outcome: { status: 'win' } };
  const r2 = mergePairs(r1.list, [upd]);
  strictEqual(r2.list.length, 2);
  strictEqual(r2.updated, 1);
  strictEqual(r2.list.find(x => x.id === 'a').ts, 9);
  const r3 = mergePairs(null, null);
  deepStrictEqual(r3.list, []);
  ok('mergePairs 去重/更新/空安全', true);

  const many = [];
  for (let i = 0; i < 10; i++) many.push({ id: 'p' + i, ts: i });
  strictEqual(trimPairList(many, 4).length, 4);
  deepStrictEqual(trimPairList(many, 4).map(x => x.ts), [6, 7, 8, 9]);   // 留最新
  strictEqual(trimPairList(many, JEV_AUDIT_CAP).length, 10);
  strictEqual(trimPairList(null, 4).length, 0);
  ok('trimPairList 留最新', true);
}

// ---------- wilsonCI ----------
{
  const ci = wilsonCI(60, 100);
  assertOk(Array.isArray(ci) && ci[0] < 0.6 && ci[1] > 0.6);
  assertOk(ci[0] >= 0 && ci[1] <= 1);
  strictEqual(wilsonCI(0, 0), null);
  strictEqual(wilsonCI(1, 0), null);
  const tiny = wilsonCI(1, 1);
  assertOk(tiny[0] > 0.1 && tiny[1] === 1);   // n 小 → 区间大
  ok('wilsonCI 边界', true);
}

// ---------- pairGroupOf ----------
{
  strictEqual(pairGroupOf({ side: 'long', jevSide: 'long' }), 'same');
  strictEqual(pairGroupOf({ side: 'long', jevSide: 'short' }), 'reverse');
  strictEqual(pairGroupOf({ side: 'short', jevSide: null }), 'flat');
  strictEqual(pairGroupOf(null), 'flat');
  ok('pairGroupOf', true);
}

// ---------- pairStats ----------
{
  const t0 = 1_700_000_000_000;
  const day = 86400000;
  const mk = (i, side, jevSide, status, pnl) => ({
    id: 'p' + i, ts: t0 + i * 3600000, sym: 'BTCUSDT', kind: 'k', side, jevSide,
    outcome: status ? { status, win: status === 'win' ? 1 : status === 'loss' ? -1 : 0, pnlPct: pnl } : null
  });
  const list = [
    mk(0, 'long', 'long', 'win', 2),      // same win
    mk(1, 'long', 'long', 'loss', -1.5),  // same loss
    mk(2, 'long', 'short', 'loss', -1.5), // reverse loss
    mk(3, 'short', 'long', 'win', 2),     // reverse win
    mk(4, 'long', null, 'expired', 0),    // flat expired
    mk(5, 'long', 'long', null, null),    // same pending
    mk(6, 'short', 'short', 'no-entry', null)  // same no-entry
  ];
  const st = pairStats(list);
  strictEqual(st.total, 7);
  strictEqual(st.decided, 5);
  strictEqual(st.pending, 1);
  strictEqual(st.noEntry, 1);
  strictEqual(st.withJev, 6);
  assertOk(Math.abs(st.coverage - 6 / 7) < 1e-9);
  assertOk(st.days > 0);
  // same: win1 loss1 + pending1 + noEntry1 → n=2, hitRate 0.5
  strictEqual(st.groups.same.n, 2);
  strictEqual(st.groups.same.wins, 1);
  strictEqual(st.groups.same.losses, 1);
  strictEqual(st.groups.same.pending, 1);
  strictEqual(st.groups.same.noEntry, 1);
  strictEqual(st.groups.same.hitRate, 0.5);
  assertOk(Array.isArray(st.groups.same.ci));
  // reverse: loss1 win1 → n=2, hitRate 0.5
  strictEqual(st.groups.reverse.n, 2);
  strictEqual(st.groups.reverse.hitRate, 0.5);
  // flat: expired1 → n=1, hitRate null（无 win/loss）
  strictEqual(st.groups.flat.n, 1);
  strictEqual(st.groups.flat.expired, 1);
  strictEqual(st.groups.flat.hitRate, null);
  // 增量 = 0
  strictEqual(st.increment, 0);
  strictEqual(st.enough, false);
  ok('pairStats 分组/命中率/覆盖率/增量/门槛', true);

  // 反向明显更差 → 增量 > 0
  const list2 = [];
  for (let i = 0; i < 160; i++) list2.push(mk(i, 'long', 'long', 'win', 2));
  for (let i = 160; i < 320; i++) list2.push(mk(i, 'long', 'short', 'loss', -1.5));
  const st2 = pairStats(list2);
  strictEqual(st2.groups.same.hitRate, 1);
  strictEqual(st2.groups.reverse.hitRate, 0);
  strictEqual(st2.increment, 100);
  strictEqual(st2.enough, true);
  ok('增量 = 同向−反向（pp）+ 达标', true);

  // 空输入
  const st0 = pairStats([]);
  strictEqual(st0.total, 0);
  strictEqual(st0.increment, null);
  strictEqual(st0.groups.same.hitRate, null);
  ok('pairStats 空输入', true);
}

// ---------- aggregateSnapshot ----------
{
  const snap = aggregateSnapshot([{ sym: 'BTCUSDT', side: 'long', jevSide: 'long', outcome: { status: 'win', pnlPct: 2 } }], 'BTCUSDT');
  strictEqual(snap.total, 1);
  strictEqual(snap.same.n, 1);
  strictEqual(snap.same.wins, 1);
  strictEqual(snap.increment, null);   // reverse 无样本
  assertOk(snap.at > 0);
  strictEqual(aggregateSnapshot(null, null).total, 0);
  ok('aggregateSnapshot', true);
}

// ---------- 面板 ----------
{
  const st = pairStats([
    { sym: 'BTCUSDT', side: 'long', jevSide: 'long', outcome: { status: 'win', pnlPct: 2 } },
    { sym: 'BTCUSDT', side: 'long', jevSide: 'long', outcome: { status: 'loss', pnlPct: -1.5 } },
    { sym: 'BTCUSDT', side: 'long', jevSide: 'short', outcome: { status: 'loss', pnlPct: -1.5 } },
    { sym: 'BTCUSDT', side: 'short', jevSide: 'short', outcome: { status: 'win', pnlPct: 2 } },
    { sym: 'BTCUSDT', side: 'long', jevSide: null, outcome: null }
  ]);
  const m = buildJevAuditModel({ stats: st, sym: 'BTCUSDT' });
  strictEqual(m.total, 5);
  strictEqual(m.decided, 4);
  strictEqual(m.pending, 1);
  strictEqual(m.rows.length, 3);
  strictEqual(m.rows[0].key, 'same');
  strictEqual(m.enough, false);
  assertOk(m.verdictTxt.includes('样本不足'));
  assertOk(m.incrementTxt.includes('pp'));
  ok('buildJevAuditModel 基本', true);

  const html = renderJevAuditHtml(m);
  assertOk(html.includes('ja-wrap'));
  assertOk(html.includes('Jev 同向'));
  assertOk(html.includes('Jev 反向'));
  assertOk(html.includes('Jev 中性或缺'));
  assertOk(html.includes('增量'));
  assertOk(html.includes(AUDIT_DISCLAIMER));
  assertOk(html.includes('仅观察'));
  ok('renderJevAuditHtml 含三组/增量/免责', true);

  // 达标 + 正增量
  const m2 = buildJevAuditModel({ stats: pairStats([
    ...Array.from({ length: 150 }, () => ({ sym: 'B', side: 'long', jevSide: 'long', outcome: { status: 'win', pnlPct: 2 } })),
    ...Array.from({ length: 150 }, () => ({ sym: 'B', side: 'long', jevSide: 'short', outcome: { status: 'loss', pnlPct: -1.5 } }))
  ]), sym: 'B' });
  strictEqual(m2.enough, true);
  assertOk(m2.verdictTxt.includes('已达门槛'));
  assertOk(renderJevAuditHtml(m2).includes('ja-ok'));
  ok('达标 + 正增量文案', true);

  // 空样本 → 引导，不空串
  const empty = buildJevAuditModel({ stats: pairStats([]), sym: 'X' });
  assertOk(renderJevAuditHtml(empty).includes('暂无配对样本'));
  strictEqual(renderJevAuditHtml({ available: false }), '');
  ok('空样本引导 + 不可用 → 空串', true);

  // 转义
  const esc = buildJevAuditModel({ stats: pairStats([]), sym: 'X', lastErr: '<script>' });
  assertOk(renderJevAuditHtml(esc).includes('&lt;script&gt;'));
  ok('HTML 转义', true);
}

// ---------- P4 剩余子项：TSEV 喂样（tsevSampleOf / applyTsevFeed）----------
{
  const pair = { id: 'x', sym: 'BTCUSDT', side: 'long', ts: 1700000000000, barT: 1700000000000, evalTf: '15m' };
  const s = tsevSampleOf(pair, { status: 'win' });
  ok('tsevSampleOf win → side +1 / hit true / td 15m', !!s && s.side === 1 && s.hit === true && s.sym === 'BTCUSDT' && s.td === '15m' && s.ts === 1700000000000);
  ok('tsevSampleOf loss short → side -1 / hit false', (() => { const q = tsevSampleOf({ sym: 'ETHUSDT', side: 'short', ts: 1 }, { status: 'loss' }); return q && q.side === -1 && q.hit === false && q.td === '15m'; })());
  ok('tsevSampleOf pending/expired/no-entry → null', ['pending', 'expired', 'no-entry'].every(st => tsevSampleOf(pair, { status: st }) === null));
  ok('tsevSampleOf 无方向 → null', tsevSampleOf({ sym: 'X', side: '', ts: 1 }, { status: 'win' }) === null);
  ok('tsevSampleOf 缺 sym → null', tsevSampleOf({ sym: '', side: 'long', ts: 1 }, { status: 'win' }) === null);
  ok('tsevSampleOf 保留 pair.evalTf', tsevSampleOf({ sym: 'X', side: 'long', ts: 1, evalTf: '1h' }, { status: 'win' }).td === '1h');
  ok('tsevSampleOf null 安全', tsevSampleOf(null, null) === null && TSEV_TD === '15m');

  let calls = 0;
  const failFeed = () => { calls++; return false; };
  const okFeed = () => { calls++; return true; };
  const f1 = applyTsevFeed(pair, { status: 'win' }, failFeed);
  ok('feed 失败 → 不标 tsevFed（v1.6.75 教训）', f1.fed === false && f1.attempted === true && !f1.pair.tsevFed);
  ok('feed 抛出也不崩且不标 fed', (() => { const r = applyTsevFeed(pair, { status: 'win' }, () => { throw new Error('x'); }); return r.fed === false && !r.pair.tsevFed; })());
  const f2 = applyTsevFeed(f1.pair, { status: 'win' }, okFeed);
  ok('feed 成功 → tsevFed=true + tsevFedAt', f2.fed === true && f2.pair.tsevFed === true && typeof f2.pair.tsevFedAt === 'number');
  const before = calls;
  const f3 = applyTsevFeed(f2.pair, { status: 'win' }, okFeed);
  ok('已喂过 → 不再调 feedFn（幂等）', f3.fed === true && f3.attempted === false && calls === before);
  const f4 = applyTsevFeed(pair, { status: 'pending' }, okFeed);
  ok('非 win/loss → 不喂不标', f4.fed === false && f4.attempted === false && !f4.pair.tsevFed);
  ok('applyTsevFeed null 安全', applyTsevFeed(null, null, okFeed).fed === false);
}

console.log(`\n=== jevSrsiAudit: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
