import { ORDER_STATUS } from './ExchangeAdapter.js';

let _orderSeq = 0;

export function nextOrderId(prefix = 'P') {
  return `${prefix}-${Date.now().toString(36)}-${(++_orderSeq).toString(36)}`;
}

/**
 * 订单状态机
 * 状态转换图：
 *   submitted → partially_filled → filled
 *   submitted → cancelled
 *   submitted → partially_filled → cancelled
 *   submitted → rejected
 *   partially_filled → rejected (不可能，只有全拒绝)
 */
export function createOrder(opts) {
  return {
    orderId: opts.orderId || nextOrderId(opts.prefix || 'P'),
    status: ORDER_STATUS.SUBMITTED,
    symbol: opts.symbol,
    side: opts.side,
    type: opts.type,
    qty: opts.qty,
    price: opts.price || null,
    lev: opts.lev || 1,
    filledQty: 0,
    avgPrice: 0,
    fee: 0,
    cumFee: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    fills: [],              // 逐笔成交明细 [{price, qty, fee, ts}]
    rejectReason: null,
    extra: opts.extra || {}
  };
}

export function canCancel(order) {
  return order.status === ORDER_STATUS.SUBMITTED
    || order.status === ORDER_STATUS.PARTIALLY_FILLED;
}

export function canFill(order) {
  return order.status === ORDER_STATUS.SUBMITTED
    || order.status === ORDER_STATUS.PARTIALLY_FILLED;
}

export function applyFill(order, fill) {
  if (!canFill(order)) return false;
  order.filledQty += fill.qty;
  order.cumFee += fill.fee;
  order.avgPrice = ((order.avgPrice * (order.filledQty - fill.qty)) + (fill.price * fill.qty)) / order.filledQty;
  order.updatedAt = Date.now();
  order.fills.push({ ...fill, ts: Date.now() });
  order.status = order.filledQty >= order.qty - 1e-12
    ? ORDER_STATUS.FILLED
    : ORDER_STATUS.PARTIALLY_FILLED;
  return true;
}

export function applyCancel(order) {
  if (!canCancel(order)) return false;
  order.status = ORDER_STATUS.CANCELLED;
  order.updatedAt = Date.now();
  return true;
}

export function applyReject(order, reason) {
  if (order.status !== ORDER_STATUS.SUBMITTED) return false;
  order.status = ORDER_STATUS.REJECTED;
  order.rejectReason = reason;
  order.updatedAt = Date.now();
  return true;
}