// ============================================================
// 均线关系仪表盘（MA20 回踩带）—— 纯函数模型 + canvas 绘制
//
// 用途：把「均线关系解读」面板里那些新手看不懂的词（回踩 / 站稳 / 反抽）
// 翻译成一张直观的动画仪表盘：
//   - 横轴 = 现价相对 MA20 的位置（轴范围 = MA20 ± 2×ATR，超出钳到两端）
//   - 绿色（bear 红）矩形 = 「回踩带」= MA20 ± 0.2×ATR（价格进到这里就算“已回踩到”）
//   - 脉冲圆点 = 现价，越靠带内越接近入场机会
//
// 设计约束（与项目其它 tech2 模块一致）：
//   - 纯函数优先，无 DOM 依赖：drawMaRelGauge 只接受 ctx，不查 document。
//   - 只读 buildMaRelation(data) 的返回，不写任何引擎/实盘状态。
//   - 所有数值用 Number.isFinite 防护，非法值不得抛异常。
//
// 术语（写死，避免文案漂移）：站稳 = 收盘价站上 MA20（影线不算）。
// ============================================================

const TONE_COLOR = { bull: '#2ecc71', bear: '#ff6b6b', range: '#f59e0b' };
const HOLD_TXT = '站稳 = 收盘价站上 MA20（影线不算）';
const BAND_MULT = 0.2;   // 回踩带 = MA20 ± 0.2×ATR
const AXIS_MULT = 2;     // 可视轴 = MA20 ± 2×ATR
const ATR_FALLBACK = 0.01; // ATR 无效时的回退：ma20 的 1%（使回踩带恰为 MA20 ± 0.2%）

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const numOr = (v, d) => (finite(v) ? v : d);

// 取数组尾部第一个有限值（均线数组末尾可能为 null）
function lastFinite(a) {
  if (!Array.isArray(a)) return null;
  for (let i = a.length - 1; i >= 0; i--) { if (finite(a[i])) return a[i]; }
  return null;
}

// 市场状态 → 语气（bull / bear / range）
export function toneOf(state) {
  return state === 'BULL' ? 'bull' : state === 'BEAR' ? 'bear' : 'range';
}

// 底部一句话提示（纯字符串，供画布显示；规则见模块头与 AGENTS）
export function gaugeLabel(tone, inBand, bandSide, bandDistPct, squeezed) {
  const d = finite(bandDistPct) ? Math.abs(bandDistPct).toFixed(2) : '--';
  if (tone === 'bull') {
    if (inBand) return '已回踩到 MA20 带内 → 等收盘站上 MA20 即可做多';
    if (bandSide === 'above') return '距回踩带 ' + d + '%（再回踩一点就是入场机会）';
    return '已跌破回踩带 → 需收盘重新站上 MA20 才有效';
  }
  if (tone === 'bear') {
    if (inBand) return '已反抽到 MA20 带内 → 等收盘跌破 MA20 即可做空';
    if (bandSide === 'below') return '距反抽带 ' + d + '%';
    return '已升破反抽带 → 需收盘重新跌破 MA20 才有效';
  }
  return '震荡：均线' + (squeezed ? '密集，等收盘带量跳出' : '未密集，暂不猜方向');
}

// ============================================================
// 纯函数：由 buildMaRelation(data) 的返回构造仪表盘模型
// ============================================================
export function maRelGaugeModel(data) {
  const base = {
    ok: false, tone: 'range', price: null, ma20: null, atr: null, atrPct: null,
    bandLo: null, bandHi: null, devPct: null, above: false, inBand: false, bandDistPct: null,
    bandSide: 'in', pos: null, bandPos: null, zeroPos: 0.5,
    squeezePct: null, squeezeThr: null, squeezed: false,
    label: '数据不足', holdTxt: HOLD_TXT,
  };
  if (!data || typeof data !== 'object') return base;

  const ma20 = lastFinite(data.ma && data.ma.fast);
  const price = finite(data.info && data.info.px) ? data.info.px
    : finite(data.market && data.market.close) ? data.market.close
      : null;
  if (!finite(price) || !finite(ma20) || ma20 === 0) return base;

  const tone = toneOf(data.market && data.market.state);
  const atrPct = finite(data.info && data.info.atrPct) ? data.info.atrPct : null;
  // ATR 绝对值：优先 info.atr，否则由 atrPct×ma20 反推（ma20 为轴心，保证轴/带不随现价漂移）；
  // 再无效则用 ma20 的 1%（使回踩带恰为 MA20 ± 0.2%）。
  const atrRaw = finite(data.info && data.info.atr) ? data.info.atr
    : (atrPct != null ? Math.abs(atrPct) / 100 * ma20 : null);
  const atrEff = (finite(atrRaw) && atrRaw > 0) ? atrRaw : Math.abs(ma20) * ATR_FALLBACK;

  const bandLo = ma20 - BAND_MULT * atrEff;
  const bandHi = ma20 + BAND_MULT * atrEff;
  const axisLo = ma20 - AXIS_MULT * atrEff;
  const axisHi = ma20 + AXIS_MULT * atrEff;
  const span = axisHi - axisLo;
  const mapAxis = (v) => (span > 0 ? clamp01((v - axisLo) / span) : 0.5);

  const devPct = (price - ma20) / ma20 * 100;
  const above = price >= ma20;
  const bandEps = Math.abs(ma20) * 1e-9;   // 浮点容差：恰好落在带边缘也算带内
  const inBand = price >= bandLo - bandEps && price <= bandHi + bandEps;

  let bandSide, bandDistPct;
  if (inBand) { bandSide = 'in'; bandDistPct = 0; }
  else if (price > bandHi) { bandSide = 'above'; bandDistPct = (price - bandHi) / ma20 * 100; }
  else { bandSide = 'below'; bandDistPct = (price - bandLo) / ma20 * 100; }

  const squeezePct = finite(data.squeeze && data.squeeze.spreadPct) ? data.squeeze.spreadPct : null;
  const squeezeThr = finite(data.opts && data.opts.squeezePct) ? data.opts.squeezePct : 1.2;
  const squeezed = !!(data.squeeze && data.squeeze.squeezed);

  return {
    ok: true, tone, price, ma20,
    atr: finite(atrRaw) ? atrRaw : null,
    atrPct,
    bandLo, bandHi, devPct, above, inBand, bandDistPct, bandSide,
    pos: mapAxis(price),
    bandPos: [mapAxis(bandLo), mapAxis(bandHi)],
    zeroPos: 0.5,
    squeezePct, squeezeThr, squeezed,
    label: gaugeLabel(tone, inBand, bandSide, bandDistPct, squeezed),
    holdTxt: HOLD_TXT,
  };
}

// ============================================================
// 纯函数：布局（便于单测；主代理用固定逻辑分辨率 W=298,H=118 调用）
// ============================================================
export function maRelGaugeLayout(w, h, opts = {}) {
  const o = opts || {};
  const W = finite(w) && w > 0 ? w : 298;
  const H = finite(h) && h > 0 ? h : 118;
  const x0 = 10;
  const x1 = Math.max(x0 + 1, W - 10);
  const axisY = H * 0.52;             // 轴线（约 52% 高）
  const bandH = 10;                   // 回踩带条高
  const bandY = axisY + 8;            // 回踩带条（轴下方）
  const labelY = H - 6;               // 底部文字基线
  const tickStepPct = finite(o.tickStepPct) ? o.tickStepPct : 0.5;
  return { axisY, x0, x1, bandY, bandH, labelY, tickStepPct };
}

// ============================================================
// canvas 绘制。opts: { pos: 已缓动的 0..1 位置（可空，用 m.pos）, phase: 毫秒（驱动脉冲） }
// ============================================================
export function drawMaRelGauge(ctx, m, w, h, opts = {}) {
  if (!ctx) return;
  const o = opts || {};
  const W = finite(w) && w > 0 ? w : 298;
  const H = finite(h) && h > 0 ? h : 118;
  const lay = maRelGaugeLayout(W, H);
  const model = m || {};

  try { ctx.clearRect(0, 0, W, H); } catch (e) { /* stub ctx 防御 */ }

  // 数据不足：只画一行灰字
  if (!model.ok) {
    ctx.fillStyle = 'rgba(160,175,190,.8)';
    ctx.font = '10px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('数据不足', W / 2, H / 2);
    ctx.textAlign = 'left';
    return;
  }

  const tone = TONE_COLOR[model.tone] || TONE_COLOR.range;
  const posInput = finite(o.pos) ? o.pos : model.pos;
  const X = (p) => lay.x0 + (lay.x1 - lay.x0) * clamp01(numOr(p, 0.5));
  const zx = X(model.zeroPos);

  // 1. 轴线 + 两端小刻度
  ctx.strokeStyle = '#2a3442';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(lay.x0, lay.axisY);
  ctx.lineTo(lay.x1, lay.axisY);
  ctx.moveTo(lay.x0, lay.axisY - 4);
  ctx.lineTo(lay.x0, lay.axisY + 4);
  ctx.moveTo(lay.x1, lay.axisY - 4);
  ctx.lineTo(lay.x1, lay.axisY + 4);
  ctx.stroke();

  // 中心 MA20 竖线
  ctx.strokeStyle = 'rgba(160,175,190,.55)';
  ctx.beginPath();
  ctx.moveTo(zx, lay.axisY - 14);
  ctx.lineTo(zx, lay.axisY + 6);
  ctx.stroke();

  // 2. 回踩带矩形（tone=bear 用红）
  if (Array.isArray(model.bandPos)) {
    const bx0 = X(model.bandPos[0]), bx1 = X(model.bandPos[1]);
    const left = Math.min(bx0, bx1), bw = Math.abs(bx1 - bx0);
    ctx.fillStyle = model.tone === 'bear' ? 'rgba(255,107,107,.22)' : 'rgba(46,204,113,.22)';
    ctx.fillRect(left, lay.bandY, bw, lay.bandH);
    ctx.strokeStyle = model.tone === 'bear' ? 'rgba(255,107,107,.7)' : 'rgba(46,204,113,.7)';
    ctx.strokeRect(left, lay.bandY, bw, lay.bandH);
  }

  // 3. 价格指针（脉冲：半径 + 外圈光晕呼吸）
  const px = X(posInput);
  const phase = finite(o.phase) ? o.phase : 0;
  const wave = Math.sin(phase / 380);
  const r = 5 + 1.2 * wave;
  const glow = 0.28 + 0.22 * (1 + wave) / 2;
  ctx.save();
  ctx.globalAlpha = glow;
  ctx.fillStyle = tone;
  ctx.beginPath();
  ctx.arc(px, lay.axisY, r + 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = tone;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(px, lay.axisY - 16);
  ctx.lineTo(px, lay.axisY + 4);
  ctx.stroke();
  ctx.fillStyle = tone;
  ctx.beginPath();
  ctx.arc(px, lay.axisY, r, 0, Math.PI * 2);
  ctx.fill();

  // 4. 轴刻度文字
  ctx.fillStyle = 'rgba(160,175,190,.8)';
  ctx.font = '9px system-ui';
  ctx.textAlign = 'left';
  ctx.fillText('-2×ATR', lay.x0, lay.axisY - 8);
  ctx.textAlign = 'right';
  ctx.fillText('+2×ATR', lay.x1, lay.axisY - 8);
  ctx.textAlign = 'center';
  ctx.fillText('MA20', zx, lay.axisY - 8);

  // 5. 密集度小条（右上角，宽 60、高 5）
  const bw2 = 60, bh2 = 5, bx2 = lay.x1 - bw2, by2 = 6;
  const ratio = (finite(model.squeezePct) && finite(model.squeezeThr) && model.squeezeThr > 0)
    ? clamp01(model.squeezePct / model.squeezeThr) : 0;
  ctx.fillStyle = 'rgba(255,255,255,.08)';
  ctx.fillRect(bx2, by2, bw2, bh2);
  ctx.fillStyle = model.squeezed ? '#ffd740' : '#4a5568';
  ctx.fillRect(bx2, by2, bw2 * ratio, bh2);
  ctx.fillStyle = model.squeezed ? '#ffd740' : 'rgba(160,175,190,.85)';
  ctx.font = '9px system-ui';
  ctx.textAlign = 'right';
  ctx.fillText('密集 ' + (finite(model.squeezePct) ? model.squeezePct.toFixed(2) : '--') + '%', bx2 - 6, by2 + 5);

  // 6. 底部一句话提示
  ctx.fillStyle = tone;
  ctx.font = '9px system-ui';
  ctx.textAlign = 'left';
  ctx.fillText(String(model.label == null ? '' : model.label), lay.x0, lay.labelY);
  ctx.textAlign = 'left';
}
