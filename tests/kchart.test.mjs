/**
 * smart-trader K线分析 页面纯函数单元测试 (Node 原生, 无框架)
 *
 * 测试:
 *   indicators.js downsampleOHLC  (K线 OHLC 下采样聚合, 10m 由 5m)
 *   tech2/kchart.js __defaultKConfig / __buildSubListFor (SRSI 多子图短→长排序)
 */

import { deepStrictEqual, strictEqual } from 'assert';
import { downsampleOHLC, sumVol } from '../src/engine/indicators.js';
import { __defaultKConfig, __buildSubListFor, srsiPanelSeries, idxFromFrac, fmtVol, mainHoverAt, subHoverAt, nextKMode, kPresetCombos, buildSrsiOverview, overviewVerdict, analyzeTradeDiscipline, dirName, pickConfirm, latestCross, discLiveInfo, horizonTrend, macroTrend, atrPctHistory, deadZoneLatch, deadZoneValue, conflictPenalty, trendConflictNote, hookEnergy, leadingTF, signalLifecycle, isReversed, countBullBear } from '../src/tech2/kchart.js';
import { KLINE_TF } from '../src/engine/timeframe.js';

let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log('ok:', name); } else { failed++; console.log('FAIL:', name); } }
function close(a, b, eps = 1e-6) { return Math.abs(a - b) < eps; }
function deepEq(a, b) { try { deepStrictEqual(a, b); return true; } catch (e) { return false; } }

// ============================================================
//  K线 多周期（seq = 1 序）
// ============================================================
console.log('\n[kchart: SRSI 多子图 短→长排序]');
{
  // 只勾选部分周期, 期望按 分钟数 短→长
  const sel = { '1m': true, '1h': true, '5m': false, '15m': true, '1d': true };
  const show = { rsi: true, srsi: true, macd: true };
  const order = ['rsi', 'srsi', 'macd'];
  const list = __buildSubListFor(sel, show, order);
  const srsiTfs = list.filter(s => s.key === 'srsi').map(s => s.tf);
  ok('SRSI 子图按 短→长 排列', deepEq(srsiTfs, ['1m', '15m', '1h', '1d']));
  ok('RSI 在 SRSI 前(按顺序)', list[0].key === 'rsi' && list[0].name === 'RSI');
  ok('总子图数 = RSI+MACD+SRSI×N', list.length === 2 + srsiTfs.length);
}

{
  // 子图顺序可换: SRSI 置顶
  const sel = { '5m': true, '1h': true };
  const show = { rsi: true, srsi: true, macd: false };
  const order = ['srsi', 'rsi'];
  const list = __buildSubListFor(sel, show, order);
  ok('顺序: SRSI 在 RSI 前', list[0].key === 'srsi' && list[2].key === 'rsi');
  ok('MACD 已关不出现', list.every(s => s.key !== 'macd'));
}

{
  // 全部勾选 11 个周期 → 11 个 SRSI 子图, 短→长
  const sel = {};
  ['1m', '5m', '10m', '15m', '30m', '1h', '4h', '8h', '1d', '7d', '30d'].forEach(tf => sel[tf] = true);
  const show = { rsi: false, srsi: true, macd: false };
  const list = __buildSubListFor(sel, show, ['srsi']);
  const orderTf = list.map(s => s.tf);
  ok('全部 11 周期 SRSI 短→长', deepEq(orderTf, ['1m', '5m', '10m', '15m', '30m', '1h', '4h', '8h', '1d', '7d', '30d']));
}

{
  // 未勾选任何周期 → 无 SRSI 子图
  const sel = { '1m': false, '5m': false };
  const list = __buildSubListFor(sel, { rsi: true, srsi: true, macd: true }, ['rsi', 'srsi', 'macd']);
  ok('空勾选 → SRSI 无面板', list.every(s => s.key !== 'srsi'));
}

// ============================================================
//  downsampleOHLC: K线下采样聚合
// ============================================================
console.log('\n[kchart: downsampleOHLC OHLC 聚合]');
{
  const opens = [100, 101, 102, 103];
  const highs = [105, 104, 106, 104];
  const lows = [99, 100, 101, 102];
  const closes = [101, 102, 103, 103.5];
  const r = downsampleOHLC(opens, highs, lows, closes, 2);
  strictEqual(r.closes.length, 2, 'step=2, 4根 → 2根');
  ok('第1根 close = 第2根close', r.closes[0] === closes[1]);
  ok('第1根 open = 第1根open', r.opens[0] === opens[0]);
  ok('第1根 high = max(105,104)', r.highs[0] === 105);
  ok('第1根 low = min(99,100)', r.lows[0] === 99);
  ok('第2根 open = 第3根open', r.opens[1] === opens[2]);
  ok('第2根 high = max(106,104)', r.highs[1] === 106);
  ok('第2根 low = min(101,102)', r.lows[1] === 101);
  ok('第2根 close = 第4根close', r.closes[1] === closes[3]);
}

{
  // step=1 → 原样
  const r = downsampleOHLC([1, 2], [5, 6], [0, 1], [3, 4], 1);
  ok('step=1 原样输出', r.closes.length === 2 && r.opens[0] === 1 && r.closes[1] === 4);
}

{
  // 长度不足 → 丢弃最旧（右对齐，优先保留最新）
  const opens = [10, 20, 30, 40, 50];
  const highs = opens.map(v => v + 1);
  const lows = opens.map(v => v - 1);
  const closes = opens;
  const r = downsampleOHLC(opens, highs, lows, closes, 2);
  strictEqual(r.closes.length, 2, '5根 step2 → floor(5/2)=2 根');
  ok('第一组[1,2] close=第3根', r.closes[0] === 30);
  ok('末组 close=最后根(50)', r.closes[1] === 50);
  ok('第一组 open=第2根', r.opens[0] === 20);
}

{
  // 空输入/非法 step
  ok('空数组 → 空', downsampleOHLC([], [], [], [], 2).closes.length === 0);
  ok('step<1 → 空', downsampleOHLC([1, 2], [3, 4], [0, 0], [2, 2], 0).closes.length === 0);
}

// ============================================================
//  kConfig 默认参数
// ============================================================
console.log('\n[kchart: 默认配置]');
{
  const d = __defaultKConfig();
  ok('默认主图周期 5m', d.mainTF === '5m');
  ok('默认根线数 150', d.bars === 150);
  ok('默认 SRSI 参数存在', d.srsi && d.srsi.rsiPeriod && d.srsi.smoothK != null);
  ok('klineSel 覆盖全部 K 线周期', Object.keys(d.klineSel).length === 11);
  ok('默认三子图全开', d.show.rsi && d.show.srsi && d.show.macd);
}

// ============================================================
//  srsiPanelSeries —— SRSI warmup 修复 (v1.6)
// 需求: 默认 RSI=85 需 ~98 根 warmup 才能出现 KD(成下 98)。
//       若像旧代码那样"先 slice(-150) 再算", 150 根窗口里 KD 只在最后 ~52 根
//       (≈1/3 宽), 而 10m(5m下采样→75根) 根本到不了 98 → 不显示。
//       srsiPanelSeries 用全量历史 warmup, 只把展示切成最后 bars 根 → 全宽。
// ============================================================
console.log('\n[kchart: srsiPanelSeries SRSI warmup]');
function firstNonNull(ar) { for (let i = 0; i < ar.length; i++) if (ar[i] != null) return i; return -1; }
{
  // 合成够长的价格序列
  const mk = (n) => Array.from({ length: n }, (_, i) => 100 + Math.sin(i / 7) * 5 + i * 0.02);
  const conf = { rsiPeriod: 85, stochPeriod: 50, smoothK: 10, smoothD: 5 };

  // 500 根(修复后各 K 线周期实际量, 含 10m 下采样→250) → 展示 150 根应全宽
  ok('500根→展示150根: 首值 K 非空(warmup 铺满全宽)', firstNonNull(srsiPanelSeries(mk(500), conf, 150).k) === 0);
  ok('500根→展示150根: 首值 D 非空', firstNonNull(srsiPanelSeries(mk(500), conf, 150).d) === 0);
  ok('500根→展示150根: 返回长度=150', srsiPanelSeries(mk(500), conf, 150).k.length === 150);
  ok('500根→展示150根: crossings 长度=150', srsiPanelSeries(mk(500), conf, 150).crossings.length === 150);

  // 250 根(模拟 10m = 500 根 5m 下采样折半) → 也全宽
  ok('250根(模拟10m)→展示150根: K 首值非空', firstNonNull(srsiPanelSeries(mk(250), conf, 150).k) === 0);
  ok('250根(模拟10m)→展示150根: D 首值非空', firstNonNull(srsiPanelSeries(mk(250), conf, 150).d) === 0);

  // 旧 bug 对比: 若只给 150 根(旧 slice 后输入), warmup 后仍有 null → 这就是"右侧1/3"来源
  ok('旧式只给150根→K 首值仍为 null(证明旧截断 bug)', firstNonNull(srsiPanelSeries(mk(150), conf, 150).k) > 0);
  ok('旧式只给150根→D 首值仍为 null', firstNonNull(srsiPanelSeries(mk(150), conf, 150).d) > 0);

  // bars 小于可用长度
  ok('bars=100 且 500 根 → 返回 100 根 全宽', firstNonNull(srsiPanelSeries(mk(500), conf, 100).k) === 0 && srsiPanelSeries(mk(500), conf, 100).k.length === 100);

  // 防御: bars 超过数据长度 → 返回 数据全长(仍用全量warmup; 前端 warmup 段仍为 null, 末值非空)
  {
    const r = srsiPanelSeries(mk(250), conf, 500);
    ok('bars 超过数据长度 → 返回 数据全长', r.k.length === 250);
    ok('bars 超过数据长度 → 末值非空(有 KD 线)', r.k[r.k.length - 1] != null && r.d[r.d.length - 1] != null);
  }

  // 防御: 空输入
  ok('空输入 → 空数组', srsiPanelSeries([], conf, 150).k.length === 0);
  ok('长度不足2 → 空数组', srsiPanelSeries([100], conf, 150).k.length === 0);
}

// ============================================================
//  sumVol —— 成交量按 downsampleOHLC 同款右对齐分组求和
// ============================================================
console.log('\n[kchart: sumVol 成交量求和]');
{
  // 6 根, step=2 → 3 组
  const r = sumVol([1, 2, 3, 4, 5, 6], 2);
  ok('6根 step2 → 3 组', r.length === 3);
  ok('第1组[1,2] 和=3', r[0] === 3);
  ok('第2组[3,4] 和=7', r[1] === 7);
  ok('第3组[5,6] 和=11', r[2] === 11);

  // 右对齐: 5 根 step=2 → floor(5/2)=2, offset=1 → 组[2,3]=2+3=5, 组[4,5]=4+5=9 (首根丢弃,与 downsampleOHLC 对齐)
  const r2 = sumVol([1, 2, 3, 4, 5], 2);
  ok('5根 step2 右对齐 → 2 组', r2.length === 2 && r2[0] === 5 && r2[1] === 9);

  // 忽略 null/NaN
  const r3 = sumVol([null, 2, 3, NaN, 5, 6], 2);
  ok('null/NaN 按 0 求和', r3[0] === 2 && r3[2] === 11);

  // 防御
  ok('空数组 → 空', sumVol([], 2).length === 0);
  ok('step<1 → 空', sumVol([1, 2, 3], 0).length === 0);
}

// ============================================================
//  idxFromFrac / fmtVol 纯函数
// ============================================================
console.log('\n[kchart: idxFromFrac / fmtVol]');
{
  // len=10, bars=150 → n=10, start=0
  ok('len<=bars: frac0→0', idxFromFrac(0, 10, 150) === 0);
  ok('len<=bars: frac1→9', idxFromFrac(1, 10, 150) === 9);
  ok('len<=bars: frac0.5→5', idxFromFrac(0.5, 10, 150) === 5);
  ok('越界 frac<0 → 钳到 0', idxFromFrac(-1, 10, 150) === 0);
  ok('越界 frac>1 → 钳到9', idxFromFrac(5, 10, 150) === 9);

  // len=500, bars=150 → n=150, start=350
  ok('len>bars: frac0→350(窗口起点)', idxFromFrac(0, 500, 150) === 350);
  ok('len>bars: frac1→499', idxFromFrac(1, 500, 150) === 499);
  ok('len>bars: frac0.5→425', idxFromFrac(0.5, 500, 150) === 425);

  // 防御
  ok('len<=0 → -1', idxFromFrac(0, 0, 150) === -1);

  ok('fmtVol 千分位', fmtVol(4500) === '4.50K');
  ok('fmtVol 百万', fmtVol(1230000) === '1.23M');
  ok('fmtVol 小值', fmtVol(3.5) === '3.50');
  ok('fmtVol 空 → --', fmtVol(null) === '--');
}

// ============================================================
//  mainHoverAt / subHoverAt —— 依赖 window.S，用 stub 数据
// ============================================================
console.log('\n[kchart: mainHoverAt / subHoverAt 读数]');
{
  const sym = 'BTCUSDT', tf = '5m';
  const nBars = 10;
  const closes = [], opens = [], highs = [], lows = [], vols = [], times = [];
  for (let i = 0; i < nBars; i++) {
    closes.push(100 + i);
    opens.push(99 + i);
    highs.push(101 + i);
    lows.push(98 + i);
    vols.push(i + 1);
    times.push(1600000000000 + i * 300000);
  }
  globalThis.window = {
    S: {
      klinesO: { [sym]: { [tf]: opens } },
      klinesH: { [sym]: { [tf]: highs } },
      klinesL: { [sym]: { [tf]: lows } },
      klines: { [sym]: { [tf]: closes } },
      klinesV: { [sym]: { [tf]: vols } },
      klinesT: { [sym]: { [tf]: times } },
      indicators: {
        [sym]: {
          [tf]: {
            series: {
              rsi: closes.map(v => 50),
              macdLine: closes.map(v => 1),
              macdSignal: closes.map(v => 0.5),
              macdHist: closes.map(v => 0.5)
            }
          }
        }
      }
    }
  };

  // mainHoverAt: frac=0.5 → i=5, close=105, prev=104 → chg≈0.962%
  const m = mainHoverAt(0.5, sym, tf, 150);
  ok('mainHoverAt frac0.5 → i=5', m.i === 5);
  ok('mainHoverAt close=105', m.close === 105);
  ok('mainHoverAt open=104', m.open === 104);
  ok('mainHoverAt high=106', m.high === 106);
  ok('mainHoverAt low=103', m.low === 103);
  ok('mainHoverAt vol=6', m.vol === 6);
  ok('mainHoverAt chg≈0.9615%', close(m.chg, (105 - 104) / 104 * 100));
  ok('mainHoverAt time 正确', m.time === 1600000000000 + 5 * 300000);

  // 越界
  ok('mainHoverAt len=0 → null', mainHoverAt(0.5, sym, '1h', 150) === null);

  // subHoverAt: rsi
  const r = subHoverAt(0.5, sym, tf, 'rsi', 150);
  ok('rsi frac0.5 → i=5', r.i === 5 && r.rsi === 50);

  // macd
  const mc = subHoverAt(0.5, sym, tf, 'macd', 150);
  ok('macd 取值', mc.macd === 1 && mc.signal === 0.5 && mc.hist === 0.5);

  // srsi (基于 klines closes 计算, warmup 段可能 null——只用输出形状)
  const sr = subHoverAt(0.5, sym, tf, 'srsi', 150);
  ok('srsi 输出形状 (k/d/cross 字段)', 'k' in sr && 'd' in sr && 'cross' in sr);
}

// ============================================================
//  subHoverAt srsi 索引对齐回归 (len=500 > bars=150)
//  bug: srsiPanelSeries 切片后索引 0..n-1, 旧代码用绝对索引 i 取恒 undefined
// ============================================================
console.log('\n[kchart: subHoverAt srsi 索引对齐 (len>bars 回归)]');
{
  const sym = 'ETHUSDT', tf = '15m';
  const N = 500;
  const closes = [], opens = [], highs = [], lows = [], vols = [], times = [];
  for (let i = 0; i < N; i++) {
    const v = 100 + Math.sin(i / 7) * 3 + i * 0.01;
    closes.push(v);
    opens.push(v - 0.1);
    highs.push(v + 0.2);
    lows.push(v - 0.2);
    vols.push(i + 1);
    times.push(1600000000000 + i * 900000);
  }
  globalThis.window = {
    S: {
      klinesO: { [sym]: { [tf]: opens } },
      klinesH: { [sym]: { [tf]: highs } },
      klinesL: { [sym]: { [tf]: lows } },
      klines: { [sym]: { [tf]: closes } },
      klinesV: { [sym]: { [tf]: vols } },
      klinesT: { [sym]: { [tf]: times } },
      indicators: { [sym]: { [tf]: { series: {} } } }
    }
  };

  const bars = 150;
  const srsiCfg = __defaultKConfig().srsi;
  const sl = srsiPanelSeries(closes, srsiCfg, bars);

  // frac=0.5 → i=425, off=350, li=75
  const sr = subHoverAt(0.5, sym, tf, 'srsi', bars);
  ok('srsi 回归: i=425', sr.i === 425);
  ok('srsi 回归: k 非 null (旧代码恒 null)', typeof sr.k === 'number');
  ok('srsi 回归: k 与局部索引 sl.k[75] 对齐', close(sr.k, sl.k[75]));
  ok('srsi 回归: d 与局部索引 sl.d[75] 对齐', close(sr.d, sl.d[75]));

  // frac=0 → i=350, li=0 (窗口起点, warmup 已过)
  const s0 = subHoverAt(0, sym, tf, 'srsi', bars);
  ok('srsi 回归: frac0 → i=350, li=0', s0.i === 350);
  ok('srsi 回归: frac0 k 非 null', typeof s0.k === 'number');
  ok('srsi 回归: frac0 与 sl.k[0] 对齐', close(s0.k, sl.k[0]));

  // frac=1 → i=499, li=149 (窗口末尾)
  const s1 = subHoverAt(1, sym, tf, 'srsi', bars);
  ok('srsi 回归: frac1 → i=499, li=149', s1.i === 499);
  ok('srsi 回归: frac1 k 非 null', typeof s1.k === 'number');
  ok('srsi 回归: frac1 与 sl.k[149] 对齐', close(s1.k, sl.k[149]));

  // crossing 对齐: 非 null 判定一致
  ok('srsi 回归: crossing 对齐 (null 一致)', (sr.cross === null) === (sl.crossings[75] == null));
}


console.log('\n[kchart: 统一周期选择 nextKMode]');
{
  const base = { mainTF: '5m', klineSel: { '1m': false, '5m': true, '10m': false, '15m': true, '30m': false, '1h': true, '4h': false, '8h': false, '1d': false, '7d': false, '30d': false } };
  const r1 = nextKMode('1h', base, 'main');
  ok('点圆点→设为主图+自动勾选', r1.mainTF === '1h' && r1.sel['1h'] === true);
  ok('设主图不改变其他勾选', r1.sel['5m'] === true && r1.sel['4h'] === false);
  const r2 = nextKMode('4h', base, 'srsi');
  ok('点方框→切换 SRSI 子图', r2.sel['4h'] === true);
  ok('srsi 切换不改主图', r2.mainTF === '5m');
  const r3 = nextKMode('5m', base, 'srsi');
  ok('取消勾选主图→主图落到首个仍勾选周期', r3.mainTF === '15m' && r3.sel['5m'] === false);
  const only = { mainTF: '5m', klineSel: { '1m': false, '5m': true, '10m': false, '15m': false, '30m': false, '1h': false, '4h': false, '8h': false, '1d': false, '7d': false, '30d': false } };
  const r4 = nextKMode('5m', only, 'srsi');
  ok('取消最后一个勾选→主图保持不变', r4.mainTF === '5m');
}

console.log('\n[kchart: 快捷预设 kPresetCombos]');
{
  const scalp = kPresetCombos('scalp');
  ok('短线: main=5m', scalp.mainTF === '5m');
  ok('短线: 勾选 1m/5m/15m', scalp.sel['1m'] && scalp.sel['5m'] && scalp.sel['15m']);
  ok('短线: 未勾选 4h/1d', !scalp.sel['4h'] && !scalp.sel['1d']);
  const day = kPresetCombos('day');
  ok('日内: main=1h', day.mainTF === '1h');
  ok('日内: 勾选 15m/1h/4h', day.sel['15m'] && day.sel['1h'] && day.sel['4h']);
  const swing = kPresetCombos('swing');
  ok('波段: main=1d', swing.mainTF === '1d');
  ok('波段: 勾选 4h/1d/7d', swing.sel['4h'] && swing.sel['1d'] && swing.sel['7d']);
  ok('未知预设→回退日内', kPresetCombos('zzz').mainTF === '1h');
  const allc = kPresetCombos('all');
  ok('全选: mainTF=null(保持主图不变)', allc.mainTF === null);
  ok('全选: all 标记', allc.all === true);
  ok('全选: 勾选全部 11 周期', KLINE_TF.every(tf => allc.sel[tf]));
}

console.log('\n[kchart: 多周期 SRSI 速览 buildSrsiOverview]');
{
  const srsi = { rsiPeriod: 85, stochPeriod: 50, smoothK: 10, smoothD: 5, overbought: 80, oversold: 20 };
  const bull = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(100 + (i % 25) * 0.8 - (i % 7) * 0.1); return a; };
  const bear = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(300 - (i % 25) * 0.8 + (i % 7) * 0.1); return a; };
  const flat = (n) => new Array(n).fill(150);
  const pm = { '5m': bull(500), '1h': bear(500), '4h': flat(500) };
  const ov = buildSrsiOverview(['4h', '1h', '5m'], srsi, pm, 150);
  ok('行按 短→长 排序', ov.rows.map(r => r.tf).join(',') === '5m,1h,4h');
  ok('5m 多头趋势→超买', ov.rows[0].zone === 'overbought');
  ok('5m K 有数值', typeof ov.rows[0].k === 'number');
  ok('5m 超买边界 K>80', ov.rows[0].k > 80);
  ok('1h 空头趋势→超卖', ov.rows[1].zone === 'oversold');
  ok('1h 超卖边界 K<20', ov.rows[1].k < 20);
  ok('4h 横盘→中性', ov.rows[2].zone === 'neutral');
  ok('多空计数 bull=1 bear=1', ov.bull === 1 && ov.bear === 1);
  const ov2 = buildSrsiOverview(['5m', '1h'], srsi, pm, 150);
  const c5 = ov2.rows[0].crossing;
  const f5 = ov2.rows[0].fresh;
  ok('5m 出现穿越方向且新鲜度≥0', (c5 === 'buy' || c5 === 'sell') && typeof f5 === 'number');
  ok('空价格→数据不足行 null/中性', (() => { const o = buildSrsiOverview(['4h'], srsi, { '4h': [] }, 150); return o.rows[0].k === null && o.rows[0].zone === 'neutral' && o.rows[0].fresh === null; })());
  ok('单根价格→数据不足', (() => { const o = buildSrsiOverview(['4h'], srsi, { '4h': [150] }, 150); return o.rows[0].k === null; })());
  // 回归：底部「偏多/偏空」必须与「穿越」列方向一致（按穿越方向统计，不再用 K 与 50 的位置）
  {
    const ov3 = buildSrsiOverview(['5m', '1h', '4h'], srsi, pm, 150);
    let eb = 0, ebe = 0;
    ov3.rows.forEach(r => { const cv = latestCross(r).cv; if (cv === 'buy' || cv === 'goldHook') eb++; else if (cv === 'sell' || cv === 'deathHook') ebe++; });
    ok('底部偏多==穿越列金叉/金钩数', ov3.bull === eb);
    ok('底部偏空==穿越列死叉/死钩数', ov3.bear === ebe);
  }
}

console.log('\n[kchart: 速览结论 overviewVerdict]');
{
  ok('全多→一致偏多', overviewVerdict(3, 0) === '一致偏多');
  ok('全空→一致偏空', overviewVerdict(0, 2) === '一致偏空');
  ok('多空都有→分歧', overviewVerdict(2, 1) === '分歧');
  ok('全中性→中性', overviewVerdict(0, 0) === '中性');
}

console.log('\n[kchart: 反转判定 isReversed / countBullBear]');
{
  ok('死钩+K>D→已反转', isReversed({ hook: 'deathHook', hookFresh: 2, crossing: null, fresh: null, k: 75, d: 70 }) === true);
  ok('死叉+K<D→未反转', isReversed({ crossing: 'sell', fresh: 2, hook: null, hookFresh: null, k: 60, d: 70 }) === false);
  ok('金钩+K<D→已反转', isReversed({ hook: 'goldHook', hookFresh: 2, crossing: null, fresh: null, k: 25, d: 30 }) === true);
  ok('金叉+K>D→未反转', isReversed({ crossing: 'buy', fresh: 2, hook: null, hookFresh: null, k: 80, d: 70 }) === false);
  ok('无信号→false', isReversed({ crossing: null, fresh: null, hook: null, hookFresh: null, k: 70, d: 70 }) === false);
  ok('缺K/D→false', isReversed({ hook: 'deathHook', hookFresh: 2 }) === false);
  // countBullBear：死钩被反转→翻转计多
  const r1 = [{ hook: 'deathHook', hookFresh: 2, crossing: null, fresh: null, k: 75, d: 70 }, { crossing: 'buy', fresh: 1, hook: null, hookFresh: null, k: 80, d: 70 }];
  r1.forEach(r => r.reversed = isReversed(r));
  const cb1 = countBullBear(r1);
  ok('countBullBear 死钩反转→全计多', cb1.bull === 2 && cb1.bear === 0);
  const r2 = [{ hook: 'deathHook', hookFresh: 2, crossing: null, fresh: null, k: 60, d: 70 }, { crossing: 'buy', fresh: 1, hook: null, hookFresh: null, k: 80, d: 70 }];
  r2.forEach(r => r.reversed = isReversed(r));
  const cb2 = countBullBear(r2);
  ok('countBullBear 死钩未反转→正常计空', cb2.bull === 1 && cb2.bear === 1);
  // buildSrsiOverview 行携带 reversed / gap 字段
  const srsi = { rsiPeriod: 85, stochPeriod: 50, smoothK: 10, smoothD: 5, overbought: 80, oversold: 20 };
  const rising = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(100 + i * 0.5); return a; };
  const ov = buildSrsiOverview(['5m', '1h'], srsi, { '5m': rising(500), '1h': rising(500) }, 150);
  ok('概览行含 reversed 字段', ov.rows.every(r => 'reversed' in r));
  ok('概览行含 gapNow/gapTrend 字段', ov.rows.every(r => 'gapNow' in r && 'gapTrend' in r));
}

console.log('\n[kchart: 反转/全周期K/D/间距动能 进入纪律分析]');
{
  const srsi = { rsiPeriod: 85, stochPeriod: 50, smoothK: 10, smoothD: 5, overbought: 80, oversold: 20 };
  const risingAll = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(100 + Math.sin(i / 10) * 15 + i * 0.05); return a; };
  const pm = { '5m': risingAll(500), '15m': risingAll(500), '1h': risingAll(500), '4h': risingAll(500) };
  const s = analyzeTradeDiscipline(pm, srsi, { bars: 150, mainTF: '15m' });
  ok('全周期K>D→趋势方向已判定', typeof s.trend.up === 'boolean' && !!s.trend.tf);
  ok('全周期K>D→一致偏多', s.multiTf.verdict === '一致偏多');
  ok('全周期K>D→置信含强势+10', s.entry.confParts.some(p => p.includes('全周期K>D 强势+10')));
  ok('confirm 对象含 reversed 字段', 'reversed' in s.confirm);
  ok('纪律清单含「信号反转识别」规则', s.rules.some(r => r.name === '信号反转识别'));
}

console.log('\n[kchart: 钩信号 dirName / pickConfirm]');
{
  ok('dirName buy 普通→金叉', dirName('buy', false) === '金叉');
  ok('dirName sell 普通→死叉', dirName('sell', false) === '死叉');
  ok('dirName buy 钩→金钩', dirName('buy', true) === '金钩');
  ok('dirName sell 钩→死钩', dirName('sell', true) === '死钩');

  // 钗更近 → 取钗（钩即使存在也因更旧而不计）
  const c1 = pickConfirm([
    { tf: '5m', crossing: 'buy', fresh: 1, hook: null, hookFresh: null },
    { tf: '15m', crossing: null, fresh: null, hook: 'goldHook', hookFresh: 5 }
  ]);
  ok('pickConfirm 钗更近→取钗', c1.isHook === false && c1.dir === 'buy' && c1.tf === '5m');

  // 钩更近 → 取钩（isHook=true，+15 权重）
  const c1b = pickConfirm([
    { tf: '5m', crossing: 'buy', fresh: 5, hook: null, hookFresh: null },
    { tf: '15m', crossing: null, fresh: null, hook: 'goldHook', hookFresh: 1 }
  ]);
  ok('pickConfirm 钩更近→取钩', c1b.isHook === true && c1b.dir === 'buy' && c1b.tf === '15m');

  // 同行既有钗又有钩：钗更新 → 取钗
  const c6 = pickConfirm([{ tf: '5m', crossing: 'buy', fresh: 2, hook: 'goldHook', hookFresh: 8 }]);
  ok('pickConfirm 同行钗更近→取钗', c6.isHook === false && c6.dir === 'buy');

  // 仅普通穿越
  const c2 = pickConfirm([{ tf: '5m', crossing: 'sell', fresh: 2, hook: null, hookFresh: null }]);
  ok('pickConfirm 仅普通→死叉无钩', c2.isHook === false && c2.dir === 'sell');

  // 新鲜度优先（两普通穿越）
  const c3 = pickConfirm([
    { tf: '5m', crossing: 'buy', fresh: 4, hook: null, hookFresh: null },
    { tf: '15m', crossing: 'buy', fresh: 1, hook: null, hookFresh: null }
  ]);
  ok('pickConfirm 同档按新鲜度', c3.tf === '15m' && c3.fresh === 1);

  // 空候选
  const c4 = pickConfirm([]);
  ok('pickConfirm 空→无确认', c4.dir === null && c4.confirmed === false);

  // 仅钩且陈旧 → 仍标识钩(isHook)但未确认（fresh>3）
  const c5 = pickConfirm([{ tf: '5m', crossing: null, fresh: null, hook: 'deathHook', hookFresh: 10 }]);
  ok('pickConfirm 仅钩陈旧→钩未确认', c5.isHook === true && c5.dir === 'sell' && c5.confirmed === false);

  // 方向感知（expectDir）：同向才算确认；反向已确认 → contrarian, confirmed=false
  const d1 = pickConfirm([{ tf: '5m', crossing: 'sell', fresh: 0, hook: null, hookFresh: null }], 'buy');
  ok('pickConfirm 期望做多+最近死叉→contrarian 未确认', d1.contrarian === true && d1.confirmed === false && d1.dir === 'sell');
  const d2 = pickConfirm([{ tf: '5m', crossing: 'buy', fresh: 1, hook: null, hookFresh: null }], 'buy');
  ok('pickConfirm 期望做多+最近金叉→同向确认', d2.contrarian === false && d2.confirmed === true && d2.dir === 'buy');
  const d3 = pickConfirm([{ tf: '5m', crossing: 'buy', fresh: 2, hook: null, hookFresh: null }], 'sell');
  ok('pickConfirm 期望做空+最近金叉→contrarian', d3.contrarian === true && d3.confirmed === false);
  const d4 = pickConfirm([{ tf: '5m', crossing: 'sell', fresh: 2, hook: null, hookFresh: null }], 'sell');
  ok('pickConfirm 期望做空+最近死叉→同向确认', d4.contrarian === false && d4.confirmed === true);
  const d5 = pickConfirm([{ tf: '5m', crossing: 'buy', fresh: 1, hook: null, hookFresh: null }]);
  ok('pickConfirm 无期望方向→保持原行为(不标contrarian)', d5.contrarian === false && d5.confirmed === true);
  const d6 = pickConfirm([], 'buy');
  ok('pickConfirm 空候选+期望方向→无信号', d6.dir === null && d6.contrarian === false);
  const d7 = pickConfirm([{ tf: '5m', crossing: 'sell', fresh: 0, hook: null, hookFresh: null }], null);
  ok('pickConfirm expectDir=null→contrarian=false', d7.contrarian === false);
}

console.log('\n[kchart: SRSI 能量 hookEnergy / 领跑者 leadingTF]');
{
  // 15m 强卖（BNB 场景：K=60, D=70, deathHook fresh=4, gap=10, 距20余量40 → 80）
  const r1 = { tf: '15m', k: 60, d: 70, zone: 'neutral', crossing: 'sell', fresh: 4, hook: 'deathHook', hookFresh: 4 };
  const e1 = hookEnergy(r1);
  ok('能量 15m 强卖 score=80', e1.dir === 'sell' && e1.score === 80 && e1.isHook);
  ok('能量 15m 强卖 reason 含因子', e1.reason.includes('距') && e1.reason.includes('余量') && e1.reason.includes('新鲜') && e1.reason.includes('钩'));

  // 1h 弱买（BNB 场景：K=52, D=50, goldHook fresh=7, gap=2, 距80余量28 → 55）
  const r2 = { tf: '1h', k: 52, d: 50, zone: 'neutral', crossing: 'buy', fresh: 7, hook: 'goldHook', hookFresh: 7 };
  const e2 = hookEnergy(r2);
  ok('能量 1h 弱买 score=55', e2.dir === 'buy' && e2.score === 55 && e2.isHook);

  // 无信号
  const r3 = { tf: '5m', k: 50, d: 50, zone: 'neutral', crossing: null, fresh: null, hook: null, hookFresh: null };
  const e3 = hookEnergy(r3);
  ok('能量 无信号 score=0', e3.dir === null && e3.score === 0 && e3.isHook === false);

  // null 行
  const e4 = hookEnergy(null);
  ok('能量 null 行 score=0', e4.dir === null && e4.score === 0);

  // leadingTF: 15m 领跑（BNB 场景）
  const r4 = { tf: '4h', k: 6.2, d: 6.4, zone: 'oversold', crossing: 'buy', fresh: 26, hook: 'deathHook', hookFresh: 62 };
  const lead = leadingTF([r1, r2, r4]);
  ok('领跑 15m 方向 sell', lead && lead.tf === '15m' && lead.dir === 'sell');
  ok('领跑 score=80', lead && lead.score === 80);
  ok('领跑 isClear=true', lead && lead.isClear === true);

  // leadingTF: 无领跑（能量均 <50）
  const low = [
    { tf: '5m', k: 51, d: 50, zone: 'neutral', crossing: 'buy', fresh: 10, hook: null, hookFresh: null },
    { tf: '15m', k: 49, d: 50, zone: 'neutral', crossing: 'sell', fresh: 12, hook: null, hookFresh: null }
  ];
  ok('无领跑(能量低)=null', leadingTF(low) === null);

  // leadingTF: 空数组
  ok('无领跑(空数组)=null', leadingTF([]) === null);
}

console.log('\n[kchart: 信号生命周期 signalLifecycle]');
{
  // 新鲜死钩: 5m fresh=1, 能量80 → phase=fresh strength=强 conf=80+10+15
  const l1 = signalLifecycle({ dir: 'sell', fresh: 1, tf: '5m', isHook: true }, null, [{ tf: '5m', score: 80 }]);
  ok('生命 新鲜死钩 phase=fresh', l1 && l1.phase === 'fresh' && l1.dir === 'sell' && l1.isHook);
  ok('生命 新鲜死钩 strength=强', l1 && l1.strength === '强');
  ok('生命 新鲜死钩 conf=105钳制95', l1 && l1.conf === 95);
  ok('生命 新鲜死钩 txt 含钩', l1.txt.includes('死钩') && l1.txt.includes('新鲜'));

  // 活跃金叉: 15m fresh=6, 能量55 → active 中 conf=55+5
  const l2 = signalLifecycle({ dir: 'buy', fresh: 6, tf: '15m', isHook: false }, null, [{ tf: '15m', score: 55 }]);
  ok('生命 活跃金叉 phase=active', l2 && l2.phase === 'active' && l2.strength === '中' && l2.conf === 60);
  ok('生命 活跃金叉 txt 含金叉', l2.txt.includes('金叉'));

  // 衰减死叉: fresh=12, 能量40 → aging 弱 conf=40
  const l3 = signalLifecycle({ dir: 'sell', fresh: 12, tf: '1h', isHook: false }, null, [{ tf: '1h', score: 40 }]);
  ok('生命 衰减死叉 phase=aging', l3 && l3.phase === 'aging' && l3.strength === '弱' && l3.conf === 40);

  // 失效无能量 → stale 并钳制下限
  const l4 = signalLifecycle({ dir: 'buy', fresh: 30, tf: '1h', isHook: false }, null, [{ tf: '1h', score: 10 }]);
  ok('生命 失效 phase=stale', l4 && l4.phase === 'stale' && l4.conf === 5);

  // 顺势标: contrarian 不影响生命周期(只影响入场确认), 反向由 txt.dirTxt 体现
  const l5 = signalLifecycle({ dir: 'sell', fresh: 2, tf: '5m', isHook: true, contrarian: true }, null, [{ tf: '5m', score: 0 }]);
  ok('生命 contrarian 只标记不改变 phase', l5 && l5.phase === 'fresh' && l5.dir === 'sell');

  // 无信号 → null
  ok('生命 无信号=null', signalLifecycle({}, null, null) === null);
  ok('生命 null confirm=null', signalLifecycle(null, null, null) === null);

  // 无 tf 的 confirm(仅领跑) → 用领跑
  const l6 = signalLifecycle({ dir: null, fresh: null, tf: null, isHook: false }, { tf: '4h', dir: 'buy', score: 72, isHook: false }, []);
  ok('生命 领跑回退 tf=4h', l6 && l6.tf === '4h' && l6.dir === 'buy' && l6.strength === '强');
}

console.log('\n[kchart: 速览穿越列 latestCross 取最近信号]');
{
  // 钩比带穿越更近 → 显示钩
  ok('钩更近→金钩', latestCross({ crossing: 'buy', fresh: 5, hook: 'goldHook', hookFresh: 2 }).cv === 'goldHook');
  ok('钩更近→死钩', latestCross({ crossing: 'sell', fresh: 8, hook: 'deathHook', hookFresh: 3 }).cv === 'deathHook');
  // 带穿越比钩更近 → 显示钗
  ok('钗更近→金叉', latestCross({ crossing: 'buy', fresh: 1, hook: 'goldHook', hookFresh: 6 }).cv === 'buy');
  ok('钗更近→死叉', latestCross({ crossing: 'sell', fresh: 2, hook: 'deathHook', hookFresh: 9 }).cv === 'sell');
  // 只有一种 → 显示该种类
  ok('仅钩→金钩', latestCross({ crossing: null, fresh: null, hook: 'goldHook', hookFresh: 4 }).cv === 'goldHook');
  ok('仅钗→死叉', latestCross({ crossing: 'sell', fresh: 4, hook: null, hookFresh: null }).cv === 'sell');
  // 同新鲜度 → 优先钩
  ok('同新鲜度优先钩', latestCross({ crossing: 'buy', fresh: 3, hook: 'goldHook', hookFresh: 3 }).cv === 'goldHook');
  // 都无 → 无
  ok('都无→无', latestCross({ crossing: null, fresh: null, hook: null, hookFresh: null }).cv === null);
}


console.log('\n[kchart: 交易纪律分析 analyzeTradeDiscipline]');
{
  const srsi = { rsiPeriod: 85, stochPeriod: 50, smoothK: 10, smoothD: 5, overbought: 80, oversold: 20 };
  const rising = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(100 + i * 0.3); return a; };
  const falling = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(300 - i * 0.3); return a; };
  const riseThenDip = (n) => { const a = rising(n); for (let i = 0; i < 40; i++) a.push(a[a.length - 1] - (i + 1) * 1.2); return a; };
  const fallThenRally = (n) => { const a = falling(n); for (let i = 0; i < 40; i++) a.push(a[a.length - 1] + (i + 1) * 1.2); return a; };
  const bull = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(100 + (i % 25) * 0.8 - (i % 7) * 0.1); return a; };
  const bear = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(300 - (i % 25) * 0.8 + (i % 7) * 0.1); return a; };

  // S1 顺势做多: 4h 上升 + 15m 超卖回调 → 做多, 中置信, 回调≠反转规则通过
  const s1 = analyzeTradeDiscipline({ '5m': riseThenDip(500), '15m': riseThenDip(500), '1h': rising(500), '4h': rising(500) }, srsi, { bars: 150, mainTF: '15m' });
  ok('S1 趋势识别为上升', s1.trend.up === true);
  ok('S1 主周期(15m)超卖', s1.zones.main === 'oversold');
  ok('S1 建议做多', s1.entry.dir === '做多');
  ok('S1 置信度中等(≥45)', s1.entry.conf >= 45);
  ok('S1 7条纪律规则(含短周期锚定+反转识别)', s1.rules.length === 7);
  ok('S1 顺势交易规则通过', s1.rules[0].ok === true);
  ok('S1 回调≠反转规则通过(上涨趋势回调=低吸)', s1.rules.find(r => r.name === '回调≠反转').ok === true);
  ok('S1 signalLife 存在并写入 reason', !!s1.signalLife && s1.entry.reason.includes('信号: ') && s1.signalLife.txt.length > 0);

  // S2 顺势做空: 4h 下降 + 15m 超买反弹 → 做空
  const s2 = analyzeTradeDiscipline({ '5m': fallThenRally(500), '15m': fallThenRally(500), '1h': falling(500), '4h': falling(500) }, srsi, { bars: 150, mainTF: '15m' });
  ok('S2 趋势识别为下降', s2.trend.up === false);
  ok('S2 主周期超买', s2.zones.main === 'overbought');
  ok('S2 建议做空', s2.entry.dir === '做空');
  ok('S2 置信度中等(≥45)', s2.entry.conf >= 45);

  // S3 分歧惩罚: 5m超买 15m超卖 ↗ → verdict=分歧, 置信扣15
  const s3 = analyzeTradeDiscipline({ '5m': bull(500), '15m': bear(500), '4h': rising(500) }, srsi, { bars: 150, mainTF: '15m' });
  ok('S3 多空分歧', s3.multiTf.verdict === '分歧');
  ok('S3 置信含"周期分歧-15"', s3.entry.confParts.some(p => p.includes('周期分歧-15')));

  // S4 空数据 → null
  ok('S4 空数据返回 null', analyzeTradeDiscipline({}, srsi, { bars: 150, mainTF: '15m' }) === null);

  // S5 数据不足(周期数不足) → 仍可分析或 null, 不抛异常
  const s5 = analyzeTradeDiscipline({ '4h': rising(500) }, srsi, { bars: 150, mainTF: '15m' });
  ok('S5 单周期不抛异常', s5 === null || typeof s5.trend === 'object');

  // S6 入场确认字段结构
  ok('S6 confirm 字段齐全', ['dir', 'fresh', 'tf', 'confirmed', 'contrarian'].every(k => k in s1.confirm));

  // S6b 能量/领跑字段接入纪律分析
  ok('S6b energyRows 存在', Array.isArray(s1.energyRows) && s1.energyRows.length > 0);
  ok('S6b energyRows 各含 tf/dir/score', s1.energyRows.every(e => typeof e.tf === 'string' && typeof e.score === 'number'));

  // S7 规则名称固定6条
  const names = s1.rules.map(r => r.name);
  ok('S7 7条规则名称', names.join('|') === '顺势交易|多周期共振|逆势信号警惕|回调≠反转|信号只是提示|信号反转识别|短周期锚定');

  // S8 回归: 趋势不受勾选周期影响（用全部TF数据但klineSel只勾短周期）
  // 完整数据: 5m/15m下降, 4h/1d上升 → 方向基准取 ≤capMin(4h) 的最长 = 4h 上升
  const fullPM = { '5m': falling(500), '15m': falling(500), '1h': falling(500), '4h': rising(500), '1d': rising(500) };
  const selShort = { '5m': true, '15m': true, '1h': true, '4h': false, '1d': false };
  const r8a = analyzeTradeDiscipline(fullPM, srsi, { bars: 150, mainTF: '1h', klineSel: selShort });
  const r8b = analyzeTradeDiscipline(fullPM, srsi, { bars: 150, mainTF: '4h', klineSel: { ...selShort, '4h': true, '1d': true } });
  ok('S8 只勾短周期时方向基准仍取全部周期≤4h(4h上升)', r8a.trend.up === true && r8a.trend.tf === '4h');
  ok('S8 全勾选方向基准一致(4h上升)', r8b.trend.up === true && r8b.trend.tf === '4h');
  ok('S8 短周期趋势与方向基准不一致时不被勾选污染', r8a.trend.spreadPct > 0);

  // S8b 横盘(价差<死区)→ 观望 + flat
  const flatSeq = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(200 + Math.sin(i / 3) * 0.2); return a; };
  const s8b = analyzeTradeDiscipline({ '5m': flatSeq(500), '15m': flatSeq(500), '1h': flatSeq(500), '4h': flatSeq(500) }, srsi, { bars: 150, mainTF: '15m' });
  ok('S8b 横盘方向基准 flat', s8b.trend.flat === true);
  ok('S8b 横盘 → 观望', s8b.entry.dir === '观望');
  ok('S8b 横盘 reason 含死区', (s8b.entry.reason || '').includes('死区'));
  ok('S8b 横盘规则1说明横盘', (s8b.rules.find(r => r.name === '顺势交易').note || '').includes('横盘观望'));

  // S9 回归: 做空目标必须低于现价（防止 te20 高于现价导致目标无意义）
  // 构造: 1d下降, 主周期超买 → 做空; 且 trendTF(1d) 的 te20 高于现价
  const s9 = analyzeTradeDiscipline({ '5m': fallThenRally(500), '15m': fallThenRally(500), '1h': falling(500), '4h': falling(500), '1d': falling(500) }, srsi, { bars: 150, mainTF: '15m' });
  ok('S9 做空场景 target < 现价', s9.entry.dir.startsWith('做空') && s9.entry.target != null && s9.entry.target < s9.entry.stop);
  ok('S9 做空场景 stop > 现价(在target上方)', s9.entry.stop > s9.entry.target);

  // S10 回归: 观察态也有止损（不再显示 --）
  const s10 = analyzeTradeDiscipline({ '5m': riseThenDip(500), '15m': rising(500), '1h': rising(500), '4h': rising(500) }, srsi, { bars: 150, mainTF: '1h' });
  ok('S10 观察态有止损值', s10.entry.stop != null && s10.entry.stop > 0);

  // S12 门控: 4h 上升 + 5m 最近死叉(contrarian fresh≤3) → 观望。注意死叉须未被反转(当前 K<D)，否则按反转逻辑不触发门控
  const uptrend = (n, step = 0.3) => { const a = []; for (let i = 0; i < n; i++) a.push(100 + i * step); return a; };
  const contrarianFixture = () => {
    const a = [];
    for (let i = 0; i < 580; i++) a.push(100 + i * 0.4 + Math.sin(i / 6) * 6);
    const last = a[a.length - 1];
    for (let i = 1; i <= 4; i++) a.push(last - i * 20);
    return a;
  };
  const s12 = analyzeTradeDiscipline({
    '5m': contrarianFixture(), '15m': uptrend(600, 0.15), '1h': uptrend(600, 0.15), '4h': uptrend(600, 0.15)
  }, srsi, { bars: 150, mainTF: '1h' });
  ok('S12 4h上升+5m死叉fresh=0→观望', s12.entry.dir === '观望');
  ok('S12 观望态 stop=null', s12.entry.stop == null);
  ok('S12 观望态 target=null', s12.entry.target == null);
  ok('S12 reason 含"观望"', s12.entry.reason.includes('观望'));
  ok('S12 confirm.contrarian===true', s12.confirm.contrarian === true);
  ok('S12 confirm.confirmed===false', s12.confirm.confirmed === false);
  ok('S12 规则5 ok=true(gateWait 也算已确认)', s12.rules[4].ok === true);
  ok('S12 规则5 note 含"反向"', s12.rules[4].note.includes('反向'));
  ok('S12 无入场确认加分', !s12.entry.confParts.some(p => p.includes('确认') || p.includes('未确认')));

  // S13 回归: stale contrarian (fresh>3) → 不触发门控, 仍做多(观察)
  const staleFixture = () => {
    const a = uptrend(600, 0.15); const last = a[a.length - 1];
    for (let i = 1; i <= 50; i++) a.push(last - i * 1);
    const bot = a[a.length - 1];
    for (let i = 1; i <= 6; i++) a.push(bot + i * 8);
    const plateau = a[a.length - 1];
    for (let i = 0; i < 10; i++) a.push(plateau);
    return a;
  };
  const s13 = analyzeTradeDiscipline({
    '5m': staleFixture(), '15m': uptrend(600, 0.15), '1h': uptrend(600, 0.15), '4h': uptrend(600, 0.15)
  }, srsi, { bars: 150, mainTF: '1h' });
  ok('S13 stale contrarian(>3) 不观望', s13.entry.dir.startsWith('做多') && s13.entry.dir !== '观望');
  ok('S13 stale contrarian 有止损', s13.entry.stop != null && s13.entry.stop > 0);

  // S11 日线槽位 = 真实 1d（不受 klineSel/预设影响）：1d 超卖, 勾选只含短周期 → zones.daily 仍为 oversold
  const s11 = analyzeTradeDiscipline({ '5m': bull(500), '15m': bull(500), '1h': bull(500), '4h': bull(500), '1d': bear(500) }, srsi, { bars: 150, mainTF: '5m', klineSel: { '5m': true, '15m': true, '1h': false, '4h': false, '1d': false } });
  ok('S11 未勾选1d时日线槽位仍取真实1d超卖', s11.zones.daily === 'oversold');
  ok('S11 dailyTf 为 1d', s11.zones.dailyTf === '1d');

  // S11b 无 1d 数据时回退勾选中最长周期（保持旧行为）
  const s11b = analyzeTradeDiscipline({ '5m': bull(500), '15m': bull(500), '4h': rising(500) }, srsi, { bars: 150, mainTF: '5m', klineSel: { '5m': true, '15m': true, '4h': true } });
  ok('S11b 无1d回退最长勾选周期', s11b.zones.dailyTf === '4h');

  // ---- S14 市场状态策略（方向随策略切换 + 趋势极性约束）----
  const flatPM = { '5m': flatSeq(500), '15m': flatSeq(500), '1h': flatSeq(500), '4h': flatSeq(500) };
  const s1b = analyzeTradeDiscipline({ '5m': riseThenDip(500), '15m': riseThenDip(500), '1h': rising(500), '4h': rising(500) }, srsi, { bars: 150, mainTF: '15m' });
  const s2b = analyzeTradeDiscipline({ '5m': fallThenRally(500), '15m': fallThenRally(500), '1h': falling(500), '4h': falling(500) }, srsi, { bars: 150, mainTF: '15m' });
  const sfb = analyzeTradeDiscipline(flatPM, srsi, { bars: 150, mainTF: '15m' });
  const s13b = analyzeTradeDiscipline({ '5m': staleFixture(), '15m': uptrend(600, 0.15), '1h': uptrend(600, 0.15), '4h': uptrend(600, 0.15) }, srsi, { bars: 150, mainTF: '1h' });

  ok('S14 上升趋势→策略=能量领跑', s1b.strategy === 'energy-leader');
  ok('S14 下降趋势→策略=动量跟随', s2b.strategy === 'freshest-signal');
  ok('S14 横盘→策略=趋势跟随', sfb.strategy === 'trend-baseline');
  ok('S14 上升+能量领跑方向→做多', s1b.entry.dir === '做多');
  ok('S14 下降+动量跟随方向→做空', s2b.entry.dir === '做空');
  ok('S14 横盘+趋势跟随→观望', sfb.entry.dir === '观望');
  ok('S14 energy-leader 不重复加领跑分', !s1b.entry.confParts.some(p => p.includes('领跑')));
  ok('S14 regime 字段存在', s1b.regime && typeof s1b.regime.type === 'string');
  ok('S14 弱逆势领跑(55<70)不翻转→仍做多观察', s13b.entry.dir.startsWith('做多') && s13b.entry.dir !== '观望');
  ok('S14 弱逆势不翻转时理由含能量', s13b.entry.reason.includes('能量'));
}

console.log('\n[kchart: 方向基准视野化 (horizonTrend / macroTrend / deadZone / conflictPenalty 等)]');
{
  const srsi = { rsiPeriod: 85, stochPeriod: 50, smoothK: 10, smoothD: 5, overbought: 80, oversold: 20 };
  const rising = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(100 + i * 0.3); return a; };
  const falling = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(300 - i * 0.3); return a; };
  const volatile = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(200 + (i % 5 - 2) * 8); return a; };

  // horizonTrend: 最长 ≤ capMin(4h) 的 EMA 趋势，含死区 flat
  ok('HT 上升序列→up=true', horizonTrend({ '1h': rising(500), '4h': rising(500) }).up === true);
  ok('HT 下降序列→up=false', horizonTrend({ '1h': falling(500), '4h': falling(500) }).up === false);
  ok('HT 取最长≤capMin(4h)', horizonTrend({ '1h': rising(500), '4h': falling(500), '1d': rising(500) }).tf === '4h');
  ok('HT capMin 提到1d→方向基准取1d', horizonTrend({ '1h': rising(500), '4h': falling(500), '1d': rising(500) }, { capMin: 1440 }).tf === '1d');
  ok('HT 空数据→null', horizonTrend({}) === null);
  ok('HT 数据不足(<120点)取最长仍判定', (() => { const t = horizonTrend({ '1h': rising(50), '4h': falling(50) }); return t && t.tf === '4h'; })());
  // 死区检测: 微小价差 → flat=true
  const small = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(100 + i * 0.005); return a; };
  ok('HT 微小价差(<0.5%)→flat', horizonTrend({ '4h': small(500) }).flat === true);
  ok('HT 微小价差 label 横盘', horizonTrend({ '4h': small(500) }).label === '横盘');
  // 自适应死区传入
  ok('HT 自适应死区 2%→flat', horizonTrend({ '4h': small(500) }, { deadZone: 2 }).flat === true);

  // macroTrend: 7d/30d 中最长 ≥120 点
  ok('MT 30d 上升', macroTrend({ '30d': rising(500), '7d': rising(500) }).up === true);
  ok('MT 30d 下降', macroTrend({ '7d': falling(500) }).up === false);
  ok('MT 无数据→null', macroTrend({ '1h': rising(500) }) === null);
  ok('MT 数据不足(<120)→null', macroTrend({ '30d': rising(50) }) === null);

  // atrPctHistory: 返回 n 条 ATR/close%
  const h = atrPctHistory(volatile(500), 10);
  ok('AH 返回数组', Array.isArray(h));
  ok('AH 长度≤请求', h.length <= 10);
  ok('AH 值>0', h.every(v => v > 0));

  // deadZoneLatch: 滞回状态机
  const st = { mode: 'fixed', n: 0 };
  const r1 = deadZoneLatch(0.3, st, { hiEnter: 2, loEnter: 0.4, hiExit: 1.8, loExit: 0.5, confirm: 3 });
  ok('DZ 低比值→fixed,n=1', r1.mode === 'fixed' && r1.n === 1);
  const r2 = deadZoneLatch(0.3, r1, { hiEnter: 2, loEnter: 0.4, hiExit: 1.8, loExit: 0.5, confirm: 3 });
  const r3 = deadZoneLatch(0.3, r2, { hiEnter: 2, loEnter: 0.4, hiExit: 1.8, loExit: 0.5, confirm: 3 });
  ok('DZ 3帧低比值→adaptive', r3.mode === 'adaptive' && r3.n === 0);
  // 无效 ratio 强制回 fixed
  const r4 = deadZoneLatch(null, r3, { confirm: 1 });
  ok('DZ 无效ratio→fixed', r4.mode === 'fixed' && r4.n === 0);

  // deadZoneValue: 合成死区
  ok('DZV fixed→固定值', deadZoneValue('fixed', [0.8, 1.0], { fixed: 0.5 }) === 0.5);
  ok('DZV adaptive 样本不足→fixed', deadZoneValue('adaptive', [], { minSamples: 5, fixed: 0.5 }) === 0.5);
  const pcts = [0.1, 0.2, 0.3, 0.4, 0.5];
  ok('DZV adaptive 中位数*mult', deadZoneValue('adaptive', pcts, { mult: 0.5, lo: 0.05, hi: 3, minSamples: 5 }) === 0.15);

  // conflictPenalty: 宏观冲突扣分
  const mtUp = { tf: '30d', up: true, spreadPct: 10 };
  const mtDown = { tf: '30d', up: false, spreadPct: 12 };
  ok('CP 宏观向下+做多=扣分>0', conflictPenalty(mtDown, '做多') > 0);
  ok('CP 宏观向上+做空=扣分>0', conflictPenalty(mtUp, '做空') > 0);
  ok('CP 同向=0', conflictPenalty(mtUp, '做多') === 0);
  ok('CP 观望=0', conflictPenalty(mtDown, '观望') === 0);
  ok('CP 无宏观=0', conflictPenalty(null, '做多') === 0);
  ok('CP 扣分范围[10,20]', (() => { const p = conflictPenalty(mtDown, '做多'); return p >= 10 && p <= 20; })());
  ok('CP 扣分按 spread 缩放', (() => {
    const smallMT = { tf: '30d', up: false, spreadPct: 5 };
    const largeMT = { tf: '30d', up: false, spreadPct: 40 };
    return conflictPenalty(smallMT, '做多') < conflictPenalty(largeMT, '做多');
  })());

  // trendConflictNote: 双向对称, 仅明确相反才提示
  ok('TCN 趋势↓+一致偏多→非null', trendConflictNote(false, '一致偏多', '30d') !== null);
  ok('TCN 趋势↓+一致偏多 含"回调≠反转"', (trendConflictNote(false, '一致偏多', '30d') || '').includes('回调≠反转'));
  ok('TCN 趋势↑+一致偏空→非null', trendConflictNote(true, '一致偏空', '30d') !== null);
  ok('TCN 趋势↑+一致偏空 含"上涨中的回调"', (trendConflictNote(true, '一致偏空', '30d') || '').includes('上涨中的回调'));
  ok('TCN 趋势↓+一致偏空→null(同向)', trendConflictNote(false, '一致偏空', '30d') === null);
  ok('TCN 趋势↑+一致偏多→null(同向)', trendConflictNote(true, '一致偏多', '30d') === null);
  ok('TCN up=null→null(不误报)', trendConflictNote(null, '一致偏多', '30d') === null);
  ok('TCN 分歧→null', trendConflictNote(false, '分歧', '30d') === null);

  // conflictNote 接线: analyzeTradeDiscipline 的 conflictNote 必须等于纯函数结果(无论 SRSI 是否命中)
  const pmA = { '1h': falling(500), '4h': falling(500), '1d': falling(500), '30d': falling(500) };
  const rA = analyzeTradeDiscipline(pmA, srsi, { bars: 150, mainTF: '1h' });
  ok('CN 接线: 与纯函数一致', rA.conflictNote === trendConflictNote(rA.trend.up, rA.multiTf.verdict, rA.trend.tf));
  const pmB = { '1h': rising(500), '4h': rising(500), '1d': rising(500), '30d': rising(500) };
  const rB = analyzeTradeDiscipline(pmB, srsi, { bars: 150, mainTF: '1h' });
  ok('CN 接线(上升): 与纯函数一致', rB.conflictNote === trendConflictNote(rB.trend.up, rB.multiTf.verdict, rB.trend.tf));

  // 宏观冲突接线: 4h V反弹(方向基准向上) 但 30d 宏观向下 → 做多方向被宏观扣分
  const vShape = (n) => { const a = falling(n); for (let i = 0; i < 40; i++) a.push(a[a.length - 1] + (i + 1) * 1.2); return a; };
  const pmC = { '5m': vShape(500), '15m': vShape(500), '4h': vShape(500), '30d': falling(500) };
  const selNo30d = { '5m': true, '15m': true, '4h': true, '30d': false };
  const rC = analyzeTradeDiscipline(pmC, srsi, { bars: 150, mainTF: '15m', klineSel: selNo30d });
  ok('CN 方向基准取 4h(不取30d宏观)', rC.trend.up === true && rC.trend.tf === '4h');
  ok('CN 宏观30d向下列为宏观带', rC.macroConflict != null && rC.macroConflict.includes('30d'));
  ok('CN 宏观冲突已扣置信', rC.entry.confParts.some(p => p.includes('宏观反向-')));
}

console.log('\n[kchart: 实时价 discLiveInfo]');
{
  // 模拟 window.S.prices
  globalThis.window = { S: { prices: { BTCUSDT: { last: 686.41, chg: -1.2 } } } };

  // 做多: 目标700.1 止损673.6, 现价686.41(未达目标未破止损)
  const a1 = discLiveInfo('BTCUSDT', { entry: { dir: '做多', target: 700.1, stop: 673.6 } });
  ok('D1 价格取自 window.S', a1.price === 686.41);
  ok('D1 价格涨跌着色(chg<0→down)', a1.priceCls === 'disc-down');
  ok('D1 距目标% 正确', close(a1.toTarget, (700.1 - 686.41) / 686.41 * 100));
  ok('D1 距止损% 正确', close(a1.toStop, (673.6 - 686.41) / 686.41 * 100));
  ok('D1 未达目标→targetCls空', a1.targetCls === '');
  ok('D1 未破止损→stopCls空', a1.stopCls === '');

  // 现价突破目标(做多, 现价>目标) → targetCls=disc-pos, 涨→up
  globalThis.window = { S: { prices: { BTCUSDT: { last: 710, chg: 2.5 } } } };
  const a2 = discLiveInfo('BTCUSDT', { entry: { dir: '做多', target: 700.1, stop: 673.6 } });
  ok('D2 现价>目标→targetCls=disc-pos', a2.targetCls === 'disc-pos');
  ok('D2 价格涨→priceCls=disc-up', a2.priceCls === 'disc-up');

  // 现价跌破止损(做多, 现价<止损) → stopCls=disc-neg
  globalThis.window = { S: { prices: { BTCUSDT: { last: 670, chg: -3 } } } };
  const a3 = discLiveInfo('BTCUSDT', { entry: { dir: '做多', target: 700.1, stop: 673.6 } });
  ok('D3 现价<止损→stopCls=disc-neg', a3.stopCls === 'disc-neg');

  // 做空: 目标673.6(低于现价), 止损700.1(高于现价); 现价670<目标→已到目标→targetCls=disc-pos
  globalThis.window = { S: { prices: { BTCUSDT: { last: 670, chg: 1 } } } };
  const a4 = discLiveInfo('BTCUSDT', { entry: { dir: '做空', target: 673.6, stop: 700.1 } });
  ok('D4 做空 距目标% 正确', close(a4.toTarget, (673.6 - 670) / 670 * 100));
  ok('D4 做空 现价<目标→已到目标 targetCls=disc-pos', a4.targetCls === 'disc-pos');
  ok('D4 做空 现价<止损→stopCls空', a4.stopCls === '');

  // 无价格数据 → null
  globalThis.window = { S: { prices: {} } };
  ok('D5 无价格→null', discLiveInfo('BTCUSDT', { entry: { dir: '做多', target: 700, stop: 673 } }) === null);

  // 清理, 避免影响后续(若有)
  delete globalThis.window;
}

console.log(`\n=== kchart.test: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);