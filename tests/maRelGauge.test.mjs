// 均线关系仪表盘单元测试（Node 原生，无框架）
// 覆盖：maRelGaugeModel 的 ok/tone/devPct/bandDistPct/pos 钳制/bandPos/atr 回退/label 六分支，
//       maRelGaugeLayout 端点与居中，drawMaRelGauge 用 stub ctx 冒烟（ok=false 只画字、正常至少 arc/fillRect/fillText）。
import {
  toneOf, gaugeLabel, maRelGaugeModel, maRelGaugeLayout, drawMaRelGauge
} from '../src/tech2/maRelGauge.js';

let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log('ok:', name); } else { failed++; console.log('FAIL:', name); } }
const near = (a, b, eps = 1e-6) => typeof a === 'number' && Math.abs(a - b) <= eps;

// 构造 buildMaRelation(data) 形状的最小输入
function mkData({ price = 100, ma20 = 100, atrPct = 1, state = 'BULL', spreadPct = 0.5, thr = 1.2, squeezed = false } = {}) {
  return {
    ma: { fast: [90, 95, ma20], mid: [], slow: [] },
    info: { px: price, atrPct },
    market: { state, close: price },
    squeeze: { spreadPct, squeezed },
    opts: { squeezePct: thr },
  };
}

// 记录调用的 stub ctx
function stubCtx() {
  const calls = { arc: [], fillRect: [], strokeRect: [], fillText: [], clearRect: [], fill: 0, stroke: 0, beginPath: 0 };
  const ctx = {
    calls,
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: 'left', globalAlpha: 1,
    clearRect: (...a) => calls.clearRect.push(a),
    beginPath: () => { calls.beginPath++; },
    moveTo: () => {}, lineTo: () => {}, closePath: () => {},
    arc: (...a) => calls.arc.push({ r: a[2], x: a[0], y: a[1], style: ctx.fillStyle }),
    fill: () => { calls.fill++; },
    stroke: () => { calls.stroke++; },
    fillRect: (...a) => calls.fillRect.push({ x: a[0], y: a[1], w: a[2], h: a[3], style: ctx.fillStyle }),
    strokeRect: (...a) => calls.strokeRect.push({ x: a[0], y: a[1], w: a[2], h: a[3], style: ctx.strokeStyle }),
    fillText: (...a) => calls.fillText.push({ t: a[0], x: a[1], y: a[2], style: ctx.fillStyle }),
    save: () => {}, restore: () => {},
    measureText: (s) => ({ width: String(s).length * 6 }),
    setTransform: () => {}, createLinearGradient: () => ({ addColorStop: () => {} }),
  };
  return ctx;
}

console.log('\n[maRelGauge: toneOf / gaugeLabel]');
{
  ok('toneOf BULL→bull', toneOf('BULL') === 'bull');
  ok('toneOf BEAR→bear', toneOf('BEAR') === 'bear');
  ok('toneOf RANGE→range', toneOf('RANGE') === 'range');
  ok('toneOf 未知→range', toneOf('XXX') === 'range' && toneOf(undefined) === 'range');

  ok('label bull 带内', gaugeLabel('bull', true, 'in', 0, false) === '已回踩到 MA20 带内 → 等收盘站上 MA20 即可做多');
  ok('label bull 带上方', gaugeLabel('bull', false, 'above', 0.8, false) === '距回踩带 0.80%（再回踩一点就是入场机会）');
  ok('label bull 带下方', gaugeLabel('bull', false, 'below', -0.8, false) === '已跌破回踩带 → 需收盘重新站上 MA20 才有效');
  ok('label bear 带内', gaugeLabel('bear', true, 'in', 0, false) === '已反抽到 MA20 带内 → 等收盘跌破 MA20 即可做空');
  ok('label bear 带下方', gaugeLabel('bear', false, 'below', -0.8, false) === '距反抽带 0.80%');
  ok('label bear 带上方', gaugeLabel('bear', false, 'above', 0.8, false) === '已升破反抽带 → 需收盘重新跌破 MA20 才有效');
  ok('label range 未密集', gaugeLabel('range', false, 'above', 0, false) === '震荡：均线未密集，暂不猜方向');
  ok('label range 密集', gaugeLabel('range', false, 'above', 0, true) === '震荡：均线密集，等收盘带量跳出');
}

console.log('\n[maRelGaugeModel: ok 分支]');
{
  const bad1 = maRelGaugeModel(null);
  ok('null 数据 ok=false', bad1.ok === false && bad1.label === '数据不足');
  ok('null 数据 pos/bandPos 为 null', bad1.pos === null && bad1.bandPos === null);
  const bad2 = maRelGaugeModel({ ma: { fast: [] }, info: {} });
  ok('无均线 ok=false', bad2.ok === false);
  const bad3 = maRelGaugeModel({ ma: { fast: [null, 100] }, info: { px: null }, market: {} });
  ok('无价 ok=false', bad3.ok === false);
  const bad4 = maRelGaugeModel({ ma: { fast: [null, null] }, info: { px: 100 } });
  ok('均线全 null ok=false', bad4.ok === false);
  const bad5 = maRelGaugeModel({ ma: { fast: [0] }, info: { px: 100 } });
  ok('均线为 0 ok=false', bad5.ok === false);
  ok('ok=false 仍带 holdTxt', bad1.holdTxt === '站稳 = 收盘价站上 MA20（影线不算）');

  const m = maRelGaugeModel(mkData());
  ok('正常 ok=true', m.ok === true);
  ok('ma20 取数组末值', m.ma20 === 100);
  ok('price 取 info.px', m.price === 100);
  ok('holdTxt 固定文案', m.holdTxt === '站稳 = 收盘价站上 MA20（影线不算）');
  ok('atr = atrPct/100*price', near(m.atr, 1));
  ok('zeroPos 恒 0.5', m.zeroPos === 0.5);
}

console.log('\n[maRelGaugeModel: tone / devPct / above]');
{
  ok('BULL→bull', maRelGaugeModel(mkData({ state: 'BULL' })).tone === 'bull');
  ok('BEAR→bear', maRelGaugeModel(mkData({ state: 'BEAR' })).tone === 'bear');
  ok('RANGE→range', maRelGaugeModel(mkData({ state: 'RANGE' })).tone === 'range');
  const up = maRelGaugeModel(mkData({ price: 101, state: 'BULL' }));
  ok('devPct 正', near(up.devPct, 1));
  ok('above true（价≥MA20）', up.above === true);
  const dn = maRelGaugeModel(mkData({ price: 99, state: 'BEAR' }));
  ok('devPct 负', near(dn.devPct, -1));
  ok('above false', dn.above === false);
  const eq = maRelGaugeModel(mkData({ price: 100 }));
  ok('price=MA20 → devPct 0 / above true', near(eq.devPct, 0) && eq.above === true);
}

console.log('\n[maRelGaugeModel: 回踩带 / bandDistPct / bandSide]');
{
  // atrPct=1, ma20=100 → atr=1，回踩带 [99.8, 100.2]
  const inb = maRelGaugeModel(mkData({ price: 100 }));
  ok('价=MA20 → inBand', inb.inBand === true && inb.bandSide === 'in');
  ok('带内 bandDistPct=0', inb.bandDistPct === 0);
  ok('回踩带 = MA20 ∓ 0.2×ATR', near(inb.bandLo, 99.8) && near(inb.bandHi, 100.2));

  const edgeHi = maRelGaugeModel(mkData({ price: 100.2 }));
  ok('带边缘(hi) 仍 inBand', edgeHi.inBand === true && edgeHi.bandSide === 'in');
  const edgeLo = maRelGaugeModel(mkData({ price: 99.8 }));
  ok('带边缘(lo) 仍 inBand', edgeLo.inBand === true);

  const above = maRelGaugeModel(mkData({ price: 101 }));
  ok('带上方 bandSide=above', above.bandSide === 'above' && above.inBand === false);
  ok('带上方 bandDistPct 正', near(above.bandDistPct, 0.8));
  ok('带上方 label 文案', above.label === '距回踩带 0.80%（再回踩一点就是入场机会）');

  const below = maRelGaugeModel(mkData({ price: 99, state: 'BULL' }));
  ok('带下方 bandSide=below', below.bandSide === 'below');
  ok('带下方 bandDistPct 负', near(below.bandDistPct, -0.8));
  ok('带下方 label 文案', below.label === '已跌破回踩带 → 需收盘重新站上 MA20 才有效');

  const bearIn = maRelGaugeModel(mkData({ price: 100, state: 'BEAR' }));
  ok('bear 带内 label', bearIn.label === '已反抽到 MA20 带内 → 等收盘跌破 MA20 即可做空');
  const bearBelow = maRelGaugeModel(mkData({ price: 99, state: 'BEAR' }));
  ok('bear 带下方 label', bearBelow.label === '距反抽带 0.80%');
  const bearAbove = maRelGaugeModel(mkData({ price: 101, state: 'BEAR' }));
  ok('bear 带上方 label', bearAbove.label === '已升破反抽带 → 需收盘重新跌破 MA20 才有效');
  const rng = maRelGaugeModel(mkData({ state: 'RANGE', spreadPct: 0.5 }));
  ok('range 未密集 label', rng.label === '震荡：均线未密集，暂不猜方向');
  const rngSq = maRelGaugeModel(mkData({ state: 'RANGE', spreadPct: 0.5, squeezed: true }));
  ok('range 密集 label', rngSq.label === '震荡：均线密集，等收盘带量跳出');
}

console.log('\n[maRelGaugeModel: pos 轴 / 钳制 / bandPos]');
{
  const mid = maRelGaugeModel(mkData({ price: 100 }));
  ok('价=MA20 → pos 0.5', near(mid.pos, 0.5));
  const top = maRelGaugeModel(mkData({ price: 102 }));
  ok('价=MA20+2ATR → pos 1', near(top.pos, 1));
  const bot = maRelGaugeModel(mkData({ price: 98 }));
  ok('价=MA20-2ATR → pos 0', near(bot.pos, 0));
  const over = maRelGaugeModel(mkData({ price: 200 }));
  ok('超出上界 → pos 钳到 1', over.pos === 1);
  const under = maRelGaugeModel(mkData({ price: 10 }));
  ok('超出下界 → pos 钳到 0', under.pos === 0);
  ok('bandPos 两端单调 lo<hi', mid.bandPos[0] < mid.bandPos[1]);
  ok('bandPos ≈ [0.45, 0.55]', near(mid.bandPos[0], 0.45) && near(mid.bandPos[1], 0.55));
  ok('bandPos 全在 0..1', mid.bandPos.every((v) => v >= 0 && v <= 1));
}

console.log('\n[maRelGaugeModel: atr 无效回退 / 密集度透传]');
{
  const noAtr = maRelGaugeModel(mkData({ atrPct: null, price: 100 }));
  ok('atrPct null → atr=null', noAtr.atr === null);
  ok('atr 无效回退带 = MA20 ∓ 0.2%', near(noAtr.bandLo, 99.8) && near(noAtr.bandHi, 100.2));
  const noAtrAbove = maRelGaugeModel(mkData({ atrPct: null, price: 101 }));
  ok('atr 无效时 bandSide/距离仍正确', noAtrAbove.bandSide === 'above' && near(noAtrAbove.bandDistPct, 0.8));
  const zeroAtr = maRelGaugeModel(mkData({ atrPct: 0, price: 100 }));
  ok('atrPct=0 视为无效回退', near(zeroAtr.bandLo, 99.8) && near(zeroAtr.bandHi, 100.2));

  const sq = maRelGaugeModel(mkData({ spreadPct: 0.6, thr: 1.2, squeezed: true }));
  ok('squeezePct 透传', near(sq.squeezePct, 0.6));
  ok('squeezeThr 透传', near(sq.squeezeThr, 1.2));
  ok('squeezed 透传', sq.squeezed === true);
  const noOpts = maRelGaugeModel({ ma: { fast: [100] }, info: { px: 100 } });
  ok('无 opts → squeezeThr 默认 1.2', near(noOpts.squeezeThr, 1.2) && noOpts.squeezePct === null && noOpts.squeezed === false);
}

console.log('\n[maRelGaugeLayout]');
{
  const L = maRelGaugeLayout(298, 118);
  ok('x0 留边距 10', L.x0 === 10);
  ok('x1 = w-10', L.x1 === 288);
  ok('axisY ≈ h*0.52', near(L.axisY, 118 * 0.52, 1e-9));
  ok('labelY = h-6', L.labelY === 112);
  ok('bandH = 10 且 bandY 在轴下方', L.bandH === 10 && L.bandY > L.axisY);
  ok('tickStepPct 默认 0.5', L.tickStepPct === 0.5);
  ok('tickStepPct 可覆盖', maRelGaugeLayout(298, 118, { tickStepPct: 1 }).tickStepPct === 1);
  const Lbad = maRelGaugeLayout(NaN, undefined);
  ok('非法 w/h → 回退有限值', Number.isFinite(Lbad.x1) && Number.isFinite(Lbad.axisY) && Lbad.x1 > Lbad.x0);
  const Lsm = maRelGaugeLayout(10, 20);
  ok('极窄画布 x1 > x0', Lsm.x1 > Lsm.x0);
}

console.log('\n[drawMaRelGauge: stub ctx 冒烟]');
{
  // ok=false：只画一行「数据不足」，不画指针
  const c0 = stubCtx();
  drawMaRelGauge(c0, maRelGaugeModel(null), 298, 118, {});
  ok('ok=false 有 clearRect', c0.calls.clearRect.length === 1);
  ok('ok=false 画「数据不足」', c0.calls.fillText.some((f) => f.t === '数据不足'));
  ok('ok=false 不画 arc', c0.calls.arc.length === 0);
  ok('ok=false 不画回踩带 fillRect', c0.calls.fillRect.length === 0);

  // 正常：至少 arc / fillRect / fillText
  const c1 = stubCtx();
  drawMaRelGauge(c1, maRelGaugeModel(mkData()), 298, 118, { phase: 0 });
  ok('正常画 arc（指针+光晕）', c1.calls.arc.length >= 2);
  ok('正常画 fillRect（带+密集条）', c1.calls.fillRect.length >= 2);
  ok('正常画 fillText（刻度+MA20+label）', c1.calls.fillText.length >= 4);
  ok('刻度文字含 -2×ATR / +2×ATR / MA20', ['-2×ATR', '+2×ATR', 'MA20'].every((t) => c1.calls.fillText.some((f) => f.t === t)));
  ok('底部 label 已绘制', c1.calls.fillText.some((f) => f.t === '已回踩到 MA20 带内 → 等收盘站上 MA20 即可做多'));
  ok('密集度文字含「密集」', c1.calls.fillText.some((f) => String(f.t).indexOf('密集 ') === 0));
  ok('指针半径 phase=0 时为 5', c1.calls.arc.some((a) => near(a.r, 5)));

  // 脉冲：phase 改变半径
  const c2 = stubCtx();
  const phase = 380 * Math.PI / 2; // sin=1 → r=6.2
  drawMaRelGauge(c2, maRelGaugeModel(mkData()), 298, 118, { phase });
  ok('脉冲改变指针半径（phase 有效）', c2.calls.arc.some((a) => near(a.r, 6.2, 1e-9)));
  ok('两相位半径不同', Math.abs(Math.max(...c1.calls.arc.map((a) => a.r)) - Math.max(...c2.calls.arc.map((a) => a.r))) > 0.5);

  // tone 颜色：bear 用红指针 / 红色带
  const c3 = stubCtx();
  drawMaRelGauge(c3, maRelGaugeModel(mkData({ state: 'BEAR' })), 298, 118, {});
  ok('bear 指针用红', c3.calls.arc.some((a) => a.style === '#ff6b6b'));
  ok('bear 回踩带用红半透明', c3.calls.fillRect.some((r) => r.style === 'rgba(255,107,107,.22)'));
  ok('bear 带边框用红', c3.calls.strokeRect.some((r) => r.style === 'rgba(255,107,107,.7)'));

  // range 颜色
  const c4 = stubCtx();
  drawMaRelGauge(c4, maRelGaugeModel(mkData({ state: 'RANGE' })), 298, 118, {});
  ok('range 指针用金', c4.calls.arc.some((a) => a.style === '#f59e0b'));

  // 密集条颜色
  const c5 = stubCtx();
  drawMaRelGauge(c5, maRelGaugeModel(mkData({ spreadPct: 1.0, thr: 1.2, squeezed: true })), 298, 118, {});
  ok('密集时条用 #ffd740', c5.calls.fillRect.some((r) => r.style === '#ffd740'));
  const c6 = stubCtx();
  drawMaRelGauge(c6, maRelGaugeModel(mkData({ spreadPct: 0.1, thr: 1.2, squeezed: false })), 298, 118, {});
  ok('未密集条用 #4a5568', c6.calls.fillRect.some((r) => r.style === '#4a5568'));

  // opts.pos 覆盖模型 pos
  const c7 = stubCtx();
  drawMaRelGauge(c7, maRelGaugeModel(mkData()), 298, 118, { pos: 0.9 });
  const pointer7 = c7.calls.arc.find((a) => near(a.r, 5));
  ok('opts.pos 覆盖（x 落在轴右侧）', !!pointer7 && pointer7.x > 10 + (288 - 10) * 0.85);

  // 非法输入不抛
  let threw = false;
  try {
    drawMaRelGauge(stubCtx(), null, 298, 118, {});
    drawMaRelGauge(stubCtx(), { ok: true, tone: 'bull', pos: NaN, bandPos: [NaN, NaN], squeezePct: NaN, squeezeThr: NaN, label: null }, NaN, NaN, { phase: NaN, pos: NaN });
    drawMaRelGauge(stubCtx(), { ok: true, tone: 'bull', bandPos: 'x', pos: 'y', label: 123 }, 298, 118, null);
    drawMaRelGauge(null, maRelGaugeModel(mkData()), 298, 118, {});
  } catch (e) { threw = true; console.log('  threw:', e && e.message); }
  ok('非法输入不抛异常', threw === false);
  const c8 = stubCtx();
  drawMaRelGauge(c8, { ok: true, tone: 'bull', pos: NaN, bandPos: [NaN, NaN], squeezePct: NaN, squeezeThr: NaN, label: null }, 298, 118, { phase: NaN, pos: NaN });
  ok('NaN 模型仍能画完（fillText 非空）', c8.calls.fillText.length >= 3);
  ok('opts=null 不抛', (() => { try { drawMaRelGauge(stubCtx(), maRelGaugeModel(mkData()), 298, 118, null); return true; } catch (e) { return false; } })());
}

console.log(`\n=== maRelGauge.test: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
