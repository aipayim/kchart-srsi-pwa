/**
 * PWA「工具一览（Tool Board）」—— 纯函数单元测试 (Node 原生, 无框架)
 *
 * 测试 (src/tech2/toolBoard.js):
 *   toneDir / dirMark          —— tone→方向 / 方向标记
 *   toolBoardCounts            —— 偏多/偏空/中性计数（none 不计）
 *   toolBoardConflicts         —— 方向冲突对
 *   buildToolBoardModel        —— 只列已开启工具 / 各工具真实周期 / tfOnly 过滤 / 原样引用结论
 *   renderToolBoardHtml        —— 行 + 关系行 + 冲突 + 声明；空 → ''
 */

import { strictEqual, deepStrictEqual, ok as assertOk } from 'assert';
import {
  toneDir, dirMark, DIR_MARK, toolBoardCounts, toolBoardConflicts,
  buildToolBoardModel, renderToolBoardHtml
} from '../src/tech2/toolBoard.js';

let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log('ok:', name); } else { failed++; console.log('FAIL:', name); } }

// ---------- toneDir / dirMark ----------
{
  strictEqual(toneDir('bull'), 'long');
  strictEqual(toneDir('bear'), 'short');
  strictEqual(toneDir('range'), 'flat');
  strictEqual(toneDir('none'), 'none');
  strictEqual(toneDir(null), 'none');
  ok('toneDir 映射', true);
  strictEqual(dirMark('long'), DIR_MARK.long);
  strictEqual(dirMark('short'), DIR_MARK.short);
  strictEqual(dirMark('flat'), DIR_MARK.flat);
  strictEqual(dirMark('bogus'), DIR_MARK.none);
  ok('dirMark 映射 + 未知回退', true);
}

// ---------- toolBoardCounts ----------
{
  const rows = [
    { dir: 'long' }, { dir: 'long' }, { dir: 'short' }, { dir: 'flat' }, { dir: 'none' }, { dir: 'none' }
  ];
  deepStrictEqual(toolBoardCounts(rows), { long: 2, short: 1, flat: 1 });
  deepStrictEqual(toolBoardCounts([]), { long: 0, short: 0, flat: 0 });
  deepStrictEqual(toolBoardCounts(null), { long: 0, short: 0, flat: 0 });
  ok('toolBoardCounts 只计方向型（none 不计）', true);
}

// ---------- toolBoardConflicts ----------
{
  const rows = [
    { name: 'A', dir: 'long' }, { name: 'B', dir: 'short' }, { name: 'C', dir: 'long' }, { name: 'D', dir: 'none' }
  ];
  const cf = toolBoardConflicts(rows);
  // A-B, B-C 两组反向（A-C 同向不算）
  strictEqual(cf.length, 2);
  ok('冲突对文案含方向', cf[0].includes('A多') && cf[0].includes('B空'));
  deepStrictEqual(toolBoardConflicts([{ name: 'A', dir: 'long' }, { name: 'B', dir: 'long' }]), []);
  deepStrictEqual(toolBoardConflicts(null), []);
  ok('toolBoardConflicts 同向/空安全', true);
}

// ---------- buildToolBoardModel：只列已开启工具 ----------
{
  const cfg = { symbol: 'BTCUSDT', mainTF: '5m' };   // 全部工具关
  const m = buildToolBoardModel({ cfg, mainTF: '5m' });
  strictEqual(m.rows.length, 0);
  ok('全部关闭 → 0 行', true);
}
{
  const cfg = { symbol: 'BTCUSDT', mainTF: '1h', alphaSignalOn: true, maRelOn: true, chanOn: true, rbOn: true, sigOverlay: true, ruleMonitorOpen: true, srsiAutoOn: true, adaptiveOverlay: true };
  const m = buildToolBoardModel({
    cfg, mainTF: '1h',
    alphaSig: { lastW: 0.62, sym: 'BTCUSDT', tf: '1h' },
    maRel: { tone: 'bull', verdict: '结构：价在MA20上方（偏多）' },
    chan: { tone: 'bear', verdict: '结构：向下笔（仅结构描述）' },
    rb: { tone: 'range', verdict: '结构：箱体 100–120' },
    adaptive: { enabled: true, bucket: 'high', wA: 0.3, wC: 0.7, alphaW: 0.18 },
    srsi: { band: 'lower' }
  });
  const byId = {}; for (const r of m.rows) byId[r.id] = r;
  strictEqual(m.rows.length, 8);
  // 各工具真实周期
  strictEqual(byId.alpha.tf, '1h+日线');
  strictEqual(byId.srsi.tf, '15m');
  strictEqual(byId.adaptive.tf, '1h');
  strictEqual(byId.maRel.tf, '1h');
  strictEqual(byId.rb.tf, '1h');
  strictEqual(byId.chan.tf, '1h');
  strictEqual(byId.live.tf, '成交');
  strictEqual(byId.monitor.tf, '—');
  ok('各工具周期正确（含跟随 mainTF 的）', true);
  // 方向
  strictEqual(byId.alpha.dir, 'long');
  strictEqual(byId.srsi.dir, 'long');       // 下带 → 做多
  strictEqual(byId.adaptive.dir, 'long');    // alphaW 0.18 > 0.05
  strictEqual(byId.maRel.dir, 'long');
  strictEqual(byId.chan.dir, 'short');
  strictEqual(byId.rb.dir, 'flat');
  strictEqual(byId.live.dir, 'none');
  strictEqual(byId.monitor.dir, 'none');
  ok('方向映射正确', true);
  // 结论原样引用
  strictEqual(byId.maRel.concl, '结构：价在MA20上方（偏多）');
  strictEqual(byId.chan.concl, '结构：向下笔（仅结构描述）');
  strictEqual(byId.rb.concl, '结构：箱体 100–120');
  assertOk(byId.alpha.concl.includes('+62%'));
  ok('结论原样引用（maRel/chan/rb）+ alpha 仓位', true);
  // 计数 + 冲突（long: alpha,srsi,adaptive,maRel = 4；short: chan = 1；flat: rb = 1）
  deepStrictEqual(m.counts, { long: 4, short: 1, flat: 1 });
  ok('计数正确', m.conflicts.length > 0 && m.conflicts.some(c => c.includes('缠论')));
}

// ---------- tfOnly 过滤 ----------
{
  const cfg = { symbol: 'BTCUSDT', mainTF: '4h', alphaSignalOn: true, maRelOn: true, chanOn: true, sigOverlay: true, srsiAutoOn: true };
  const base = { cfg, mainTF: '4h', alphaSig: { lastW: -0.3, sym: 'BTCUSDT' }, maRel: { tone: 'bull', verdict: 'v1' }, chan: { tone: 'bear', verdict: 'v2' }, srsi: { band: 'upper' } };
  const all = buildToolBoardModel(base);
  const only = buildToolBoardModel({ ...base, cfg: { ...cfg, toolBoardTfOnly: true } });
  strictEqual(all.tfOnly, false);
  strictEqual(only.tfOnly, true);
  // 过滤后只剩 nativeTf===4h 的（maRel + chan）
  strictEqual(only.rows.length, 2);
  assertOk(only.rows.every(r => r.nativeTf === '4h'));
  ok('tfOnly 只保留 nativeTf===mainTF', true);
  // mainTF=1h 时，adaptive(1h) 应保留
  const only1h = buildToolBoardModel({ ...base, cfg: { ...cfg, mainTF: '1h', toolBoardTfOnly: true, adaptiveOverlay: true }, mainTF: '1h', adaptive: { enabled: true, wA: 0.5, wC: 0.5, alphaW: 0.5, bucket: 'mid' } });
  assertOk(only1h.rows.some(r => r.id === 'adaptive'));
  assertOk(only1h.rows.every(r => r.nativeTf === '1h'));
  ok('mainTF=1h 时 1h 固定周期工具保留', true);
}

// ---------- alpha 无信号 / adaptive 未启用 ----------
{
  const cfg = { symbol: 'ETHUSDT', mainTF: '15m', alphaSignalOn: true, adaptiveOverlay: true, srsiAutoOn: true };
  const m = buildToolBoardModel({ cfg, mainTF: '15m', alphaSig: null, adaptive: { enabled: false }, srsi: { band: 'neutral' } });
  const byId = {}; for (const r of m.rows) byId[r.id] = r;
  strictEqual(byId.alpha.dir, 'none');
  assertOk(byId.alpha.concl.includes('未计算'));
  strictEqual(byId.adaptive.dir, 'none');
  assertOk(byId.adaptive.concl.includes('未启用'));
  strictEqual(byId.srsi.dir, 'flat');   // neutral → 无带态 → flat
  ok('alpha 无信号 / adaptive 未启用 显示正确', true);
}

// ---------- adaptiveOverlay=false 不列 adaptive ----------
{
  const cfg = { symbol: 'BTCUSDT', mainTF: '1h', adaptiveOverlay: false };
  const m = buildToolBoardModel({ cfg, mainTF: '1h', adaptive: { enabled: true, wA: 1, wC: 0 } });
  strictEqual(m.rows.length, 0);
  ok('adaptiveOverlay=false → adaptive 不列（且无其它工具）', true);
}

// ---------- renderToolBoardHtml ----------
{
  strictEqual(renderToolBoardHtml({ rows: [] }), '');
  strictEqual(renderToolBoardHtml(null), '');
  ok('空模型 → 空字符串', true);
  const cfg = { symbol: 'BTCUSDT', mainTF: '1h', maRelOn: true, chanOn: true };
  const m = buildToolBoardModel({ cfg, mainTF: '1h', maRel: { tone: 'bull', verdict: '价在MA20上方' }, chan: { tone: 'bear', verdict: '向下笔' } });
  const html = renderToolBoardHtml(m);
  assertOk(html.includes('tb-list'));
  assertOk(html.includes('均线关系'));
  assertOk(html.includes('价在MA20上方'));
  assertOk(html.includes('tb-rel'));
  assertOk(html.includes('偏多 1'));
  assertOk(html.includes('偏空 1'));
  assertOk(html.includes('方向冲突'));
  assertOk(html.includes('原样引用'));
  ok('HTML 含行/关系/冲突/声明', true);
}

console.log(`\n=== toolBoard: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
