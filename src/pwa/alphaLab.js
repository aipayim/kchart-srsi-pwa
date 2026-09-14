// Alpha 实验室（PWA 前端复现）：回测 + paper 实盘（确定性重放）+ 自检
// 策略核心 = ./alphaCore.js（与 Node 权威框架 goal2-bt.mjs 逐位对齐，见 scripts/goal4-run-align.mjs）
// 诚实约束：信号在已收盘 bar 收盘评估 → 下一根开盘价成交（lag=1）；taker 0.045%+滑 0.02%；
//           现货模式 longOnly + 无资金费现金流（funding 仅作信号输入）；vol-target 需 720 根 1h 预热。
import { runBacktest, annualized, maxDD, sharpeDaily } from './alphaCore.js';
import { fetchKlinesRange, fetchFundingRate } from './data.js';

const PAPER_KEY = 'pwa_alpha_paper';
const HOUR = 3600e3, DAY = 86400e3;

// —— 合成 fixture（与 scripts/goal5-fixture.mjs 同一种子同构；期望常量来自 goal2-bt 权威输出，Δ=0）——
function mulberry32(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export function buildFixture() {
  const rnd = mulberry32(42);
  const T0 = Date.UTC(2024, 0, 1), N = 1600;
  const t = [], o = [], h = [], l = [], c = [], v = [];
  let p = 100;
  for (let i = 0; i < N; i++) {
    const ret = 0.00002 + (rnd() - 0.5) * 0.008;
    const op = p, cl = p * Math.exp(ret);
    const hi = Math.max(op, cl) * (1 + rnd() * 0.003), lo = Math.min(op, cl) * (1 - rnd() * 0.003);
    t.push(T0 + i * HOUR); o.push(op); h.push(hi); l.push(lo); c.push(cl); v.push(1 + rnd());
    p = cl;
  }
  const dt = [], do_ = [], dc = [];
  for (let d = 0; d * 24 + 24 <= N; d++) { dt.push(T0 + d * DAY); do_.push(o[d * 24]); dc.push(c[d * 24 + 23]); }
  const funding = [];
  for (let q = 0; q * 8 * HOUR + T0 < T0 + N * HOUR; q++) {
    const base = (q % 5 === 0 ? 0.0005 : q % 3 === 0 ? -0.0003 : 0.0001) + (rnd() - 0.5) * 0.0002;
    funding.push([T0 + q * 8 * HOUR, base]);
  }
  return { h1: { t, o, h, l, c, v }, d1: { t: dt, o: do_, c: dc }, funding };
}
const FIX_EXPECT = [
  { label: 'A: 现货只多 L1 vt30 vtCap1', cfg: { levCap: 1, volTarget: 0.30, vtCap: 1.0, longOnly: true }, final: 0.9955784145, sharpe: -3.02957486, maxDD: 0.582666 },
  { label: 'B: 现货多空 L3 vt30(计funding流)', cfg: { levCap: 3, volTarget: 0.30, longOnly: false }, final: 0.9754162656, sharpe: -0.81154192, maxDD: 10.253322 },
];
export function fixtureSelfCheck() {
  const fx = buildFixture();
  const end = fx.h1.t[fx.h1.t.length - 1] + HOUR;
  return FIX_EXPECT.map(x => {
    const r = runBacktest(fx.h1, fx.d1, { start: fx.h1.t[0], end, band: 0.05, funding: fx.funding, useFunding: true, ...x.cfg });
    const ok = Math.abs(r.final - x.final) < 1e-6 && Math.abs(r.sharpe - x.sharpe) < 1e-6 && Math.abs(r.maxDD - x.maxDD) < 1e-6;
    return { label: x.label, ok, got: r.final };
  });
}

// —— 拉取（复用 data.js：多域名竞速+用户代理+分页；两种模式都用现货价源——GOAL4-C 已证价源差异可忽略）——
async function loadBars(sym, tf, startTime, endTime, maxBars) {
  const k = await fetchKlinesRange(sym, tf, startTime, endTime, null, maxBars);
  if (!k || !k.times || k.times.length < 200) throw new Error('K线数据不足（' + (k && k.times ? k.times.length : 0) + ' 根）');
  return { t: k.times, o: k.opens, h: k.highs, l: k.lows, c: k.closes };
}
async function loadFunding(sym, startTime) {
  // fapi 双域名（fapi.binance.com / fapi.binance.vision）均不可达时降级为空：
  // funding 缺失 → z=null → combo 退化为 momo/breakout（与现货口径一致，信号仍有效）
  try {
    const rows = await fetchFundingRate(sym, startTime, Date.now());
    return (rows || []).map(r => [r.fundingTime, r.fundingRate]);
  } catch (e) { return []; }
}

// —— 渲染辅助 ——
const $ = (id) => document.getElementById(id);
const pct = (x, d = 1) => (x * 100).toFixed(d) + '%';
function fmtMetrics(r, days) {
  return `年化 <b>${pct(r.annRet)}</b> · Sharpe <b>${r.sharpe.toFixed(2)}</b> · 最大回撤 <b>${r.maxDD.toFixed(1)}%</b> · 期末 <b>${r.final.toFixed(2)}x</b> · 爆仓 <b>${r.liq}</b> · ${days.toFixed(0)} 天`;
}
function drawEquity(cv, eqs) {
  const ctx = cv.getContext('2d'); const W = cv.width = cv.clientWidth || 600, H = cv.height = 110;
  ctx.clearRect(0, 0, W, H);
  if (!eqs || eqs.length < 2) return;
  let mn = Infinity, mx = -Infinity; for (const v of eqs) { if (v < mn) mn = v; if (v > mx) mx = v; }
  if (!(mx > mn)) return;
  ctx.strokeStyle = '#4da3ff'; ctx.lineWidth = 1.5; ctx.beginPath();
  for (let i = 0; i < eqs.length; i++) { const x = i / (eqs.length - 1) * (W - 2) + 1, y = H - 4 - (eqs[i] - mn) / (mx - mn) * (H - 10); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
  ctx.stroke();
  ctx.fillStyle = '#889'; ctx.font = '10px sans-serif';
  ctx.fillText(mx.toFixed(2) + 'x', 4, 12); ctx.fillText(mn.toFixed(2) + 'x', 4, H - 2);
}
function oosMetrics(r) { // 后 1/3 窗口（诚实口径：与 Node 报告一致）
  const n = r.eqs.length, a = Math.floor(n * 2 / 3);
  const eq = r.eqs.slice(a), tt = r.ts.slice(a);
  if (eq.length < 100 || !(eq[0] > 0)) return null;
  const norm = eq.map(v => v / eq[0]);
  return { annRet: annualized(1, eq[eq.length - 1] / eq[0], tt), sharpe: sharpeDaily(norm, tt), maxDD: maxDD(eq) * 100 };
}

// —— 主渲染 ——
let paperTimer = null;
async function runBacktestUI(sym) {
  const mode = $('alphaMode').value, years = +$('alphaYears').value, vt = +$('alphaVt').value / 100, lev = +$('alphaLev').value;
  const out = $('alphaOut');
  out.innerHTML = '<div class="alpha-note">拉取数据中（1h × ' + years + ' 年 + 资金费率全史，约 5-20 秒）…</div>';
  try {
    const need = Math.min(60000, Math.round(years * 365 * 24));
    const startTime = Date.now() - need * HOUR;
    const isSpot = mode === 'spot';
    const [h1, d1] = await Promise.all([
      loadBars(sym, '1h', startTime, Date.now(), need),
      loadBars(sym, '1d', startTime - 40 * DAY, Date.now(), Math.round(need / 24) + 210),
    ]);
    let funding = [];
    try { funding = await loadFunding(sym, startTime - 100 * DAY); } catch (e) { /* 降级：carry 腿为 0 */ }
    const cfg = {
      start: h1.t[0], end: h1.t[h1.t.length - 1] + HOUR, band: 0.05, funding,
      useFunding: !isSpot, fundingZ: undefined,
      levCap: isSpot ? 1 : lev, volTarget: vt, vtCap: isSpot ? 1.0 : 1.5, longOnly: isSpot,
    };
    const r = runBacktest(h1, d1, cfg);
    if (r.error) { out.innerHTML = `<div class="alpha-err">回测失败：${r.error}</div>`; return; }
    const days = (r.ts[r.ts.length - 1] - r.ts[0]) / DAY;
    const oos = oosMetrics(r);
    const fundNote = isSpot ? '现货模式：无资金费现金流（funding 仅作信号输入），只多不加杠杆' : `永续语义（现货价源）：资金费现金流已计入（实付 ${(r.fundingPaid * 100).toFixed(1)}% 权益）`;
    const warm = '前 30 天为 vol-target/carry 预热段';
    const deg = funding.length ? '' : '<div class="alpha-err">⚠ 资金费数据不可达（fapi 被墙？）——carry 腿为 0，结果仅 breakout+momo</div>';
    out.innerHTML = `
      <div class="alpha-metrics">${fmtMetrics(r, days)}</div>
      <div class="alpha-metrics alpha-oos">OOS（后1/3）：年化 ${oos ? pct(oos.annRet) : '-'} · Sharpe ${oos ? oos.sharpe.toFixed(2) : '-'} · 回撤 ${oos ? oos.maxDD.toFixed(1) + '%' : '-'}　<span class="alpha-note">${warm}</span></div>
      <div class="alpha-note">${fundNote} · 成本 taker 0.045%+滑 0.02% · 信号收盘评估→下一根开盘成交（lag=1，无前视）</div>
      ${deg}
      <canvas class="alpha-eq" id="alphaEqCv"></canvas>
      <div class="alpha-row" style="margin-top:.4em"><button id="alphaReport">📄 导出回测报告（人机可读）</button><span class="alpha-note">含：条件/概要/逐笔出入场明细/机器可读 JSON，可发给 AI 复核</span></div>`;
    drawEquity($('alphaEqCv'), r.eqs);
    _lastBt = { r, sym, mode, vt, lev, days, bars: h1.t.length, t0: r.ts[0], t1: r.ts[r.ts.length - 1], fundingN: funding.length };
    const rb = $('alphaReport');
    if (rb) rb.addEventListener('click', () => exportAlphaReport());
  } catch (e) {
    out.innerHTML = `<div class="alpha-err">数据拉取失败：${e.message}（可在「行情数据源」设置代理）</div>`;
  }
}

// —— GOAL6-反馈：人机可读回测报告（仿 SRSI 自动回测报告结构）——
let _lastBt = null;
function exportAlphaReport() {
  if (!_lastBt) return;
  const { r, sym, mode, vt, lev, days, bars, t0, t1, fundingN } = _lastBt;
  const isSpot = mode === 'spot';
  const wins = r.trades.filter(x => x.pnlPct > 0).length;
  const losses = r.trades.length - wins;
  const head = '| 入场时间 | 方向 | 目标权重 | 入价 | 出场时间 | 出价 | 盈亏%(权益) | 出场权益 | 原因 |';
  const sep = '| --- | --- | --- | --- | --- | --- | --- | --- | --- |';
  const fmtT = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
  const rows = r.trades.map(x => `| ${fmtT(x.tIn)} | ${x.side} | ${(x.w * 100).toFixed(1)}% | ${x.pIn.toFixed(2)} | ${fmtT(x.tOut)} | ${x.pOut.toFixed(2)} | ${x.pnlPct >= 0 ? '+' : ''}${x.pnlPct.toFixed(2)}% | ${x.eqOut.toFixed(4)} | ${x.reason} |`).join('\n');
  const md = [
    '# Alpha(combo) 回测报告', '',
    '- 生成时间：' + new Date().toLocaleString(),
    '- 币对：' + sym + ' ｜ 模式：' + (isSpot ? '现货只多' : '永续多空(现货价源+funding流)') + ' ｜ 杠杆上限：' + (isSpot ? '1x' : lev + 'x'),
    '- 数据：' + bars + ' 根 1h K线（' + fmtT(t0) + ' ~ ' + fmtT(t1) + '，' + days.toFixed(0) + ' 天）+ 1d 收盘（动量/突破）+ funding ' + fundingN + ' 条',
    '- 版本：' + (typeof APP_VERSION !== 'undefined' ? APP_VERSION : 'dev'), '',
    '## 一、策略条件（信号→仓位）',
    '- 目标权重 w = 0.5×carry(z) + 0.3×breakout(1d) + 0.2×momo(1d)，clamp [-1,1]' + (isSpot ? '，longOnly(w≥0)' : ''),
    '- 波动率目标：' + (vt * 100).toFixed(0) + '% 年化（rolling ' + 720 + 'h σ 缩放，cap ' + (isSpot ? '1.0' : '1.5') + '×）；资金费：' + (fundingN ? '计入学费情绪 z + 永续现金流' : '不可达，carry 腿=0（降级）'),
    '- 调仓规则：|w − 当前仓| > 5%（band）→ 下一根开盘成交（lag=1 无前视）；成本 taker 0.045%+滑 0.02%；爆仓 = bar 极值穿越 entry×(1∓(1/lev−MMR))', '',
    '## 二、结果概要',
    '- 期末：' + r.final.toFixed(4) + 'x ｜ 年化 ' + (r.annRet * 100).toFixed(1) + '% ｜ Sharpe ' + r.sharpe.toFixed(2) + ' ｜ 最大回撤 ' + r.maxDD.toFixed(1) + '%',
    '- 交易 ' + r.trades.length + ' 笔（' + wins + '胜/' + losses + '负）｜ 爆仓 ' + r.liq + ' ｜ 成本：学费 ' + (r.fees * 100).toFixed(2) + '% 权益 ｜ 资金费净付 ' + (r.fundingPaid * 100).toFixed(2) + '% 权益', '',
    '## 三、逐笔交易明细', head, sep, rows || '（无成交——预热段后无信号跨越 band）', '',
    '## 四、机器可读数据（复制给 AI 复核）',
    '```json',
    JSON.stringify({ symbol: sym, mode, params: { band: 0.05, volTarget: vt, levCap: isSpot ? 1 : lev, vtCap: isSpot ? 1.0 : 1.5, longOnly: isSpot, combo: { carry: 0.5, breakout: 0.3, momo: 0.2 } }, summary: { final: r.final, annRet: r.annRet, sharpe: r.sharpe, maxDDPct: r.maxDD, liq: r.liq, feesPctEquity: r.fees, fundingPctEquity: r.fundingPaid, trades: r.trades.length, wins, losses, bars, t0, t1 }, trades: r.trades }, null, 2),
    '```', '', '--- 报告结束（alphaCore 与 Node 权威框架逐位对齐，GOAL4/5 验证） ---',
  ].join('\n');
  const fname = 'alpha-' + sym + '-' + (isSpot ? 'spot' : 'perp') + '-' + Math.round(days) + 'd.txt';
  const url = URL.createObjectURL(new Blob([md], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = fname; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// —— paper：确定性重放（每 tick 用同参 runBacktest 重算 [startT, now]，与回测逐位一致）——
function loadPaperCfg() { try { const s = localStorage.getItem(PAPER_KEY); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
function savePaperCfg(cfg) { try { cfg ? localStorage.setItem(PAPER_KEY, JSON.stringify(cfg)) : localStorage.removeItem(PAPER_KEY); } catch (e) {} }
async function tickPaper() {
  const cfg = loadPaperCfg(), box = $('alphaPaperOut');
  if (!cfg || !box) return;
  try {
    const need = Math.min(12000, Math.max(800, Math.round((Date.now() - cfg.startT) / HOUR) + 40));
    const [h1, d1] = await Promise.all([
      loadBars(cfg.sym, '1h', cfg.startT - 60 * DAY, Date.now(), need),
      loadBars(cfg.sym, '1d', cfg.startT - 60 * DAY, Date.now(), Math.round(need / 24) + 210),
    ]);
    let funding = [];
    try { funding = await loadFunding(cfg.sym, cfg.startT - 100 * DAY); } catch (e) {}
    const isSpot = cfg.mode === 'spot';
    const r = runBacktest(h1, d1, {
      start: cfg.startT, end: h1.t[h1.t.length - 1] + HOUR, band: 0.05, funding,
      useFunding: !isSpot, levCap: isSpot ? 1 : cfg.lev, volTarget: cfg.vt, vtCap: isSpot ? 1.0 : 1.5, longOnly: isSpot,
    });
    if (r.error) { box.innerHTML = `<div class="alpha-err">paper: ${r.error}</div>`; return; }
    const days = (Date.now() - cfg.startT) / DAY;
    const live = r.lastW > 0.02 ? `多 ${(r.lastW * 100).toFixed(0)}% 仓位` : r.lastW < -0.02 ? `空 ${(Math.abs(r.lastW) * 100).toFixed(0)}% 仓位` : '空仓';
    box.innerHTML = `
      <div class="alpha-metrics">${cfg.sym} ${cfg.mode === 'spot' ? '现货只多' : '永续多空'} · 已运行 <b>${days.toFixed(1)}</b> 天</div>
      <div class="alpha-metrics">模拟权益 <b>${r.final.toFixed(3)}x</b>（年化 ${pct(Math.pow(r.final, 365 / Math.max(days, 1)) - 1)}）· 当前 <b>${live}</b> · 累计手续费+滑点 ${(r.fees * 100).toFixed(2)}% 权益 · 资金费 ${(r.fundingPaid * 100).toFixed(2)}% · 爆仓 ${r.liq}</div>
      <div class="alpha-note">确定性重放：每次刷新用与回测完全相同的代码重算全部 bar（与 Node 逐位一致）；权益随最新价 mark-to-market</div>`;
  } catch (e) { box.innerHTML = `<div class="alpha-err">paper 刷新失败：${e.message}</div>`; }
}
function startPaper() {
  const sym = ($('alphaSym')?.value || window.__pwa?.curSym || 'BTCUSDT').toUpperCase().trim();
  const cfg = { sym, mode: $('alphaMode').value, vt: +$('alphaVt').value / 100, lev: +$('alphaLev').value, startT: Date.now() };
  savePaperCfg(cfg);
  $('alphaPaperCfg').textContent = `运行中：${cfg.sym} ${cfg.mode === 'spot' ? '现货只多' : '永续多空'} vt${(cfg.vt * 100).toFixed(0)}%${cfg.mode === 'perp' ? ' L' + cfg.lev : ''} · 起点 ${new Date(cfg.startT).toISOString().slice(0, 16).replace('T', ' ')}`;
  $('alphaPaperStart').style.display = 'none'; $('alphaPaperStop').style.display = '';
  tickPaper();
  if (!paperTimer) paperTimer = setInterval(tickPaper, 60000);
}
function stopPaper() { savePaperCfg(null); if (paperTimer) { clearInterval(paperTimer); paperTimer = null; } $('alphaPaperOut').innerHTML = ''; $('alphaPaperCfg').textContent = ''; $('alphaPaperStart').style.display = ''; $('alphaPaperStop').style.display = 'none'; }

function selfCheckUI() {
  const rows = fixtureSelfCheck();
  const ok = rows.every(r => r.ok);
  $('alphaSelf').innerHTML = rows.map(r => `<div>${r.ok ? '✓' : '✗'} ${r.label} — final=${r.got.toFixed(8)}</div>`).join('') +
    `<div class="${ok ? 'alpha-ok' : 'alpha-err'}">${ok ? '自检通过：浏览器核心与 Node 权威框架一致（fixture 2 用例，容差 1e-6）' : '自检失败：核心被改动或损坏！'}</div>`;
}

export function initAlphaLab() {
  const box = $('alphaLab');
  if (!box) return;
  // 折叠初态：默认收起（kchart.html 初始 closed）；展开过的用户记忆在 localStorage
  const wrap = document.getElementById('alphaLabWrap');
  if (wrap && localStorage.getItem('pwa_alpha_open') === '1') wrap.classList.remove('closed');
  // 融合进「回测设置」面板：把整块移入 kt-bt-section 的 ktAlphaSlot（交易条骨架只建一次，幂等）；
  // 槽不存在（交易条未开/主系统）时留在原位，250ms 兑底重试×20
  if (wrap) {
    const mount = () => {
      const slot = document.getElementById('ktAlphaSlot');
      if (slot && wrap.parentElement !== slot) slot.appendChild(wrap);
      return !!(slot && wrap.parentElement === slot);
    };
    if (!mount()) {
      let n = 0;
      const t = setInterval(() => { if (mount() || ++n > 20) clearInterval(t); }, 250);
    }
  }
  window.__alphaLabHead = () => {
    const w = document.getElementById('alphaLabWrap');
    if (w) localStorage.setItem('pwa_alpha_open', w.classList.contains('closed') ? '0' : '1');
  };
  box.innerHTML = `
    <div class="alpha-row">
      <input id="alphaSym" placeholder="BTCUSDT" value="BTCUSDT" size="9" />
      <select id="alphaMode"><option value="spot">现货只多</option><option value="perp">永续多空</option></select>
      <label>年限 <input id="alphaYears" type="number" min="1" max="6" step="0.5" value="3" style="width:4em" /></label>
      <label>目标波动 <input id="alphaVt" type="number" min="10" max="50" step="5" value="30" style="width:4em" />%</label>
      <label>杠杆(永续) <input id="alphaLev" type="number" min="1" max="5" value="3" style="width:3em" /></label>
      <button id="alphaRun">▶ 运行回测</button>
      <button id="alphaSelfBtn" title="验证浏览器内策略核心与 Node 权威回测框架逐位一致（2 个合成用例 Δ=0），用于确认线上代码未跑偏">🧪 自检</button>
    </div>
    <div id="alphaOut" class="alpha-out"><div class="alpha-note">combo 策略（carry0.5+breakout0.3+momo0.2）：核心与 Node 回测框架<b>逐位一致</b>（GOAL4 验证）。<b>应用到实盘 = 下方「启动 Paper 实盘模拟」</b>（60s 确定性重放同源核心，模拟真实持仓/权益；真实资金交易本系统不开放）。默认参数为 GOAL2-4 稳健区间代表值，非逐币最优。</div></div>
    <div id="alphaSelf"></div>
    <div class="alpha-row" style="margin-top:.5em">
      <button id="alphaPaperStart" title="启动模拟实盘：以面板参数每 60s 重算同源核心，模拟真实持仓/权益/爆仓（不接真实资金）">📡 启动 Paper 实盘模拟</button>
      <button id="alphaPaperStop" style="display:none">⏹ 停止</button>
      <span id="alphaPaperCfg" class="alpha-note"></span>
    </div>
    <div id="alphaPaperOut"></div>`;
  $('alphaRun').addEventListener('click', () => runBacktestUI(($('alphaSym').value || 'BTCUSDT').toUpperCase().trim()));
  $('alphaSelfBtn').addEventListener('click', selfCheckUI);
  $('alphaPaperStart').addEventListener('click', startPaper);
  $('alphaPaperStop').addEventListener('click', stopPaper);
  const cfg = loadPaperCfg();
  if (cfg) { // 恢复 paper 运行态
    $('alphaSym').value = cfg.sym; $('alphaMode').value = cfg.mode;
    $('alphaVt').value = Math.round(cfg.vt * 100); $('alphaLev').value = cfg.lev;
    $('alphaPaperCfg').textContent = `运行中：${cfg.sym} ${cfg.mode === 'spot' ? '现货只多' : '永续多空'} vt${(cfg.vt * 100).toFixed(0)}%${cfg.mode === 'perp' ? ' L' + cfg.lev : ''} · 起点 ${new Date(cfg.startT).toISOString().slice(0, 16).replace('T', ' ')}`;
    $('alphaPaperStart').style.display = 'none'; $('alphaPaperStop').style.display = '';
    tickPaper(); paperTimer = setInterval(tickPaper, 60000);
  }
  window.__alphaLab = { runBacktestUI, tickPaper, fixtureSelfCheck };
  // GOAL6：主图 α 信号 provider —— kchart.js 的「α 信号」chip 开启时调用，
  // 用与回测/paper 同源的 runBacktest 重算当前币/主周期逐根权重并写入 window.__alphaSignals。
  window.__alphaSignalProvider = async () => {
    try {
      const kApi = globalThis.kchartApi;
      const kc = kApi && kApi.getConfig ? kApi.getConfig() : null;
      const sym = String((kc && kc.symbol) || 'BTCUSDT').toUpperCase();
      await updateAlphaSignal(sym, (kc && kc.mainTF) || '1h');
    } catch (e) { /* 静默：信号缺失时主图零绘制 */ }
  };
}

// ---- GOAL6：主图 α 信号序列（无前视）----
// 用当前主周期可见 K 线跑同源 runBacktest（含 vol-target），取逐根目标权重 ws；
// 再按 band 规则重放成交点（|w-posW|>band → 在下一根开盘成交，与回测 fill 语义一致）。
// 1d 收盘与资金费率按币缓存（d1 拉取一次；funding 6h 刷新），主图切换周期/币种自动重算。
const _sigCache = { d1: {}, fr: {}, frT: {} };
export async function updateAlphaSignal(sym, tf, force = false) {
  try {
    const S = globalThis.S;
    // 与 kchart.js getTFData 同源：PWA 存储为分离数组（S.klinesO/H/L/C/T），非对象
    const K = (k) => (S && S[k] && S[k][sym] && S[k][sym][tf]) || [];
    const t = K('klinesT'), c = K('klines'), o = K('klinesO'), h = K('klinesH'), l = K('klinesL');
    if (t.length < 60 || c.length !== t.length || o.length !== t.length) return null;
    if (!force) {
      const prev = globalThis.__alphaSignals;
      if (prev && prev.sym === sym && prev.tf === tf && prev.ts === t && Date.now() - prev.updatedT < 30000) return prev;
    }
    let d1 = _sigCache.d1[sym];
    if (!d1 || !d1.t || d1.t.length < 30) {
      const k = await fetchKlinesRange(sym, '1d', Date.now() - 410 * DAY, Date.now(), null, 500);
      d1 = { t: k.times, c: k.closes };
      _sigCache.d1[sym] = d1;
    }
    let funding = _sigCache.fr[sym];
    if (!funding || Date.now() - (_sigCache.frT[sym] || 0) > 6 * HOUR) {
      funding = await loadFunding(sym, Date.now() - 100 * DAY);
      _sigCache.fr[sym] = funding; _sigCache.frT[sym] = Date.now();
    }
    const h1 = { t, o, h, l, c };
    const r = runBacktest(h1, d1, {
      start: t[0], end: t[t.length - 1] + HOUR,
      band: 0.05, funding, useFunding: true, levCap: 1, volTarget: 0.30, vtCap: 1.5, longOnly: false,
    });
    if (!r || r.error || !r.ws || r.ws.length !== t.length) return null;
    const flips = [];
    let posW = 0;
    for (let i = 0; i < r.ws.length - 1; i++) { // 末根为 in-flight：不在未收盘 bar 上决策（无前视）
      const w = r.ws[i];
      if (!Number.isFinite(w)) continue;
      if (Math.abs(w - posW) > 0.05) {
        flips.push({ i: Math.min(i + 1, r.ws.length - 1), dir: w > posW ? 1 : -1, w });
        posW = w;
      }
    }
    globalThis.__alphaSignals = { sym, tf, ts: t, flips, lastW: posW, updatedT: Date.now() };
    return globalThis.__alphaSignals;
  } catch (e) { return null; }
}
