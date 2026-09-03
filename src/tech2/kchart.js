// ===== K线分析 页面（全新实现，独立于 技术分析 techChart/techPanel）=====
// 复用公开纯函数与数据源，自建精简渲染：
//   - 顶部：交易对 + K线周期多选（决定 SRSI 多子图）+ 主图周期单选 + 根线数 + 子图顺序 + SRSI 参数
//   - 主图：真 OHLC 蜡烛（数据取自 S.klinesO/H/L 与 S.klines（close））
//   - 子图：RSI / SRSI / MACD（顺序可拖拽），SRSI 对每个勾选 K 线周期渲染短→长堆叠
import { srsiKD, srsiCrossings, srsiHooks, srsiSignal, ema, atrClose, ais, detectRegimeState } from '../engine/indicators.js';
import { KLINE_TF, KLINE_MINUTES, KLINE_INTERVAL } from '../engine/timeframe.js';
import { THRESH } from '../engine/thresholds.js';
import { regimeStrategy } from '../engine/regimeParams.js';

// ---- 逻辑画布尺寸：宽固定，高随子图数量自适应 ----
const W = 1000;
const PAD_L = 64, PAD_R = 12;
const PAD_T = 14, PAD_B = 16;
const MAIN_H = 320;          // 主图固定高度
const SUB_H = 120;           // 每个 RSI/SRSI/MACD 子图高度
const SUB_GAP = 22;          // 子图标题栏+间距
const BASE_H = MAIN_H + PAD_T + PAD_B;

const STATE_KEY = 'smartTrader_kchart';

const DEFAULT_SRSI = { rsiPeriod: 85, stochPeriod: 50, smoothK: 10, smoothD: 5, overbought: 80, oversold: 20 };

export function defaultKConfig() {
  // SRSI 参数默认沿用当前技术分析 techConfig（若无则以内置默认）
  const tc = (typeof window !== 'undefined' && window.techConfig) || {};
  const srsi = {
    rsiPeriod: tc.srsiRsiPeriod || DEFAULT_SRSI.rsiPeriod,
    stochPeriod: tc.srsiStochPeriod || DEFAULT_SRSI.stochPeriod,
    smoothK: tc.srsiSmoothK || DEFAULT_SRSI.smoothK,
    smoothD: tc.srsiSmoothD || DEFAULT_SRSI.smoothD,
    overbought: tc.srsiOverbought || DEFAULT_SRSI.overbought,
    oversold: tc.srsiOversold || DEFAULT_SRSI.oversold
  };
  const klineSel = {};
  KLINE_TF.forEach(tf => { klineSel[tf] = true; });
  return {
    symbol: (tc && tc.symbol) || 'BTCUSDT',
    klineSel,
    mainTF: '5m',
    show: { rsi: true, srsi: true, macd: true },
    bars: 150,
    overviewOpen: true,
    discOpen: true,
    discEvidenceOpen: false,   // 纪律面板「证据」折叠区：首次默认收起，点亮后记住
    srsi,
    subOrder: ['rsi', 'srsi', 'macd']   // 子图顺序（拖拽换序）
  };
}

let cfg = defaultKConfig();

// ---- 内部状态 ----
let _cv = null, _ctx = null;
let _hover = null;
let _resizeObs = null;
let _drag = null;            // 子图拖拽 {startY, curY, moved, fromIdx}
let _suppressClick = false;
let _subRegions = [];        // [{key, tf, y0, y1}]
const _posHits = [];

// ---- 存取 ----
function loadCfg() {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (raw) {
      const o = JSON.parse(raw);
      cfg = { ...defaultKConfig(), ...o, show: { ...defaultKConfig().show, ...(o.show || {}) }, srsi: { ...DEFAULT_SRSI, ...(o.srsi || {}) } };
    }
  } catch (e) { cfg = defaultKConfig(); }
  // 主图/勾选只保留合法 K 线周期
  if (!KLINE_TF.includes(cfg.mainTF)) cfg.mainTF = '5m';
  const sel = {};
  KLINE_TF.forEach(tf => { sel[tf] = !!cfg.klineSel[tf]; });
  cfg.klineSel = sel;
}
function persist() { try { localStorage.setItem(STATE_KEY, JSON.stringify(cfg)); } catch (e) {} }

// ---- 周期排序辅助 ----
const minutesOf = (tf) => KLINE_MINUTES[tf] || 1;

// ---- 控件渲染 ----
function renderControls() {
  const sel = document.getElementById('kchartSymbol');
  if (sel && sel.options.length === 0) {
    (window.SYMS || []).forEach(s => {
      const o = document.createElement('option');
      o.value = s.id; o.textContent = s.id.replace('USDT', '') + ' ' + s.name;
      sel.appendChild(o);
    });
  }
  if (sel) sel.value = cfg.symbol;

  // 统一周期选择器（主图 + SRSI 子图）：每个 TF 一个按钮，含主图圆点 + SRSI 方框
  const tfRow = document.getElementById('kchartTFRow');
  if (tfRow && tfRow.children.length === 0) {
    tfRow.innerHTML = KLINE_TF.map(tf => {
      const isMain = tf === cfg.mainTF;
      const isSel = !!cfg.klineSel[tf];
      return `<span class="kchart-tfbtn ${isMain ? 'main' : ''}" data-tf="${tf}">
        <span class="kchart-tfdot"></span>
        <span class="kchart-tfname">${tf}</span>
        <span class="kchart-tfsq ${isSel ? 'on' : ''}"></span>
      </span>`;
    }).join('');
    // 事件委托（绑定一次）
    if (!tfRow.__bound) {
      tfRow.__bound = true;
      tfRow.addEventListener('click', (e) => {
        const btn = e.target.closest('.kchart-tfbtn');
        if (!btn) return;
        const tf = btn.dataset.tf;
        if (!KLINE_TF.includes(tf)) return;
        if (e.target.closest('.kchart-tfsq')) {
          const res = nextKMode(tf, cfg, 'srsi');
          applyKMode(res);
        } else {
          const res = nextKMode(tf, cfg, 'main');
          applyKMode(res);
        }
      });
    }
  } else if (tfRow) {
    // 同步状态
    tfRow.querySelectorAll('.kchart-tfbtn').forEach(btn => {
      const tf = btn.dataset.tf;
      btn.classList.toggle('main', tf === cfg.mainTF);
      const sq = btn.querySelector('.kchart-tfsq');
      if (sq) sq.classList.toggle('on', !!cfg.klineSel[tf]);
    });
  }

  // 预设按钮（选中集合与 mainTF 完全匹配才高亮；「全选」只看是否全部勾选，主图周期不限）
  const selKeys = KLINE_TF.filter(tf => cfg.klineSel[tf]).sort();
  document.querySelectorAll('.kchart-preset').forEach(el => {
    const p = el.dataset && el.dataset.preset;
    const combo = p && kPresetCombos(p);
    const cKeys = combo ? KLINE_TF.filter(tf => combo.sel[tf]).sort() : [];
    const active = combo
      ? (combo.all
          ? selKeys.length === KLINE_TF.length
          : cfg.mainTF === combo.mainTF && selKeys.join(',') === cKeys.join(','))
      : false;
    el.classList.toggle('active', !!active);
  });

  // 速览表折叠状态
  const ovWrap = document.getElementById('kchartOverviewWrap');
  if (ovWrap) ovWrap.classList.toggle('closed', !cfg.overviewOpen);
  const discWrap = document.getElementById('kchartDiscWrap');
  if (discWrap) discWrap.classList.toggle('closed', !cfg.discOpen);

  const bars = document.getElementById('kchartBars');
  if (bars) bars.value = cfg.bars;
  const barsLbl = document.getElementById('kchartBarsLbl');
  if (barsLbl) barsLbl.textContent = cfg.bars;

  // 子图显示开关
  const subTog = document.getElementById('kchartSubToggles');
  if (subTog) {
    const labels = { rsi: 'RSI', srsi: 'SRSI', macd: 'MACD' };
    subTog.innerHTML = ['rsi', 'srsi', 'macd'].map(key =>
      `<label class="kchart-tog ${cfg.show[key] ? 'on' : ''}" style="--kct:${SUB_COLORS[key]}">
        <input type="checkbox" ${cfg.show[key] ? 'checked' : ''} onchange="window.setKShow('${key}',this.checked)">
        <span>${labels[key]}</span></label>`
    ).join('');
  }

  // SRSI 参数
  const srsiBox = document.getElementById('kchartSrsi');
  if (srsiBox) {
    const mkSel = (name, arr, val) =>
      `<select onchange="window.setKSrsi('${name}',this.value)" class="kchart-sel">` +
      arr.map(v => `<option value="${v}" ${val === v ? 'selected' : ''}>${v}</option>`).join('') + '</select>';
    srsiBox.innerHTML =
      `<span>RSI周期</span>${mkSel('rsiPeriod', [14, 21, 55, 85, 120], cfg.srsi.rsiPeriod)}` +
      `<span>Stoch</span>${mkSel('stochPeriod', [14, 30, 50, 70, 100], cfg.srsi.stochPeriod)}` +
      `<span>%K</span>${mkSel('smoothK', [1, 3, 5, 10, 15, 20, 30], cfg.srsi.smoothK)}` +
      `<span>%D</span>${mkSel('smoothD', [1, 3, 5, 10, 15, 20, 30], cfg.srsi.smoothD)}` +
      `<span>超买</span>${mkSel('overbought', [70, 75, 80, 85, 90], cfg.srsi.overbought)}` +
      `<span>超卖</span>${mkSel('oversold', [10, 15, 20, 25, 30], cfg.srsi.oversold)}` +
      `<button class="kchart-srsi-btn" onclick="window.kResetSrsi()">默认</button>`;
  }
}

// ---- 多周期 SRSI 速览表渲染（DOM，与 canvas 无关）----
// 用签名守卫：仅当 数据/勾选/SRSI参数/主图 变化时才重建 DOM（hover 触发 renderKChart 不重建）
let _ovSig = '';
let _discSig = '';

export function renderSrsiOverview(hz, capMin) {
  const box = document.getElementById('kchartOverview');
  if (!box) return;
  const sym = cfg.symbol;
  const selTfs = KLINE_TF.filter(tf => cfg.klineSel[tf]);
  const priceMap = {};
  let sig = sym + '|' + cfg.mainTF + '|' + cfg.bars + '|' + cfg.srsi.rsiPeriod + '/' + cfg.srsi.stochPeriod + '/' + cfg.srsi.smoothK + '/' + cfg.srsi.smoothD + '/' + cfg.srsi.overbought + '/' + cfg.srsi.oversold + '|';
  selTfs.forEach(tf => {
    const c = getTFData(sym, tf).c;
    priceMap[tf] = c;
    sig += tf + ':' + c.length + ':' + (c[c.length - 1] || 0) + ';';
  });
  sig += '|dz:' + (hz ? hz.deadMode : 'fixed') + ':' + (hz ? hz.deadZone.toFixed(3) : '');
  if (sig === _ovSig) return;
  _ovSig = sig;

  const { rows, bull, bear } = buildSrsiOverview(selTfs, cfg.srsi, priceMap, cfg.bars);
  const verdict = overviewVerdict(bull, bear);
  // 方向基准用全部 KLINE_TF（不受当前勾选影响），与纪律面板共用同一 hz（同一 deadZone/同一基准周期）
  const tr = (hz && hz.trend) || horizonTrend(allPriceMapOf(sym), { capMin: capMin != null ? capMin : THRESH.HORIZON_CAP_MIN, deadZone: hz ? hz.deadZone : THRESH.HORIZON_DEAD_FIXED });
  const mt = macroTrend(allPriceMapOf(sym));
  const deadTxt = hz && hz.deadMode === 'adaptive'
    ? ` 死区自适应${hz.deadZone.toFixed(2)}%(${hz.ratio >= 1 ? '高波动' : '低波动'})`
    : ` 死区固定${(hz ? hz.deadZone : THRESH.HORIZON_DEAD_FIXED).toFixed(2)}%`;
  // 脚部把「决策依据(趋势方向)」与「风险背景(大趋势/宏观)」分开标注，避免误读
  // "宏观7d↓=应该做空"。趋势方向决定做多做空；大趋势方向只用于降置信度、不改方向。
  const trendTxt = tr
    ? `<br>【趋势方向·决策】${tr.up === true ? '↑做多' : tr.up === false ? '↓做空' : '—横盘'}(${tr.tf} ${tr.spreadPct.toFixed(1)}%${tr.flat ? ' 横盘' : ''})${mt && mt.up != null ? ` ·【大趋势·仅扣分】${mt.tf}${mt.up === true ? '↑' : '↓'}(${mt.spreadPct.toFixed(1)}%)` : ''}${deadTxt}`
      + `<br><span style="opacity:.8" title="短周期(速览表)只定入场时机与置信度；大趋势与趋势方向相反时仅降低置信度、不改变方向">短周期箭头≠趋势方向，大趋势反向≠翻方向，仅降置信度</span>`
    : '';
  const zoneCls = { overbought: 'ov-bear', oversold: 'ov-bull', neutral: '' };
  const zoneLbl = { overbought: '超买', oversold: '超卖', neutral: '中性' };
  const rowHtml = rows.map(r => {
    const lc = latestCross(r);
    const cv = lc.cv, fv = lc.fv;
    const freshTxt = fv == null ? '—' : (fv === 0 ? '当下' : fv + '根前');
    const freshCls = fv != null && fv <= 3 ? (cv === 'buy' || cv === 'goldHook' ? 'ov-fresh-buy' : 'ov-fresh-sell') : '';
    const crossTxt = cv === 'goldHook' ? '▲金钩' : cv === 'deathHook' ? '▼死钩' : cv === 'buy' ? '▲金叉' : cv === 'sell' ? '▼死叉' : '无';
    const crossCls = cv === 'goldHook' ? 'ov-hook-gold' : cv === 'deathHook' ? 'ov-hook-death' : cv === 'buy' ? 'ov-cross-buy' : cv === 'sell' ? 'ov-cross-sell' : '';
    const eng = r.energy || { dir: null, score: 0 };
    const engCls = eng.score >= 60 ? 'ov-eng-hi' : eng.score >= 30 ? 'ov-eng-mid' : 'ov-eng-lo';
    const engTxt = eng.dir ? eng.score : '—';
    return `<div class="kchart-ov-row ${r.tf === cfg.mainTF ? 'ov-main' : ''}" data-tf="${r.tf}">
      <span class="kchart-ov-tf">${r.tf}</span>
      <span class="kchart-ov-k">${r.k != null ? r.k.toFixed(1) : '--'}</span>
      <span class="kchart-ov-d">${r.d != null ? r.d.toFixed(1) : '--'}</span>
      <span class="kchart-ov-zone ${zoneCls[r.zone]}">${zoneLbl[r.zone]}</span>
      <span class="kchart-ov-cross ${crossCls} ${r.reversed ? 'ov-reversed' : ''}">${crossTxt}${r.reversed ? ' ↺' : ''}${r.gapNow != null ? `<span class="kchart-ov-gap"> 间${r.gapNow.toFixed(1)}${r.gapTrend === 'up' ? '↑' : r.gapTrend === 'down' ? '↓' : '–'}</span>` : ''}</span>
      <span class="kchart-ov-eng ${engCls}" title="${r.energy ? r.energy.reason : ''}">${engTxt}</span>
      <span class="kchart-ov-fresh ${freshCls}">${freshTxt}</span>
    </div>`;
  }).join('');
  box.innerHTML =
    `<div class="kchart-ov-head-row"><span>周期</span><span>K</span><span>D</span><span>区域</span><span>穿越</span><span>能量</span><span>新鲜度</span></div>` +
    rowHtml +
    `<div class="kchart-ov-foot">偏多 ${bull} · 偏空 ${bear} · ${verdict}<span class="kchart-ov-trend">${trendTxt}</span></div>`;
}

// 速览表行点击 → 切换主图
export function bindOverviewClick() {
  const box = document.getElementById('kchartOverview');
  if (!box || box.__bound) return;
  box.__bound = true;
  box.addEventListener('click', (e) => {
    const row = e.target.closest('.kchart-ov-row');
    if (row && row.dataset.tf) setMainTF(row.dataset.tf);
  });
}

// ---- 交易纪律分析面板（DOM 渲染，防 hover 重建）----
// 实时价信息（纯函数，可单测）：读取 window.S.prices[sym] 计算距目标/止损百分比
export function discLiveInfo(sym, analysis) {
  const S = window.S;
  const p = S && S.prices && S.prices[sym];
  if (!p || p.last == null) return null;
  const out = { price: p.last, chg: p.chg || 0, toTarget: null, toStop: null, targetCls: '', stopCls: '', priceCls: '' };
  out.priceCls = p.chg > 0 ? 'disc-up' : p.chg < 0 ? 'disc-down' : '';
  const isLong = !!(analysis && analysis.entry && analysis.entry.dir.startsWith('做多'));
  const isShort = !!(analysis && analysis.entry && analysis.entry.dir.startsWith('做空'));
  const t = analysis && analysis.entry && analysis.entry.target;
  const s = analysis && analysis.entry && analysis.entry.stop;
  if (t != null) { out.toTarget = (t - p.last) / p.last * 100; if ((isLong && p.last >= t) || (isShort && p.last <= t)) out.targetCls = 'disc-pos'; }
  if (s != null) { out.toStop = (s - p.last) / p.last * 100; if ((isLong && p.last <= s) || (isShort && p.last >= s)) out.stopCls = 'disc-neg'; }
  return out;
}

let _lastDiscAnalysis = null;

// ---- 方向基准死区滞回状态（每 币|基准周期 一份，仅内存，不持久化）----
// 由 updateHorizonState 在 renderKChart 每次推进（DOM 未重建也推进，保证 CONFIRM 计数正确），
// renderSrsiOverview 与 renderTradeDiscipline 共用同一 deadZone，保证两面板口径一致。
const __hzLatch = new Map();
const __hzCache = { key: null, trend: null, deadZone: THRESH.HORIZON_DEAD_FIXED, deadMode: 'fixed', ratio: null };

export function updateHorizonState(sym, priceMap, capMin) {
  const cap = capMin != null ? capMin : THRESH.HORIZON_CAP_MIN;
  const trend = horizonTrend(priceMap, { capMin: cap });
  const key = trend ? sym + '|' + trend.tf : null;
  if (key !== __hzCache.key) {
    __hzLatch.delete(__hzCache.key);
    __hzCache.key = key;
  }
  let his = [], ratio = null;
  if (key) {
    his = atrPctHistory(priceMap[trend.tf]);
    if (his.length >= THRESH.HORIZON_ATR_MIN) {
      const s = [...his].filter(v => typeof v === 'number' && isFinite(v) && v > 0).sort((a, b) => a - b);
      const med = s.length ? s[Math.floor(s.length / 2)] : null;
      ratio = med > 0 ? his[his.length - 1] / med : null;
    }
    const st = deadZoneLatch(ratio, __hzLatch.get(key));
    __hzLatch.set(key, st);
    __hzCache.deadMode = st.mode;
  } else {
    __hzCache.deadMode = 'fixed';
  }
  __hzCache.ratio = ratio;
  __hzCache.deadZone = deadZoneValue(__hzCache.deadMode, his);
  // 用当前(可能自适应)死区重算 trend——死区只影响 flat、不影响候选TF；
  // 保证速览页脚(hz.trend)与纪律面板(用 hz.deadZone 重算)口径一致(5.28「两面板口径一致」)
  __hzCache.trend = trend ? horizonTrend(priceMap, { capMin: cap, deadZone: __hzCache.deadZone }) : trend;
  return __hzCache;
}

// 轻量实时价刷新：在 _discSig 守卫之前调用，每 800ms tick 都执行，实现真·实时
function updateDiscLivePrice(box) {
  const priceEl = box.querySelector('#kchartDiscPrice');
  if (!priceEl) return;
  const info = discLiveInfo(cfg.symbol, _lastDiscAnalysis);
  if (!info) { priceEl.textContent = '—'; return; }
  priceEl.textContent = info.price.toFixed(2);
  priceEl.className = 'disc-price-val ' + info.priceCls;
  const distEl = box.querySelector('#kchartDiscDist');
  if (distEl) {
    const tTxt = info.toTarget != null ? ('目标 <b class="' + info.targetCls + '">' + (info.toTarget >= 0 ? '+' : '') + info.toTarget.toFixed(2) + '%</b>') : '';
    const sTxt = info.toStop != null ? ('止损 <b class="' + info.stopCls + '">' + (info.toStop >= 0 ? '+' : '') + info.toStop.toFixed(2) + '%</b>') : '';
    distEl.innerHTML = (tTxt + (tTxt && sTxt ? ' · ' : '') + sTxt) || '—';
  }
}

export function renderTradeDiscipline(hz, capMin) {
  const box = document.getElementById('kchartDisc');
  if (!box) return;
  const sym = cfg.symbol;
  updateDiscLivePrice(box);
  const selTfs = KLINE_TF.filter(tf => cfg.klineSel[tf]);
  if (!selTfs.length) return;
  const priceMap = {};
  let sig = sym + '|' + cfg.mainTF + '|' + cfg.bars + '|' + cfg.srsi.rsiPeriod + '/' + cfg.srsi.stochPeriod + '|';
  KLINE_TF.forEach(tf => {
    const c = getTFData(sym, tf).c;
    priceMap[tf] = c;
    sig += tf + ':' + (c.length > 0 ? c[c.length - 1] : 0) + ';';
  });
  sig += '|dz:' + (hz ? hz.deadMode : 'fixed') + ':' + (hz ? hz.deadZone.toFixed(3) : '');
  if (sig === _discSig) return;
  _discSig = sig;

  const deadZone = hz ? hz.deadZone : THRESH.HORIZON_DEAD_FIXED;
  const deadMode = hz ? hz.deadMode : 'fixed';
  const cap = capMin != null ? capMin : THRESH.HORIZON_CAP_MIN;
  const analysis = analyzeTradeDiscipline(priceMap, cfg.srsi, { bars: cfg.bars, mainTF: cfg.mainTF, klineSel: cfg.klineSel, capMin: cap, deadZone, deadMode });
  if (!analysis) { box.innerHTML = '<div class="kchart-disc-empty">⏳ 数据不足</div>'; return; }
  _lastDiscAnalysis = analysis;

  const { trend, multiTf, zones, confirm, entry, rules, leading, energyRows, strategy, signalLife } = analysis;
  const stratLabel = strategy === 'energy-leader' ? '能量领跑' : strategy === 'freshest-signal' ? '动量跟随' : '趋势跟随';
  const stratCls = strategy === 'energy-leader' ? 'strat-leader' : strategy === 'freshest-signal' ? 'strat-fresh' : 'strat-baseline';
  const dirColor = entry.dir.startsWith('做多') ? 'disc-bull' : entry.dir.startsWith('做空') ? 'disc-bear' : 'disc-neutral';
  const confColor = entry.confLabel === '高' ? 'conf-high' : entry.confLabel === '中' ? 'conf-mid' : 'conf-low';
  const zoneEmoji = { overbought: '🔴超买', oversold: '🟢超卖', neutral: '⚪中性' };
  const trendEmoji = trend.up === true ? '📈' : trend.up === false ? '📉' : '—';
  const deadTxt = deadMode === 'adaptive'
    ? ` · 死区自适应${deadZone.toFixed(2)}%(${hz && hz.ratio >= 1 ? '高波动' : '低波动'})`
    : ` · 死区固定${deadZone.toFixed(2)}%`;
  const regimeLabel = analysis.regime && analysis.regime.label ? analysis.regime.label : '—';

  const rulesHtml = rules.map(r =>
    `<div class="kchart-disc-rule ${r.ok ? 'disc-rule-ok' : 'disc-rule-warn'}">
      <span class="disc-rule-icon">${r.ok ? '✓' : '⚠'}</span>
      <span class="disc-rule-name">${r.name}</span>
      <span class="disc-rule-note">${r.note}</span>
    </div>`
  ).join('');
  const confPartsHtml = entry.confParts.length ? entry.confParts.join(' · ') : '基准' + entry.conf;
  const tradeBarHtml = `${leading ? `<div class="disc-lead disc-lead-${leading.dir === 'buy' ? 'bull' : 'bear'}">⚡ 能量领跑: ${leading.tf} (${leading.score}) ${leading.dir === 'buy' ? '偏多' : '偏空'}${leading.isClear ? ' · 独一档' : ''}</div>` : ''}${energyRows && energyRows.length ? `<div class="disc-engbar">${energyRows.map(e => `<span class="disc-eng-cell ${e.score >= 60 ? 'disc-eng-hi' : e.score >= 30 ? 'disc-eng-mid' : 'disc-eng-lo'}">${e.tf} ${e.dir ? (e.dir === 'buy' ? '▲' : '▼') : '—'}${e.score}</span>`).join('')}</div>` : ''}`;

  // ---- 风险带：聚合负向因子 → 一句直觉警告（仅呈现层，不改判断逻辑）----
  const riskItems = [];
  const dirLong = entry.dir.startsWith('做多');
  const dirShort = entry.dir.startsWith('做空');
  if (dirLong && zones.daily === 'overbought') riskItems.push('日线超买(反向)');
  if (dirShort && zones.daily === 'oversold') riskItems.push('日线超卖(反向)');
  if (multiTf.verdict === '分歧') riskItems.push('多周期分歧');
  else if (dirLong && multiTf.bear >= multiTf.bull) riskItems.push('动能偏空');
  else if (dirShort && multiTf.bull >= multiTf.bear) riskItems.push('动能偏多');
  if (analysis.macroConflict) riskItems.push('宏观反向');
  if (confirm.dir && !confirm.confirmed && !confirm.contrarian) {
    riskItems.push(confirm.isHook ? dirName(confirm.dir, true) : dirName(confirm.dir, false) + '未确认');
  }
  if (leading && leading.dir && ((dirLong && leading.dir === 'sell') || (dirShort && leading.dir === 'buy')))
    riskItems.push(leading.tf + '能量反向');
  const riskTag = riskItems.length ? riskItems.slice(0, 4).map(x => `<span class="disc-risk-tag">${x}</span>`).join('') : '<span class="disc-risk-tag disc-risk-clear">暂无显著风险</span>';
  let warnTxt = '无显著风险';
  if (riskItems.length) {
    if (riskItems.includes('日线超买')) warnTxt = dirLong ? '⚠ 日线超买, 仅当回调低吸, 勿追高' : '⚠ 日线超买, 反弹高位, 谨慎';
    else if (riskItems.includes('日线超卖')) warnTxt = dirShort ? '⚠ 日线超卖, 仅当反弹做空, 勿追空' : '⚠ 日线超卖, 回调低位, 谨慎';
    else if (riskItems.includes('宏观反向')) warnTxt = '⚠ 大趋势与方向反向, 仅降置信, 勿满仓';
    else warnTxt = '⚠ ' + riskItems[0] + ', 注意风控';
  }
  const evidenceOpen = cfg.discEvidenceOpen ? ' open' : '';

  box.innerHTML = `
    <div class="kchart-disc-header">
      <span class="disc-title">📋 交易纪律分析</span>
    </div>

    <div class="disc-blocks">
      <!-- ① 判决 -->
      <div class="disc-block disc-block-verdict">
        <div class="disc-action ${dirColor}">
          <span class="disc-dir">${entry.dir}</span>
          <span class="disc-conf ${confColor}">${entry.confLabel} · ${entry.conf}</span>
          <span class="disc-risk">${entry.risk}</span>
        </div>
        <div class="disc-reason">${entry.reason}</div>
        <div class="disc-nowprice">当前价: <span id="kchartDiscPrice">—</span> <span id="kchartDiscDist" class="disc-dist"></span></div>
        <div class="disc-plan"><span class="disc-plan-item">入场: ${entry.entryCue}</span><span class="disc-plan-item">目标: ${entry.target != null ? entry.target.toFixed(2) : '—'}</span><span class="disc-plan-item">止损: ${entry.stop != null ? entry.stop.toFixed(2) : '—'}</span></div>
      </div>

      <!-- ② 市场情境 -->
      <div class="disc-block disc-block-regime">
        <div class="disc-blk-label">市场情境</div>
        <div class="disc-regime">${trendEmoji} ${regimeLabel} · EMA(${trend.tf}) ${trend.up === true ? '↑' : trend.up === false ? '↓' : '—'} ${trend.spreadPct.toFixed(2)}%${deadTxt}</div>
        <div class="disc-strategy ${stratCls}">策略: ${stratLabel}</div>
      </div>

      <!-- ③ 依据 / ④ 时机 / ⑤ 风险（三带） -->
      <div class="disc-bandrow">
        <div class="disc-band disc-band-evidence">
          <div class="disc-blk-label">方向依据</div>
          <div class="disc-band-txt">EMA(${trend.tf}) ${trend.up === true ? '↑ 做多基准' : trend.up === false ? '↓ 做空基准' : '横盘观望'} ${trend.spreadPct.toFixed(2)}%</div>
        </div>
        <div class="disc-band disc-band-timing">
          <div class="disc-blk-label">时机(动能)</div>
          <div class="disc-band-txt"><span class="${multiTf.verdict === '分歧' ? 'disc-warn-text' : ''}">共振 ${multiTf.bull}多·${multiTf.bear}空 → ${multiTf.verdict}</span> · 入场确认 ${confirm.contrarian ? '⚠ 反向' : (confirm.confirmed ? '✅ 已确认' : '⏳ 等待')}</div>
          ${signalLife ? `<div class="disc-band-txt disc-sig ${signalLife.cls}">信号生命周期: ${signalLife.txt} · 信号置信 <b>${signalLife.conf}</b>` : ''}</div>
        </div>
        <div class="disc-band disc-band-risk">
          <div class="disc-blk-label">风险</div>
          <div class="disc-risk-tags">${riskTag}</div>
          <div class="disc-warn ${riskItems.length ? '' : 'disc-warn-clear'}">${warnTxt}</div>
        </div>
      </div>

      <!-- ⑥ 证据（可折叠，记住状态） -->
      <div class="disc-block disc-block-evidence">
        <details class="disc-details"${evidenceOpen}>
          <summary class="disc-details-summary" onclick="event.stopPropagation(); window.setDiscEvidence(!this.parentElement.open)">证据详情（规则 · 能量 · 确认 · 调整）<span class="disc-details-arrow">▸</span></summary>
          <div class="disc-details-body">
            ${analysis.conflictNote ? `<div class="disc-conflict">⚠ ${analysis.conflictNote}</div>` : ''}
            ${analysis.macroConflict ? `<div class="disc-conflict">${analysis.macroConflict} 已扣 ` + (entry.confParts.find(p => p.includes('宏观反向')) || '') + `</div>` : ''}
            <div class="disc-zone">${zones.dailyTf === '1d' ? '日线' : (zones.dailyTf || '日线')} ${zoneEmoji[zones.daily] || '—'} · 主周期 ${zoneEmoji[zones.main] || '—'}</div>
            <div class="disc-consensus">多周期: 偏多${multiTf.bull} 偏空${multiTf.bear} → ${multiTf.verdict}</div>
            <div class="disc-confirm">入场确认: ${confirm.contrarian ? '⚠ 反向信号' : (confirm.confirmed ? '✅ 已确认' : '⏳ 等待')} ${confirm.tf ? '(' + confirm.tf + ' ' + dirName(confirm.dir, confirm.isHook) + ' ' + confirm.fresh + '根前' + (confirm.isHook ? ' [钩]' : '') + ')' : ''}</div>
            ${signalLife ? `<div class="disc-life">信号生命周期: <b class="${signalLife.cls}">${signalLife.txt}</b> · 信号置信 <b>${signalLife.conf}</b> · 能量 ${signalLife.score}</div>` : ''}
            ${tradeBarHtml}
            <div class="disc-rules">${rulesHtml}</div>
            <div class="disc-conf-detail">调整: ${confPartsHtml}</div>
          </div>
        </details>
      </div>
    </div>
  `;
}

// 多周期 SRSI 速览表（纯数据，可单测）

const SUB_COLORS = { rsi: '#ffd740', srsi: '#c58aff', macd: '#ffffff' };

// ---- 计算子图栈：按 show + 顺序，展开 SRSI 多子图 ----
function buildSubList() {
  const list = [];
  const all = ['rsi', 'srsi', 'macd'];
  const order = (cfg.subOrder && cfg.subOrder.length ? cfg.subOrder : all).filter(k => cfg.show[k]);
  // 防御：show 中开启、但不在 subOrder 里的键，补到末尾（避免关闭后重开丢失）
  all.forEach(k => { if (cfg.show[k] && !order.includes(k)) order.push(k); });
  order.forEach(key => {
    if (key === 'srsi') {
      const tfs = KLINE_TF.filter(tf => cfg.klineSel[tf]).slice().sort((a, b) => minutesOf(a) - minutesOf(b));
      tfs.forEach(tf => list.push({ key: 'srsi', tf, name: 'SRSI ' + tf }));
    } else {
      list.push({ key, tf: null, name: key.toUpperCase() });
    }
  });
  return list;
}

// ---- 周期选择器统一状态机（纯函数）----
// 每个 TF 有两种状态：主图(唯一) + SRSI子图(多选)。
// action: 'main' = 设为该 TF 为主图(自动勾选进 SRSI)；'srsi' = 切换该 TF 的 SRSI 勾选。
// 取消勾选当前主图时主图自动退到第一个仍勾选的 TF；若一个都不剩则保持原主图。
export function nextKMode(tf, cur, action) {
  const sel = { ...cur.klineSel };
  let mainTF = cur.mainTF;
  if (action === 'main') {
    mainTF = tf;
    sel[tf] = true;
  } else if (action === 'srsi') {
    sel[tf] = !sel[tf];
    if (!sel[tf] && tf === mainTF) {
      const remain = KLINE_TF.filter(x => sel[x]);
      if (remain.length) mainTF = remain[0];
    }
  }
  return { mainTF, sel };
}

// 快捷预设组合：短线/日内/波段 → { mainTF, sel }；all → 全选全部周期（速览表全显），主图周期保持不变
export function kPresetCombos(name) {
  if (name === 'all') {
    const sel = {};
    KLINE_TF.forEach(tf => { sel[tf] = true; });
    return { mainTF: null, sel, all: true };
  }
  const P = {
    scalp:   { tfs: ['1m', '5m', '15m'],   main: '5m' },
    day:     { tfs: ['15m', '1h', '4h'],   main: '1h' },
    swing:   { tfs: ['4h', '1d', '7d'],    main: '1d' }
  };
  const p = P[name] || P.day;
  const sel = {};
  KLINE_TF.forEach(tf => { sel[tf] = p.tfs.includes(tf); });
  return { mainTF: p.main, sel };
}

// ---- 多周期 SRSI 速览表（纯数据，可单测）----
// 对每个已勾选 TF 计算 srsiPanelSeries 的末根 K/D、区域、最近穿越方向与新鲜度(根数)。
// 返回 { rows: [{tf,k,d,zone,crossing,fresh,hook,hookFresh,reversed,gapNow,gapPrev,gapTrend,energy}], bull, bear }
//   reversed: 该周期最近信号是否已被反向动量否决；bull/bear 计数已对反转行做翻转。
export function buildSrsiOverview(selTfs, srsiCfg, priceMap, bars = 150) {
  const rows = [];
  let bull = 0, bear = 0;
  (selTfs || []).slice().sort((a, b) => minutesOf(a) - minutesOf(b)).forEach(tf => {
    const price = (priceMap && priceMap[tf]) || [];
    const row = { tf, k: null, d: null, zone: 'neutral', crossing: null, fresh: null, hook: null, hookFresh: null };
    if (price.length >= 2) {
      const sl = srsiPanelSeries(price, srsiCfg, bars);
      const k = sl.k[sl.k.length - 1], d = sl.d[sl.d.length - 1];
      const st = srsiSignal(k, sl.k.length > 1 ? sl.k[sl.k.length - 2] : null, { overbought: srsiCfg.overbought, oversold: srsiCfg.oversold });
      row.k = k != null ? k : null;
      row.d = d != null ? d : null;
      row.zone = st.zone;
      for (let i = sl.crossings.length - 1; i >= 0; i--) {
        if (sl.crossings[i]) { row.crossing = sl.crossings[i]; row.fresh = sl.crossings.length - 1 - i; break; }
      }
      for (let i = sl.hooks.length - 1; i >= 0; i--) {
        if (sl.hooks[i]) { row.hook = sl.hooks[i]; row.hookFresh = sl.hooks.length - 1 - i; break; }
      }
      // K-D 间距动能（加速/减弱）：当前间距 vs 前一根间距
      const nSl = sl.k.length;
      const gapNow = (row.k != null && row.d != null) ? Math.abs(row.k - row.d) : null;
      const gapPrev = (nSl >= 2 && sl.k[nSl - 2] != null && sl.d[nSl - 2] != null) ? Math.abs(sl.k[nSl - 2] - sl.d[nSl - 2]) : null;
      let gapTrend = 'flat';
      if (gapNow != null && gapPrev != null) {
        if (gapNow > gapPrev * 1.1) gapTrend = 'up';
        else if (gapNow < gapPrev * 0.9) gapTrend = 'down';
      }
      row.gapNow = gapNow; row.gapPrev = gapPrev; row.gapTrend = gapTrend;
      // 反转判定：信号意图 vs 当前瞬时 K/D 方向（死/金 钩/叉 被反向动量否决 → 已反转）
      row.reversed = isReversed(row);
      row.energy = hookEnergy(row);
    } else {
      row.energy = { dir: null, score: 0, isHook: false, reason: '数据不足' };
    }
    rows.push(row);
  });
  const cb = countBullBear(rows);
  return { rows, bull: cb.bull, bear: cb.bear };
}

// 由速览表统计 → 聚合结论
export function overviewVerdict(bull, bear) {
  if (bull === 0 && bear === 0) return '中性';
  if (bull > 0 && bear === 0) return '一致偏多';
  if (bear > 0 && bull === 0) return '一致偏空';
  if (bull > 0 && bear > 0) return '分歧';
  return '中性';
}

// 方向 + 是否钩 → 显示名（金叉/死叉 或 金钩/死钩）
export function dirName(dir, isHook) {
  if (dir === 'buy') return isHook ? '金钩' : '金叉';
  if (dir === 'sell') return isHook ? '死钩' : '死叉';
  return '无';
}

// 速览「穿越」列取离当前最近的一根信号：普通带穿越(金叉/死叉) 与 钩(金钩/死钩) 之间比新鲜度，
// 取 bars 数更小（更近）者；同新鲜度时优先钩（更具体）。返回 { cv, fv }。
export function latestCross(row) {
  const crossFresh = (row.crossing != null && row.fresh != null) ? row.fresh : Infinity;
  const hookFresh = (row.hook != null && row.hookFresh != null) ? row.hookFresh : Infinity;
  const useHook = hookFresh <= crossFresh;
  return { cv: useHook ? row.hook : row.crossing, fv: useHook ? row.hookFresh : row.fresh };
}

// 反转判定（纯函数，可单测）：信号意图 vs 当前瞬时 K/D 方向。
// 死叉/死钩(bear) 但当前 K>D → 空头被买回(已反转, 偏多)；金叉/金钩(bull) 但当前 K<D → 多头被砸回(已反转, 偏空)。
export function isReversed(row) {
  if (!row) return false;
  const lc = latestCross(row);
  if (!lc.cv) return false;
  const bear = lc.cv === 'sell' || lc.cv === 'deathHook';
  const bull = lc.cv === 'buy' || lc.cv === 'goldHook';
  if (row.k == null || row.d == null || !isFinite(row.k) || !isFinite(row.d)) return false;
  const EPS = 0.5;
  return bear ? (row.k - row.d > EPS) : bull ? (row.d - row.k > EPS) : false;
}

// 多周期速览共识计数（纯函数，可单测）：按「穿越」列方向计多/空；若该行已反转则翻转贡献（死勾反转→计多 / 金勾反转→计空）。
export function countBullBear(rows) {
  let bull = 0, bear = 0;
  (rows || []).forEach(row => {
    const lc = latestCross(row);
    if (!lc.cv) return;
    let contrib = (lc.cv === 'buy' || lc.cv === 'goldHook') ? 'bull'
                : (lc.cv === 'sell' || lc.cv === 'deathHook') ? 'bear' : null;
    if (!contrib) return;
    if (row.reversed) contrib = contrib === 'bull' ? 'bear' : 'bull';
    if (contrib === 'bull') bull++; else bear++;
  });
  return { bull, bear };
}

// 单周期 SRSI KD 能量分（用户概念：KD 线间距大 + 远离 50 中线 + 钩刚激活 → 能量足）：
//   gapFactor   = clamp(|K-D|/20, 0, 1)    30%  K/D 分得开 → 动量强
//   midFactor   = clamp(距 50 的余量)        30%  信号方向还剩多少空间（卖→离 20 多远 / 买→离 80 多远）
//   freshFactor = clamp(1-fresh/20, 0, 1)   25%  刚激活 → 能量足（>20根前归零）
//   hookBonus   = 钩 +15%, 钗 0%             15%  钩比钗更具体
// 方向取 latestCross（钩/钗孰新取孰）方向。返回 { dir, score:0-100, isHook, reason }。
export function hookEnergy(row) {
  if (!row) return { dir: null, score: 0, isHook: false, reason: '无数据' };
  const lc = latestCross(row);
  if (!lc.cv || lc.fv == null) return { dir: null, score: 0, isHook: false, reason: '无信号' };
  const k = row.k, d = row.d;
  if (k == null || d == null) return { dir: null, score: 0, isHook: false, reason: 'K/D未就绪' };
  const isHook = lc.cv === 'goldHook' || lc.cv === 'deathHook';
  const dir = (lc.cv === 'buy' || lc.cv === 'goldHook') ? 'buy' : 'sell';
  const gapFactor = Math.min(1, Math.abs(k - d) / 20);
  const midFactor = Math.min(1, Math.max(0, dir === 'sell' ? (k - 20) / 40 : (80 - k) / 40));
  const freshFactor = Math.max(0, Math.min(1, 1 - lc.fv / 20));
  const hookBonus = isHook ? 0.15 : 0;
  const score = Math.round((gapFactor * 0.30 + midFactor * 0.30 + freshFactor * 0.25 + hookBonus) * 100);
  const reason = `距${Math.round(gapFactor * 100)}/余量${Math.round(midFactor * 100)}/新鲜${Math.round(freshFactor * 100)}${isHook ? '/钩' : ''}`;
  return { dir, score, isHook, reason };
}

// 从多周期 SRSI 行中找「领跑者」：能量 ≥30 且有方向者取最高分，最高分 ≥50 才认定领跑。
// 返回 { tf, dir, score, isHook, isClear } | null；isClear=最高分 ≥ 次高 1.4 倍（独一档）。
export function leadingTF(rows) {
  const active = (rows || [])
    .map(r => ({ tf: r.tf, energy: hookEnergy(r) }))
    .filter(e => e.energy.dir != null && e.energy.score >= 30);
  if (!active.length) return null;
  active.sort((a, b) => b.energy.score - a.energy.score || minutesOf(a.tf) - minutesOf(b.tf));
  const best = active[0];
  if (best.energy.score < 50) return null;
  const runnerUp = active[1];
  const isClear = !runnerUp || runnerUp.energy.score < best.energy.score * 1.4;
  return { tf: best.tf, dir: best.energy.dir, score: best.energy.score, isHook: best.energy.isHook, isClear };
}

// 入场确认候选选择（纯函数，可单测）：与速览「穿越」列一致——取离当前最近的一根信号（钩或钗），
// 仅当钩是最近事件时才以钩计（isHook），否则以带穿越计。再跨周期按新鲜度取最近。
// rows: [{tf, crossing, fresh, hook, hookFresh}]（已限定短周期）
// expectDir: 期望确认方向('buy'/'sell'/null)。提供时做方向感知——最近信号若与其反向 → 标 contrarian
//   (供「观望」门控用, 不做正向确认, confirmed=false)；expectDir=null 保持原行为(兼容旧调用)。
export function pickConfirm(rows, expectDir) {
  const cands = [];
  (rows || []).forEach(r => {
    const lc = latestCross(r);
    if (lc.cv == null || lc.fv == null) return;
    const isHook = lc.cv === 'goldHook' || lc.cv === 'deathHook';
    const dir = (lc.cv === 'buy' || lc.cv === 'goldHook') ? 'buy' : 'sell';
    cands.push({ dir, fresh: lc.fv, tf: r.tf, isHook, reversed: isReversed(r) });
  });
  cands.sort((a, b) => a.fresh - b.fresh);
  const confirm = cands.length ? cands[0] : { dir: null, fresh: null, tf: null, isHook: false, reversed: false };
  // 已反转信号不作为反向确认（其原方向已被动量否决）：不触发 contrarian 门控、也不计为有效确认
  confirm.contrarian = !!(expectDir && confirm.dir != null && confirm.dir !== expectDir) && !confirm.reversed;
  confirm.confirmed = !confirm.contrarian && confirm.dir != null && confirm.fresh <= 3 && !confirm.reversed;
  return confirm;
}

// ---- 信号生命周期 / 强度（纯函数，可单测）----
// 把「入场确认信号」还原成直观的强弱 + 新鲜度阶段 + 置信度，供纪律面板所有档位统一显示。
// 输入 confirm(最新短周期信号)、leader(能量领跑)、energyRows(各周期能量)。
// 仅呈现层，绝不参与 dir 判定（守 §5.29：不改方向逻辑）。
// 返回 { phase, strength, conf, txt, cls, tf, dir, fresh, isHook } | null
//   phase: 'fresh'(≤3根刚激活) / 'active'(≤8) / 'aging'(≤20) / 'stale'(>20) / 'none'(无信号)
//   strength: '强'(≥70) / '中'(45-69) / '弱'(<45)
//   conf: 信号置信度 5-95（能量基准 + 新鲜 + 钩加成；独立于 entry.conf 判断置信）
export function signalLifecycle(confirm, leader, energyRows) {
  const c = confirm || {};
  const tf = c.tf || (leader ? leader.tf : null);
  const fresh = c.fresh != null ? c.fresh : null;
  const isHook = !!(c.isHook || (leader && leader.isHook));
  const dir = c.dir || (leader ? leader.dir : null);
  if (!tf || dir == null) return null;

  // 能量基准：优先用最新信号所在周期的能量分，缺则用领跑分
  let score = 0;
  if (c.tf && Array.isArray(energyRows)) {
    const e = energyRows.find(x => x && x.tf === c.tf);
    if (e && e.score != null) score = e.score;
  }
  if (!score && leader && leader.score != null) score = leader.score;

  // 新鲜度阶段
  let phase;
  if (fresh == null) phase = 'none';
  else if (fresh <= 3) phase = 'fresh';
  else if (fresh <= 8) phase = 'active';
  else if (fresh <= 20) phase = 'aging';
  else phase = 'stale';

  // 强度分档（能量分）
  const strength = score >= 70 ? '强' : score >= 45 ? '中' : '弱';

  // 信号置信度（纯展示）
  let conf = score;
  if (phase === 'fresh') conf += 10;
  else if (phase === 'active') conf += 5;
  else if (phase === 'stale') conf -= 10;
  if (isHook) conf += 15;
  conf = Math.max(5, Math.min(95, Math.round(conf)));

  const phaseTxt = { fresh: '新鲜', active: '活跃', aging: '衰减', stale: '失效', none: '无信号' }[phase];
  const dirTxt = dir === 'buy' ? '偏多' : dir === 'sell' ? '偏空' : '';
  const hookTxt = isHook ? (dir === 'buy' ? '金钩' : '死钩') : (dir === 'buy' ? '金叉' : '死叉');
  const freshTxt = fresh == null ? '' : (fresh === 0 ? '当下' : fresh + '根前');
  const cls = phase === 'fresh' ? 'disc-sig-fresh' : phase === 'stale' ? 'disc-sig-stale' : phase === 'aging' ? 'disc-sig-aging' : 'disc-sig-active';
  const txt = `${tf} ${hookTxt} ${freshTxt} · ${phaseTxt} ${strength} · ${dirTxt}`.replace(/\s+/g, ' ').trim();

  return { phase, strength, conf, txt, cls, tf, dir, fresh, isHook, score };
}

// ---- 方向基准视野化 + 死区固定/自适应滞回（纯函数，可单测）----
// 方向基准 = 勾选周期中最长、但 ≤ capMin(4h) 且 ≥120 点的 EMA20/120 趋势。
// 7d/30d 归宏观带(macroTrend)，只做冲突扣分，不参与方向判定。
// deadZone: EMA20/120 spread 绝对值低于该 % → flat(横盘/观望)，避免把噪声当方向。
export function horizonTrend(priceMap, opts = {}) {
  const capMin = opts.capMin != null ? opts.capMin : THRESH.HORIZON_CAP_MIN;
  const deadZone = opts.deadZone != null ? opts.deadZone : THRESH.HORIZON_DEAD_FIXED;
  const tfs = Object.keys(priceMap || {})
    .filter(tf => KLINE_TF.includes(tf) && minutesOf(tf) <= capMin)
    .sort((a, b) => minutesOf(a) - minutesOf(b));
  if (!tfs.length) return null;
  let trendTF = tfs[tfs.length - 1];
  for (let i = tfs.length - 1; i >= 0; i--) {
    if ((priceMap[tfs[i]] || []).length >= 120) { trendTF = tfs[i]; break; }
  }
  const tClose = priceMap[trendTF] || [];
  const e20A = ema(tClose, 20), e120A = ema(tClose, 120);
  const te20 = e20A[e20A.length - 1], te120 = e120A[e120A.length - 1];
  let up = null, slowRef = te120;
  if (te20 != null && te120 != null) up = te20 > te120;
  else if (te20 != null) {
    const win = Math.min(60, Math.max(20, Math.floor(tClose.length / 2)));
    slowRef = tClose.slice(-win).reduce((a, b) => a + b, 0) / win;
    up = te20 > slowRef;
  }
  const spreadPct = te20 != null && slowRef != null && slowRef > 0 ? (te20 - slowRef) / slowRef * 100 : 0;
  const flat = up == null || Math.abs(spreadPct) < deadZone;
  let label;
  if (up == null) label = '数据不足';
  else if (flat) label = '横盘';
  else label = up ? '上升' : '下降';
  return {
    tf: trendTF,
    up: flat ? null : up,
    flat,
    label,
    e20: te20, e120: slowRef,
    spreadPct, deadZone
  };
}

// 宏观带趋势(7d/30d 中最长 ≥120 点)，只用于冲突扣分，不参与方向判定。
export function macroTrend(priceMap) {
  const keys = Object.keys(priceMap || {});
  for (const tf of ['30d', '7d']) {
    if (!keys.includes(tf)) continue;
    const c = priceMap[tf] || [];
    if (c.length < 120) continue;
    const e20A = ema(c, 20), e120A = ema(c, 120);
    const te20 = e20A[e20A.length - 1], te120 = e120A[e120A.length - 1];
    let up = null;
    if (te20 != null && te120 != null) up = te20 > te120;
    else if (te20 != null) {
      const win = Math.min(60, Math.max(20, Math.floor(c.length / 2)));
      up = te20 > c.slice(-win).reduce((a, b) => a + b, 0) / win;
    }
    if (up == null) continue;
    return { tf, up, spreadPct: te20 != null && te120 != null && te120 > 0 ? (te20 - te120) / te120 * 100 : 0 };
  }
  return null;
}

// ATR% 历史（无状态，每次从 klines 现算）：atrClose 逐根 ATR/close×100，取末 n 根。
export function atrPctHistory(closes, n) {
  const N = n || THRESH.HORIZON_ATR_HIS;
  const c = closes || [];
  if (c.length < 14) return [];
  const atrA = atrClose(c, 14);
  const out = [];
  for (let i = Math.max(0, c.length - N); i < c.length; i++) {
    const a = atrA[i], cl = c[i];
    if (a != null && isFinite(a) && cl != null && cl > 0) out.push(a / cl * 100);
  }
  return out;
}

// 滞回状态机: ratio(curATR%/medATR%) → mode('fixed'|'adaptive')。
// fixed→adaptive: ratio≥hiEnter 或 ≤loEnter 连续 CONFIRM 帧；
// adaptive→fixed: loExit≤ratio≤hiExit 连续 CONFIRM 帧（滞回带防抖）。
// state={mode,n}；返回新 state。ratio 无效时强制回 fixed。
export function deadZoneLatch(ratio, state, opts = {}) {
  const s = state && state.mode ? state : { mode: 'fixed', n: 0 };
  const hiEnter = opts.hiEnter != null ? opts.hiEnter : THRESH.HORIZON_VOL_HI_ENTER;
  const loEnter = opts.loEnter != null ? opts.loEnter : THRESH.HORIZON_VOL_LO_ENTER;
  const hiExit = opts.hiExit != null ? opts.hiExit : THRESH.HORIZON_VOL_HI_EXIT;
  const loExit = opts.loExit != null ? opts.loExit : THRESH.HORIZON_VOL_LO_EXIT;
  const confirm = opts.confirm != null ? opts.confirm : THRESH.HORIZON_VOL_CONFIRM;
  let mode = s.mode, n = s.n || 0;
  if (ratio == null || !isFinite(ratio)) return { mode: 'fixed', n: 0 };
  if (mode === 'fixed') {
    const extreme = ratio >= hiEnter || ratio <= loEnter;
    n = extreme ? n + 1 : 0;
    if (n >= confirm) { mode = 'adaptive'; n = 0; }
  } else {
    const normal = ratio <= hiExit && ratio >= loExit;
    n = normal ? n + 1 : 0;
    if (n >= confirm) { mode = 'fixed'; n = 0; }
  }
  return { mode, n };
}

// 合成死区: fixed=固定值; adaptive=clamp(中位ATR%×mult, lo, hi)。
// pctHis 样本 < minSamples → 强制 fixed（冷启动保守）。
export function deadZoneValue(mode, pctHis, opts = {}) {
  const fixed = opts.fixed != null ? opts.fixed : THRESH.HORIZON_DEAD_FIXED;
  if (mode !== 'adaptive') return fixed;
  const his = pctHis || [];
  if (his.length < (opts.minSamples != null ? opts.minSamples : THRESH.HORIZON_ATR_MIN)) return fixed;
  const s = [...his].filter(v => typeof v === 'number' && isFinite(v) && v > 0).sort((a, b) => a - b);
  if (!s.length) return fixed;
  const med = s[Math.floor(s.length / 2)];
  const mult = opts.mult != null ? opts.mult : THRESH.HORIZON_DEAD_ATR_MULT;
  const lo = opts.lo != null ? opts.lo : THRESH.HORIZON_DEAD_MIN;
  const hi = opts.hi != null ? opts.hi : THRESH.HORIZON_DEAD_MAX;
  return Math.max(lo, Math.min(hi, med * mult));
}

// 宏观冲突扣分: 方向与宏观反向时按宏观 spread% 缩放, clamp [10,20]; 同向/观望→0。
export function conflictPenalty(mt, dir) {
  if (!mt || mt.up == null || !dir || dir === '观望') return 0;
  const conflict = (dir.startsWith('做多') && mt.up === false) || (dir.startsWith('做空') && mt.up === true);
  if (!conflict) return 0;
  return Math.max(10, Math.min(20, Math.abs(mt.spreadPct) * 0.5));
}

// 趋势(长周期EMA)与动能(SRSI共识)背离时的显式说明——双向对称，避免"速览一致偏多"与"纪律做空"视觉矛盾。
// 仅当两者明确相反时提示；同向/分歧/趋势数据不足均返回 null(避免误报或伪造一致)。
export function trendConflictNote(up, verdict, trendTF) {
  if (up === false && verdict === '一致偏多')
    return 'SRSI 多周期一致偏多，但长周期(' + trendTF + ') EMA 向下=主趋势偏空：金叉/金钩仅视为下跌中的反弹（回调≠反转），不逆势做多，等反转确认';
  if (up === true && verdict === '一致偏空')
    return 'SRSI 多周期一致偏空，但长周期(' + trendTF + ') EMA 向上=主趋势偏多：死叉/死钩仅视为上涨中的回调，不盲目做空';
  return null;
}

// ---- 交易纪律分析引擎（纯函数，可单测）----
// 输入: priceMap={tf:[close,...]}（各周期收盘序列）+ SRSI 配置 + 主图周期。
// 规则硬编码自「交易纪律」百科：顺势交易/多周期共振/逆势信号警惕/回调≠反转/信号只是提示。
// 输出: { trend, multiTf, zones, entry, rules } —— 见预演（BNB/ETH/SOL 三币验证一致）。
export function analyzeTradeDiscipline(priceMap, srsiCfg, opts = {}) {
  const bars = opts.bars || 150;
  const mainTF = opts.mainTF || '4h';
  const klineSel = opts.klineSel || {};
  const allTfs = Object.keys(priceMap || {}).filter(tf => KLINE_TF.includes(tf)).sort((a, b) => minutesOf(a) - minutesOf(b));
  if (!allTfs.length) return null;
  // SRSI/共识仅用用户勾选的 TF，方向基准用全部 TF 中 ≤capMin 的最长周期
  const useTfs = allTfs.filter(tf => klineSel[tf] !== false);
  if (!useTfs.length) return null;
  const ov = buildSrsiOverview(useTfs, srsiCfg, priceMap, bars);
  const rows = ov.rows;
  const byTf = {};
  rows.forEach(r => { byTf[r.tf] = r; });
  // 能量/领跑：逐周期 KD 能量分 + 找出最高能量的「领跑者」（供呈现与置信度修正）
  const energyRows = rows.map(r => ({ tf: r.tf, energy: hookEnergy(r) }));
  const leader = leadingTF(rows);

  // 方向基准: 全部 TF 中 ≤capMin(4h)、≥120 点的最长 EMA20/120 趋势；spread < 死区 → flat 观望
  const capMin = opts.capMin != null ? opts.capMin : THRESH.HORIZON_CAP_MIN;
  const deadZone = opts.deadZone != null ? opts.deadZone : THRESH.HORIZON_DEAD_FIXED;
  const trend = horizonTrend(priceMap, { capMin, deadZone })
    || { tf: '—', up: null, flat: true, label: '数据不足', e20: null, e120: null, spreadPct: 0, deadZone };
  const trendTF = trend.tf;
  const up = trend.up;
  const tClose = (trendTF !== '—' && priceMap[trendTF]) || [];
  const mt = macroTrend(priceMap);

  // 市场状态 → 信号策略（用趋势TF 的 AIS 斜率检测 regime）
  const regSeries = trendTF !== '—' && tClose.length >= 30
    ? { price: tClose, aisLine: ais(tClose, 20, 8, 32, 14, 2).line } : null;
  const regimeState = regSeries ? detectRegimeState(regSeries) : null;
  const strategy = regimeStrategy(regimeState);

  // 多周期共识
  const bull = ov.bull, bear = ov.bear;
  const verdict = overviewVerdict(bull, bear);

  // 趋势与动能背离说明（双向对称）
  const conflictNote = trendConflictNote(trend.up, verdict, trendTF);

  // 关键周期
  const mainRow = byTf[mainTF] || rows[Math.floor(rows.length / 2)] || rows[rows.length - 1];
  const scalpRow = rows[0] || mainRow;
  // 日线槽位 = 真实 1d K线（不受 klineSel/预设影响，与速览同源）；1d 未就绪时回退勾选中最长周期
  const hasDaily = !!(priceMap['1d'] && priceMap['1d'].length >= 2);
  const dailyRow = hasDaily ? buildSrsiOverview(['1d'], srsiCfg, priceMap, bars).rows[0] : (rows[rows.length - 1] || mainRow);
  const dailyTf = hasDaily ? '1d' : dailyRow.tf;
  const mainTFUse = mainRow.tf;
  const zones = { daily: dailyRow.zone, main: mainRow.zone, scalp: scalpRow.zone, dailyTf };

  // 入场确认（方向感知: 门控安全网仍以趋势方向为基准, 策略只在无反向确认时切换方向源）
  const shortTfs = rows.filter(r => minutesOf(r.tf) <= minutesOf(mainTFUse)).map(r => r.tf);
  const shortRows = (shortTfs.length ? shortTfs : [scalpRow.tf]).map(tf => byTf[tf]);
  const want = up === true ? 'buy' : up === false ? 'sell' : null;
  let confirm = pickConfirm(shortRows, want);
  const confirmed = confirm.confirmed;
  // 观望门控: 趋势方向明确(want) 但最近短周期信号已反向确认(≤3根) → 不追不逆, 观望等信号与趋势一致
  const gateWait = !!(want && confirm.contrarian && confirm.fresh != null && confirm.fresh <= 3);

  // 数据驱动: 超买/超卖跨周期广度（仅勾选 TF）
  const obCount = rows.filter(r => r.zone === 'overbought').length;
  const osCount = rows.filter(r => r.zone === 'oversold').length;

  // —— 反转 / 全周期K / K-D间距动能（供置信度修正与说明）——
  const allAbove = rows.length && rows.every(r => r.k != null && r.d != null && r.k > r.d);
  const allBelow = rows.length && rows.every(r => r.k != null && r.d != null && r.k < r.d);
  const allOB = rows.length && rows.every(r => r.zone === 'overbought');
  const allOS = rows.length && rows.every(r => r.zone === 'oversold');
  // 反转韧性：所选 confirm 已反转 → 原空头被反转(K>D)=偏多韧性 / 原多头被反转(K<D)=偏空韧性
  let reversalAdd = 0; const reversalParts = []; let revNote = null;
  if (confirm.reversed && confirm.dir) {
    const bear = confirm.dir === 'sell';
    if (bear && up !== false) { reversalAdd = 8; reversalParts.push('死信号反转+8(多头韧性)'); }
    else if (!bear && up !== true) { reversalAdd = 8; reversalParts.push('金信号反转+8(空头韧性)'); }
    else if (bear && up === false) { reversalAdd = -8; reversalParts.push('死信号反转-8'); }
    else if (!bear && up === true) { reversalAdd = -8; reversalParts.push('金信号反转-8'); }
    revNote = (bear ? '死勾/死叉' : '金勾/金叉') + '已反转(' + (bear ? 'K>D' : 'K<D') + ')→' + (bear ? '偏多韧性' : '偏空韧性');
  }
  // 全周期 K>D / K<D 强信号
  let periodKAdd = 0;
  if (allAbove) periodKAdd = 10;
  else if (allBelow) periodKAdd = -10;
  // K-D 间距动能（加速/减弱）：与方向基准一致时加速+, 减弱-；超买收窄=背离预警
  let gapAdd = 0; const gapParts = [];
  rows.forEach(r => {
    if (r.gapNow == null || r.gapPrev == null) return;
    const gdir = r.k > r.d ? 'buy' : (r.k < r.d ? 'sell' : null);
    if (!gdir) return;
    const accel = r.gapNow > r.gapPrev * 1.1;
    const decel = r.gapNow < r.gapPrev * 0.9;
    if (up === true && gdir === 'buy' && accel) gapAdd += 3;
    else if (up === true && gdir === 'buy' && decel) gapAdd -= 3;
    else if (up === false && gdir === 'sell' && accel) gapAdd += 3;
    else if (up === false && gdir === 'sell' && decel) gapAdd -= 3;
    if (r.zone === 'overbought' && decel) gapParts.push(r.tf + '超买动能失速(背离预警)');
  });
  gapAdd = Math.max(-12, Math.min(12, gapAdd));
  // 新鲜信号却动能减弱 → 额外 -5
  if (confirm.dir && !confirm.reversed && confirm.fresh != null && confirm.fresh <= 3) {
    const cr = byTf[confirm.tf];
    if (cr && cr.gapNow != null && cr.gapPrev != null && cr.gapNow < cr.gapPrev * 0.9) gapAdd -= 5;
  }
  let periodRisk = '';
  if (allAbove && allOB) periodRisk = '中(全周期超买,防冲顶)';
  else if (allBelow && allOS) periodRisk = '中(全周期超卖,防赶底)';

  // 纪律清单
  const rules = [];
  let trendNote;
  if (trend.label === '数据不足') trendNote = '数据不足, 无法判断趋势';
  else if (up === true) trendNote = '方向基准(' + trendTF + ') EMA20>EMA120, 顺势做多为主';
  else if (up === false) trendNote = '方向基准(' + trendTF + ') EMA 向下, 顺势做空为主';
  else trendNote = '方向基准(' + trendTF + ') EMA 价差 ' + trend.spreadPct.toFixed(2) + '% 低于死区 ' + deadZone.toFixed(2) + '%, 横盘观望';
  rules.push({ name: '顺势交易', ok: up === true, note: trendNote });

  rules.push({
    name: '多周期共振',
    ok: verdict === '一致偏多' || verdict === '一致偏空',
    note: '偏多' + bull + ' 偏空' + bear + ' → ' + verdict
  });

  let trapNote = '无逆势陷阱';
  let trapOk = true;
  if (up === true && scalpRow.zone === 'overbought') { trapNote = scalpRow.tf + '超买(死叉)多为回调非反转, 勿追空'; trapOk = false; }
  else if (up === false && scalpRow.zone === 'oversold') { trapNote = scalpRow.tf + '超卖(金叉)多为反弹非反转, 勿追多'; trapOk = false; }
  else if (trend.flat && trend.label !== '数据不足' && (scalpRow.zone === 'overbought' || scalpRow.zone === 'oversold')) {
    trapNote = '方向横盘, 无趋势可逆; 超买超卖信号可靠性低, 等 EMA 方向明确';
    trapOk = true;
  }
  rules.push({ name: '逆势信号警惕', ok: trapOk, note: trapNote });

  // 回调≠反转（数据驱动: 实际 SRSI 短/多周期超买超卖广度）
  let prNote, prOk;
  if (up === true) {
    if (mainRow.zone === 'oversold') {
      const depthNote = osCount >= 2 ? '(多周期均超卖, 深度回调)' : '(仅部分超卖, 常规回调)';
      prNote = '下跌中 主周期(' + mainTFUse + ')超卖, 方向基准仍向上 → 视为回调' + depthNote + ', 等金叉低吸, 勿追空';
      prOk = true;
    } else {
      prNote = '方向基准向上, 主周期未超卖, 等回踩低吸';
      prOk = false;
    }
  } else if (up === false) {
    if (mainRow.zone === 'overbought') {
      const depthNote = obCount >= 2 ? '(多周期均超买, 深度反弹)' : '(仅部分超买, 常规反弹)';
      prNote = '反弹中 主周期(' + mainTFUse + ')超买, 方向基准仍向下 → 视为反弹' + depthNote + ', 等死叉做空, 勿追多';
      prOk = true;
    } else {
      prNote = '方向基准向下, 主周期未超买, 等反弹做空';
      prOk = false;
    }
  } else if (trend.label === '数据不足') {
    prNote = '数据不足, 无法判断趋势上下文'; prOk = false;
  } else {
    prNote = '方向基准横盘(价差 < 死区 ' + deadZone.toFixed(2) + '%), 回调≠反转暂不适用, 等 EMA 方向明确';
    prOk = true;
  }
  rules.push({ name: '回调≠反转', ok: prOk, note: prNote });

  rules.push({
    name: '信号只是提示',
    ok: confirmed || gateWait,
    note: confirmed
      ? (confirm.tf + ' ' + dirName(confirm.dir, confirm.isHook) + ' ' + confirm.fresh + '根前 ✅ 已确认')
      : (gateWait
        ? (confirm.tf + ' ' + dirName(confirm.dir, confirm.isHook) + ' ' + confirm.fresh + '根前 ✅ 已确认(反向) → ' + (want === 'buy' ? '回调中勿追多, 等金叉/金钩确认回调结束再低吸' : '反弹中勿追空, 等死叉/死钩确认反弹结束再做空'))
        : (confirm.dir ? (confirm.tf + ' ' + dirName(confirm.dir, confirm.isHook) + ' ' + confirm.fresh + '根前, 需等更新鲜确认') : '近期无穿越信号, 观望'))
  });

  // 反转信号识别：若最近信号已反转，说明原方向被动量否决 → 翻转计入，不作为有效反向确认
  rules.push({
    name: '信号反转识别',
    ok: !confirm.reversed || (confirm.dir === 'sell' ? up !== false : up !== true),
    note: confirm.reversed ? (revNote + ' → 翻转计' + (confirm.dir === 'sell' ? '多' : '空')) : '近期信号未反转'
  });

  // 短周期锚定（能量领跑）：最高能量的周期驱动近期走势，方向与方向基准一致 → 顺势增强，相反 → 动能衰减警惕
  let leadNote, leadOk = true;
  if (leader) {
    const leadDirTxt = leader.dir === 'buy' ? '偏多' : '偏空';
    if (up === true && leader.dir === 'buy') { leadNote = leader.tf + ' 能量 ' + leader.score + ' ' + leadDirTxt + '领跑, 与方向基准一致 → 短线顺势'; leadOk = true; }
    else if (up === false && leader.dir === 'sell') { leadNote = leader.tf + ' 能量 ' + leader.score + ' ' + leadDirTxt + '领跑, 与方向基准一致 → 短线顺势'; leadOk = true; }
    else if (up === true && leader.dir === 'sell') { leadNote = leader.tf + ' 能量 ' + leader.score + ' ' + leadDirTxt + '领跑, 与方向基准相反 → 短线动能衰减, 防回调/反转'; leadOk = false; }
    else if (up === false && leader.dir === 'buy') { leadNote = leader.tf + ' 能量 ' + leader.score + ' ' + leadDirTxt + '领跑, 与方向基准相反 → 短线反弹, 勿追空'; leadOk = false; }
    else { leadNote = leader.tf + ' 能量 ' + leader.score + ' ' + leadDirTxt + '领跑, 方向基准横盘 → 短线动能主导'; leadOk = true; }
  } else {
    leadNote = '无显著领跑周期(各周期能量均 <50 或无信号)';
  }
  rules.push({ name: '短周期锚定', ok: leadOk, note: leadNote });

  // 操作建议（策略感知）
  const p = tClose[tClose.length - 1] || 0;
  const atrP = tClose.length >= 14 ? (atrClose(tClose, 14)[tClose.length - 1] || p * 0.001) : p * 0.001;
  let dir = '观望', base = 30, reason = '多周期分歧/无明确信号', entryCue = '等待共振信号', stop = null, target = null;
  if (trend.label === '数据不足') {
    dir = '观望'; base = 30; reason = '数据不足, 无法判定方向'; entryCue = '等待更多K线';
  } else if (gateWait) {
    dir = '观望'; base = 30;
    reason = want === 'buy'
      ? '方向基准上升(' + trendTF + ') 但 ' + (confirm.tf || '短周期') + ' ' + dirName(confirm.dir, confirm.isHook) + '已确认(反向) → 短线回调中, 观望: 勿追多(下跌未完)亦勿逆势做空(趋势向上), 等金叉/金钩确认回调结束再低吸'
      : '方向基准下降(' + trendTF + ') 但 ' + (confirm.tf || '短周期') + ' ' + dirName(confirm.dir, confirm.isHook) + '已确认(反向) → 短线反弹中, 观望: 勿追空(反弹未完)亦勿逆势做多(趋势向下), 等死叉/死钩确认反弹结束再做空';
    entryCue = want === 'buy'
      ? '等 短周期金叉/金钩 确认回调结束, 或 ' + trendTF + ' 方向翻空后再考虑做空'
      : '等 短周期死叉/死钩 确认反弹结束, 或 ' + trendTF + ' 方向翻多后再考虑做多';
    stop = null; target = null;
  } else if (strategy === 'energy-leader' && leader && leader.dir) {
    // 趋势极性约束: 逆势领跑仅当 独一档且能量≥70 才允许覆盖方向(顺势领跑/趋势未明直接用)
    const isBuy = leader.dir === 'buy';
    const aligned = up == null || (up === true) === isBuy;
    const strongOverride = leader.isClear && leader.score >= 70;
    if (aligned || strongOverride) {
      dir = isBuy ? '做多' : '做空';
      base = Math.max(40, Math.min(70, leader.score));
      reason = '策略[能量领跑]: ' + leader.tf + ' 能量 ' + leader.score + ' ' + (isBuy ? '偏多' : '偏空') + '领跑' + (aligned ? ', 与方向基准一致 → 顺势' : ', 逆势独一档高能, 短线动能反转');
      entryCue = '等 ' + (confirm.tf || '短周期') + ' ' + (confirm.isHook ? (isBuy ? '金钩' : '死钩') : (isBuy ? '金叉' : '死叉')) + '确认 + 价格企稳';
      stop = p - (isBuy ? 1.5 : -1.5) * atrP;
      target = trend.e20 != null && (isBuy ? trend.e20 > p : trend.e20 < p) ? trend.e20 : (isBuy ? p * 1.02 : p * 0.98);
    } else {
      // 弱逆势领跑不覆盖 → 回落到趋势基线逻辑
      if (up === true && mainRow.zone === 'oversold') { dir = '做多'; base = 70; reason = '方向基准向上 + ' + mainTFUse + '超卖回调 → 顺势低吸(策略能量领跑, 但领跑' + leader.tf + '弱逆势不覆盖)'; entryCue = '等 ' + (confirm.tf || '短周期') + ' ' + (confirm.isHook ? '金钩' : '金叉') + '确认 + 价格企稳'; stop = p - 1.5 * atrP; target = trend.e20 != null && trend.e20 > p ? trend.e20 : p * 1.02; }
      else if (up === true) { dir = '做多(观察)'; base = 45; reason = '方向基准向上, 领跑' + leader.tf + '能量' + leader.score + '偏空但不够强(需≥70独一档) → 不逆势, 等回调'; entryCue = '回踩 ' + mainTFUse + ' 支撑或 EMA20 再考虑'; stop = p - 1.0 * atrP; target = trend.e20 != null && trend.e20 > p ? trend.e20 : p * 1.02; }
    }
  } else if (strategy === 'freshest-signal' && confirm.dir) {
    // 趋势极性约束: 逆势动量仅当已确认(≤3根) 才覆盖; 顺势直接用
    const isBuy = confirm.dir === 'buy';
    const aligned = up == null || (up === true) === isBuy;
    if (aligned || confirmed) {
      dir = isBuy ? '做多' : '做空';
      base = 70;
      reason = '策略[动量跟随]: ' + confirm.tf + ' ' + dirName(confirm.dir, confirm.isHook) + ' ' + confirm.fresh + '根前(最新信号)' + (aligned ? ', 与方向基准一致' : ', 已确认动量反转');
      entryCue = (confirm.isHook ? (isBuy ? '金钩' : '死钩') : (isBuy ? '金叉' : '死叉')) + '已确认, 顺势入场';
      stop = p - (isBuy ? 1.0 : -1.0) * atrP;
      target = trend.e20 != null && (isBuy ? trend.e20 > p : trend.e20 < p) ? trend.e20 : (isBuy ? p * 1.02 : p * 0.98);
    } else if (up === false) {
      dir = '做空(观察)'; base = 45; reason = '方向基准向下, ' + confirm.tf + '动量偏多但已' + confirm.fresh + '根前未确认 → 不逆势, 等反弹'; entryCue = '反弹至 ' + mainTFUse + ' 压力或 EMA20 再考虑'; stop = p + 1.0 * atrP; target = trend.e20 != null && trend.e20 < p ? trend.e20 : p * 0.98;
    }
  } else if (trend.flat) {
    dir = '观望'; base = 30;
    reason = '方向基准(' + trendTF + ') EMA 价差仅 ' + trend.spreadPct.toFixed(2) + '% < 死区 ' + deadZone.toFixed(2) + '%, 无明确趋势 → 观望';
    entryCue = '等 ' + trendTF + ' 价差突破死区(' + deadZone.toFixed(2) + '%) 或 SRSI 共振确认';
  } else if (up === true && mainRow.zone === 'oversold') {
    dir = '做多'; base = 70; reason = '方向基准向上 + ' + mainTFUse + '超卖回调 → 顺势低吸';
    entryCue = '等 ' + (confirm.tf || '短周期') + ' ' + (confirm.isHook ? '金钩' : '金叉') + '确认 + 价格企稳';
    stop = p - 1.5 * atrP;
    target = trend.e20 != null && trend.e20 > p ? trend.e20 : p * 1.02;
  } else if (up === false && mainRow.zone === 'overbought') {
    dir = '做空'; base = 70; reason = '方向基准向下 + ' + mainTFUse + '超买反弹 → 顺势做空';
    entryCue = '等 ' + (confirm.tf || '短周期') + ' ' + (confirm.isHook ? '死钩' : '死叉') + '确认 + 价格滞涨';
    stop = p + 1.5 * atrP;
    target = trend.e20 != null && trend.e20 < p ? trend.e20 : p * 0.98;
  } else if (up === true) {
    dir = '做多(观察)'; base = 45; reason = '方向基准向上, 但主周期未超卖, 等回调';
    entryCue = '回踩 ' + mainTFUse + ' 支撑或 EMA20 再考虑';
    stop = p - 1.0 * atrP;
    target = trend.e20 != null && trend.e20 > p ? trend.e20 : p * 1.02;
  } else if (up === false) {
    dir = '做空(观察)'; base = 45; reason = '方向基准向下, 但主周期未超买, 等反弹';
    entryCue = '反弹至 ' + mainTFUse + ' 压力或 EMA20 再考虑';
    stop = p + 1.0 * atrP;
    target = trend.e20 != null && trend.e20 < p ? trend.e20 : p * 0.98;
  }

  // 置信度修正
  let conf = base;
  const confParts = [];
  if (verdict === '一致偏多' && dir.startsWith('做多')) { conf += 10; confParts.push('多周期一致+10'); }
  else if (verdict === '一致偏空' && dir.startsWith('做空')) { conf += 10; confParts.push('多周期一致+10'); }
  else if (verdict === '分歧') { conf -= 15; confParts.push('周期分歧-15'); }
  if (gateWait) {
    // 反向确认已成立 → 观望: 不加分、不当「未确认」, 理由行已说明
  } else if (confirmed) { conf += confirm.isHook ? 15 : 10; confParts.push(confirm.isHook ? '钩确认+15' : '入场已确认+10'); }
  else if (confirm.dir && !confirm.reversed) { conf -= 5; confParts.push('未确认-5'); }
  if (dir.startsWith('做多') && dailyRow.zone === 'overbought') { conf -= 10; confParts.push('日线超买-10'); }
  if (dir.startsWith('做空') && dailyRow.zone === 'oversold') { conf -= 10; confParts.push('日线超卖-10'); }
  // 宏观冲突扣分（方向 vs 宏观 7d/30d 反向）
  const macroPen = conflictPenalty(mt, dir);
  if (macroPen) { conf -= macroPen; confParts.push('宏观反向-' + macroPen); }
  // 能量领跑修正：领跑方向与操作方向一致 → 按能量加分；相反 → 短周期反向动能减分；全线能量枯竭 → 减分
  // （策略为 energy-leader 时 base 已含能量分, 不再重复加分）
  if (strategy !== 'energy-leader' && leader && (dir.startsWith('做多') || dir.startsWith('做空'))) {
    const leadAligned = (dir.startsWith('做多') && leader.dir === 'buy') || (dir.startsWith('做空') && leader.dir === 'sell');
    if (leadAligned) { const add = Math.min(leader.score / 10, 10); conf += add; confParts.push('领跑' + leader.tf + '+' + add); }
    else { conf -= 5; confParts.push('领跑反向-5'); }
  } else if (strategy !== 'energy-leader' && !leader && rows.length && rows.every(r => !r.energy || r.energy.score < 30)) {
    conf -= 5; confParts.push('信号耗尽-5');
  }
  // 反转韧性加/扣分
  if (reversalAdd) { conf += reversalAdd; confParts.push(reversalParts[0]); }
  // 全周期 K>D/D 强信号
  if (periodKAdd) { conf += periodKAdd; confParts.push(periodKAdd > 0 ? '全周期K>D 强势+10' : '全周期K<D 强势-10'); }
  // K-D 间距动能（加速/减弱）
  if (gapAdd) { conf += gapAdd; confParts.push('KD间距动能' + (gapAdd > 0 ? '+' : '') + gapAdd); }
  if (gapParts.length) confParts.push(gapParts.join('/'));
  // 全周期超买/超卖护栏：封顶置信度
  if (periodRisk) { conf = Math.min(conf, 80); }
  conf = Math.max(10, Math.min(90, conf));
  const confLabel = conf >= 70 ? '高' : conf >= 45 ? '中' : '低';

  // 宏观冲突文本（用于额外横幅）
  let macroConflict = null;
  if (mt && mt.up != null && dir.startsWith('做多') && mt.up === false)
    macroConflict = '⚠ 宏观(' + mt.tf + ') EMA 向下与做多方向冲突, 整体观点';
  else if (mt && mt.up != null && dir.startsWith('做空') && mt.up === true)
    macroConflict = '⚠ 宏观(' + mt.tf + ') EMA 向上与做空方向冲突, 整体观点';

  // 信号生命周期/强度（仅呈现层, 统一追加到所有档位 reason 尾部 + 单独 field 供 DOM）
  const life = signalLifecycle(confirm, leader, energyRows);
  if (life && life.txt) reason += '；信号: ' + life.txt;
  if (revNote) reason += '；' + revNote;

  return {
    strategy,
    regime: regimeState ? { type: regimeState.type, label: regimeState.label, strength: regimeState.strength, slopePct: regimeState.slopePct } : null,
    macroConflict,
    conflictNote,
    trend,
    multiTf: { bull, bear, verdict },
    zones,
    confirm: { dir: confirm.dir, fresh: confirm.fresh, tf: confirm.tf, isHook: confirm.isHook, confirmed, contrarian: confirm.contrarian, reversed: confirm.reversed },
    leading: leader ? { tf: leader.tf, dir: leader.dir, score: leader.score, isHook: leader.isHook, isClear: leader.isClear } : null,
    energyRows: energyRows.map(e => ({ tf: e.tf, dir: e.energy.dir, score: e.energy.score, isHook: e.energy.isHook })),
    signalLife: life,
    entry: {
      dir, conf, confLabel, confParts, reason, entryCue, stop, target,
      risk: periodRisk || ((dir.startsWith('做多') && dailyRow.zone === 'overbought') || (dir.startsWith('做空') && dailyRow.zone === 'oversold') ? '中(长周期极端反向)' : '低')
    },
    rules
  };
}

// ---- 画布尺寸同步（DPR）----
function syncCanvasSize() {
  if (!_cv) return;
  const nSub = buildSubList().length;
  const H = BASE_H + nSub * (SUB_H + SUB_GAP);
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  let bw, bh;
  if (typeof _cv.getBoundingClientRect === 'function') {
    const rect = _cv.getBoundingClientRect();
    if (rect.width > 0) {
      bw = Math.max(1, Math.round(rect.width * dpr));
      bh = Math.max(1, Math.round(bw * (H / W)));
    }
  }
  if (!bw || !bh) { bw = W * dpr; bh = H * dpr; }
  _cv.__logicalH = H;
  if (bw === _cv.width && bh === _cv.height) return;
  _cv.width = bw;
  _cv.height = bh;
  _ctx = _cv.getContext('2d');
  _ctx.setTransform(bw / W, 0, 0, bh / H, 0, 0);
}

export function renderKChart() {
  syncCanvasSize();
  renderQuickTrade();
  if (!_ctx) return;
  const S = window.S;
  const sym = cfg.symbol;
  const ctx = _ctx;
  const H = _cv.__logicalH || BASE_H;
  let bg = '#0a0e17';
  try { bg = getComputedStyle(document.body).backgroundColor || '#0a0e17'; } catch (e) {}
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // 主图周期
  const tf = cfg.mainTF;
  const mainOk = drawMain(ctx, sym, tf, H);
  if (!mainOk) { drawEmpty(ctx, H, '等待 K 线数据（' + tf + '）...'); return; }

  // 子图
  const subList = buildSubList();
  let y0 = PAD_T + MAIN_H + 6;
  const regs = [];
  subList.forEach((sub, idx) => {
    const y1 = y0 + SUB_H;
    drawSub(ctx, sub, sym, y0);
    regs.push({ key: sub.key, tf: sub.tf, y0, y1, idx });
    // 标题栏（可拖拽）
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(PAD_L + 2, y0 + 2, PAD_L, SUB_GAP - 6);
    if (_drag && _suppressClick && _drag.fromIdx === idx) {
      ctx.strokeStyle = 'rgba(0,230,118,0.9)';
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(PAD_L, y0, W - PAD_L - PAD_R, SUB_H);
      ctx.setLineDash([]);
    }
    y0 = y1 + SUB_GAP;
  });
  _subRegions = regs;

  // 拖拽指示线
  if (_drag && _drag.moved && _drag.curY != null) {
    ctx.strokeStyle = 'rgba(0,230,118,0.8)';
    ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(PAD_L, _drag.curY); ctx.lineTo(W - PAD_R, _drag.curY); ctx.stroke();
    ctx.setLineDash([]);
  }

  if (_hover) drawHover(ctx, subList, H);
  // 方向基准死区状态推进（renderSrsiOverview / renderTradeDiscipline 共用同一 deadZone）
  // 方向基准固定 ≤4h（THRESH.HORIZON_CAP_MIN=240）。7d/30d 永远只做宏观冲突扣分，
  // 不因主周期(mainTF)上探而改为更长周期——避免"主周期=1d"时方向基准跳到日线级、
  // 与 AGENTS.md 5.28「方向基准≤4h、7d/30d归宏观带」口径不一致。
  const capMin = THRESH.HORIZON_CAP_MIN;
  const allPriceMap = {};
  KLINE_TF.forEach(tf => { const d = getTFData(sym, tf); if (d.c && d.c.length) allPriceMap[tf] = d.c; });
  const hz = updateHorizonState(sym, allPriceMap, capMin);
  renderSrsiOverview(hz, capMin);
  renderTradeDiscipline(hz, capMin);
}

// 轻量面板实时刷新：仅重算「方向基准死区 + 速览 + 纪律分析」DOM，不重绘画布。
// 供主系统 / PWA 的周期 tick 调用（renderKChart 每帧都重绘画布较贵，此处只刷面板）。
export function refreshPanels() {
  const box = document.getElementById('kchartDisc');
  const ov = document.getElementById('kchartOverview');
  if (!box && !ov) return;
  const S = window.S;
  if (!S || !cfg.symbol) return;
  const capMin = THRESH.HORIZON_CAP_MIN;
  const allPriceMap = {};
  KLINE_TF.forEach(tf => { const d = getTFData(cfg.symbol, tf); if (d.c && d.c.length) allPriceMap[tf] = d.c; });
  const hz = updateHorizonState(cfg.symbol, allPriceMap, capMin);
  if (ov) renderSrsiOverview(hz, capMin);
  if (box) renderTradeDiscipline(hz, capMin);
}

function getTFData(sym, tf) {
  const S = window.S;
  const o = (S.klinesO && S.klinesO[sym] && S.klinesO[sym][tf]) || [];
  const h = (S.klinesH && S.klinesH[sym] && S.klinesH[sym][tf]) || [];
  const l = (S.klinesL && S.klinesL[sym] && S.klinesL[sym][tf]) || [];
  const c = (S.klines && S.klines[sym] && S.klines[sym][tf]) || [];
  const v = (S.klinesV && S.klinesV[sym] && S.klinesV[sym][tf]) || [];
  const t = (S.klinesT && S.klinesT[sym] && S.klinesT[sym][tf]) || [];
  return { o, h, l, c, v, t };
}

// 全部 KLINE_TF 的收盘序列 map（方向基准/宏观带用，不受勾选影响）
function allPriceMapOf(sym) {
  const m = {};
  KLINE_TF.forEach(tf => { const c = getTFData(sym, tf).c; if (c && c.length) m[tf] = c; });
  return m;
}

// ---- 主图蜡烛 ----
function drawMain(ctx, sym, tf, H) {
  const S = window.S;
  const { o, h, l, c, t } = getTFData(sym, tf);
  const bars = cfg.bars;
  const n = Math.min(bars, c.length);
  if (n < 2) return false;
  const start = c.length - n;
  const plotW = W - PAD_L - PAD_R;
  const mainBottom = PAD_T + MAIN_H;
  const xStep = plotW / n;
  const cw = Math.max(1, xStep * 0.72);

  let lo = Infinity, hi = -Infinity;
  for (let i = start; i < c.length; i++) {
    if (l[i] != null && isFinite(l[i]) && l[i] < lo) lo = l[i];
    if (h[i] != null && isFinite(h[i]) && h[i] > hi) hi = h[i];
  }
  if (!isFinite(lo) || !isFinite(hi) || hi <= lo) { lo = c[c.length - 1] * 0.999; hi = c[c.length - 1] * 1.001; }
  const pad = (hi - lo) * 0.08 || hi * 0.001;
  lo -= pad; hi += pad;
  const Y = (v) => PAD_T + (hi - v) / (hi - lo) * MAIN_H;
  const X = (i) => PAD_L + (i - start) * xStep + xStep / 2;

  // 网格
  drawGrid(ctx, PAD_L, PAD_T, plotW, MAIN_H, 5, (p) => { const v = hi - (p / 100) * (hi - lo); return fmt(v); });

  ctx.save();
  ctx.beginPath(); ctx.rect(PAD_L, PAD_T, plotW, MAIN_H); ctx.clip();
  for (let i = start; i < c.length; i++) {
    const x = X(i), oo = o[i], hh = h[i], ll = l[i], cc = c[i];
    if (cc == null) continue;
    const up = cc >= (oo != null ? oo : cc);
    const col = up ? '#00E676' : '#FF5252';
    const x0 = x - cw / 2;
    if (hh != null && ll != null) {
      ctx.strokeStyle = col; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, Y(hh)); ctx.lineTo(x, Y(ll)); ctx.stroke();
    }
    const yO = Y(oo != null ? oo : cc), yC = Y(cc);
    ctx.fillStyle = col;
    const yTop = Math.min(yO, yC), yBot = Math.max(yO, yC);
    ctx.fillRect(x0, yTop, cw, Math.max(1, yBot - yTop));
  }
  // 最新价虚线
  const last = c[c.length - 1];
  ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.setLineDash([4, 4]);
  const ly = Y(last);
  ctx.beginPath(); ctx.moveTo(PAD_L, ly); ctx.lineTo(W - PAD_R, ly); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#fff'; ctx.font = 'bold 11px monospace';
  ctx.fillText(fmt(last), PAD_L + plotW - 70, Math.max(PAD_T + 8, ly - 3));
  ctx.restore();

  // 标题
  ctx.fillStyle = '#8b95a5'; ctx.font = '9px monospace';
  ctx.fillText(sym + ' · ' + tf + '  最近 ' + n + ' 根', PAD_L + 4, PAD_T + 10);
  return true;
}

// ---- 子图（RSI / SRSI / MACD），SRSI 按勾选周期 ----
function drawSub(ctx, sub, sym, y0) {
  const plotW = W - PAD_L - PAD_R;
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.strokeRect(PAD_L, y0, plotW, SUB_H);

  const S = window.S;
  const price = getTFData(sym, sub.tf || cfg.mainTF).c;

  if (sub.key === 'rsi') {
    const s = subTf(sym, sub.tf || cfg.mainTF);
    drawOscillator(ctx, s && s.series ? s.series.rsi : [], y0, [30, 50, 70], '#ffd740', sub, cfg.bars);
    drawSubTitle(ctx, sub.name, SUB_COLORS.rsi, y0);
  } else if (sub.key === 'macd') {
    const s = subTf(sym, sub.tf || cfg.mainTF);
    drawMacd(ctx, s && s.series ? s.series : null, y0, sub, cfg.bars);
    drawSubTitle(ctx, sub.name, SUB_COLORS.macd, y0);
  } else if (sub.key === 'srsi') {
    const n = Math.min(cfg.bars, price.length);
    if (n < 2) { drawSubTitle(ctx, sub.name, SUB_COLORS.srsi, y0); return; }
    const sl = srsiPanelSeries(price, cfg.srsi, n);
    drawSrsiPanel(ctx, { k: sl.k, d: sl.d, hooks: sl.hooks }, sl.crossings, y0, n, sub);
    // 标题：SRSI 周期  Kxx.x Dxx.x ▲金叉/▼死叉  [主图]
    const k = sl.k.length ? sl.k[sl.k.length - 1] : null;
    const d = sl.d.length ? sl.d[sl.d.length - 1] : null;
    const st = srsiSignal(k, sl.k.length > 1 ? sl.k[sl.k.length - 2] : null, { overbought: cfg.srsi.overbought, oversold: cfg.srsi.oversold });
    let title = sub.name;
    title += '  K' + (k != null ? k.toFixed(1) : '--') + ' D' + (d != null ? d.toFixed(1) : '--');
    if (st.crossing === 'buy') title += ' ▲金叉';
    else if (st.crossing === 'sell') title += ' ▼死叉';
    if (sub.tf === cfg.mainTF) title += '  [主图]';
    drawSubTitle(ctx, title, SUB_COLORS.srsi, y0);
  }
}

function drawSubTitle(ctx, text, color, y0) {
  ctx.fillStyle = color || '#fff';
  ctx.font = 'bold 9px monospace';
  ctx.fillText(text, PAD_L + 4, y0 + 12);
}

// 纯函数：SRSI 面板序列。为避免 RSI(默认85) 长 warmup 吃掉窗口前部导致 KD 只画右侧/10m 完全不显示，
// 先对全量 price 计算 srsiKD，再只截取最近 bars 根用于展示（warmup 用前面历史）。
// 返回 { k, d, crossings }（均已切到最后 bars 根，索引 0..bars-1，可直接按 0 基画）。
export function srsiPanelSeries(price, cfg, bars) {
  const p = Array.isArray(price) ? price : [];
  const n = Math.min(bars, p.length);
  if (!(n >= 2)) return { k: [], d: [], crossings: [] };
  const sl = srsiKD(p, cfg);
  const cross = srsiCrossings(sl.k, cfg);
  const hooks = srsiHooks(sl.k, sl.d, cfg);
  return {
    k: sl.k.slice(-n),
    d: sl.d.slice(-n),
    crossings: cross.slice(-n),
    hooks: hooks.slice(-n)
  };
}

function subTf(sym, tf) {
  const S = window.S;
  return (S.indicators[sym] && S.indicators[sym][tf]) || null;
}

function drawOscillator(ctx, data, y0, refs, color, sub, bars) {
  const n = Math.min(bars, data.length);
  if (n < 2) return;
  const start = data.length - n;
  const plotW = W - PAD_L - PAD_R;
  const xStep = plotW / n;
  const Y = (v) => y0 + (100 - v) / 100 * SUB_H;
  const X = (i) => PAD_L + (i - start) * xStep + xStep / 2;
  refs.forEach(r => {
    const y = Y(r);
    ctx.strokeStyle = r === 50 ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.12)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(PAD_L, y); ctx.lineTo(PAD_L + plotW, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.font = '8px monospace';
    ctx.fillText(String(r), PAD_L + plotW - 18, y - 2);
  });
  ctx.save();
  ctx.beginPath(); ctx.rect(PAD_L, y0, plotW, SUB_H); ctx.clip();
  ctx.strokeStyle = color; ctx.lineWidth = 1.3;
  ctx.beginPath();
  let started = false;
  for (let i = start; i < data.length; i++) {
    const v = data[i];
    if (v == null) { started = false; continue; }
    const x = X(i), y = Y(v);
    if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();
  const cur = data[data.length - 1];
  if (cur != null) {
    ctx.fillStyle = color; ctx.font = 'bold 9px monospace';
    ctx.fillText(fmt(cur), PAD_L + plotW - 46, y0 + SUB_H - 4);
  }
}

function drawMacd(ctx, series, y0, sub, bars) {
  if (!series) return;
  const data = series.macdLine;
  const n = Math.min(bars, data.length);
  if (n < 2) return;
  const start = data.length - n;
  const plotW = W - PAD_L - PAD_R;
  const xStep = plotW / n;
  let m = 1;
  const abs = [];
  for (let i = start; i < series.macdHist.length; i++) { const v = series.macdHist[i]; if (v != null && isFinite(v)) abs.push(Math.abs(v)); }
  if (abs.length) m = Math.max(...abs);
  if (!m) m = 1;
  const lo = -m * 1.1, hi = m * 1.1;
  const Y = (v) => y0 + (hi - v) / (hi - lo) * SUB_H;
  const X = (i) => PAD_L + (i - start) * xStep + xStep / 2;
  const y0z = Y(0);
  ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(PAD_L, y0z); ctx.lineTo(PAD_L + plotW, y0z); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.font = '8px monospace';
  ctx.fillText('0', PAD_L + plotW - 12, y0z - 2);
  ctx.save();
  ctx.beginPath(); ctx.rect(PAD_L, y0, plotW, SUB_H); ctx.clip();
  const bw = Math.max(1, xStep * 0.6);
  for (let i = start; i < series.macdHist.length; i++) {
    const v = series.macdHist[i];
    if (v == null) continue;
    const x = X(i);
    ctx.fillStyle = v >= 0 ? 'rgba(255,82,82,0.6)' : 'rgba(0,230,118,0.6)';
    ctx.fillRect(x - bw / 2, Math.min(Y(v), y0z), bw, Math.max(1, Math.abs(Y(v) - y0z)));
  }
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.2;
  ctx.beginPath(); let started = false;
  for (let i = start; i < data.length; i++) { const v = data[i]; if (v == null) { started = false; continue; } const x = X(i), y = Y(v); if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y); }
  ctx.stroke();
  if (series.macdSignal) {
    ctx.strokeStyle = '#ffd740'; ctx.lineWidth = 1.1;
    ctx.beginPath(); started = false;
    for (let i = start; i < series.macdSignal.length; i++) { const v = series.macdSignal[i]; if (v == null) { started = false; continue; } const x = X(i), y = Y(v); if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y); }
    ctx.stroke();
  }
  ctx.restore();
}

function drawSrsiPanel(ctx, sl, crossings, y0, n, sub) {
  const plotW = W - PAD_L - PAD_R;
  const xStep = plotW / n;
  const Y = (v) => y0 + (100 - v) / 100 * SUB_H;
  const X = (i) => PAD_L + i * xStep + xStep / 2;
  const ob = cfg.srsi.overbought, os = cfg.srsi.oversold;
  // 超买/超卖带
  ctx.fillStyle = 'rgba(255,82,82,0.10)';
  ctx.fillRect(PAD_L, Y(100), plotW, Y(ob) - Y(100));
  ctx.fillStyle = 'rgba(0,230,118,0.10)';
  ctx.fillRect(PAD_L, Y(0), plotW, Y(os) - Y(0));
  [50, ob, os].forEach(r => {
    const y = Y(r);
    ctx.strokeStyle = r === 50 ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.14)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(PAD_L, y); ctx.lineTo(PAD_L + plotW, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.font = '8px monospace';
    ctx.fillText(String(r), PAD_L + plotW - 18, y - 2);
  });
  ctx.save();
  ctx.beginPath(); ctx.rect(PAD_L, y0, plotW, SUB_H); ctx.clip();
  const mk = (arr, color, w) => {
    ctx.strokeStyle = color; ctx.lineWidth = w; ctx.beginPath();
    let started = false;
    for (let i = 0; i < arr.length; i++) { const v = arr[i]; if (v == null) { started = false; continue; } const x = X(i), y = Y(v); if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y); }
    ctx.stroke();
  };
  mk(sl.k, '#ffffff', 1.4);
  mk(sl.d, '#ffd740', 1.0);
  // 穿越信号
  for (let i = 0; i < crossings.length; i++) {
    const c = crossings[i];
    if (!c) continue;
    const x = X(i), y = Y(sl.k[i]);
    const sz = 6;
    if (c === 'buy') {
      ctx.fillStyle = '#00E5FF';
      ctx.beginPath(); ctx.moveTo(x, y - sz); ctx.lineTo(x - sz * 0.6, y + sz * 0.6); ctx.lineTo(x + sz * 0.6, y + sz * 0.6); ctx.closePath(); ctx.fill();
    } else {
      ctx.fillStyle = '#FFB300';
      ctx.beginPath(); ctx.moveTo(x, y + sz); ctx.lineTo(x - sz * 0.6, y - sz * 0.6); ctx.lineTo(x + sz * 0.6, y - sz * 0.6); ctx.closePath(); ctx.fill();
    }
  }
  // 钩标记（死钩/金钩）：红/绿菱形 ◆，区别于上方 cyan/amber 三角（带穿越）
  for (let i = 0; i < sl.hooks.length; i++) {
    const h = sl.hooks[i];
    if (!h) continue;
    const x = X(i), y = Y(sl.k[i]);
    const sz = 5;
    ctx.fillStyle = h === 'deathHook' ? '#FF5252' : '#00E676';
    ctx.beginPath();
    ctx.moveTo(x, y - sz); ctx.lineTo(x + sz, y); ctx.lineTo(x, y + sz); ctx.lineTo(x - sz, y); ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  // 当前值
  const curK = sl.k[sl.k.length - 1], curD = sl.d[sl.d.length - 1];
  if (curK != null) {
    ctx.font = 'bold 9px monospace';
    ctx.fillStyle = '#fff'; ctx.fillText('K:' + fmt(curK), PAD_L + plotW - 96, y0 + SUB_H - 4);
    ctx.fillStyle = '#ffd740'; ctx.fillText('D:' + fmt(curD), PAD_L + plotW - 46, y0 + SUB_H - 4);
  }
}

// ---- 悬停：十字线 + 主图价 line + 顶部联动汇总栏 + 命中面板浮动详情 ----
function drawHover(ctx, subList, H) {
  const { lx, ly } = _hover;
  const plotW = W - PAD_L - PAD_R;
  if (lx < PAD_L || lx > PAD_L + plotW || ly < PAD_T) return;
  const mainBottom = PAD_T + MAIN_H;
  const tf = cfg.mainTF;
  const sym = cfg.symbol;
  const { o, h, l, c, v, t } = getTFData(sym, tf);
  const bars = cfg.bars;
  const frac = (lx - PAD_L) / plotW;
  const i = idxFromFrac(frac, c.length, bars);
  const n = Math.min(bars, c.length);
  const start = c.length - n;
  const xStep = plotW / n;

  // ---- 十字竖线（贯穿全高）----
  ctx.save();
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(lx, PAD_T); ctx.lineTo(lx, H - PAD_B); ctx.stroke();
  ctx.restore();

  // ---- 主图：横虚线 + 价格 chip（hovered 柱 close）----
  if (i >= 0 && i < c.length && c[i] != null) {
    let lo = Infinity, hi = -Infinity;
    for (let k = start; k < c.length; k++) {
      if (l[k] != null && isFinite(l[k]) && l[k] < lo) lo = l[k];
      if (h[k] != null && isFinite(h[k]) && h[k] > hi) hi = h[k];
    }
    if (!isFinite(lo) || !isFinite(hi) || hi <= lo) { lo = c[i] * 0.999; hi = c[i] * 1.001; }
    const pad = (hi - lo) * 0.08 || hi * 0.001;
    lo -= pad; hi += pad;
    const Y = (val) => PAD_T + (hi - val) / (hi - lo) * MAIN_H;
    const yc = Y(c[i]);
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath(); ctx.moveTo(PAD_L, yc); ctx.lineTo(W - PAD_R, yc); ctx.stroke();
    ctx.restore();
    // 价格 chip
    ctx.fillStyle = 'rgba(8,12,20,0.9)';
    ctx.fillRect(PAD_L + plotW - 64, yc - 7, 60, 12);
    ctx.fillStyle = (c[i] >= (o[i] != null ? o[i] : c[i])) ? '#00E676' : '#FF5252';
    ctx.font = '9px monospace';
    ctx.fillText(fmt(c[i]), PAD_L + plotW - 60, yc + 1);
  }

  // ---- 顶部联动汇总栏（任意位置都显示：主图 + 全部子图 在 hovered x 的读数）----
  const m = i >= 0 ? mainHoverAt(frac, sym, tf, bars) : null;
  drawLinkBar(ctx, subList, m, tf, frac, mainBottom);

  // ---- 命中面板：跟随式浮动详情框 ----
  const hit = panelFromLy(ly, _subRegions, mainBottom);
  if (hit) {
    if (hit.kind === 'main') drawMainDetail(ctx, m, lx, ly, plotW, H);
    else if (hit.kind === 'sub') drawSubDetail(ctx, hit, frac, lx, ly, plotW, H, bars);
  }
}

// 主图 OHLC 浮动详情框
function drawMainDetail(ctx, m, lx, ly, plotW, H) {
  if (!m || m.close == null) return;
  const green = m.close >= (m.open != null ? m.open : m.close);
  const col = green ? '#00E676' : '#FF5252';
  const chg = m.chg != null ? ` ${m.chg >= 0 ? '+' : ''}${m.chg.toFixed(2)}%` : '';
  const lines = [
    '时间  ' + fmtTime(m.time),
    `开 ${fmt(m.open)}  收 ${fmt(m.close)}`,
    `高 ${fmt(m.high)}  低 ${fmt(m.low)}`,
    `量 ${fmtVol(m.vol)}${chg}`
  ];
  drawFloatBox(ctx, lines, lx, ly, plotW, H, { lastCol: col });
}

// 某子图浮动详情框
function drawSubDetail(ctx, hit, frac, lx, ly, plotW, H, bars) {
  const sym = cfg.symbol;
  const tf = hit.tf || cfg.mainTF;
  const d = subHoverAt(frac, sym, tf, hit.key, bars);
  let lines = [];
  let lastCol = '#fff';
  if (hit.key === 'rsi') {
    lines = [`RSI  ${d.rsi != null ? d.rsi.toFixed(2) : '--'}`];
    const r = d.rsi;
    if (r != null) { if (r > 70) lastCol = '#FF5252'; else if (r < 30) lastCol = '#00E676'; else lastCol = '#ffd740'; }
    if (r > 70) lines.push('超买'); else if (r < 30) lines.push('超卖'); else lines.push('中性');
  } else if (hit.key === 'macd') {
    lines = [
      `MACD   ${d.macd != null ? d.macd.toFixed(4) : '--'}`,
      `SIGNAL ${d.signal != null ? d.signal.toFixed(4) : '--'}`,
      `HIST   ${d.hist != null ? d.hist.toFixed(4) : '--'}`
    ];
    if (d.hist != null) lastCol = d.hist >= 0 ? '#FF5252' : '#00E676';
  } else if (hit.key === 'srsi') {
    const cs = d.cross === 'buy' ? '金叉' : d.cross === 'sell' ? '死叉' : '无';
    lines = [
      `K ${d.k != null ? d.k.toFixed(2) : '--'}   D ${d.d != null ? d.d.toFixed(2) : '--'}`,
      '穿越 ' + cs
    ];
    lastCol = d.cross === 'buy' ? '#00E5FF' : d.cross === 'sell' ? '#FFB300' : '#fff';
    if (d.hook === 'deathHook') { lines.push('钩 死钩'); lastCol = '#FF5252'; }
    else if (d.hook === 'goldHook') { lines.push('钩 金钩'); lastCol = '#00E676'; }
  }
  drawFloatBox(ctx, lines, lx, ly, plotW, H, { lastCol });
}

// 通用跟随式浮动框（越界自动翻转），lastCol 用于末行文字着色（如涨跌）
function drawFloatBox(ctx, lines, lx, ly, plotW, H, { lastCol = '#fff' } = {}) {
  if (!lines.length) return;
  ctx.font = '9px monospace';
  let maxW = 0;
  lines.forEach(s => { const w = ctx.measureText(s).width; if (w > maxW) maxW = w; });
  const boxW = maxW + 16, rowH = 13, boxH = lines.length * rowH + 10;
  let bx = lx + 12, by = ly + 12;
  if (bx + boxW > W - 4) bx = lx - boxW - 12;
  if (by + boxH > H - PAD_B) by = ly - boxH - 12;
  if (bx < PAD_L + 2) bx = PAD_L + 2;
  if (by < PAD_T) by = PAD_T;
  ctx.fillStyle = 'rgba(8,12,20,0.94)';
  roundRect(ctx, bx, by, boxW, boxH, 4); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1;
  roundRect(ctx, bx, by, boxW, boxH, 4); ctx.stroke();
  lines.forEach((s, idx) => {
    ctx.fillStyle = idx === lines.length - 1 ? lastCol : '#b8c2d0';
    ctx.fillText(s, bx + 8, by + 14 + idx * rowH);
  });
}

// 顶部联动汇总栏：时间 + 主图OHLC/量 + 各子图读数（命中段高亮，其余置暗）
function drawLinkBar(ctx, subList, m, tf, frac, mainBottom) {
  const sym = cfg.symbol;
  ctx.font = '9px monospace';
  const hit = panelFromLy(_hover.ly, _subRegions, mainBottom);
  let x = PAD_L + 4;
  const y = PAD_T + 36;
  const drawSeg = (text, hl, color) => {
    const w = ctx.measureText(text).width + 10;
    if (x + w > W - PAD_R - 4) return;
    if (hl) {
      ctx.fillStyle = 'rgba(0,230,118,0.18)';
      ctx.fillRect(x - 2, y - 9, w, 13);
      ctx.strokeStyle = 'rgba(0,230,118,0.6)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x - 2, y - 9, w, 13);
    }
    ctx.fillStyle = color || '#b8c2d0';
    ctx.fillText(text, x, y);
    x += w;
  };

  if (m) {
    drawSeg(fmtTime(m.time), false, '#8b95a5');
    const col = m.close >= (m.open != null ? m.open : m.close) ? '#00E676' : '#FF5252';
    const chg = m.chg != null ? ` ${m.chg >= 0 ? '+' : ''}${m.chg.toFixed(2)}%` : '';
    drawSeg(`C ${fmt(m.close)}${chg}`, hit && hit.kind === 'main', col);
    drawSeg(`V ${fmtVol(m.vol)}`, false, '#8b95a5');
  }

  subList.forEach(sub => {
    const dt = subHoverAt(frac, sym, sub.tf || tf, sub.key, cfg.bars);
    const hl = hit && hit.kind === 'sub' && hit.key === sub.key && (hit.tf === sub.tf);
    if (sub.key === 'rsi') {
      drawSeg(`RSI ${dt.rsi != null ? dt.rsi.toFixed(1) : '--'}`, hl, '#ffd740');
    } else if (sub.key === 'macd') {
      const macd = dt.macd != null ? dt.macd.toFixed(3) : '--';
      const hist = dt.hist != null ? dt.hist.toFixed(3) : '--';
      drawSeg(`MACD ${macd}/${hist}`, hl, '#fff');
    } else if (sub.key === 'srsi') {
      const k = dt.k != null ? dt.k.toFixed(1) : '--';
      const d = dt.d != null ? dt.d.toFixed(1) : '--';
      drawSeg(`SRSI${sub.tf ? sub.tf : ''} ${k}/${d}`, hl, '#c58aff');
    }
  });
}

// ---- 交互：hover / 子图拖拽 ----
export function initKChart() {
  _cv = document.getElementById('kchartCanvas');
  if (!_cv) return;
  _cv.style.width = '100%';
  _cv.style.height = 'auto';
  _ctx = _cv.getContext('2d');
  syncCanvasSize();
  if (!_cv.__kchartResizeBound) {
    _cv.__kchartResizeBound = true;
    if (typeof ResizeObserver !== 'undefined') {
      _resizeObs = new ResizeObserver(() => { syncCanvasSize(); renderKChart(); });
      _resizeObs.observe(_cv);
    }
    window.addEventListener && window.addEventListener('resize', () => { syncCanvasSize(); renderKChart(); });
  }
  if (!_cv.__kchartHoverBound) {
    _cv.__kchartHoverBound = true;
    const toLocal = (e) => {
      const rect = _cv.getBoundingClientRect();
      const H = _cv.__logicalH || BASE_H;
      return { lx: (e.clientX - rect.left) * (W / rect.width), ly: (e.clientY - rect.top) * (H / rect.height) };
    };
    _cv.addEventListener('mousemove', (e) => {
      _hover = toLocal(e);
      // 命中标题栏 → 拖拽
      const reg = _subRegions.find(r => _hover.ly >= r.y0 && _hover.ly <= r.y0 + SUB_GAP && _hover.lx >= PAD_L && _hover.lx <= W - PAD_R);
      _cv.style.cursor = reg ? 'grab' : 'crosshair';
      if (_drag) { if (Math.abs(_hover.ly - _drag.startY) > 8) _drag.moved = true; if (_drag.moved) _drag.curY = _hover.ly; _cv.style.cursor = 'grabbing'; renderKChart(); return; }
      renderKChart();
    });
    _cv.addEventListener('mousedown', (e) => {
      const p = toLocal(e);
      const reg = _subRegions.find(r => p.ly >= r.y0 && p.ly <= r.y0 + SUB_GAP && p.lx >= PAD_L && p.lx <= W - PAD_R);
      if (reg) _drag = { fromIdx: reg.idx, startY: p.ly, curY: p.ly, moved: false };
    });
    const endDrag = () => {
      if (_drag && _drag.moved) {
        const target = _subRegions.find(r => _drag.curY >= r.y0 && _drag.curY <= r.y1);
        if (target && target.idx !== _drag.fromIdx) {
          const list = (cfg.subOrder || ['rsi', 'srsi', 'macd']).slice();
          // 将对应子图（可能展开多 SRSI 面板，这里按相对顺序移动整个子图键）
          const keyToMove = _subRegions[_drag.fromIdx] && _subRegions[_drag.fromIdx].key;
          const fromArr = list.indexOf(keyToMove);
          if (fromArr < 0) { _drag = null; return; }
          list.splice(fromArr, 1);
          let toArr = list.indexOf(target.key);
          if (toArr < 0) toArr = list.length;
          list.splice(toArr, 0, keyToMove);
          cfg.subOrder = list;
          persist();
        }
      } else if (_drag && !_drag.moved) {
        // 单击 SRSI 子图标题栏 → 切换主图为该周期
        const reg = _subRegions[_drag.fromIdx];
        if (reg && reg.key === 'srsi' && reg.tf && reg.tf !== cfg.mainTF) {
          setMainTF(reg.tf);
          _drag = null;
          renderKChart();
          return;
        }
      }
      _drag = null;
      renderKChart();
    };
    _cv.addEventListener('mouseup', endDrag);
    window.addEventListener('mouseup', endDrag);
    _cv.addEventListener('mouseleave', () => { _hover = null; renderKChart(); });
  }
  renderKChart();
  bindOverviewClick();
}

// ---- 公共设置 ----
function setSym(sym) { if (!sym) return; cfg.symbol = sym; persist(); renderKChart(); }
function applyKMode(res) {
  if (!res) return;
  if (res.mainTF) cfg.mainTF = res.mainTF;
  cfg.klineSel = res.sel;
  persist();
  renderControls();
  renderKChart();
}
function setMainTF(tf) { if (!KLINE_TF.includes(tf)) return; applyKMode(nextKMode(tf, cfg, 'main')); }
function setKlineSel(tf, on) {
  if (!KLINE_TF.includes(tf)) return;
  const cur = { mainTF: cfg.mainTF, klineSel: { ...cfg.klineSel } };
  cur.klineSel[tf] = !!on;
  applyKMode(nextKMode(tf, cur, 'srsi'));
}
function setKPreset(name) { applyKMode(kPresetCombos(name)); }
function setKOverview(on) { cfg.overviewOpen = !!on; persist(); const wrap = document.getElementById('kchartOverviewWrap'); if (wrap) wrap.classList.toggle('closed', !cfg.overviewOpen); renderControls(); renderKChart(); }
function toggleOverview() { setKOverview(!cfg.overviewOpen); }
function setKDisc(on) { cfg.discOpen = !!on; persist(); const wrap = document.getElementById('kchartDiscWrap'); if (wrap) wrap.classList.toggle('closed', !cfg.discOpen); renderKChart(); }
function toggleKDisc() { setKDisc(!cfg.discOpen); }
function setBars(v) { cfg.bars = Math.max(60, Math.min(300, parseInt(v) || 150)); persist(); renderKChart(); const lbl = document.getElementById('kchartBarsLbl'); if (lbl) lbl.textContent = cfg.bars; }
function setShow(key, on) {
  if (!(key in cfg.show)) return;
  cfg.show[key] = !!on;
  if (!cfg.subOrder) cfg.subOrder = [];
  if (on) { if (!cfg.subOrder.includes(key)) cfg.subOrder.push(key); }
  else cfg.subOrder = cfg.subOrder.filter(k => k !== key);
  persist();
  renderControls();
  renderKChart();
}
function setSrsi(name, v) { if (!(name in cfg.srsi)) return; cfg.srsi[name] = parseInt(v) || DEFAULT_SRSI[name]; persist(); renderKChart(); }
function resetSrsi() { cfg.srsi = { ...DEFAULT_SRSI }; persist(); renderKChart(); window.__renderKControls && window.__renderKControls(); }
export function refreshWith(t) { cfg = t || defaultKConfig(); loadCfg(); persist(); }

// 供 main.js / index.html 暴露
export function kSymbol() { return cfg.symbol; }
export function kConfig() { return cfg; }
export function renderKControls() {
  loadCfg();
  renderControls();
  if (_ctx) { syncCanvasSize(); renderKChart(); }
}

// ---- 工具 ----
function drawGrid(ctx, x0, y0, w, h, rows, labelFn) {
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.fillStyle = '#6b7688';
  ctx.font = '9px monospace';
  for (let r = 0; r <= rows; r++) {
    const y = y0 + (h / rows) * r;
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + w, y); ctx.stroke();
    if (labelFn) { const t = labelFn((r / rows) * 100); ctx.fillText(t, 2, y + 3); }
  }
}
function drawEmpty(ctx, H, msg) {
  ctx.fillStyle = '#6b7688'; ctx.font = '12px monospace';
  ctx.fillText(msg, W / 2 - ctx.measureText(msg).width / 2, H / 2);
}
function fmt(v) {
  if (v == null || !isFinite(v)) return '--';
  if (Math.abs(v) >= 10000) return v.toFixed(0);
  if (Math.abs(v) >= 100) return v.toFixed(2);
  if (Math.abs(v) >= 10) return v.toFixed(2);
  return v.toFixed(4);
}

// ---- hover / 联动读数 纯函数与工具 ----

// 由横向比例 frac(0..1) → 可见窗内柱索引。与绘制一致: start = len - min(bars,len)。
export function idxFromFrac(frac, len, bars) {
  if (!(len > 0)) return -1;
  const n = Math.min(bars, len);
  if (n < 1) return -1;
  const start = len - n;
  const f = Math.max(0, Math.min(1, frac));
  return start + Math.max(0, Math.min(n - 1, Math.round(f * (n - 1))));
}

// 成交量缩写: >=1e6 → 12.3M, >=1e3 → 4.5K, 否则原样(2位小数)
export function fmtVol(v) {
  if (v == null || !isFinite(v)) return '--';
  const a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(2) + 'K';
  return v.toFixed(2);
}

// 时间戳 → 本地字符串 (ts 毫秒)
export function fmtTime(ts) {
  if (ts == null || !isFinite(ts)) return '--:--:--';
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// 命中面板: 由逻辑 ly 判断落在主图 还是 某个子图区域
function panelFromLy(ly, subRegions, mainBottom) {
  if (ly != null && ly >= PAD_T && ly <= mainBottom) return { kind: 'main' };
  if (subRegions) {
    const reg = subRegions.find(r => ly >= r.y0 && ly <= r.y1);
    if (reg) return { kind: 'sub', key: reg.key, tf: reg.tf };
  }
  return null;
}

// 主图 hover 柱信息 (纯数据)
export function mainHoverAt(frac, sym, tf, bars) {
  const { o, h, l, c, v, t } = getTFData(sym, tf);
  const i = idxFromFrac(frac, c.length, bars);
  if (i < 0 || i >= c.length) return null;
  const prev = i > 0 ? c[i - 1] : null;
  const chg = (prev != null && isFinite(prev) && prev !== 0) ? (c[i] - prev) / prev * 100 : null;
  return {
    i, time: t[i], open: o[i], high: h[i], low: l[i], close: c[i], vol: v[i], chg
  };
}

// 某个子图在 frac 处的读数 (纯数据)
export function subHoverAt(frac, sym, tf, key, bars) {
  const lenBase = getTFData(sym, tf).c.length;
  const i = idxFromFrac(frac, lenBase, bars);
  const s = subTf(sym, tf);
  const series = s && s.series;
  if (key === 'rsi') {
    const v = series && series.rsi ? series.rsi[i] : null;
    return { i, rsi: v };
  }
  if (key === 'macd') {
    return {
      i,
      macd: series && series.macdLine ? series.macdLine[i] : null,
      signal: series && series.macdSignal ? series.macdSignal[i] : null,
      hist: series && series.macdHist ? series.macdHist[i] : null
    };
  }
  if (key === 'srsi') {
    const price = getTFData(sym, tf).c;
    const sl = srsiPanelSeries(price, cfg.srsi, bars);
    // srsiPanelSeries 把数组切到最后 bars 根(局部索引 0..n-1)，需把绝对索引 i 换算成局部索引
    const off = Math.max(0, price.length - Math.min(bars, price.length));
    const li = i - off;
    return { i, k: sl.k[li] != null ? sl.k[li] : null, d: sl.d[li] != null ? sl.d[li] : null, cross: sl.crossings[li] || null, hook: sl.hooks[li] || null };
  }
  return { i };
}


// 单测导出
export function __buildSubListFor(tfSel, show, order) { const _old = { cfg, klineSel: cfg.klineSel, show: cfg.show, subOrder: cfg.subOrder }; cfg = { ...cfg, klineSel: tfSel, show, subOrder: order }; const list = buildSubList(); cfg.subOrder = _old.subOrder; return list; }
export function __defaultKConfig() { return defaultKConfig(); }
export function __debugKChart() { return { drag: _drag, hover: _hover, hoverBound: _cv ? _cv.__kchartHoverBound : null, subRegions: _subRegions.map(r => ({ key: r.key, tf: r.tf, y0: r.y0, y1: r.y1, idx: r.idx })) }; }

// 对外设置入口（main.js 挂 window）
export const kchartApi = {
  setSymbol: setSym,
  setMainTF,
  setKlineSel,
  setKKMode: (tf, action) => { if (KLINE_TF.includes(tf)) applyKMode(nextKMode(tf, cfg, action)); },
  setKPreset,
  setKOverview,
  toggleOverview,
  setKDisc,
  toggleKDisc,
  setDiscEvidence: (v) => { cfg.discEvidenceOpen = !!v; persist(); },
  setBars,
  setShow,
  setSrsi,
  resetSrsi: () => { resetSrsi(); },
  renderControls: renderKControls,
  render: renderKChart,
  refreshPanels,
  init: initKChart,
  getConfig: () => cfg,
  defaultConfig: defaultKConfig,
  debug: __debugKChart,
  setTradeEngine,
  setTradeConfig,
  renderQuickTrade,
  checkUserTpSl,
  openOrderManager,
  closeOrderManager,
  reversePosition
};
if (typeof window !== 'undefined') window.kchartApi = kchartApi;

// ===================== 快捷合约交易（纸面）=====================
// 方向定死：空=U本位 / 多=币本位；平仓利润的 50% 自动再投到另一资产。
// 引擎由主系统 / PWA 各自注入(setTradeEngine)，UI 仅依赖 PaperEngine 接口：
//   engine.S.prices[sym].last / engine.S.pos / engine.getPerpSub() / engine.placeOrder / engine.exitPosition
let _tradeEngine = null;
let _tradeOn = true;
let _tradeLinked = true;
let _lev = 10;
let _sizePct = 50;
let _fixedAmt = 100;
let _useFixed = false;
let _safeguard = true;
let _arm = { side: null, t: 0 };

export function setTradeEngine(e) { _tradeEngine = e; renderQuickTrade(); }
export function setTradeConfig(c) {
  if (c) {
    if (typeof c.on === 'boolean') _tradeOn = c.on;
    if (typeof c.linked === 'boolean') _tradeLinked = c.linked;
    if (typeof c.lev === 'number') _lev = c.lev;
  }
  renderQuickTrade();
}

function _fmt(n, d = 2) { return (n == null || isNaN(n)) ? '0' : Number(n).toFixed(d); }
function _tradeBar() { return typeof document !== 'undefined' ? document.getElementById('kchartTradeBar') : null; }

function renderQuickTrade() {
  const bar = _tradeBar();
  if (!bar) return;
  if (!_tradeOn) { bar.innerHTML = '<div class="kt-off">快捷交易已关闭（设置中可开启）</div>'; bar._built = false; return; }
  const sym = cfg.symbol;
  const engine = _tradeEngine;
  let perp = null, price = null, pos = null, usdt = 0, coin = 0;
  if (engine && engine.S) {
    perp = engine.getPerpSub ? engine.getPerpSub() : null;
    price = (engine.S.prices && engine.S.prices[sym] && engine.S.prices[sym].last) || null;
    pos = (engine.S.pos || []).find(p => p.sym === sym);
    if (perp) { usdt = perp.bal || 0; coin = (perp.coins && perp.coins[sym]) || 0; }
  }
  if (!engine) {
    bar.innerHTML = '<div class="kt-off">交易引擎未连接</div>';
    bar._built = false;
    return;
  }
  const armShort = _safeguard && _arm.side === 'short' && Date.now() - _arm.t < 3000;
  const armLong = _safeguard && _arm.side === 'long' && Date.now() - _arm.t < 3000;
  const armClose = _safeguard && _arm.side === 'close' && Date.now() - _arm.t < 3000;
  // 首次构建骨架(含监听)，之后仅就地更新动态值，避免每次 render 重建按钮导致真实点击失效
  if (!bar._built) {
    bar.innerHTML = `
    <div class="kt-row">
      <span class="kt-label">杠杆</span>
      <input id="ktLev" class="kt-lev" type="range" min="1" max="30" />
      <span id="ktLevV" class="kt-val"></span>
      <label class="kt-toggle"><input id="ktFixed" type="checkbox"/>固定数额</label>
      <span id="ktSizeWrap" class="kt-size">
        <input id="ktPct" class="kt-pct" type="range" min="1" max="100" />
        <span id="ktPctV" class="kt-val"></span>
        <input id="ktFixedAmt" class="kt-amt" type="number" min="0" step="any" />
      </span>
      <label class="kt-toggle"><input id="ktSafe" type="checkbox"/>防误触</label>
    </div>
    <div class="kt-row">
      <span id="ktAvail" class="kt-avail"></span>
      <span id="ktPrice" class="kt-price"></span>
    </div>
    <div class="kt-row kt-btns">
      <button id="ktShort" class="kt-btn kt-short"></button>
      <button id="ktLong" class="kt-btn kt-long"></button>
      <button id="ktClose" class="kt-btn kt-close"></button>
      <button id="ktOrders" class="kt-btn kt-orders"></button>
    </div>
    <div id="ktPos" class="kt-row kt-pos"></div>`;
    const b = bar;
    b.querySelector('#ktLev').addEventListener('input', () => { _lev = +b.querySelector('#ktLev').value; b.querySelector('#ktLevV').textContent = _lev + 'x'; });
    b.querySelector('#ktFixed').addEventListener('change', () => { _useFixed = b.querySelector('#ktFixed').checked; renderQuickTrade(); });
    b.querySelector('#ktPct').addEventListener('input', () => { _sizePct = +b.querySelector('#ktPct').value; b.querySelector('#ktPctV').textContent = _sizePct + '%'; });
    b.querySelector('#ktFixedAmt').addEventListener('input', () => { _fixedAmt = parseFloat(b.querySelector('#ktFixedAmt').value) || 0; });
    b.querySelector('#ktSafe').addEventListener('change', () => { _safeguard = b.querySelector('#ktSafe').checked; });
    b.querySelector('#ktShort').addEventListener('click', () => kchartTradeOpen('short'));
    b.querySelector('#ktLong').addEventListener('click', () => kchartTradeOpen('long'));
    b.querySelector('#ktClose').addEventListener('click', () => kchartTradeClose());
    b.querySelector('#ktOrders').addEventListener('click', () => openOrderManager());
    bar._built = true;
  }
  // ---- 就地更新动态值（不重建 DOM，按钮/监听保持存活）----
  const q = (id) => bar.querySelector('#' + id);
  q('ktLev').value = _lev; q('ktLevV').textContent = _lev + 'x';
  q('ktFixed').checked = _useFixed; q('ktSafe').checked = _safeguard;
  q('ktPct').value = _sizePct; q('ktPctV').textContent = _sizePct + '%';
  q('ktFixedAmt').value = _fixedAmt;
  q('ktPct').style.display = _useFixed ? 'none' : '';
  q('ktPctV').style.display = _useFixed ? 'none' : '';
  q('ktFixedAmt').style.display = _useFixed ? '' : 'none';
  q('ktAvail').innerHTML = `可用USDT <b>${_fmt(usdt)}</b> · 可用${sym} <b>${_fmt(coin, 6)}</b>`;
  q('ktPrice').textContent = price ? '价 $' + _fmt(price) : '无行情';
  const bS = q('ktShort'); bS.textContent = armShort ? '确认开空?' : 'U本位 开空'; bS.classList.toggle('armed', armShort);
  const bL = q('ktLong'); bL.textContent = armLong ? '确认开多?' : '币本位 开多'; bL.classList.toggle('armed', armLong);
  const bC = q('ktClose'); bC.textContent = armClose ? '确认平仓?' : '平仓'; bC.classList.toggle('armed', armClose); bC.disabled = !pos;
  q('ktOrders').textContent = '持仓(' + ((engine && engine.S && engine.S.pos) ? engine.S.pos.length : 0) + ')';
  q('ktPos').innerHTML = pos
    ? `持仓: <b class="${pos.side === 'long' ? 'up' : 'down'}">${pos.side === 'long' ? '多单' : '空单'}</b> ${pos.lev}x @ $${_fmt(pos.entry)} · 浮盈 $${_fmt(pos.pnl)} · ${pos.marginMode === 'coin' ? '币本位' : 'U本位'}${pos.reinvest ? ' · 50%再投' : ''}`
    : '当前币无持仓';
}

function kchartTradeOpen(side) {
  if (!_tradeOn || !_tradeEngine) return;
  const sym = cfg.symbol;
  const mm = side === 'short' ? 'usdt' : 'coin';
  const engine = _tradeEngine;
  const sub = engine.getPerpSub ? engine.getPerpSub() : null;
  if (!sub) { if (typeof alert === 'function') alert('未初始化模拟账户（请先设置初始资金）'); return; }
  const price = (engine.S.prices && engine.S.prices[sym] && engine.S.prices[sym].last);
  if (!price) { if (typeof alert === 'function') alert('无行情价，无法开仓'); return; }
  if (_safeguard) {
    const now = Date.now();
    if (_arm.side !== side || now - _arm.t > 3000) { _arm = { side, t: now }; renderQuickTrade(); return; }
    _arm = { side: null, t: 0 };
  }
  const available = mm === 'coin' ? ((sub.coins && sub.coins[sym]) || 0) : (sub.bal || 0);
  const amt = _useFixed ? (parseFloat(_fixedAmt) || 0) : available * _sizePct / 100;
  if (amt <= 0) { if (typeof alert === 'function') alert('可用保证金不足'); return; }
  engine.placeOrder({ symbol: sym, side, lev: _lev, amt, marginMode: mm, reinvest: true, sub: sub.id });
  renderQuickTrade();
}

function kchartTradeClose() {
  if (!_tradeEngine) return;
  const sym = cfg.symbol;
  const pos = (_tradeEngine.S.pos || []).find(p => p.sym === sym);
  if (!pos) return;
  if (_safeguard) {
    const now = Date.now();
    if (_arm.side !== 'close' || now - _arm.t > 3000) { _arm = { side: 'close', t: now }; renderQuickTrade(); return; }
    _arm = { side: null, t: 0 };
  }
  _tradeEngine.exitPosition(pos, { reason: '手动平仓' });
  renderQuickTrade();
}

// ===================== 订单管理（对冲模式：同币可多空并存，列出全部持仓）=====================
let _omOpen = false;
let _omTimer = null;

// 纯函数：按用户设置的 TP/SL 价位点触发平仓；返回触发笔数。engine 需提供 .S 与 .exitPosition
function checkUserTpSl(engine) {
  if (!engine) return 0;
  const S = engine.S;
  if (!S || !S.pos || !S.pos.length) return 0;
  let n = 0;
  for (let i = S.pos.length - 1; i >= 0; i--) {
    const pos = S.pos[i];
    const c = (S.prices[pos.sym] || {}).last;
    if (!c) continue;
    let hit = null;
    if (pos.tp != null) {
      if ((pos.side === 'long' && c >= pos.tp) || (pos.side === 'short' && c <= pos.tp)) hit = '止盈';
    }
    if (!hit && pos.sl != null) {
      if ((pos.side === 'long' && c <= pos.sl) || (pos.side === 'short' && c >= pos.sl)) hit = '止损';
    }
    if (hit) { engine.exitPosition(pos, { reason: '用户' + hit }); n++; }
  }
  return n;
}

// 反手：平掉当前仓，并按同参数开反向仓
function reversePosition(engine, pos) {
  if (!engine || !pos) return;
  engine.exitPosition(pos, { reason: '反手平仓' });
  engine.placeOrder({
    symbol: pos.sym, side: pos.side === 'long' ? 'short' : 'long',
    lev: pos.lev, marginMode: pos.marginMode, reinvest: !!pos.reinvest,
    sub: pos.sid, amt: pos.amt
  });
}

function _buildOrderMgrModal() {
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.id = 'orderMgrModal';
  ov.innerHTML = `
    <div class="modal order-mgr">
      <div class="om-head">
        <h3>订单管理 <span id="omCount" class="om-count"></span></h3>
        <div class="om-head-btns">
          <button id="omCloseAll" class="btn btn-sell btn-sm">一键全平</button>
          <button id="omClose" class="btn btn-sm">关闭</button>
        </div>
      </div>
      <div class="om-cols">
        <span>交易对</span><span>方向</span><span>模式</span><span>杠杆</span><span>开仓价</span>
        <span>标记价</span><span>浮盈</span><span>TP</span><span>SL</span><span>操作</span>
      </div>
      <div id="omRows" class="om-rows"></div>
      <div id="omEmpty" class="om-empty">暂无持仓</div>
    </div>`;
  document.body.appendChild(ov);
  ov.addEventListener('click', (e) => { if (e.target === ov) closeOrderManager(); });
  ov.querySelector('#omClose').addEventListener('click', closeOrderManager);
  ov.querySelector('#omCloseAll').addEventListener('click', () => {
    if (!_tradeEngine) return;
    (_tradeEngine.S.pos || []).slice().forEach(p => _tradeEngine.exitPosition(p, { reason: '一键全平' }));
    _renderOrderMgr(); renderQuickTrade();
  });
  const rows = ov.querySelector('#omRows');
  rows.addEventListener('click', (e) => {
    const row = e.target.closest('.om-row'); if (!row) return;
    const oid = row.dataset.oid;
    const pos = (_tradeEngine.S.pos || []).find(p => p.orderId === oid);
    if (!pos) return;
    if (e.target.classList.contains('om-close')) { _tradeEngine.exitPosition(pos, { reason: '手动平仓(管理)' }); _renderOrderMgr(); renderQuickTrade(); }
    else if (e.target.classList.contains('om-partial')) { _tradeEngine.closePartial(pos, { ratio: 0.5, reason: '部分平仓(管理)' }); _renderOrderMgr(); renderQuickTrade(); }
    else if (e.target.classList.contains('om-rev')) { reversePosition(_tradeEngine, pos); _renderOrderMgr(); renderQuickTrade(); }
  });
  rows.addEventListener('change', (e) => {
    const row = e.target.closest('.om-row'); if (!row) return;
    const oid = row.dataset.oid;
    const pos = (_tradeEngine.S.pos || []).find(p => p.orderId === oid);
    if (!pos) return;
    if (e.target.classList.contains('om-lev')) { const v = Math.max(1, Math.min(30, parseInt(e.target.value) || 1)); pos.lev = v; e.target.value = v; }
    else if (e.target.classList.contains('om-tp')) { const v = parseFloat(e.target.value); pos.tp = (e.target.value === '' || isNaN(v)) ? null : v; }
    else if (e.target.classList.contains('om-sl')) { const v = parseFloat(e.target.value); pos.sl = (e.target.value === '' || isNaN(v)) ? null : v; }
  });
  return ov;
}

function _renderOrderMgr() {
  const ov = document.getElementById('orderMgrModal');
  if (!ov || !_omOpen || !_tradeEngine) return;
  const S = _tradeEngine.S;
  const pos = (S && S.pos) || [];
  const count = ov.querySelector('#omCount');
  const rows = ov.querySelector('#omRows');
  const empty = ov.querySelector('#omEmpty');
  if (count) count.textContent = '(' + pos.length + ')';
  if (!pos.length) { rows.innerHTML = ''; empty.style.display = ''; return; }
  empty.style.display = 'none';
  rows.innerHTML = pos.map(p => {
    const c = (S.prices[p.sym] || {}).last;
    const pnl = p.pnl || 0; const pct = p.pnlPct || 0;
    const pc = pnl >= 0 ? 'up' : 'down';
    const sideTxt = p.side === 'long' ? '多单' : '空单';
    const modeTxt = p.marginMode === 'coin' ? '币本位' : 'U本位';
    return `<div class="om-row" data-oid="${p.orderId}">
      <span>${p.sym.replace('USDT', '')}</span>
      <span class="${pc}">${sideTxt}</span>
      <span>${modeTxt}</span>
      <span data-label="杠杆"><input class="om-lev" type="number" min="1" max="30" value="${p.lev}" style="width:42px"/></span>
      <span data-label="开仓价">$${_fmt(p.entry)}</span>
      <span data-label="标记价">${c != null ? '$' + _fmt(c) : '-'}</span>
      <span class="${pc}">${pnl >= 0 ? '+' : ''}$${_fmt(pnl)} (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)</span>
      <span><input class="om-tp" type="number" step="any" placeholder="TP" value="${p.tp != null ? p.tp : ''}"/></span>
      <span><input class="om-sl" type="number" step="any" placeholder="SL" value="${p.sl != null ? p.sl : ''}"/></span>
      <span class="om-ops">
        <button class="om-close btn btn-sell btn-sm">平</button>
        <button class="om-partial btn btn-sm">平50%</button>
        <button class="om-rev btn btn-sm">反手</button>
      </span>
    </div>`;
  }).join('');
}

function openOrderManager() {
  if (!_tradeEngine) { if (typeof alert === 'function') alert('交易引擎未连接'); return; }
  _omOpen = true;
  let ov = document.getElementById('orderMgrModal');
  if (!ov) ov = _buildOrderMgrModal();
  ov.classList.add('show');
  _renderOrderMgr();
  if (_omTimer) clearInterval(_omTimer);
  _omTimer = setInterval(() => { if (_omOpen) _renderOrderMgr(); }, 800);
}

function closeOrderManager() {
  _omOpen = false;
  if (_omTimer) { clearInterval(_omTimer); _omTimer = null; }
  const ov = document.getElementById('orderMgrModal');
  if (ov) ov.classList.remove('show');
}

function onTradeKey(e) {
  if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
  const bar = _tradeBar();
  if (!bar || bar.offsetParent === null) return;
  if (e.key === 'ArrowUp') { e.preventDefault(); kchartTradeOpen('long'); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); kchartTradeOpen('short'); }
  else if (e.key === ' ') { e.preventDefault(); kchartTradeClose(); }
}
if (typeof document !== 'undefined') document.addEventListener('keydown', onTradeKey);

