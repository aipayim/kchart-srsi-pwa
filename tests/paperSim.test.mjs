import { PaperEngine } from '../src/exchange/PaperEngine.js';
import { ORDER_STATUS } from '../src/exchange/ExchangeAdapter.js';
import { THRESH } from '../src/engine/thresholds.js';

let fails = 0;
const check = (name, cond) => { if (!cond) { fails++; console.error('FAIL:', name); } else console.log('ok:', name); };
const approx = (a, b, eps = 1e-4) => Math.abs(a - b) < eps;

const logs = [];
function makeState(sim) {
  const S = {
    prices: { BTCUSDT: { last: 78000 }, ETHUSDT: { last: 3000 } },
    fusion: { fr: { BTCUSDT: 0.0001, ETHUSDT: 0.0001 } },
    subs: [{ id: 1, bal: 1000, st: 'idle', tr: 0, ex: 'Binance', pnl: 0, w: 0 }],
    pos: [], realized: 0, closed: [], ai: { w: 0, l: 0, sigScore: {}, sigLog: [] }
  };
  globalThis.window = {};
  window.S = S;
  window.log = (t, m) => logs.push([t, m]);
  const pe = new PaperEngine({ stateRef: () => window.S, onLog: window.log, getSlip: () => 0.0002 });
  window.getMarkPrice = (sym) => (S.prices[sym] || {}).last;
  if (sim) pe.seedSim(sim);
  return { S, pe };
}
const filled = (r) => r && r.status === ORDER_STATUS.FILLED;
// 模拟 tick: 用当前价更新持仓浮动盈亏(USDT 模式依赖 pos.pnl)
function tickPnl(S) { for (const p of S.pos) p.pnl = (p.side === 'long' ? (S.prices[p.sym].last - p.entry) : (p.entry - S.prices[p.sym].last)) * p.qty; }

// ---- 1) U本位空 + 再投: 盈利→币增, USDT 增一半 ----
{
  const sim = { spotUsdt: 5000, perpUsdt: 5000, coin: { BTCUSDT: 0 } };
  const { S, pe } = makeState(sim);
  const perp = pe.getPerpSub();
  const r = await pe.placeOrder({ symbol: 'BTCUSDT', side: 'short', lev: 10, amt: 100, marginMode: 'usdt', reinvest: true, sub: perp.id });
  check('U本位空 已成交', filled(r) && r.extra.positionIndex >= 0);
  check('开仓扣 USDT 保证金', perp.bal < 5000);
  S.prices.BTCUSDT.last = 77000;
  tickPnl(S);
  const beforeCoin = perp.coins.BTCUSDT || 0;
  const beforeBal = perp.bal;
  const cr = pe.exitPosition(S.pos[0], { reason: '手动平仓' });
  check('平仓后无持仓', S.pos.length === 0);
  check('U本位利润→USDT 增一半(>0)', perp.bal - beforeBal > 0);
  check('U本位利润→币库存增加', (perp.coins.BTCUSDT || 0) - beforeCoin > 0);
  check('再投比例≈50%', cr && approx((perp.coins.BTCUSDT || 0) - beforeCoin, cr.reinvestOther));
}

// ---- 2) 币本位多 + 再投: 盈利→USDT 增 ----
{
  const sim = { spotUsdt: 5000, perpUsdt: 5000, coin: { BTCUSDT: 0.01 } };
  const { S, pe } = makeState(sim);
  const perp = pe.getPerpSub();
  const r = await pe.placeOrder({ symbol: 'BTCUSDT', side: 'long', lev: 10, amt: 0.005, marginMode: 'coin', reinvest: true, sub: perp.id });
  check('币本位多 已成交', filled(r) && r.extra.positionIndex >= 0);
  const beforeUsdt = perp.bal;
  const beforeCoin = perp.coins.BTCUSDT;
  S.prices.BTCUSDT.last = 79000;
  const cr = pe.exitPosition(S.pos[0], { reason: '手动平仓' });
  check('币本位利润→USDT 增加', perp.bal - beforeUsdt > 0);
  check('币本位另一半利润留币(>0返还)', perp.coins.BTCUSDT - beforeCoin + 0.005 > 0);
  check('再投USDT≈利润一半*价', cr && approx(perp.bal - beforeUsdt, cr.reinvestOther, 1e-2));
}

// ---- 3) 币库存为0拒绝币本位开多 ----
{
  const sim = { spotUsdt: 5000, perpUsdt: 5000, coin: { BTCUSDT: 0 } };
  const { S, pe } = makeState(sim);
  const perp = pe.getPerpSub();
  const r = await pe.placeOrder({ symbol: 'BTCUSDT', side: 'long', lev: 10, amt: 0.005, marginMode: 'coin', reinvest: true, sub: perp.id });
  check('币库存0 拒绝币本位开多', !filled(r) && S.pos.length === 0);
}

// ---- 4) reinvest=false(AI/旧路径): 不转换资产 ----
{
  const sim = { spotUsdt: 5000, perpUsdt: 5000, coin: { BTCUSDT: 0 } };
  const { S, pe } = makeState(sim);
  const perp = pe.getPerpSub();
  const r = await pe.placeOrder({ symbol: 'BTCUSDT', side: 'long', lev: 10, amt: 100, sub: perp.id });
  check('旧路径默认U本位', filled(r) && r.extra.positionIndex >= 0 && S.pos[0].marginMode === 'usdt' && S.pos[0].reinvest === false);
  S.prices.BTCUSDT.last = 79000;
  tickPnl(S);
  const beforeCoin = perp.coins.BTCUSDT || 0;
  pe.exitPosition(S.pos[0], { reason: '手动平仓' });
  check('reinvest=false 不买币', (perp.coins.BTCUSDT || 0) - beforeCoin === 0);
  check('reinvest=false USDT 全额回收盈利', perp.bal > 5000);
}

// ---- 5) seedSim 幂等 ----
{
  const sim = { spotUsdt: 5000, perpUsdt: 5000, coin: { BTCUSDT: 0.02 } };
  const { S, pe } = makeState(sim);
  const n1 = S.subs.length;
  pe.seedSim(sim);
  check('seedSim 幂等不重复建子账户', S.subs.length === n1);
  check('perp 子账户带币库存', (pe.getPerpSub().coins.BTCUSDT || 0) === 0.02);
}

// ---- 6) resetSim 重建 ----
{
  const sim = { spotUsdt: 5000, perpUsdt: 3000, coin: { BTCUSDT: 0.03 } };
  const { S, pe } = makeState(sim);
  pe.resetSim(sim);
  const perp = pe.getPerpSub();
  check('resetSim 重建 perp USDT=3000', perp.bal === 3000);
  check('resetSim 重建币库存=0.03', (perp.coins.BTCUSDT || 0) === 0.03);
}

// ---- v1.6.22: 成交明细有界保留（S.closed 是用户数据，不能无界增长）----
{
  const { S, pe } = makeState({ spotUsdt: 5000, perpUsdt: 5000, coin: { BTCUSDT: 0 } });
  const perp = pe.getPerpSub();
  // 直接调 _recordClosed 模拟已累积大量成交明细
  S.closed = Array.from({ length: THRESH.CLOSED_MAX - 1 }, (_, i) => ({ t: i, sym: 'BTCUSDT', pnl: 1 }));
  pe._recordClosed({ pos: { sym: 'BTCUSDT', side: 'long', lev: 7, sid: perp.id, entry: 100, src: 'srsiAuto', marginMode: 'usdt' }, pnl: 5, reason: '测试', price: 101 });
  check('有界保留：未超上限时只追加', S.closed.length === THRESH.CLOSED_MAX);
  pe._recordClosed({ pos: { sym: 'BTCUSDT', side: 'long', lev: 7, sid: perp.id, entry: 100, src: 'srsiAuto', marginMode: 'usdt' }, pnl: 5, reason: '测试', price: 102 });
  check('有界保留：超上限后裁到 CLOSED_MAX', S.closed.length === THRESH.CLOSED_MAX);
  check('有界保留：裁掉的是最旧的（首条已被丢弃）', S.closed[0].t !== 0);
  check('有界保留：保留的是最新的', S.closed[S.closed.length - 1].exit === 102);
  check('CLOSED_MAX 为合理正数', Number.isFinite(THRESH.CLOSED_MAX) && THRESH.CLOSED_MAX >= 500);
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
