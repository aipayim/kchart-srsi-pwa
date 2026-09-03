// 手动跨检脚本（不在 npm test 内，避免网络依赖）：实时拉 BNBUSDT，对比
// 迷你 PWA parseKlines 与主系统解析结果，打印每周期 PASS/FAIL。
// 用法: node scripts/verify-pwa-data.mjs [SYMBOL]
import { parseKlines } from '../src/pwa/data.js';
import { downsampleOHLC, sumVol } from '../src/engine/indicators.js';
import { KLINE_TF, KLINE_INTERVAL, KLINE_DOWNSAMPLE } from '../src/engine/timeframe.js';
import { THRESH } from '../src/engine/thresholds.js';

const SYM = process.argv[2] || 'BNBUSDT';
const API = 'https://api.binance.com';

function legacyParse(tf, raw) {
  let opens = raw.map(c => parseFloat(c[1]));
  let highs = raw.map(c => parseFloat(c[2]));
  let lows = raw.map(c => parseFloat(c[3]));
  let closes = raw.map(c => parseFloat(c[4]));
  let vols = raw.map(c => parseFloat(c[5]));
  let times = raw.map(c => parseInt(c[0], 10) || 0);
  const ds = KLINE_DOWNSAMPLE[tf];
  if (ds) {
    const agg = downsampleOHLC(opens, highs, lows, closes, ds.step);
    opens = agg.opens; highs = agg.highs; lows = agg.lows; closes = agg.closes;
    vols = sumVol(vols, ds.step);
    times = times.slice(-closes.length);
  }
  return JSON.stringify({ opens, highs, lows, closes, vols, times });
}

async function main() {
  let pass = 0, fail = 0;
  for (const tf of KLINE_TF) {
    const interval = KLINE_INTERVAL[tf] || tf;
    const url = `${API}/api/v3/klines?symbol=${SYM}&interval=${interval}&limit=${THRESH.KLINE_LIMIT || 150}`;
    try {
      const r = await fetch(url);
      const raw = await r.json();
      const a = JSON.stringify(parseKlines(tf, raw));
      const b = legacyParse(tf, raw);
      if (a === b) { console.log(`PASS ${tf} (${raw.length} 根)`); pass++; }
      else { console.log(`FAIL ${tf}`); fail++; }
    } catch (e) {
      console.log(`ERR  ${tf}: ${e.message}`); fail++;
    }
  }
  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
main();
