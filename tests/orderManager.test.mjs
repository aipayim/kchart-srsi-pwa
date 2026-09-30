// 订单管理：checkUserTpSl / reversePosition / 部分平仓 纯逻辑测试
import { kchartApi } from '../src/tech2/kchart.js';

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.log('FAIL:', m); } }

function mkEngine(pos) {
  const S = { prices: { BTCUSDT: { last: 80000 } }, pos };
  const exits = [];
  return {
    S, _exits: exits,
    exitPosition: (p, o) => { const i = S.pos.indexOf(p); if (i >= 0) S.pos.splice(i, 1); exits.push(o); },
    closePartial: (p, o) => { p.qty *= (1 - (o.ratio || 0)); p.amt *= (1 - (o.ratio || 0)); },
    placeOrder: (o) => { S.pos.push({ orderId: 'n' + Math.random(), sym: o.symbol, side: o.side, lev: o.lev, marginMode: o.marginMode, reinvest: o.reinvest, sid: o.sub, amt: o.amt, qty: o.amt * 10, entry: 80000, pnl: 0 }); }
  };
}
const mkPos = (over) => Object.assign({ orderId: 'a', sym: 'BTCUSDT', side: 'long', lev: 10, marginMode: 'usdt', reinvest: true, sid: 2, amt: 100, qty: 1000, entry: 80000, pnl: 0 }, over);

// ---- checkUserTpSl ----
let e = mkEngine([mkPos({ tp: 81000, sl: 79000 })]); e.S.prices.BTCUSDT.last = 81500;
ok(kchartApi.checkUserTpSl(e) === 1 && e.S.pos.length === 0, '多单 触达TP → 平仓');

e = mkEngine([mkPos({ tp: 81000, sl: 79000 })]); e.S.prices.BTCUSDT.last = 78000;
ok(kchartApi.checkUserTpSl(e) === 1 && e.S.pos.length === 0, '多单 触达SL → 平仓');

e = mkEngine([mkPos({ side: 'short', tp: 79000, sl: 81000 })]);
ok(kchartApi.checkUserTpSl(e) === 0 && e.S.pos.length === 1, '空单 未触达任何线 → 不平');
e.S.prices.BTCUSDT.last = 78000;
ok(kchartApi.checkUserTpSl(e) === 1 && e.S.pos.length === 0, '空单 触达TP → 平仓');
e = mkEngine([mkPos({ side: 'short', tp: 79000, sl: 81000 })]); e.S.prices.BTCUSDT.last = 82000;
ok(kchartApi.checkUserTpSl(e) === 1 && e.S.pos.length === 0, '空单 触达SL → 平仓');

e = mkEngine([mkPos({ tp: 81000, sl: 79000 })]); e.S.prices.BTCUSDT.last = 80500;
ok(kchartApi.checkUserTpSl(e) === 0, '价格在 TP/SL 之间 → 不触发');

// ---- 部分平仓 ----
e = mkEngine([mkPos({})]);
kchartApi.checkUserTpSl(e); // 无 TP/SL 不应触发
e.closePartial(e.S.pos[0], { ratio: 0.5, reason: 'x' });
ok(Math.abs(e.S.pos[0].qty - 500) < 1e-6, '部分平仓 qty 减半');
ok(Math.abs(e.S.pos[0].amt - 50) < 1e-6, '部分平仓 amt 减半');

// ---- 反手 ----
e = mkEngine([mkPos({ side: 'long', marginMode: 'coin', amt: 2, qty: 20 })]);
kchartApi.reversePosition(e, e.S.pos[0]);
ok(e.S.pos.length === 1, '反手后仅剩 1 仓');
ok(e.S.pos[0].side === 'short', '反手开反向(空)');
ok(e.S.pos[0].marginMode === 'coin', '反手保持币本位');
ok(e._exits.length === 1, '反手先平掉原仓');

console.log(`orderManager: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
