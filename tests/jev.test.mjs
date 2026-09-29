// Jev（LLM 多空判断 + 本地 TSEV 学习）单元测试（Node 原生，无框架）
// 覆盖：纯函数档位分类 / 状态文档（四组 + 未知）/ 请求体模板（转义、占位符、非法 JSON）/ 响应解析（score+choice）/
//       决策端点 URL 与调用（mock fetch：200/400/网络错误）/ 形状探测 / 面板模型（滑块三态、关系判定、单测渲染）/
//       到期判定 evalDecisionHorizon（多空 TP·SL、未到期、K线滚出窗口）/ jevStats 统计。
import {
  JEV_LEVELS, JEV_HORIZONS, JEV_DEFAULT_GROUPS, JEV_MODES,
  rsiZone, macdState, maState, volState, candlePattern, srsiBandText, atrBandText,
  resonanceText, timeWindow, buildJevState, renderTemplate, buildJevBody,
  parseJevResponse, jevSamplesFor, scoreToStrength, strengthLabel, jevSide
} from '../src/engine/jevState.js';
import { decisionEndpoint, decisionEndpointInfo, decisionCall, probeDecisionShapes, estimateTokens } from '../src/ai/llmClient.js';
import { parseJevFlow, flowFillSummary } from '../src/engine/jevState.js';
import { collectJevContext, jevSchedulerTick, planMaturation } from '../src/pwa/jevClient.js';
import { sliderView, jevTsevRelation, buildJevModel, renderJevHtml, renderJevSetHtml, buildJevHistory, renderJevHistoryHtml, JEV_DISCLAIMER, isStale } from '../src/tech2/jevPanel.js';
import { evalDecisionHorizon, jevStats, JEV_EVAL, readJevCfg } from '../src/pwa/jevClient.js';

let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; } else { failed++; console.log('FAIL:', name); } }
const near = (a, b, eps = 1e-9) => typeof a === 'number' && Math.abs(a - b) < eps;

// ============ 档位分类 ============
(function classify() {
  ok('rsiZone 超买', rsiZone(72) === '超买');
  ok('rsiZone 超卖', rsiZone(25) === '超卖');
  ok('rsiZone 中性', rsiZone(50) === '中性');
  ok('rsiZone null 安全', rsiZone(null) === null && rsiZone(NaN) === null);

  ok('macdState 金叉', macdState(0.5, -0.3) === '金叉');
  ok('macdState 死叉', macdState(-0.5, 0.3) === '死叉');
  ok('macdState 多头发散', macdState(0.8, 0.4) === '多头发散');
  ok('macdState 多头收敛', macdState(0.3, 0.6) === '多头收敛');
  ok('macdState 空头发散', macdState(-0.8, -0.4) === '空头发散');
  ok('macdState 首值', macdState(0.2, null) === '多头');

  ok('maState 多头排列站上', maState(110, 105, 100) === '站上均线(多头排列)');
  ok('maState 空头排列跌破', maState(95, 100, 105) === '跌破均线(空头排列)');
  ok('maState 缠绕', maState(100.05, 100, 90) === '缠绕均线');

  const vols = [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 30];
  const upC = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2];
  ok('volState 爆量上涨', volState(vols, upC) === '爆量上涨');
  const lowVols = vols.slice(); lowVols[20] = 4;
  ok('volState 缩量上涨', volState(lowVols, upC) === '缩量上涨');
  ok('volState 数据不足', volState([1, 2, 3], upC) === null);

  const cl = [1, 2, 3, 4, 5, 6, 7, 8];
  ok('candlePattern 连阳', candlePattern(cl, cl, cl).indexOf('连阳') >= 0);
  const dn = [8, 7, 6, 5, 4, 3, 2, 1];
  ok('candlePattern 连阴', candlePattern(dn, dn, dn).indexOf('连阴') >= 0);
  const brkC = [10, 10, 10, 10, 10, 10, 10, 9];
  const brkH = [10, 10, 10, 10, 10, 10, 10, 99];
  const brkL = [9, 9, 9, 9, 9, 9, 9, 8];
  ok('candlePattern 向上假突破', candlePattern(brkC, brkH, brkL).indexOf('向上假突破') >= 0);
  ok('candlePattern 输入不足', candlePattern([1, 2], [1, 2], [1, 2]) === null);

  ok('srsiBandText 上带', srsiBandText(85) === '上带');
  ok('srsiBandText 下带', srsiBandText(12) === '下带');
  ok('srsiBandText 中带', srsiBandText(50) === '中带');
  ok('srsiBandText null', srsiBandText(null) === null);

  ok('atrBandText 高波动', atrBandText(3, 1).indexOf('高波动') === 0);
  ok('atrBandText 低波动', atrBandText(0.4, 1).indexOf('低波动') === 0);
  ok('atrBandText 中波动', atrBandText(1.1, 1).indexOf('中波动') === 0);

  ok('resonanceText 一致偏多', resonanceText({ buy: 2, sell: 0 }) === '一致偏多(买2/卖0)');
  ok('resonanceText 一致偏空', resonanceText({ buy: 0, sell: 3 }) === '一致偏空(买0/卖3)');
  ok('resonanceText 分歧', resonanceText({ buy: 1, sell: 2 }) === '分歧(买1/卖2 多数偏空)');
  ok('resonanceText 无共振', resonanceText({ buy: 0, sell: 0 }) === '无共振');
  ok('resonanceText null', resonanceText(null) === null);

  ok('timeWindow 返回盘中/周末含 UTC', /UTC \d\d:\d\d/.test(timeWindow(Date.UTC(2026, 0, 5, 12, 0))) === true);
  ok('timeWindow 周末', timeWindow(Date.UTC(2026, 0, 4, 12, 0)).indexOf('周末') >= 0);
})();

// ============ 状态文档 ============
(function state() {
  const inp = {
    sym: 'BTCUSDT', group: 'short', tfs: ['5m', '15m'],
    tf: {
      '5m': { rsi: 65, macd: '多头发散', ma: '站上均线', vol: '放量突破', pattern: '连阳', momPct: 1.23, atr: '高波动(ATR 1.20%)', kd: [78, 65], band: '中带' },
      '15m': null
    },
    resonance: { buy: 2, sell: 1 },
    vd: { bull: true, bear: false, pct: -12 },
    sr: { supDistPct: -1.2, resDistPct: 0.8 },
    regime: { type: 'trend', direction: 'up', strength: 0.72 },
    volQ: 0.78,
    trend: { up: true, spreadPct: 2.1, tf: '4h' },
    macro: { up: false, spreadPct: -3.2, tf: '7d' },
    flow: { fundingRate: 0.0001, frTrend: '上升', taker: 1.12, longRatio: 53.9 },
    ext: { news: { sentiment: 'bullish', bullishCount: 2, bearishCount: 0, title: 'BTC ETF inflow' } },
    now: Date.UTC(2026, 0, 5, 12, 0)
  };
  const r = buildJevState(inp);
  ok('buildJevState 文本含四组标题', r.text.indexOf('【一、技术指标档位】') >= 0 && r.text.indexOf('【四、市场环境与体制】') >= 0);
  ok('buildJevState 含标的与周期', r.text.indexOf('标的: BTCUSDT') === 0 && r.text.indexOf('周期 5m/15m') > 0);
  ok('buildJevState 未知档显式写未知', r.text.indexOf('- 15m: 未知') >= 0);
  ok('buildJevState 资金费率档位（多头拥挤）', r.text.indexOf('多头拥挤') > 0);
  ok('buildJevState 主动买卖比', r.text.indexOf('主动买/卖 = 1.120') > 0);
  ok('buildJevState 未提供盘口 → flow 缺项', buildJevState({ sym: 'X', group: 'short', tfs: ['5m'], tf: {}, now: 1 }).missing.indexOf('盘口/订单流') >= 0);
  ok('buildJevState 量价背离文字', r.text.indexOf('底部背离') > 0);
  ok('buildJevState 时间窗口', r.text.indexOf('时间窗口:') > 0);
  ok('buildJevState 无原始 K 线（不含长数字序列）', !/\d{4,},\d{4,},\d{4,}/.test(r.text));
})();

// ============ 模板 / 请求体 ============
(function tpl() {
  const t = '{"model":"{{model}}","state":{{state}},"questions":{"q1":{"type":"score","instructions":"x","criteria":["a","b"]}}}';
  const o = renderTemplate(t, { model: 'jev-latest', state: 'A"B\nC' });
  ok('renderTemplate 裸写 state 转义为 JSON 字符串', o.state === 'A"B\nC');
  ok('renderTemplate 双引号包裹 model', o.model === 'jev-latest');
  const t2 = '{"a":"{{v}}"}';
  ok('renderTemplate 引号包裹占位符', renderTemplate(t2, { v: 'x"y' }).a === 'x"y');
  let threw = false;
  try { renderTemplate('{"a":{{b}}}', {}); } catch (e) { threw = e.message.indexOf('未替换占位符') >= 0; }
  ok('renderTemplate 未替换占位符报错', threw);
  threw = false;
  try { renderTemplate('{oops', { }); } catch (e) { threw = e.message.indexOf('不是合法 JSON') >= 0; }
  ok('renderTemplate 非法 JSON 报错', threw);

  const b = buildJevBody({ model: 'jev-latest', enabled: { short: true, mid: false, long: true } }, 'STATE');
  ok('buildJevBody 只含已勾选档', !!b.questions.short && !b.questions.mid && !!b.questions.long);
  ok('buildJevBody score criteria = 5 档', Array.isArray(b.questions.short.criteria) && b.questions.short.criteria.length === JEV_LEVELS.length);
  ok('buildJevBody 含 driver choice', b.questions.driver.type === 'choice' && !!b.questions.driver.criteria.技术面);
  ok('buildJevBody state 原样传入', b.state === 'STATE');
  let e2 = false;
  try { buildJevBody({ enabled: { short: false, mid: false, long: false } }, 'S'); } catch (e) { e2 = e.message.indexOf('至少勾选') >= 0; }
  ok('buildJevBody 全不勾选报错', e2);
  const viaTpl = buildJevBody({ model: 'M', template: '{"model":"{{model}}","state":{{state}},"questions":{"q1":{"instructions":"i"}}}' }, 'ST');
  ok('buildJevBody 模板优先', viaTpl.questions.q1.instructions === 'i' && viaTpl.model === 'M');
})();

// ============ 响应解析 ============
(function parse() {
  const score5 = { type: 'score', score: 3.48, confidence: 0.59, legend: { 0: '强空', 4: '强多' }, probabilities: { 3: 0.51 } };
  const r = parseJevResponse({
    model: 'jev-1.13.0', usage: { input_tokens: 473, output_tokens: 120 },
    answers: {
      short: score5,
      mid: { type: 'score', score: 2, confidence: 0.5 },
      long: { type: 'score', score: 0, confidence: 0.8 },
      driver: { type: 'choice', choice: '技术面', confidence: 0.9 }
    }
  });
  ok('parseJevResponse ok', r.ok === true && r.err === null);
  ok('parseJevResponse usage/model', r.usage.input_tokens === 473 && r.model === 'jev-1.13.0');
  ok('parseJevResponse score=3.48 → +74', r.horizons.short.strength === 74);
  ok('parseJevResponse score=2(中性) → 0', r.horizons.mid.strength === 0);
  ok('parseJevResponse score=0 → −100 强空', r.horizons.long.strength === -100 && r.horizons.long.label === '强空');
  ok('parseJevResponse driver', r.driver === '技术面');
  ok('parseJevResponse 置信度透传', r.horizons.short.conf === 0.59);

  const rc = parseJevResponse({ answers: { short: { type: 'choice', choice: '偏多', confidence: 0.98, probabilities: { 偏多: 0.99, 偏空: 0.0, 观望: 0.01 } } } });
  ok('parseJevResponse choice 概率差 → 强度', rc.horizons.short.strength === 99 && rc.horizons.short.label === '强多');

  const bad = parseJevResponse({});
  ok('parseJevResponse 缺 answers 报错', bad.ok === false && bad.err.indexOf('answers') >= 0);
  const bad2 = parseJevResponse({ answers: { x: { type: 'score', score: 1 } } });
  ok('parseJevResponse 无可识别档报错', bad2.ok === false);

  ok('scoreToStrength 边界钳制', scoreToStrength(99, JEV_LEVELS) === 100);
  ok('strengthLabel 分级', strengthLabel(60) === '强多' && strengthLabel(15) === '偏多' && strengthLabel(0) === '中性' && strengthLabel(-15) === '偏空');
  ok('jevSide 阈值', jevSide(15) === 'long' && jevSide(-15) === 'short' && jevSide(14) === 'flat' && jevSide(null) === 'flat');

  const smp = jevSamplesFor({ ok: true, horizons: { short: { strength: 60 }, mid: { strength: 0 }, long: { strength: -60 } } }, 'BTCUSDT', 1000);
  ok('jevSamplesFor 中性不留样本', smp.length === 2);
  ok('jevSamplesFor side 映射', smp[0].side === 'long' && smp[1].side === 'short');
})();

// ============ 决策端点 URL / 调用（mock fetch） ============
(function endpoint() {
  const savedLoc = globalThis.location;
  globalThis.location = { origin: 'http://localhost:5173', hostname: 'localhost', port: '5173' };
  ok('decisionEndpoint 本机其它端口 → /llm-proxy', decisionEndpoint({ baseUrl: 'http://localhost:3460/v1' }) === 'http://localhost:5173/llm-proxy/decisions');
  ok('decisionEndpoint 同端口不代理', decisionEndpoint({ baseUrl: 'http://localhost:5173/v1' }) === 'http://localhost:5173/v1/decisions');
  ok('decisionEndpoint 完整端点不重复拼', decisionEndpoint({ baseUrl: 'https://x/v1/decisions' }) === 'https://x/v1/decisions');
  ok('decisionEndpoint 远端直连', decisionEndpoint({ baseUrl: 'https://api.jev.ai/v1' }) === 'https://api.jev.ai/v1/decisions');
  ok('decisionEndpoint 空值回落代理（相对路径）', decisionEndpoint({}) === '/llm-proxy/decisions');
  if (savedLoc === undefined) delete globalThis.location; else globalThis.location = savedLoc;

  // v1.6.55：生产页面填 localhost → 必须给出可行动报错，而不是发一个必被 405 的请求
  globalThis.location = { origin: 'https://srsi.openapi.im', hostname: 'srsi.openapi.im', port: '' };
  const p1 = decisionEndpointInfo({ baseUrl: 'http://localhost:3460/v1' });
  ok('决策端点：生产页面 + localhost base → 不可用且带可行动提示', p1.url === '' && /localhost 只能由/.test(p1.err) && /https/.test(p1.err));
  ok('decisionEndpoint 不可用时返回空串', decisionEndpoint({ baseUrl: 'http://localhost:3460/v1' }) === '');
  const p2 = decisionEndpointInfo({ baseUrl: '' });
  ok('决策端点：生产页面 + 空 base → 提示必须填自己的端点', p2.url === '' && /必须填你自己的 Jev 端点/.test(p2.err));
  const p3 = decisionEndpointInfo({ baseUrl: 'https://api.jev.ai/v1' });
  ok('决策端点：生产页面 + 远端 https → 直连', p3.url === 'https://api.jev.ai/v1/decisions' && p3.err === null);
  const p4 = decisionEndpointInfo({ baseUrl: 'http://192.168.1.9:3460/v1' });
  ok('决策端点：生产页面 + 局域网 IP → 直连（由浏览器 CORS/混合内容把关）', p4.url === 'http://192.168.1.9:3460/v1/decisions' && p4.err === null);
  globalThis.location = { origin: 'http://localhost:5173', hostname: 'localhost', port: '5173' };
  const p5 = decisionEndpointInfo({ baseUrl: 'http://127.0.0.1:3460/v1' });
  ok('决策端点：本机页面 + 本机 base → 走 /llm-proxy', p5.url === 'http://localhost:5173/llm-proxy/decisions' && p5.proxied === true);
  if (savedLoc === undefined) delete globalThis.location; else globalThis.location = savedLoc;
})();

async function fetchTests() {
  const savedFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body), auth: opts.headers.Authorization });
    if (/fail400/.test(url)) return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: 'state must be a string' } }) };
    if (/net/.test(url)) throw new Error('Failed to fetch');
    return { ok: true, status: 200, text: async () => JSON.stringify({ model: 'jev-1.13.0', answers: { q1: { type: 'score', score: 3 } }, usage: { input_tokens: 10, output_tokens: 2 } }) };
  };
  try {
    const r = await decisionCall({ baseUrl: 'https://api.jev.ai/v1', apiKey: 'k1' }, { model: 'm', state: 's', questions: { q1: { type: 'score', instructions: 'i', criteria: ['a', 'b'] } } });
    ok('decisionCall 200 返回 json/usage', !!r.json.answers && r.usage.input_tokens === 10);
    ok('decisionCall 带上 Bearer token', calls[calls.length - 1].auth === 'Bearer k1');

    let msg = '';
    try { await decisionCall({ baseUrl: 'https://x/fail400', apiKey: 'k' }, { model: 'm' }); } catch (e) { msg = e.message; }
    ok('decisionCall 4xx 抛出含上游错误原文', msg.indexOf('HTTP 400') === 0 && msg.indexOf('state must be a string') > 0);
    ok('decisionCall 4xx 不重试（只 1 次请求）', calls.filter(c => /fail400/.test(c.url)).length === 1);

    let msg2 = '';
    try { await decisionCall({ baseUrl: 'https://x/net', apiKey: 'k' }, { model: 'm' }); } catch (e) { msg2 = e.message; }
    ok('decisionCall 网络错误 → 友好提示（重试 2 次）', msg2.indexOf('网络错误') >= 0 && calls.filter(c => /net/.test(c.url)).length === 2);

    let msg3 = '';
    try { await decisionCall({ baseUrl: 'https://x/y', apiKey: '' }, { model: 'm' }); } catch (e) { msg3 = e.message; }
    ok('decisionCall 缺 Token 报错', msg3.indexOf('缺少 Token') >= 0);

    const p = await probeDecisionShapes({ baseUrl: 'https://api.jev.ai/v1', apiKey: 'k' }, 'st', 'q');
    ok('probeDecisionShapes 返回 5 个候选形状', p.results.length === 5);
    ok('probeDecisionShapes 记录 winner', p.ok === true && !!p.winner);

    // 端点不可用 → 短路：不发请求、带 endpointErr（不回一堆 405/ERR）
    const savedLoc2 = globalThis.location;
    globalThis.location = { origin: 'https://srsi.openapi.im', hostname: 'srsi.openapi.im', port: '' };
    const n0 = calls.length;
    const p2 = await probeDecisionShapes({ baseUrl: 'http://localhost:3460/v1', apiKey: 'k' }, 'st', 'q');
    ok('probeDecisionShapes 端点不可用 → 短路不发请求', calls.length === n0 && p2.ok === false && p2.results.length === 5);
    ok('probeDecisionShapes 短路时带 endpointErr（可行动提示）', /localhost 只能由/.test(p2.endpointErr || '') && p2.results.every(x => x.status === 0));
    const p3 = await probeDecisionShapes({ baseUrl: 'https://api.jev.ai/v1', apiKey: '' }, 'st', 'q');
    ok('probeDecisionShapes 无 Token → 短路并说明', calls.length === n0 && /未填写 Token/.test(p3.endpointErr || ''));
    if (savedLoc2 === undefined) delete globalThis.location; else globalThis.location = savedLoc2;
  } finally {
    globalThis.fetch = savedFetch;
  }
  await fetchTests2();
}

async function fetchTests2() {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: { message: 'nope' } }) });
  try {
    const p = await probeDecisionShapes({ baseUrl: 'https://x/v1', apiKey: 'k' }, 'st', 'q');
    ok('probeDecisionShapes 全失败 → ok=false', p.ok === false && p.winner === null && p.results.every(x => x.ok === false));
  } finally { globalThis.fetch = savedFetch; }
  ok('estimateTokens 存在且为正', estimateTokens('hello world') > 0);
}

// ============ 面板模型 ============
(function panel() {
  ok('sliderView apply+有 Jev → source=jev', sliderView({ strength: 74, conf: 0.59 }, { long: null, short: null }, 'apply').source === 'jev');
  const sv = sliderView({ strength: 74, conf: 0.59 }, null, 'apply');
  ok('sliderView apply → 值 = Jev 强度', sv.value === 74 && sv.tone === 'long' && sv.tick === 0.59 && sv.affecting === true && sv.ghostValue === null);
  const sv2 = sliderView(null, { long: 0.8, short: -0.2 }, 'apply');
  ok('sliderView 无 Jev → 本机 TSEV 偏置', sv2.source === 'tsev' && sv2.value === Math.round((0.8 - (-0.2)) / 1.5 * 100));
  ok('sliderView 全无 → 0/none', sliderView(null, null, 'apply').source === 'none' && sliderView(null, null, 'apply').value === 0);

  // 三态开关必须真实生效（不能是装饰性设置）：learn 下 Jev 不计入强度
  const lv = sliderView({ strength: -41, conf: 0.85 }, null, 'learn');
  ok('sliderView learn：Jev 不计入强度（value 0 / source none）', lv.value === 0 && lv.source === 'none' && lv.affecting === false);
  ok('sliderView learn：Jev 位置以 ghost 标记保留', lv.ghostValue === -41);
  const lv2 = sliderView({ strength: -41, conf: 0.85 }, { long: 0.8, short: -0.2 }, 'learn');
  ok('sliderView learn + 有 TSEV 权重 → 值 = TSEV 偏置', lv2.value === 67 && lv2.source === 'tsev' && lv2.ghostValue === -41);
  const ov = sliderView({ strength: -41, conf: 0.85 }, null, 'off');
  ok('sliderView off 行为同 learn', ov.source === 'none' && ov.ghostValue === -41);
  ok('sliderView 三态差异可见（apply≠learn）', sliderView({ strength: -41 }, null, 'apply').value !== sliderView({ strength: -41 }, null, 'learn').value);

  ok('jevTsevRelation 同向', jevTsevRelation(60, { long: 0.5, short: null }).relation === 'agree');
  ok('jevTsevRelation 相反', jevTsevRelation(60, { long: -0.5, short: null }).relation === 'differ');
  ok('jevTsevRelation 样本不足', jevTsevRelation(60, { long: null, short: null }).relation === 'nodata');
  ok('jevTsevRelation 中性', jevTsevRelation(5, { long: 0.5, short: 0.1 }).relation === 'na');

  ok('isStale 无 ts 视为陈旧', isStale(null, 3600000, Date.now()) === true);
  ok('isStale 3 倍间隔内不陈旧', isStale(1000, 1000, 1000 + 2999) === false);
  ok('isStale 超 3 倍间隔陈旧', isStale(1000, 1000, 1000 + 3001) === true);

  const model = buildJevModel({
    sym: 'BTCUSDT',
    cfg: { enabled: true, mode: 'apply', freq: '1h', model: 'jev-latest', spend: { calls: 3, inTok: 1000, outTok: 200, cost: 0.01 } },
    hasToken: true,
    latest: { ts: Date.now(), ms: 900, driver: '技术面', dirs: { short: { strength: 74, conf: 0.59, label: '偏多' }, mid: { strength: -30, conf: 0.4, label: '偏空' }, long: { strength: 0, conf: 0.5, label: '中性' } } },
    stats: { byHorizon: { short: { n: 10, wins: 6, losses: 4, winRate: 0.6, avgPnl: 0.3 } }, learned: { short: { long: 0.5, short: null } }, n: 5, pending: 1 },
    status: {}, now: Date.now(), freqMs: 3600000
  });
  ok('buildJevModel 三档', model.rows.length === JEV_HORIZONS.length);
  ok('buildJevModel 关系计数（短同向/中样本不足/长中性）', model.relation.agree === 1 && model.relation.nodata === 1 && model.relation.na === 1);
  ok('buildJevModel modeText', model.modeText === JEV_MODES.apply.short);
  const html = renderJevHtml(model);
  ok('renderJevHtml 含免责声明', html.indexOf(JEV_DISCLAIMER) >= 0);
  ok('renderJevHtml 含三行滑块', (html.match(/jev-slider/g) || []).length >= 3);
  ok('renderJevHtml 含关系条', html.indexOf('Jev × TSEV 关系') >= 0);
  ok('renderJevHtml 含驱动', html.indexOf('主要驱动') >= 0);
  ok('renderJevHtml 含费用', html.indexOf('$0.0100') >= 0);
  ok('renderJevHtml 未启用提示', renderJevHtml(buildJevModel({ cfg: { enabled: false }, stats: { byHorizon: {}, learned: {} } })).indexOf('未启用：不产生调用与样本') >= 0);

  const setHtml = renderJevSetHtml({ enabled: true, baseUrl: 'http://localhost:3460/v1', model: 'jev-latest', freq: '1h', mode: 'learn', horizons: { short: true, mid: true, long: false }, groups: JEV_DEFAULT_GROUPS, price: {}, spend: { calls: 1, inTok: 10, outTok: 5, cost: 0 }, spend0: null }, { hasToken: true });
  ok('renderJevSetHtml 含启用/base/模型', setHtml.indexOf('id="jevEnabled"') > 0 && setHtml.indexOf('id="jevBase"') > 0 && setHtml.indexOf('id="jevModel"') > 0);
  ok('renderJevSetHtml 含频率三态与勾选', setHtml.indexOf('id="jevFreq"') > 0 && setHtml.indexOf('data-hz="long"') > 0);
  ok('renderJevSetHtml 含 Token 保存/清除/测试/探测/立即', setHtml.indexOf('idt="x"') < 0 && setHtml.indexOf('id="jevTokenSave"') > 0 && setHtml.indexOf('id="jevTokenClear"') > 0 && setHtml.indexOf('id="jevTest"') > 0 && setHtml.indexOf('id="jevProbe"') > 0 && setHtml.indexOf('id="jevRunNow"') > 0);
  ok('renderJevSetHtml 含高级模板', setHtml.indexOf('id="jevTpl"') > 0);
  ok('renderJevSetHtml 未勾 long → 不 checked', setHtml.indexOf('data-hz="long">') > 0 && setHtml.indexOf('data-hz="long" checked') < 0);
})();

// ============ 到期判定 / 统计 ============
(function mature() {
  const savedS = globalThis.S;
  const ev = JEV_EVAL.short;
  const t0 = 1700000000000;
  const closes = [], times = [];
  for (let i = 0; i < 100; i++) { closes.push(100 + i); times.push(t0 + i * 3600000); }
  globalThis.S = { klines: { BTCUSDT: { [ev.tf]: closes } }, klinesT: { BTCUSDT: { [ev.tf]: times } }, indicators: {} };
  try {
    const base = {
      sym: 'BTCUSDT', ts: t0, matured: false, entry: { short: { tf: ev.tf, price: 100, atr: 1 } },
      dirs: { short: { strength: 74 } }
    };
    const rLong = evalDecisionHorizon(base, 'short');
    ok('evalDecisionHorizon 看多 +2×ATR 先到 → win=1', !!rLong && rLong.win === 1 && rLong.tf === ev.tf);
    const rShort = evalDecisionHorizon(Object.assign({}, base, { dirs: { short: { strength: -74 } } }), 'short');
    ok('evalDecisionHorizon 看空逆行 1.5×ATR 先到 → win=−1', !!rShort && rShort.win === -1);
    const late = Object.assign({}, base, { ts: times[90] });
    ok('evalDecisionHorizon 未走满到期根数 → null', evalDecisionHorizon(late, 'short') === null);
    const out = Object.assign({}, base, { ts: times[0] - 999999999 });
    ok('evalDecisionHorizon 决策 bar 滚出窗口 → null', evalDecisionHorizon(out, 'short') === null);
    const flat = Object.assign({}, base, { dirs: { short: { strength: 3 } } });
    ok('evalDecisionHorizon 中性档 → null', evalDecisionHorizon(flat, 'short') === null);
    const noatr = Object.assign({}, base, { entry: { short: { tf: ev.tf, price: 100, atr: 0 } } });
    ok('evalDecisionHorizon 无 ATR → null', evalDecisionHorizon(noatr, 'short') === null);

    const decisions = [
      { sym: 'BTCUSDT', matured: true, dirs: { short: { strength: 74, conf: 0.6 } }, outcomes: { short: { win: 1, pnlPct: 2.5, side: 1 } } },
      { sym: 'BTCUSDT', matured: true, dirs: { short: { strength: 74, conf: 0.4 } }, outcomes: { short: { win: -1, pnlPct: -1.5, side: 1 }, mid: { win: 0, pnlPct: null, side: 1 } } },
      { sym: 'ETHUSDT', matured: false, dirs: { short: { strength: 60 } }, outcomes: {} }
    ];
    const st = jevStats(decisions, 'BTCUSDT');
    ok('jevStats 只统计本币', st.n === 2);
    ok('jevStats 命中率/均值盈亏', near(st.byHorizon.short.winRate, 0.5) && near(st.byHorizon.short.avgPnl, 0.5));
    ok('jevStats expired 计数', st.byHorizon.mid.expired === 1);
    ok('jevStats pending = 未成熟条数', st.pending === 0);
    const stAll = jevStats(decisions, null);
    ok('jevStats 不限币时包含全部', stAll.n === 3 && stAll.pending === 1);
    ok('jevStats 空输入安全', jevStats(null, 'X').n === 0);
  } finally {
    if (savedS === undefined) delete globalThis.S; else globalThis.S = savedS;
  }
})();

// ============ jevStats × 本机 TSEV（真实 getWeights 形状回归） ============
(function statsTsev() {
  const saved = globalThis.__localTsev;
  globalThis.__localTsev = {
    // localLoop.getWeights() 真实形状：{ perSym:{[sym]:{...}}, n }（不接受参数）
    getWeights: () => ({ perSym: { BTCUSDT: { 'jev|short|1': 1.099, 'jev|short|-1': -1.099 } }, n: 120 }),
    debugTsev: (sym) => (sym === 'BTCUSDT' ? [{ key: 'jev|short|1', n: 55, p: 0.75 }, { key: 'jev|short|-1', n: 55, p: 0.25 }] : [])
  };
  try {
    const st = jevStats([{ sym: 'BTCUSDT', matured: false, dirs: {}, outcomes: {} }], 'BTCUSDT');
    ok('jevStats 从 getWeights().perSym[sym] 取权重', st.learned.short.long === 1.099 && st.learned.short.short === -1.099);
    ok('jevStats 未学到的档为 null', st.learned.mid.long === null && st.learned.long.short === null);
    ok('jevStats fedN 汇总 jev 样本数', st.fedN === 110);
    ok('jevStats 解析样本进度（n/命中率）供面板显示', st.progress.short.long.n === 55 && near(st.progress.short.long.p, 0.75) && st.progress.short.short.n === 55);
    ok('jevStats 未提供的档 progress 为 null', st.progress.mid.long === null && st.progress.long.short === null);
    ok('jevStats minSample=50（与 TSEV 门槛一致）', st.minSample === 50);
    ok('jevStats weightsSource=local', st.weightsSource === 'local');
    const stNoSym = jevStats([{ sym: 'X', matured: false, dirs: {}, outcomes: {} }], 'X');
    ok('jevStats 其它币无权重 → null', stNoSym.learned.short.long === null);
    ok('jevStats getWeights 返回 null 安全', (() => {
      globalThis.__localTsev.getWeights = () => null;
      const s2 = jevStats([{ sym: 'BTCUSDT', matured: false, dirs: {}, outcomes: {} }], 'BTCUSDT');
      return s2.learned.short.long === null;
    })());
  } finally {
    if (saved === undefined) delete globalThis.__localTsev; else globalThis.__localTsev = saved;
  }
})();

// ============ 盘口/订单流解析 + 采集（v1.6.55） ============
(function flowParse() {
  const full = parseJevFlow({
    premium: { markPrice: 100.5, indexPrice: 100, lastFundingRate: 0.0001, nextFundingTime: 1 },
    oi: [{ sumOpenInterest: '1000' }, { sumOpenInterest: '1010' }],
    lsGlobal: [{ longAccount: 0.5399 }],
    lsTop: [{ longAccount: '0.61' }],
    taker: [{ buySellRatio: '1.12' }],
    prevRate: 0.00005
  });
  ok('parseJevFlow 五项全填', full.filledN === 5 && full.filled.funding && full.filled.basis && full.filled.oi && full.filled.ls && full.filled.taker);
  ok('parseJevFlow longAccount 0~1 小数 → 百分比', near(full.longRatio, 53.99) && near(full.topLongRatio, 61));
  ok('parseJevFlow 已是百分数不重复 ×100', near(parseJevFlow({ lsGlobal: [{ longAccount: 53.9 }] }).longRatio, 53.9));
  ok('parseJevFlow 基差计算', near(full.basisPct, 0.5));
  ok('parseJevFlow OI 变化%', near(full.oiChangePct, 1) && full.oiChangeBars === 2);
  ok('parseJevFlow frTrend 比上次', full.frTrend === '较上次↑' && near(full.frDelta, 0.00005));
  ok('parseJevFlow 无 prevRate 不给 trend', parseJevFlow({ premium: { lastFundingRate: 0.0001 } }).frTrend === undefined);
  const empty = parseJevFlow(null);
  ok('parseJevFlow 空输入安全', empty.filledN === 0 && empty.fundingRate === undefined && empty.longRatio === undefined);
  const partial = parseJevFlow({ premium: { lastFundingRate: '-0.0002' } });
  ok('parseJevFlow 部分可用（负费率）', partial.filledN === 1 && partial.fundingRate === -0.0002 && partial.filled.basis === undefined);
  ok('parseJevFlow 非法值不当数字', parseJevFlow({ taker: [{ buySellRatio: 'abc' }] }).taker === undefined);
  ok('parseJevFlow 不抛异常（全垃圾）', !!parseJevFlow({ oi: 5, lsGlobal: 'x', taker: {} }));

  ok('flowFillSummary 全有', flowFillSummary(full, { news: {} }).text === '盘口 5/5 · 新闻 ✓');
  const fs2 = flowFillSummary(parseJevFlow({ premium: { lastFundingRate: 0.0001 } }), null);
  ok('flowFillSummary 含缺口清单', fs2.flow.have === 1 && fs2.flow.missing.indexOf('持仓量') >= 0 && fs2.text.indexOf('缺：') > 0 && fs2.news === false);
  ok('flowFillSummary 空输入安全', flowFillSummary(null, null).flow.have === 0 && /新闻 未知/.test(flowFillSummary(null, null).text));
})();

async function contextTest() {
  const savedFetch = globalThis.fetch;
  const urls = [];
  const ok2 = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o), json: async () => o });
  globalThis.fetch = async (url) => {
    urls.push(url);
    if (url.indexOf('premiumIndex') >= 0) return ok2({ symbol: 'BTCUSDT', markPrice: 100.5, indexPrice: 100, lastFundingRate: 0.0001, nextFundingTime: 1 });
    if (url.indexOf('openInterestHist') >= 0) return ok2([{ sumOpenInterest: '1000' }, { sumOpenInterest: '1010' }]);
    if (url.indexOf('globalLongShortAccountRatio') >= 0) return ok2([{ longAccount: 0.5399 }]);
    if (url.indexOf('topLongShortAccountRatio') >= 0) return ok2([{ longAccount: '0.61' }]);
    if (url.indexOf('takerlongshortRatio') >= 0) return ok2([{ buySellRatio: '1.12' }]);
    return { ok: false, status: 404, text: async () => '' };
  };
  try {
    const ctx = await collectJevContext('BTCUSDT', { flowOpts: { force: true } });
    ok('collectJevContext 拉 5 个盘口接口', urls.filter(u => /fapi\/v1\/premiumIndex|futures\/data\//.test(u)).length === 5);
    ok('collectJevContext 填出 flow 各字段', near(ctx.flow.fundingRate, 0.0001) && near(ctx.flow.basisPct, 0.5) && near(ctx.flow.longRatio, 53.99) && near(ctx.flow.taker, 1.12));
    ok('collectJevContext OI 趋势文字', /上升 1\.00%/.test(ctx.flow.oiTrend || ''));
    ok('collectJevContext 大户 vs 散户对比文字', /大户更偏多/.test(ctx.flow.whale || ''));
    ok('collectJevContext fill 摘要', ctx.fill && ctx.fill.flow.have === 5 && ctx.fill.news === false);

    // 盘口全部失败 → flow 空但绝不抛错（拿不到就是未知，不影响 Jev 判断）
    globalThis.fetch = async () => ({ ok: false, status: 451, text: async () => '' });
    const ctx2 = await collectJevContext('ETHUSDT', { flowOpts: { force: true } });
    ok('collectJevContext 全失败 → flow 空 + 不抛错', Object.keys(ctx2.flow).length === 0 && ctx2.fill.flow.have === 0);
    ok('collectJevContext 全失败时 errs 有记录', Array.isArray(ctx2.errs));
  } finally { globalThis.fetch = savedFetch; }
}

// ============ 调度节流（1h 频率内不重复触发） ============
async function schedTest() {
  const savedFetch = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = async () => { posts++; return { ok: false, status: 400, text: async () => '{}', json: async () => ({}) }; };
  const jev = await import('../src/pwa/jevClient.js');
  try {
    // 未启用（Node 无 localStorage）→ 不触发
    for (let i = 0; i < 5; i++) jev.jevSchedulerTick();
    await new Promise(r => setTimeout(r, 50));
    ok('调度：未启用时不发请求', posts === 0 && jev.__jevSchedState().lastAttempt === 0);

    // 注入内存 localStorage，开启 Jev（1h）
    const store = {};
    globalThis.localStorage = {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; },
      key: i => Object.keys(store)[i] || null,
      get length() { return Object.keys(store).length; }
    };
    const { patchJevCfg } = await import('../src/pwa/jevClient.js');
    patchJevCfg({ enabled: true, freq: '1h', baseUrl: 'https://api.jev.ai/v1' });
    jev.jevSchedulerTick();
    const first = jev.__jevSchedState().lastAttempt;
    ok('调度：启用后首次 tick 即触发一次尝试', first > 0);
    for (let i = 0; i < 30; i++) jev.jevSchedulerTick();
    await new Promise(r => setTimeout(r, 60));
    ok('调度：1h 频率内后续 30 次 tick 不再触发（失败也不刷屏）', jev.__jevSchedState().lastAttempt === first);

    // manual 模式永不自动跑
    patchJevCfg({ freq: 'manual' });
    const before = jev.__jevSchedState().lastAttempt;
    for (let i = 0; i < 5; i++) jev.jevSchedulerTick();
    ok('调度：manual 模式不自动调用', jev.__jevSchedState().lastAttempt === before);
  } finally {
    globalThis.fetch = savedFetch;
    delete globalThis.localStorage;
  }
}

// ============ 面板：数据填充度 + 三态开关可见差异 + 样本进度 + 设置卡（v1.6.55/57） ============
(function panelFill() {
  const m = buildJevModel({
    sym: 'BTCUSDT', cfg: { enabled: true, mode: 'learn', freq: '1h' }, hasToken: true,
    latest: null, stats: { byHorizon: {}, learned: {} },
    fill: { text: '盘口 5/5 · 新闻 ✓', flow: { have: 5, total: 5, missing: [] } }, now: Date.now(), freqMs: 3600000
  });
  const h = renderJevHtml(m);
  ok('面板显示数据填充度（真实时）', h.indexOf('盘口 5/5 · 新闻 ✓') > 0);
  const h2 = renderJevHtml(buildJevModel({ cfg: { enabled: true }, stats: { byHorizon: {}, learned: {} }, fill: null }));
  ok('面板无填充度时提示拉不到不影响判断', h2.indexOf('不影响 Jev 判断') > 0);

  const s = renderJevSetHtml({ enabled: true, horizons: { short: true }, groups: JEV_DEFAULT_GROUPS, price: {}, spend: {} }, { hasToken: true });
  ok('设置卡含 Token 即时反馈行', s.indexOf('id="jevTokMsg"') > 0 && s.indexOf('已保存（AES-GCM') > 0);
  ok('设置卡含新闻源输入（带 {url} 说明）', s.indexOf('id="jevNews"') > 0 && s.indexOf('{url}') > 0);
  ok('设置卡说明 localhost 仅本机可用', s.indexOf('localhost 只指访问者自己') > 0);
  ok('设置卡未保存 Token 时提示未填写', renderJevSetHtml({ horizons: {}, groups: {}, price: {}, spend: {} }, { hasToken: false }).indexOf('未填写 Token') > 0);

  // 三态开关的可见差异 + 样本进度（回答「怎样才能生效」）
  const mk = (mode) => buildJevModel({
    sym: 'BTCUSDT', cfg: { enabled: true, mode, freq: '15m' }, hasToken: true,
    latest: { ts: Date.now(), dirs: { short: { strength: -41, conf: 0.85, label: '偏空' } }, driver: '技术面' },
    stats: { byHorizon: {}, learned: {}, progress: { short: { long: { n: 1, p: 1 }, short: null } }, n: 1, pending: 1, minSample: 50 },
    now: Date.now(), freqMs: 900000
  });
  const hApply = renderJevHtml(mk('apply'));
  const hLearn = renderJevHtml(mk('learn'));
  ok('apply 面板写「已计入」且无 ghost', hApply.indexOf('（已计入）') > 0 && hApply.indexOf('jev-sld-ghost') < 0);
  ok('learn 面板写「未计入」且带 ghost 标记', hLearn.indexOf('未计入') > 0 && hLearn.indexOf('jev-sld-ghost') > 0);
  ok('三态提示语随模式变化', hApply.indexOf('「学并影响」') > 0 && hLearn.indexOf('「只学不影响」') > 0 && renderJevHtml(mk('off')).indexOf('「关」') > 0);
  ok('未达门槛时显示样本进度 n/50', hLearn.indexOf('样本 看多 1/50（命中 100%） · 看空 0/50') > 0);
})();

// ============ 最近 N 笔判断历史（v1.6.58） ============
(function history() {
  const now = Date.now();
  const decs = [
    { ts: now - 60000, sym: 'BTCUSDT', model: 'jev-1.13.0', driver: '技术面', ms: 900, inTok: 2586, outTok: 95, matured: false,
      dirs: { short: { strength: -37, conf: 0.78, label: '偏空' }, mid: { strength: -6, conf: 0.54, label: '中性' }, long: { strength: 11, conf: 0.56, label: '中性' } },
      outcomes: null, err: null },
    { ts: now - 3600000, sym: 'BTCUSDT', driver: '资金面',
      dirs: { short: { strength: -50, conf: 0.8, label: '偏空' }, mid: { strength: 30, conf: 0.6, label: '偏多' }, long: { strength: 40, conf: 0.5, label: '偏多' } },
      outcomes: { short: { win: -1, pnlPct: -1.2, bars: 5, tf: '1h' }, mid: { win: 1, pnlPct: 2.4, bars: 12, tf: '4h' }, long: { win: 0, pnlPct: null, bars: 30, tf: '1d' } } },
    { ts: now - 7200000, sym: 'ETHUSDT', dirs: { short: { strength: -50, conf: 0.8, label: '偏空' } }, outcomes: {} },
    null,
    { ts: now - 10800000, sym: 'BTCUSDT', dirs: {}, outcomes: {} }
  ];
  const h = buildJevHistory(decs, 'BTCUSDT', { limit: 10 });
  ok('buildJevHistory 只含本币且去掉空记录', h.rows.length === 3 && h.rows.every(r => !!r.ts));
  ok('buildJevHistory 保持最新在前', h.rows[0].ts > h.rows[1].ts && h.rows[1].ts > h.rows[2].ts);
  ok('buildJevHistory 未到期 → pending', h.rows[0].horizons.every(x => x.status === 'pending'));
  ok('buildJevHistory 已判定：win/loss 分别标出', h.rows[1].horizons[0].status === 'loss' && h.rows[1].horizons[1].status === 'win');
  ok('buildJevHistory 方向档 win=0 → expired', h.rows[1].horizons[2].status === 'expired');
  ok('buildJevHistory 中性档不计入胜败', h.rows[0].horizons[1].status === 'pending' && h.rows[0].horizons[1].side === 'flat');
  ok('buildJevHistory 盈亏与周期透传', h.rows[1].horizons[0].pnl === -1.2 && h.rows[1].horizons[1].tf === '4h');
  ok('buildJevHistory 主方向取第一档有方向者', h.rows[0].mainSide === 'short' && h.rows[2].mainSide === 'flat');
  ok('buildJevHistory 汇总按档统计', h.summary.win === 1 && h.summary.loss === 1 && h.summary.expired === 1 && h.summary.pending === 3);
  ok('buildJevHistory 命中率/均盈亏', near(h.summary.winRate, 0.5) && near(h.summary.avgPnl, 0.6));
  ok('buildJevHistory limit 生效', buildJevHistory(decs, 'BTCUSDT', { limit: 2 }).rows.length === 2);
  ok('buildJevHistory 空输入安全', buildJevHistory(null, 'BTCUSDT').rows.length === 0 && buildJevHistory(null, null).summary.decided === 0);

  const html = renderJevHistoryHtml(h);
  ok('历史 HTML 含标题与笔数', html.indexOf('最近 3 笔判断') > 0);
  ok('历史 HTML 含汇总行（命中率/待回填）', /已判定 2 档 · 命中 1 · 未中 1 · 命中率 50%/.test(html) && /待回填 3/.test(html));
  ok('历史 HTML 每档带符号与盈亏', html.indexOf('✗ -1.20%') > 0 && html.indexOf('✓ +2.40%') > 0 && html.indexOf('⏳ 待回填') > 0 && html.indexOf('○ 未触发') > 0);
  ok('历史 HTML 带时间/驱动/置信', /class="sig-ev-t">\d\d:\d\d</.test(html) && html.indexOf('驱动 技术面') > 0 && html.indexOf('置信 78%/54%/56%') > 0);
  ok('renderJevHistoryHtml 空输入返回空串', renderJevHistoryHtml(null) === '' && renderJevHistoryHtml({ rows: [] }) === '');
  ok('历史 HTML 附到期口径说明（回答要等多久）', html.indexOf('到期口径') > 0 && html.indexOf('短 ≈24h') > 0 && html.indexOf('到期未触发不计胜负') > 0);

  const m = buildJevModel({
    sym: 'BTCUSDT', cfg: { enabled: true, mode: 'learn', freq: '15m', price: { inPer1M: 5, outPer1M: 30 } }, hasToken: true,
    latest: h.rows[0], stats: { byHorizon: {}, learned: {}, n: 3, pending: 3 }, history: h, now, freqMs: 900000
  });
  const full = renderJevHtml(m);
  ok('Jev 面板内嵌历史列表', full.indexOf('最近 3 笔判断') > 0 && full.indexOf('mar-sep') > 0);
  ok('无历史时不渲染列表', renderJevHtml(buildJevModel({ cfg: { enabled: true }, stats: { byHorizon: {}, learned: {} } })).indexOf('mar-sep') < 0);
  ok('设了单价 → 费用不再写「未设单价」', renderJevHtml(m).indexOf('未设单价') < 0);
  ok('未设单价 → 费用标「未设单价·本地网关免费」', renderJevHtml(buildJevModel({ cfg: { enabled: true, spend: { calls: 1 } }, stats: { byHorizon: {}, learned: {} } })).indexOf('未设单价') > 0);
})();

// ============ 回填幂等性（v1.6.59 关键修复：样本不得重复喂） ============
(function maturity() {
  const mkEval = (matured) => (rec, h) => {
    if (!matured.includes(h)) return null;
    if (h === 'mid') return { win: 0, side: 1, pnlPct: null, bars: 30, tf: '4h' };
    return { win: rec.dirs[h].strength < 0 ? 1 : -1, side: rec.dirs[h].strength < 0 ? -1 : 1, pnlPct: 1.5, bars: 5, tf: '1h' };
  };
  const rec = {
    sym: 'BTCUSDT', ts: 1,
    dirs: { short: { strength: -40 }, mid: { strength: 30 }, long: { strength: 0 } },
    samples: [{ horizon: 'short', side: 'short' }, { horizon: 'mid', side: 'long' }, { horizon: 'long', side: 'long' }]
  };
  const p1 = planMaturation(rec, mkEval(['short']));
  ok('planMaturation：只有短档到期 → toFeed 只含短', p1.toFeed.length === 1 && p1.toFeed[0].horizon === 'short');
  ok('planMaturation：看空档 win=1 → hit=true（方向判对了）', p1.toFeed[0].hit === true && p1.toFeed[0].win === 1);
  ok('planMaturation：未到期档不喂也不标记', p1.fed.mid === undefined && p1.fed.short === true);
  ok('planMaturation：中性档不产生样本（不进 toFeed）', !p1.toFeed.some(x => x.horizon === 'long'));
  ok('planMaturation：还有未到期档 → allDone=false', p1.allDone === false && p1.anyOutcome === true);

  // 关键：第二次调用（带持久化的 fed）绝不得重复喂
  rec.fed = p1.fed; rec.outcomes = p1.outcomes;
  const p2 = planMaturation(rec, mkEval(['short']));
  ok('planMaturation 幂等：第二次不再喂已喂过的档（防重复计数）', p2.toFeed.length === 0);

  // 中档到期但 win=0（到期未触发）→ 标记已喂但不计入样本
  const p3 = planMaturation(rec, mkEval(['short', 'mid']));
  ok('planMaturation：win=0 的档标记已喂但不入样本', p3.fed.mid === true && !p3.toFeed.some(x => x.horizon === 'mid'));

  // 全部到期 → allDone
  const p4 = planMaturation({ dirs: { short: { strength: -40 }, mid: { strength: 30 } }, samples: [] }, mkEval(['short', 'mid']));
  ok('planMaturation：方向档全到期 → allDone=true 且可结算', p4.allDone === true && p4.anyOutcome === true && Object.keys(p4.outcomes).length === 2);

  // 全中性记录：无方向档 → allDone=true（直接结算）、无 outcome
  const p5 = planMaturation({ dirs: { short: { strength: 5 }, mid: { strength: 0 } }, samples: [] }, mkEval([]));
  ok('planMaturation：全中性 → allDone=true / anyOutcome=false', p5.allDone === true && p5.anyOutcome === false);

  // 看多档 win=-1 → hit=false
  const p6 = planMaturation({ dirs: { short: { strength: 40 } }, samples: [{ horizon: 'short', side: 'long' }] }, mkEval(['short']));
  ok('planMaturation：看多档 win=−1 → hit=false', p6.toFeed.length === 1 && p6.toFeed[0].hit === false);
  ok('planMaturation 空输入安全', planMaturation(null, mkEval([])).toFeed.length === 0 && planMaturation(null, mkEval([])).allDone === true);
})();

// ============ 设置读写（Node 无 localStorage → 走默认值） ============
(function cfg() {
  const c = readJevCfg();
  ok('readJevCfg 默认值（无 localStorage）', c.enabled === false && c.freq === '1h' && c.mode === 'off' && c.model === 'jev-latest');
  ok('readJevCfg 默认三档全勾', c.horizons.short && c.horizons.mid && c.horizons.long);
  ok('readJevCfg 默认分组', c.groups.short.join(',') === '5m,15m,1h' && c.groups.long.join(',') === '7d,30d');
})();

await contextTest();
await schedTest();
await fetchTests();

console.log(`\n=== jev.test: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
