/**
 * ExchangeAdapter — 统一交易所执行接口
 *
 * 纸面引擎（PaperEngine）与未来真实交易所适配器（BinanceAdapter/OkxAdapter）
 * 必须实现同一接口，从而保证业务引擎（PortfolioEngine/RiskEngine）零改动。
 *
 * 接口约定：
 *  - 所有金额单位：USD（合约名义价值按 USD 计）
 *  - 所有数量单位：标的资产数量（如 BTC）
 *  - 事件回调（onFill/onFunding/onLiquidation）为异步批量推送
 *  - 返回值均为 Promise
 */

export const ORDER_SIDE = { LONG: 'long', SHORT: 'short' };
export const ORDER_TYPE = { MARKET: 'MARKET', LIMIT: 'LIMIT' };
export const ORDER_STATUS = {
  SUBMITTED: 'submitted',      // 已提交，等待撮合
  PARTIALLY_FILLED: 'partial', // 部分成交
  FILLED: 'filled',            // 全部成交
  CANCELLED: 'cancelled',      // 已取消
  REJECTED: 'rejected'         // 被拒绝（风控/余额不足）
};

export class ExchangeAdapter {
  constructor(config = {}) {
    this.name = 'abstract';
    this.config = config;
    this._orderListeners = [];
    this._fundingListeners = [];
    this._liqListeners = [];
  }

  async connect() { throw new Error('not implemented'); }
  async disconnect() { throw new Error('not implemented'); }
  async subscribeMarket(symbols) { throw new Error('not implemented'); }

  /**
   * 下单
   * @param {object} order
   * @param {string} order.symbol  如 'BTCUSDT'
   * @param {string} order.side    ORDER_SIDE.LONG | ORDER_SIDE.SHORT
   * @param {string} order.type    ORDER_TYPE.MARKET | ORDER_TYPE.LIMIT
   * @param {number} order.qty     标的数量
   * @param {number} [order.price] LIMIT 单必填
   * @param {number} [order.lev]   杠杆
   * @returns {Promise<{orderId:string, status:string, avgPrice:number, filledQty:number, fee:number}>}
   */
  async placeOrder(order) { throw new Error('not implemented'); }

  /**
   * 撤单
   * @param {string} orderId
   */
  async cancelOrder(orderId) { throw new Error('not implemented'); }

  /** 当前持仓快照（symbol -> {qty, side, entryPrice, pnl, liquidationPrice}） */
  async getPositions() { throw new Error('not implemented'); }

  /** 账户余额快照 */
  async getBalance() { throw new Error('not implemented'); }

  /** 资金费率结算（每 8 小时触发） */
  async settleFunding() { throw new Error('not implemented'); }

  // ---- 事件订阅 ----
  onOrder(cb) { this._orderListeners.push(cb); return () => { this._orderListeners = this._orderListeners.filter(f => f !== cb); }; }
  onFunding(cb) { this._fundingListeners.push(cb); return () => { this._fundingListeners = this._fundingListeners.filter(f => f !== cb); }; }
  onLiquidation(cb) { this._liqListeners.push(cb); return () => { this._liqListeners = this._liqListeners.filter(f => f !== cb); }; }

  _emitOrder(ev) { this._orderListeners.forEach(f => f(ev)); }
  _emitFunding(ev) { this._fundingListeners.forEach(f => f(ev)); }
  _emitLiq(ev) { this._liqListeners.forEach(f => f(ev)); }
}
