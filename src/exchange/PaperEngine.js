import { ExchangeAdapter, ORDER_TYPE } from './ExchangeAdapter.js';
import { createOrder, applyFill, applyCancel, applyReject, nextOrderId } from './orderState.js';
import { calcFee, openNotional, closeNotional } from '../engine/fees.js';
import { settleFundingFor, msUntilFunding } from '../engine/funding.js';
import { checkLiquidation as detectLiquidation } from '../engine/liquidation.js';
import { THRESH } from '../engine/thresholds.js';

// 波动滑点参数: slip = base + SLIP_K×ATR% (cap)
const SLIP_K = THRESH.SLIP_K;
const SLIP_CAP = THRESH.SLIP_CAP;

/**
 * PaperEngine — 纸面撮合引擎（实现 ExchangeAdapter 接口）
 *
 * 设计要点：
 *  - 只消费"真实行情"（stateRef 提供的价格），不使用随机模拟，保证与真实一致
 *  - 撮合模型：当前为"参考价 + 滑点保护"模型（与真实订单簿深度模型可替换）
 *  - 账户/风控数学（手续费、资金费率、强平、平仓结算、已实现盈亏）集中在此，
 *    纸面与未来真实共用，保证结果一致
 *  - 每笔订单/资金/强平产生事件（onOrder/onFunding/onLiquidation），可被事件溯源持久化
 */
export class PaperEngine extends ExchangeAdapter {
  constructor({ stateRef, fee, onLog = () => {}, getSlip = () => 0.0002 }) {
    super({ paper: true });
    this.name = 'paper';
    this.stateRef = stateRef;
    this._log = onLog;
    this._getSlip = getSlip;
    this._orders = new Map();       // orderId -> order
    this._feeOverride = fee;
    this._lastFundingCheck = Date.now();
  }

  get S() { return this.stateRef(); }
  get slip() { return this._getSlip(); }

  /** 动态滑点: 基础滑点 + 波动加成(ATR%高→更大不利偏移, 更接近真实市场冲击) */
  _slipFor(symbol) {
    const base = this.slip || 0;
    let atrPct = 0;
    try {
      const AS = this.S.ai && this.S.ai.atrSuper;
      if (AS && AS[symbol]) {
        const st = AS[symbol]['1t'] || AS[symbol]['1m'];
        if (st && st.pctHis && st.pctHis.length) {
          const cur = st.pctHis[st.pctHis.length - 1];
          if (typeof cur === 'number' && Number.isFinite(cur) && cur > 0 && cur < 0.2) atrPct = cur;
        }
      }
    } catch (e) { /* 无监督ATR时仅用基础滑点 */ }
    return Math.min(SLIP_CAP, base + SLIP_K * atrPct);
  }

  _fee(exchange, notional, opts) {
    return this._feeOverride ? notional * this._feeOverride : calcFee(exchange, notional, opts);
  }

  async connect() { return true; }
  async disconnect() { return true; }
  async subscribeMarket() { return true; }

  /**
   * 开仓：投入保证金 amt，杠杆 lev，方向 side
   * @returns order + position
   */
  async placeOrder({ symbol, side, qty, type = ORDER_TYPE.MARKET, price, lev = 1, sub, amt, ai = false, sig = '', marginMode, reinvest = false }) {
    const S = this.S;
    const priceRef = (S.prices[symbol] || {}).last;
    // 默认 U 本位(兼容旧调用/AI)；新调用显式传 marginMode('usdt'|'coin')
    const mm = marginMode === 'coin' ? 'coin' : 'usdt';
    if (!priceRef) {
      const o = createOrder({ symbol, side, type, qty, price, lev, extra: { sub: sub && sub.id } });
      applyReject(o, 'no_market_data');
      this._orders.set(o.orderId, o);
      this._emitOrder({ ...o, event: 'rejected' });
      return o;
    }
    const account = typeof sub === 'object' ? sub : S.subs[sub - 1];
    const order = createOrder({
      symbol, side, type, qty: type === ORDER_TYPE.MARKET ? (mm === 'coin' ? amt * lev : (amt * lev) / priceRef) : qty,
      price, lev, extra: { sub: account && account.id, amt, ai, sig, marginMode: mm }
    });

    // 余额校验: U本位查 USDT(bal), 币本位查对应币(coins[sym])
    let insufficient = false;
    if (mm === 'coin') {
      const have = (account && account.coins && account.coins[symbol]) || 0;
      insufficient = !account || have < amt;
    } else {
      insufficient = !account || account.bal < amt;
    }
    if (insufficient) {
      applyReject(order, 'insufficient_balance');
      this._orders.set(order.orderId, order);
      this._emitOrder({ ...order, event: 'rejected' });
      return order;
    }

    // 市价单：参考价 ± 动态滑点(基础+波动加成)；纸面全为 taker 成交(显式, 非默认折扣口径)
    const slipPct = this._slipFor(symbol);
    const fillPrice = side === 'long'
      ? priceRef * (1 + slipPct)
      : priceRef * (1 - slipPct);
    const fillQty = mm === 'coin' ? amt * lev : (amt * lev) / fillPrice;
    const usdNotional = mm === 'coin' ? amt * lev * fillPrice : amt * lev;
    const fee = this._fee(account.ex || 'Binance', usdNotional, { isMaker: false });

    order.qty = fillQty;
    order.price = fillPrice;
    applyFill(order, { price: fillPrice, qty: fillQty, fee });
    order.extra.amt = amt;

    const position = this._openPosition({
      symbol, side, lev, qty: fillQty, entry: fillPrice, fee, account,
      amt, ai, sig, orderId: order.orderId, marginMode: mm, reinvest
    });
    order.extra.positionIndex = S.pos.indexOf(position);

    this._orders.set(order.orderId, order);
    this._emitOrder({ ...order, event: 'filled', position });
    return order;
  }

  async cancelOrder(orderId) {
    const o = this._orders.get(orderId);
    if (!o) return { orderId, status: 'not_found' };
    applyCancel(o);
    this._emitOrder({ ...o, event: 'cancelled' });
    return o;
  }

  async getPositions() { return this.S.pos.map(p => ({ ...p })); }
  async getBalance() { return this.S.subs.map(s => ({ ...s })); }

  /** 资金费率结算（每 8h UTC 整点执行） */
  async settleFunding() {
    const S = this.S;
    if (!S.fusion || !S.fusion.fr) return { settled: 0, payments: [] };
    const result = settleFundingFor({
      positions: S.pos,
      getFundingRate: (sym) => S.fusion.fr[sym] || 0,
      getNotional: (pos) => (window.getMarkPrice ? window.getMarkPrice(pos.sym) : ((S.prices[pos.sym] || {}).last)) * pos.qty,
      onSettle: (pos, payment, rate) => {
        const account = S.subs[pos.sid - 1];
        if (account) { account.bal += payment; S.realized += payment; }
        this._emitOrder({
          orderId: nextOrderId('F'), event: 'funding', symbol: pos.sym,
          side: pos.side, rate, payment, ts: Date.now()
        });
        this._emitFunding({ symbol: pos.sym, side: pos.side, rate, payment, ts: Date.now() });
        this._log('sub', `[sub-${pf(pos.sid)}] 资金费率结算 ${pos.sym} 费率${(rate * 100).toFixed(4)}% ${payment >= 0 ? '收' : '付'}$${Math.abs(payment).toFixed(4)}`);
      }
    });
    this._lastFundingCheck = Date.now();
    return result;
  }

  /** 每 tick 调用：跨过 8h 结算边界时自动结算（防重复） */
  maybeSettleFunding(now = Date.now()) {
    const next = msUntilFunding(now);
    if (next > 7 * 3600 * 1000 && !this._settledBoundary) {
      this._settledBoundary = true;
      return this.settleFunding();
    }
    if (next <= 7 * 3600 * 1000 && this._settledBoundary) {
      this._settledBoundary = false;
    }
    return null;
  }

  /** 检查并执行强平（每 tick 调用） */
  checkLiquidations() {
    const S = this.S;
    const hits = detectLiquidation(
      S.pos,
      // 用标记价(mark)代替最新成交价判定强平: 更接近交易所指数价, 避免最后一笔成交插针误强平
      (sym) => (window.getMarkPrice ? window.getMarkPrice(sym) : ((S.prices[sym] || {}).last)),
      (pos) => pos.exchange || 'Binance'
    );
    hits.forEach(({ pos, liqPrice, markPrice }) => this._liquidate(pos, liqPrice));
    return hits;
  }

  _liquidate(pos, liqPrice) {
    const S = this.S;
    const q = pos.qty;
    const pnlOverride = (liqPrice - pos.entry) * q * (pos.side === 'long' ? 1 : -1);
    const res = this._settle(pos, { q, c: liqPrice, reason: '强平', recordSig: false, isClose: true, pnlOverride });
    this._emitLiq({ symbol: pos.sym, side: pos.side, liqPrice, pnl: res.pnl, ts: Date.now() });
    const idx = S.pos.indexOf(pos);
    if (idx >= 0) S.pos.splice(idx, 1);
  }

  /**
   * 开仓核心记账（共享数学，纸面/真实共用）
   */
  _openPosition({ symbol, side, lev, qty, entry, fee, account, amt, ai, sig, orderId, marginMode = 'usdt', reinvest = false }) {
    const S = this.S;
    if (!account.coins) account.coins = {};
    const mm = marginMode === 'coin' ? 'coin' : 'usdt';
    const pos = {
      orderId, sym: symbol, sid: account.id, side, lev, qty, entry,
      pnl: 0, pnlPct: 0, be: false, tl: 0, hi: entry, lo: entry,
      fee, ai: !!ai, amt, sig: sig || '', openTime: Date.now(), pnlHis: [0],
      exchange: account.ex || 'Binance', marginMode: mm, reinvest: !!reinvest
    };
    S.pos.push(pos);
    if (mm === 'coin') {
      const feeCoin = fee / entry;
      account.coins[symbol] = (account.coins[symbol] || 0) - (amt + feeCoin);
      account.st = 'active';
      account.tr = (account.tr || 0) + 1;
      this._log('trade', `[sub-${pf(account.id)}] 币本位做多 ${symbol} ${lev}x ${amt.toFixed(6)}币 @ $${entry.toFixed(2)} 手续费:$` + fee.toFixed(3));
    } else {
      account.bal -= (amt + fee);
      account.st = 'active';
      account.tr = (account.tr || 0) + 1;
      this._log('trade', `[sub-${pf(account.id)}] ${side === 'long' ? '做多' : '做空'} ${symbol} ${lev}x $${amt} @ $${entry.toFixed(2)} 手续费:$` + fee.toFixed(3));
    }
    return pos;
  }

  /**
   * 部分平仓（保本出 / 阶梯止盈），持仓保留但 qty 减少
   * ratio: 平仓数量占比 (0,1]
   * recordSig: true → 该笔部分平仓也计入 sigScore 学习(AI 仓, 修 tt vs w+l 记账盲区)
   */
  closePartial(pos, { reason, ratio = 1, price, recordSig = false }) {
    const S = this.S;
    const c = price || (S.prices[pos.sym] || {}).last;
    if (!c || pos.qty <= 0.00001) return null;
    const q = pos.qty * ratio;
    return this._settle(pos, { q, c, reason, recordSig, isClose: false });
  }

  /**
   * 全部平仓（手动 / 止损 / 跟踪止损 / 超时）
   */
  exitPosition(pos, { reason = '手动平仓', price }) {
    const S = this.S;
    const c = price || (S.prices[pos.sym] || {}).last;
    if (!c || pos.qty <= 0.00001) return null;
    const q = pos.qty;
    const res = this._settle(pos, { q, c, reason, recordSig: false, isClose: true });
    const idx = S.pos.indexOf(pos);
    if (idx >= 0) S.pos.splice(idx, 1);
    return res;
  }

  /**
   * 统一平仓结算（全平/部分/强平共用）：
   *  - 保证金按 marginMode 返还到 USDT(bal) 或 币(coins[sym])
   *  - 盈利且 pos.reinvest=true 时，50% 利润转换为另一资产（U本位利润→买币；币本位利润→卖币变现 USDT）
   *  - pnlOverride 用于强平（以强平价而非当前浮盈计算）
   */
  _settle(pos, { q, c, reason, recordSig = false, isClose = false, pnlOverride }) {
    const S = this.S;
    if (!S.realized) S.realized = 0;
    const isCoin = pos.marginMode === 'coin';
    const account = S.subs[pos.sid - 1];
    if (account && !account.coins) account.coins = {};
    const curAmt = pos.amt || (pos.entry * pos.qty / pos.lev);
    const mRet = curAmt * (q / pos.qty);
    let pnlMargin;
    if (typeof pnlOverride === 'number') pnlMargin = pnlOverride;
    else pnlMargin = isCoin ? (c - pos.entry) * q * (pos.side === 'long' ? 1 : -1) : (pos.pnl || 0) * (q / pos.qty);
    const exitFee = this._fee(pos.exchange || 'Binance', c * q);
    const feeMargin = isCoin ? exitFee / c : exitFee;
    const net = pnlMargin - feeMargin;
    let toMargin = mRet;     // 返还保证金
    let toOther = 0;         // 转换到另一资产的数量
    if (net > 0 && pos.reinvest) {
      const half = net / 2;
      if (isCoin) {
        account.bal = (account.bal || 0) + half * c;     // 币利润→卖币变现 USDT
        toOther = half * c;
      } else {
        account.coins[pos.sym] = (account.coins[pos.sym] || 0) + half / c; // U本位利润→买币
        toOther = half / c;
      }
      toMargin += half;
    } else {
      toMargin += net;
    }
    if (isCoin) account.coins[pos.sym] = (account.coins[pos.sym] || 0) + toMargin;
    else account.bal = (account.bal || 0) + toMargin;

    pos.qty -= q;
    pos.amt = curAmt - mRet;
    const realizedUsdt = isCoin ? (mRet + net) * c : (mRet + net);
    S.realized += realizedUsdt;

    const pnlUsdt = isCoin ? net * c : net;
    this._recordClosed({ pos, pnl: pnlUsdt, reason, price: c });
    if (recordSig && pos.ai && pos.sig) {
      if (window.recordDirResult) window.recordDirResult(pos.side, net);
      recordSigResultRef(S, pos.sig, net >= 0 ? 'win' : 'lose', net);
    }
    if (pos.ai && S.ai) {
      if (pnlMargin > 0) S.ai.w++; else S.ai.l++;
      if (pos.sig) recordSigResultRef(S, pos.sig, pnlMargin >= 0 ? 'win' : 'lose', pnlMargin);
      if (window.recordDirResult) window.recordDirResult(pos.side, pnlMargin);
      if (window.recordClosedTrade) window.recordClosedTrade(pos, pnlUsdt, reason, c);
    }
    this._log('sub', `[sub-${pf(pos.sid)}] ${reason} 手续费:$${exitFee.toFixed(3)}${pos.reinvest ? ' 再投:' + (toOther >= 0 ? '+' : '') + (isCoin ? (toOther).toFixed(2) + 'U' : (toOther).toFixed(6) + '币') : ''}`);
    if (isClose && account) account.st = 'idle';
    return { qty: q, price: c, fee: exitFee, pnl: pnlUsdt, reinvestOther: toOther };
  }

  _recordClosed({ pos, pnl, reason, price }) {
    const S = this.S;
    S.closed.push({ t: Date.now(), sym: pos.sym, side: pos.side, lev: pos.lev, sub: pos.sid, pnl: Math.round(pnl * 100) / 100, reason, entry: pos.entry, exit: price });
    this._emitOrder({
      orderId: pos.orderId || nextOrderId('C'), event: 'closed', symbol: pos.sym,
      side: pos.side, pnl: Math.round(pnl * 100) / 100, reason, ts: Date.now()
    });
  }

  /** 从"模拟真实交易"设置初始化纸面账户（主系统/PWA 共用） */
  seedSim(sim) {
    const S = this.S;
    if (!S.subs) S.subs = [];
    if (S.subs.some(s => s.sim)) return; // 已初始化则跳过，避免重复
    const coinMap = (sim && sim.coin) || {};
    const coins = {};
    Object.keys(coinMap).forEach(sym => { coins[sym] = coinMap[sym]; });
    S.subs.push({ id: S.subs.length + 1, bal: sim && sim.spotUsdt != null ? sim.spotUsdt : 5000, st: 'idle', pnl: 0, ex: 'Binance', tr: 0, w: 0, type: 'spot', coins: {}, sim: true });
    S.subs.push({ id: S.subs.length + 1, bal: sim && sim.perpUsdt != null ? sim.perpUsdt : 5000, st: 'idle', pnl: 0, ex: 'Binance', tr: 0, w: 0, type: 'perp', coins, sim: true });
  }

  /** 重置纸面账户（清掉 sim 子账户与其持仓，按设置重建） */
  resetSim(sim) {
    const S = this.S;
    if (S.subs) {
      S.subs = S.subs.filter(s => !s.sim);
      if (S.pos) S.pos = S.pos.filter(p => { const a = S.subs[p.sid - 1]; return !(a && a.sim); });
    }
    this.seedSim(sim);
  }

  /** 仅更新现有 sim 子账户的余额/币库存（不清除持仓，供设置变更时即时应用） */
  updateSim(sim) {
    const S = this.S;
    if (!S.subs) return;
    S.subs.forEach(s => {
      if (!s.sim) return;
      if (s.type === 'spot') s.bal = sim && sim.spotUsdt != null ? sim.spotUsdt : 5000;
      else if (s.type === 'perp') {
        s.bal = sim && sim.perpUsdt != null ? sim.perpUsdt : 5000;
        if (!s.coins) s.coins = {};
        const coinMap = (sim && sim.coin) || {};
        Object.keys(coinMap).forEach(sym => { s.coins[sym] = coinMap[sym]; });
      }
    });
  }

  getPerpSub() {
    const S = this.S;
    return ((S.subs || []).find(s => s.type === 'perp')) || (S.subs && S.subs[0]) || null;
  }
  getSpotSub() {
    const S = this.S;
    return (S.subs || []).find(s => s.type === 'spot') || null;
  }
}

function pf(id) { return String(id).padStart(2, '0'); }
function recordSigResultRef(S, sigStr, result, pnl) {
  if (window.recordSigResult) { window.recordSigResult(sigStr, result, pnl); return; }
  if (!sigStr || !S.ai || !S.ai.sigScore) return;
  sigStr.split('+').forEach((name) => {
    name = name.trim(); if (!name) return;
    if (!S.ai.sigScore[name]) S.ai.sigScore[name] = { total: 0, wins: 0, losses: 0, sumPnl: 0 };
    const s = S.ai.sigScore[name];
    s.total++; s.sumPnl += pnl;
    if (result === 'win') s.wins++; else s.losses++;
    s.winRate = s.wins / s.total;
    s.avgPnl = s.sumPnl / s.total;
  });
  if (S.ai.sigLog) {
    S.ai.sigLog.push({ sig: sigStr, result, pnl, t: Date.now() });
    if (S.ai.sigLog.length > 200) S.ai.sigLog.shift();
  }
}
