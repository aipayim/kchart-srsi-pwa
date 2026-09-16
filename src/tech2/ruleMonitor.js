// ============================================================
// 规则监测面板（P1）—— 影子计算 + 影子信号簿（主系统 index.html 与 PWA kchart.html 共享）
//
// 设计（AGENTS.md / notebook rule-monitor-plan）：
//  A 区影子计算：每 ~2s 把当前行情+cfg 代入 runSrsiAutoTrade 的规则链（只读，复用既有纯函数），
//    输出「每条规则 当前判定 + 本 tick 规则结论」。零行为变化红线：不调 srsiAutoBandState（那会推进
//    实盘状态机），而是只读读 st.band/st.armed 并用纯函数 bandEdge 代入；不改 runSrsiAutoTrade 本体。
//  B 区影子信号簿：监测 _srsiAuto[sym].band 状态转移（进带=信号候选），记录被拦否(PD/闸门/热停/同向/
//    确认/资金)与实际开仓否（对账 __srsiLiveTrades）；每 15m 根收盘用 winLossByAtr(2×ATR/1.5×ATR)
//    回填前瞻盈亏 → 统计胜率/平均盈亏/分拦截原因贡献。明细走 IndexedDB（store: ruleSignals），
//    localStorage 只存 KB 级聚合快照（必须走 kchart._safeSetItem 配额自愈路径——5.30 红线）。
//  UI：主图下方折叠面板（仿 kchart-discwrap），cfg.ruleMonitorOpen 记忆；签名守卫防无谓重建。
// ============================================================

import {
  bandEdge, resolveEntryBands, srsiAutoRegime, predictDanger, emaOpp2,
  computeSizeScale, smartDanger, klineDirFromCloses,
  buildSrsiOverview, auxGateDir, _safeSetItem
} from './kchart.js';
import { atrClose, ema, ais } from '../engine/indicators.js';
import { THRESH } from '../engine/thresholds.js';

// ---------------- 帮手 ----------------
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const fmtN = (v, d = 1) => (v == null || !isFinite(v)) ? '--' : (+v).toFixed(d);
const fmtPct = (v, d = 1) => (v == null || !isFinite(v)) ? '--' : ((v >= 0 ? '+' : '') + (+v).toFixed(d) + '%');
const nowMs = () => Date.now();
// 时间对齐：升序 times 中 openTime <= t 的最大下标（与 kchart.js idxLe 同口径，二分）
function idxLe(times, t) {
  if (!times || !times.length) return -1;
  let lo = 0, hi = times.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (times[m] <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}
function tfData(sym, tf) {
  const S = globalThis.S || {};
  return {
    o: (S.klinesO && S.klinesO[sym] && S.klinesO[sym][tf]) || [],
    h: (S.klinesH && S.klinesH[sym] && S.klinesH[sym][tf]) || [],
    l: (S.klinesL && S.klinesL[sym] && S.klinesL[sym][tf]) || [],
    c: (S.klines && S.klines[sym] && S.klines[sym][tf]) || [],
    t: (S.klinesT && S.klinesT[sym] && S.klinesT[sym][tf]) || []
  };
}

// ============================================================
// 纯函数 1：evalRuleChain —— 影子规则链判定（与 runSrsiAutoTrade/_tryOpen 的约束链同序同语义）
// 输入全部显式传入（无 DOM/模块状态），可单测。
// 返回 { rules:[{id,name,state,detail}], verdict:{action,side,rev,blockedBy,reason} }
//   rule.state: 'pass'=对上✓ / 'fail'=没对上(拦截) / 'active'=进行中● / 'off'=未启用
//   verdict.action: 'open' = 应开仓 / 'confirm' = 挂确认推进中 / 'wait' = 观望
// ============================================================
export function evalRuleChain(i) {
  const rules = [];
  const R = (id, name, state, detail) => rules.push({ id, name, state, detail: detail || '' });
  // 拟开仓方向（仅边沿/挂单时有）
  const edgeSide = i.edge === 'enterUpper' ? 'short' : (i.edge === 'enterLower' ? 'long' : null);
  const pcSide = i.pendingConfirm ? i.pendingConfirm.side : null;
  const side = edgeSide || pcSide || null;
  let blockedBy = null;
  const block = (id) => { if (!blockedBy) blockedBy = id; };

  // R1 自动交易总开关
  if (!i.autoOn) {
    R('auto', '自动交易开关', 'off', '关（不产生任何自动动作）');
    R('engine', '撮合引擎/子账户', 'off', '—');
    R('canTrade', '15m 已优选(#1)', 'off', '—');
    R('band', 'KD 带态', 'off', '—');
    R('regime', 'regime 闸门', 'off', '—');
    R('hotstop', '热停(1h ATR)', 'off', '—');
    R('same', '同向上限', 'off', '—');
    R('pd', 'PD-A 危险拦截', 'off', '—');
    R('danger', '防爆模式', 'off', '—');
    R('confirm', '确认 bar', 'off', '—');
    R('margin', '资金/仓位', 'off', '—');
    return { rules, verdict: { action: 'wait', side: null, rev: false, blockedBy: 'off', reason: '自动交易总开关关' } };
  }
  R('auto', '自动交易开关', 'pass', '开');

  // R2 引擎/子账户
  if (!i.engineOk) { R('engine', '撮合引擎/子账户', 'fail', '未就绪'); block('engine'); }
  else R('engine', '撮合引擎/子账户', 'pass', '就绪');

  // R3 #1 硬约束：15m 已优选（未优选 → 禁止自动交易）
  if (!i.canTrade) { R('canTrade', '15m 已优选(#1)', 'fail', '15m 未优选 → 禁止自动开仓'); block('optimize'); }
  else R('canTrade', '15m 已优选(#1)', 'pass', '已优选');

  // R4 KD 带态（边沿/挂单方向）
  if (edgeSide) R('band', 'KD 带态', 'active', (i.band === 'upper' ? '上限带' : '下限带') + ` K${fmtN(i.k)} D${fmtN(i.d)} (${fmtN(i.upper, 0)}/${fmtN(i.lower, 0)}) 边沿:${edgeSide === 'short' ? '空' : '多'}`);
  else if (pcSide) R('band', 'KD 带态', 'active', (i.band === 'upper' ? '上限带' : '下限带') + ` K${fmtN(i.k)} D${fmtN(i.d)} 确认挂单:${pcSide === 'short' ? '空' : '多'}`);
  else if (i.band && i.band !== 'neutral') R('band', 'KD 带态', 'pass', (i.band === 'upper' ? '上限带内(已过边沿/未触发)' : '下限带内(已过边沿/未触发)') + ` K${fmtN(i.k)} D${fmtN(i.d)}`);
  else R('band', 'KD 带态', 'pass', '中性带 K' + fmtN(i.k) + ' D' + fmtN(i.d));

  // R5 regime 闸门（lowdrift → 禁开新仓，含反手）
  if (i.regimeGate === 'off') R('regime', 'regime 闸门', 'off', '关');
  else if (!i.regimeState) R('regime', 'regime 闸门', 'pass', '样本不足/未生效');
  else if (i.regimeState === 'lowdrift') { R('regime', 'regime 闸门', 'fail', '低波阴跌 → 禁开新仓'); block('regime'); }
  else if (i.regimeState === 'high') R('regime', 'regime 闸门', 'pass', '高波 → 照常');
  else R('regime', 'regime 闸门', 'pass', '中波 → ' + (i.regimeGate === 'size' ? '减仓×0.5' : (i.regimeGate === 'confirm' || i.regimeGate === 'tconf') ? '确认+1' : '照常'));

  // R6 热停（1h ATR > 1.3×sma20(1h ATR) → 禁普通开仓；反手仍允许）
  if (!i.hotStopOn) R('hotstop', '热停(1h ATR)', 'off', '关');
  else if (i.hotStopHit) { R('hotstop', '热停(1h ATR)', 'fail', '1h ATR 超 1.3×SMA20 → 禁普通开仓'); block('hotstop'); }
  else R('hotstop', '热停(1h ATR)', 'pass', '波动正常');

  // R7 同向上限（仅普通单；反手不计入）
  if (side && !i.rev) {
    const sc = (i.sameCount && i.sameCount[side]) || 0;
    if (sc >= i.maxSame) { R('same', '同向上限', 'fail', `同向${side === 'long' ? '多' : '空'}单 ${sc}/${i.maxSame} → 拦截`); block('samelimit'); }
    else R('same', '同向上限', 'pass', `同向${side === 'long' ? '多' : '空'}单 ${sc}/${i.maxSame}`);
  } else R('same', '同向上限', 'pass', i.rev ? '反手单不受限' : '无信号方向');

  // R8 PD-A 危险拦截（predictDanger 多因子 ≥ PREDICT_MIN → 拦截普通开仓；反手单不拦）
  const pd = i.pd || { danger: false, score: 0, reasons: [] };
  if (!i.pdBlockOn) R('pd', 'PD-A 危险拦截', 'off', '关');
  else if (!i.rev && pd.danger) { R('pd', 'PD-A 危险拦截', 'fail', `命中${pd.score}因子: ${pd.reasons.join('、') || '—'}`); block('pd'); }
  else if (i.rev) R('pd', 'PD-A 危险拦截', 'pass', '反手单不拦');
  else R('pd', 'PD-A 危险拦截', 'pass', pd.score > 0 ? `未达阈值(${pd.score}因子: ${pd.reasons.join('、') || '—'})` : '无命中');

  // R9 防爆模式（danger 语义：none=关 / filter=避开 / smart=智能避开 / reverse=危险→反手 / revconf=挂起等确认）
  //  filter/smart 命中 → resolveEntryDecision 的 blockedBy='danger' 同语义，链上拦下
  if (i.dangerMode === 'none') R('danger', '防爆模式', 'off', '关');
  else if (i.dangerMode === 'revconf') R('danger', '防爆模式', 'pass', '反手(确认)模式：危险→挂单等价格确认');
  else if (i.dangerMode === 'reverse') R('danger', '防爆模式', 'pass', i.dangerHit ? '危险 → 反手开反向' : '危险未命中');
  else if (i.dangerHit) { R('danger', '防爆模式', 'fail', '危险命中 → 避开该单'); block('danger'); }
  else R('danger', '防爆模式', 'pass', '危险未命中（放行）');

  // R10 确认 bar（GOAL27：边沿后需 N 根 15m 收盘仍带内）
  if (i.confirmN > 0) {
    if (i.pendingConfirm) R('confirm', '确认 bar', 'active', `确认中 ${i.pendingConfirm.count}/${i.pendingConfirm.n}（${i.pendingConfirm.side === 'short' ? '空' : '多'}，带内保持才递进）`);
    else if (edgeSide) R('confirm', '确认 bar', 'active', `边沿挂起 → 需 ${i.confirmN} 根 15m 收盘确认`);
    else R('confirm', '确认 bar', 'pass', `模式开(${i.confirmN}根)，当前无挂单`);
  } else R('confirm', '确认 bar', 'off', '0=立即执行');

  // R11 资金/仓位（影子估算 amt>0）
  if (i.marginOk === false) { R('margin', '资金/仓位', 'fail', '可用余额/仓位不足(amt≤0)'); block('nomargin'); }
  else R('margin', '资金/仓位', 'pass', i.marginDetail || '充足');

  // ---- verdict（本 tick 规则结论）----
  if (edgeSide) {
    if (i.confirmN > 0) return { rules, verdict: { action: 'confirm', side: edgeSide, rev: false, blockedBy: null, reason: `边沿挂确认(${i.confirmN}根)` } };
    if (blockedBy) return { rules, verdict: { action: 'wait', side: edgeSide, rev: false, blockedBy, reason: '应开' + (edgeSide === 'short' ? '空' : '多') + '，被「' + blockReasonTxt(blockedBy) + '」拦截' } };
    if (i.dangerMode === 'reverse' && i.dangerHit) return { rules, verdict: { action: 'open', side: edgeSide === 'long' ? 'short' : 'long', rev: true, blockedBy: null, reason: '危险命中 → 防爆反手开' + (edgeSide === 'long' ? '空' : '多') } };
    return { rules, verdict: { action: 'open', side: edgeSide, rev: false, blockedBy: null, reason: '应开' + (edgeSide === 'short' ? '空' : '多') } };
  }
  if (i.pendingConfirm) {
    if (blockedBy) return { rules, verdict: { action: 'wait', side: pcSide, rev: false, blockedBy, reason: `确认推进中 ${i.pendingConfirm.count}/${i.pendingConfirm.n}（若确认完成将被「${blockReasonTxt(blockedBy)}」拦截）` } };
    return { rules, verdict: { action: 'confirm', side: pcSide, rev: false, blockedBy: null, reason: `确认推进中 ${i.pendingConfirm.count}/${i.pendingConfirm.n}` } };
  }
  return { rules, verdict: { action: 'wait', side: null, rev: false, blockedBy: blockedBy || null, reason: i.band && i.band !== 'neutral' ? '带内无新边沿' : '带态中性，观望' } };
}
function blockReasonTxt(b) {
  return ({ engine: '引擎未就绪', optimize: '15m未优选', regime: '低波阴跌闸门', hotstop: '热停', samelimit: '同向上限', pd: 'PD-A危险拦截', nomargin: '资金不足', off: '总开关', confirm: '确认挂起' })[b] || b;
}

// ============================================================
// 纯函数 2：detectBandTransition —— 带转移检测（B 区信号簿边沿）
// prev/cur 为 st.band 观察值；进带（neutral→upper / neutral→lower / upper↔lower）= 信号候选。
// 返回 'upper'|'lower'|null。
// ============================================================
export function detectBandTransition(prev, cur) {
  if (!cur || cur === 'neutral') return null;
  if (!prev || prev === 'neutral' || prev !== cur) return cur;
  return null; // 同带持续，非转移
}

// ============================================================
// 纯函数 3：reconcileOpened —— 「实际开仓否」对账
// sig.ts 时刻的边沿信号，与实盘开仓记录（__srsiLiveTrades: {t, side, action:'open', ...}）比对。
// 匹配窗口 [sig.ts - 90s, sig.ts + 150s]（实盘推进领先/滞后影子的容差）。
// 返回 true(已开) / false(未开，窗口已过) / null(窗口未过，未定)。
// ============================================================
export function reconcileOpened(sig, trades, now) {
  const W1 = 90 * 1000, W2 = 150 * 1000;
  const hit = (trades || []).some(tr => tr && tr.action === 'open' && tr.side === sig.side
    && tr.t >= sig.ts - W1 && tr.t <= sig.ts + W2);
  if (hit) return true;
  if (now < sig.ts + W2) return null; // 窗口未过，无法断定
  return false;
}

// ============================================================
// 纯函数 4：backfillForward —— 前瞻盈亏回填（每 15m 根收盘跑一次）
// tf: {c:[closes], t:[openTimes]}（15m）；sig 有 entryPrice/ts。
// 出场口径 = winLossByAtr：2×ATR 止盈 / 1.5×ATR 止损（THRESH.BT_TP_ATR / BT_SL_ATR），horizon 60 根。
// 数据不足 / 未到期 → {done:false}；到期未触发 TP/SL → win:null(Expired)；触发 → win=±1。
// ============================================================
export function backfillForward(sig, tf, now) {
  const c = tf && tf.c, t = tf && tf.t;
  if (!Array.isArray(c) || c.length < 30 || !Array.isArray(t) || t.length !== c.length) return { done: false };
  const ei = idxLe(t, sig.ts);
  if (ei < 0 || ei >= c.length - 1) return { done: false };
  const horizon = THRESH.BT_HORIZON || 60;
  const expiredByTime = (now - sig.ts) > (horizon + 2) * 15 * 60 * 1000;
  const expiredByIdx = ei + 1 + horizon <= c.length - 1;
  const atrArr = atrClose(c.map(Number), 14);
  const r = winLossByAtrSafe(c, atrArr, ei, sig.side);
  // 触发 TP/SL → 立即完成；未触发但窗口已走完 → Expired；否则继续等
  if (r.win != null) {
    return {
      done: true,
      fwd: { win: r.win, pnlPct: r.pnlPct, barsHeld: r.barsHeld, exitDir: r.exitDir, filled: true, entryIdx: ei, entryPrice: c[ei], btTpAtr: THRESH.BT_TP_ATR, btSlAtr: THRESH.BT_SL_ATR }
    };
  }
  if (expiredByTime || expiredByIdx) {
    return {
      done: true,
      fwd: { win: null, pnlPct: 0, barsHeld: 0, exitDir: null, filled: false, entryIdx: ei, entryPrice: c[ei], btTpAtr: THRESH.BT_TP_ATR, btSlAtr: THRESH.BT_SL_ATR }
    };
  }
  return { done: false }; // 前瞻窗口未走完，继续等
}
function winLossByAtrSafe(c, atrArr, ei, side) {
  // 内联 winLossByAtr（indicators.js 同口径，避免重复导出依赖差异）：2×ATR 止盈 / 1.5×ATR 止损
  const tpAtr = THRESH.BT_TP_ATR, slAtr = THRESH.BT_SL_ATR, horizon = THRESH.BT_HORIZON;
  const p = c[ei], atr = atrArr && atrArr[ei];
  if (p == null || !isFinite(p) || p <= 0 || atr == null || !isFinite(atr) || atr <= 0) return { win: null, pnlPct: 0, barsHeld: 0, exitDir: null };
  const up = atr * tpAtr, dn = atr * slAtr;
  const lim = Math.min(c.length, ei + 1 + horizon);
  const dir = side === 'long' ? 'buy' : 'sell';
  for (let j = ei + 1; j < lim; j++) {
    const pj = c[j];
    if (pj == null || !isFinite(pj)) continue;
    if (dir === 'buy') {
      if (pj >= p + up) return { win: 1, pnlPct: (pj - p) / p * 100, barsHeld: j - ei, exitDir: 'tp' };
      if (pj <= p - dn) return { win: -1, pnlPct: (pj - p) / p * 100, barsHeld: j - ei, exitDir: 'sl' };
    } else {
      if (pj <= p - up) return { win: 1, pnlPct: (p - pj) / p * 100, barsHeld: j - ei, exitDir: 'tp' };
      if (pj >= p + dn) return { win: -1, pnlPct: (p - pj) / p * 100, barsHeld: j - ei, exitDir: 'sl' };
    }
  }
  return { win: null, pnlPct: 0, barsHeld: 0, exitDir: null };
}

// ============================================================
// 纯函数 5：computeRuleStats —— 信号簿统计（近 days 天）
// 「分规则贡献」：各拦截原因组 vs 放行组的前瞻胜率对比 → 拦截规则拦对了没。
// ============================================================
export function computeRuleStats(signals, now, days = 7) {
  const from = now - days * 86400 * 1000;
  const s = (signals || []).filter(x => x && x.ts >= from);
  const total = s.length;
  const blockedRecs = s.filter(x => x.blockedBy);
  const allowedRecs = s.filter(x => !x.blockedBy);
  const fwdOf = (arr) => arr.filter(x => x.fwd && x.fwd.win != null);
  const wr = (arr) => { const f = fwdOf(arr); return f.length ? f.filter(x => x.fwd.win === 1).length / f.length : null; };
  const avgPct = (arr) => { const f = fwdOf(arr); return f.length ? f.reduce((a, x) => a + (x.fwd.pnlPct || 0), 0) / f.length : null; };
  const byBlock = {};
  blockedRecs.forEach(x => {
    const k = x.blockedBy;
    byBlock[k] = byBlock[k] || { n: 0, backfilled: 0, fwdWinRate: null, avgPnlPct: null, wins: 0 };
    byBlock[k].n++;
    if (x.fwd && x.fwd.win != null) { byBlock[k].backfilled++; if (x.fwd.win === 1) byBlock[k].wins++; }
  });
  Object.keys(byBlock).forEach(k => {
    const grp = blockedRecs.filter(x => x.blockedBy === k);
    byBlock[k].fwdWinRate = wr(grp);
    byBlock[k].avgPnlPct = avgPct(grp);
    delete byBlock[k].wins;
  });
  const allowedFwd = fwdOf(allowedRecs);
  const blockedFwd = fwdOf(blockedRecs);
  return {
    windowDays: days, now,
    total, blocked: blockedRecs.length, allowed: allowedRecs.length,
    backfilled: s.filter(x => x.fwd && x.fwd.win != null).length,
    opened: s.filter(x => x.opened === true).length,
    allowedOpened: allowedRecs.filter(x => x.opened === true).length,
    fwdWinRate: wr(allowedRecs),                       // 放行后前瞻胜率
    allowedAvgPnlPct: avgPct(allowedRecs),
    allowedBackfilled: allowedFwd.length,
    blockedBackfilled: blockedFwd.length,
    blockedIfAllowedWinRate: wr(blockedRecs),          // 被拦组「若放行」的前瞻胜率
    blockedAvgPnlPct: avgPct(blockedRecs),
    byBlock
  };
}

// ============================================================
// 存储层：IndexedDB（store: ruleSignals）+ 内存兜底；localStorage 仅聚合快照
// ============================================================
const IDB_NAME = 'smartTraderRM', IDB_STORE = 'ruleSignals', DB_VER = 1;
const MAX_SIGNALS = 2000;
const LS_STATS_KEY = 'smartTrader_ruleMonitor';
const _rm = {
  inited: false, mode: 'mem', db: null,      // mode: 'idb' | 'mem'
  signals: [],                                // 会话内存为主（最新在后）
  lastBand: {},                               // sym → 上次观察的 st.band
  lastTickT: 0, lastBackfillT: 0, lastStatsWrite: 0, lastStatsSig: '',
  lastSnapshot: null, lastRenderSig: ''
};
function idbOpen() {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(IDB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
      setTimeout(() => resolve(req.readyState === 'done' ? (req.result || null) : null), 2000);
    } catch (e) { resolve(null); }
  });
}
function idbPut(db, rec) {
  return new Promise((resolve) => {
    if (!db) return resolve(false);
    try {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(rec);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch (e) { resolve(false); }
  });
}
function idbAll(db) {
  return new Promise((resolve) => {
    if (!db) return resolve(null);
    try {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve(null);
    } catch (e) { resolve(null); }
  });
}
async function idbTrim(db, keep) {
  if (!db) return;
  const all = await idbAll(db);
  if (!all || all.length <= keep) return;
  all.sort((a, b) => a.ts - b.ts);
  const del = all.slice(0, all.length - keep);
  try {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    const st = tx.objectStore(IDB_STORE);
    del.forEach(r => st.delete(r.id));
  } catch (e) {}
}
export async function ruleMonitorInit() {
  if (_rm.inited) return;
  _rm.inited = true;
  const db = await idbOpen();
  if (db) {
    _rm.db = db; _rm.mode = 'idb';
    const all = await idbAll(db);
    if (all && all.length) {
      all.sort((a, b) => a.ts - b.ts);
      _rm.signals = all.slice(-MAX_SIGNALS);
      if (all.length > MAX_SIGNALS) idbTrim(db, MAX_SIGNALS);
    }
  } else {
    _rm.mode = 'mem';
    try { console.warn('[RULE-MON] IndexedDB 不可用，信号簿降级为内存模式（仅本会话）'); } catch (e) {}
  }
}
function persistRec(rec) { if (_rm.db) idbPut(_rm.db, rec); }
function writeStatsSnapshot() {
  // localStorage 聚合快照（KB 级）——必须走 _safeSetItem（5.30 配额自愈红线）
  try {
    const stats = computeRuleStats(_rm.signals, nowMs(), 7);
    const sig = JSON.stringify(stats);
    if (sig === _rm.lastStatsSig) return; // 无变化不写
    _rm.lastStatsSig = sig;
    _safeSetItem(LS_STATS_KEY, JSON.stringify({ t: nowMs(), stats }));
  } catch (e) {}
}
export function ruleMonitorClear() {
  _rm.signals = []; _rm.lastBand = {}; _rm.lastStatsSig = '';
  if (_rm.db) { try { const tx = _rm.db.transaction(IDB_STORE, 'readwrite'); tx.objectStore(IDB_STORE).clear(); } catch (e) {} }
  try { localStorage.removeItem(LS_STATS_KEY); } catch (e) {}
  forceRender();
}

// ============================================================
// 影子计算素材采集（只读）：把当前行情+cfg 代入规则链的输入
// ============================================================
function klineDirOfC(sym, tf) {
  const c = tfData(sym, tf).c;
  if (!c || c.length < 120) return null;
  return klineDirFromCloses(c);
}
function srsiDirOfC(sym, tf, c) {
  if (!c || c.length < 30) return null;
  const srsiCfgFn = (cfgNow.srsiByTf && cfgNow.srsiByTf[tf]) || cfgNow.srsi;
  const rows = buildSrsiOverview([tf], srsiCfgFn, { [tf]: c }).rows;
  if (!rows || !rows.length) return null;
  return auxGateDir(rows[rows.length - 1]); // 与 kchart.srsiDirOf 同源同语义
}
let cfgNow = null; // 影子周期内缓存的 cfg 引用（由 getCfg 注入，避免每次取 getter）
function effConfirmN(st, price) {
  // 复刻 runSrsiAutoTrade 的 _effConfirmNow：confirm/tconf 闸门升确认
  const base = (cfgNow.srsiAutoConfirmBars != null) ? Math.max(0, Math.min(5, Math.floor(+cfgNow.srsiAutoConfirmBars || 0))) : 0;
  const gate = cfgNow.srsiAutoRegimeGate;
  const confirmClass = gate === 'confirm' || gate === 'tconf';
  const rg = st && st.regime;
  if (base > 0 && !(confirmClass && rg)) return base;
  if (gate === 'confirm' && rg && rg.state === 'mid') return base + (THRESH.REGIME_GATE_MID_CONFIRM || 1);
  if (gate === 'tconf' && rg && rg.state) {
    const ty = trendType1h(cfgNow.symbol, price);
    if (ty && ty.indexOf('trend') === 0) return base + (THRESH.REGIME_GATE_MID_CONFIRM || 1);
  }
  return base;
}
function trendType1h(sym, price) {
  // 复刻 _trendType：AIS 1h 斜率 → trend-up/trend-down/range/pullback-*
  const c = tfData(sym, '1h').c;
  if (c.length < 90) return null;
  const cn = c.map(Number);
  const line = ais(cn, 20, 8, 32, 14, 2).line;
  const n = line.length, j = n - 1, j60 = n - 61;
  if (j60 < 0 || line[j] == null || line[j60] == null || line[j60] <= 0) return null;
  const slope = (line[j] - line[j60]) / line[j60] * 100;
  if (Math.abs(slope) < (THRESH.REGIME_DEAD_SLOPE_PCT != null ? THRESH.REGIME_DEAD_SLOPE_PCT : 0.15)) return 'range';
  const above = cn[n - 1] > line[j];
  return slope > 0 ? (above ? 'trend-up' : 'pullback-up') : (above ? 'pullback-down' : 'trend-down');
}

// 影子快照（只读代入，不写任何引擎/实盘状态）——渲染与信号记录共用
export function buildRuleSnapshot(sym, st) {
  const c15 = tfData(sym, '15m');
  const engine = (typeof window !== 'undefined' && window.kchartApi && window.kchartApi.getTradeEngine()) || null;
  const price = engine && engine.S && engine.S.prices && engine.S.prices[sym] && engine.S.prices[sym].last;
  const sub = engine && engine.getPerpSub ? engine.getPerpSub() : null;
  // 带态：只读读实盘状态机当前值 + 纯函数代入（不调 srsiAutoBandState —— 那会推进实盘状态）
  const srsi15 = (cfgNow.srsiByTf && cfgNow.srsiByTf['15m']) || cfgNow.srsi;
  const rows = c15.c && c15.c.length ? buildSrsiOverview(['15m'], srsi15, { '15m': c15.c }).rows : null;
  const r0 = rows && rows[0];
  const k = r0 && r0.k, d = r0 && r0.d;
  const eb = resolveEntryBands(cfgNow);
  const armed = st && st.armed;
  const be = bandEdge(st ? st.band : 'neutral', k, d, { upper: eb.upper, lower: eb.lower }, armed);
  // 方向信息
  const emaTf = { '4h': klineDirOfC(sym, '4h'), '1h': klineDirOfC(sym, '1h'), '30m': klineDirOfC(sym, '30m') };
  const srsiDir = { '4h': srsiDirOfC(sym, '4h', tfData(sym, '4h').c), '1h': srsiDirOfC(sym, '1h', tfData(sym, '1h').c), '30m': srsiDirOfC(sym, '30m', tfData(sym, '30m').c) };
  // 危险信号素材（与 runSrsiAutoTrade 每 tick 的计算同口径）
  const _e15 = ema(c15.c.map(Number), 20); const e15 = _e15[_e15.length - 1];
  const c1h = tfData(sym, '1h').c;
  const _e1h = ema(c1h.map(Number), 20); const e1h = _e1h[_e1h.length - 1];
  const _a15 = atrClose(c15.c.map(Number), 14); const a15 = _a15[_a15.length - 1];
  const c15n = c15.c;
  const recentPct = c15n.length >= 5 ? (c15n[c15n.length - 1] - c15n[c15n.length - 5]) / c15n[c15n.length - 5] * 100 : null;
  const priceVsEma1h = (e1h != null && isFinite(e1h) && e1h !== 0 && price != null) ? (price - e1h) / e1h * 100 : null;
  const priceVsEma15 = (e15 != null && isFinite(e15) && e15 !== 0 && price != null) ? (price - e15) / e15 * 100 : null;
  // regime 闸门（只读重算；实盘 st.regime 为权威显示，影子重算供信号记录）
  const rgOn = cfgNow.srsiAutoRegimeGate !== 'off';
  const rg = rgOn ? srsiAutoRegime(c1h.map(Number), price, { w: cfgNow.srsiAutoRegimeW, emaTf: cfgNow.srsiAutoRegimeEmaTf, c1d: tfData(sym, '1d').c }) : null;
  const regimeState = rg ? rg.state : (st && st.regime ? st.regime.state : null);
  // 热停
  let hotStopHit = false, hotDetail = '';
  if (cfgNow.srsiAutoHotStop && c1h.length > 30) {
    const atr1h = atrClose(c1h.map(Number), 14);
    const n = atr1h.length;
    if (n >= 20) {
      let s2 = 0; for (let j = n - 20; j < n; j++) s2 += atr1h[j];
      const sma = s2 / 20;
      hotStopHit = sma > 0 && atr1h[n - 1] > 1.3 * sma;
      hotDetail = 'ATR%' + fmtN(atr1h[n - 1] / c1h[c1h.length - 1] * 100, 2) + ' vs SMA20×1.3';
    }
  }
  // PD ctx
  const edgeSideGuess = be.edge === 'enterUpper' ? 'short' : (be.edge === 'enterLower' ? 'long' : null);
  const sideForPd = edgeSideGuess || (st && st.pendingConfirm ? st.pendingConfirm.side : null);
  const pd = sideForPd ? predictDanger({
    dir: sideForPd, k15: k, atrPct15: (a15 != null && price) ? a15 / price * 100 : null,
    emaOpp2Weak: sideForPd ? emaOpp2(sideForPd, emaTf) : false,
    priceVsEma1h, priceVsEma15, recentCandlePct: recentPct
  }) : { danger: false, score: 0, reasons: [] };
  const smartHit = sideForPd ? smartDanger({ priceVsEma1h, recentCandlePct, k15: k, dir: sideForPd }) : false;
  const emaOppHit = sideForPd ? emaOpp2(sideForPd, emaTf) : false;
  const dangerMode = cfgNow.srsiAutoDanger || 'none';
  const dangerHit = dangerMode === 'reverse' ? pd.danger : dangerMode === 'smart' ? smartHit : dangerMode === 'revconf' ? false : emaOppHit;
  // 同向计数
  const pos = (engine && engine.S && engine.S.pos) || [];
  const sameCount = {
    long: pos.filter(p => p.sym === sym && p.side === 'long' && p.src === 'srsiAuto' && !p.reverse).length,
    short: pos.filter(p => p.sym === sym && p.side === 'short' && p.src === 'srsiAuto' && !p.reverse).length
  };
  // 资金影子估算（#4 缩放 + 连开递减，与 _tryOpen 同口径）
  const isRev = dangerMode === 'reverse' && dangerHit;
  const sideSig = edgeSideGuess || (st && st.pendingConfirm ? st.pendingConfirm.side : 'long');
  const mm = cfgNow.srsiAutoMode === 'usdt' ? 'usdt' : cfgNow.srsiAutoMode === 'coin' ? 'coin' : (sideSig === 'short' ? 'usdt' : 'coin');
  const isCoin = mm === 'coin';
  const avail = isCoin ? ((sub && sub.coins && sub.coins[sym]) || 0) : ((sub && sub.bal) || 0);
  const scale = computeSizeScale(sideSig, srsiDir, { '4h': cfgNow.srsiAutoW4h, '1h': cfgNow.srsiAutoW1h, '30m': cfgNow.srsiAutoW30m }, cfgNow.srsiOptSource);
  const same = (sameCount[sideSig] || 0);
  let effPct = cfgNow.srsiAutoBasePct;
  if (same > 0 && cfgNow.srsiAutoStackDecay > 0 && cfgNow.srsiAutoStackDecay < 1) {
    const front = (typeof cfgNow.srsiAutoStackFront === 'number' && cfgNow.srsiAutoStackFront > 1) ? cfgNow.srsiAutoStackFront : 1;
    effPct = cfgNow.srsiAutoBasePct * Math.pow(cfgNow.srsiAutoStackDecay, Math.max(0, same - (front - 1)));
  }
  const lev = (isRev && cfgNow.srsiAutoReverseLev > 0) ? cfgNow.srsiAutoReverseLev : cfgNow.srsiAutoLev;
  let amt = avail * effPct / 100 * scale;
  const capUsdt = cfgNow.srsiAutoOpenCapUsdt > 0 ? cfgNow.srsiAutoOpenCapUsdt : Infinity;
  const capCoin = cfgNow.srsiAutoOpenCapCoin > 0 ? cfgNow.srsiAutoOpenCapCoin : Infinity;
  if (isCoin && price) amt = Math.min(amt, capCoin, capUsdt / price);
  else if (price) amt = Math.min(amt, capUsdt, capCoin * price);
  const marginOk = price != null && amt > 0 && avail > 0;
  const confirmN = effConfirmN(st, price);
  const chain = evalRuleChain({
    autoOn: !!cfgNow.srsiAutoOn,
    engineOk: !!(engine && sub),
    canTrade: cfgNow.srsiOptSource && cfgNow.srsiOptSource['15m'] === 'optimized',
    band: be.band, edge: be.edge, k, d, upper: eb.upper, lower: eb.lower,
    sameCount, maxSame: cfgNow.srsiAutoMaxSame,
    regimeGate: cfgNow.srsiAutoRegimeGate, regimeState,
    hotStopOn: !!cfgNow.srsiAutoHotStop, hotStopHit,
    dangerMode, dangerHit, emaOppHit, smartHit, pd,
    pdBlockOn: !!cfgNow.srsiAutoPdBlockOn,
    rev: isRev,
    confirmN,
    pendingConfirm: (st && st.pendingConfirm) ? { side: st.pendingConfirm.side, count: st.pendingConfirm.count, n: st.pendingConfirm.n || confirmN } : null,
    marginOk, marginDetail: `${isCoin ? '币本位' : 'U本位'} 可用${fmtN(avail, isCoin ? 4 : 2)}×${effPct}%×缩放${fmtN(scale, 2)} → amt ${fmtN(amt, isCoin ? 4 : 2)} ${lev}x`
  });
  return {
    ts: nowMs(), sym, price, ok: !!(c15.c && c15.c.length >= 30),
    rules: chain.rules, verdict: chain.verdict,
    band: be.band, edge: be.edge, k, d, upper: eb.upper, lower: eb.lower, bandsAuto: eb.auto,
    regime: rg, regimeState, regimeGate: cfgNow.srsiAutoRegimeGate,
    hotStopHit, hotDetail, pd, smartHit, emaOppHit, dangerMode, dangerHit,
    emaTf, srsiDir, sameCount, maxSame: cfgNow.srsiAutoMaxSame,
    confirmN, pendConfirmRaw: st && st.pendingConfirm ? { side: st.pendingConfirm.side, count: st.pendingConfirm.count, n: st.pendingConfirm.n || confirmN } : null,
    marginOk, amt, avail, isCoin, scale, effPct, lev,
    autoOn: !!cfgNow.srsiAutoOn, canTrade: !!(cfgNow.srsiOptSource && cfgNow.srsiOptSource['15m'] === 'optimized')
  };
}

// ============================================================
// 影子 tick（renderKChart / refreshPanels 每 tick 调用，内部 2s 节流）
// ============================================================
export function updateRuleMonitorTick() {
  const api = (typeof window !== 'undefined') && window.kchartApi;
  const c = api && api.getConfig ? api.getConfig() : null;
  if (!c) return;
  cfgNow = c;
  const sym = c.symbol;
  const now = nowMs();
  // 惰性初始化（IDB 读回）+ 渲染（面板开着才重建，守卫在 renderRuleMonitor 内）
  ruleMonitorInit();
  if (now - _rm.lastTickT < 2000) { renderRuleMonitor(); return; }
  _rm.lastTickT = now;
  const st = api.srsiAutoStateOf ? api.srsiAutoStateOf(sym) : null;
  const prevBand = _rm.lastBand[sym];
  const curBand = st ? st.band : 'neutral';
  _rm.lastBand[sym] = curBand;
  // A 区快照（渲染用）
  let snap = null;
  try { snap = buildRuleSnapshot(sym, st); } catch (e) { snap = null; }
  _rm.lastSnapshot = snap;
  // B 区：自动交易开 且 检测到带转移 → 记录信号（边沿检测基于实盘状态机的 band 值变化）
  // 首次观察（prevBand===undefined）只建立基线，不触发信号
  if (c.srsiAutoOn && st && prevBand !== undefined && detectBandTransition(prevBand, curBand)) {
    try { recordSignal(snap, curBand, prevBand); } catch (e) {}
  }
  // 对账 opened（最近 15 分钟内未定信号）
  reconcilePendingSignals(now);
  // 回填（60s 节流）
  if (now - _rm.lastBackfillT > 60000) { _rm.lastBackfillT = now; backfillPending(now); }
  renderRuleMonitor();
}
function recordSignal(snap, band, prevBand) {
  if (!snap) return;
  const side = band === 'upper' ? 'short' : 'long';
  const edge = band === 'upper' ? 'enterUpper' : 'enterLower';
  // 用边沿方向重算链（快照的 verdict 可能基于「无 edge」状态）
  const chain = evalRuleChain({
    autoOn: snap.autoOn, engineOk: snap.ok && !!snap.price,
    canTrade: snap.canTrade,
    band: snap.band, edge, k: snap.k, d: snap.d, upper: snap.upper, lower: snap.lower,
    sameCount: snap.sameCount, maxSame: snap.maxSame,
    regimeGate: snap.regimeGate, regimeState: snap.regimeState,
    hotStopOn: !!(cfgNow && cfgNow.srsiAutoHotStop), hotStopHit: snap.hotStopHit,
    dangerMode: snap.dangerMode, dangerHit: snap.dangerHit, emaOppHit: snap.emaOppHit, smartHit: snap.smartHit, pd: snap.pd,
    pdBlockOn: !!(cfgNow && cfgNow.srsiAutoPdBlockOn),
    rev: false,
    confirmN: snap.confirmN, pendingConfirm: snap.pendConfirmRaw,
    marginOk: snap.marginOk, marginDetail: ''
  });
  const rec = {
    id: 'sig-' + snap.ts + '-' + snap.sym + '-' + side,
    ts: snap.ts, sym: snap.sym, side, band, prevBand: prevBand || null, edge,
    price: snap.price, k: snap.k, d: snap.d, upper: snap.upper, lower: snap.lower,
    regimeGate: snap.regimeGate, regimeState: snap.regimeState,
    confirmN: snap.confirmN, pending: !!snap.pendConfirmRaw,
    pdBlockOn: !!(cfgNow && cfgNow.srsiAutoPdBlockOn),
    pdScore: snap.pd ? snap.pd.score : 0, pdReasons: (snap.pd && snap.pd.reasons) || [],
    dangerMode: snap.dangerMode, emaOpp: snap.emaOppHit, smart: snap.smartHit,
    hotStop: snap.hotStopHit,
    blockedBy: chain.verdict.blockedBy || (chain.verdict.action === 'confirm' ? 'confirm' : null),
    verdict: chain.verdict.action, verdictReason: chain.verdict.reason,
    opened: null, fwd: null
  };
  _rm.signals.push(rec);
  if (_rm.signals.length > MAX_SIGNALS) _rm.signals = _rm.signals.slice(-MAX_SIGNALS);
  persistRec(rec);
  writeStatsSnapshot(); // 信号新增即刷新聚合快照（对账/回填变更时也会写）
}
function reconcilePendingSignals(now) {
  const trades = (typeof window !== 'undefined' && window.__srsiLiveTrades) || [];
  let dirty = false;
  for (let i = _rm.signals.length - 1; i >= 0; i--) {
    const s = _rm.signals[i];
    if (s.opened != null) continue;
    if (now - s.ts > 30 * 60 * 1000) break; // 只对账最近 30 分钟
    const r = reconcileOpened(s, trades, now);
    if (r != null) { s.opened = r; dirty = true; persistRec(s); }
  }
  if (dirty) writeStatsSnapshot();
}
function backfillPending(now) {
  const bySymTf = {};
  let dirty = false;
  for (const s of _rm.signals) {
    if (s.fwd) continue;
    if (now - s.ts < 15 * 60 * 1000) continue; // 至少等 1 根 15m
    const sym = s.sym;
    if (!bySymTf[sym]) bySymTf[sym] = tfData(sym, '15m');
    const r = backfillForward(s, bySymTf[sym], now);
    if (r.done) { s.fwd = r.fwd; dirty = true; persistRec(s); }
  }
  if (dirty) writeStatsSnapshot();
}

// ============================================================
// UI：renderRuleMonitor（折叠面板；签名守卫 + 轻量实时行）
// ============================================================
function ruleStateBadge(st) {
  if (st === 'pass') return '<span class="rm-badge rm-pass">✓</span>';
  if (st === 'fail') return '<span class="rm-badge rm-fail">✗</span>';
  if (st === 'active') return '<span class="rm-badge rm-active">●</span>';
  return '<span class="rm-badge rm-off">–</span>';
}
export function renderRuleMonitor() {
  // v1.5.52 HUD 模式：存在 #discHudRmBody 时渲染进 HUD 内的 RM 区（流内 #kchartRuleMonitor 保留为无 HUD 时的回退）
  const _hudBody = (typeof document !== 'undefined') && document.getElementById('discHudRmBody');
  const box = _hudBody || ((typeof document !== 'undefined') && document.getElementById('kchartRuleMonitor'));
  if (!box) return;
  const wrap = document.getElementById('ruleMonitorWrap');
  const cfg = cfgNow || (typeof window !== 'undefined' && window.kchartApi && window.kchartApi.getConfig());
  if (!cfg) return;
  const open = !!cfg.ruleMonitorOpen;
  // HUD 模式：RM 内容在悬浮卡内以仪表盘形态展开，流内面板永久收起（避免陈旧内容露出；kToggleRuleMonitor 变为 HUD 总开关）
  if (wrap) wrap.classList.toggle('closed', !open || !!_hudBody);
  if (!open) { stopRmGauge(); return; } // v1.5.55 mini 态：body/签名均保留 → 展开首帧直接复用 canvas（sameNode），数据 2s 内自动刷新
  const snap = _rm.lastSnapshot;
  if (!snap || !snap.ok) {
    if (_hudBody) { updateHudBarTitle(null); stopRmGauge(); }
    const s0 = 'nodata|' + (cfg.symbol || '') + '|' + (cfg.srsiAutoOn ? 1 : 0);
    if (s0 === _rm.lastRenderSig) return;
    _rm.lastRenderSig = s0;
    box.innerHTML = '<div class="rm-empty">⏳ 等待 15m K 线数据…（自动交易' + (cfg.srsiAutoOn ? '开' : '关') + '）</div>';
    updateHeadBadge('⏳');
    return;
  }
  // 轻量实时行（守卫外，每 tick 直接更新）
  const pe = document.getElementById('rmPrice');
  if (pe && snap.price != null) {
    pe.textContent = '$' + fmtN(snap.price, snap.price > 100 ? 1 : 3);
  }
  // 签名：规则判定 + 结论 + 统计摘要 + 优选/版本状态（不含实时价，价由上面轻量行更新）
  const stats = computeRuleStats(_rm.signals, nowMs(), 7);
  const rulesSig = snap.rules.map(r => r.id + r.state).join(',');
  const rvSt = readRvStore();
  const opt = _rmOpt;
  const sig = [snap.sym, snap.autoOn ? 1 : 0, rulesSig, snap.verdict.action, snap.verdict.blockedBy, snap.verdict.reason,
    snap.band, snap.regimeState, snap.confirmN, snap.pendConfirmRaw ? snap.pendConfirmRaw.count : -1,
    snap.pd.score, stats.total, stats.backfilled, stats.fwdWinRate, stats.blocked, stats.opened,
    Object.keys(stats.byBlock).map(k => k + ':' + stats.byBlock[k].n + ':' + (stats.byBlock[k].fwdWinRate == null ? '-' : stats.byBlock[k].fwdWinRate.toFixed(2))).join('|'),
    _rm.mode,
    'opt:' + (opt.running ? 1 : 0) + (opt.error ? 'E' : '') + (opt.result ? 'R' + (opt.result.applied ? 'A' : '') + Object.keys(opt.result.changes).length : ''),
    'rv:' + rvSt.current + ':' + rvSt.versions.length + ':' + (opt.progress ? opt.progress.phase + opt.progress.label + opt.progress.i + '/' + opt.progress.n : '')
  ].join('|');
  if (_hudBody) {
    // ---- v1.5.54 HUD 仪表盘形态：每 tick 更新标题/目标读数/画布（签名未变也持续），签名变化才重建 ----
    updateHudBarTitle(snap);
    updateGaugeTarget(snap);
    if (sig === _rm.lastRenderSig) { setupGaugeCanvas(box); ensureRmGauge(); return; }
    _rm.lastRenderSig = sig;
    const gCls = (k) => 'rm-gbtn' + (_rmGauge.tab === k ? ' on' : '');
    box.innerHTML = '<canvas id="rmGaugeCv"></canvas>' +
      '<div class="rm-gbtns">' +
      '<div class="' + gCls('rules') + '" data-dr="rules">规则全表</div>' +
      '<div class="' + gCls('stats') + '" data-dr="stats">统计</div>' +
      '<div class="' + gCls('opt') + '" data-dr="opt">🧪 优选</div></div>';
    const hudRoot = box.closest('#discHud');
    if (hudRoot) { ensureDrawer(hudRoot); bindDrawerEvents(hudRoot); }
    setupGaugeCanvas(box);
    ensureRmGauge();
    if (_rmGauge.tab) refreshDrawer(); // 签名变化 → 刷新开着抽屉的内容
    return;
  }
  if (sig === _rm.lastRenderSig) return;
  _rm.lastRenderSig = sig;
  // ---- 构建 HTML（流内文字版回退）----
  const actCls = { open: 'rm-act-open', confirm: 'rm-act-confirm', wait: 'rm-act-wait' };
  const actTxt = verdictHeadline(snap.verdict);
  const regimeTxt = snap.regimeGate === 'off' ? '关'
    : !snap.regimeState ? '未生效'
      : { high: '高波(照常)', mid: '中波(' + (snap.regimeGate === 'size' ? '减仓×0.5' : (snap.regimeGate === 'confirm' || snap.regimeGate === 'tconf') ? '确认+1' : '照常') + ')', lowdrift: '低波阴跌(禁开)' }[snap.regimeState] || snap.regimeState;
  const rowsHtml = snap.rules.map(r =>
    `<tr><td>${ruleStateBadge(r.state)}</td><td class="rm-rule-name">${esc(r.name)}</td><td class="rm-rule-detail">${esc(r.detail)}</td></tr>`).join('');
  const bb = stats.byBlock;
  const bbKeys = Object.keys(bb);
  const bbHtml = bbKeys.length
    ? bbKeys.map(k => {
      const b = bb[k];
      const wrTxt = b.fwdWinRate == null ? '样本不足' : (b.fwdWinRate * 100).toFixed(0) + '%';
      const pnlTxt = b.avgPnlPct == null ? '' : ' 平均' + fmtPct(b.avgPnlPct, 2);
      return `<span class="rm-chip">「${esc(blockReasonTxt(k))}」拦 ${b.n} 次 · 若放行胜率 ${wrTxt}${pnlTxt}</span>`;
    }).join(' ')
    : '<span class="rm-dim">暂无拦截记录</span>';
  const wrTxt = stats.fwdWinRate == null ? '--' : (stats.fwdWinRate * 100).toFixed(0) + '%';
  const bWrTxt = stats.blockedIfAllowedWinRate == null ? '--' : (stats.blockedIfAllowedWinRate * 100).toFixed(0) + '%';
  const pdWr = bb['pd'];
  const cmpTxt = (stats.fwdWinRate != null && stats.blockedIfAllowedWinRate != null)
    ? (stats.blockedIfAllowedWinRate < stats.fwdWinRate ? '拦截规则整体<b class="rm-good">拦对了</b>（被拦组若放行表现更差）'
      : stats.blockedIfAllowedWinRate > stats.fwdWinRate ? '<b class="rm-bad">拦错了？</b>被拦组若放行表现更好，考虑放宽'
        : '两组相当')
    : '待样本';
  // ---- P2 优选区 ----
  let optHtml = '';
  if (opt.running) {
    const p = opt.progress || {};
    optHtml = '<div class="rm-opt-progress">⏳ ' + esc(p.label || '') + (p.n ? ' (' + p.i + '/' + p.n + ')' : '') + '</div>';
  } else {
    const rows = opt.result ? opt.result.rows : [];
    const nPick = rows.filter(r => r.pick).length;
    optHtml = rows.length ? (
      '<div class="rm-opt-table"><table><tr><th>维度</th><th>基线→推荐</th><th>近窗Δ</th><th>长窗Δ</th></tr>' +
      rows.map(r => '<tr class="' + (r.pick ? 'rm-pick' : '') + '"><td>' + esc(r.label) + '</td><td>' + esc(String(r.baseValue)) + ' → ' + (r.pick ? '<b>' + esc(String(r.value)) + '</b>' : '保持') + '</td><td>' + (r.nearΔ == null ? '--' : fmtPct(r.nearΔ, 1)) + '</td><td>' + (r.longΔ == null ? '--' : fmtPct(r.longΔ, 1)) + '</td></tr>').join('') +
      '</table><div class="rm-dim">基线 近/长: ' + fmtPnlBt(opt.result.base.near) + ' | ' + fmtPnlBt(opt.result.base.long) + '</div></div>' +
      (nPick && !opt.result.applied ? '<button class="rm-btn rm-btn-primary" onclick="window.ruleOptimizeApply()">✓ 应用推荐（' + nPick + ' 项 · 写入 cfg 立即生效）</button> '
        : opt.result.applied ? '<span class="rm-good">已应用</span> ' : '<span class="rm-dim">无双窗一致正贡献的候选 → 保持现配置</span> ')
    ) : '';
    optHtml += '<button class="rm-btn" onclick="window.ruleOptimizeRun()"' + (opt.running ? ' disabled' : '') + '>🧪 一键优选（单维轮换 × 近45d/长90d 双窗一致）</button>';
    if (opt.error) optHtml += '<div class="rm-bad rm-opt-err">优选失败: ' + esc(opt.error) + '</div>';
  }
  const rvOpts = rvSt.versions.slice().reverse().map(v => '<option value="' + esc(v.id) + '"' + (v.id === rvSt.current ? ' selected' : '') + '>' + esc(v.id.replace('rv-', '') + ' ' + (v.label || '')) + '</option>').join('');
  const rvHtml = '<div class="rm-rv"><span class="rm-dim">参数版本: <b>' + (rvSt.current ? esc(rvSt.current) : '未登记（手动配置）') + '</b></span>' +
    (rvSt.versions.length ? ' <select class="rm-sel" id="rmRvSel">' + rvOpts + '</select> <button class="rm-btn" onclick="window.ruleVersionSwitch()">切回此版本</button>' : '') + '</div>';
  box.innerHTML = `
    <div class="rm-topline">
      <span class="rm-sym">${esc(snap.sym)}</span>
      <span id="rmPrice" class="rm-price"></span>
      <span class="rm-chip ${snap.autoOn ? 'rm-on' : 'rm-offc'}">自动交易 ${snap.autoOn ? '开' : '关'}</span>
      <span class="rm-chip">带态 ${snap.band === 'upper' ? '上限' : snap.band === 'lower' ? '下限' : '中性'} K${fmtN(snap.k)} D${fmtN(snap.d)}</span>
      <span class="rm-chip">闸门 ${esc(regimeTxt)}</span>
      <span class="rm-chip">确认 ${snap.confirmN > 0 ? (snap.pendConfirmRaw ? `挂单 ${snap.pendConfirmRaw.count}/${snap.pendConfirmRaw.n}` : '开(' + snap.confirmN + '根)') : '关'}</span>
      <span class="rm-chip">PD ${snap.pdBlockOn ? (snap.pd && snap.pd.danger ? '<b class="rm-bad">危险(' + snap.pd.score + ')</b>' : '分数 ' + (snap.pd ? snap.pd.score : 0)) : '关'}</span>
      <span class="rm-chip">信号簿 ${_rm.mode === 'idb' ? 'IndexedDB' : '内存'}</span>
    </div>
    <div class="rm-verdict ${actCls[snap.verdict.action]}">本 tick 规则结论：<b>${actTxt}</b> — ${esc(snap.verdict.reason)}</div>
    <table class="rm-table"><tbody>${rowsHtml}</tbody></table>
    <div class="rm-stats">
      <div class="rm-stats-title">影子信号簿（近 ${stats.windowDays} 天 · 出场口径 2×ATR止盈/1.5×ATR止损 · 15m） <button class="rm-clear" onclick="window.ruleMonitorClear()">清空</button></div>
      <div class="rm-stats-grid">
        <span>信号 <b>${stats.total}</b></span>
        <span>拦截 <b>${stats.blocked}</b></span>
        <span>放行 <b>${stats.allowed}</b></span>
        <span>实际开仓 <b>${stats.opened}</b></span>
        <span>已回填 <b>${stats.backfilled}</b></span>
        <span>放行后前瞻胜率 <b>${wrTxt}</b>（${stats.allowedBackfilled} 笔）</span>
        <span>放行平均 ${fmtPct(stats.allowedAvgPnlPct, 2)}</span>
        <span>被拦组若放行胜率 <b>${bWrTxt}</b>（${stats.blockedBackfilled} 笔）</span>
      </div>
      <div class="rm-compare">${cmpTxt}</div>
      <div class="rm-byblock">${bbHtml}</div>
      <div class="rm-dim rm-note">放行后前瞻胜率 = 影子记为「应开」的信号，按 15m 收盘价 2×ATR/1.5×ATR 的前瞻结果；实际开仓对账 window.__srsiLiveTrades。与实盘成交级统计（S.closed）口径不同，仅作规则侧对照。</div>
    </div>
    <div class="rm-opt">
      <div class="rm-opt-head">🧪 一键优选（P2）— 离散规则维度单维轮换，近/长双窗一致正贡献才推荐，人工确认应用；应用即登记参数版本可回滚</div>
      ${optHtml}
      ${rvHtml}
    </div>`;
  updateHeadBadge(snap.verdict.action === 'open' ? '⚡' : snap.verdict.action === 'confirm' ? '⏳' : (snap.autoOn ? '●' : '○'));
  // 重填实时价（innerHTML 重建后）
  const pe2 = document.getElementById('rmPrice');
  if (pe2 && snap.price != null) pe2.textContent = '$' + fmtN(snap.price, snap.price > 100 ? 1 : 3);
}
function updateHeadBadge(txt) {
  const el = (typeof document !== 'undefined') && document.getElementById('ruleMonitorState');
  if (el) el.textContent = txt;
}

// ============================================================
// v1.5.54 HUD 仪表盘形态：canvas 主表（多空信号分 -100..+100，270°弧+淡色刻度）
//   + 3 副表（PD 预警 / 规则通过 / 带态K，半径30·弧宽7·13px 数字——比 demo 更大更清晰）
//   + 底部抽屉按钮（规则全表/统计/优选）+ 右侧滑出抽屉（挂 HUD 根，不受 body overflow 裁切）。
// 视觉参照 hud-demo.html（改进：①主表淡色刻度线 ②副表更大更清晰）。
// 数据流：renderRuleMonitor 每 tick 更新 _rmGauge.target → RAF 缓动重绘（lerp 0.06 + 噪声摆动）；
//   关闭（kToggleRuleMonitor / !open 分支）即 stopRmGauge()。
// ============================================================
const _rmGauge = { raf: 0, anim: { sig: 0, pd: 0, pass: 0, k: 0 }, target: null, tab: null, dpr: 1 };
const GAUGE_H = 158;
const PD_MAX_FACTORS = 5; // predictDanger 因子类数（1h/15m EMA偏离、K15超买卖、近根振幅、EMA120背离）
function gLerp(a, b, t) { return a + (b - a) * t; }
function gClamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

// 纯函数：多空信号分 = 空头分-多头分，钳制 ±100（主表读数；读不到 → 0）
export function sigScore(ls, ss) {
  const l = (ls == null || !isFinite(+ls)) ? 0 : +ls;
  const s = (ss == null || !isFinite(+ss)) ? 0 : +ss;
  return gClamp(s - l, -100, 100);
}

// 共享文案（HUD 表盘与流内文字版同源）：结论大字 + 拦截/放行小字
const SIDE_TXT = { long: '多', short: '空' };
function verdictHeadline(v) {
  if (!v) return '观望';
  if (v.action === 'open') return v.rev ? '应反手开' + (SIDE_TXT[v.side] || '') : '应开' + (SIDE_TXT[v.side] || '');
  if (v.action === 'confirm') return '确认推进中';
  return '观望';
}

// ---- 主表：270° 弧（-100..+100）三色区 + 淡色刻度线（每10分细 tick/每50分主 tick，弧外侧）+ 指针 + 中心结论 ----
function drawRmMainGauge(ctx, cx, cy, R, val, verdictTxt, verdictColor, blockedTxt) {
  const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25; // 270°
  const seg = (v0, v1, color) => {
    const t0 = a0 + (a1 - a0) * (v0 + 100) / 200, t1 = a0 + (a1 - a0) * (v1 + 100) / 200;
    ctx.beginPath(); ctx.arc(cx, cy, R, t0, t1);
    ctx.lineWidth = 9; ctx.strokeStyle = color; ctx.lineCap = 'butt'; ctx.stroke();
  };
  seg(-100, -25, 'rgba(255,82,82,.75)');
  seg(-25, 25, 'rgba(139,148,158,.35)');
  seg(25, 100, 'rgba(0,230,118,.75)');
  // 淡色刻度线（v1.5.54 改进①）：每 10 分细 tick #2a3442 长5px，每 50 分主 tick #4a5568 长8px
  for (let v = -100; v <= 100; v += 10) {
    const t = a0 + (a1 - a0) * (v + 100) / 200;
    const major = v % 50 === 0;
    const r1 = R + 6, r2 = R + 6 + (major ? 8 : 5);
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(t) * r1, cy + Math.sin(t) * r1);
    ctx.lineTo(cx + Math.cos(t) * r2, cy + Math.sin(t) * r2);
    ctx.lineWidth = 1; ctx.strokeStyle = major ? '#4a5568' : '#2a3442'; ctx.stroke();
  }
  // 空/中/多 标签
  ctx.font = '7px system-ui'; ctx.fillStyle = '#5a6572'; ctx.textAlign = 'center';
  for (const [v, lb] of [[-100, '空'], [0, '中'], [100, '多']]) {
    const t = a0 + (a1 - a0) * (v + 100) / 200;
    ctx.fillText(lb, cx + Math.cos(t) * (R + 21), cy + Math.sin(t) * (R + 21) + 2);
  }
  // 指针（发光）
  const t = a0 + (a1 - a0) * (gClamp(val, -100, 100) + 100) / 200;
  const nx = cx + Math.cos(t) * (R - 16), ny = cy + Math.sin(t) * (R - 16);
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(nx, ny);
  ctx.lineWidth = 3; ctx.strokeStyle = '#e6edf3'; ctx.lineCap = 'round';
  ctx.shadowColor = 'rgba(230,237,243,.8)'; ctx.shadowBlur = 6; ctx.stroke(); ctx.shadowBlur = 0;
  ctx.beginPath(); ctx.arc(cx, cy, 4.5, 0, 7); ctx.fillStyle = '#e6edf3'; ctx.fill();
  ctx.beginPath(); ctx.arc(cx, cy, 1.8, 0, 7); ctx.fillStyle = '#0d1117'; ctx.fill();
  // 中心结论大字（15px 800，色同 demo 规则）+ 拦截/放行小字
  ctx.font = '800 15px system-ui';
  ctx.fillStyle = verdictColor || '#FFB300'; ctx.textAlign = 'center';
  ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 10;
  ctx.fillText(verdictTxt || '—', cx, cy + 34); ctx.shadowBlur = 0;
  ctx.font = '9px system-ui'; ctx.fillStyle = '#8b949e';
  ctx.fillText(blockedTxt || '', cx, cy + 47);
}

// ---- 副表：小弧 + 大数字（v1.5.54 改进②：半径30/弧宽7/13px 800 数字/9px 标签 + 每25% 淡刻度）----
function drawRmSubGauge(ctx, cx, cy, R, label, val, max, color, warnAt, valTxt, greenLow) {
  const a0 = Math.PI * 0.85, a1 = Math.PI * 2.15;
  // 底弧
  ctx.beginPath(); ctx.arc(cx, cy, R, a0, a1);
  ctx.lineWidth = 7; ctx.strokeStyle = 'rgba(139,148,158,.22)'; ctx.lineCap = 'round'; ctx.stroke();
  // 警戒段（红）：PD 达标线 / K 上带(80-100)
  if (warnAt != null) {
    const t0 = a0 + (a1 - a0) * gClamp(warnAt, 0, max) / max;
    ctx.beginPath(); ctx.arc(cx, cy, R, t0, a1);
    ctx.strokeStyle = 'rgba(255,82,82,.5)'; ctx.stroke();
  }
  // 下带段（绿）：带态 K 0-20 = 多头信号区
  if (greenLow) {
    const tg2 = a0 + (a1 - a0) * 20 / max;
    ctx.beginPath(); ctx.arc(cx, cy, R, a0, tg2);
    ctx.strokeStyle = 'rgba(0,230,118,.35)'; ctx.stroke();
  }
  // 值弧（更饱和值色 + 发光）
  const t1 = a0 + (a1 - a0) * gClamp(val, 0, max) / max;
  ctx.beginPath(); ctx.arc(cx, cy, R, a0, t1);
  ctx.strokeStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 6; ctx.stroke(); ctx.shadowBlur = 0;
  // 淡刻度（每 25%，弧外侧）
  for (let i = 0; i <= 4; i++) {
    const t = a0 + (a1 - a0) * i / 4;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(t) * (R + 5), cy + Math.sin(t) * (R + 5));
    ctx.lineTo(cx + Math.cos(t) * (R + 9), cy + Math.sin(t) * (R + 9));
    ctx.lineWidth = 1; ctx.strokeStyle = '#2a3442'; ctx.stroke();
  }
  // 数字（13px 800 主色）+ 标签（9px）
  ctx.font = '800 13px system-ui'; ctx.fillStyle = '#e6edf3'; ctx.textAlign = 'center';
  ctx.fillText(valTxt != null ? valTxt : Math.round(val), cx, cy + 4);
  ctx.font = '9px system-ui'; ctx.fillStyle = '#9aa4b2';
  ctx.fillText(label, cx, cy + 19);
}

// 纯绘制函数（导出可单测传 stub ctx）：主表居左 + 3 副表右排（宽度自适应，目标半径 30）
export function drawRmGauge(ctx, W, H, anim, target) {
  if (!ctx || !W || !H) return;
  const a = anim || { sig: 0, pd: 0, pass: 0, k: 0 };
  const tg = target || {};
  ctx.clearRect(0, 0, W, H);
  const RM = W >= 300 ? 54 : (W >= 260 ? 48 : 42);   // 主表半径
  const cxM = RM + 14, cyM = H * 0.60;               // 主表圆心
  const Rs = gClamp(Math.floor((W - (cxM + RM + 8) - 24) / 6), 17, 30); // 副表半径（≤30，防重叠）
  const sGap = 2 * Rs + 7;
  const x3 = W - Rs - 5, x2 = x3 - sGap, x1 = x2 - sGap;
  const cyS = cyM - 2;
  drawRmMainGauge(ctx, cxM, cyM, RM, a.sig, tg.verdictTxt, tg.verdictColor, tg.blockedTxt);
  const need = (tg.pdNeed == null) ? null : tg.pdNeed;
  drawRmSubGauge(ctx, x1, cyS, Rs, 'PD 预警', a.pd, 100,
    (need != null && a.pd >= need) ? '#FF5252' : '#6ea8fe', need, tg.pdTxt != null ? tg.pdTxt : String(Math.round(a.pd)));
  drawRmSubGauge(ctx, x2, cyS, Rs, '规则通过', a.pass, tg.total || 11,
    a.pass >= (tg.total || 11) ? '#00E676' : '#FFB300', null, Math.round(a.pass) + '/' + (tg.total || 11));
  drawRmSubGauge(ctx, x3, cyS, Rs, '带态 K', a.k, 100,
    a.k >= 80 ? '#FF5252' : a.k <= 20 ? '#00E676' : '#9aa4b2', 80, String(Math.round(a.k)), true);
}

// ---- 画布尺寸（box.clientWidth 去内边距，≤340；DPR 适配；不存在/宽度变了即重建）----
const GAUGE_W = 298; // 固定逻辑分辨率 + CSS width:100% 等比缩放 → 展开即终尺寸，无先小后大跳变（v1.5.55）
function setupGaugeCanvas(box) {
  if (typeof document === 'undefined' || !box) return null;
  let cv = document.getElementById('rmGaugeCv');
  if (!cv || cv.parentElement !== box) {
    if (cv) cv.remove();
    cv = document.createElement('canvas');
    cv.id = 'rmGaugeCv';
    box.insertBefore(cv, box.querySelector('.rm-gbtns') || null);
  }
  const dpr = Math.max(1, (typeof devicePixelRatio !== 'undefined' && devicePixelRatio) || 1);
  _rmGauge.dpr = dpr;
  if (+cv.dataset.w !== GAUGE_W) {
    cv.dataset.w = String(GAUGE_W);
    cv.width = GAUGE_W * dpr; cv.height = GAUGE_H * dpr;
    cv.style.width = '100%'; cv.style.height = 'auto'; // 显示尺寸交给 CSS，绘制坐标恒定
  }
  return cv;
}

// ---- RAF 缓动循环（lerp 0.06 + sin 噪声摆动，同 demo）----
function gaugeFrame() {
  _rmGauge.raf = 0;
  const cv = (typeof document !== 'undefined') && document.getElementById('rmGaugeCv');
  const tg = _rmGauge.target;
  const cfg = cfgNow;
  if (!cv || !tg || !cfg || !cfg.ruleMonitorOpen) return; // HUD 关/画布没了 → 自停
  const ctx = cv.getContext && cv.getContext('2d');
  if (!ctx) return;
  const W = cv.clientWidth || +cv.dataset.w || 298;
  const t = nowMs();
  const a = _rmGauge.anim;
  a.sig = gLerp(a.sig, gClamp(tg.sig + Math.sin(t / 900) * 6, -100, 100), 0.06);
  a.pd = gLerp(a.pd, gClamp(tg.pd + Math.sin(t / 1300) * 3, 0, 100), 0.06);
  a.pass = gLerp(a.pass, tg.pass, 0.08);
  a.k = gLerp(a.k, gClamp(tg.k + Math.sin(t / 1100) * 4, 0, 100), 0.06);
  ctx.setTransform(_rmGauge.dpr, 0, 0, _rmGauge.dpr, 0, 0);
  try { drawRmGauge(ctx, W, GAUGE_H, a, tg); } catch (e) {}
  _rmGauge.raf = (typeof requestAnimationFrame !== 'undefined') ? requestAnimationFrame(gaugeFrame) : 0;
}
function ensureRmGauge() {
  if (_rmGauge.raf || typeof requestAnimationFrame === 'undefined') return;
  _rmGauge.raf = requestAnimationFrame(gaugeFrame);
}
function stopRmGauge() {
  if (_rmGauge.raf && typeof cancelAnimationFrame !== 'undefined') { try { cancelAnimationFrame(_rmGauge.raf); } catch (e) {} }
  _rmGauge.raf = 0;
}

// ---- 表盘数据目标（renderRuleMonitor 每 tick 更新，签名守卫之外）----
function updateGaugeTarget(snap) {
  const S = globalThis.S;
  const sc = (S && S.ai && S.ai.lastScores && S.ai.lastScores[snap.sym]) || null;
  const v = snap.verdict || {};
  const vt = verdictHeadline(v);
  const pdScore = snap.pd ? snap.pd.score : 0;
  // PD 表盘 0-100 = 命中因子数/5；警戒线 = PD 拦截开启时的危险阈值（PREDICT_MIN 归一化，读不到回退 75）
  const pdPct = gClamp(pdScore / PD_MAX_FACTORS * 100, 0, 100);
  const needPct = (typeof THRESH !== 'undefined' && THRESH.PREDICT_MIN)
    ? gClamp(THRESH.PREDICT_MIN / PD_MAX_FACTORS * 100, 0, 100) : 75;
  _rmGauge.target = {
    sym: snap.sym, price: snap.price,
    sig: sc ? sigScore(sc.ls, sc.ss) : 0,
    pd: pdPct, pdTxt: pdScore + '/' + PD_MAX_FACTORS,
    pdNeed: snap.pdBlockOn ? needPct : null,
    pass: (snap.rules || []).filter(r => r.state === 'pass').length,
    total: (snap.rules || []).length || 11,
    k: (snap.k != null && isFinite(+snap.k)) ? +snap.k : 0,
    verdictTxt: vt,
    verdictColor: vt.indexOf('多') >= 0 ? '#00E676' : vt.indexOf('空') >= 0 ? '#FF5252' : '#FFB300',
    blockedTxt: v.blockedBy ? '⛔ ' + blockReasonTxt(v.blockedBy) : '✓ 放行'
  };
}

// ---- HUD bar 标题（保留 ✕；每 tick 更新价）----
function updateHudBarTitle(snap) {
  if (typeof document === 'undefined') return;
  const bar = document.getElementById('discHudBar');
  if (!bar) return;
  let t = bar.querySelector('#hudTitle') || bar.querySelector('.hud-title');
  if (!t) {
    t = document.createElement('span');
    t.className = 'hud-title'; t.id = 'hudTitle';
    bar.insertBefore(t, bar.firstChild || null);
  }
  const p = snap && snap.price;
  const priceTxt = (p != null && isFinite(+p)) ? ' · $' + fmtN(+p, +p > 100 ? 1 : 3) : '';
  t.innerHTML = '<span class="live-dot"></span>规则监测 · ' + esc((snap && snap.sym) || '') + priceTxt;
}

// ---- 右侧抽屉（挂 HUD 根，幂等创建；三 tab 复用真实数据构建函数）----
const DR_TABS = { rules: '规则全表', stats: '统计对比', opt: '一键优选 · 参数版本' };
function ensureDrawer(hudRoot) {
  let dr = hudRoot.querySelector('.rm-drawer');
  if (!dr) {
    dr = document.createElement('div');
    dr.className = 'rm-drawer';
    dr.id = 'rmDrawer';
    dr.innerHTML = '<div class="rm-dr-head"><span class="rm-dr-title">详情</span><span class="rm-dr-x" data-dr="close">✕</span></div><div class="rm-dr-body" id="rmDrBody"></div>';
    hudRoot.appendChild(dr);
  }
  return dr;
}
function bindDrawerEvents(hudRoot) {
  if (!hudRoot || hudRoot.dataset.rmDrBound) return;
  hudRoot.dataset.rmDrBound = '1';
  hudRoot.addEventListener('click', (e) => {
    const btn = e.target.closest('.rm-gbtn[data-dr]');
    if (btn) { setDrawerTab(btn.dataset.dr); return; }
    if (e.target.closest('[data-dr="close"]')) setDrawerTab(null);
  });
}
function setDrawerTab(tab) {
  if (typeof document === 'undefined') return;
  const hudRoot = document.getElementById('discHud');
  const drawer = hudRoot && hudRoot.querySelector('.rm-drawer');
  if (!hudRoot || !drawer) return;
  if (_rmGauge.tab === tab) tab = null; // 再点同 tab / ✕ → 收起
  _rmGauge.tab = tab || null;
  hudRoot.querySelectorAll('.rm-gbtn').forEach(b => b.classList.toggle('on', !!_rmGauge.tab && b.dataset.dr === _rmGauge.tab));
  if (!_rmGauge.tab) { drawer.classList.remove('open'); return; }
  refreshDrawer();
  drawer.classList.add('open');
}
function refreshDrawer() {
  if (typeof document === 'undefined' || !_rmGauge.tab) return;
  const hudRoot = document.getElementById('discHud');
  const drawer = hudRoot && hudRoot.querySelector('.rm-drawer');
  if (!drawer) return;
  const snap = _rm.lastSnapshot;
  if (!snap) return;
  const title = drawer.querySelector('.rm-dr-title');
  const body = drawer.querySelector('.rm-dr-body');
  if (!title || !body) return;
  title.textContent = DR_TABS[_rmGauge.tab] || '详情';
  if (_rmGauge.tab === 'rules') {
    body.innerHTML = '<div class="sec"><div class="sec-t">规则链（' + snap.rules.length + ' 条，按引擎同序）</div>' +
      buildRulesRowsHtml(snap.rules) +
      '<div class="rm-dim" style="margin-top:6px">✗ 的规则即当前未放行的原因；影子计算与引擎同序只读代入，不影响实盘状态机。</div></div>';
  } else if (_rmGauge.tab === 'stats') {
    body.innerHTML = buildStatsHtml(computeRuleStats(_rm.signals, nowMs(), 7));
  } else {
    body.innerHTML = buildOptHtml(_rmOpt, readRvStore());
  }
}

// ---- 抽屉 tab 内容构建（导出纯函数：模板字符串、无 DOM 依赖、可单测）----
export function buildRulesRowsHtml(rules) {
  return (rules || []).map(r => {
    const cls = r.state === 'fail' ? 'bad' : r.state === 'active' ? 'warn' : r.state === 'off' ? 'dim' : 'ok';
    return '<div class="row"><span>' + ruleStateBadge(r.state) + ' ' + esc(r.name) + '</span><span class="' + cls + '">' + esc(r.detail) + '</span></div>';
  }).join('');
}
export function buildStatsHtml(stats) {
  if (!stats) return '<div class="sec"><div class="rm-dim">暂无统计</div></div>';
  const wrPct = stats.fwdWinRate == null ? null : Math.round(stats.fwdWinRate * 100);
  const bWrPct = stats.blockedIfAllowedWinRate == null ? null : Math.round(stats.blockedIfAllowedWinRate * 100);
  const wrTxt = wrPct == null ? '--' : wrPct + '%';
  const bWrTxt = bWrPct == null ? '--' : bWrPct + '%';
  const cmpTxt = (stats.fwdWinRate != null && stats.blockedIfAllowedWinRate != null)
    ? (stats.blockedIfAllowedWinRate < stats.fwdWinRate ? '拦截规则整体<b class="rm-good">拦对了</b>（被拦组若放行表现更差）'
      : stats.blockedIfAllowedWinRate > stats.fwdWinRate ? '<b class="rm-bad">拦错了？</b>被拦组若放行表现更好，考虑放宽' : '两组相当')
    : '待样本';
  const bb = stats.byBlock || {};
  const bbKeys = Object.keys(bb);
  const bbHtml = bbKeys.length
    ? bbKeys.map(k => {
      const b = bb[k];
      const w = b.fwdWinRate == null ? '样本不足' : Math.round(b.fwdWinRate * 100) + '%';
      const pnl = b.avgPnlPct == null ? '' : ' 平均' + fmtPct(b.avgPnlPct, 2);
      return '<span class="rm-chip">「' + esc(blockReasonTxt(k)) + '」拦 ' + b.n + ' 次 · 若放行胜率 ' + w + pnl + '</span>';
    }).join(' ')
    : '<span class="rm-dim">暂无拦截记录</span>';
  return '<div class="sec">' +
    '<div class="sec-t">影子信号簿（近 ' + (stats.windowDays || 7) + ' 天） <button class="rm-clear" onclick="window.ruleMonitorClear()">清空</button></div>' +
    '<div class="stat-grid">' +
    '<div class="stat-cell"><div class="stat-num">' + stats.total + '</div><div class="stat-lbl">信号</div></div>' +
    '<div class="stat-cell"><div class="stat-num">' + stats.blocked + '</div><div class="stat-lbl">拦截</div></div>' +
    '<div class="stat-cell"><div class="stat-num">' + stats.allowed + '</div><div class="stat-lbl">放行</div></div>' +
    '<div class="stat-cell"><div class="stat-num">' + stats.opened + '</div><div class="stat-lbl">实际开仓</div></div>' +
    '</div>' +
    '<div class="sec-t" style="margin-top:6px">放行 vs 拦截（前瞻胜率）</div>' +
    '<div class="row"><span>放行组 2×ATR 先到</span><span class="ok">' + wrTxt + '（' + stats.allowedBackfilled + ' 笔）</span></div>' +
    '<div class="bar-wrap"><div class="bar-fill" style="width:' + (wrPct || 0) + '%;background:#00E676"></div></div>' +
    '<div class="row"><span>被拦组「若放行」</span><span class="bad">' + bWrTxt + '（' + stats.blockedBackfilled + ' 笔）</span></div>' +
    '<div class="bar-wrap"><div class="bar-fill" style="width:' + (bWrPct || 0) + '%;background:#FF5252"></div></div>' +
    '<div class="rm-dim" style="margin-top:3px">' + cmpTxt + '</div>' +
    '<div class="sec-t" style="margin-top:8px">分拦截原因贡献</div>' +
    '<div class="rm-byblock">' + bbHtml + '</div>' +
    '<div class="rm-dim" style="margin-top:4px">前瞻口径：15m 收盘 2×ATR止盈/1.5×ATR止损；开仓对账 __srsiLiveTrades。与实盘成交级统计（S.closed）口径不同。</div>' +
    '</div>';
}
function fmtPnlBt(s) { return s ? fmtPct(s.pnlPct, 1) + '/DD' + fmtN(s.maxDD, 0) + '%/强平' + s.liqCount : '--'; }
export function buildOptHtml(opt, rvSt) {
  opt = opt || {};
  rvSt = rvSt || { current: null, versions: [] };
  let html = '<div class="sec"><div class="sec-t">🧪 一键优选（P2）</div>';
  if (opt.running) {
    const p = opt.progress || {};
    html += '<div class="rm-opt-progress">⏳ ' + esc(p.label || '') + (p.n ? ' (' + p.i + '/' + p.n + ')' : '') + '</div>';
  } else {
    const rows = (opt.result && opt.result.rows) || [];
    if (rows.length) {
      const nPick = rows.filter(r => r.pick).length;
      html += '<div class="rm-opt-table"><table><tr><th>维度</th><th>基线→推荐</th><th>近窗Δ</th><th>长窗Δ</th></tr>' +
        rows.map(r => '<tr class="' + (r.pick ? 'rm-pick' : '') + '"><td>' + esc(r.label) + '</td><td>' + esc(String(r.baseValue)) + ' → ' + (r.pick ? '<b>' + esc(String(r.value)) + '</b>' : '保持') + '</td><td>' + (r.nearΔ == null ? '--' : fmtPct(r.nearΔ, 1)) + '</td><td>' + (r.longΔ == null ? '--' : fmtPct(r.longΔ, 1)) + '</td></tr>').join('') +
        '</table><div class="rm-dim">基线 近/长: ' + fmtPnlBt(opt.result.base && opt.result.base.near) + ' | ' + fmtPnlBt(opt.result.base && opt.result.base.long) + '</div></div>' +
        (nPick && !opt.result.applied ? '<button class="rm-btn rm-btn-primary" onclick="window.ruleOptimizeApply()">✓ 应用推荐（' + nPick + ' 项 · 写入 cfg 立即生效）</button> '
          : opt.result.applied ? '<span class="rm-good">已应用</span> ' : '<span class="rm-dim">无双窗一致正贡献的候选 → 保持现配置</span> ');
    }
    html += '<button class="rm-btn" onclick="window.ruleOptimizeRun()"' + (opt.running ? ' disabled' : '') + '>🧪 一键优选（单维轮换 × 近45d/长90d 双窗一致）</button>';
    if (opt.error) html += '<div class="rm-bad rm-opt-err">优选失败: ' + esc(opt.error) + '</div>';
  }
  const rvVers = rvSt.versions || [];
  const rvOpts = rvVers.slice().reverse().map(v => '<option value="' + esc(v.id) + '"' + (v.id === rvSt.current ? ' selected' : '') + '>' + esc(String(v.id).replace('rv-', '') + ' ' + (v.label || '')) + '</option>').join('');
  html += '<div class="rm-rv"><span class="rm-dim">参数版本: <b>' + (rvSt.current ? esc(rvSt.current) : '未登记（手动配置）') + '</b></span>' +
    (rvVers.length ? ' <select class="rm-sel" id="rmRvSel">' + rvOpts + '</select> <button class="rm-btn" onclick="window.ruleVersionSwitch()">切回此版本</button>' : '') +
    '</div></div>';
  return html;
}
function forceRender() { _rm.lastRenderSig = ''; renderRuleMonitor(); }

// 折叠切换（kchartApi + window 双绑定由调用方接线；GOAL13 红线）
export function kToggleRuleMonitor() {
  const cfg = cfgNow || (typeof window !== 'undefined' && window.kchartApi && window.kchartApi.getConfig());
  if (!cfg) return;
  cfg.ruleMonitorOpen = !cfg.ruleMonitorOpen;
  if (!cfg.ruleMonitorOpen) stopRmGauge(); // v1.5.54：关 HUD 即停仪表 RAF
  if (typeof window !== 'undefined' && window.kchartApi && window.kchartApi.__persist) window.kchartApi.__persist();
  forceRender();
  try { renderDiscHud(); } catch (e) {} // v1.5.52：HUD 开/关即时反馈（不等下一 tick）
}

// 单测钩子
export function __ruleMonitorTestState() { return { mode: _rm.mode, n: _rm.signals.length, signals: _rm.signals }; }

// v1.5.52 纯函数：HUD 卡位置 clamp 到主图容器内（留 4px 边距；卡片宽/高超过容器则贴左上 4px）。
// 非数字输入返回默认位置 {x:4,y:4}。
export function hudClampPos(x, y, w, h, bw, bh) {
  if (![x, y, w, h, bw, bh].every(v => typeof v === 'number' && isFinite(v))) return { x: 4, y: 4 };
  const cx = bw - w - 4, cy = bh - h - 4;
  return {
    x: Math.max(4, Math.min(cx < 4 ? 4 : cx, x)),
    y: Math.max(4, Math.min(cy < 4 ? 4 : cy, y))
  };
}

// ============================================================
// P2：一键优选 + 参数版本化
// 优选对象 = 离散规则维度（单维轮换，非全网格——防过拟合 + 控回测成本）；
// 双窗一致（近窗 45d + 长窗 90d 相对基线都正贡献）才推荐；人工确认才应用。
// 版本化：rv-<ts>-<hash8>，localStorage 版本表（小）+ 应用即写 cfg（引擎每秒读 cfg 立即生效）。
// ============================================================
import { backtestSrsiAuto, fetchKlinesRange, renderDiscHud } from './kchart.js';

const OPT_DIMS = [
  { key: 'srsiAutoRegimeGate', label: 'regime闸门', values: ['off', 'confirm', 'size', 'tconf'] },
  { key: 'srsiAutoConfirmBars', label: '确认bar', values: [0, 1, 2] },
  { key: 'srsiAutoPdBlockOn', label: 'PD-A拦截', values: [false, true] },
  { key: 'srsiAutoDanger', label: '防爆模式', values: ['none', 'filter', 'smart', 'reverse'] },
  { key: 'srsiAutoHotStop', label: '热停', values: [false, true] },
  { key: 'srsiAutoMaxSame', label: '同向上限', values: [2, 3, 5] }
];
// 近窗/长窗（天）——walk-forward 语义：候选在两窗都优于基线才推荐
const OPT_NEAR_DAYS = 45, OPT_LONG_DAYS = 90;
const RV_LS_KEY = 'smartTrader_rv', RV_MAX = 20;

// 纯函数：单维轮换候选集（排除与基线相同的值）
export function btCandidates(base) {
  const out = [];
  for (const d of OPT_DIMS) {
    for (const v of d.values) {
      if (base[d.key] === v) continue;
      out.push({ key: d.key, value: v, label: d.label });
    }
  }
  return out;
}

// 纯函数：回测结果提分数（透明口径：主排序 pnlPct，tie-break 强平少 → 回撤小）
export function scoreBt(r) {
  if (!r || r.error) return null;
  return {
    pnlPct: +r.pnlPct || 0,
    liqCount: r.liqCount || 0,
    maxDD: +r.maxDD || 0,
    opens: (r.longs || 0) + (r.shorts || 0),
    winRate: r.winRate || 0
  };
}
function btBetter(a, b) { // a 是否优于 b
  if (a.pnlPct !== b.pnlPct) return a.pnlPct > b.pnlPct;
  if (a.liqCount !== b.liqCount) return a.liqCount < b.liqCount;
  return a.maxDD < b.maxDD;
}

// 纯函数：双窗一致正贡献才推荐。candScores: [{key,value,label,near,long}]
// 返回 { changes:{key:value}, rows:[{key,label,baseValue,value,nearΔ,longΔ,pick}] }
export function pickWinners(base, candScores) {
  const changes = {};
  const rows = [];
  for (const c of candScores || []) {
    const ok = !!(c.near && c.long &&
      c.near.pnlPct > base.near.pnlPct && c.long.pnlPct > base.long.pnlPct);
    rows.push({
      key: c.key, label: c.label, value: c.value, baseValue: base[c.key],
      nearΔ: c.near ? +(c.near.pnlPct - base.near.pnlPct).toFixed(2) : null,
      longΔ: c.long ? +(c.long.pnlPct - base.long.pnlPct).toFixed(2) : null,
      pick: false
    });
    if (!ok) continue;
    // 同维取更优（近窗为主排序，长窗必须同号为正贡献；tie-break 与全局一致）
    const prev = rows.find(r => r.key === c.key && r.pick);
    if (prev) {
      const pv = candScores.find(x => x.key === c.key && x.value === prev.value);
      const better = btBetter({ pnlPct: c.near.pnlPct + c.long.pnlPct, liqCount: c.near.liqCount + c.long.liqCount, maxDD: c.near.maxDD + c.long.maxDD },
        { pnlPct: pv.near.pnlPct + pv.long.pnlPct, liqCount: pv.near.liqCount + pv.long.liqCount, maxDD: pv.near.maxDD + pv.long.maxDD });
      if (!better) continue;
      prev.pick = false;
    }
    changes[c.key] = c.value;
    const me = rows.find(r => r.key === c.key && r.value === c.value);
    if (me) me.pick = true;
  }
  return { changes, rows };
}

// 纯函数：FNV-1a 32bit → 8 hex（版本指纹，稳定同步无依赖）
export function rvHashOf(params) {
  const s = JSON.stringify(params);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
  return ('00000000' + h.toString(16)).slice(-8);
}

// ---- 版本表（localStorage 小对象；写入走 _safeSetItem 配额自愈）----
function readRvStore() {
  try {
    const raw = localStorage.getItem(RV_LS_KEY);
    const o = raw ? JSON.parse(raw) : null;
    if (o && Array.isArray(o.versions)) return o;
  } catch (e) {}
  return { current: null, versions: [] };
}
function writeRvStore(st) {
  if (st.versions.length > RV_MAX) st.versions = st.versions.slice(-RV_MAX);
  _safeSetItem(RV_LS_KEY, JSON.stringify(st));
}
export function rvCurrent() { return readRvStore().current; }

// 应用参数集（写 cfg + persist → 引擎每秒读 cfg 立即生效）并登记版本
export function rvApply(params, label, btInfo) {
  const cfg = cfgNow || ((typeof window !== 'undefined') && window.kchartApi && window.kchartApi.getConfig());
  if (!cfg || !params) return null;
  const clean = {};
  for (const d of OPT_DIMS) if (d.key in params) clean[d.key] = params[d.key];
  const id = 'rv-' + new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '') + '-' + rvHashOf(clean);
  Object.assign(cfg, clean);
  if (typeof window !== 'undefined' && window.kchartApi && window.kchartApi.__persist) window.kchartApi.__persist();
  const st = readRvStore();
  st.versions.push({ id, ts: Date.now(), label: label || '一键优选', params: clean, bt: btInfo || null });
  st.current = id;
  writeRvStore(st);
  forceRender();
  return id;
}
// 切回历史版本（重新应用其 params，登记为「回滚」版本）
export function rvSwitchTo(id) {
  const st = readRvStore();
  const v = st.versions.find(x => x.id === id);
  if (!v) return null;
  return rvApply(v.params, '回滚→' + v.label, v.bt);
}

// ---- 优选编排（异步分批，UI 呼吸；config 显式注入不污染实盘）----
const _optData = { t: 0, sym: null, kl: null };
async function ensureOptData(sym, onP) {
  const now = Date.now();
  if (_optData.kl && _optData.sym === sym && now - _optData.t < 10 * 60 * 1000) return _optData.kl;
  const endMs = now, startMs = now - OPT_LONG_DAYS * 86400000;
  const warmupMs = 140 * 15 * 60 * 1000;
  const fs = startMs - warmupMs;
  const maxBars = Math.ceil(OPT_LONG_DAYS * 96) + 256;
  if (onP) onP({ phase: 'fetch', label: '拉取历史 K线（90d×4 周期）', i: 0, n: 4 });
  const [k15, k1h, k30, k4h] = await Promise.all([
    fetchKlinesRange(sym, '15m', fs, endMs, null, maxBars),
    fetchKlinesRange(sym, '1h', fs, endMs, null, maxBars),
    fetchKlinesRange(sym, '30m', fs, endMs, null, maxBars),
    fetchKlinesRange(sym, '4h', fs, endMs, null, maxBars)
  ]);
  _optData.kl = { '15m': k15, '1h': k1h, '30m': k30, '4h': k4h };
  _optData.sym = sym; _optData.t = now;
  return _optData.kl;
}
function candConfig(base, key, value) {
  const c = Object.assign({}, base);
  c[key] = value;
  return c;
}
function runBt(sym, kl, config, windowStart) {
  try {
    return scoreBt(backtestSrsiAuto(sym, kl, config, 1000, windowStart, null, { mode: 'perp' }));
  } catch (e) { return null; }
}
const _rmOpt = { running: false, progress: null, result: null, error: null };
// 切回历史版本（从面板下拉选中的 id；重新应用其 params，登记为「回滚」版本）
export function ruleVersionSwitch() {
  const sel = (typeof document !== 'undefined') && document.getElementById('rmRvSel');
  if (!sel || !sel.value) return null;
  return rvSwitchTo(sel.value);
}
export function ruleOptState() { return _rmOpt; }
export async function ruleOptimizeRun() {
  if (_rmOpt.running) return null;
  const cfg = cfgNow || ((typeof window !== 'undefined') && window.kchartApi && window.kchartApi.getConfig());
  if (!cfg) return null;
  _rmOpt.running = true; _rmOpt.result = null; _rmOpt.error = null; _rmOpt.progress = { phase: 'start', label: '准备中', i: 0, n: 0 };
  forceRender();
  try {
    const sym = cfg.symbol;
    const kl = await ensureOptData(sym, (p) => { _rmOpt.progress = p; forceRender(); });
    const n15 = kl && kl['15m'] && (kl['15m'].closes || kl['15m']).length || 0;
    const klOk = kl && kl['15m'] && n15 > 200;
    if (!klOk) throw new Error('15m 历史数据不足（' + n15 + ' 根）');
    const now = Date.now();
    const winNear = now - OPT_NEAR_DAYS * 86400000, winLong = now - OPT_LONG_DAYS * 86400000;
    const cands = btCandidates(cfg);
    const total = (cands.length + 1) * 2;
    let done = 0;
    const step = () => new Promise(r => setTimeout(r, 0)); // 让 UI 呼吸
    _rmOpt.progress = { phase: 'bt', label: '基线回测', i: 0, n: total };
    forceRender(); await step();
    const base = { near: runBt(sym, kl, cfg, winNear), long: runBt(sym, kl, cfg, winLong) };
    done += 2; _rmOpt.progress = { phase: 'bt', label: '基线完成', i: done, n: total }; forceRender();
    if (!base.near || !base.long) throw new Error('基线回测失败（数据不足）');
    const scored = [];
    for (let i = 0; i < cands.length; i++) {
      const cd = cands[i];
      const cc = candConfig(cfg, cd.key, cd.value);
      _rmOpt.progress = { phase: 'bt', label: (cd.label + '→' + cd.value), i: done, n: total };
      forceRender(); await step();
      const near = runBt(sym, kl, cc, winNear);
      const long = runBt(sym, kl, cc, winLong);
      scored.push({ ...cd, near, long });
      done += 2;
    }
    const { changes, rows } = pickWinners(
      { ...base, srsiAutoRegimeGate: cfg.srsiAutoRegimeGate, srsiAutoConfirmBars: cfg.srsiAutoConfirmBars, srsiAutoPdBlockOn: cfg.srsiAutoPdBlockOn, srsiAutoDanger: cfg.srsiAutoDanger, srsiAutoHotStop: cfg.srsiAutoHotStop, srsiAutoMaxSame: cfg.srsiAutoMaxSame },
      scored
    );
    _rmOpt.result = { sym, ts: Date.now(), base, changes, rows, applied: false };
    _rmOpt.error = null;
  } catch (e) {
    _rmOpt.error = (e && e.message) || String(e);
  }
  _rmOpt.running = false; _rmOpt.progress = null;
  forceRender();
  return _rmOpt.result;
}
export function ruleOptimizeApply() {
  const r = _rmOpt.result;
  if (!r || !r.changes || !Object.keys(r.changes).length) return null;
  const id = rvApply(r.changes, '一键优选 ' + new Date().toISOString().slice(5, 16).replace('T', ' '), { near: r.base.near, long: r.base.long, changes: r.changes });
  if (id) { r.applied = true; forceRender(); }
  return id;
}

// 单测钩子（P2）
export function __ruleMonitorOptDims() { return OPT_DIMS; }
export function __ruleOptTest() { return { sym: _optData.sym, cached: !!_optData.kl }; }
