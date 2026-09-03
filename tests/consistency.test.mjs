// 一致性验证：迷你 PWA 的 parseKlines 必须逐元素等于主系统 refreshTechKlines 的解析
// 这样 S.klines 相同 → 共享的 kchart.js 算出的 SRSI/速览/纪律结论完全相同
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseKlines, computeSeries } from '../src/pwa/data.js';
import { buildSrsiOverview, defaultKConfig } from '../src/tech2/kchart.js';
import { downsampleOHLC, sumVol } from '../src/engine/indicators.js';
import { KLINE_DOWNSAMPLE } from '../src/engine/timeframe.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'bnbusdt_klines.json'), 'utf8'));

// 逐行复制 legacy.js refreshTechKlines 的解析逻辑（仅用于对照，证明两者一致）
function legacyParse(tf, raw) {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  let opens = raw.map(c => parseFloat(c[1]));
  let highs = raw.map(c => parseFloat(c[2]));
  let lows = raw.map(c => parseFloat(c[3]));
  let closes = raw.map(c => parseFloat(c[4]));
  let vols = raw.map(c => parseFloat(c[5]));
  let times = raw.map(c => parseInt(c[0], 10) || 0);
  const ds = KLINE_DOWNSAMPLE[tf];
  if (ds) {
    const step = ds.step;
    const agg = downsampleOHLC(opens, highs, lows, closes, step);
    opens = agg.opens; highs = agg.highs; lows = agg.lows; closes = agg.closes;
    vols = sumVol(vols, step);
    times = times.slice(-closes.length);
  }
  return { opens, highs, lows, closes, vols, times };
}

const TFS = ['5m', '15m', '1h', '4h', '1d'];
let count = 0;

// 1) 各周期 O/H/L/C/V/T 逐元素相等
for (const tf of TFS) {
  const raw = fixture[tf];
  assert.ok(Array.isArray(raw) && raw.length > 0, `fixture 缺少 ${tf}`);
  const a = parseKlines(tf, raw);
  const b = legacyParse(tf, raw);
  assert.deepStrictEqual(a, b, `${tf} parseKlines 与主系统解析不一致`);
  count++;
}
// 10m 由 5m 源下采样（KLINE_INTERVAL['10m']==='5m'）
{
  const raw = fixture['5m'];
  const a = parseKlines('10m', raw);
  const b = legacyParse('10m', raw);
  assert.deepStrictEqual(a, b, '10m parseKlines 与主系统解析不一致');
  count++;
}

// 2) 由相同 closes 经共享 buildSrsiOverview 算出的 SRSI 速览必须相等
const cfg = defaultKConfig();
const selTfs = TFS.filter(tf => cfg.klineSel[tf]);
function priceMapOf(parsedMap) {
  const m = {};
  for (const tf of TFS) if (parsedMap[tf]) m[tf] = parsedMap[tf].closes;
  return m;
}
const parsedMap = {}; const legacyMap = {};
for (const tf of TFS) { parsedMap[tf] = parseKlines(tf, fixture[tf]); legacyMap[tf] = legacyParse(tf, fixture[tf]); }
const ovA = buildSrsiOverview(selTfs, cfg.srsi, priceMapOf(parsedMap), cfg.bars);
const ovB = buildSrsiOverview(selTfs, cfg.srsi, priceMapOf(legacyMap), cfg.bars);
assert.deepStrictEqual(ovA, ovB, 'SRSI 速览由相同数据应完全一致');
count++;

// 3) RSI/SRSI 子图数据必须是 0-100 振荡器（回归：曾因把价格喂给 ais 导致 series.rsi 装成价格 ~77851，子图画到画布外）
{
  const closes = fixture['5m'].map(c => parseFloat(c[4]));
  const s = computeSeries(closes);
  for (const v of s.series.rsi) if (v != null) assert.ok(v >= 0 && v <= 100, `series.rsi 越界(应为0-100): ${v}`);
  for (const v of s.series.srsi) if (v != null) assert.ok(v >= 0 && v <= 100, `series.srsi 越界(应为0-100): ${v}`);
  count++;
}

console.log(`✅ consistency: ${count} 项断言通过（迷你 PWA 解析 = 主系统解析，K线/SRSI 数据一致）`);
