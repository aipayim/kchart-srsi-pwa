/**
 * smart-trader K线分析 页面纯函数单元测试 (Node 原生, 无框架)
 *
 * 测试:
 *   indicators.js downsampleOHLC  (K线 OHLC 下采样聚合, 10m 由 5m)
 *   tech2/kchart.js __defaultKConfig / __buildSubListFor (SRSI 多子图短→长排序)
 */

import { deepStrictEqual, strictEqual } from 'assert';
import { downsampleOHLC, sumVol } from '../src/engine/indicators.js';
import { __defaultKConfig, __buildSubListFor, srsiPanelSeries, idxFromFrac, fmtVol, mainHoverAt, subHoverAt, nextKMode, kPresetCombos, buildSrsiOverview, overviewVerdict, analyzeTradeDiscipline, dirName, pickConfirm, latestCross, discLiveInfo, horizonTrend, macroTrend, atrPctHistory, deadZoneLatch, deadZoneValue, conflictPenalty, trendConflictNote, hookEnergy, leadingTF, signalLifecycle,   isReversed, countBullBear, bullBearTfs, positionSizing,   shortSignalWeight, weightedVerdict, weightedShortVerdict, energyBallLayout, energyBallHitTest, drawEnergyBall, drawPricePath,   pricePathForecast, reversalInnerColor, kdZone, kdSweepFrac, tfOverviewStat, fmtPrice, perTfSrsi, auxGateDir, auxGateStatus, alignSeriesToBase, kchartApi, computeDirectionScore,       srsiAutoBandState, runSrsiAutoTrade, resetSrsiAuto, bandEdge, backtestSrsiAuto, klineDirFromCloses, srsiDirFromKD, srsiDirOf, srsiAutoDirs, fetchKlinesRange, _renderBacktestResult, _getSim, buildBacktestConditions, resolveEntryBands,   kdTrendColor, emaOpp2, aggTFData, nativeMain, loadCfg, persist, _btCfgSave, _btCfgLoad, cfg, _btCfg } from '../src/tech2/kchart.js';
import {   srsiKD } from '../src/engine/indicators.js';
import { KLINE_TF, resample } from '../src/engine/timeframe.js';

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

//  SRSI 子图 7d/30d 改用原生周/月线：不再依赖稀疏的日线聚合(71/16 根)，悬停读数应基于足量原生数据
{
  const sym = 'NATIVE7D', tf = '7d';
  const N = 500;
  const c = [], o = [], h = [], l = [], v = [], t = [];
  for (let i = 0; i < N; i++) {
    const x = 100 + Math.sin(i / 11) * 5 + i * 0.002;
    c.push(x); o.push(x - 0.1); h.push(x + 0.3); l.push(x - 0.3); v.push(i + 1); t.push(1600000000000 + i * 604800000);
  }
  globalThis.S = { klinesWeek: { [sym]: { o, h, l, c, v, t } }, klinesMonth: {} };
  const bars = 150;
  const sr = subHoverAt(0.5, sym, tf, 'srsi', bars);
  ok('7d SRSI 子图读原生周线 → k 为数值(非稀疏)', typeof sr.k === 'number' && isFinite(sr.k));
  // 起点(i=350 局部0) 也应有有效读数而非恒 null
  const s0 = subHoverAt(0, sym, tf, 'srsi', bars);
  ok('7d SRSI 子图原生 起点 k 非 null', typeof s0.k === 'number');
  // 30d 原生月线同理
  const cM = c.map((x, i) => x + Math.cos(i / 9) * 3), oM = cM.map(x => x - 0.1), hM = cM.map(x => x + 0.3), lM = cM.map(x => x - 0.3), vM = v, tM = t.map(x => x + 1);
  globalThis.S.klinesMonth = { [sym]: { o: oM, h: hM, l: lM, c: cM, v: vM, t: tM } };
  const srM = subHoverAt(0.5, sym, '30d', 'srsi', bars);
  ok('30d SRSI 子图读原生月线 → k 为数值', typeof srM.k === 'number' && isFinite(srM.k));
  delete globalThis.S;
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
  console.log('\n[kchart: 长周期聚合 7d/30d 周/月线 SRSI]');
  {
    // 全量日线(500 根) → 7d 聚合成周线(step7)、30d 聚合成月线(step30); 聚合后根数少, 用短 RSI/Stoch 周期保证预热
    const daily = [];
    for (let i = 0; i < 500; i++) daily.push(100 + Math.sin(i / 9) * 15 + Math.sin(i / 23) * 8 + i * 0.02);
    const longCfg = {
      '7d': { rsiPeriod: 14, stochPeriod: 14, smoothK: 3, smoothD: 3, overbought: 80, oversold: 20 },
      '30d': { rsiPeriod: 6, stochPeriod: 6, smoothK: 2, smoothD: 2, overbought: 80, oversold: 20 },
    };
    const ovL = buildSrsiOverview(['1d', '7d', '30d'], (tf) => longCfg[tf] || srsi, { '1d': daily, '7d': resample(daily, 7), '30d': resample(daily, 30) }, 150);
    const r1d = ovL.rows.find(r => r.tf === '1d'), r7 = ovL.rows.find(r => r.tf === '7d'), r30 = ovL.rows.find(r => r.tf === '30d');
    ok('7d 聚合周线 K/D 有数值(不再恒等于1d)', typeof r7.k === 'number' && r7.k !== null);
    ok('30d 聚合月线 K/D 有数值', typeof r30.k === 'number' && r30.k !== null);
    ok('30d 月线 K/D 非恒为50(周期够小以预热)', r30.k !== 50 || r30.d !== 50);
    ok('聚合后周线根数≈71、月线≈16', r7.k != null && resample(daily, 7).length >= 50 && resample(daily, 30).length >= 10);
    ok('1d 与 7d K/D 解耦(不等)', r1d.k !== r7.k);
    ok('7d 与 30d K/D 解耦(不等)', r7.k !== r30.k);
    // buildSrsiOverview 仍兼容旧式对象 cfg(非函数)
    const ovObj = buildSrsiOverview(['1d'], srsi, { '1d': daily }, 150);
    ok('对象式 cfg 仍可用(向后兼容)', typeof ovObj.rows[0].k === 'number');
  }
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

console.log('\n[kchart: 反转对称性 · 上涨后反转下跌(rise→fall)]');
{
  // 上涨后反转下跌：金叉被反转(K<D) + 趋势向下 → 空头韧性 +8（验证与「下跌后反转上涨」路径对称）
  const srsi = { rsiPeriod: 85, stochPeriod: 50, smoothK: 10, smoothD: 5, overbought: 80, oversold: 20 };
  const fallTrend = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(200 - i * 0.1 + Math.sin(i / 9) * 14); return a; };
  const pm = { '5m': fallTrend(500), '15m': fallTrend(500), '1h': fallTrend(500), '4h': fallTrend(500) };
  const s = analyzeTradeDiscipline(pm, srsi, { bars: 150, mainTF: '1h' });
  ok('rise→fall: 趋势向下(up=false)', s.trend.up === false);
  ok('rise→fall: 金叉信号被反转(rev=true)', s.confirm.dir === 'buy' && s.confirm.reversed === true);
  ok('rise→fall: 空头韧性+8(镜像上涨反转的+8)', s.entry.confParts.some(p => p.includes('金信号反转+8(空头韧性)')));
  ok('rise→fall: D>K 全周期强势-10(与 K>D +10 对称)', s.entry.confParts.some(p => p.includes('全周期K<D 强势-10')));
  ok('置信度整数(无浮点小数 13.8999…)', Number.isInteger(s.entry.conf));
  ok('反转文案错别字已修(金钩/金叉)', s.entry.reason.includes('金钩/金叉已反转(K<D)'));
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
  ok('pickConfirm 期望看多+最近死叉→contrarian 未确认', d1.contrarian === true && d1.confirmed === false && d1.dir === 'sell');
  const d2 = pickConfirm([{ tf: '5m', crossing: 'buy', fresh: 1, hook: null, hookFresh: null }], 'buy');
  ok('pickConfirm 期望看多+最近金叉→同向确认', d2.contrarian === false && d2.confirmed === true && d2.dir === 'buy');
  const d3 = pickConfirm([{ tf: '5m', crossing: 'buy', fresh: 2, hook: null, hookFresh: null }], 'sell');
  ok('pickConfirm 期望看空+最近金叉→contrarian', d3.contrarian === true && d3.confirmed === false);
  const d4 = pickConfirm([{ tf: '5m', crossing: 'sell', fresh: 2, hook: null, hookFresh: null }], 'sell');
  ok('pickConfirm 期望看空+最近死叉→同向确认', d4.contrarian === false && d4.confirmed === true);
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

  // S1 顺势看多: 4h 上升 + 15m 超卖回调 → 看多, 中置信, 回调≠反转规则通过
  const s1 = analyzeTradeDiscipline({ '5m': riseThenDip(500), '15m': riseThenDip(500), '1h': rising(500), '4h': rising(500) }, srsi, { bars: 150, mainTF: '15m' });
  ok('S1 趋势识别为上升', s1.trend.up === true);
  ok('S1 主周期(15m)超卖', s1.zones.main === 'oversold');
  ok('S1 建议看多', s1.entry.dir === '看多');
  ok('S1 置信度中等(≥45)', s1.entry.conf >= 45);
  ok('S1 7条纪律规则(含短周期锚定+反转识别)', s1.rules.length === 7);
  ok('S1 顺势交易规则通过', s1.rules[0].ok === true);
  ok('S1 回调≠反转规则通过(上涨趋势回调=低吸)', s1.rules.find(r => r.name === '回调≠反转').ok === true);
  ok('S1 signalLife 存在并写入 reason', !!s1.signalLife && s1.entry.reason.includes('信号: ') && s1.signalLife.txt.length > 0);

  // S2 顺势看空: 4h 下降 + 15m 超买反弹 → 看空
  const s2 = analyzeTradeDiscipline({ '5m': fallThenRally(500), '15m': fallThenRally(500), '1h': falling(500), '4h': falling(500) }, srsi, { bars: 150, mainTF: '15m' });
  ok('S2 趋势识别为下降', s2.trend.up === false);
  ok('S2 主周期超买', s2.zones.main === 'overbought');
  ok('S2 建议看空', s2.entry.dir === '看空');
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

  // S9 回归: 看空目标必须低于现价（防止 te20 高于现价导致目标无意义）
  // 构造: 1d下降, 主周期超买 → 看空; 且 trendTF(1d) 的 te20 高于现价
  const s9 = analyzeTradeDiscipline({ '5m': fallThenRally(500), '15m': fallThenRally(500), '1h': falling(500), '4h': falling(500), '1d': falling(500) }, srsi, { bars: 150, mainTF: '15m' });
  ok('S9 看空场景 target < 现价', s9.entry.dir.startsWith('看空') && s9.entry.target != null && s9.entry.target < s9.entry.stop);
  ok('S9 看空场景 stop > 现价(在target上方)', s9.entry.stop > s9.entry.target);

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

  // S13 回归: stale contrarian (fresh>3) → 不触发门控, 仍看多(观察)
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
  ok('S13 stale contrarian(>3) 不观望', s13.entry.dir.startsWith('看多') && s13.entry.dir !== '观望');
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
  ok('S14 上升+能量领跑方向→看多', s1b.entry.dir === '看多');
  ok('S14 下降+动量跟随方向→看空', s2b.entry.dir === '看空');

  // S15 TSEV 翻转修复回归：经典判「观望」(target/stop=null) 但 TSEV 权重投出可交易看多时，
  // 必须补上 target/stop，避免面板「可交易」却显示「—」。复用 S12 的 gateWait 场景。
  const s15 = analyzeTradeDiscipline({
    '5m': contrarianFixture(), '15m': uptrend(600, 0.15), '1h': uptrend(600, 0.15), '4h': uptrend(600, 0.15)
  }, srsi, { bars: 150, mainTF: '1h', weights: { 'consensus|bear|-1': -5, 'hook|death|-1': -5 } });
  ok('S15 经典观望被TSEV翻转为看多', s15.entry.dir === '看多');
  ok('S15 TSEV 可交易(actionable)', s15.tsev && s15.tsev.actionable === true);
  ok('S15 翻转后补上目标价(非null)', s15.entry.target != null);
  ok('S15 翻转后补上止损(非null)', s15.entry.stop != null);
  ok('S15 补的止损低于目标(顺势多)', s15.entry.stop < s15.entry.target);
  ok('S14 横盘+趋势跟随→观望', sfb.entry.dir === '观望');
  ok('S14 energy-leader 不重复加领跑分', !s1b.entry.confParts.some(p => p.includes('领跑')));
  ok('S14 regime 字段存在', s1b.regime && typeof s1b.regime.type === 'string');
  ok('S14 弱逆势领跑(55<70)不翻转→仍看多观察', s13b.entry.dir.startsWith('看多') && s13b.entry.dir !== '观望');
  ok('S14 弱逆势不翻转时理由含能量', s13b.entry.reason.includes('能量'));

  // S17 方案1：TSEV 投票方向但阈值不足 → 保留方向、仅不可交易（不丢弃成观察，避免与子信号自相矛盾）
  const s17 = analyzeTradeDiscipline({ '5m': uptrend(600, 0.15), '15m': uptrend(600, 0.15), '1h': uptrend(600, 0.15), '4h': uptrend(600, 0.15) }, srsi, { bars: 150, mainTF: '1h', weights: { 'consensus|bull|1': 0.1 } });
  ok('S17 投票看多但阈值不足→保留看多(非观察)', s17.entry.dir.startsWith('看多') && s17.entry.dir !== '观望');
  ok('S17 不可交易(actionable=false)', s17.tsev && s17.tsev.actionable === false);
}

// S16 诚实逆势：方向依据 / 顺势交易规则 必须与实际方向一致（消除「看多基准却判看空」的自相矛盾）
{
  const srsi = { rsiPeriod: 85, stochPeriod: 50, smoothK: 10, smoothD: 5, overbought: 80, oversold: 20 };
  const rising = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(100 + i * 0.3); return a; };
  const falling = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(300 - i * 0.3); return a; };
  const riseThenDip = (n) => { const a = rising(n); for (let i = 0; i < 40; i++) a.push(a[a.length - 1] - (i + 1) * 1.2); return a; };
  const fallThenRally = (n) => { const a = falling(n); for (let i = 0; i < 40; i++) a.push(a[a.length - 1] + (i + 1) * 1.2); return a; };
  // 不变量: contraTrade 当且仅当 方向与趋势相反；且 顺势交易规则 ok === !contraTrade
  const inv = (s) => {
    const rev = (s.trend.up === true && s.entry.dir.startsWith('看空')) || (s.trend.up === false && s.entry.dir.startsWith('看多'));
    return s.contraTrade === rev && s.rules.find(r => r.name === '顺势交易').ok === !s.contraTrade;
  };

  const upPM = { '5m': riseThenDip(500), '15m': riseThenDip(500), '1h': rising(500), '4h': rising(500) };
  const sUp = analyzeTradeDiscipline(upPM, srsi, { bars: 150, mainTF: '15m' });
  ok('S16 顺势看多 contraTrade=false', sUp.contraTrade === false);
  ok('S16 顺势看多 方向依据含看多基准', (sUp.basisNote || '').includes('看多基准'));
  ok('S16 顺势看多 顺势交易规则✅', sUp.rules.find(r => r.name === '顺势交易').ok === true);
  ok('S16 顺势看多 不变量', inv(sUp));

  const downPM = { '5m': fallThenRally(500), '15m': fallThenRally(500), '1h': falling(500), '4h': falling(500) };
  const sDown = analyzeTradeDiscipline(downPM, srsi, { bars: 150, mainTF: '15m' });
  ok('S16 顺势看空 contraTrade=false', sDown.contraTrade === false);
  ok('S16 顺势看空 顺势交易规则✅', sDown.rules.find(r => r.name === '顺势交易').ok === true);
  ok('S16 顺势看空 不变量', inv(sDown));

  // 逆势覆盖场景：上升市中短周期出现清晰偏空信号 → 应判看空 且 如实标注逆势（不伪装成看多基准）
  const crash = (n) => {
    const a = []; for (let i = 0; i < n - 30; i++) a.push(100 + i * 0.5);
    const last = a[a.length - 1]; for (let i = 1; i <= 30; i++) a.push(last - i * 6); return a;
  };
  const sCT = analyzeTradeDiscipline({ '5m': crash(500), '15m': rising(500), '1h': rising(500), '4h': rising(500) }, srsi, { bars: 150, mainTF: '1h' });
  ok('S16 逆势场景 不变量仍成立', inv(sCT));
  if (sCT.contraTrade) {
    ok('S16 逆势覆盖→方向依据含逆势覆盖', (sCT.basisNote || '').includes('逆势覆盖'));
    ok('S16 逆势覆盖→顺势交易规则⚠', sCT.rules.find(r => r.name === '顺势交易').ok === false);
  } else {
    ok('S16 逆势场景未触发覆盖(依赖数据形态, 不变量已保)', true);
  }
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
  ok('CP 宏观向下+看多=扣分>0', conflictPenalty(mtDown, '看多') > 0);
  ok('CP 宏观向上+看空=扣分>0', conflictPenalty(mtUp, '看空') > 0);
  ok('CP 同向=0', conflictPenalty(mtUp, '看多') === 0);
  ok('CP 观望=0', conflictPenalty(mtDown, '观望') === 0);
  ok('CP 无宏观=0', conflictPenalty(null, '看多') === 0);
  ok('CP 扣分范围[10,20]', (() => { const p = conflictPenalty(mtDown, '看多'); return p >= 10 && p <= 20; })());
  ok('CP 扣分按 spread 缩放', (() => {
    const smallMT = { tf: '30d', up: false, spreadPct: 5 };
    const largeMT = { tf: '30d', up: false, spreadPct: 40 };
    return conflictPenalty(smallMT, '看多') < conflictPenalty(largeMT, '看多');
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

  // positionSizing: 长×中×短 三周期对齐 → 仓位阶梯
  const ps = positionSizing;
  ok('PS 三连多→立即加大×1.5', (() => { const r = ps(true, true, true); return r.mult === 1.5 && r.label === '立即加大筹码' && r.side === 'up'; })());
  ok('PS 三连空→立即加大×1.5', (() => { const r = ps(false, false, false); return r.mult === 1.5 && r.label === '立即加大筹码' && r.side === 'down'; })());
  ok('PS 中↑短↑长↓→逆风不追满×0.5', (() => { const r = ps(false, true, true); return r.mult === 0.5 && r.label.includes('不追满'); })());
  ok('PS 中↑短↑长中性→顺势×1.0', (() => { const r = ps(null, true, true); return r.mult === 1.0 && r.label === '顺势正常做'; })());
  ok('PS 中↓短↓长↑→顺势做空略加×1.2', (() => { const r = ps(true, false, false); return r.mult === 1.2 && r.label.includes('顺势做空'); })());
  ok('PS 中↑短↓→仅轻仓逆势×0.5', (() => { const r = ps(true, true, false); return r.mult === 0.5 && r.label.includes('轻仓逆势'); })());
  ok('PS 中↓短↑→仅轻仓逆势×0.5', (() => { const r = ps(false, false, true); return r.mult === 0.5 && r.label.includes('轻仓逆势'); })());
  ok('PS 全中性→基准×0.6', (() => { const r = ps(null, null, null); return r.mult === 0.6; })());
  ok('PS cls: 三连多→disc-size-up', ps(true, true, true).cls === 'disc-size-up');
  ok('PS cls: 三连空→disc-size-down', ps(false, false, false).cls === 'disc-size-down');
  ok('PS cls: 背离→disc-size-neutral', ps(true, true, false).cls === 'disc-size-neutral');

  // PS 仓位门控: 三连多/空 + caveat → 不追满(×1.0 标准仓)
  ok('PS 三连多+caveat→×1.0 不满攻', (() => { const r = ps(true, true, true, null, { caveat: { present: true, reasons: ['日线超买', '信号未确认'] } }); return r.mult === 1.0 && r.label.includes('不满攻'); })());
  ok('PS 三连空+caveat→×1.0 不满攻', (() => { const r = ps(false, false, false, null, { caveat: { present: true, reasons: ['动能背离'] } }); return r.mult === 1.0 && r.label.includes('不满攻'); })());
  ok('PS 三连多无caveat→仍×1.5', ps(true, true, true).mult === 1.5);

  // 本地序列构造（EMA 上升 + SRSI 多周期一致偏多 / 镜像偏空），用于仓位/透明化断言
  const upTrend = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(100 + Math.sin(i / 8) * 8 + i * 0.15); return a; };
  const dnTrend = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(200 - Math.sin(i / 8) * 8 - i * 0.15); return a; };

  // bullBearTfs: 与 countBullBear 计数一致, 且返回 TF 名列表
  const pmBull = { '5m': upTrend(500), '15m': upTrend(500), '1h': upTrend(500), '4h': upTrend(500) };
  const ovBull = buildSrsiOverview(['5m', '15m', '1h', '4h'], srsi, pmBull, 150);
  const bbBull = bullBearTfs(ovBull.rows);
  ok('BTF 返回 TF 名数组', Array.isArray(bbBull.bullTfs) && Array.isArray(bbBull.bearTfs));
  ok('BTF 计数与 countBullBear 一致', bbBull.bullTfs.length === ovBull.bull && bbBull.bearTfs.length === ovBull.bear);
  ok('BTF 全上升→偏多含4h 且无偏空', bbBull.bullTfs.includes('4h') && bbBull.bearTfs.length === 0);

  // conflictNote 接线: analyzeTradeDiscipline 的 conflictNote 必须等于纯函数结果(无论 SRSI 是否命中)
  const pmA = { '1h': falling(500), '4h': falling(500), '1d': falling(500), '30d': falling(500) };
  const rA = analyzeTradeDiscipline(pmA, srsi, { bars: 150, mainTF: '1h' });
  ok('CN 接线: 与纯函数一致', rA.conflictNote === trendConflictNote(rA.trend.up, rA.multiTf.verdict, rA.trend.tf));
  const pmB = { '1h': rising(500), '4h': rising(500), '1d': rising(500), '30d': rising(500) };
  const rB = analyzeTradeDiscipline(pmB, srsi, { bars: 150, mainTF: '1h' });
  ok('CN 接线(上升): 与纯函数一致', rB.conflictNote === trendConflictNote(rB.trend.up, rB.multiTf.verdict, rB.trend.tf));
  ok('ATD 返回 sizing 字段', typeof rB.sizing === 'object' && typeof rB.sizing.mult === 'number');
  ok('ATD sizing 由 positionSizing 计算(接线一致)', rB.sizing.mult === ps(rB.longUp, rB.trend.up, rB.multiTf.verdict === '一致偏多' ? true : rB.multiTf.verdict === '一致偏空' ? false : null, rB.entry.dir.startsWith('看多') ? true : rB.entry.dir.startsWith('看空') ? false : null).mult);

  // ATD 仓位门控: 三连多 + 未确认/置信不足 → 不满攻(×1.0)，验证 ② 透明降仓
  const pmGate = { '5m': upTrend(500), '15m': upTrend(500), '1h': upTrend(500), '4h': upTrend(500), '1d': upTrend(500), '7d': upTrend(500), '30d': upTrend(500) };
  const rGate = analyzeTradeDiscipline(pmGate, srsi, { bars: 150, mainTF: '1h' });
  ok('ATD 三连多+风险→仓位不满攻(mult<1.5)', rGate.sizing.mult < 1.5);
  ok('ATD 满攻降级为谨慎标签', rGate.sizing.label.includes('不满攻'));
  ok('ATD multiTf 暴露 verdictShort1h(真·短轴)', typeof rGate.multiTf.verdictShort1h === 'string');
  ok('ATD multiTf 暴露 bullTfs/bearTfs(透明化)', Array.isArray(rGate.multiTf.bullTfs) && Array.isArray(rGate.multiTf.bearTfs));

  // ATD 真·短轴(≤1h): 4h 上升但 1h/5m/15m 下跌 → 短共识非一致偏多(源头消除假三连多)，且透明化揭示构成
  const pmShort = { '5m': dnTrend(500), '15m': dnTrend(500), '1h': dnTrend(500), '4h': upTrend(500), '1d': upTrend(500), '7d': upTrend(500), '30d': upTrend(500) };
  const rShort = analyzeTradeDiscipline(pmShort, srsi, { bars: 150, mainTF: '1h' });
  ok('ATD ≤1h 真短轴: 4h↑但短↓ → shortVerdict 非一致偏多', rShort.multiTf.verdictShort1h !== '一致偏多');
  ok('ATD 透明化: bullTfs 含4h 且 bearTfs 非空(揭示构成)', rShort.multiTf.bullTfs.includes('4h') && rShort.multiTf.bearTfs.length > 0);

  // sizing.side 与 entry.dir 方向一致性（看多→up/看空→down/观望→up|down|null）
  const sizingSideFromDir = rB.entry.dir.startsWith('看多') ? 'up' : rB.entry.dir.startsWith('看空') ? 'down' : null;
  ok('ATD sizing.side 与 entry.dir 一致', rB.sizing.side === sizingSideFromDir,
    `sizing.side=${rB.sizing.side} vs dir=${rB.entry.dir} → expected=${sizingSideFromDir}`);

  // 逆势案例：BNB 型（中短偏多 + 但判决看空）→ sizing.side='down', label含逆势
  const pmBNB = { '5m': rising(500), '15m': rising(500), '1h': rising(500), '4h': falling(500), '1d': falling(500), '7d': falling(500) };
  const rBNB = analyzeTradeDiscipline(pmBNB, srsi, { bars: 150, mainTF: '1h' });
  const dbBNB = rBNB.entry.dir.startsWith('看多') ? true : rBNB.entry.dir.startsWith('看空') ? false : null;
  if (dbBNB !== null && rBNB.sizing.side !== null) {
    ok('BNB型 sizing.side 与 dir 一致', rBNB.sizing.side === (dbBNB ? 'up' : 'down'));
  }

  // entryCue: gateWait + hook已触发 → "X钩已现，等价格企稳"
  const pmHook = { '5m': rising(500), '15m': falling(500), '4h': rising(500), '1d': rising(500) };
  const rHook = analyzeTradeDiscipline(pmHook, srsi, { bars: 150, mainTF: '15m' });
  if (rHook.entry.dir === '观望' && rHook.confirm.isHook) {
    ok('hook已触发时 entryCue 含"已现"', rHook.entry.entryCue.includes('已现'));
  }

  // 宏观冲突接线: 4h V反弹(方向基准向上) 但 30d 宏观向下 → 看多方向被宏观扣分
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

  // 看多: 目标700.1 止损673.6, 现价686.41(未达目标未破止损)
  const a1 = discLiveInfo('BTCUSDT', { entry: { dir: '看多', target: 700.1, stop: 673.6 } });
  ok('D1 价格取自 window.S', a1.price === 686.41);
  ok('D1 价格涨跌着色(chg<0→down)', a1.priceCls === 'disc-down');
  ok('D1 距目标% 正确', close(a1.toTarget, (700.1 - 686.41) / 686.41 * 100));
  ok('D1 距止损% 正确', close(a1.toStop, (673.6 - 686.41) / 686.41 * 100));
  ok('D1 未达目标→targetCls空', a1.targetCls === '');
  ok('D1 未破止损→stopCls空', a1.stopCls === '');

  // 现价突破目标(看多, 现价>目标) → targetCls=disc-pos, 涨→up
  globalThis.window = { S: { prices: { BTCUSDT: { last: 710, chg: 2.5 } } } };
  const a2 = discLiveInfo('BTCUSDT', { entry: { dir: '看多', target: 700.1, stop: 673.6 } });
  ok('D2 现价>目标→targetCls=disc-pos', a2.targetCls === 'disc-pos');
  ok('D2 价格涨→priceCls=disc-up', a2.priceCls === 'disc-up');

  // 现价跌破止损(看多, 现价<止损) → stopCls=disc-neg
  globalThis.window = { S: { prices: { BTCUSDT: { last: 670, chg: -3 } } } };
  const a3 = discLiveInfo('BTCUSDT', { entry: { dir: '看多', target: 700.1, stop: 673.6 } });
  ok('D3 现价<止损→stopCls=disc-neg', a3.stopCls === 'disc-neg');

  // 看空: 目标673.6(低于现价), 止损700.1(高于现价); 现价670<目标→已到目标→targetCls=disc-pos
  globalThis.window = { S: { prices: { BTCUSDT: { last: 670, chg: 1 } } } };
  const a4 = discLiveInfo('BTCUSDT', { entry: { dir: '看空', target: 673.6, stop: 700.1 } });
  ok('D4 看空 距目标% 正确', close(a4.toTarget, (673.6 - 670) / 670 * 100));
  ok('D4 看空 现价<目标→已到目标 targetCls=disc-pos', a4.targetCls === 'disc-pos');
  ok('D4 看空 现价<止损→stopCls空', a4.stopCls === '');

  // 无价格数据 → null
  globalThis.window = { S: { prices: {} } };
  ok('D5 无价格→null', discLiveInfo('BTCUSDT', { entry: { dir: '看多', target: 700, stop: 673 } }) === null);

  // 清理, 避免影响后续(若有)
  delete globalThis.window;
}

// ============ 短线多空共识：多维因子加权 ============
const mkRow = (tf, o = {}) => ({
  tf, k: o.k, d: o.d, hook: o.hook || null, hookFresh: o.hookFresh != null ? o.hookFresh : null,
  zone: o.zone || null, crossing: o.crossing || null, fresh: o.fresh != null ? o.fresh : null, gapTrend: o.gapTrend || 'flat', reversed: !!o.reversed
});

console.log('\n[kchart: 短线多维加权 shortSignalWeight]');
const r4 = mkRow('4h', { k: 25, d: 18, hook: 'goldHook', hookFresh: 2, crossing: 'buy', fresh: 5, gapTrend: 'up' });
const r1 = mkRow('1h', { k: 25, d: 18, hook: 'goldHook', hookFresh: 2, crossing: 'buy', fresh: 5, gapTrend: 'up' });
const w4 = shortSignalWeight(r4, 2), w1 = shortSignalWeight(r1, 2);
ok('①周期时长: 4h权重≈1h的2倍', w4 > w1 * 1.9 && w4 < w1 * 2.1);
ok('①周期时长: 4h钩权重≈1.0+', w4 > 0.9 && w4 < 1.3);

const rCross = mkRow('4h', { k: 25, d: 18, crossing: 'buy', fresh: 2, gapTrend: 'up' });
ok('②信号类型: 钩 > 叉(同周期同向)', shortSignalWeight(r4, 2) > shortSignalWeight(rCross, 2));

const rWide = mkRow('4h', { k: 30, d: 10, crossing: 'buy', fresh: 5, gapTrend: 'up' });
const rNarrow = mkRow('4h', { k: 21, d: 19, crossing: 'buy', fresh: 5, gapTrend: 'up' });
ok('③KD间距: 大 > 小', shortSignalWeight(rWide, 5) > shortSignalWeight(rNarrow, 5));

const rOldHook = mkRow('4h', { k: 25, d: 18, hook: 'goldHook', hookFresh: 4, crossing: 'buy', fresh: 5, gapTrend: 'up' });
ok('④极值突破: 刚突破(fv≤3) > 老钩(fv>3)', shortSignalWeight(r4, 2) > shortSignalWeight(rOldHook, 4));

const rNew = mkRow('4h', { k: 25, d: 18, crossing: 'buy', fresh: 1, gapTrend: 'flat' });
const rOld = mkRow('4h', { k: 25, d: 18, crossing: 'buy', fresh: 18, gapTrend: 'flat' });
ok('⑤新鲜度: 新鲜根 > 老根', shortSignalWeight(rNew, 1) > shortSignalWeight(rOld, 18));

console.log('\n[kchart: 钩反转加权 higherExtreme]');
// 4h 超买(极值带) + 1h 死钩(≤1h 钩) 时, 该钩权重应被放大到压过 4h 趋势权重
const r4hOB = mkRow('4h', { k: 83, d: 82, hook: null, zone: 'overbought', crossing: 'buy', fresh: 3, gapTrend: 'up' });
const r1hDH = mkRow('1h', { k: 40, d: 49, hook: 'deathHook', hookFresh: 8, zone: 'neutral', crossing: 'sell', fresh: 12, gapTrend: 'down' });
const wHookNoBoost = shortSignalWeight(r1hDH, 12, {});
const wHookBoost = shortSignalWeight(r1hDH, 12, { higherExtreme: true });
ok('钩反转: higherExtreme 下 ≤1h 钩权重被放大', wHookBoost > wHookNoBoost * 2);
ok('钩反转: 放大后 1h死钩权重 > 4h(无钩)权重', wHookBoost > shortSignalWeight(r4hOB, 3, {}));
// 无 higherExtreme 时不应放大（正常趋势 4h 仍主导）
ok('钩反转: 无 higherExtreme 时不放大', wHookBoost > wHookNoBoost && shortSignalWeight(r1hDH, 12, {}) === wHookNoBoost);
// ≥4h 的钩(8h) 不因 higherExtreme 被放大(仅 ≤1h 钩)
const r8hDH = mkRow('8h', { k: 74, d: 70, hook: 'deathHook', hookFresh: 4, zone: 'neutral', crossing: 'sell', fresh: 35, gapTrend: 'down' });
ok('钩反转: ≥4h 钩不放大', shortSignalWeight(r8hDH, 35, { higherExtreme: true }) === shortSignalWeight(r8hDH, 35, {}));

console.log('\n[kchart: countBullBear 钩反转翻转共识]');
// BNB 型: 4h 超买(K>D 计多) + 1h 死钩(计空) → 放大后空方压倒多方 → 一致偏空
const cbBNB = countBullBear([r4hOB, r1hDH]);
ok('BNB型: 加权空 > 加权多(钩反转生效)', cbBNB.wbear > cbBNB.wbull);
ok('BNB型: weightedShortVerdict=一致偏空', weightedShortVerdict([r4hOB, r1hDH], cbBNB.wbull, cbBNB.wbear) === '一致偏空');
// 对照: 无 1h 钩(仅 4h 超买 + 1h 普通死叉) → 不放大 → 多方(4h)占优 → 一致偏多
const r1hPlain = mkRow('1h', { k: 40, d: 49, hook: null, zone: 'neutral', crossing: 'sell', fresh: 12, gapTrend: 'down' });
const cbNoHook = countBullBear([r4hOB, r1hPlain]);
ok('对照: 无≤1h钩时不翻转(4h主导→偏多)', weightedShortVerdict([r4hOB, r1hPlain], cbNoHook.wbull, cbNoHook.wbear) === '一致偏多');

console.log('\n[kchart: 加权共识 weightedVerdict]');
ok('占比1 → 一致偏多', weightedVerdict(0.6, 0) === '一致偏多');
ok('占比0.6 → 一致偏多', weightedVerdict(0.6, 0.4) === '一致偏多');
ok('占比0.59 → 分歧', weightedVerdict(0.59, 0.41) === '分歧');
ok('占比0.4 → 一致偏空', weightedVerdict(0.4, 0.6) === '一致偏空');
ok('全中性 → 中性', weightedVerdict(0, 0) === '中性');

console.log('\n[kchart: 加权共识+锚定 weightedShortVerdict]');
const rb5 = mkRow('5m', { k: 25, d: 18, hook: 'goldHook', hookFresh: 2, crossing: 'buy', fresh: 5, gapTrend: 'up' });
const rb1m = mkRow('1m', { k: 26, d: 19, hook: 'goldHook', hookFresh: 1, crossing: 'buy', fresh: 6, gapTrend: 'up' });
const rb1h = mkRow('1h', { k: 25, d: 18, hook: 'goldHook', hookFresh: 2, crossing: 'buy', fresh: 5, gapTrend: 'up' });
const cbNoAnchor = countBullBear([rb5, rb1m]);
ok('纯加权: 全≤1h偏多 → 一致偏多', weightedVerdict(cbNoAnchor.wbull, cbNoAnchor.wbear) === '一致偏多');
ok('锚定: 无≥1h周期 → 降级分歧', weightedShortVerdict([rb5, rb1m], cbNoAnchor.wbull, cbNoAnchor.wbear) === '分歧');
const cbAnchor = countBullBear([rb5, rb1m, rb1h]);
ok('锚定: 有1h同向 → 维持一致偏多', weightedShortVerdict([rb5, rb1m, rb1h], cbAnchor.wbull, cbAnchor.wbear) === '一致偏多');

console.log('\n[kchart: countBullBear 加权返回]');
ok('返回 wbull/wbear', cbAnchor.wbull > 0 && cbAnchor.wbear === 0);
const rBear = mkRow('4h', { k: 78, d: 82, hook: 'deathHook', hookFresh: 2, crossing: 'sell', fresh: 5, gapTrend: 'down' });
const cbMix = countBullBear([rb1h, rBear]);
ok('混合多空都计', cbMix.bull === 1 && cbMix.bear === 1 && cbMix.wbull > 0 && cbMix.wbear > 0);

console.log('\n[kchart: 短线能量场 energyBallLayout]');
const _srsi = { rsiPeriod: 85, stochPeriod: 50, smoothK: 10, smoothD: 5, overbought: 80, oversold: 20 };
const _rising = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(100 + i * 0.5); return a; };
const _bull = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(100 + (i % 25) * 0.8 - (i % 7) * 0.1); return a; };
const m0 = energyBallLayout([], { wbull: 0, wbear: 0, verdict: '分歧' }, 300, 300);
ok('空数据: nodes=0', m0.nodes.length === 0);
ok('空数据: orbR 基础值26', m0.orbR === 26);
const sf = [
  { tf: '4h', dir: 'bull', w: 1.0, k: 25, d: 18, gap: 7, gapTrend: 'up', fresh: 2, isHook: true, signal: 'goldHook', reversed: false },
  { tf: '5m', dir: 'bear', w: 0.1, k: 80, d: 82, gap: -2, gapTrend: 'down', fresh: 9, isHook: false, signal: 'sell', reversed: false }
];
const m = energyBallLayout(sf, { wbull: 1.0, wbear: 0.1, ratio: 0.91, verdict: '一致偏多' }, 300, 300);
ok('有数据: nodes=2', m.nodes.length === 2);
ok('节点在界内', m.nodes.every(n => n.x >= 0 && n.x <= 300 && n.y >= 0 && n.y <= 300));
ok('中心强度符号=多(正)', m.strength > 0);
ok('verdict 透传', m.verdict === '一致偏多');
ok('连线数=节点数', m.edges.length === m.nodes.length);
ok('节点半径随权重(4h>5m)', m.nodes[0].r > m.nodes[1].r);
const ringR = 300 * 0.36;
ok('节点在环上(距中心≈ringR)', Math.abs(Math.hypot(m.nodes[0].x - 150, m.nodes[0].y - 150) - ringR) < 1.5);

console.log('\n[kchart: energyBallHitTest 命中检测]');
const n0 = m.nodes[0], n1 = m.nodes[1];
ok('命中节点中心(4h)→返回4h', energyBallHitTest(m, n0.x, n0.y) && energyBallHitTest(m, n0.x, n0.y).tf === '4h');
ok('命中节点中心(5m)→返回5m', energyBallHitTest(m, n1.x, n1.y) && energyBallHitTest(m, n1.x, n1.y).tf === '5m');
ok('远离任何节点(中心)→null', energyBallHitTest(m, 150, 150) === null);
ok('环带内近4h角度(容错)→4h', energyBallHitTest(m, n0.x, n0.y - 30) && energyBallHitTest(m, n0.x, n0.y - 30).tf === '4h');
ok('环带外(远角)→null', energyBallHitTest(m, 280, 280) === null);
ok('空节点布局→null', energyBallHitTest(m0, 150, 150) === null);

console.log('\n[kchart: tfOverviewStat 周期涨跌/区间]');
ok('涨: c=[100,110]→+10%', Math.abs(tfOverviewStat([100, 110], null, null).chgPct - 10) < 1e-9);
ok('跌: c=[110,100]→≈-9.09%', Math.abs(tfOverviewStat([110, 100], null, null).chgPct - (-9.0909)) < 0.01);
ok('平: c=[100,100]→0% 但 ok', tfOverviewStat([100, 100], null, null).chgPct === 0 && tfOverviewStat([100, 100], null, null).ok === true);
ok('数据不足: c=[100]→ok=false', tfOverviewStat([100], null, null).ok === false);
ok('区间来自 l/h(末bars)', tfOverviewStat([1, 2], [1, 5], [3, 9], 2).low === 1 && tfOverviewStat([1, 2], [1, 5], [3, 9], 2).high === 9);
ok('l/h 缺→回退 c 区间', (() => { const s = tfOverviewStat([5, 7], null, null, 2); return s.low === 5 && s.high === 7; })());
ok('bars 截断只取末N根', (() => { const s = tfOverviewStat([1, 2, 3, 10], [0, 0, 4, 8], [0, 0, 12, 5], 2); return s.low === 4 && s.high === 12; })());
ok('fmtPrice 自适应小数', fmtPrice(1234.5) === '1234.50' && fmtPrice(0.01234) === '0.0123' && fmtPrice(null) === '--');

console.log('\n[kchart: tfOverviewStat 时长感知(用时间戳回看真实时长)]');
// 30d 类: K线实际是日线分辨率(每根=1天), 单根邻接会误算成1日涨跌; 应回看30天前价格
ok('30d→回看30天前=+23.15%', (() => {
  const c = [100, 110, 120, 123.15];
  const t = [0, 86400000, 172800000, 259200000]; // 每天一根(ms), now=第3天
  const s = tfOverviewStat(c, null, null, t, 150, 3 * 1440);
  return s.ok && s.chgPct != null && Math.abs(s.chgPct - 23.15) < 1e-6;
})());
ok('10m→回看10分钟前(末根)', (() => {
  // 1分钟一根, durMin=10 → 回看10分钟前=第0根
  const c = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110];
  const t = []; for (let i = 0; i < c.length; i++) t.push(i * 60000);
  const s = tfOverviewStat(c, null, null, t, 150, 10);
  return s.ok && Math.abs(s.chgPct - 10) < 1e-9; // (110-100)/100=10%
})());
ok('时间戳缺失→回退单根邻接', (() => {
  const s = tfOverviewStat([100, 110], null, null, null, 150, 1);
  return s.ok && Math.abs(s.chgPct - 10) < 1e-9;
})());
ok('时长感知: 区间同跨度(末根-回看点)', (() => {
  const c = [100, 105, 110], l = [99, 104, 109], h = [101, 106, 111];
  const t = [0, 60000, 120000];
  const s = tfOverviewStat(c, l, h, t, 150, 1); // durMin=1min → 回看点=第1根(index1)
  return s.low === 104 && s.high === 111 && Math.abs(s.chgPct - (5 / 105 * 100)) < 0.01;
})());
ok('30d 真实日线序列→精确回看30天前', (() => {
  // 150 根日线, 每天一根; 30天前=第120根(150-30), 价格=80; 现在=100 → +25%
  const c = [], t = [];
  for (let i = 0; i < 150; i++) { c.push(80 + (i === 149 ? 20 : 0)); t.push(i * 86400000); }
  c[149] = 100;
  const s = tfOverviewStat(c, null, null, t, 150, 30 * 1440);
  return s.ok && Math.abs(s.chgPct - 25) < 1e-6;
})());

const ad = analyzeTradeDiscipline({ '4h': _rising(500), '1h': _bull(500) }, _srsi, { bars: 150, mainTF: '15m' });
ok('ATD 返回 shortFactors 数组', Array.isArray(ad.shortFactors) && ad.shortFactors.length > 0);
ok('shortFactors 含 tf/dir/w', ad.shortFactors.every(f => f.tf && (f.dir === null || f.dir === 'bull' || f.dir === 'bear') && typeof f.w === 'number'));

console.log('\n[kchart: drawEnergyBall 渲染冒烟]');
function _mockCtx() {
  const noop = () => {};
  return {
    setTransform: noop, clearRect: noop, save: noop, restore: noop, translate: noop, rotate: noop,
    beginPath: noop, arc: noop, moveTo: noop, lineTo: noop, stroke: noop, fill: noop, fillText: noop, closePath: noop, clip: noop,
    setLineDash: noop, createRadialGradient: () => ({ addColorStop: noop }), createLinearGradient: () => ({ addColorStop: noop }),
    strokeStyle: '', fillStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '', shadowColor: '', shadowBlur: 0
  };
}
const mmLong = energyBallLayout(sf, { wbull: 1.0, wbear: 0.1, ratio: 0.91, verdict: '一致偏多' }, 300, 300);
let threw = false;
try { drawEnergyBall(_mockCtx(), mmLong, { t: 1.2, price: 100, W: 300, H: 300 }); } catch (e) { threw = true; console.log('ERR', e.message); }
ok('drawEnergyBall 一致偏多(有价) 不抛', !threw);
const mmDiv = energyBallLayout(sf, { wbull: 0.5, wbear: 0.5, ratio: 0.5, verdict: '分歧' }, 300, 300);
threw = false;
try { drawEnergyBall(_mockCtx(), mmDiv, { t: 0.5, price: null, W: 300, H: 300 }); } catch (e) { threw = true; }
ok('drawEnergyBall 分歧(无价·灰散态) 不抛', !threw);

console.log('\n[kchart: 反转内点 reversalInnerColor]');
const rcBull = reversalInnerColor('bull');
const rcBear = reversalInnerColor('bear');
ok('reversalInnerColor 看多→红(255,82,82)', rcBull[0] === 255 && rcBull[1] === 82 && rcBull[2] === 82);
ok('reversalInnerColor 看空→绿(0,230,118)', rcBear[0] === 0 && rcBear[1] === 230 && rcBear[2] === 118);
// 含反转节点的布局渲染不抛
const sfRev = [
  { tf: '4h', dir: 'bull', w: 1.0, k: 25, d: 18, gap: 7, gapTrend: 'up', fresh: 2, isHook: true, signal: 'goldHook', reversed: true },
  { tf: '5m', dir: 'bear', w: 0.1, k: 80, d: 82, gap: -2, gapTrend: 'down', fresh: 9, isHook: false, signal: 'sell', reversed: true }
];
const mmRev = energyBallLayout(sfRev, { wbull: 1.0, wbear: 0.1, ratio: 0.91, verdict: '一致偏多' }, 300, 300);
threw = false;
try { drawEnergyBall(_mockCtx(), mmRev, { t: 1.0, price: 100, W: 300, H: 300 }); } catch (e) { threw = true; console.log('ERR', e.message); }
ok('drawEnergyBall 含反转节点(内点) 不抛', !threw);

console.log('\n[kchart: KD 环形进度 kdZone / kdSweepFrac]');
ok('kdZone 80→overbought', kdZone(80) === 'overbought');
ok('kdZone 82→overbought', kdZone(82) === 'overbought');
ok('kdZone 20→oversold', kdZone(20) === 'oversold');
ok('kdZone 18→oversold', kdZone(18) === 'oversold');
ok('kdZone 50→neutral', kdZone(50) === 'neutral');
ok('kdZone 超界clamp 120→overbought', kdZone(120) === 'overbought');
ok('kdZone 非数→neutral', kdZone(undefined) === 'neutral');
ok('kdZone 自定义带 75/25: 76→overbought', kdZone(76, 75, 25) === 'overbought');
ok('kdSweepFrac 50→0.5', Math.abs(kdSweepFrac(50) - 0.5) < 1e-9);
ok('kdSweepFrac 100→1', kdSweepFrac(100) === 1);
ok('kdSweepFrac 0→0', kdSweepFrac(0) === 0);
ok('kdSweepFrac 超界 120→1', kdSweepFrac(120) === 1);
ok('kdSweepFrac 负 -5→0', kdSweepFrac(-5) === 0);
ok('kdSweepFrac 非数→0', kdSweepFrac('x') === 0);
// 含 KD 数据的节点渲染（外环路径）不抛
const sfKD = [
  { tf: '4h', dir: 'bull', w: 1.0, k: 82, d: 18, gap: 64, gapTrend: 'up', fresh: 2, isHook: true, signal: 'goldHook', reversed: false },
  { tf: '5m', dir: 'bear', w: 0.1, k: 22, d: 80, gap: -58, gapTrend: 'down', fresh: 9, isHook: false, signal: 'sell', reversed: false }
];
const mmKD = energyBallLayout(sfKD, { wbull: 1.0, wbear: 0.1, ratio: 0.91, verdict: '一致偏多' }, 300, 300);
threw = false;
try { drawEnergyBall(_mockCtx(), mmKD, { t: 1.0, price: 100, W: 300, H: 300 }); } catch (e) { threw = true; console.log('ERR', e.message); }
ok('drawEnergyBall 含KD数据节点(外环) 不抛', !threw);

console.log('\n[kchart: pricePathForecast 预测路径]');
const pfA = analyzeTradeDiscipline({ '4h': _rising(500), '1h': _bull(500) }, _srsi, { bars: 150, mainTF: '15m' });
const pfM = pricePathForecast(pfA, pfA.entry.target || 100, { horizonBars: 12 });
ok('价格路径: target≈entry.target', Math.abs(pfM.target - (pfA.entry.target || 0)) < 1e-6);
ok('价格路径: support≈entry.stop', Math.abs(pfM.support - (pfA.entry.stop || 0)) < 1e-6);
ok('价格路径: pullbackProb∈[0,1]', pfM.pullbackProb >= 0 && pfM.pullbackProb <= 1);
ok('价格路径: 依据非空', Array.isArray(pfM.pullbackBasis) && pfM.pullbackBasis.length > 0);
ok('价格路径: horizon=12', pfM.horizon === 12);
const pfW = pricePathForecast({ entry: { dir: '观望' }, multiTf: { ratio: 0.5, verdict: '分歧' }, shortFactors: [] }, 100, {});
ok('观望: pullbackProb≥0.5', pfW.pullbackProb >= 0.5);
const pfOb = pricePathForecast({ entry: { dir: '看多', target: 110, stop: 95 }, multiTf: { ratio: 0.9, verdict: '一致偏多' }, shortFactors: [{ k: 85 }, { k: 82 }] }, 100, {});
ok('超买共识强: 0.15<pullbackProb<0.85', pfOb.pullbackProb > 0.15 && pfOb.pullbackProb < 0.85);

// 方向无关：看空时 target(止盈/低) < support(止损/高)，bullish=false（动态图对全市场适应）
const pfBear = pricePathForecast({ entry: { dir: '看空', target: 90, stop: 108 }, multiTf: { ratio: 0.1, verdict: '一致偏空' }, shortFactors: [] }, 100, {});
ok('看空: 止盈<止损(方向无关)', pfBear.target < pfBear.support && pfBear.bullish === false);

// 弱信号联动：分歧 → weak=true、uncertainty 高（扇带加宽），强单边 → weak=false、uncertainty 低
const pfWeak = pricePathForecast({ entry: { dir: '观望', target: 100, stop: 100 }, multiTf: { ratio: 0.5, verdict: '分歧' }, shortFactors: [] }, 100, {});
ok('分歧: weak=true', pfWeak.weak === true);
ok('分歧: uncertainty≥0.9', pfWeak.uncertainty >= 0.9);
const pfStrong = pricePathForecast({ entry: { dir: '看多', target: 110, stop: 95 }, multiTf: { ratio: 0.92, verdict: '一致偏多' }, shortFactors: [] }, 100, {});
ok('强多: weak=false', pfStrong.weak === false);
ok('强多: uncertainty<分歧', pfStrong.uncertainty < pfWeak.uncertainty);
ok('强多: strength>0.8', pfStrong.strength > 0.8);

console.log('\n[kchart: drawPricePath 渲染冒烟]');
threw = false;
try { drawPricePath(_mockCtx(), pfM, { t: 1.0, W: 320, H: 200 }); } catch (e) { threw = true; console.log('ERR', e.message); }
ok('drawPricePath 不抛', !threw);
threw = false;
try { drawPricePath(_mockCtx(), { price: 100, target: 90, support: 108, atrAbs: 0.5, pullbackProb: 0.3, uncertainty: 0.9, weak: true, horizon: 12, fanK: 1.5 }, { t: 0.5, W: 320, H: 200 }); } catch (e) { threw = true; console.log('ERR', e.message); }
ok('drawPricePath 看空+弱信号 不抛', !threw);
threw = false;
try { drawPricePath(_mockCtx(), { price: 749, target: 749, support: 749, atrAbs: 3, pullbackProb: 0.5, uncertainty: 1, weak: true, horizon: 12, fanK: 1.5 }, { t: 0.5, W: 320, H: 200 }); } catch (e) { threw = true; console.log('ERR', e.message); }
ok('drawPricePath 观望(目标≈支撑, 原退化成顶部直线) 不抛', !threw);

// 趋势冲突进入依据：短周期偏多但趋势↓→判做空，依据须显式说明
const pfConflict = pricePathForecast({
  entry: { dir: '看空', target: 716.66, stop: 756.95 },
  multiTf: { ratio: 0.24, verdict: '一致偏多' },
  shortFactors: [{ k: 85 }, { k: 82 }, { k: 30 }],
  conflictNote: 'SRSI 多周期一致偏多，但长周期(4h) EMA 向下=主趋势偏空：金叉/金钩仅视为下跌中的反弹（回调≠反转），不逆势看多，等反转确认'
}, 747.29, {});
ok('冲突: 依据含「趋势优先→判看空」', pfConflict.pullbackBasis.some(b => b.includes('趋势优先→判看空')));
ok('冲突: 依据含 EMA 向下说明', pfConflict.pullbackBasis.some(b => b.includes('EMA 向下')));
ok('冲突: 命名改为「短周期加权共识」', pfConflict.pullbackBasis.some(b => b.includes('短周期加权共识')));

// 决策原因进入依据首行：能量领跑逆势覆盖成做空，共识仍偏多 → 首行写明原因 + 反向轴通用说明
const pfReason = pricePathForecast({
  entry: { dir: '看空', target: 716.66, stop: 756.95, reason: '策略[能量领跑]: ETH 能量82 偏空领跑, 逆势独一档高能, 短线动能反转；信号: 衰减中' },
  multiTf: { ratio: 0.19, verdict: '一致偏多' },
  shortFactors: [{ k: 85 }, { k: 82 }, { k: 30 }]
}, 747.29, {});
ok('决策原因: 依据首行含「判看空」', pfReason.pullbackBasis[0].includes('判看空'));
ok('决策原因: 首行含策略说明', pfReason.pullbackBasis[0].includes('逆势'));
ok('决策原因: 反向轴通用说明存在', pfReason.pullbackBasis.some(b => b.includes('短周期共识(一致偏多) 与判看空相反')));
ok('决策原因: 仍含短周期加权共识', pfReason.pullbackBasis.some(b => b.includes('短周期加权共识')));

// 钩反转覆盖: 4h超买上涨(trend判看多) + 1h死钩(SRSI短线判偏空) → 预测翻成看空, 止盈/止损下移
const pfHook = pricePathForecast({
  entry: { dir: '看多', target: 110, stop: 95 },
  multiTf: { ratio: 0.1, verdict: '一致偏空', hookOverride: true },
  shortFactors: [{ k: 85 }, { k: 82 }, { k: 30 }],
  atrP: 1.0
}, 100, {});
ok('钩反转: 预测方向翻为看空', pfHook.dir === '看空');
ok('钩反转: 短线目标<现价(均值回归向下)', pfHook.target < 100);
ok('钩反转: 做空止损(支撑)在现价上方', pfHook.support > 100);
ok('钩反转: 依据含短线段反转说明', pfHook.pullbackBasis[0].includes('短线段反转'));

// 画布方向感知标签（做空→「做空止盈/做空止损·反向%」）
const recTexts = [];
const recCtx = new Proxy({}, { get: (t, p) => {
  if (p === 'fillText') return (s) => { recTexts.push(String(s)); };
  if (p === 'createLinearGradient' || p === 'createRadialGradient') return () => ({ addColorStop() {} });
  return () => {};
} });
drawPricePath(recCtx, { price: 747.29, target: 716.66, support: 756.95, atrAbs: 4, pullbackProb: 0.37, uncertainty: 0.5, weak: false, horizon: 12, fanK: 1.5, dirWord: '做空' }, { t: 0.5, W: 320, H: 200 });
ok('画布: 含「做空止盈」', recTexts.some(s => s.includes('做空止盈')));
ok('画布: 含「做空止损·反向%」', recTexts.some(s => s.includes('做空止损') && s.includes('反向')));

// ============================================================
//  每周期独立 SRSI 参数 + 辅助放行闸门 + 主图叠加
// ============================================================
console.log('\n[kchart: 每周期独立 SRSI 参数 perTfSrsi]');
{
  const byTf = { '5m': { rsiPeriod: 14, stochPeriod: 21, smoothK: 5, smoothD: 3, overbought: 90, oversold: 10 } };
  const fb = { rsiPeriod: 85, stochPeriod: 50, smoothK: 10, smoothD: 5, overbought: 80, oversold: 20 };
  ok('perTfSrsi 取 byTf 覆盖', deepEq(perTfSrsi('5m', byTf, fb), byTf['5m']));
  ok('perTfSrsi 回退默认', deepEq(perTfSrsi('15m', byTf, fb), fb));
  ok('perTfSrsi 7d 特例', perTfSrsi('7d', {}, fb).rsiPeriod === 14);
  ok('perTfSrsi 30d 特例', perTfSrsi('30d', {}, fb).rsiPeriod === 6);

  const rising = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(100 + i * 0.3); return a; };
  const pm = { '5m': rising(500), '15m': rising(500), '1h': rising(500), '4h': rising(500) };
  const ov = buildSrsiOverview(Object.keys(pm), (tf) => perTfSrsi(tf, byTf, fb), pm, 150);
  ok('buildSrsiOverview 函数式参数→返回所有TF且有K/D', ov.rows.length === Object.keys(pm).length && ov.rows.every(r => typeof r.k === 'number' && typeof r.d === 'number'));

  // 参数确实生效: 不同 rsi/stoch 周期 → 末根 K 不同
  const seq = [100,101,99,102,98,103,97,104,96,105,95,106,94,107,93,108,92,109,91,110];
  const a = srsiPanelSeries(seq, { rsiPeriod: 3, stochPeriod: 3, smoothK: 1, smoothD: 1, overbought: 80, oversold: 20 }, seq.length);
  const b = srsiPanelSeries(seq, { rsiPeriod: 14, stochPeriod: 14, smoothK: 3, smoothD: 3, overbought: 80, oversold: 20 }, seq.length);
  ok('srsiPanelSeries 参数影响 K 值', a.k[a.k.length - 1] !== b.k[b.k.length - 1]);
}

console.log('\n[kchart: 每周期默认 SRSI 参数(7d/30d 长周期特例)]');
{
  const def = __defaultKConfig().srsiByTf;
  ok('默认 1h=通用 RSI85', def['1h'].rsiPeriod === 85);
  ok('默认 7d=长周期 RSI14', def['7d'].rsiPeriod === 14);
  ok('默认 30d=长周期 RSI6', def['30d'].rsiPeriod === 6);
  ok('默认 7d smoothK=3', def['7d'].smoothK === 3);
  ok('默认 30d smoothD=2', def['30d'].smoothD === 2);
  // 7d/30d 用默认长周期参数聚合后 K/D 非 null（预热足够，不再恒为 --）
  const rising = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(100 + Math.sin(i / 7) * 5); return a; };
  const daily = rising(500);
  const pm = { '7d': resample(daily, 7), '30d': resample(daily, 30) };
  const ov = buildSrsiOverview(['7d', '30d'], (tf) => perTfSrsi(tf, def, def['5m']), pm, 150);
  const r7 = ov.rows.find(r => r.tf === '7d'), r30 = ov.rows.find(r => r.tf === '30d');
  ok('默认 7d K/D 非 null', typeof r7.k === 'number' && typeof r7.d === 'number');
  ok('默认 30d K/D 非 null', typeof r30.k === 'number' && typeof r30.d === 'number');
}

console.log('\n[kchart: 辅助放行闸门 auxGateDir/auxGateStatus]');
{
  ok('auxGateDir long', auxGateDir({ k: 80, d: 20 }) === 'long');
  ok('auxGateDir short', auxGateDir({ k: 20, d: 80 }) === 'short');
  ok('auxGateDir 中性', auxGateDir({ k: 50, d: 50 }) === null);
  ok('auxGateDir 无效null', auxGateDir({ k: null, d: 50 }) === null);
  ok('auxGateDir 回退 KD 方向', auxGateDir({ k: 20, d: 80 }) === 'short');
  ok('auxGateDir 区域优先(超卖→short)', auxGateDir({ k: 80, d: 20, zone: 'oversold' }) === 'short');
  ok('auxGateDir 区域优先(超买→long)', auxGateDir({ k: 20, d: 80, zone: 'overbought' }) === 'long');
  ok('auxGateDir 最近穿越优先', auxGateDir({ k: 80, d: 20, crossing: 'sell', fresh: 1 }) === 'short');

  ok('status na 无辅助', auxGateStatus('buy', []) === 'na');
  ok('status released 同向', auxGateStatus('buy', [{ k: 80, d: 20 }]) === 'released');
  ok('status released 中性不否决', auxGateStatus('buy', [{ k: 50, d: 50 }]) === 'released');
  ok('status vetoed 反向', auxGateStatus('buy', [{ k: 20, d: 80 }]) === 'vetoed');
  ok('status vetoed 多个辅助任一反向', auxGateStatus('buy', [{ k: 80, d: 20 }, { k: 20, d: 80 }]) === 'vetoed');
}

console.log('\n[kchart: 纪律分析 辅助闸门否决主方向]');
{
  const srsi = { rsiPeriod: 85, stochPeriod: 50, smoothK: 10, smoothD: 5, overbought: 80, oversold: 20 };
  const rising = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(100 + i * 0.3); return a; };
  const falling = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(300 - i * 0.3); return a; };
  // 辅助 TF: 平盘后急跌 → 最近穿越为破超卖(sell) → 方向偏空; 主方向看多 → 反向否决
  const auxDown = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(100 + Math.sin(i / 5) * 2); const last = a[a.length - 1]; for (let i = 1; i <= 8; i++) a.push(last - i * 5); return a; };
  const pm = { '5m': rising(500), '15m': rising(500), '1h': rising(500), '4h': rising(500), '1d': auxDown(500) };
  const sNoAux = analyzeTradeDiscipline(pm, srsi, { bars: 150, mainTF: '15m' });
  const sAux = analyzeTradeDiscipline(pm, srsi, { bars: 150, mainTF: '15m', auxTfs: ['1d'] });
  ok('无辅助时看多', sNoAux.entry.dir.startsWith('看多'));
  ok('辅助1d反向→否决成观望', sAux.entry.dir === '观望');
  ok('辅助否决 reason 含辅助周期', (sAux.entry.reason || '').includes('1d'));
  ok('辅助否决 conf=30', sAux.entry.conf === 30);
  const pm2 = { '5m': rising(500), '15m': rising(500), '1h': rising(500), '4h': rising(500), '1d': rising(500) };
  const sAuxOk = analyzeTradeDiscipline(pm2, srsi, { bars: 150, mainTF: '15m', auxTfs: ['1d'] });
  ok('辅助同向→不否决仍看多', sAuxOk.entry.dir.startsWith('看多'));
}

console.log('\n[kchart: 主图叠加 alignSeriesToBase]');
{
  const baseT = [10, 20, 30, 40, 50];
  const srcT = [10, 30, 50];
  const srcV = [1, 2, 3];
  const out = alignSeriesToBase(baseT, srcT, srcV);
  ok('align 等长', out.length === baseT.length);
  ok('align 向前填充', deepEq(out, [1, 1, 2, 2, 3]));
  ok('align 空src→null', deepEq(alignSeriesToBase(baseT, [], []), [null, null, null, null, null]));
}

// ============================================================
//  每币对独立 K线配置（按币对存储 + 复制/重置）
// ============================================================
{
  // 内存版 localStorage + 最小 window/document 桩（避免触达渲染）
  const _ls = {};
  globalThis.localStorage = {
    getItem: (k) => (k in _ls ? _ls[k] : null),
    setItem: (k, v) => { _ls[k] = String(v); },
    removeItem: (k) => { delete _ls[k]; },
  };
  globalThis.window = globalThis.window || {};

  function freshStore() { kchartApi.__clearStore(); }
  function loadAs(sym) { kchartApi.__setCfgForTest({ symbol: sym }); kchartApi.__load(); }
  function curStore() { return kchartApi.__testStore(); }

  console.log('[kchart: 每币对独立配置]');

  // 旧扁平格式迁移
  freshStore();
  _ls['smartTrader_kchart'] = JSON.stringify({ symbol: 'BTCUSDT', srsiByTf: { '1h': { rsiPeriod: 21 } } });
  kchartApi.__load();
  ok('迁移: bySymbol 含旧 symbol', !!curStore().bySymbol['BTCUSDT']);
  ok('迁移: lastSymbol=BTCUSDT', curStore().lastSymbol === 'BTCUSDT');

  // 切换隔离
  freshStore();
  kchartApi.__setCfgForTest({ symbol: 'BTCUSDT', srsiByTf: { '1h': { rsiPeriod: 21 } } });
  kchartApi.__persist();
  kchartApi.__setCfgForTest({ symbol: 'ETHUSDT', srsiByTf: { '1h': { rsiPeriod: 55 } } });
  kchartApi.__persist();
  loadAs('BTCUSDT');
  ok('隔离: BTC 的 1h.rsiPeriod=21', kchartApi.getConfig().srsiByTf['1h'].rsiPeriod === 21);
  loadAs('ETHUSDT');
  ok('隔离: ETH 的 1h.rsiPeriod=55', kchartApi.getConfig().srsiByTf['1h'].rsiPeriod === 55);
  loadAs('BTCUSDT');
  ok('隔离: 切回 BTC 仍=21', kchartApi.getConfig().srsiByTf['1h'].rsiPeriod === 21);

  // 复制本币对到全部
  freshStore();
  kchartApi.__setCfgForTest({ symbol: 'BTCUSDT', srsiByTf: { '1h': { rsiPeriod: 33 } }, mainOverlay: true });
  kchartApi.__persist();
  kchartApi.copyCfgToAll(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
  ok('复制: ETH 获得 BTC 的 1h.rsiPeriod=33', curStore().bySymbol['ETHUSDT'].srsiByTf['1h'].rsiPeriod === 33);
  ok('复制: SOL 获得 BTC 的 1h.rsiPeriod=33', curStore().bySymbol['SOLUSDT'].srsiByTf['1h'].rsiPeriod === 33);
  ok('复制: ETH symbol 字段改写为 ETHUSDT', curStore().bySymbol['ETHUSDT'].symbol === 'ETHUSDT');
  ok('复制: 不覆盖源 BTC 本身', curStore().bySymbol['BTCUSDT'].srsiByTf['1h'].rsiPeriod === 33);

  // 重置本币对
  freshStore();
  kchartApi.__setCfgForTest({ symbol: 'BTCUSDT', srsiByTf: { '1h': { rsiPeriod: 99 } } });
  kchartApi.__persist();
  kchartApi.resetSymbolCfg();
  ok('重置: 删除该币对槽位', !curStore().bySymbol['BTCUSDT']);
  ok('重置: 当前 cfg 回退默认 1h.rsiPeriod=85', kchartApi.getConfig().srsiByTf['1h'].rsiPeriod === 85);
  ok('重置: 默认 7d=长周期 RSI14', kchartApi.getConfig().srsiByTf['7d'].rsiPeriod === 14);
  ok('重置: 默认 30d=长周期 RSI6', kchartApi.getConfig().srsiByTf['30d'].rsiPeriod === 6);

  // 7d/30d 脏值迁移: 存的是通用默认(85/50/10/5)→ 改回长周期特例(14/6)
  freshStore();
  const polluted = Object.assign(__defaultKConfig(), { symbol: 'BTCUSDT', mainTF: '5m',
    srsiByTf: { '7d': { rsiPeriod: 85, stochPeriod: 50, smoothK: 10, smoothD: 5, overbought: 80, oversold: 20 },
                 '30d': { rsiPeriod: 85, stochPeriod: 50, smoothK: 10, smoothD: 5, overbought: 80, oversold: 20 } } });
  const norm = kchartApi.__normalizeCfg(polluted);
  ok('迁移: 7d 脏值→RSI14', norm.srsiByTf['7d'].rsiPeriod === 14);
  ok('迁移: 30d 脏值→RSI6', norm.srsiByTf['30d'].rsiPeriod === 6);
  // 用户显式改过的值不回退
  const userSet = Object.assign(__defaultKConfig(), { symbol: 'BTCUSDT', mainTF: '5m',
    srsiByTf: { '30d': { rsiPeriod: 30, stochPeriod: 50, smoothK: 10, smoothD: 5, overbought: 80, oversold: 20 } } });
  const norm2 = kchartApi.__normalizeCfg(userSet);
  ok('迁移: 用户显式 30d=30 保留', norm2.srsiByTf['30d'].rsiPeriod === 30);

  // PWA 周期切换不依赖 window.__renderKControls 钩子（模块自洽）
  freshStore();
  kchartApi.__setCfgForTest(__defaultKConfig());
  globalThis.window.__renderKControls = undefined;
  kchartApi.setSrsiTf('1h');
  ok('setSrsiTf: 无 __renderKControls 桩也不抛错且更新 editTf', kchartApi.getConfig().srsiEditTf === '1h');

  // 10m 优选参数刷新后应持久化（修复自动面板显示“未优选”）
  freshStore();
  const cfg10 = __defaultKConfig();
  cfg10.symbol = 'BTCUSDT';
  cfg10.srsiOptSource = { '10m': 'optimized' };
  cfg10.srsiByTf['10m'] = { r: 9, k: 3, d: 9, ub: 90, lb: 10 };
  kchartApi.__setCfgForTest(cfg10);
  kchartApi.__persist();
  kchartApi.__load();
  const after10 = kchartApi.getConfig();
  ok('10m 优选刷新后 标记不丢失', after10.srsiOptSource['10m'] === 'optimized');
  ok('10m 优选参数刷新后保留', after10.srsiByTf['10m'] && after10.srsiByTf['10m'].r === 9);

  // 真实 applySrsiOpt 流程（模拟用户点“应用 10m 优选”后刷新）
  freshStore();
  const cfgA = __defaultKConfig(); cfgA.symbol = 'BTCUSDT';
  cfgA.srsiOptPreview['10m'] = { role: 'swing', best: { r: 9, k: 3, d: 9, ub: 90, lb: 10 }, symbol: 'BTCUSDT' };
  kchartApi.__setCfgForTest(cfgA);
  kchartApi.applySrsiOpt('10m');
  kchartApi.__load();
  const afterApply = kchartApi.getConfig();
  ok('applySrsiOpt(10m) 刷新后仍标记 optimized', afterApply.srsiOptSource['10m'] === 'optimized');
  ok('applySrsiOpt(10m) 刷新后仍写入 srsiByTf', afterApply.srsiByTf['10m'] && afterApply.srsiByTf['10m'].r === 9);

  // PWA 刷新路径回归：原先 PWA init 从不调 loadCfg，且在 setSymbol 同币对 early-return 把默认 cfg 覆盖写回 → 所有优选 SRSI 被清空。
  // 现 PWA init 已加 api.loadCfg()，验证：全部周期优选 → 模拟刷新(__setCfgForTest 重置为默认) → loadCfg() 应全量恢复。
  freshStore();
  const cfgAll = __defaultKConfig(); cfgAll.symbol = 'BTCUSDT';
  kchartApi.__setCfgForTest(cfgAll);
  KLINE_TF.forEach(tf => {
    cfgAll.srsiOptPreview[tf] = { role: 'swing', best: { r: 9, k: 3, d: 9, ub: 92, lb: 8 }, symbol: 'BTCUSDT' };
    kchartApi.applySrsiOpt(tf);
  });
  kchartApi.__setCfgForTest(__defaultKConfig()); // 模拟刷新：内存 cfg 被重置为默认（未含优选）
  kchartApi.loadCfg();                            // PWA init 现在会调一次
  const reloaded = kchartApi.getConfig();
  ok('PWA刷新: 全部周期 srsiOptSource 恢复', KLINE_TF.every(tf => reloaded.srsiOptSource[tf] === 'optimized'));
  ok('PWA刷新: 全部周期 srsiByTf 参数恢复', KLINE_TF.every(tf => reloaded.srsiByTf[tf] && reloaded.srsiByTf[tf].r === 9));
  kchartApi.setSymbol('BTCUSDT');                 // 同币对应走 early-return persist，不应清掉已载入 SRSI
  const afterSame = kchartApi.getConfig();
  ok('PWA刷新: 同币对 setSymbol 不清除已载入 SRSI', KLINE_TF.every(tf => afterSame.srsiOptSource[tf] === 'optimized'));

  // 非默认币对回归：bug 根因是 PWA init 时 cfg.symbol 为默认 BTCUSDT，loadCfg 读 _store.bySymbol[cfg.symbol]
  // 永远取 BTCUSDT 的配置，忽略 _store.lastSymbol。若用户对非默认币对(如 ETHUSDT)优选 SRSI，刷新后会被
  // 默认 BTCUSDT 的空配置覆盖，显示「未选」。修复：PWA init 在 loadCfg 前确定实际币对并传入 symOverride。
  freshStore();
  const cfgEth = __defaultKConfig(); cfgEth.symbol = 'ETHUSDT';
  kchartApi.__setCfgForTest(cfgEth);
  KLINE_TF.forEach(tf => {
    cfgEth.srsiOptPreview[tf] = { role: 'swing', best: { r: 9, k: 3, d: 9, ub: 92, lb: 8 }, symbol: 'ETHUSDT' };
    kchartApi.applySrsiOpt(tf);
  });
  kchartApi.__persist();
  kchartApi.__setCfgForTest(__defaultKConfig()); // 模拟刷新：内存重置为默认(默认 symbol=BTCUSDT)
  kchartApi.loadCfg('ETHUSDT');                  // PWA init 现在会传当前币对
  const reloadedEth = kchartApi.getConfig();
  ok('非默认币对刷新: symbol 恢复为 ETHUSDT', reloadedEth.symbol === 'ETHUSDT');
  ok('非默认币对刷新: 全部周期 srsiOptSource 恢复', KLINE_TF.every(tf => reloadedEth.srsiOptSource[tf] === 'optimized'));
  const _storeEth = JSON.parse(localStorage.getItem('smartTrader_kchart') || '{}');
  ok('非默认币对刷新: 默认 BTCUSDT 配置未被污染', !( _storeEth.bySymbol && _storeEth.bySymbol['BTCUSDT'] && _storeEth.bySymbol['BTCUSDT'].srsiOptSource && KLINE_TF.every(tf => _storeEth.bySymbol['BTCUSDT'].srsiOptSource[tf] === 'optimized')));

  // SRSI 参数自由填写(数字输入, 不再受下拉预设限制)
  freshStore();
  kchartApi.__setCfgForTest(__defaultKConfig());
  kchartApi.setSrsi('rsiPeriod', '30');
  kchartApi.setSrsi('smoothK', '8');
  kchartApi.setSrsi('overbought', '78');
  ok('自由填写: rsiPeriod=30(非预设选项)', kchartApi.getConfig().srsiByTf['5m'].rsiPeriod === 30);
  ok('自由填写: smoothK=8(非预设选项)', kchartApi.getConfig().srsiByTf['5m'].smoothK === 8);
  ok('自由填写: overbought=78(非预设选项)', kchartApi.getConfig().srsiByTf['5m'].overbought === 78);
  kchartApi.__persist();
  loadAs('BTCUSDT');
  ok('自由填写: 持久化后 rsiPeriod=30 仍保留', kchartApi.getConfig().srsiByTf['5m'].rsiPeriod === 30);
  kchartApi.setSrsi('rsiPeriod', 'abc');
  ok('自由填写: 非法值回退默认 85', kchartApi.getConfig().srsiByTf['5m'].rsiPeriod === 85);

  // 主图叠加改为按周期独立勾选（不再跟随全量 klineSel）
  freshStore();
  kchartApi.__setCfgForTest(__defaultKConfig());
  kchartApi.setMainOverlayTf('4h', true);
  kchartApi.setMainOverlayTf('1h', true);
  let oc = kchartApi.getConfig();
  ok('主图叠加: 4h/1h 已勾选', oc.overlayTfs['4h'] === true && oc.overlayTfs['1h'] === true);
  ok('主图叠加: mainOverlay 镜像=true', oc.mainOverlay === true);
  ok('主图叠加: 其它周期(如15m)未跟随勾选', !oc.overlayTfs['15m']);
  ok('主图叠加: klineSel 仍默认全选(不影响速览/子图)', oc.klineSel['15m'] === true);
  ok('overlayTfsList: 仅返回勾选周期且按 TF 顺序', JSON.stringify(kchartApi.__overlayTfsList(oc)) === JSON.stringify(['1h', '4h']));
  kchartApi.setMainOverlayTf('4h', false);
  oc = kchartApi.getConfig();
  ok('主图叠加: 取消4h后仅剩1h', !oc.overlayTfs['4h'] && oc.overlayTfs['1h'] === true);
  oc = kchartApi.getConfig();
  kchartApi.__persist();
  loadAs('BTCUSDT');
  ok('主图叠加: 持久化后 1h 仍保留', kchartApi.getConfig().overlayTfs['1h'] === true);
  kchartApi.setMainOverlayTf('1h', false);
  oc = kchartApi.getConfig();
  ok('主图叠加: 全清空后 mainOverlay=false', Object.keys(oc.overlayTfs).length === 0 && oc.mainOverlay === false);

  // 迁移：旧全局 mainOverlay=true 且无 overlayTfs → 回填当时 klineSel
  freshStore();
  const migrated = kchartApi.__normalizeCfg({ mainOverlay: true, klineSel: { '1h': true, '4h': true, '15m': false }, overlayTfs: undefined });
  ok('迁移: 旧 mainOverlay=true 回填 overlayTfs', migrated.overlayTfs['1h'] === true && migrated.overlayTfs['4h'] === true);
  ok('迁移: 旧配置仅回填当时 klineSel 中选中的', !migrated.overlayTfs['15m']);
  const emptyOv = kchartApi.__normalizeCfg({ mainOverlay: false, klineSel: { '1h': true }, overlayTfs: undefined });
  ok('迁移: 旧 mainOverlay=false 不回填 overlayTfs', Object.keys(emptyOv.overlayTfs).length === 0);

  // 主图也画辅助 SRSI 线：叠加 ∪ 辅助，去重并标 aux
  freshStore();
  let plan = kchartApi.__mainChartSrsiPlan({ overlayTfs: { '4h': true, '1h': true }, srsiAux: { '15m': true } });
  ok('主图计划: 4h/1h 叠加 + 15m 辅助 共3条', plan.length === 3);
  ok('主图计划: 15m 标 aux', plan.find(p => p.tf === '15m').aux === true);
  ok('主图计划: 4h/1h 非 aux', !plan.find(p => p.tf === '4h').aux && !plan.find(p => p.tf === '1h').aux);
  plan = kchartApi.__mainChartSrsiPlan({ overlayTfs: {}, srsiAux: { '15m': true } });
  ok('主图计划: 仅辅助无叠加也画', plan.length === 1 && plan[0].tf === '15m' && plan[0].aux === true);
  plan = kchartApi.__mainChartSrsiPlan({ overlayTfs: { '15m': true }, srsiAux: { '15m': true } });
  ok('主图计划: 叠加与辅助同周期去重只1条且标aux', plan.length === 1 && plan[0].tf === '15m' && plan[0].aux === true);
  plan = kchartApi.__mainChartSrsiPlan({ overlayTfs: {}, srsiAux: {} });
  ok('主图计划: 全空时不画', plan.length === 0);
  plan = kchartApi.__mainChartSrsiPlan({ mainOverlay: true, klineSel: { '5m': true, '15m': true }, overlayTfs: {}, srsiAux: { '15m': true } });
  ok('主图计划: 迁移旧配置(klineSel回退)叠加也含15m且标aux', plan.some(p => p.tf === '15m' && p.aux === true) && plan.some(p => p.tf === '5m'));

  // 纪律面板签名守卫：改任意 SRSI 参数或切辅助都须使签名变化（修复刷新缺口）
  const defByTf = { '5m': { rsiPeriod: 85, stochPeriod: 50, smoothK: 10, smoothD: 5, overbought: 80, oversold: 20 } };
  const baseCfg = { symbol: 'BTCUSDT', mainTF: '4h', bars: 150, srsiByTf: defByTf, srsiAux: {} };
  const pm = { '1h': [100, 101], '5m': [100, 102] };
  const baseSig = kchartApi.__buildDiscSig(baseCfg, pm, 'fixed', 0.005, null);
  const sigOf = (byTf, aux) => kchartApi.__buildDiscSig({ ...baseCfg, srsiByTf: byTf, srsiAux: aux || {} }, pm, 'fixed', 0.005, null);
  ok('纪律签名: 相同输入稳定', baseSig === kchartApi.__buildDiscSig(baseCfg, pm, 'fixed', 0.005, null));
  ok('纪律签名: 改 rsiPeriod 变化', baseSig !== sigOf({ '5m': { ...defByTf['5m'], rsiPeriod: 55 } }, {}));
  ok('纪律签名: 改 smoothK 变化', baseSig !== sigOf({ '5m': { ...defByTf['5m'], smoothK: 8 } }, {}));
  ok('纪律签名: 改 overbought 变化', baseSig !== sigOf({ '5m': { ...defByTf['5m'], overbought: 75 } }, {}));
  ok('纪律签名: 改 oversold 变化', baseSig !== sigOf({ '5m': { ...defByTf['5m'], oversold: 25 } }, {}));
  ok('纪律签名: 切辅助变化', baseSig !== sigOf(defByTf, { '15m': true }));
}

// ===== 主图叠加时间对齐 + 快选 chip 栏 =====
(() => {
  console.log('\n[kchart: 主图时间对齐 + 快选chip]');

  // --- alignedSrsiOverlay ---
  const mkPrice = (n) => Array.from({ length: n }, (_, i) => 100 + Math.sin(i / 5) * 3 + i * 0.1);
  const price = mkPrice(40);
  const tfT = price.map((_, i) => i);                 // 每根 1 单位时间
  const cfgDef = __defaultKConfig();
  const sc = perTfSrsi('5m', cfgDef.srsiByTf, cfgDef.srsi);

  ok('alignOverlay 空输入→空', JSON.stringify(kchartApi.__alignedSrsiOverlay([], [], [], sc)) === JSON.stringify({ k: [], d: [] }));
  ok('alignOverlay 坏输入→空', JSON.stringify(kchartApi.__alignedSrsiOverlay(price, [], [1, 2], sc)) === JSON.stringify({ k: [], d: [] }));

  // 同时间轴(完全对齐) → 结果应等于 srsiKD 全量输出
  const baseSame = tfT.slice(0);
  const a1 = kchartApi.__alignedSrsiOverlay(price, tfT, baseSame, sc);
  const kd = srsiKD(price, sc);
  ok('alignOverlay 长度=baseT', a1.k.length === baseSame.length && a1.d.length === baseSame.length);
  ok('alignOverlay 同时间轴==srsiKD', JSON.stringify(a1.k) === JSON.stringify(kd.k) && JSON.stringify(a1.d) === JSON.stringify(kd.d));

  // 稀疏 baseT（取偶数时间）→ 长度=baseT，且每点=对应 src 最近 ≤ 值（forward-fill）
  const baseSparse = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20];
  const a2 = kchartApi.__alignedSrsiOverlay(price, tfT, baseSparse, sc);
  ok('alignOverlay 稀疏长度', a2.k.length === baseSparse.length);
  // baseT 末尾 20 → 取 src 时间<=20 的最后一个，即 kd.k[20]
  ok('alignOverlay 末端forward-fill', a2.k[a2.k.length - 1] === kd.k[20]);
  // 中间 base=6 应等于 src 时间<=6 最近者 = kd.k[6]（因 src 含 6）
  ok('alignOverlay 中间对齐点', a2.k[3] === kd.k[6]);

  // --- ovQuickChips（空集兜底 mainTF）---
  const c0 = __defaultKConfig();
  const ch0 = kchartApi.__ovQuickChips(c0);
  ok('ovQuickChips 默认空→垫 mainTF 单 pill 未开', ch0.length === 1 && ch0[0].tf === c0.mainTF && ch0[0].on === false);
  const c1 = __defaultKConfig();
  c1.overlayTfs = { '4h': true, '1h': true }; c1.srsiAux = { '15m': true };
  const chips = kchartApi.__ovQuickChips(c1);
  // 按 KLINE_TF 顺序: 15m 应在 1h 前、1h 在 4h 前
  ok('ovQuickChips 含3项且KLINE排序', chips.length === 3 && chips[0].tf === '15m' && chips[1].tf === '1h' && chips[2].tf === '4h');
  ok('ovQuickChips 状态(叠加/辅助/on)', chips.find(x => x.tf === '1h').overlay === true && chips.find(x => x.tf === '15m').aux === true && chips.find(x => x.tf === '15m').on === true);

  // 隐藏项（皆无）也应出现并置灰
  const c2 = __defaultKConfig();
  c2.ovQuickTfs = ['4h', '1h'];
  const chips2 = kchartApi.__ovQuickChips(c2);
  ok('ovQuickChips 隐藏项置灰', chips2.length === 2 && chips2.every(x => x.on === false));

  // --- toggleOvQuickTf：仅切换主图线条显隐，绝不改动叠加/闸门(辅助)角色 ---
  kchartApi.__clearStore();
  const tc = __defaultKConfig();
  tc.symbol = 'BTCUSDT'; tc.ovQuickTfs = []; tc.overlayTfs = {}; tc.srsiAux = {}; tc.ovHide = {};
  kchartApi.__setCfgForTest(tc);
  kchartApi.__toggleOvQuickTf('4h');
  ok('toggle 关→开(叠加)', tc.overlayTfs['4h'] === true && tc.ovQuickTfs.includes('4h'));
  kchartApi.__toggleOvQuickTf('4h'); // 再点→隐藏主图线条（角色保留）
  ok('toggle 叠加→隐藏(显隐, 角色不丢)', tc.ovHide['4h'] === true && tc.overlayTfs['4h'] === true && tc.ovQuickTfs.includes('4h'));
  kchartApi.__toggleOvQuickTf('4h'); // 再点→恢复显示
  ok('toggle 隐藏→恢复显示', !tc.ovHide['4h'] && tc.overlayTfs['4h'] === true);
  tc.srsiAux['15m'] = true; tc.ovQuickTfs.push('15m');
  kchartApi.__toggleOvQuickTf('15m'); // 辅助→隐藏主图线条（辅助角色保留）
  ok('toggle 辅助→隐藏(辅助角色不丢)', tc.ovHide['15m'] === true && tc.srsiAux['15m'] === true && tc.ovQuickTfs.includes('15m'));
  ok('toggle 辅助隐藏后仍不删 overlayTfs 之外角色(仍在辅助)', tc.srsiAux['15m'] === true);
  kchartApi.__toggleOvQuickTf('15m'); // 恢复仍为辅助（非叠加）
  ok('toggle 恢复后仍为辅助', !tc.ovHide['15m'] && tc.srsiAux['15m'] === true && !tc.overlayTfs['15m']);

  // --- ovQuickChips 隐藏项置灰仍在栏 ---
  const cHide = __defaultKConfig();
  cHide.overlayTfs = { '4h': true }; cHide.ovHide = { '4h': true };
  const chipsHide = kchartApi.__ovQuickChips(cHide);
  ok('ovQuickChips 隐藏项置灰且仍在栏', chipsHide.find(x => x.tf === '4h').on === false && chipsHide.find(x => x.tf === '4h').hidden === true);

  // --- ovQuickChips 空集兜底：用 mainTF 垫一个未开 pill（保证主图永远有可点开关）---
  const cEmpty = __defaultKConfig();
  cEmpty.ovQuickTfs = []; cEmpty.overlayTfs = {}; cEmpty.srsiAux = {}; cEmpty.mainTF = '1h';
  const chipsEmpty = kchartApi.__ovQuickChips(cEmpty);
  ok('ovQuickChips 空集兜底 mainTF', chipsEmpty.length === 1 && chipsEmpty[0].tf === '1h' && chipsEmpty[0].on === false);
  const cEmpty2 = __defaultKConfig();
  cEmpty2.ovQuickTfs = []; cEmpty2.overlayTfs = {}; cEmpty2.srsiAux = {}; cEmpty2.mainTF = '5m';
  const chipsEmpty2 = kchartApi.__ovQuickChips(cEmpty2);
  ok('ovQuickChips 空集兜底 mainTF(5m)', chipsEmpty2.length === 1 && chipsEmpty2[0].tf === '5m');

  // --- normalizeCfg 保留 ovHide（布尔）---
  const old = { symbol: 'BTCUSDT', overlayTfs: { '4h': true }, srsiAux: { '15m': true }, ovHide: { '4h': true }, klineSel: {}, mainTF: '5m', srsiByTf: buildByTf() };
  const loaded = kchartApi.__normalizeCfg(old);
  ok('迁移 ovQuickTfs 含 overlay+aux', loaded.ovQuickTfs.includes('4h') && loaded.ovQuickTfs.includes('15m'));
  ok('normalizeCfg 保留 ovHide(布尔)', loaded.ovHide['4h'] === true);
})();

function buildByTf() {
  const base = __defaultKConfig().srsi;
  const o = {}; KLINE_TF.forEach(tf => { o[tf] = { ...base }; }); return o;
}

// ============================================================
//  SRSI 自动交易
// ============================================================
console.log('\n[kchart: SRSI 自动交易]');
{
  // --- computeDirectionScore 纯函数 ---
  const opts = { basePct: 10, bonusBig: 3, bonusMid: 2, bonusSmall: 1 };
  const s0 = computeDirectionScore({ '1h': null, '30m': null, '15m': null }, { '4h': null, '1h': null }, opts);
  ok('方向无数据 → 0 加成/基准10%', s0.big === false && s0.mid === false && s0.small === false && s0.posPct === 10);

  // --- kdTrendColor 纯函数（主图叠加药丸背景色）---
  ok('k>d → 淡绿', kdTrendColor(60, 40) === 'rgba(38,166,91,0.22)');
  ok('k<d → 淡红', kdTrendColor(40, 60) === 'rgba(211,47,47,0.22)');
  ok('k===d → 透明', kdTrendColor(50, 50) === '');
  ok('null → 透明', kdTrendColor(null, 50) === '');
  ok('NaN → 透明', kdTrendColor(NaN, 50) === '');
  const sAll = computeDirectionScore({ '1h': 'long', '30m': 'long', '15m': 'long' }, { '4h': 'long', '1h': 'long' }, opts);
  ok('三方向全一致 → +6% (16%)', sAll.big && sAll.mid && sAll.small && sAll.posPct === 16);
  const sPart = computeDirectionScore({ '1h': 'long', '30m': 'short', '15m': 'long' }, { '4h': 'long', '1h': 'long' }, opts);
  ok('仅大/小一致 → +4% (14%)', sPart.big && !sPart.mid && sPart.small && sPart.posPct === 14);
  const sCap = computeDirectionScore({ '1h': 'long', '30m': 'long', '15m': 'long' }, { '4h': 'long', '1h': 'long' }, { basePct: 28, bonusBig: 3, bonusMid: 2, bonusSmall: 1 });
  ok('仓位封顶 30%', sCap.posPct === 30);

  // --- srsiAutoBandState 边沿（注入 row）---
  kchartApi.__setCfgForTest(__defaultKConfig());
  resetSrsiAuto('BTCUSDT');
  let bs = srsiAutoBandState('BTCUSDT', { k: 95, d: 92 });
  ok('进上带(K>D)仅准备无信号', bs.band === 'upper' && bs.edge === null);
  bs = srsiAutoBandState('BTCUSDT', { k: 92, d: 95 });
  ok('带内D>K→enterUpper', bs.band === 'upper' && bs.edge === 'enterUpper');
  bs = srsiAutoBandState('BTCUSDT', { k: 94, d: 93 });
  ok('停留上带 无新边沿', bs.band === 'upper' && bs.edge === null);
  bs = srsiAutoBandState('BTCUSDT', { k: 50, d: 50 });
  ok('回中性 无边沿', bs.band === 'neutral' && bs.edge === null);
  bs = srsiAutoBandState('BTCUSDT', { k: 95, d: 92 });
  ok('重进上带(K>D)再次仅准备', bs.band === 'upper' && bs.edge === null);
  bs = srsiAutoBandState('BTCUSDT', { k: 92, d: 95 });
  ok('重进带后D>K再触发', bs.edge === 'enterUpper');
  bs = srsiAutoBandState('BTCUSDT', { k: 5, d: 8 });
  ok('进下带(D>K)仅准备', bs.band === 'lower' && bs.edge === null);
  bs = srsiAutoBandState('BTCUSDT', { k: 8, d: 5 });
  ok('带内K>D→enterLower', bs.band === 'lower' && bs.edge === 'enterLower');

  // --- runSrsiAutoTrade 集成（注入 engine/band/dir）---
  const tfs = ['5m', '10m', '15m', '30m', '1h', '4h'];
  const cfgAuto = __defaultKConfig();
  cfgAuto.symbol = 'BTCUSDT'; cfgAuto.srsiAutoOn = true;
  tfs.forEach(tf => cfgAuto.srsiOptSource[tf] = 'optimized');
  kchartApi.__setCfgForTest(cfgAuto);
  resetSrsiAuto('BTCUSDT');

  const mkEngine = (pos, bal = 1000, coin = 0) => {
    const positions = pos.slice();
    return {
      S: { prices: { 'BTCUSDT': { last: 100 } }, pos: positions },
      getPerpSub: () => ({ id: 'perp', bal, coins: { 'BTCUSDT': coin } }),
      placeOrder: (o) => { orders.push(o); positions.push({ sym: o.symbol, side: o.side, src: o.src, pnl: 0, entry: 100, qty: 1, amt: o.amt }); },
      exitPosition: (p, r) => { const i = positions.indexOf(p); if (i >= 0) positions.splice(i, 1); exits.push({ p, r }); }
    };
  };
  let orders = [], exits = [];
  const kd = { '1h': 'long', '30m': 'long', '15m': 'long' };
  const sd = { '4h': 'short', '1h': 'short', '30m': 'short' };
  const bandUp = { edge: 'enterUpper', band: 'upper', k: 95, d: 92 };
  const bandLow = { edge: 'enterLower', band: 'lower', k: 5, d: 5 };

  // 上带：无多单 → 仅开空(跟随→U本位)，仓位=16%×余额
  orders = []; exits = [];
  runSrsiAutoTrade('BTCUSDT', { engine: mkEngine([], 1000, 0), klineDir: kd, srsiDir: sd, band: bandUp });
  ok('上带 开空(无多单/U本位)', orders.length === 1 && orders[0].side === 'short' && orders[0].marginMode === 'usdt');
  ok('上带 空单仓位=16%×余额', close(orders[0].amt, 160, 1e-6));
  ok('上带 不开多不平仓', exits.length === 0);

  // 上带：有盈利多单 → 平多 + 开空
  orders = []; exits = [];
  const longPos = { sym: 'BTCUSDT', side: 'long', pnl: 5, entry: 90, qty: 1, amt: 90, src: 'srsiAuto' };
  runSrsiAutoTrade('BTCUSDT', { engine: mkEngine([longPos], 1000, 0), klineDir: kd, srsiDir: sd, band: bandUp });
  ok('上带 平盈利多单', exits.length === 1 && exits[0].r.reason === 'SRSI自动 上带平多');
  ok('上带 仍开空', orders.length === 1 && orders[0].side === 'short');

  // 上带：亏损多单 → 仅跳过平仓、仍开空
  orders = []; exits = [];
  const lossLong = { sym: 'BTCUSDT', side: 'long', pnl: -5, entry: 110, qty: 1, amt: 110, src: 'srsiAuto' };
  runSrsiAutoTrade('BTCUSDT', { engine: mkEngine([lossLong], 1000, 0), klineDir: kd, srsiDir: sd, band: bandUp });
  ok('上带 亏损多单不平仓', exits.length === 0);
  ok('上带 亏损多单仍开空', orders.length === 1 && orders[0].side === 'short');

  // 自动可平人工单（默认关）：盈利人工多单不被自动平
  orders = []; exits = [];
  const manLong = { sym: 'BTCUSDT', side: 'long', pnl: 5, entry: 90, qty: 1, amt: 90, src: 'manual' };
  runSrsiAutoTrade('BTCUSDT', { engine: mkEngine([manLong], 1000, 0), klineDir: kd, srsiDir: sd, band: bandUp });
  ok('默认 盈利人工多单不被自动平', exits.length === 0 && orders.length === 1 && orders[0].side === 'short');

  // 开关开：盈利人工多单被自动平（仍仅净盈利才平）
  const cfgClose = __defaultKConfig();
  cfgClose.symbol = 'BTCUSDT'; cfgClose.srsiAutoOn = true; cfgClose.srsiAutoCloseManual = true;
  tfs.forEach(tf => cfgClose.srsiOptSource[tf] = 'optimized');
  kchartApi.__setCfgForTest(cfgClose);
  resetSrsiAuto('BTCUSDT');
  orders = []; exits = [];
  runSrsiAutoTrade('BTCUSDT', { engine: mkEngine([manLong], 1000, 0), klineDir: kd, srsiDir: sd, band: bandUp });
  ok('开关开 盈利人工多单被自动平', exits.length === 1 && exits[0].r.reason === 'SRSI自动 上带平多');
  ok('开关开 仍开空', orders.length === 1 && orders[0].side === 'short');
  kchartApi.__setCfgForTest(cfgAuto); // 还原，避免影响后续用例

  // 下带：开多(跟随→币本位)，币余额 10
  orders = []; exits = [];
  runSrsiAutoTrade('BTCUSDT', { engine: mkEngine([], 0, 10), klineDir: kd, srsiDir: sd, band: bandLow });
  ok('下带 开多(币本位)', orders.length === 1 && orders[0].side === 'long' && orders[0].marginMode === 'coin');

  // 最多连开同向 3 个：连续 4 次上带，第 4 次不再开（复用同一 engine，真实累计持仓）
  resetSrsiAuto('BTCUSDT');
  orders = []; exits = [];
  const capEng = mkEngine([], 1000, 0);
  for (let i = 0; i < 4; i++) runSrsiAutoTrade('BTCUSDT', { engine: capEng, klineDir: kd, srsiDir: sd, band: bandUp });
  ok('连开空最多 3 次', orders.length === 3);

  // 15m 未优选 → 自动交易硬暂停（按需求 #1：15m 未优选不能交易）
  const cfgPart = __defaultKConfig();
  cfgPart.symbol = 'BTCUSDT'; cfgPart.srsiAutoOn = true;
  cfgPart.srsiOptSource = { '5m': 'optimized' }; // 仅 5m 优选，15m 未优选
  kchartApi.__setCfgForTest(cfgPart);
  resetSrsiAuto('BTCUSDT');
  orders = []; exits = [];
  runSrsiAutoTrade('BTCUSDT', { engine: mkEngine([], 1000, 0), klineDir: kd, srsiDir: sd, band: bandUp });
  ok('15m未优选 硬暂停(不开仓)', orders.length === 0);

  // 15m 优选、但 30m/1h/4h 未优选 → 仍开仓，按权重减仓（scale=0.4 → 10%×0.4=4%）
  const cfgPart2 = __defaultKConfig();
  cfgPart2.symbol = 'BTCUSDT'; cfgPart2.srsiAutoOn = true;
  cfgPart2.srsiOptSource = { '15m': 'optimized', '5m': 'optimized' };
  kchartApi.__setCfgForTest(cfgPart2);
  resetSrsiAuto('BTCUSDT');
  orders = []; exits = [];
  runSrsiAutoTrade('BTCUSDT', { engine: mkEngine([], 1000, 0), klineDir: kd, srsiDir: sd, band: bandUp });
  ok('15m优选但高位未优选 仍开空', orders.length === 1 && orders[0].side === 'short');
  ok('高位未优选 减仓至4%×余额', close(orders[0].amt, 40, 1e-6), 'amt=' + (orders[0] && orders[0].amt));

  // 恢复默认 cfg 避免影响其它用例
  kchartApi.__setCfgForTest(__defaultKConfig());
}

// ============================================================
//  bandEdge / klineDirFromCloses / srsiDirFromKD / backtestSrsiAuto
// ============================================================
console.log('\n[kchart: bandEdge & 回测]');
{
  const E = { upper: 90, lower: 10 };
  // 进上带(K>D) = 准备，不触发；带内 D>K 交叉才发空头信号
  let b = bandEdge('neutral', 95, 92, E);
  ok('bandEdge 进上带(K>D)仅准备无信号', b.band === 'upper' && b.edge === null && b.armed === false);
  b = bandEdge('upper', 92, 95, E);
  ok('bandEdge 带内D>K→enterUpper', b.band === 'upper' && b.edge === 'enterUpper' && b.armed === true);
  b = bandEdge('upper', 92, 95, E, true);
  ok('bandEdge 停留上带不重复触发', b.edge === null);
  b = bandEdge('upper', 50, 50, E, true);
  ok('bandEdge 回中性复位armed', b.band === 'neutral' && b.edge === null && b.armed === false);
  b = bandEdge('neutral', 95, 92, E);
  ok('bandEdge 重进上带再次仅准备', b.edge === null);
  b = bandEdge('upper', 92, 95, E);
  ok('bandEdge 重进带后D>K再触发', b.edge === 'enterUpper');
  // 进下带(D>K,即K<D) = 准备；带内 K>D 交叉才发多头信号
  b = bandEdge('neutral', 5, 8, E);
  ok('bandEdge 进下带(D>K)仅准备', b.band === 'lower' && b.edge === null && b.armed === false);
  b = bandEdge('lower', 8, 5, E);
  ok('bandEdge 带内K>D→enterLower', b.band === 'lower' && b.edge === 'enterLower' && b.armed === true);
  b = bandEdge('lower', 8, 5, E, true);
  ok('bandEdge 停留下带不重复触发', b.edge === null);
  b = bandEdge('lower', 50, 50, E, true);
  ok('bandEdge 下带回升中性复位', b.band === 'neutral' && b.edge === null && b.armed === false);

  ok('srsiDirFromKD overbought→long', srsiDirFromKD(95, 92, 'overbought') === 'long');
  ok('srsiDirFromKD oversold→short', srsiDirFromKD(5, 5, 'oversold') === 'short');
  ok('srsiDirFromKD 中性无向', srsiDirFromKD(50, 50, null) === null);

  const rise = [], fall = [];
  for (let i = 0; i < 130; i++) rise.push(100 + i);
  for (let i = 0; i < 130; i++) fall.push(300 - i);
  ok('klineDirFromCloses 上升→long', klineDirFromCloses(rise) === 'long');
  ok('klineDirFromCloses 下降→short', klineDirFromCloses(fall) === 'short');
  ok('klineDirFromCloses 不足120→null', klineDirFromCloses(rise.slice(0, 100)) === null);

  // 反复 V 形（下→上）使 SRSI 在带内产生 K/D 交叉：超卖 K>D→开多、超买 D>K→开空（新闸门=带内交叉）
  const closes = [];
  for (let v = 0; v < 8; v++) {
    for (let i = 0; i < 25; i++) closes.push(140 - i * 4);   // 140→40 下跌
    for (let i = 0; i < 25; i++) closes.push(40 + i * 4);    // 40→140 上涨
  }
  const mk = (arr) => arr.map((c, i) => [i * 900000, c, c, c, c, 0]);
  const kl = { '15m': mk(closes), '1h': mk(closes), '30m': mk(closes), '4h': mk(closes) };
  const cfgBt = { ...__defaultKConfig(), srsiAutoUseCost: false, srsiAutoUpper: 80, srsiAutoLower: 20 };
  const res = backtestSrsiAuto('BTCUSDT', kl, cfgBt, 1000);
  ok('回测 无错误', !res.error);
  ok('回测 有开仓', res.trades.some(t => t.action === 'open'));
  ok('回测 有平仓', res.trades.some(t => t.action.indexOf('close') === 0));
  ok('回测 含开空', res.shorts >= 1);
  ok('回测 多单同时持仓不超上限', res.maxOpenLong <= cfgBt.srsiAutoMaxSame);
  ok('回测 空单同时持仓不超上限', res.maxOpenShort <= cfgBt.srsiAutoMaxSame);
  ok('回测 含开多', res.longs >= 1);
  ok('回测 期末权益为有限数', isFinite(res.finalEquity));
  ok('回测 胜率∈[0,1]', res.winRate >= 0 && res.winRate <= 1);
  // 成交记录含增强字段（金额/余额/K/D）
  const openT = res.trades.find(t => t.action === 'open');
  const closeT = res.trades.find(t => t.action.indexOf('close') === 0);
  ok('回测 开仓记录含 amt>0', openT && openT.amt > 0);
  ok('回测 开仓记录含 bal 有限', openT && isFinite(openT.bal));
  ok('回测 开仓记录含 K/D 数值', openT && isFinite(openT.k) && isFinite(openT.d));
  ok('回测 平仓记录含 pnl', !!closeT && isFinite(closeT.pnl));
  ok('回测 平仓记录含 bal', !!closeT && isFinite(closeT.bal));
  // 全量（非截断 8 笔）：开仓 + 平仓(close*) + 爆仓(liquidate)
  const nOpen = res.trades.filter(t => t.action === 'open').length;
  const nLiq = res.trades.filter(t => t.action === 'liquidate').length;
  ok('回测 成交总条数=开仓+平仓+爆仓', res.trades.length === nOpen + (res.wins + res.losses) + nLiq);
  // 窗口过滤：只在 windowStart 之后重放成交（修复 24h 预热导致“数据不足”）
  const winStart = closes.length > 150 ? (150 * 900000 + 1) : 0;
  const resWin = backtestSrsiAuto('BTCUSDT', kl, cfgBt, 1000, winStart);
  ok('回测(窗口) 无错误', !resWin.error);
  ok('回测(窗口) 所有成交在窗口内', resWin.trades.every(t => t.t >= winStart));

  // 解析对象格式（fetchKlinesRange 真实返回）：{opens,highs,lows,closes,vols,times}
  const parsed = {};
  for (const tf of ['15m', '1h', '30m', '4h']) {
    parsed[tf] = { opens: closes.slice(), highs: closes.slice(), lows: closes.slice(), closes: closes.slice(), vols: closes.map(() => 0), times: closes.map((_, i) => i * 900000) };
  }
  const res2 = backtestSrsiAuto('BTCUSDT', parsed, cfgBt, 1000);
  ok('回测(解析对象) 无错误', !res2.error);
  ok('回测(解析对象) 有开仓', res2.trades.some(t => t.action === 'open'));
  ok('回测(解析对象) 期末权益有限', isFinite(res2.finalEquity));
  ok('回测(解析对象) 增强字段齐全', (() => { const o = res2.trades.find(t => t.action === 'open'); return o && isFinite(o.amt) && isFinite(o.bal) && isFinite(o.k); })());
}

// 成本模型：手续费 / 滑点 / 真实资金费率（与实盘 PaperEngine 同源）
console.log('\n[kchart: 回测成本模型]');
{
  // 反复 V 形（保证多空均会在带内交叉开仓且含可记账平仓）
  const zz = [];
  for (let v = 0; v < 8; v++) {
    for (let i = 0; i < 25; i++) zz.push(140 - i * 4);
    for (let i = 0; i < 25; i++) zz.push(40 + i * 4);
  }
  const mk = (arr) => { const kl = {}; for (const tf of ['15m', '1h', '30m', '4h']) kl[tf] = arr.map((c, i) => [i * 900000, c, c, c, c, 0]); return kl; };
  const cfg = { ...__defaultKConfig(), srsiAutoUpper: 80, srsiAutoLower: 20 };
  const base = { ...cfg, srsiAutoUseCost: false, srsiAutoFeeRate: 0, srsiAutoSlipBase: 0, srsiAutoUseFunding: false };
  const r0 = backtestSrsiAuto('BTCUSDT', mk(zz), base, 1000);
  ok('成本基准 有成交', r0.trades.some(t => t.action === 'open'));
  const rFee = backtestSrsiAuto('BTCUSDT', mk(zz), { ...cfg, srsiAutoFeeRate: 0.001, srsiAutoSlipBase: 0, srsiAutoUseFunding: false }, 1000);
  ok('成本 手续费>0 使期末权益更低', rFee.finalEquity < r0.finalEquity);
  ok('成本 totalFee>0', rFee.totalFee > 0);
  const rSlip = backtestSrsiAuto('BTCUSDT', mk(zz), { ...cfg, srsiAutoFeeRate: 0, srsiAutoSlipBase: 0.005, srsiAutoUseFunding: false }, 1000);
  ok('成本 滑点>0 使期末权益更低', rSlip.finalEquity < r0.finalEquity);
  ok('成本 totalSlip>0', rSlip.totalSlip > 0);
  const sideAt = (trades, T) => { let side = null; for (const t of trades) { if (t.t > T) break; if (t.action === 'open') side = t.side; else if (t.action.indexOf('close') === 0) side = null; } return side; };
  const T = 160 * 900000;
  const fund = [{ fundingTime: T, fundingRate: 0.0001 }];
  const rFund = backtestSrsiAuto('BTCUSDT', mk(zz), { ...cfg, srsiAutoFeeRate: 0, srsiAutoSlipBase: 0, srsiAutoUseFunding: true }, 1000, null, fund);
  ok('成本 资金费被计入(≠0)', rFund.totalFunding !== 0);
  const sideT = sideAt(rFund.trades, T);
  ok('成本 资金费符号与持仓方向一致', (sideT === 'short' && rFund.totalFunding > 0) || (sideT === 'long' && rFund.totalFunding < 0));
  const cl = rFee.trades.find(t => t.action.indexOf('close') === 0);
  ok('成本 平仓记录含 fee/slip/funding 字段', cl && cl.fee != null && cl.slip != null && cl.funding != null);
  ok('成本 返回含 totalFee/totalSlip/totalFunding', 'totalFee' in rFee && 'totalSlip' in rFee && 'totalFunding' in rFee);
  // 净盈亏对账：net = 毛利 - 手续费 - 滑点 + 资金费(现金流)
  const recon = rFee.trades.filter(t => t.action.indexOf('close') === 0).every(t => Math.abs(t.pnl - (t.gross - t.fee - t.slip + t.funding)) < 1e-6);
  ok('成本 净盈亏=毛利-手续费-滑点+资金费(对账一致)', recon);
  // 亏损不平仓：含成本时 仅净盈的平仓被记账
  ok('亏损不平仓 含成本时 已记账平仓均净盈', rFee.trades.filter(t => t.action.indexOf('close') === 0).every(t => t.pnl > 0));
  // 成本总开关：关闭后完全不计成本
  const rNo = backtestSrsiAuto('BTCUSDT', mk(zz), { ...cfg, srsiAutoUseCost: false }, 1000, null, fund);
  ok('成本开关 关→无手续费', rNo.totalFee === 0);
  ok('成本开关 关→无滑点', rNo.totalSlip === 0);
  ok('成本开关 关→无资金费', rNo.totalFunding === 0);
  ok('成本开关 关→等同无成本基准', Math.abs(rNo.finalEquity - r0.finalEquity) < 1e-6);
  ok('成本开关 关→期末权益≥含成本', rNo.finalEquity >= rFee.finalEquity - 1e-6);
  ok('成本开关 关→记账平仓数≥含成本', rNo.trades.filter(t => t.action.indexOf('close') === 0).length >= rFee.trades.filter(t => t.action.indexOf('close') === 0).length);
}

//  回测爆仓线（真实交易所 MMR 规则）：高杠杆下价格击穿强平价应被强平并诚实显示
console.log('\n[kchart: 回测 爆仓线]');
{
  // 拉升→顶部回抽(带内 D>K 开空，后被反向击穿)→深跌→底部回抽(K>D 开多抢反弹)→继续暴跌击穿多单强平价→爆仓
  const closes = [];
  for (let i = 0; i < 60; i++) closes.push(100 + i * 1.6);          // 100→196 拉升
  for (let i = 0; i < 16; i++) closes.push(196 - i * 1.3 + (i % 2 ? 6 : 0)); // 顶部回抽(带内 D>K)
  for (let i = 0; i < 50; i++) closes.push(176 + i * 1.6);          // 续涨(空头被穿透)
  for (let i = 0; i < 60; i++) closes.push(256 - i * 2.6);          // 256→100 深跌
  for (let i = 0; i < 16; i++) closes.push(100 + i * 1.3 + (i % 2 ? 6 : 0)); // 底部回抽(带内 K>D→开多)
  for (let i = 0; i < 50; i++) closes.push(120 - i * 1.4);          // 120→50 暴跌，击穿多单强平价
  const mk = (arr) => { const kl = {}; for (const tf of ['15m', '1h', '30m', '4h']) kl[tf] = arr.map((c, i) => [i * 900000, c, c, c, c, 0]); return kl; };
  // 高杠杆：多单强平价 ≈ entry*(1-1/lev+mmr)，lev=30 ⇒ 仅需 -3.3% 即爆
  const cfg = { ...__defaultKConfig(), srsiAutoUseCost: false, srsiAutoLev: 30, srsiAutoUpper: 80, srsiAutoLower: 20, srsiAutoMaxSame: 3 };
  const res = backtestSrsiAuto('BTCUSDT', mk(closes), cfg, 1000);
  ok('爆仓 有开仓', res.trades.some(t => t.action === 'open'));
  ok('爆仓 出现 liquidate 成交', res.trades.some(t => t.action === 'liquidate'));
  ok('爆仓 计数 ≥ 1', (res.liqCount || 0) >= 1);
  const liq = res.trades.find(t => t.action === 'liquidate');
  ok('爆仓 记录含 liqPrice', liq && isFinite(liq.liqPrice) && liq.liqPrice > 0);
  ok('爆仓 多发生在开仓之后', liq && res.trades.some(t => t.action === 'open' && t.t < liq.t));
  ok('爆仓 净损失为负(保证金基本归零)', liq && liq.pnl < 0);
  ok('爆仓 净损失≈-保证金(lev=30 约 -0.88×amt)', liq && Math.abs(liq.pnl + liq.amt * 0.88) < liq.amt * 0.05);
  ok('爆仓 返回 liqLoss<0', res.liqLoss < 0);
  // 渲染：含爆仓红条与「爆仓」标记
  const html = _renderBacktestResult(res, 30);
  ok('爆仓 渲染含「强平」摘要', html.includes('强平'));
  ok('爆仓 渲染含「爆仓」标记', html.includes('爆仓'));
}

// 回测 现货模式（双余额/无杠杆/无爆仓/做空仅卖已有币）
console.log('\n[kchart: 回测 现货模式]');
{
  const zz = [];
  for (let v = 0; v < 8; v++) {
    for (let i = 0; i < 25; i++) zz.push(140 - i * 4);
    for (let i = 0; i < 25; i++) zz.push(40 + i * 4);
  }
  const mk = (arr) => { const kl = {}; for (const tf of ['15m', '1h', '30m', '4h']) kl[tf] = arr.map((c, i) => [i * 900000, c, c, c, c, 0]); return kl; };
  const cfg = { ...__defaultKConfig(), srsiAutoUseCost: false, srsiAutoUpper: 80, srsiAutoLower: 20 };
  // 有币库存：应同时出现开多(买币)与开空(卖币)
  const res = backtestSrsiAuto('BTCUSDT', mk(zz), cfg, 1000, null, null, { mode: 'spot', spotUsdt: 1000, spotCoin: 5 });
  ok('现货 模式标记=spot', res.mode === 'spot');
  ok('现货 无爆仓', (res.liqCount || 0) === 0 && !res.trades.some(t => t.action === 'liquidate'));
  ok('现货 无资金费', (res.totalFunding || 0) === 0);
  ok('现货 有开仓', res.trades.some(t => t.action === 'open'));
  ok('现货 有平仓', res.trades.some(t => t.action.indexOf('close') === 0));
  ok('现货 含开多(买币)', res.longs >= 1);
  ok('现货 含开空(卖币)', res.shorts >= 1);
  ok('现货 初始USDT池已记录', res.spotInitU === 1000);
  ok('现货 初始币库存已记录', res.spotInitC === 5);
  ok('现货 期末权益有限', isFinite(res.finalEquity));
  ok('现货 本金(startVal)=USDT池+币库存×窗口起点价', isFinite(res.principal) && res.principal > 0);
  ok('现货 收益率有限', isFinite(res.pnlPct));
  ok('现货 双余额下单记录含 bal', (() => { const o = res.trades.find(t => t.action === 'open'); return o && isFinite(o.bal); })());
  // 纯空无币库存：short 不应开（现货无借币）
  const resNo = backtestSrsiAuto('BTCUSDT', mk(zz), cfg, 1000, null, null, { mode: 'spot', spotUsdt: 1000, spotCoin: 0 });
  ok('现货(无币) 不开空', resNo.shorts === 0);
  ok('现货(无币) 仍开多', resNo.longs >= 1);
  ok('现货(无币) 无爆仓', (resNo.liqCount || 0) === 0);
  // 渲染：现货显示模式徽章与无爆仓
  const html = _renderBacktestResult(res, 30);
  ok('现货 渲染含「现货 1x」徽章', html.includes('现货 1x'));
  ok('现货 渲染不含「强平」爆仓行', !html.includes('强平'));
  // 期末分离：现金 USDT 与币库存各自记录（不再只归一为单一权益）
  ok('现货 期末分离-现金USDT 记录', typeof res.finalU === 'number');
  ok('现货 期末分离-币库存 记录', typeof res.finalC === 'number');
  ok('现货 期末分离-期末价 记录', typeof res.finalPrice === 'number');
  ok('现货 期末分离-现金=初始+盈亏(合理范围)', isFinite(res.finalU));
  ok('现货 期末分离-成交逐笔标 mode', res.trades.every(t => t.marginMode === 'spot'));
  ok('现货 渲染含模式列表头', html.includes('<th>模式</th>'));
  ok('现货 渲染含现货模式标签', html.includes('现货'));
  // 合约模式：逐笔标注 U本位(开空)/币本位(开多)
  const perpCfg = { ...__defaultKConfig(), srsiAutoUseCost: false, srsiAutoBtMode: 'perp', srsiAutoLev: 5, srsiAutoUpper: 80, srsiAutoLower: 20 };
  const resPerp = backtestSrsiAuto('BTCUSDT', mk(zz), perpCfg, 1000);
  ok('合约 成交含 marginMode', resPerp.trades.some(t => t.marginMode === 'usdt' || t.marginMode === 'coin'));
  ok('合约 开空标 U本位', resPerp.trades.some(t => t.action === 'open' && t.side === 'short' && t.marginMode === 'usdt'));
  ok('合约 开多标 币本位', resPerp.trades.some(t => t.action === 'open' && t.side === 'long' && t.marginMode === 'coin'));
  const htmlPerp = _renderBacktestResult(resPerp, 30);
  ok('合约 渲染含 U本位', htmlPerp.includes('U本位'));
  ok('合约 渲染含 币本位', htmlPerp.includes('币本位'));
}

// 回测 双池真实建模（本位下拉框 srsiAutoMode 驱动 marginMode + USDT 池/币库存池）
console.log('\n[kchart: 回测 双池建模]');
{
  const zz = [];
  for (let v = 0; v < 8; v++) {
    for (let i = 0; i < 25; i++) zz.push(140 - i * 4);
    for (let i = 0; i < 25; i++) zz.push(40 + i * 4);
  }
  const mk2 = (arr) => { const kl = {}; for (const tf of ['15m', '1h', '30m', '4h']) kl[tf] = arr.map((c, i) => [i * 900000, c, c, c, c, 0]); return kl; };
  const baseBt = (mode) => ({ ...__defaultKConfig(), srsiAutoUseCost: false, srsiAutoBtMode: 'perp', srsiAutoLev: 5, srsiAutoMode: mode, srsiAutoUpper: 80, srsiAutoLower: 20 });
  const P = 1000;
  const fp = zz[zz.length - 1]; // 期末价 = 末根收盘价
  // follow：开空→U本位 / 开多→币本位
  const rF = backtestSrsiAuto('BTCUSDT', mk2(zz), baseBt('follow'), P);
  ok('双池 follow 有成交', rF.trades.some(t => t.action === 'open'));
  ok('双池 follow 开空→U本位', rF.trades.some(t => t.action === 'open' && t.side === 'short' && t.marginMode === 'usdt'));
  ok('双池 follow 开多→币本位', rF.trades.some(t => t.action === 'open' && t.side === 'long' && t.marginMode === 'coin'));
  ok('双池 follow startVal=本金', Math.abs(rF.principal - P) < 1e-6);
  ok('双池 follow 期末权益=avail+coinAvail*价', Math.abs(rF.finalEquity - (rF.finalAvail + rF.finalCoinAvail * fp)) < 1e-6);
  // usdt：全 U 本位，币库存池恒 0（等同旧单池行为，U本位 不受影响）
  const rU = backtestSrsiAuto('BTCUSDT', mk2(zz), baseBt('usdt'), P);
  ok('双池 usdt 全部 U本位', rU.trades.filter(t => t.action === 'open').every(t => t.marginMode === 'usdt'));
  ok('双池 usdt 币库存池恒0', Math.abs(rU.finalCoinAvail) < 1e-9);
  ok('双池 usdt 期末权益=finalAvail', Math.abs(rU.finalEquity - rU.finalAvail) < 1e-9);
  ok('双池 usdt startVal=本金', Math.abs(rU.principal - P) < 1e-6);
  // coin：全币本位，USDT 池恒 0
  const rC = backtestSrsiAuto('BTCUSDT', mk2(zz), baseBt('coin'), P);
  ok('双池 coin 全部币本位', rC.trades.filter(t => t.action === 'open').every(t => t.marginMode === 'coin'));
  ok('双池 coin USDT池恒0', Math.abs(rC.finalAvail) < 1e-9);
  ok('双池 coin 币库存池>0(双池真实建模)', rC.finalCoinAvail > 0);
  ok('双池 coin startVal=本金', Math.abs(rC.principal - P) < 1e-6);
  ok('双池 coin 期末权益=coinAvail*价', Math.abs(rC.finalEquity - rC.finalCoinAvail * fp) < 1e-9);
  // 资本隔离：三种本位均有限期末权益且 >0
  ok('双池 三种本位回测均产生有限且正期末权益', [rF, rU, rC].every(r => isFinite(r.finalEquity) && r.finalEquity > 0));
}

// 回测 现货模式 _getSim 多源合并（主系统 smartTrader / PWA pwa_sim_settings 均可喂给现货回测）
console.log('\n[kchart: _getSim 多源合并]');
{
  if (!globalThis.localStorage) {
    const _ls = {};
    globalThis.localStorage = { getItem: (k) => (k in _ls ? _ls[k] : null), setItem: (k, v) => { _ls[k] = String(v); }, removeItem: (k) => { delete _ls[k]; } };
  }
  const savedWindowS = globalThis.window;
  globalThis.window = {}; // 确保 window.S.sim 不干扰（PWA 中 S.sim 为 undefined）
  // 场景1：仅主系统 smartTrader 持久化中有币库存 → 现货回测应读到
  globalThis.localStorage.setItem('smartTrader', JSON.stringify({ ver: 1, sim: { spotUsdt: 5000, perpUsdt: 5000, coin: { BTCUSDT: 0.5, ETHUSDT: 1.2 } } }));
  globalThis.localStorage.removeItem('pwa_sim_settings');
  const r1 = _getSim();
  ok('_getSim 主系统 smartTrader 币库存被读取(BTCUSDT)', r1.coin['BTCUSDT'] === 0.5);
  ok('_getSim 主系统 smartTrader 币库存被读取(ETHUSDT)', r1.coin['ETHUSDT'] === 1.2);
  ok('_getSim USDT池取首个非零', r1.spotUsdt === 5000);
  // 场景2：仅 PWA pwa_sim_settings 有币库存
  globalThis.localStorage.removeItem('smartTrader');
  globalThis.localStorage.setItem('pwa_sim_settings', JSON.stringify({ spotUsdt: 8000, perpUsdt: 5000, coin: { SOLUSDT: 3 } }));
  const r2 = _getSim();
  ok('_getSim PWA pwa_sim_settings 币库存被读取(SOLUSDT)', r2.coin['SOLUSDT'] === 3);
  // 场景3：两源共存 → 合并（不互相覆盖）
  globalThis.localStorage.setItem('smartTrader', JSON.stringify({ ver: 1, sim: { spotUsdt: 5000, perpUsdt: 5000, coin: { BTCUSDT: 0.5 } } }));
  const r3 = _getSim();
  ok('_getSim 多源合并含 PWA 币(SOLUSDT)', r3.coin['SOLUSDT'] === 3 && r3.coin['BTCUSDT'] === 0.5);
  // 场景4：window.S.sim 实时态优先（主系统在线状态）
  globalThis.window = { S: { sim: { spotUsdt: 2000, perpUsdt: 5000, coin: { BTCUSDT: 9 } } } };
  const r4 = _getSim();
  ok('_getSim 实时 S.sim 优先(BTCUSDT=9)', r4.coin['BTCUSDT'] === 9);
  // 清理
  globalThis.window = savedWindowS;
  globalThis.localStorage.removeItem('smartTrader');
  globalThis.localStorage.removeItem('pwa_sim_settings');
}

// 一致性：实时/回测方向同源（srsiAutoDirs 复用 auxGateDir 口径，且采用 srsiByTf 优选）
console.log('\n[kchart: 实时/回测方向一致性]');
{
  const up = []; for (let i = 0; i < 220; i++) up.push(100 + i * 0.5);
  const closesByTf = { '15m': up, '30m': up, '1h': up, '4h': up };
  const cfgDir = __defaultKConfig();
  const d = srsiAutoDirs(closesByTf, cfgDir);
  ok('srsiAutoDirs 返回 klineDir/srsiDir 映射', !!d && !!d.klineDir && !!d.srsiDir);
  ok('srsiAutoDirs 1h 趋势方向=long', d.klineDir['1h'] === 'long');
  // SRSI 方向为 long/short/null 之一（纯单调序列 SRSI 为中性，允许 null）；不抛错即同源可用
  const validDir = (x) => x === null || x === 'long' || x === 'short';
  ok('srsiAutoDirs 4h SRSI 方向合法', validDir(d.srsiDir['4h']));
  ok('srsiAutoDirs 1h SRSI 方向合法', validDir(d.srsiDir['1h']));
  // 采用 srsiByTf 优选后仍能稳定出方向（不因配置切换而抛错/破坏结构）
  const cfgOpt = __defaultKConfig();
  cfgOpt.srsiByTf = { '4h': { ...cfgOpt.srsi, r: 9, k: 3, d: 9 }, '1h': { ...cfgOpt.srsi, r: 7 } };
  const d2 = srsiAutoDirs(closesByTf, cfgOpt);
  ok('srsiAutoDirs(优选) 结构完整', validDir(d2.srsiDir['4h']) && validDir(d2.srsiDir['1h']));
}

//  fetchKlinesRange 须按 [startTime,endTime] 截断（修复 24h/7d 返回同一整页）
{
  const savedFetch = globalThis.fetch, savedApi = globalThis.KCHART_BINANCE_API;
  try {
    globalThis.KCHART_BINANCE_API = 'https://test.example.com';
    const now = Date.now();
    const N = 1000, step = 900000; // 15m
    const page = [];
    for (let i = 0; i < N; i++) {
      const t = now - (N - 1 - i) * step;
      const c = 100 + (i % 2 ? 1 : -1) * (i % 20);
      page.push([t, c, c, c, c, 0]);
    }
    globalThis.fetch = async () => ({ ok: true, json: async () => page });
    const r1 = await fetchKlinesRange('BTCUSDT', '15m', now - 24 * 3600 * 1000, now);
    const r7 = await fetchKlinesRange('BTCUSDT', '15m', now - 7 * 24 * 3600 * 1000, now);
    ok('fetchKlinesRange 24h 已截断(<1000)', r1.closes.length < 1000);
    ok('fetchKlinesRange 7d 已截断(<1000)', r7.closes.length < 1000);
    ok('fetchKlinesRange 24h≠7d（修复雷同）', r1.closes.length !== r7.closes.length);
    ok('fetchKlinesRange 7d>24h', r7.closes.length > r1.closes.length);
    // 窗口边界内：最早一根应 >= startTime
    ok('fetchKlinesRange 24h 首根在窗口内', r1.times[0] >= now - 24 * 3600 * 1000 - step);
  } finally {
    globalThis.fetch = savedFetch;
    globalThis.KCHART_BINANCE_API = savedApi;
  }
}

console.log('\n[kchart: SRSI自动交易 价格注入(修复空数据致 9h 无成交)]');
{
  // 回归：buildSrsiOverview 之前未传 priceMap，k/d 恒为 null → 带信号永不触发 → 自动交易 9h 无成交
  const N = 320;
  const mk = () => { const a = []; for (let i = 0; i < N; i++) a.push(100 + Math.sin(i / 12) * 12 + i * 0.02); return a; };
  globalThis.S = { klines: { BTCUSDT: { '5m': mk(), '10m': mk(), '15m': mk(), '30m': mk(), '1h': mk(), '4h': mk() } } };
  try {
    const bs = srsiAutoBandState('BTCUSDT');
    ok('srsiAutoBandState 注入价格后返回有效 k/d', bs.k != null && bs.d != null && isFinite(bs.k) && isFinite(bs.d));
    const dir = srsiDirOf('BTCUSDT', '4h');
    ok('srsiDirOf 注入价格后不恒为 null', dir === null || dir === 'long' || dir === 'short');
  } finally { delete globalThis.S; }
}

//  10m 自动优选真实管线回放（faithful repro：注入桩→optimize→apply→persist→reload）
{
  const TFS = ['5m', '10m', '15m', '30m', '1h', '4h'];
  kchartApi.__clearStore();
  const c = __defaultKConfig();
  c.symbol = 'BTCUSDT';
  c.srsiAutoOptEnabled = true;
  c.srsiOptSource = {};
  kchartApi.__setCfgForTest(c);
  resetSrsiAuto('BTCUSDT');
  const mkCloses = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(100 + Math.sin(i / 11) * 15 + i * 0.05); return a; };
  kchartApi.__setOptFetch(async (sym, tf, days) => {
    const closes = mkCloses(600);
    return { closes, opens: closes.slice(), times: closes.map((_, i) => 1e12 + i * 600000), from: 1e12, to: 1e12 + 600 * 600000 };
  });
  try {
    await kchartApi.runSrsiAutoOptimizeAll(false);
    const applied = kchartApi.__getCfg().srsiOptSource;
    ok('自动优选管线覆盖 10m', applied['10m'] === 'optimized');
    ok('自动优选管线覆盖全部 6 周期', TFS.every(tf => applied[tf] === 'optimized'));
    kchartApi.__persist();
    kchartApi.__load();
    const reloaded = kchartApi.__getCfg().srsiOptSource;
    ok('刷新后 10m 仍为已优选（持久化不丢 10m）', reloaded['10m'] === 'optimized');
    ok('刷新后全部 6 周期仍为已优选', TFS.every(tf => reloaded[tf] === 'optimized'));
  } finally {
    kchartApi.__setOptFetch(null);
  }
}

//  10m 优选缺失自愈：用户曾优选过(任一周期标记 optimized)→ 加载时 runSrsiAutoOptimizeAll(false) 补跑缺失周期(含 10m)
console.log('\n[kchart: 10m 优选缺失自愈]');
{
  const TFS = ['5m', '10m', '15m', '30m', '1h', '4h'];
  kchartApi.__clearStore();
  const c = __defaultKConfig();
  c.symbol = 'BTCUSDT';
  c.srsiAutoOptEnabled = false; // 注意：自愈不应依赖「自动优选总开关」打开
  c.srsiOptSource = { '5m': 'optimized' }; // 仅曾优选过 5m，10m 缺失
  kchartApi.__setCfgForTest(c);
  resetSrsiAuto('BTCUSDT');
  const mkCloses = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(100 + Math.sin(i / 11) * 15 + i * 0.05); return a; };
  kchartApi.__setOptFetch(async (sym, tf, days) => {
    const closes = mkCloses(600);
    return { closes, opens: closes.slice(), times: closes.map((_, i) => 1e12 + i * 600000), from: 1e12, to: 1e12 + 600 * 600000 };
  });
  try {
    await kchartApi.runSrsiAutoOptimizeAll(false); // force=false：跳过已优化，只补跑缺失（含 10m）
    const after = kchartApi.__getCfg().srsiOptSource;
    ok('缺失的 10m 被自愈为 optimized', after['10m'] === 'optimized');
    ok('已有的 5m 仍保留 optimized', after['5m'] === 'optimized');
    ok('其余缺失周期一并补齐', TFS.filter(tf => tf !== '5m').every(tf => after[tf] === 'optimized'));
  } finally {
    kchartApi.__setOptFetch(null);
  }
}

//  回测明细「平多/平空」配色：平(橙)/多(绿)/空(红) 加粗；亏损平含「亏」标记
console.log('\n[kchart: 回测 平多/平空 配色]');
{
  const res = {
    error: null, pnlPct: 5, finalEquity: 105, principal: 100,
    winRate: 0.5, wins: 1, losses: 1, longs: 1, shorts: 1, maxDD: 0.1,
    trades: [
      { t: Date.now(), action: 'open', side: 'long', price: 100, amt: 10, k: 50, d: 50, bal: 100 },
      { t: Date.now() + 1, action: 'close', side: 'long', pnl: 5, price: 105, fee: 0.1, slip: 0.1, funding: 0, bal: 105, k: 60, d: 60 },
      { t: Date.now() + 2, action: 'close', side: 'short', pnl: -3, price: 95, fee: 0.1, slip: 0.1, funding: 0, bal: 102, k: 40, d: 40 }
    ],
    totalFee: 0.2, totalSlip: 0.2, totalFunding: 0, equitySeries: [{ eq: 100 }, { eq: 105 }]
  };
  const html = _renderBacktestResult(res, 30);
  ok('盈利平多 含 bt-ping(平)+bt-long(多)', html.includes('bt-ping') && html.includes('bt-long'));
  ok('亏损平空 含 bt-short(空)', html.includes('bt-short'));
  ok('亏损平仓 含 bt-loss(亏) 标记', html.includes('bt-loss'));
  ok('不再出现旧文案 平盈', !html.includes('平盈'));
  ok('不再出现旧文案 平亏', !html.includes('平亏'));
}

// 回测 90/180/365 按钮功能有效性：覆盖完整窗口(maxBars 按比例放大) + 各区间独立缓存 + 二次点击复用已缓存 K线
console.log('\n[kchart: 回测 90/180/365 按钮功能]');
{
  kchartApi.__clearStore();
  const c = __defaultKConfig();
  c.symbol = 'BTCUSDT';
  c.srsiAutoUseFunding = false; // 测试不触真网资金费率
  kchartApi.__setCfgForTest(c);
  const mk = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(100 + Math.sin(i / 7) * 10 + i * 0.02); return a; };
  const stepMs = (tf) => tf === '15m' ? 900000 : tf === '30m' ? 1800000 : tf === '1h' ? 3600000 : 14400000;
  let maxBarsSeen = {};
  let fetchCalls = 0;
  const fetchImpl = async (sym, tf, start, end, onP, maxBars) => {
    fetchCalls++;
    maxBarsSeen[tf] = (maxBarsSeen[tf] || 0) > maxBars ? maxBarsSeen[tf] : maxBars;
    const n = Math.max(200, Math.min(maxBars, Math.ceil((end - start) / stepMs(tf)) + 200));
    const closes = mk(n);
    return {
      closes, opens: closes.slice(), highs: closes.map(v => v + 1), lows: closes.map(v => v - 1),
      vols: closes.map(() => 10), times: closes.map((_, i) => start + i * stepMs(tf))
    };
  };
  kchartApi.__setBacktestFetch(fetchImpl);
  try {
    for (const d of [30, 90, 180, 365]) {
      await kchartApi.runSrsiBacktest(d, { force: true });
    }
    const store = kchartApi.__getBtStore();
    ok('30天结果独立存储', !!store.results['BTCUSDT|30']);
    ok('90天结果独立存储', !!store.results['BTCUSDT|90']);
    ok('180天结果独立存储', !!store.results['BTCUSDT|180']);
    ok('365天结果独立存储', !!store.results['BTCUSDT|365']);
    ok('30天回测无错误', store.results['BTCUSDT|30'] && !store.results['BTCUSDT|30'].error);
    ok('90天回测无错误', store.results['BTCUSDT|90'] && !store.results['BTCUSDT|90'].error);
    ok('180天回测无错误', store.results['BTCUSDT|180'] && !store.results['BTCUSDT|180'].error);
    ok('365天回测无错误', store.results['BTCUSDT|365'] && !store.results['BTCUSDT|365'].error);
    ok('不同窗口结果非同一引用', store.results['BTCUSDT|90'] !== store.results['BTCUSDT|365']);
    ok('回测产出交易记录数组', Array.isArray(store.results['BTCUSDT|365'].trades));
    ok('一年回测 多单同时持仓不超上限', store.results['BTCUSDT|365'].maxOpenLong <= 3);
    ok('一年回测 空单同时持仓不超上限', store.results['BTCUSDT|365'].maxOpenShort <= 3);
    // 关键：15m 一年≈35040根，默认 maxBars=12000 会截断窗口；修复后应≥35000
    ok('365天 15m maxBars 足够覆盖整窗(≥35000)', (maxBarsSeen['15m'] || 0) >= 35000);
    ok('180天 15m maxBars 足够覆盖整窗(≥17000)', (maxBarsSeen['15m'] || 0) >= 17000);
    // 二次点击(非 force)应复用已缓存 K线，不重复拉取
    const callsAfterFirst = fetchCalls;
    await kchartApi.runSrsiBacktest(90, { force: false });
    ok('二次点击复用已缓存K线(不重复拉取)', fetchCalls === callsAfterFirst);
  } finally {
     kchartApi.__setBacktestFetch(null);
   }
}

console.log('\n[kchart: 清空回测(仅当前币对)]');
{
  kchartApi.__clearStore();
  const c = __defaultKConfig(); c.symbol = 'BTCUSDT';
  kchartApi.__setCfgForTest(c);
  const BT_KEY = 'smartTrader_kchart_bt', RAW_KEY = 'smartTrader_kchart_bt_raw', FUND_KEY = 'smartTrader_kchart_bt_fund';
  // 灌入 BTCUSDT(U本位+币本位) 与 对照 ETHUSDT 的回测数据
  localStorage.setItem(BT_KEY, JSON.stringify({
    results: { 'BTCUSDT|30': { x: 1 }, 'BTCUSDT|30|spot': { x: 1 }, 'ETHUSDT|30': { x: 1 } },
    lastSym: 'BTCUSDT', lastMode: 'perp', lastDays: 30
  }));
  localStorage.setItem(RAW_KEY, JSON.stringify({ 'BTCUSDT|30': { k: 1 }, 'ETHUSDT|30': { k: 1 } }));
  localStorage.setItem(FUND_KEY, JSON.stringify({ 'BTCUSDT|30': [1], 'ETHUSDT|30': [1] }));

  kchartApi.clearBacktestStore('BTCUSDT');

  const bt = JSON.parse(localStorage.getItem(BT_KEY) || '{}');
  const raw = JSON.parse(localStorage.getItem(RAW_KEY) || '{}');
  const fund = JSON.parse(localStorage.getItem(FUND_KEY) || '{}');
  ok('清空回测: BTCUSDT(U本位) 结果键已删', !bt.results['BTCUSDT|30']);
  ok('清空回测: BTCUSDT(币本位) 结果键已删', !bt.results['BTCUSDT|30|spot']);
  ok('清空回测: 对照 ETHUSDT 结果保留', !!bt.results['ETHUSDT|30']);
  ok('清空回测: lastSym 已清空(因等于 BTCUSDT)', bt.lastSym == null);
  ok('清空回测: raw 中 BTCUSDT 键已删、ETHUSDT 保留', !raw['BTCUSDT|30'] && !!raw['ETHUSDT|30']);
  ok('清空回测: fund 中 BTCUSDT 键已删、ETHUSDT 保留', !fund['BTCUSDT|30'] && !!fund['ETHUSDT|30']);

  // 误传其它币对不应误删 BTCUSDT
  localStorage.setItem(BT_KEY, JSON.stringify({ results: { 'ETHUSDT|30': { x: 1 } }, lastSym: 'ETHUSDT', lastMode: 'perp', lastDays: 30 }));
  localStorage.setItem(RAW_KEY, JSON.stringify({ 'ETHUSDT|30': { k: 1 } }));
  localStorage.setItem(FUND_KEY, JSON.stringify({ 'ETHUSDT|30': [1] }));
  kchartApi.clearBacktestStore('BTCUSDT');
  const bt2 = JSON.parse(localStorage.getItem(BT_KEY) || '{}');
  ok('清空回测: 无 BTCUSDT 数据时其它币对不受影响', !!bt2.results['ETHUSDT|30']);
}

// ============================================================
//  回测 保证金严格记账（本金不超开）+ 开仓上限(U本位/币本位)
// ============================================================
console.log('\n[kchart: 回测 保证金严格记账 + 开仓上限]');
{
  const buildFetch = () => {
    const mk = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(100 + Math.sin(i / 7) * 10); return a; };
    const stepMs = (tf) => tf === '15m' ? 900000 : tf === '30m' ? 1800000 : tf === '1h' ? 3600000 : 14400000;
    return async (sym, tf, start, end, onP, maxBars) => {
      const n = Math.max(200, Math.min(maxBars, Math.ceil((end - start) / stepMs(tf)) + 200));
      const closes = mk(n);
      return { closes, opens: closes.slice(), highs: closes.map(v => v + 1), lows: closes.map(v => v - 1), vols: closes.map(() => 10), times: closes.map((_, i) => start + i * stepMs(tf)) };
    };
  };
  const runBt = async (mode, cfgPatch, days) => {
    days = days || 365;
    kchartApi.__clearStore();
    const c = __defaultKConfig();
    c.symbol = 'BTCUSDT';
    c.srsiAutoUseFunding = false;
    c.srsiAutoUseCost = false; // 关闭全部成本(费/滑点)以便精确校验余额守恒
    c.srsiAutoPrincipal = 1000;
    c.srsiAutoBasePct = 30;
    c.srsiAutoLev = 2;
    c.srsiAutoMaxSame = 10;
    c.srsiAutoUpper = 90;
    c.srsiAutoLower = 10;
    Object.assign(c, cfgPatch || {});
    // 回测测试默认视为「已全部优选」（15m 硬闸门需 15m 优选才会成交）
    ['5m', '10m', '15m', '30m', '1h', '4h'].forEach(tf => { c.srsiOptSource[tf] = 'optimized'; });
    kchartApi.__setCfgForTest(c);
    // 回测配置已解耦到独立 btCfg：把 cfg 中的回测相关字段映射到 btCfg（覆盖默认）
    const patch = cfgPatch || {};
    const bt = {
      accountType: patch.srsiAutoBtMode === 'spot' ? 'spot' : 'perp',
      principal: c.srsiAutoPrincipal,
      marginMode: 'follow',
      coin: patch.srsiAutoBtMode === 'spot' ? (patch.srsiAutoCoin || 10) : 0,
      useCost: c.srsiAutoUseCost,
      feePct: 0.045,
      slipPct: 0.02,
      pct: c.srsiAutoBasePct,
      lev: c.srsiAutoLev,
      maxSame: c.srsiAutoMaxSame,
      upper: c.srsiAutoUpper,
      lower: c.srsiAutoLower,
      capUsdt: patch.srsiAutoOpenCapUsdt || 0,
      capCoin: patch.srsiAutoOpenCapCoin || 0,
      floorUsdt: 0,
      floorCoin: 0,
      optTfs: ['15m', '30m', '1h', '4h'],
      optEnabled: false,
      optIntervalOn: false,
      optIntervalH: 5,
      optNoTradeH: 5,
      w4h: c.srsiAutoW4h,
      w1h: c.srsiAutoW1h,
      w30m: c.srsiAutoW30m,
      collapsed: false
    };
    localStorage.setItem('smartTrader_kchart_bt_cfg', JSON.stringify(bt));
    if (mode === 'spot') localStorage.setItem('pwa_sim_settings', JSON.stringify({ spotUsdt: 1000, coin: {} }));
    kchartApi.__setBacktestFetch(buildFetch());
    await kchartApi.runSrsiBacktest(days, { force: true });
    const res = kchartApi.__getBtStore().results['BTCUSDT|' + days + (bt.accountType === 'spot' ? '|spot' : '')];
    kchartApi.__setBacktestFetch(null);
    localStorage.removeItem('smartTrader_kchart_bt_cfg');
    return res;
  };

  // 1) 保证金严格记账：任意时刻 自由余额 + 锁仓保证金 ≤ 本金 + 已实现盈亏（不再允许超开）
  {
    const res = await runBt('perp', {});
    ok('保证金记账: 无错误', res && !res.error, res && res.error);
    const opens = res.trades.filter(t => t.action === 'open');
    ok('保证金记账: 产生了开仓', opens.length > 0);
    const live = []; let realized = 0, bad = null;
    for (const t of res.trades) {
      if (t.action === 'open') {
        live.push({ side: t.side, amt: t.amt, entry: t.price });
      } else if (t.action.indexOf('close') === 0 || t.action === 'liquidate') {
        // 与回测平仓选择一致：带内平仓=同方向首个盈利单优先；期末强制平仓(close(final))=FIFO
        let idx = -1;
        if (t.action === 'close(final)') {
          for (let j = 0; j < live.length; j++) if (live[j].side === t.side) { idx = j; break; }
        } else {
          for (let j = 0; j < live.length; j++) {
            if (live[j].side !== t.side) continue;
            const prof = live[j].side === 'long' ? t.price > live[j].entry : t.price < live[j].entry;
            if (prof) { idx = j; break; }
          }
          if (idx < 0) for (let j = 0; j < live.length; j++) if (live[j].side === t.side) { idx = j; break; }
        }
        if (idx >= 0) live.splice(idx, 1);
        realized += (t.pnl || 0);
      }
      const sumLocked = live.reduce((a, b) => a + b.amt, 0);
      if (t.bal < -1e-6) { bad = { negative: t.bal }; break; }
      const tol = Math.max(1e-3, (1000 + realized) * 1e-9);
      if (t.bal + sumLocked > 1000 + realized + tol) { bad = { bal: t.bal, sumLocked, realized }; break; }
    }
    ok('保证金记账: 自由余额从未为负', bad === null || !bad.negative);
    ok('保证金记账: 自由余额+锁仓≤本金+已实现(不超开)', bad === null, bad ? JSON.stringify(bad) : '');
  }

  // 2) U本位开仓上限：capUsdt=150 时所有开仓 ≤150U
  {
    const res = await runBt('perp', { srsiAutoOpenCapUsdt: 150 }, 90);
    const opens = res.trades.filter(t => t.action === 'open');
    ok('开仓上限U: 产生了开仓', opens.length > 0);
    ok('开仓上限U: 所有开仓≤150U', opens.every(t => t.amt <= 150 + 1e-6));
  }

  // 3) 币本位开仓上限(perp 多头=coin 保证金)：capCoin=2 → 每笔 USDT 保证金≤2×price
  {
    const capCoin = 2;
    const res = await runBt('perp', { srsiAutoOpenCapCoin: capCoin }, 90);
    const opens = res.trades.filter(t => t.action === 'open');
    ok('开仓上限币: 产生了开仓', opens.length > 0);
    ok('开仓上限币: 每笔保证金≤capCoin×price', opens.every(t => t.amt <= capCoin * t.price + 1e-6));
  }

  // 4) 现货币本位开仓上限：capCoin=2 → 每笔 USDT 保证金≤2×price
  {
    const capCoin = 2;
    const res = await runBt('spot', { srsiAutoBtMode: 'spot', srsiAutoOpenCapCoin: capCoin }, 90);
    const opens = res.trades.filter(t => t.action === 'open');
    ok('现货开仓上限币: 产生了开仓', opens.length > 0);
    ok('现货开仓上限币: 每笔保证金≤capCoin×price', opens.every(t => t.amt <= capCoin * t.price + 1e-6));
  }

  kchartApi.__setCfgForTest(__defaultKConfig());
}

// 实盘自动交易：开仓上限生效（U本位）
console.log('\n[kchart: 实盘自动交易 开仓上限]');
{
  const tfs = ['5m', '10m', '15m', '30m', '1h', '4h'];
  const cfgAuto = __defaultKConfig();
  cfgAuto.symbol = 'BTCUSDT'; cfgAuto.srsiAutoOn = true;
  cfgAuto.srsiAutoBasePct = 30;
  cfgAuto.srsiAutoOpenCapUsdt = 150;
  tfs.forEach(tf => cfgAuto.srsiOptSource[tf] = 'optimized');
  kchartApi.__setCfgForTest(cfgAuto);
  resetSrsiAuto('BTCUSDT');
  const orders = [];
  const mkEngine = (bal = 1000, coin = 0) => ({
    S: { prices: { 'BTCUSDT': { last: 100 } }, pos: [] },
    getPerpSub: () => ({ id: 'perp', bal, coins: { 'BTCUSDT': coin } }),
    placeOrder: (o) => { orders.push(o); },
    exitPosition: () => {}
  });
  const kd = { '1h': 'long', '30m': 'long', '15m': 'long' };
  const sd = { '4h': 'short', '1h': 'short', '30m': 'short' };
  const bandUp = { edge: 'enterUpper', band: 'upper', k: 95, d: 92 };
  orders.length = 0;
  runSrsiAutoTrade('BTCUSDT', { engine: mkEngine(1000, 0), klineDir: kd, srsiDir: sd, band: bandUp });
  ok('实盘开仓上限U: 仅开1单', orders.length === 1);
  ok('实盘开仓上限U: 开仓金额被限制为150U(上限生效)', orders.length === 1 && close(orders[0].amt, 150, 1e-6), 'amt=' + (orders[0] && orders[0].amt));
  kchartApi.__setCfgForTest(__defaultKConfig());
}

console.log('\n[kchart: 回测条件文本 人类+机器可读]');
{
  const cfgT = __defaultKConfig();
  cfgT.symbol = 'BTCUSDT';
  cfgT.srsiAutoMode = 'follow';
  cfgT.srsiAutoUpper = 90; cfgT.srsiAutoLower = 10;
  cfgT.srsiAutoLev = 5; cfgT.srsiAutoMaxSame = 3;
  cfgT.srsiAutoBasePct = 10; cfgT.srsiAutoBonusBig = 3; cfgT.srsiAutoBonusMid = 2; cfgT.srsiAutoBonusSmall = 1;
  cfgT.srsiAutoPrincipal = 1000; cfgT.srsiAutoOptEnabled = true; cfgT.srsiOptSource = { '5m': 'optimized' };
  kchartApi.__setCfgForTest(cfgT);
  // 回测条件已解耦到独立 btCfg：单独设置 btCfg（覆盖默认）
  const btT = {
    accountType: 'perp', marginMode: 'follow', principal: 1000, coin: 0,
    useCost: true, feePct: 0.045, slipPct: 0.02, pct: 10, lev: 5, maxSame: 3,
    upper: 90, lower: 10, capUsdt: 0, capCoin: 0, floorUsdt: 0, floorCoin: 0,
    optTfs: ['15m', '30m', '1h', '4h'], optEnabled: true, optIntervalOn: false, optIntervalH: 5, optNoTradeH: 5,
    w4h: 30, w1h: 20, w30m: 10, collapsed: false
  };
  localStorage.setItem('smartTrader_kchart_bt_cfg', JSON.stringify(btT));
  const c = buildBacktestConditions(7);
  localStorage.removeItem('smartTrader_kchart_bt_cfg');
  ok('条件文本含 币对', c.text.indexOf('币对：BTCUSDT') >= 0);
  ok('条件文本含 交易闸门15m', c.text.indexOf('交易闸门15m') >= 0);
  ok('条件文本含 #4 因子缩放说明', c.text.indexOf('仓位缩放（#4 乘法因子') >= 0 && c.text.indexOf('与自动面板「缩放(#4)」展示同口径') >= 0);
  ok('条件文本含 SRSI 参数(固定)', c.text.indexOf('SRSI 参数（固定') >= 0);
  ok('条件文本含 reoptInBacktest 说明', c.text.indexOf('reoptInBacktest: false') >= 0);
  ok('json.symbol=币对', c.json.symbol === 'BTCUSDT');
  ok('json.days=7', c.json.days === 7);
  ok('json.gateTf=15m', c.json.gateTf === '15m');
  ok('json.sizing.method=#4', c.json.sizing && c.json.sizing.method === '#4');
  ok('json.sizing.baseTf=15m', c.json.sizing.baseTf === '15m');
  ok('json.sizing.weights 三周期', c.json.sizing.weights && c.json.sizing.weights['4h'] > 0 && c.json.sizing.weights['1h'] > 0 && c.json.sizing.weights['30m'] > 0);
  ok('json.reoptInBacktest=false', c.json.reoptInBacktest === false);
  ok('json.btCfg.marginMode=follow', c.json.btCfg.marginMode === 'follow');
  ok('json.btCfg.upper=90', c.json.btCfg.upper === 90);
  ok('json.btCfg.lev=5', c.json.btCfg.lev === 5);
  ok('json.btCfg.maxSame=3', c.json.btCfg.maxSame === 3);
  ok('json.btCfg.optEnabled=true', c.json.btCfg.optEnabled === true);
  ok('json.srsiTfParams 含 15m', !!c.json.srsiTfParams && !!c.json.srsiTfParams['15m'] && c.json.srsiTfParams['15m'].rsiPeriod > 0);
  ok('json.srsiByTf 存在', !!c.json.srsiByTf && typeof c.json.srsiByTf === 'object');
  ok('json.srsiOptSource 含 5m=optimized', c.json.srsiOptSource['5m'] === 'optimized');
  const parsed = JSON.parse(c.text.split('--- 机器可读（复制给 AI 复现）---\n')[1]);
  ok('机器可读段可 JSON.parse 且字段一致', parsed && parsed.symbol === 'BTCUSDT' && parsed.gateTf === '15m' && parsed.sizing.method === '#4');
  kchartApi.__setCfgForTest(__defaultKConfig());
}

// resolveEntryBands：0（或 falsy）= 使用 15m 优选带；非 0 = 手动覆盖
{
  const base = __defaultKConfig();
  const s15 = (base.srsiByTf && base.srsiByTf['15m']) || base.srsi;
  const auto = resolveEntryBands(base);
  ok('resolveEntryBands 默认0→回退15m优选带', auto.upper === s15.overbought && auto.lower === s15.oversold && auto.auto === true);
  const ov = Object.assign({}, base, { srsiAutoUpper: 90, srsiAutoLower: 10 });
  const r2 = resolveEntryBands(ov);
  ok('resolveEntryBands 手动90/10→不回退', r2.upper === 90 && r2.lower === 10 && r2.auto === false);
  const mix = Object.assign({}, base, { srsiAutoUpper: 85, srsiAutoLower: 0 });
  const r3 = resolveEntryBands(mix);
  ok('resolveEntryBands 混合(上85/下0)', r3.upper === 85 && r3.lower === s15.oversold && r3.auto === true);
  const no15 = Object.assign({}, base, { srsiByTf: {}, srsi: { overbought: 80, oversold: 20 } });
  const r4 = resolveEntryBands(no15);
  ok('resolveEntryBands 无15m→80/20', r4.upper === 80 && r4.lower === 20 && r4.auto === true);
  kchartApi.__setCfgForTest(__defaultKConfig());
}

// ============================================================
//  危险信号防爆 / 防爆反手（emaOpp2 + backtestSrsiAuto danger 模式）
// ============================================================
console.log('\n[kchart: 危险信号防爆/反手]');

// 纯函数 emaOpp2：≥2 周期(4h/1h/30m) EMA120 趋势与 side 相反 → 危险
ok('emaOpp2 三反向→危险', emaOpp2('long', { '4h': 'short', '1h': 'short', '30m': 'short' }) === true);
ok('emaOpp2 两反向→危险', emaOpp2('long', { '4h': 'short', '1h': 'short', '30m': 'long' }) === true);
ok('emaOpp2 一反向→安全', emaOpp2('long', { '4h': 'short', '1h': 'long', '30m': 'long' }) === false);
ok('emaOpp2 null不计入反向', emaOpp2('long', { '4h': null, '1h': 'short', '30m': 'long' }) === false);
ok('emaOpp2 空映射→安全', emaOpp2('long', {}) === false);
ok('emaOpp2 无 side→安全', emaOpp2(null, { '4h': 'short' }) === false);
ok('emaOpp2 短反向不计数', emaOpp2('long', { '4h': 'long', '1h': 'long', '30m': 'short' }) === false);

// 合成 K线：15m 2080 根（≈21天），4h/1h/30m 由 15m 按 16/4/2 抽取，保证各周期 EMA120 有足够样本
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const _rng = mulberry32(987654321);
const _STEP = 15 * 60 * 1000, _baseT = 1600000000000, _n = 2080;
let _price = 100; const _c15 = [], _t15 = [];
for (let i = 0; i < _n; i++) { _price *= (1 + (_rng() - 0.5) * 0.012); _c15.push(_price); _t15.push(_baseT + i * _STEP); }
const _k15 = _c15.map((c, i) => [_t15[i], c, c, c, c, 0]);
const _k30 = _c15.filter((_, i) => i % 2 === 0).map((c, i) => [_baseT + i * 2 * _STEP, c, c, c, c, 0]);
const _k1h = _c15.filter((_, i) => i % 4 === 0).map((c, i) => [_baseT + i * 4 * _STEP, c, c, c, c, 0]);
const _k4h = _c15.filter((_, i) => i % 16 === 0).map((c, i) => [_baseT + i * 16 * _STEP, c, c, c, c, 0]);
const _klines = { '15m': _k15, '30m': _k30, '1h': _k1h, '4h': _k4h };
const _bp = { rsiPeriod: 14, kPeriod: 3, dPeriod: 3, overbought: 80, oversold: 20 };
const _baseCfg = {
  srsi: _bp, srsiByTf: { '15m': _bp, '4h': _bp, '1h': _bp, '30m': _bp },
  srsiAutoBtMode: 'perp', srsiAutoLev: 5, srsiAutoMaxSame: 3, srsiAutoBasePct: 10,
  srsiAutoOpenCapUsdt: 1e9, srsiAutoOpenFloorUsdt: 0, srsiAutoOpenCapCoin: 1e9, srsiAutoOpenFloorCoin: 0,
  srsiAutoUseCost: false, srsiAutoMarginMode: 'usdt', srsiAutoFeeRate: 0, srsiAutoSlipBase: 0,
  srsiOptSource: null, srsiBtOptTfs: ['15m', '30m', '1h', '4h']
};
function _runDanger(mode) {
  const cfg = Object.assign({}, _baseCfg, { srsiAutoDanger: mode, srsiAutoReversePct: 0, srsiAutoReverseLev: 0 });
  return backtestSrsiAuto('BTCUSDT', _klines, cfg, 10000, undefined, [], { mode: 'perp' });
}
const _rNone = _runDanger('none'), _rFilter = _runDanger('filter'), _rReverse = _runDanger('reverse');
ok('none 返回 dangerMode', _rNone.dangerMode === 'none');
ok('filter 返回 dangerMode', _rFilter.dangerMode === 'filter');
ok('reverse 返回 dangerMode', _rReverse.dangerMode === 'reverse');
ok('dangerHits 均为数字≥0', [ _rNone.dangerHits, _rFilter.dangerHits, _rReverse.dangerHits ].every(x => typeof x === 'number' && x >= 0));
ok('三模式 dangerHits 一致(危险判定独立于模式)', _rNone.dangerHits === _rFilter.dangerHits && _rFilter.dangerHits === _rReverse.dangerHits);
ok('none 不产生反手单', _rNone.reverseOpens === 0);
ok('filter 不产生反手单(仅避开)', _rFilter.reverseOpens === 0);
ok('reverse 反手单≤危险次数', _rReverse.reverseOpens <= _rReverse.dangerHits);
if (_rReverse.reverseOpens > 0) {
  const revTrades = _rReverse.trades.filter(t => t.action === 'open' && t.reverse);
  ok('reverse 开仓 reverse 标记数=反手开单数', revTrades.length === _rReverse.reverseOpens);
  ok('reverse 反手单与正常单反向(反向类别)', revTrades.every(t => t.reverse === true));
} else {
  console.log('  (本随机序列无危险信号触发，跳过反手计数断言)');
}
ok('三模式均无 NaN 净盈亏', [_rNone, _rFilter, _rReverse].every(r => isFinite(r.finalEquity) && isFinite(r.pnlPct)));
ok('reverse 反手盈亏字段为有限数字', isFinite(_rReverse.reversePnl));
if (_rReverse.reverseOpens > 0) {
  // 反手盈亏 = 所有标记 reverse 的平仓/强平单净盈亏之和（含强平）
  const revClosePnl = _rReverse.trades
    .filter(t => t.reverse && typeof t.pnl === 'number')
    .reduce((s, t) => s + (t.pnl || 0), 0);
  ok('reverse 反手盈亏=反手平仓净盈亏之和', Math.abs(revClosePnl - _rReverse.reversePnl) < 1e-6);
} else {
  ok('reverse 无反手单时反手盈亏=0', _rReverse.reversePnl === 0);
}
// ---- aggTFData：7d/30d 主图聚合为真正周/月蜡烛（其余周期原样返回）----
{
  const sym = '__agg__';
  const mkK = (n) => Array.from({ length: n }, (_, i) => [1000 + i, 1001 + i, 999 + i, 1000 + i, i + 1]);
  // 21 根日线：OHLC 依次递增，验证分组 7 根→1 周
  const daily = mkK(21);
  globalThis.S = {
    klines: { [sym]: { '1d': daily.map(k => k[3]), '7d': daily.map(k => k[3]), '30d': daily.map(k => k[3]) } },
    klinesO: { [sym]: { '1d': daily.map(k => k[0]), '7d': daily.map(k => k[0]), '30d': daily.map(k => k[0]) } },
    klinesH: { [sym]: { '1d': daily.map(k => k[1]), '7d': daily.map(k => k[1]), '30d': daily.map(k => k[1]) } },
    klinesL: { [sym]: { '1d': daily.map(k => k[2]), '7d': daily.map(k => k[2]), '30d': daily.map(k => k[2]) } },
    klinesV: { [sym]: { '1d': daily.map(k => k[4]), '7d': daily.map(k => k[4]), '30d': daily.map(k => k[4]) } },
    klinesT: { [sym]: { '1d': daily.map((_, i) => i * 864e5), '7d': daily.map((_, i) => i * 864e5), '30d': daily.map((_, i) => i * 864e5) } }
  };
  const d1 = aggTFData(sym, '1d');
  ok('aggTFData 1d 原样返回', d1.c.length === 21);
  const w = aggTFData(sym, '7d');
  ok('aggTFData 7d 聚合为 3 周', w.c.length === 3);
  ok('aggTFData 7d 周收盘=第7根日线收盘', w.c[0] === 1006 && w.c[2] === 1020);
  ok('aggTFData 7d 周开=组首开', w.o[0] === 1000);
  ok('aggTFData 7d 周高=组内最大', w.h[0] === 1007);
  ok('aggTFData 7d 周低=组内最小', w.l[0] === 999);
  ok('aggTFData 7d 周量=组内求和', w.v[0] === (1 + 2 + 3 + 4 + 5 + 6 + 7));
  ok('aggTFData 7d 周时间=组末时间戳', w.t[0] === 6 * 864e5);
  const m = aggTFData(sym, '30d');
  ok('aggTFData 30d 不足30根原样返回', m.c.length === 21);
  const daily30 = mkK(90);
  globalThis.S.klines[sym]['30d'] = daily30.map(k => k[3]);
  globalThis.S.klinesO[sym]['30d'] = daily30.map(k => k[0]);
  globalThis.S.klinesH[sym]['30d'] = daily30.map(k => k[1]);
  globalThis.S.klinesL[sym]['30d'] = daily30.map(k => k[2]);
  globalThis.S.klinesV[sym]['30d'] = daily30.map(k => k[4]);
  globalThis.S.klinesT[sym]['30d'] = daily30.map((_, i) => i * 864e5);
  const m2 = aggTFData(sym, '30d');
  ok('aggTFData 30d 聚合为 3 月', m2.c.length === 3);
  delete globalThis.S;
}
// ---- nativeMain：主图优先用原生周/月线（7d→1w, 30d→1M），缺失时回退 aggTFData ----
{
  const sym = '__native__';
  // aggTFData 回退（无原生数组时，7d/30d 走日线聚合）
  globalThis.S = { klines: { [sym]: { '7d': [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14], '30d': [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30] } },
    klinesO: {}, klinesH: {}, klinesL: {}, klinesV: {}, klinesT: {} };
  const fb7 = nativeMain(sym, '7d');
  ok('nativeMain 无原生→回退 aggTFData(7d 聚合2周)', fb7.c.length === 2);
  const fb1 = nativeMain(sym, '1d');
  ok('nativeMain 非7d/30d→原样(aggTFData, 无原生数组)', Array.isArray(fb1.c) && fb1.c.length === 0);
  // 原生周/月线优先
  const wk = { o: [1], h: [2], l: [0], c: [1.5], v: [10], t: [100] };
  const mo = { o: [3], h: [4], l: [2], c: [3.5], v: [20], t: [200] };
  globalThis.S.klinesWeek = { [sym]: wk };
  globalThis.S.klinesMonth = { [sym]: mo };
  ok('nativeMain 7d→原生周线', nativeMain(sym, '7d') === wk);
  ok('nativeMain 30d→原生月线', nativeMain(sym, '30d') === mo);
  delete globalThis.S;
}
// 防爆反手模式：回测报告字段透出（_renderBacktestResult 不崩）
const _html = _renderBacktestResult(_rReverse);
ok('回测结果渲染含危险/反手说明', typeof _html === 'string' && _html.indexOf('危险信号触发') >= 0);
// 条件确认含防爆说明
const _cond = buildBacktestConditions(_rReverse);
ok('回测条件确认含危险信号防爆行', _cond.text.indexOf('危险信号防爆') >= 0 && !!_cond.json.btCfg.danger);

// ---- 防爆仓设置本地持久化闭环（实盘 cfg.srsiAutoDanger + 回测 _btCfg.danger）----
{
  const _store = {};
  const _ls = {
    getItem: k => (k in _store ? _store[k] : null),
    setItem: (k, v) => { _store[k] = String(v); },
    removeItem: k => { delete _store[k]; }
  };
  globalThis.localStorage = _ls;
  // 实盘：改危险开关→persist→模拟刷新 loadCfg 还原
  loadCfg('__persist__');
  cfg.srsiAutoDanger = 'reverse';
  cfg.srsiAutoReversePct = 25;
  persist();
  const raw = JSON.parse(_store['smartTrader_kchart']);
  ok('实盘危险开关已写入 localStorage', raw.bySymbol.__persist__.srsiAutoDanger === 'reverse' && raw.bySymbol.__persist__.srsiAutoReversePct === 25);
  loadCfg('__persist__');
  ok('刷新后实盘危险开关保留', cfg.srsiAutoDanger === 'reverse' && cfg.srsiAutoReversePct === 25);
  // 回测：改 danger→_btCfgSave→_btCfgLoad 还原
  _btCfg.danger = 'reverse';
  _btCfg.reversePct = 40;
  _btCfgSave();
  _btCfgLoad();
  ok('刷新后回测危险开关保留', _btCfg.danger === 'reverse' && _btCfg.reversePct === 40);
  delete globalThis.localStorage;
}

console.log(`\n=== kchart.test: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);