// 自适应组合面板单元测试（Node 原生，无框架）
// 覆盖：bucketLabel 边界、eventLabel 各 type（含未知/缺字段）、buildAdaptiveModel（null/异常/mock）、
//       adaptiveMetricsHtml/LegsHtml/EventsHtml/CardHtml 关键子串、renderAdaptiveFusion 无引擎不抛、
//       renderAdaptivePwa 签名守卫（值未变不重建 DOM）。
import {
  bucketLabel, eventLabel, buildAdaptiveModel,
  adaptiveMetricsHtml, adaptiveLegsHtml, adaptiveEventsHtml, adaptiveCardHtml,
  renderAdaptiveFusion, renderAdaptivePwa, resetAdaptivePanelSig,
} from '../src/tech2/adaptivePanel.js';

let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log('ok:', name); } else { failed++; console.log('FAIL:', name); } }
const has = (s, sub) => typeof s === 'string' && s.indexOf(sub) >= 0;

// ---------- mock ap ----------
function mkEvents(n = 20) {
  const types = ['volQ_cross', 'carry_rebalance', 'alpha_reweight', 'funding', 'enable'];
  const arr = [];
  for (let i = 0; i < n; i++) {
    arr.push({
      id: i + 1, ts: 1000 + i, type: types[i % types.length], sym: i % 2 ? 'BTCUSDT' : 'ETHUSDT',
      from: 'low', to: 'high', wA: 0.6, wC: 0.4, notional: i % 2 ? 100 : -100, pay: i % 2 ? 1.23 : -1.23, cum: 4.56,
    });
  }
  return arr;
}
function mockAp(over = {}) {
  const state = {
    enabled: true, capital: 1000, w0: 0.5, warming: false, equity: 1050, realized: 50, mode: 'mem',
    perSymbol: {
      BTCUSDT: {
        volQ: 0.21, g: 1.1, wA: 0.55, wC: 0.45, warming: false, alphaTarget: 0.3, alphaW: 0.165, bucket: 'low',
        carry: { symbol: 'BTCUSDT', inPosition: true, spotQty: 0.0012, perpQty: -0.0012, margin: 100, notional: 250.5, pnl: 1.1, equity: 101, fundingCum: 0.53, rebalCount: 2, liqCount: 0, rejectCount: 0, lastReason: null },
        err: null,
      },
      ETHUSDT: {
        volQ: 0.7, g: 0.6, wA: 0.3, wC: 0.7, warming: true, alphaTarget: 0, alphaW: 0, bucket: 'high',
        carry: null, err: null,
      },
    },
    ...over,
  };
  const events = mkEvents();
  return {
    getState: () => JSON.parse(JSON.stringify(state)),
    getEvents: (limit = 100) => events.slice(-limit),
    isEnabled: () => state.enabled,
    enable() { state.enabled = true; },
    disable() { state.enabled = false; },
    __state: state,
  };
}
function stubEl() {
  let v = '', sets = 0;
  return { get innerHTML() { return v; }, set innerHTML(x) { v = x; sets++; }, get sets() { return sets; } };
}

// ================= bucketLabel =================
console.log('\n[bucketLabel]');
ok('0 → 低波', bucketLabel(0) === '低波');
ok('0.33 → 低波', bucketLabel(0.33) === '低波');
ok('1/3 → 中波（边界含下）', bucketLabel(1 / 3) === '中波');
ok('0.5 → 中波', bucketLabel(0.5) === '中波');
ok('0.66 → 中波', bucketLabel(0.66) === '中波');
ok('2/3 → 高波', bucketLabel(2 / 3) === '高波');
ok('1 → 高波', bucketLabel(1) === '高波');
ok('NaN → —', bucketLabel(NaN) === '—');
ok('undefined → —', bucketLabel(undefined) === '—');
ok('Infinity → —', bucketLabel(Infinity) === '—');

// ================= eventLabel =================
console.log('\n[eventLabel]');
{
  const a = eventLabel({ type: 'volQ_cross', from: 'low', to: 'high', wA: 0.6 });
  ok('volQ_cross icon/color', a.icon === '🌡' && a.color === '#22d3ee');
  ok('volQ_cross text 中文桶+w_A', has(a.text, '波动率分位 低波→高波') && has(a.text, 'w_A 60%'));

  const b = eventLabel({ type: 'carry_rebalance', notional: 123.456, wC: 0.35 });
  ok('carry_rebalance icon/color', b.icon === '⚖' && b.color === '#f59e0b');
  ok('carry_rebalance text', has(b.text, 'carry 再平衡 名义 $123.46') && has(b.text, 'w_C 35%'));

  const c1 = eventLabel({ type: 'alpha_reweight', notional: 100 });
  ok('alpha_reweight 多', c1.icon === 'α' && c1.color === '#a78bfa' && has(c1.text, 'Alpha 调仓 → 多 $100.00'));
  const c2 = eventLabel({ type: 'alpha_reweight', notional: -100 });
  ok('alpha_reweight 空', has(c2.text, 'Alpha 调仓 → 空 $100.00'));

  const f1 = eventLabel({ type: 'funding', pay: 1.23, cum: 4.56 });
  ok('funding 收', f1.icon === '💰' && f1.color === '#00E676' && has(f1.text, '资金费 收 $1.23（累计 $4.56）'));
  const f2 = eventLabel({ type: 'funding', pay: -1.23, cum: 4.56 });
  ok('funding 付', has(f2.text, '资金费 付 $1.23'));

  ok('enable', eventLabel({ type: 'enable' }).text === '组合已启用' && eventLabel({ type: 'enable' }).color === '#2ecc71');
  ok('disable', eventLabel({ type: 'disable' }).text === '组合已停用' && eventLabel({ type: 'disable' }).color === '#8899aa');
  const er = eventLabel({ type: 'carry_error', reason: 'no balance' });
  ok('carry_error', er.icon === '⚠' && er.color === '#ff6b6b' && has(er.text, 'carry 错误：no balance'));

  const unk = eventLabel({ type: 'weird' });
  ok('未知 type → · 原文', unk.icon === '·' && unk.text === 'weird' && unk.color === '#8899aa');
  const empty = eventLabel();
  ok('无参不抛且 text 兜底', empty.icon === '·' && empty.text === '—');
  const miss = eventLabel({ type: 'volQ_cross' });
  ok('volQ_cross 缺字段兜底', has(miss.text, 'w_A —%') && has(miss.text, '—→—'));
}

// ================= buildAdaptiveModel =================
console.log('\n[buildAdaptiveModel]');
{
  ok('null → available:false', buildAdaptiveModel(null).available === false);
  ok('undefined → available:false', buildAdaptiveModel(undefined).available === false);
  ok('非对象 ap → available:false', buildAdaptiveModel({}).available === false);
  ok('getState 抛异常 → available:false', buildAdaptiveModel({ getState: () => { throw new Error('x'); } }).available === false);
  ok('getState 返回 null → available:false', buildAdaptiveModel({ getState: () => null }).available === false);

  const m = buildAdaptiveModel(mockAp());
  ok('available:true', m.available === true);
  ok('顶层字段', m.enabled === true && m.equity === 1050 && m.capital === 1000 && m.w0 === 0.5 && m.warming === false);
  ok('symbols 形状（key 顺序 BTC→ETH）', m.symbols.length === 2 && m.symbols[0].sym === 'BTCUSDT' && m.symbols[1].sym === 'ETHUSDT');
  ok('symbol 字段齐全', m.symbols[0].wA === 0.55 && m.symbols[0].wC === 0.45 && m.symbols[0].bucket === 'low' && m.symbols[0].warming === false);
  ok('carry 透传 / 无 carry 为 null', !!m.symbols[0].carry && m.symbols[1].carry === null);
  ok('events 最多 15 条', m.events.length === 15);
  ok('events 最新在前', m.events[0].ts === 1019 && m.events[14].ts === 1005);
  ok('events 挂 label', !!m.events[0].label && typeof m.events[0].label.icon === 'string');

  const apNoEv = mockAp();
  apNoEv.getEvents = () => 'nope';
  ok('getEvents 非数组 → events []', buildAdaptiveModel(apNoEv).events.length === 0);
}

// ================= HTML =================
console.log('\n[HTML builders]');
{
  ok('metrics null → 未初始化', has(adaptiveMetricsHtml(null), '未初始化'));
  const m = buildAdaptiveModel(mockAp());
  const h = adaptiveMetricsHtml(m);
  ok('metrics 含徽章/权益/状态', has(h, '低波') && has(h, '权益') && has(h, '● 运行中'));
  ok('metrics 含两个按钮 onclick', has(h, 'window.adaptiveToggle()') && has(h, 'window.adaptiveReset()'));
  ok('metrics 运行中按钮为「停用」', has(h, '>停用</button>'));

  const mOff = buildAdaptiveModel(mockAp({ enabled: false }));
  const hOff = adaptiveMetricsHtml(mOff);
  ok('未启用 → 灰字提示 + 启用按钮', has(hOff, '组合未启用（点启用开始纸面记录）') && has(hOff, '>启用</button>'));

  const legs = adaptiveLegsHtml(m);
  ok('legs 含两币', has(legs, 'BTCUSDT') && has(legs, 'ETHUSDT'));
  ok('legs 含 carry 明细', has(legs, '现货 0.0012') && has(legs, '永续 -0.0012') && has(legs, '保证金') && has(legs, '资金费') && has(legs, '再平衡 2'));
  ok('legs 无 carry → —', has(legs, '<div class="adp-leg-c">—</div>'));
  ok('legs 含 w_A/w_C', has(legs, 'w_A 55%') && has(legs, 'w_C 45%'));

  ok('events 空 → 暂无事件', has(adaptiveEventsHtml({ available: true, events: [] }), '暂无事件'));
  const evs = adaptiveEventsHtml(m);
  ok('events 含事件文本', has(evs, '波动率分位') || has(evs, 'carry 再平衡') || has(evs, 'Alpha 调仓') || has(evs, '资金费'));
  ok('events 含时间 HH:MM', /<span class="adp-ev-t">\d{2}:\d{2}/.test(evs));
  ok('events 含 icon span', has(evs, 'class="adp-ev-i"'));

  const card = adaptiveCardHtml(m);
  ok('card = metrics+legs+events', card === adaptiveMetricsHtml(m) + adaptiveLegsHtml(m) + adaptiveEventsHtml(m));
}

// ================= renderAdaptiveFusion =================
console.log('\n[renderAdaptiveFusion]');
{
  delete globalThis.__adaptivePortfolio;
  let out = null, threw = false;
  try { out = renderAdaptiveFusion(); } catch (e) { threw = true; }
  ok('无引擎不抛', threw === false && typeof out === 'string');
  ok('无引擎 → 未初始化提示', has(out, '未初始化'));

  globalThis.__adaptivePortfolio = mockAp();
  const out2 = renderAdaptiveFusion();
  ok('有引擎 → 卡片正文（低波/权益）', has(out2, '低波') && has(out2, '权益'));
  delete globalThis.__adaptivePortfolio;
}

// ================= renderAdaptivePwa 签名守卫 =================
console.log('\n[renderAdaptivePwa 签名守卫]');
{
  resetAdaptivePanelSig();
  const ap = mockAp();
  globalThis.__adaptivePortfolio = ap;
  const el = stubEl();
  renderAdaptivePwa(el);
  ok('首次渲染写入 DOM', el.sets === 1 && has(el.innerHTML, '低波'));
  renderAdaptivePwa(el);
  ok('值未变不重建（sets 仍 1）', el.sets === 1);
  ap.__state.equity = 1200;
  renderAdaptivePwa(el);
  ok('值变化后重建（sets 2）', el.sets === 2 && has(el.innerHTML, '1200'));
  renderAdaptivePwa(null);
  ok('el 为 null 不抛', true);
  delete globalThis.__adaptivePortfolio;
  resetAdaptivePanelSig();
  const el2 = stubEl();
  renderAdaptivePwa(el2);
  ok('无引擎渲染 → 未初始化提示', has(el2.innerHTML, '未初始化'));
}

console.log('\n[adaptivePanel] ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
