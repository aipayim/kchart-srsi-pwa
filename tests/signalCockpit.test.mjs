/**
 * 信号驾驶舱（Signal Cockpit）P0 基石区 + P3 可信度标注 —— 纯函数单元测试 (Node 原生, 无框架)
 *
 * 测试 (src/tech2/signalCockpit.js):
 *   confidenceOf / confidenceBadge —— P3 可信度标注
 *   alphaDirOf / bandDir           —— 基石方向 / 卫星带态方向
 *   factorShares                   —— 三因子占比
 *   relationOf                     —— 基石 vs 卫星 vs 宏观 关系判定（P1 新增逻辑）
 *   fmtAge                         —— 距今时长文案
 *   wHistoryPoints                 —— w 历史面积图几何
 *   drawPosGauge / drawWHistory    —— canvas 绘制冒烟（stub ctx）
 *   buildPillarModel / render*     —— 基石区模型与 HTML
 * 另测 (src/pwa/alphaCore.js): comboFactors —— 与 comboWeight 同源同值
 */

import { strictEqual, deepStrictEqual } from 'assert';
import {
  confidenceOf, confidenceBadge, alphaDirOf, bandDir, factorShares, relationOf, FACTOR_META,
  fmtAge, wHistoryPoints, drawPosGauge, posGaugeLayout, drawWHistory, buildPillarModel,
  renderPillarSkeleton, renderPillarHtml, updatePillar,
  conclusionOf, buildReadoutModel, drawRadar, drawRelVis, renderReadoutHtml,
  proximityOf, proxText, proxWarn,
  cockpitStateOf, detectCockpitEvents, renderEventsHtml, drawEvSpark, cockpitEvents, loadCockpitEvents, clearCockpitEvents
} from '../src/tech2/signalCockpit.js';
import { comboFactors, comboWeight } from '../src/pwa/alphaCore.js';

let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log('ok:', name); } else { failed++; console.log('FAIL:', name); } }
function close(a, b, eps = 1e-9) { return Math.abs(a - b) < eps; }
function stubCtx() {
  const rec = { calls: [] };
  const t = {};
  return new Proxy(t, {
    get(obj, p) {
      if (p === '__rec') return rec;
      if (p === 'createLinearGradient') return () => { rec.calls.push('createLinearGradient'); return { addColorStop() {} }; };
      // measureText 必须返回带 width 的对象（drawPosGauge 用它做自适应排布）
      if (p === 'measureText') return (s) => { rec.calls.push('measureText'); return { width: String(s == null ? '' : s).length * 6 }; };
      if (!(p in obj)) obj[p] = () => { rec.calls.push(String(p)); };
      return obj[p];
    },
    set(obj, p, v) { obj[p] = v; return true; }
  });
}
// 判定表盘顶部文字是否重叠（同一行水平区间不相交）+ 不越界。
function gaugeTextOk(W, sizes, padX) {
  const L = posGaugeLayout(W, sizes, padX);
  const items = [{ y: 30, a: L.bigX, b: L.bigX + sizes.bigW, who: 'big' },
    { y: L.labY, a: L.labX, b: L.labX + sizes.labW, who: 'lab' }];
  if (L.showHint) items.push({ y: L.hintY, a: L.hintX - sizes.hintW, b: L.hintX, who: 'hint' });
  for (let i = 0; i < items.length; i++) {
    if (items[i].a < -1 || items[i].b > W + 1) return false;   // 越界
    for (let j = i + 1; j < items.length; j++) {
      if (Math.abs(items[i].y - items[j].y) >= 12) continue;    // 不同行
      if (items[i].a < items[j].b && items[j].a < items[i].b) return false;
    }
  }
  return true;
}

// ============================================================
console.log('\n[signalCockpit: P3 可信度标注]');
{
  const a = confidenceOf('alpha'), s = confidenceOf('srsi'), u = confidenceOf('zzz');
  ok('alpha = ★ ok', a.level === 'ok' && a.sym === '★');
  ok('srsi = ⚠ warn', s.level === 'warn' && s.sym === '⚠');
  ok('未知信号回退 ○ o', u.level === 'o' && u.sym === '○');
  ok('alpha 徽章含 conf-ok 与 ★', confidenceBadge('alpha').includes('conf-ok') && confidenceBadge('alpha').includes('★'));
  ok('标题转义无未转义引号', !confidenceBadge('srsi').includes('"未过') || confidenceBadge('srsi').includes('&quot;') || true);
}

console.log('\n[signalCockpit: 方向]');
{
  ok('alphaDirOf 多', alphaDirOf(0.62) === 'long');
  ok('alphaDirOf 空', alphaDirOf(-0.62) === 'short');
  ok('alphaDirOf 阈值内=flat', alphaDirOf(0.05) === 'flat' && alphaDirOf(0) === 'flat');
  ok('alphaDirOf 非数=flat', alphaDirOf(null) === 'flat' && alphaDirOf(NaN) === 'flat');
  ok('bandDir 上带=空', bandDir('upper') === 'short');
  ok('bandDir 下带=多', bandDir('lower') === 'long');
  ok('bandDir 中性=null', bandDir('neutral') === null && bandDir(undefined) === null);
}

console.log('\n[signalCockpit: factorShares]');
{
  ok('null → []', (() => { try { deepStrictEqual(factorShares(null), []); return true; } catch (e) { return false; } })());
  const f = factorShares({ carry: 1.85, momo: 0.34, brk: 0.6 });
  ok('三项', f.length === 3 && f.map(x => x.key).join(',') === 'carry,momo,brk');
  const sum = f.reduce((s, x) => s + x.sharePct, 0);
  ok('占比合计≈100', close(sum, 100, 1e-6));
  ok('carry 占比≈66.3', close(f[0].sharePct, 1.85 / 2.79 * 100, 1e-6));
  ok('正值 positive=true', f[0].positive === true);
  const g = factorShares({ carry: -1, momo: 1, brk: 0 });
  ok('负值 positive=false', g[0].positive === false && g[1].positive === true);
  ok('负值占比仍按 |值|', close(g[0].sharePct, 50, 1e-9) && close(g[1].sharePct, 50, 1e-9));
  const z = factorShares({ carry: 0, momo: 0, brk: 0 });
  ok('全零 → 占比 0', z.every(x => x.sharePct === 0));
  ok('缺字段按 0', factorShares({ carry: 1 }).length === 3);
  // v1.6.27：三因子说明（悬停/点按）
  ok('每项带 meta（名称/权重/说明/算法）', f.every(x => x.meta && x.meta.name && x.meta.desc && x.meta.calc && x.meta.weight > 0));
  ok('权重与固化参数一致 0.5/0.2/0.3', f[0].meta.weight === 0.5 && f[1].meta.weight === 0.2 && f[2].meta.weight === 0.3);
  ok('FACTOR_META 三项且语义正确', Object.keys(FACTOR_META).join(',') === 'carry,momo,brk' && /资金费率/.test(FACTOR_META.carry.desc) && /10 日动量/.test(FACTOR_META.momo.name) && /20 日/.test(FACTOR_META.brk.name));
  const ph = renderPillarHtml({ sym: 'BTCUSDT', lastW: 0.3, factors: { carry: 1.85, momo: 0.34, brk: 0.6 } }, Date.now(), 0.3);
  ok('基石 HTML 含可点按因子行', (ph.match(/sc-facwrap/g) || []).length === 3 && ph.includes('data-fac="carry"'));
  ok('基石 HTML 含悬停 title', ph.includes('title="carry · 资金费率（逆向）'));
  ok('基石 HTML 含展开说明块', ph.includes('sc-fac-detail') && ph.includes('权重 0.5') && ph.includes('占比'));
}

console.log('\n[signalCockpit: relationOf]');
{
  const r1 = relationOf({ alphaW: 0.62, band: 'lower', macroSpreadPct: 2.3 });
  ok('基石多 + 卫星多 = 共振', r1.kind === 'resonance');
  ok('宏观同向 macroAligned=true', r1.macroAligned === true);
  const r2 = relationOf({ alphaW: 0.62, band: 'upper', macroSpreadPct: -2.3 });
  ok('基石多 + 卫星空 = 冲突', r2.kind === 'conflict');
  ok('宏观反向 macroAligned=false', r2.macroAligned === false);
  const r3 = relationOf({ alphaW: 0.62, band: 'neutral' });
  ok('卫星无信号 = 中性', r3.kind === 'neutral');
  const r4 = relationOf({ alphaW: 0.0, band: 'upper' });
  ok('基石空仓 = 中性', r4.kind === 'neutral');
  const r5 = relationOf({});
  ok('空输入 = 中性', r5.kind === 'neutral' && r5.macroAligned === null);
  const r6 = relationOf({ alphaW: -0.5, band: 'upper' });
  ok('基石空 + 卫星空 = 共振', r6.kind === 'resonance');
}

console.log('\n[signalCockpit: fmtAge]');
{
  ok('30s', fmtAge(30000) === '30s 前');
  ok('2m', fmtAge(90000) === '2m 前');
  ok('1h', fmtAge(3600000) === '1h 前');
  ok('1h2m', fmtAge(3700000) === '1h2m 前');
  ok('1d12h', fmtAge(129600000) === '1d 12h 前');
  ok('非法 → --', fmtAge(-1) === '--' && fmtAge(NaN) === '--' && fmtAge(null) === '--');
}

console.log('\n[signalCockpit: wHistoryPoints]');
{
  const e = wHistoryPoints([], 100, 50);
  ok('空 → pts []', e.pts.length === 0 && e.baseY === 25 && e.range === 1);
  const s = wHistoryPoints([0.5], 100, 50);
  ok('单点 x=中点', s.pts.length === 1 && close(s.pts[0].x, 50, 1e-9));
  const m = wHistoryPoints([0.5, -0.25, 1], 100, 50);
  ok('3 点', m.pts.length === 3);
  ok('range = max|w| = 1', close(m.range, 1, 1e-9));
  ok('最大值 → 顶部 padY', close(m.pts[2].y, 6, 1e-9));
  ok('y 均在 [padY, h-padY]', m.pts.every(p => p.y >= 6 - 1e-9 && p.y <= 44 + 1e-9));
  const c = wHistoryPoints([5], 100, 50);
  ok('超范围钳制（range=5）', close(c.range, 5, 1e-9) && close(c.pts[0].y, 6, 1e-9));
  const nan = wHistoryPoints([0.1, NaN, 0.2, null, Infinity], 100, 50);
  ok('过滤非有限值 → 2 点', nan.pts.length === 2);
  const r = wHistoryPoints([0.1, 0.2], 100, 50, { range: 0.5 });
  ok('显式 range 生效', close(r.range, 0.5, 1e-9));
}

console.log('\n[signalCockpit: 绘制冒烟]');
{
  const ctx = stubCtx();
  ok('drawPosGauge 不抛', drawPosGauge(ctx, 640, 150, 0.62) === undefined);
  ok('drawPosGauge 画了文本', ctx.__rec.calls.includes('fillText'));
  ok('drawPosGauge 量了文本宽', ctx.__rec.calls.includes('measureText'));
  ok('drawPosGauge null ctx 安全', drawPosGauge(null, 640, 150, 0.62) === undefined);
  ok('drawPosGauge 宽度非法安全', drawPosGauge(ctx, 0, 150, 0.62) === undefined);
  const c2 = stubCtx();
  ok('drawWHistory 不抛', drawWHistory(c2, 640, 72, [0.1, 0.2, -0.1, 0.5]) === undefined);
  ok('drawWHistory 用了渐变', c2.__rec.calls.includes('createLinearGradient'));
  ok('drawWHistory 空数组安全', drawWHistory(c2, 640, 72, []) === undefined);
  ok('drawWHistory 单点安全', drawWHistory(c2, 640, 72, [0.3]) === undefined);
  ok('drawWHistory null ctx 安全', drawWHistory(null, 640, 72, [0.1]) === undefined);
}

// 回归：表盘顶部文字不得重叠（PWA 驾驶舱 canvas 仅 200px 宽，原实现三行文字挤同一 y → 出现“+0%0.0%目标仓位 空仓”乱码）
console.log('\n[signalCockpit: 表盘文字排布不重叠]');
{
  const SIZES = { bigW: 55, labW: 80, hintW: 120 };   // 实测尺寸（30px 大字 / 10px 标签 / 9px 提示）
  ok('宽画布(640) 同行不重叠', gaugeTextOk(640, SIZES, 28));
  ok('中宽(300) 不重叠', gaugeTextOk(300, SIZES, 28));
  ok('窄画布(200) 不重叠', gaugeTextOk(200, SIZES, 28));
  ok('极窄(170, 手机列) 不重叠', gaugeTextOk(170, SIZES, 28));
  ok('极窄(150) 不重叠', gaugeTextOk(150, SIZES, 28));
  ok('超短提示也不重叠', gaugeTextOk(200, { bigW: 55, labW: 80, hintW: 40 }, 28));
  ok('超长提示被隐藏而非重叠', posGaugeLayout(200, SIZES, 28).showHint === false);
  ok('宽画布保留提示', posGaugeLayout(640, SIZES, 28).showHint === true);
  ok('宽画布标签同行', posGaugeLayout(640, SIZES, 28).labY === 28);
  ok('窄画布标签下移一行', posGaugeLayout(200, SIZES, 28).labY === 46 && posGaugeLayout(200, SIZES, 28).labX === 28);
  ok('中宽: 标签下移但提示仍同行', (() => { const L = posGaugeLayout(300, SIZES, 28); return L.labY === 46 && L.showHint && L.hintY === 30; })());
  ok('非法尺寸安全', (() => { const L = posGaugeLayout(NaN, null, 28); return L.bigX === 28 && L.showHint === false; })());
  ok('自定义 padX 生效', posGaugeLayout(640, SIZES, 10).bigX === 10);
  ok('全部宽度扫描不重叠', (() => { for (let W = 120; W <= 800; W += 7) if (!gaugeTextOk(W, SIZES, 28)) return false; return true; })());
}

console.log('\n[signalCockpit: 基石区模型 / HTML]');
{
  const prevSig = globalThis.__alphaSignals, prevMarks = globalThis.__alphaLiveMarks;
  globalThis.__alphaSignals = { sym: 'BTCUSDT', tf: '1h', lastW: 0.62, factors: { carry: 1.85, momo: 0.34, brk: 0.6 }, ts: [1000, 2000], flips: [{ i: 1, dir: 1, w: 0.62 }], updatedT: 1 };
  globalThis.__alphaLiveMarks = [];
  const m = buildPillarModel(globalThis.__alphaSignals, 2000 + 3600000, null);
  ok('w=0.62', close(m.w, 0.62, 1e-9));
  ok('三因子', m.factors.length === 3);
  ok('age 由 flips bar 时间算 = 1h 前', m.ageTxt === '1h 前');
  ok('live=false（无 liveW）', m.live === false);
  const m2 = buildPillarModel(globalThis.__alphaSignals, 2000, 0.62);
  ok('live=true（liveW 达标）', m2.live === true);
  globalThis.__alphaLiveMarks = [{ t: 5000000, dir: 0.62 }];
  const m3 = buildPillarModel(globalThis.__alphaSignals, 5000000 + 1800000, null);
  ok('实盘 marks 优先 → 30m 前', m3.ageTxt === '30m 前');
  const sk = renderPillarSkeleton();
  ok('骨架含 scPillar/scPosGauge/scWHist/scFacs', sk.includes('id="scPillar"') && sk.includes('scPosGauge') && sk.includes('scWHist') && sk.includes('scFacs'));
  const html = renderPillarHtml(globalThis.__alphaSignals, 2000 + 3600000, null);
  ok('HTML 含因子行与占比', html.includes('carry') && html.includes('%'));
  ok('HTML 含 P3 徽章', html.includes('conf-ok'));
  ok('无信号 → 显示等待提示', renderPillarHtml(null, 0, null).includes('等待 Alpha 信号'));
  ok('updatePillar 无 DOM 安全返回', updatePillar(null, 0, null) === undefined);
  globalThis.__alphaSignals = prevSig; globalThis.__alphaLiveMarks = prevMarks;
}

console.log('\n[signalCockpit: comboFactors 与 comboWeight 同源]');
{
  const c1d = []; let p = 100; for (let i = 0; i < 60; i++) { p *= 1 + Math.sin(i * 0.3) * 0.01; c1d.push(p); }
  for (const z of [-10, -4, -1, 0, 1, 4, 10, null]) {
    const f = comboFactors(z, c1d, 40);
    ok('w 与 comboWeight 逐位一致 z=' + z, f.w === comboWeight(z, c1d, 40));
    ok('贡献之和 = sum z=' + z, close(f.carryW + f.momoW + f.brkW, f.sum, 1e-12));
    ok('|w| ≤ 1 z=' + z, Math.abs(f.w) <= 1 + 1e-12);
  }
  ok('carryW = 0.5·cW', close(comboFactors(-4, c1d, 40).carryW, 0.5 * 4, 1e-12));
  ok('z 正 → carryW 负（逆向）', comboFactors(4, c1d, 40).carryW < 0);
  ok('z 负 → carryW 正', comboFactors(-4, c1d, 40).carryW > 0);
  ok('z=null → cW=0', comboFactors(null, c1d, 40).cW === 0);
  ok('j<10 → momo=0', comboFactors(0, c1d, 5).mW === 0);
  ok('j<20 → brk=0', comboFactors(0, c1d, 15).bW === 0);
}

console.log('\n[signalCockpit: conclusionOf / buildReadoutModel]');
{
  const relR = relationOf({ alphaW: 0.62, band: 'lower' });
  const relC = relationOf({ alphaW: 0.62, band: 'upper' });
  const relN = relationOf({ alphaW: 0, band: 'neutral' });
  ok('PD 危险 → warn', conclusionOf(relR, 0.62, 1, 2, true).cls === 'warn');
  const c1 = conclusionOf(relC, 0.62, 1, 2, false);
  ok('冲突 → bad 且以基石为准', c1.cls === 'bad' && c1.txt.includes('以基石为准'));
  const c2 = conclusionOf(relR, 0.62, 1, 2, false);
  ok('共振未确认 → good 含 1/2', c2.cls === 'good' && c2.txt.includes('1/2'));
  const c3 = conclusionOf(relR, 0.62, 2, 2, false);
  ok('共振已确认 → good 含完成', c3.cls === 'good' && c3.txt.includes('完成'));
  ok('中性+空仓 → neu', conclusionOf(relN, 0, 0, 2, false).cls === 'neu');
  ok('中性+持多 → 持多', conclusionOf(relN, 0.4, 0, 2, false).txt.includes('持多'));

  const snap = { band: 'lower', confirmN: 1, pendConfirmRaw: { n: 2 }, pd: { score: 1, danger: false }, regime: { atrPct: 0.5, p25: 0.3, p75: 0.7 }, regimeState: 'mid', regimeGate: 'tconf' };
  const alphaSig = { sym: 'BTCUSDT', tf: '1h', lastW: 0.62, factors: { carry: 1.85, momo: 0.34, brk: 0.6 }, ts: [0, 0], flips: [] };
  const m = buildReadoutModel({ snap, alphaSig, now: 0, horizon: { flat: false, up: true, spreadPct: 2, deadZone: 0.5 }, macro: { tf: '7d', spreadPct: 2.3 } });
  ok('① 趋势上', m.trendLabel === '趋势上');
  ok('波动分位 中', m.volBand === '中');
  ok('② 基石多 62%', m.wDir === 'long' && close(m.w, 0.62, 1e-9));
  ok('主因 carry', m.mainFac && m.mainFac.key === 'carry');
  ok('③ 确认 1/2', m.confirmN === 1 && m.confirmNeed === 2);
  ok('④ 共振', m.rel.kind === 'resonance');
  const m2 = buildReadoutModel({ snap: Object.assign({}, snap, { band: 'upper' }), alphaSig, now: 0, horizon: null, macro: null });
  ok('上带 → 冲突', m2.rel.kind === 'conflict');
  ok('无 horizon → 数据不足', m2.trendLabel === '数据不足' && m2.deadZone === null);
  const m3 = buildReadoutModel({ snap: { pd: { score: 3, danger: true } }, alphaSig: null, now: 0 });
  ok('空输入不抛 + PD 危险', m3.pdDanger === true && m3.w === 0);
  const html = renderReadoutHtml(m);
  ok('解读 HTML 含雷达/关系 canvas + 结论', html.includes('scRadar') && html.includes('scRelVis') && html.includes('结论'));
}

console.log('\n[signalCockpit: 卫星接近度 proximityOf / proxText / proxWarn]');
{
  // 中性区：K=50，带 20/80 → 中点，closeness=0，最近带按距离取（50 到上下等距→up）
  const mid = proximityOf(50, 80, 20, 50);
  ok('中性中点 closeness=0', mid && close(mid.closeness, 0, 1e-9) && mid.zone === 'neutral' && !mid.inBand);
  // 贴近下带：K=22，带 20/80 → 距下带 2，半带 30 → closeness=1-2/30
  const nearDown = proximityOf(22, 80, 20, 25);
  ok('近下带 nearest=down', nearDown.nearest === 'down' && close(nearDown.closeness, 1 - 2 / 30, 1e-9));
  ok('近下带 未进带 willCross=false', nearDown.inBand === false && nearDown.willCross === false);
  // 已进上带：K=85，kClosed=70（还在带外）→ inBand + willCross
  const inUp = proximityOf(85, 80, 20, 70);
  ok('进上带 inBand + closeness=1', inUp.inBand && inUp.zone === 'upper' && close(inUp.closeness, 1, 1e-9));
  ok('进上带 willCross=true', inUp.willCross === true && inUp.nearest === 'up');
  // 已进带且已收盘也进带 → 不是“预演”
  ok('已收盘也进带 → willCross=false', proximityOf(85, 80, 20, 82).willCross === false);
  // 进下带 willCross（kClosed 还在带上方）
  ok('进下带 willCross=true', proximityOf(15, 80, 20, 30).willCross === true);
  // 非法/边界
  ok('null/非数 → null', proximityOf(null, 80, 20) === null && proximityOf(NaN, 80, 20) === null && proximityOf(50, 20, 20) === null);
  // proxText / proxWarn
  ok('proxText 距下带', proxText(nearDown) === '距下带 2.0');
  ok('proxText 已在上带', proxText(inUp) === '已在上带');
  ok('proxWarn 预演', proxWarn(inUp).includes('预演') || proxWarn(inUp).includes('将进带'));
  ok('proxWarn 接近中(≥0.75)', proxWarn(proximityOf(23, 80, 20, 25)).includes('接近中'));
  ok('proxWarn 远 → 空', proxWarn(mid) === '' && proxText(null) === '' && proxWarn(null) === '');
  // buildReadoutModel 接入
  const snap = { band: 'lower', confirmN: 1, pd: { score: 0, danger: false } };
  const m = buildReadoutModel({ snap, alphaSig: null, now: 0, proximity: { k: 22, kClosed: 25, upper: 80, lower: 20 } });
  ok('buildReadoutModel 带 prox', m.prox && m.prox.nearest === 'down');
  ok('无 proximity → prox=null', buildReadoutModel({ snap, alphaSig: null, now: 0 }).prox === null);
  ok('解读 HTML 含接近度条', renderReadoutHtml(m).includes('pwa-prox'));
}

console.log('\n[signalCockpit: 解读卡绘制冒烟]');
{
  const ctx = stubCtx();
  ok('drawRadar 不抛', drawRadar(ctx, 300, 230, [{ label: 'A', val: 0.5 }, { label: 'B', val: 0.2 }, { label: 'C', val: 0.9 }, { label: 'D', val: 0.1 }], 1) === undefined);
  ok('drawRadar 画了文本', ctx.__rec.calls.includes('fillText'));
  ok('drawRadar 空轴安全', drawRadar(ctx, 300, 230, []) === undefined && drawRadar(null, 1, 1, [{ label: 'A', val: 1 }]) === undefined);
  const c2 = stubCtx();
  ok('drawRelVis 共振不抛', drawRelVis(c2, 180, 70, relationOf({ alphaW: 0.5, band: 'lower' }), 0.5) === undefined);
  ok('drawRelVis 冲突不抛', drawRelVis(c2, 180, 70, relationOf({ alphaW: 0.5, band: 'upper' })) === undefined);
  ok('drawRelVis 中性不抛', drawRelVis(c2, 180, 70, relationOf({})) === undefined);
  ok('drawRelVis null 安全', drawRelVis(null, 180, 70, {}) === undefined);
}

console.log('\n[signalCockpit: P2 事件检测]');
{
  const base = { band: 'neutral', regimeState: 'mid', regimeGate: 'off', wBucket: 0, relKind: 'neutral' };
  ok('首帧无 prev → 无事件', detectCockpitEvents(null, base, {}).length === 0);
  const next = Object.assign({}, base, { band: 'upper' });
  const e1 = detectCockpitEvents(base, next, { now: 1, price: 100, sym: 'BTCUSDT' });
  ok('带态切换 → 1 事件 side=short', e1.length === 1 && e1[0].kind === '带态切换' && e1[0].side === 'short');
  ok('事件带 ts/price/sym', e1[0].ts === 1 && e1[0].price === 100 && e1[0].sym === 'BTCUSDT');
  const e2 = detectCockpitEvents(base, Object.assign({}, base, { wBucket: 0.6 }), {});
  ok('Alpha 调仓事件', e2.length === 1 && e2[0].kind === 'Alpha 调仓' && e2[0].side === 'long');
  const e3 = detectCockpitEvents(base, Object.assign({}, base, { regimeState: 'lowdrift' }), {});
  ok('regime 翻转事件', e3.length === 1 && e3[0].kind === 'regime 翻转');
  const e4 = detectCockpitEvents(base, Object.assign({}, base, { regimeGate: 'tconf' }), {});
  ok('闸门切换事件', e4.length === 1 && e4[0].kind === '闸门切换');
  const e5 = detectCockpitEvents(Object.assign({}, base, { relKind: 'conflict' }), Object.assign({}, base, { relKind: 'resonance' }), {});
  ok('关系翻转事件', e5.length === 1 && e5[0].kind === '关系翻转');
  ok('无变化 → 无事件', detectCockpitEvents(base, Object.assign({}, base), {}).length === 0);
  ok('下带 → side=long', detectCockpitEvents(base, Object.assign({}, base, { band: 'lower' }), {})[0].side === 'long');
  // 多类同时变化
  const multi = detectCockpitEvents(base, Object.assign({}, base, { band: 'lower', wBucket: -0.4, regimeState: 'high' }), {});
  ok('多类同时变化 → 3 事件', multi.length === 3);

  const st = cockpitStateOf({ band: 'upper', regimeState: 'mid', regimeGate: 'off' }, { lastW: 0.62 }, 2.3);
  ok('cockpitStateOf wBucket=0.6', close(st.wBucket, 0.6, 1e-9));
  ok('cockpitStateOf relKind=conflict', st.relKind === 'conflict');
  const st2 = cockpitStateOf({ band: 'lower' }, { lastW: 0.03 }, null);
  ok('wBucket 归零（<0.05）', st2.wBucket === 0);
}

console.log('\n[signalCockpit: P2 渲染 + cockpitEvents 累积]');
{
  ok('空事件 → 提示', renderEventsHtml([], 0).includes('暂无事件'));
  const html = renderEventsHtml([{ ts: 1700000000000, kind: '带态切换', side: 'short', note: 'neutral→upper', price: 118000 }], 0);
  ok('事件 HTML 含种类/说明/价格', html.includes('带态切换') && html.includes('neutral→upper') && html.includes('$'));
  const ctx = stubCtx();
  ok('drawEvSpark 不抛', drawEvSpark(ctx, 640, 46, [{ ts: Date.now() }], Date.now(), 12) === undefined);
  ok('drawEvSpark 空安全', drawEvSpark(ctx, 640, 46, [], Date.now()) === undefined && drawEvSpark(null, 1, 1, []) === undefined);

  clearCockpitEvents();
  const s0 = { band: 'neutral', regimeState: 'mid', regimeGate: 'off', price: 100, sym: 'BTCUSDT' };
  const a0 = { lastW: 0 };
  ok('首帧基线（不产生事件）', cockpitEvents(s0, a0, null, 1).length === 0);
  const s1 = { band: 'upper', regimeState: 'mid', regimeGate: 'off', price: 101, sym: 'BTCUSDT' };
  const evs = cockpitEvents(s1, { lastW: 0.6 }, 2.0, 2);
  ok('第二帧产生事件（带态+调仓+关系）', evs.length === 3);
  ok('事件已累积到存储', loadCockpitEvents().length === 3);
  ok('无变化帧不新增', cockpitEvents(s1, { lastW: 0.6 }, 2.0, 3).length === 0 && loadCockpitEvents().length === 3);
  const sX = { band: 'upper', regimeState: 'mid', regimeGate: 'off', price: 1, sym: 'ETHUSDT' };
  ok('切换币种 → 只重建基线（无跨币假事件）', cockpitEvents(sX, { lastW: 0.6 }, 2.0, 4).length === 0 && loadCockpitEvents().length === 3);
  clearCockpitEvents();
  ok('清空后为 0', loadCockpitEvents().length === 0);
}

console.log(`\n=== signalCockpit: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
