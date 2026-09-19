// 信号提醒总线单元测试（Node 原生，无框架）
// 覆盖：signalEventKey 去重键 / kindMeta 回退 / fmtSignalTime 今日与跨日 / sideText /
//       pushSignalEvent 去重+容量上限 / recentSignals 最新在前 / clearSignalEvents /
//       renderRecentSignalsHtml 空态与行渲染 / signalLine 摘要
import {
  SIG_EVENTS_KEY, MAX_SIGNAL_EVENTS, SIGNAL_KINDS,
  signalEventKey, kindMeta, fmtSignalTime, sideText,
  pushSignalEvent, loadSignalEvents, recentSignals, clearSignalEvents,
  renderRecentSignalsHtml, signalLine, onSignalEvent, offSignalEvent
} from '../src/tech2/signalAlerts.js';

let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log('ok:', name); } else { failed++; console.log('FAIL:', name); } }

// ---- localStorage 桩（模块级共享） ----
const _ls = {};
globalThis.localStorage = {
  getItem: (k) => (k in _ls ? _ls[k] : null),
  setItem: (k, v) => { _ls[k] = String(v); },
  removeItem: (k) => { delete _ls[k]; }
};

console.log('\n[signalAlerts: 纯函数]');
{
  ok('SIGNAL_KINDS 含核心种类', !!(SIGNAL_KINDS['srsi-edge-upper'] && SIGNAL_KINDS['alpha-rebal'] && SIGNAL_KINDS['srsi-preview']));
  // v1.6.25：主图机会点/钩也入流 + 上限 100
  ok('SIGNAL_KINDS 含机会点/钩四类', !!(SIGNAL_KINDS['srsi-cross-buy'] && SIGNAL_KINDS['srsi-cross-sell'] && SIGNAL_KINDS['srsi-hook-gold'] && SIGNAL_KINDS['srsi-hook-death']));
  ok('金钩/死钩方向与颜色', kindMeta('srsi-hook-gold').side === 'long' && kindMeta('srsi-hook-gold').color === '#00E676' && kindMeta('srsi-hook-death').side === 'short' && kindMeta('srsi-hook-death').color === '#FF5252');
  ok('机会点 buy/sell 方向与颜色', kindMeta('srsi-cross-buy').side === 'long' && kindMeta('srsi-cross-sell').side === 'short');
  ok('容量上限 = 100', MAX_SIGNAL_EVENTS === 100);
  ok('kindMeta 已知种类', kindMeta('srsi-edge-lower').side === 'long' && kindMeta('srsi-edge-lower').severity === 'signal');
  ok('kindMeta 未知回退', kindMeta('zzz').label === 'zzz' && kindMeta(null).label === '未知信号');
  ok('kindMeta 未知 color 有值', /^#/.test(kindMeta('zzz').color));

  const k1 = signalEventKey({ sym: 'BTCUSDT', kind: 'srsi-edge-upper', side: 'short', barT: 1000 });
  const k2 = signalEventKey({ sym: 'BTCUSDT', kind: 'srsi-edge-upper', side: 'short', barT: 1000 });
  const k3 = signalEventKey({ sym: 'BTCUSDT', kind: 'srsi-edge-upper', side: 'short', barT: 2000 });
  ok('eventKey 同输入相同', k1 === k2);
  ok('eventKey barT 不同则不同', k1 !== k3);
  ok('eventKey 空输入→空串', signalEventKey(null) === '');

  const now = new Date('2026-09-18T10:00:00').getTime();
  const todayTs = new Date('2026-09-18T08:30:00').getTime();
  const oldTs = new Date('2026-09-16T22:05:00').getTime();
  ok('fmtTime 今日→HH:MM', fmtSignalTime(todayTs, now) === '08:30');
  ok('fmtTime 跨日→MM-DD HH:MM', fmtSignalTime(oldTs, now) === '09-16 22:05');
  ok('fmtTime 非法→--', fmtSignalTime(NaN, now) === '--' && fmtSignalTime(0, now) === '--');

  ok('sideText long→多', sideText('long') === '多');
  ok('sideText short→空', sideText('short') === '空');
  ok('sideText flat→平', sideText('flat') === '平');
  ok('sideText w>0→多', sideText(null, 0.3) === '多');
  ok('sideText w<0→空', sideText(null, -0.3) === '空');
  ok('sideText 无信息→—', sideText(null, null) === '—');
}

console.log('\n[signalAlerts: 事件流]');
{
  clearSignalEvents();
  ok('初始为空', loadSignalEvents().length === 0);
  ok('空态文案含启动引导', renderRecentSignalsHtml().includes('启动信号引擎'));

  const e1 = pushSignalEvent({ sym: 'BTCUSDT', kind: 'srsi-edge-upper', side: 'short', price: 77900, barT: 1000, ts: 1000 });
  ok('push 返回事件', !!e1 && e1.kind === 'srsi-edge-upper');
  ok('push 归一化 price/w', e1.price === 77900 && e1.w === null);
  const e1dup = pushSignalEvent({ sym: 'BTCUSDT', kind: 'srsi-edge-upper', side: 'short', price: 77900, barT: 1000, ts: 1500 });
  ok('同 key 去重→null', e1dup === null && loadSignalEvents().length === 1);
  pushSignalEvent({ sym: 'BTCUSDT', kind: 'srsi-edge-lower', side: 'long', price: 77000, barT: 2000, ts: 2000 });
  pushSignalEvent({ sym: 'BTCUSDT', kind: 'alpha-rebal', side: 'short', w: -0.28, price: 77900, barT: 3000, ts: 3000 });
  ok('累计 3 条', loadSignalEvents().length === 3);
  const r = recentSignals(2);
  ok('recentSignals 最新在前', r.length === 2 && r[0].kind === 'alpha-rebal' && r[1].kind === 'srsi-edge-lower');
  ok('recentSignals 默认 8 条内', recentSignals().length === 3);

  // 容量上限
  clearSignalEvents();
  for (let i = 0; i < MAX_SIGNAL_EVENTS + 12; i++) pushSignalEvent({ sym: 'X', kind: 'srsi-preview', side: 'long', barT: i, ts: i });
  ok('容量上限生效', loadSignalEvents().length === MAX_SIGNAL_EVENTS);
  ok('丢最旧保留最新', loadSignalEvents()[loadSignalEvents().length - 1].barT === MAX_SIGNAL_EVENTS + 11);

  // 订阅
  clearSignalEvents();
  let got = 0;
  const fn = () => { got++; };
  onSignalEvent(fn);
  pushSignalEvent({ sym: 'Y', kind: 'srsi-open', side: 'long', barT: 1, ts: 1 });
  ok('订阅收到事件', got === 1);
  offSignalEvent(fn);
  pushSignalEvent({ sym: 'Y', kind: 'srsi-open', side: 'short', barT: 2, ts: 2 });
  ok('取消订阅后不再收到', got === 1);

  // 渲染
  clearSignalEvents();
  pushSignalEvent({ sym: 'BTCUSDT', kind: 'srsi-edge-upper', side: 'short', price: 77900, barT: 1, ts: Date.now() });
  pushSignalEvent({ sym: 'BTCUSDT', kind: 'srsi-confirm', side: 'short', count: 2, need: 2, price: 77950, barT: 2, ts: Date.now() });
  pushSignalEvent({ sym: 'BTCUSDT', kind: 'srsi-open', side: 'short', price: 77960, barT: 3, ts: Date.now() });
  const html = renderRecentSignalsHtml(8);
  ok('列表含破上带标签', html.includes('卫星·破上带（做空信号）'));
  ok('列表含确认计数', html.includes('确认 2/2'));
  ok('列表含价格', html.includes('77900'));
  ok('列表带 trade 样式类', html.includes('sig-ev-trade'));
  ok('列表空数据不抛', renderRecentSignalsHtml(0) === '' || renderRecentSignalsHtml(0).length >= 0);

  // signalLine
  const line = signalLine({ sym: 'BTCUSDT', kind: 'alpha-rebal', w: -0.28, price: 77900 });
  ok('signalLine 含标的与种类', line.includes('BTCUSDT') && line.includes('基石·调仓'));
  ok('signalLine 含 w 百分比', line.includes('-28%'));
  ok('signalLine 空事件不抛', typeof signalLine(null) === 'string');

  // 持久化
  ok('写入 localStorage', typeof localStorage.getItem(SIG_EVENTS_KEY) === 'string');
  clearSignalEvents();
  ok('清空后为 0', loadSignalEvents().length === 0);
}

console.log(`\n=== signalAlerts: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
