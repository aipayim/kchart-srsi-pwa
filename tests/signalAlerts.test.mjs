// 信号提醒总线单元测试（Node 原生，无框架）
// 覆盖：signalEventKey 去重键 / kindMeta 回退 / fmtSignalTime 今日与跨日 / sideText /
//       pushSignalEvent 去重+容量上限 / recentSignals 最新在前 / clearSignalEvents /
//       renderRecentSignalsHtml 空态与行渲染 / signalLine 摘要
import {
  SIG_EVENTS_KEY, MAX_SIGNAL_EVENTS, SIGNAL_KINDS,
  signalEventKey, kindMeta, fmtSignalTime, sideText, sideOf,
  pushSignalEvent, loadSignalEvents, recentSignals, clearSignalEvents,
  renderRecentSignalsHtml, renderSignalListHtml, LIVE_ONLY_SIGNAL_KINDS, signalLine, onSignalEvent, offSignalEvent
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
  // v1.6.39：仅信号·非成交类（机会点/钩）label 标注「历史≈随机」
  ok('机会点/钩 label 含历史≈随机', ['srsi-cross-buy', 'srsi-cross-sell', 'srsi-hook-gold', 'srsi-hook-death'].every(k => SIGNAL_KINDS[k].label.includes('历史≈随机')));
  ok('成交类 label 不加历史≈随机', !kindMeta('srsi-open', 'long').label.includes('≈随机') && !kindMeta('alpha-rebal', 'long').label.includes('≈随机'));
  ok('容量上限 = 100', MAX_SIGNAL_EVENTS === 100);
  ok('kindMeta 已知种类', kindMeta('srsi-edge-lower').side === 'long' && kindMeta('srsi-edge-lower').severity === 'signal');
  ok('kindMeta 未知回退', kindMeta('zzz').label === 'zzz' && kindMeta(null).label === '未知信号');
  ok('kindMeta 未知 color 有值', /^#/.test(kindMeta('zzz').color));
  // v1.6.26：主图标记符（icon）与按方向动态着色
  ok('每种 kind 都有 icon', Object.keys(SIGNAL_KINDS).every(k => SIGNAL_KINDS[k].icon));
  ok('钩=◆ / 机会=● / 预演=◌', kindMeta('srsi-hook-gold').icon === '◆' && kindMeta('srsi-cross-buy').icon === '●' && kindMeta('srsi-preview').icon === '◌');
  ok('破下带=▲ / 破上带=▼', kindMeta('srsi-edge-lower').icon === '▲' && kindMeta('srsi-edge-upper').icon === '▼');
  ok('未知 kind icon 回退 •', kindMeta('zzz').icon === '•');
  ok('srsi-open 按方向给 ▲/▼ 与颜色', kindMeta('srsi-open', 'long').icon === '▲' && kindMeta('srsi-open', 'long').color === '#2ecc71' && kindMeta('srsi-open', 'short').icon === '▼' && kindMeta('srsi-open', 'short').color === '#ff6b6b');
  ok('alpha-rebal 按方向给颜色（多青/空黄/平灰）', kindMeta('alpha-rebal', 'long').color === '#22d3ee' && kindMeta('alpha-rebal', 'short').color === '#f59e0b' && kindMeta('alpha-rebal', 'flat').color === '#8899aa');
  ok('alpha-close=◇', kindMeta('alpha-close').icon === '◇');
  ok('sideOf：side 优先 / w 推导 / 无→null', sideOf({ side: 'short' }) === 'short' && sideOf({ w: -0.3 }) === 'short' && sideOf({ w: 0.3 }) === 'long' && sideOf({ w: 0 }) === 'flat' && sideOf({}) === null);

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
  pushSignalEvent({ sym: 'BTCUSDT', kind: 'srsi-open', side: 'long', price: 77970, barT: 4, ts: Date.now() });
  const html = renderRecentSignalsHtml(8);
  ok('列表含破上带标签', html.includes('卫星·破上带（做空信号）'));
  ok('列表含确认计数', html.includes('确认 2/2'));
  ok('列表含价格', html.includes('77900'));
  ok('列表带 trade 样式类', html.includes('sig-ev-trade'));
  // v1.6.26：标记符 + 类型着色 + 左侧色条
  ok('列表每行有主图标记符 span', (html.match(/sig-ev-i/g) || []).length === 4);
  ok('列表含 ▼（破上带/开空）与 ▲（开多）', html.includes('>▼</span>') && html.includes('>▲</span>'));
  ok('列表信号名按类型着色（破上带红 / 开多绿）', html.includes('color:#ff6b6b">卫星·破上带') && html.includes('color:#2ecc71">卫星·开仓'));
  ok('列表整行左侧色条按类型', html.includes('border-left-color:#ff6b6b'));
  ok('列表 text 非字符串也不出 [object Object]', (() => {
    clearSignalEvents();
    pushSignalEvent({ sym: 'X', kind: 'alpha-rebal', w: 0.1, barT: 9, ts: Date.now() });
    const h = renderRecentSignalsHtml(4);
    return !h.includes('[object Object]');
  })());
  ok('列表空数据不抛', renderRecentSignalsHtml(0) === '' || renderRecentSignalsHtml(0).length >= 0);

  // v1.6.35：renderSignalListHtml（给定数组渲染）+ 仅事件类白名单
  ok('renderSignalListHtml 空数组 → 空态', renderSignalListHtml([]).includes('启动信号引擎'));
  ok('renderSignalListHtml 非数组不抛', renderSignalListHtml(null).includes('启动信号引擎'));
  {
    const arr = [
      { ts: Date.now(), kind: 'srsi-cross-buy', side: 'long', price: 100 },
      { ts: Date.now(), kind: 'alpha-close', side: 'flat', price: 101 },
      { ts: Date.now(), kind: 'srsi-hook-death', side: 'short', price: 102 }
    ];
    const h = renderSignalListHtml(arr);
    ok('renderSignalListHtml 条数=数组长度', (h.match(/sig-ev /g) || []).length === 3);
    ok('renderSignalListHtml 含机会/钩/α平', h.includes('跌入超卖') && h.includes('金钩') === false && h.includes('死钩') && h.includes('基石·平仓'));
    ok('renderSignalListHtml 不改原数组顺序', renderSignalListHtml(arr).indexOf('跌入超卖') < renderSignalListHtml(arr).indexOf('死钩'));
  }
  ok('LIVE_ONLY_SIGNAL_KINDS 含破带/预演/确认', ['srsi-edge-upper', 'srsi-edge-lower', 'srsi-preview', 'srsi-confirm'].every(k => LIVE_ONLY_SIGNAL_KINDS.indexOf(k) >= 0));
  ok('LIVE_ONLY_SIGNAL_KINDS 不含主图标记类', ['srsi-open', 'srsi-close', 'srsi-cross-buy', 'srsi-hook-gold', 'alpha-open', 'alpha-close'].every(k => LIVE_ONLY_SIGNAL_KINDS.indexOf(k) < 0));

  // signalLine
  const line = signalLine({ sym: 'BTCUSDT', kind: 'alpha-rebal', w: -0.28, price: 77900 });
  ok('signalLine 含标的与种类', line.includes('BTCUSDT') && line.includes('基石·调仓'));
  ok('signalLine 含 w 百分比', line.includes('-28%'));
  ok('signalLine 前缀主图标记符', line.indexOf('◆ ') === 0 && signalLine({ sym: 'X', kind: 'srsi-hook-death', side: 'short' }).indexOf('◆ ') === 0);
  ok('signalLine 空事件不抛', typeof signalLine(null) === 'string');

  // 持久化
  ok('写入 localStorage', typeof localStorage.getItem(SIG_EVENTS_KEY) === 'string');
  clearSignalEvents();
  ok('清空后为 0', loadSignalEvents().length === 0);
}

console.log(`\n=== signalAlerts: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
