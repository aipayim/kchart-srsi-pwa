// 多周期数据聚合与多周期共振综合

export const TF_LIST = ['1t', '5t', '10t', '20t', '50t', '1m', '5m', '10m', '15m', '30m', '1h', '4h', '8h', '1d', '7d', '30d'];
export const TF_NAME = {
  '1t': '1t(0.8s)', '5t': '5t(4s)', '10t': '10t(8s)', '20t': '20t(16s)', '50t': '50t(40s)',
  '1m': '1m', '5m': '5m', '10m': '10m', '15m': '15m', '30m': '30m', '1h': '1h', '4h': '4h', '8h': '8h',
  '1d': '1d', '7d': '7d(周)', '30d': '30d(月)'
};

// tick 级重采样周期（由 S.history 每 N 根取 1）
export const TICK_TF = ['1t', '5t', '10t', '20t', '50t'];
// K线 REST 周期（由 Binance klines API 获取，存 S.klines）。7d/30d 内部用 1w/1M 蜡烛；10m 由 5m 合成
export const KLINE_TF = ['1m', '5m', '10m', '15m', '30m', '1h', '4h', '8h', '1d', '7d', '30d'];
// 显示周期 → Binance klines interval 映射（仅 7d/30d 需转义，其余同 key）
// 7d/30d 用日线(1d)拉取: 月线/周线分辨率无法表达"最近7/30个自然日"的真实回报,
// 必须日线分辨率才能用时间戳精确回看 N 天前价格(tfOverviewStat 时长感知)。
export const KLINE_INTERVAL = { '1m': '1m', '10m': '5m', '7d': '1d', '30d': '1d' };
// 各 K线周期的分钟数（用于多 SRSI 子图共享时间轴 —— 宽度比例 = 分钟数之比）
export const KLINE_MINUTES = {
  '1m': 1, '5m': 5, '10m': 10, '15m': 15, '30m': 30,
  '1h': 60, '4h': 240, '8h': 480, '1d': 1440, '7d': 10080, '30d': 43200
};
// 非标准周期的合成规则（用 src 周期的 klines 每 step 根取 1 收盘价）
export const KLINE_DOWNSAMPLE = { '10m': { src: '5m', step: 2 } };

// 每 step 根 tick 取最后一根 → 近似收盘序列
export function resample(arr, step) {
  const out = [];
  if (!Array.isArray(arr) || step < 2) return arr ? arr.slice() : [];
  for (let i = step - 1; i < arr.length; i += step) {
    out.push(arr[i]);
  }
  return out;
}

// 按真实分钟分桶取末价; timestamps 与 prices 并行
export function bucketByMinute(prices, timestamps) {
  const out = [];
  let curMin = -1;
  for (let i = 0; i < prices.length; i++) {
    const t = timestamps && timestamps[i] ? timestamps[i] : 0;
    const m = Math.floor(t / 60000);
    if (m !== curMin) { out.push(prices[i]); curMin = m; }
    else { out[out.length - 1] = prices[i]; }
  }
  return out;
}

// 多周期共振综合: tfStates 按小→大周期传入 [{tf,buy,sell}...]
// 大周期定趋势, 小周期定触发; 全部一致 → strong
export function combineResonance(tfStates) {
  const arr = (tfStates || []).filter(s => s && typeof s === 'object');
  if (!arr.length) return { buy: false, sell: false, strength: 'none', agree: 0, buyCount: 0, sellCount: 0, total: 0 };
  const large = arr[arr.length - 1];
  const small = arr[0];
  const buyCount = arr.filter(s => s.buy).length;
  const sellCount = arr.filter(s => s.sell).length;
  const total = arr.length;
  const unanimous = total >= 2 && (buyCount === total || sellCount === total);
  let buy = false, sell = false;
  if (large.buy) buy = small.buy;
  else if (large.sell) sell = small.sell;
  else { buy = buyCount >= 2; sell = sellCount >= 2; }
  const strength = unanimous ? 'strong' : (buy || sell) ? 'medium' : 'none';
  return { buy, sell, strength, agree: unanimous, buyCount, sellCount, total };
}
