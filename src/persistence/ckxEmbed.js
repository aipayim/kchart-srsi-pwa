/**
 * CKX iframe embed 客户端（CKX 接入方式 **B**，postMessage 协议 v1）
 *
 * 用途：在页面内以**浮层 iframe** 调起官方 CryptoKey.im 的加密/解密界面 —— 密码在官方 UI 内输入，
 * 宿主页面**永远看不到口令**；宿主只拿到密文/载体，或用户在 embed 内显式点「送返回」后的明文。
 *
 * 与 SDK 路径（`ckxVault.js` 的动态 import）互补：
 *  - SDK：免白名单、可完全离线、可设 schemaId（开放层能力）；
 *  - embed：需域名白名单（`frame-ancestors`）、需联网、**免费层不支持 schema/schemaVersion 能力**
 *    → 产物 meta 无 `schemaId`，只能靠加密信封内的 `vault.schema` 校验。
 * 两种路径产出的 `mode:'file'` 载体都是同一个 `SAFE v3` `.ckx` 容器 → **可互相解密**。
 *
 * 安全（规范 §S2/S4）：
 *  - 只接受 `event.origin === 'https://cryptokey.im'`（本地 mock 例外：同源）且 `event.source === iframe.contentWindow`；
 *  - `ckx:init` 必须回显 `ckx:ready` 的 nonce，之后每条消息都带同一 nonce；
 *  - 不写日志、不落盘明文/口令；明文仅在用户于 embed 内点击后回传。
 *
 * 协议（v1）：
 *  宿主→embed：`ckx:init{v,nonce,app,mode,schema?,schemaVersion?,label?,locale?,theme?}`、`ckx:encrypt{v,nonce,payload,meta?}`、
 *              `ckx:decrypt{v,nonce,carrier,carrierName?}`、`ckx:cancel{v,nonce}`
 *  embed→宿主：`ckx:ready{v,formatVersion,nonce,capabilities,pro}`、`ckx:capabilities{…,granted,expiresAt,source}`、
 *              `ckx:result{v,nonce,kind,text?|file?{name,mime,bytes},meta}`、`ckx:plaintext{v,nonce,text?|bytes?,meta}`、
 *              `ckx:error{v,nonce,code,message}`
 */

export const CKX_EMBED_ORIGIN = 'https://cryptokey.im';
export const CKX_EMBED_URL = 'https://cryptokey.im/ckx/embed/';
/** 本地 mock embed（自包含演示页的 embed 角色；同源，无需白名单） */
export const CKX_MOCK_EMBED_URL = './ckx-demo.html?embed=mock';
export const CKX_PROTOCOL_V = 1;
export const CKX_EMBED_TIMEOUT_MS = 120000;
export const CKX_EMBED_FREE_FEATURES = ['text', 'image', 'file', 'video'];
export const CKX_EMBED_SIGNED_FEATURES = ['shard', 'strictMatching', 'bulk', 'whiteLabel', 'schema', 'sla'];

export class CkxEmbedError extends Error {
  constructor(code, message, detail) {
    super(message || code);
    this.name = 'CkxEmbedError';
    this.code = code;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------- 纯函数
export function makeNonce(bytes = 16) {
  const a = new Uint8Array(bytes);
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) globalThis.crypto.getRandomValues(a);
  else for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 构造 `ckx:init` 消息。0.4.0：`schema` 已成为**免费信息性标签**（不再 fail-closed），`timeout` 可配会话空闲超时。 */
export function buildInitMessage(nonce, o = {}) {
  const m = { v: CKX_PROTOCOL_V, type: 'ckx:init', nonce, app: o.app, mode: o.mode || 'file' };
  if (o.schema) { m.schema = o.schema; m.schemaVersion = String(o.schemaVersion ?? 1); }
  if (o.label) m.label = o.label;
  if (o.locale) m.locale = o.locale;
  if (o.theme) m.theme = o.theme;
  if (o.timeout != null && Number.isFinite(Number(o.timeout))) m.timeout = Math.max(0, Math.floor(Number(o.timeout)));
  return m;
}
export function buildEncryptMessage(nonce, payload, meta, carrier) {
  const m = { v: CKX_PROTOCOL_V, type: 'ckx:encrypt', nonce, payload };
  if (meta) m.meta = meta;
  // 0.4.0：mode=image 时宿主可传载体基底（官方修复「静默忽略 carrier」，见 BL-1/AIPAY-1）
  if (carrier) m.carrier = carrier;
  return m;
}
export function buildDecryptMessage(nonce, carrier, carrierName) {
  const m = { v: CKX_PROTOCOL_V, type: 'ckx:decrypt', nonce, carrier };
  if (carrierName) m.carrierName = carrierName;
  return m;
}
export function buildCancelMessage(nonce) {
  return { v: CKX_PROTOCOL_V, type: 'ckx:cancel', nonce };
}
/** 0.4.0 新增：容量预检（不加密）。embed 回 `ckx:estimate.result`。 */
export function buildEstimateMessage(nonce, payload, meta, carrier) {
  const m = { v: CKX_PROTOCOL_V, type: 'ckx:estimate', nonce, payload };
  if (meta) m.meta = meta;
  if (carrier) m.carrier = carrier;
  return m;
}

/**
 * 校验 embed → 宿主 的消息（规范 S4：origin 白名单 + source 必须是 iframe）。
 * @returns {{ok:boolean, reason?:string, type?:string, msg?:object}}
 */
export function checkEmbedMessage(ev, ctx = {}) {
  const origin = ev && ev.origin;
  if (!Array.isArray(ctx.allowOrigins) || !ctx.allowOrigins.includes(origin)) return { ok: false, reason: 'origin' };
  if (ctx.sourceOk === false) return { ok: false, reason: 'source' };
  const data = ev && ev.data;
  if (!data || typeof data !== 'object') return { ok: false, reason: 'data' };
  if (data.v !== CKX_PROTOCOL_V) return { ok: false, reason: 'version' };
  if (typeof data.type !== 'string' || data.type.indexOf('ckx:') !== 0) return { ok: false, reason: 'type' };
  if (ctx.requireNonce && (!ctx.nonce || data.nonce !== ctx.nonce)) return { ok: false, reason: 'nonce' };
  return { ok: true, type: data.type, msg: data };
}

/** 把任意载荷转成 `ArrayBuffer`（string / TypedArray / ArrayBuffer / Blob）。 */
export async function toArrayBufferAsync(payload) {
  if (payload == null) return new ArrayBuffer(0);
  if (typeof payload === 'string') return new TextEncoder().encode(payload).buffer;
  if (payload instanceof ArrayBuffer) return payload;
  if (ArrayBuffer.isView(payload)) return payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
  if (typeof Blob !== 'undefined' && payload instanceof Blob) return await payload.arrayBuffer();
  throw new CkxEmbedError('CKX_EMBED_BAD_PAYLOAD', '不支持的载荷类型');
}

/** 免密钥查询某 origin 的 embed 白名单状态（公开接口）。
 *  ⚠️ 0.4.0 起 policy **只回该 origin 的 `{allowed, sla}`**（不再回全量名单）。
 *  全量名单用 `fetchIntegrators()`。
 */
export async function fetchEmbedPolicy(origin, opts = {}) {
  const f = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  if (!f) throw new CkxEmbedError('CKX_EMBED_NO_FETCH', '当前环境没有 fetch');
  const base = opts.endpoint || CKX_EMBED_ORIGIN;
  const url = new URL('/v1/ckx/embed/policy', base);
  if (origin) url.searchParams.set('origin', origin);
  const res = await f(url.toString(), { headers: { accept: 'application/json' } });
  if (!res.ok) throw new CkxEmbedError('CKX_EMBED_POLICY_HTTP', `policy HTTP ${res.status}`);
  const body = await res.json();
  // 兼容 0.3.x（含 origins）与 0.4.0（最小化）：只暴露必要字段 + sla
  return {
    allowed: !!body.allowed,
    sla: body.sla === undefined ? null : body.sla,
    origin: body.origin === undefined ? (origin || null) : body.origin,
    freeFeatures: body.freeFeatures || CKX_EMBED_FREE_FEATURES,
    proFeatures: body.proFeatures || CKX_EMBED_SIGNED_FEATURES,
    slaLevels: body.slaLevels || null,
    raw: body,
  };
}

/** 全量合作方名单（0.4.0 新增 `/v1/ckx/integrators`，即 `/registry` 公示页数据源）。 */
export async function fetchIntegrators(opts = {}) {
  const f = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  if (!f) throw new CkxEmbedError('CKX_EMBED_NO_FETCH', '当前环境没有 fetch');
  const base = opts.endpoint || CKX_EMBED_ORIGIN;
  const res = await f(new URL('/v1/ckx/integrators', base).toString(), { headers: { accept: 'application/json' } });
  if (!res.ok) throw new CkxEmbedError('CKX_EMBED_INTEGRATORS_HTTP', `integrators HTTP ${res.status}`);
  const body = await res.json();
  return { origins: Array.isArray(body.origins) ? body.origins : [], slaByOrigin: body.slaByOrigin || {}, raw: body };
}

// ---------------------------------------------------------------- 客户端
/**
 * 创建 embed 客户端（懒创建 iframe）。
 * @param {object} opts
 *  - win/doc：注入环境（测试用）；默认全局
 *  - mock：true → 使用同源 mock embed（本地开发 / 无白名单时）
 *  - url：自定义 embed 地址
 *  - app：宿主 origin（默认 `location.origin`）
 *  - medium：默认介质 `'file'|'text'`
 *  - theme/locale/label：传给 `ckx:init`
 *  - timeoutMs：交互超时（默认 120s）
 *  - interactive：true（默认）时若 `ckx:ready` 超时，错误 detail 带白名单提示
 */
export function createCkxEmbedClient(opts = {}) {
  const win = opts.win || (typeof window !== 'undefined' ? window : null);
  const doc = opts.doc || (typeof document !== 'undefined' ? document : null);
  if (!win) throw new CkxEmbedError('CKX_EMBED_NO_WINDOW', '需要浏览器 window 环境');
  const hostOrigin = (win.location && win.location.origin) || opts.app || '';
  const useMock = !!opts.mock;
  const embedSrc = opts.url || (useMock ? (opts.mockUrl || CKX_MOCK_EMBED_URL) : CKX_EMBED_URL);
  const allowOrigins = [CKX_EMBED_ORIGIN];
  if (hostOrigin) allowOrigins.push(hostOrigin); // 仅用于同源 mock；跨源 CKX iframe 仍由 origin 校验兜底
  const timeoutMs = opts.timeoutMs || CKX_EMBED_TIMEOUT_MS;
  const appOrigin = opts.app || hostOrigin;

  let state = 'idle';           // idle | waiting | ready | closed
  let nonce = null;
  let caps = null;
  let initMedium = null;        // 上一次 `ckx:init` 实际使用的 medium（embed 的 mode 只在 init 生效）
  let capWaiters = [];
  let pending = null;
  let readyPromise = null;
  let readyResolve = null;
  let readyReject = null;
  let readyTimer = null;
  let bound = false;
  let root = null;
  let boxEl = null;
  let iframeEl = null;
  const log = [];

  function note(evt, extra) { log.push(Object.assign({ t: Date.now(), evt }, extra || {})); if (log.length > 100) log.shift(); }

  function post(msg) {
    if (!iframeEl || !iframeEl.contentWindow) throw new CkxEmbedError('CKX_EMBED_NO_IFRAME', 'iframe 未就绪');
    iframeEl.contentWindow.postMessage(msg, '*'); // 目标 origin 由 embed 侧按白名单校验（mock 需要 '*'）
  }

  function onMessage(ev) {
    if (state === 'closed') return;
    const data = ev && ev.data;
    const isReady = !!(data && typeof data === 'object' && data.type === 'ckx:ready');
    const sourceOk = iframeEl ? ev.source === iframeEl.contentWindow : false;
    const r = checkEmbedMessage(ev, {
      allowOrigins,
      sourceOk,
      nonce,
      requireNonce: !isReady && state === 'ready',
    });
    if (!r.ok) { note('ignored', { reason: r.reason }); return; }
    const m = r.msg;
    if (m.type === 'ckx:ready') return onReady(m);
    if (m.type === 'ckx:capabilities') {
      caps = {
        capabilities: m.capabilities || [], pro: !!m.pro, granted: m.granted || [],
        source: m.source || 'none', expiresAt: m.expiresAt ?? null,
        ignored: Array.isArray(m.ignored) ? m.ignored : [],      // 0.4.0：如 ['schema']（信息性标签被忽略的部分）
        schemas: Array.isArray(m.schemas) ? m.schemas : [],
        mediums: m.mediums || null,
        sdkVersion: m.sdkVersion || null,
        idleTimeoutSec: typeof m.idleTimeoutSec === 'number' ? m.idleTimeoutSec : null,
      };
      note('capabilities', { pro: caps.pro, ignored: caps.ignored.join(',') || '-' });
      const w = capWaiters; capWaiters = [];
      for (const fn of w) { try { fn(); } catch (_) {} }
      return;
    }
    if (m.type === 'ckx:resize') {           // 0.4.0：自适应 iframe 高度（可选用）
      note('resize', { height: m.height });
      applyResize(m.height);
      if (typeof opts.onResize === 'function') { try { opts.onResize(m); } catch (_) {} }
      return;
    }
    if (m.type === 'ckx:idle-warning') {     // 0.4.0：超时前预警（不是错误）
      note('idle-warning', { remainingMs: m.remainingMs });
      if (typeof opts.onIdleWarning === 'function') { try { opts.onIdleWarning(m); } catch (_) {} }
      return;
    }
    if (m.type === 'ckx:error') return settle(null, new CkxEmbedError(m.code || 'CKX_EMBED_ERROR', m.message || 'embed 返回错误', { messageKey: m.messageKey, detail: m.detail, retryable: m.retryable }));
    if (m.type === 'ckx:result' || m.type === 'ckx:plaintext' || m.type === 'ckx:estimate.result') return settle(m, null);
    note('unhandled', { type: m.type });
  }

  function sendInit(mode) {
    initMedium = mode || opts.medium || 'file';
    try {
      post(buildInitMessage(nonce, {
        app: appOrigin,
        mode: initMedium,
        schema: opts.schema,                 // 0.4.0：免费层可携带 schemaId 作信息性标签
        schemaVersion: opts.schemaVersion,
        label: opts.label,
        theme: opts.theme,
        locale: opts.locale,
        timeout: opts.timeout,               // 0.4.0：会话空闲超时可配（秒；0=禁用）
      }));
    } catch (e) { /* iframe 已移除 */ }
  }

  function onReady(m) {
    if (state === 'closed') return;
    const first = state !== 'ready';
    nonce = m.nonce;
    caps = caps && caps.pro != null ? Object.assign({}, caps, { capabilities: m.capabilities || caps.capabilities, pro: !!m.pro }) : { capabilities: m.capabilities || [], pro: !!m.pro, granted: [], source: 'none', expiresAt: null };
    state = 'ready';
    note('ready', { nonce: String(nonce).slice(0, 8), pro: caps.pro });
    sendInit(opts.medium || 'file');
    if (first) {
      if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
      if (readyResolve) readyResolve({ capabilities: caps.capabilities.slice(), pro: caps.pro });
    }
  }

  /**
   * 切换 embed 的 `mode`：**mode 只在 `ckx:init` 生效**，所以必须重新 init。
   * 不调用它的后果：`encrypt(payload,{medium:'image',carrier})` 会被 embed 按**旧 mode** 处理（静默产出错介质，实测确认）。
   * 重新 init 后等 `ckx:capabilities` 确认（最多 `awaitAckMs`，不等也不报错，但会记 `medium-reinit-unacked`）。
   */
  async function setMedium(mode, o = {}) {
    if (!mode) return;
    if (mode === initMedium) { opts.medium = mode; return; }
    opts.medium = mode;
    if (state !== 'ready') return;              // 下次 init 会带上新 mode
    sendInit(mode);
    const ms = o.awaitAckMs == null ? 2000 : o.awaitAckMs;
    const acked = await new Promise((res) => {
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; res(false); } }, ms);
      capWaiters.push(() => { if (!done) { done = true; clearTimeout(t); res(true); } });
    });
    note(acked ? 'medium-reinit' : 'medium-reinit-unacked', { mode });
  }

  function settle(msg, err) {
    if (!pending) { note(err ? 'stray-error' : 'stray-result'); return; }
    const p = pending; pending = null;
    if (p.timer) clearTimeout(p.timer);
    if (err) p.reject(err);
    else p.resolve(msg);
  }

  function bind() {
    if (bound) return;
    win.addEventListener('message', onMessage);
    bound = true;
  }

  /** `ckx:resize`：默认让浮层高度跟随 embed 报告（`opts.autoHeight !== false`）。 */
  function applyResize(height) {
    if (opts.autoHeight === false) return;
    const h = Number(height);
    if (!Number.isFinite(h) || h <= 0 || !boxEl || !boxEl.style) return;
    const maxH = (typeof win.innerHeight === 'number' && win.innerHeight > 0) ? win.innerHeight - 32 : h;
    boxEl.style.height = Math.max(220, Math.min(h, maxH)) + 'px';
  }

  function ensureOverlay() {
    if (iframeEl || !doc || !doc.body) return;
    root = doc.createElement('div');
    root.setAttribute('data-ckx-embed', '1');
    root.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(3,6,12,.82);display:flex;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(2px)';
    const box = doc.createElement('div');
    boxEl = box;
    box.style.cssText = 'position:relative;width:min(460px,100%);height:min(720px,100%);background:#0b1018;border:1px solid #22303f;border-radius:12px;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 18px 60px rgba(0,0,0,.55)';
    const bar = doc.createElement('div');
    bar.style.cssText = 'flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:8px 10px;font:12px/1.4 system-ui,sans-serif;color:#9fb3c8;background:#0e141d;border-bottom:1px solid #1d2836';
    const title = doc.createElement('span');
    title.textContent = useMock ? 'CKX 本地 mock（非官方界面）' : 'CKX · CryptoKey.im（官方界面）';
    title.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    const closeBtn = doc.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = '✕';
    closeBtn.setAttribute('aria-label', '关闭');
    closeBtn.style.cssText = 'flex:0 0 auto;background:transparent;border:1px solid #2b3a4d;color:#c8d6e5;border-radius:6px;cursor:pointer;padding:2px 8px;font-size:12px';
    closeBtn.addEventListener('click', () => close());
    bar.appendChild(title); bar.appendChild(closeBtn);
    iframeEl = doc.createElement('iframe');
    iframeEl.src = embedSrc;
    iframeEl.setAttribute('title', 'CKX 加密 / 解密');
    iframeEl.style.cssText = 'flex:1 1 auto;width:100%;border:0;background:#fff';
    box.appendChild(bar); box.appendChild(iframeEl);
    root.appendChild(box);
    doc.body.appendChild(root);
    note('overlay-open', { src: embedSrc });
  }

  function ready() {
    if (state === 'ready') return Promise.resolve({ capabilities: (caps && caps.capabilities) || [], pro: !!(caps && caps.pro) });
    if (state === 'closed') return Promise.reject(new CkxEmbedError('CKX_EMBED_CLOSED', '客户端已关闭'));
    bind();
    ensureOverlay();
    if (!readyPromise) {
      readyPromise = new Promise((resolve, reject) => {
        readyResolve = resolve; readyReject = reject;
        readyTimer = setTimeout(() => {
          const hint = useMock
            ? '（本地 mock 页未响应）'
            : '（iframe 被 frame-ancestors 拒绝或网络不可达：需先注册域名白名单，见 scripts/register-ckx-embed.mjs）';
          readyReject(new CkxEmbedError('CKX_TIMEOUT', `等待 ckx:ready 超时 ${hint}`));
        }, timeoutMs);
      });
      state = 'waiting';
    }
    return readyPromise;
  }

  function request(msg, label) {
    if (state !== 'ready') return Promise.reject(new CkxEmbedError('CKX_EMBED_NOT_READY', '尚未完成握手'));
    if (pending) return Promise.reject(new CkxEmbedError('CKX_EMBED_BUSY', '已有进行中的请求'));
    if (!msg.nonce) msg.nonce = nonce;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending && pending.timer === timer) pending = null;
        reject(new CkxEmbedError('CKX_TIMEOUT', `${label} 超时（用户未在 embed 内完成操作？）`));
      }, timeoutMs);
      pending = { resolve, reject, timer };
      post(msg);
    });
  }

  async function encrypt(payload, o = {}) {
    await ready();
    const medium = o.medium || opts.medium || 'file';
    if (medium !== initMedium) await setMedium(medium);   // ⚠️ 否则 embed 会按旧 mode 处理（静默错介质）
    const value = medium === 'text' && typeof payload === 'string' ? payload : await toArrayBufferAsync(payload);
    const carrier = o.carrier ? await toArrayBufferAsync(o.carrier) : null;   // mode=image 时的载体基底
    const res = await request(buildEncryptMessage(nonce, value, o.meta, carrier), '加密');
    if (res.kind === 'ciphertext') return { medium: 'text', text: res.text, meta: res.meta || {}, capabilities: (caps && caps.capabilities) || [] };
    if (res.kind === 'carrier') {
      const f = res.file || {};
      return { medium, bytes: new Uint8Array(f.bytes), name: f.name || 'vault.ckx', mime: f.mime || 'application/octet-stream', meta: res.meta || {}, capabilities: (caps && caps.capabilities) || [] };
    }
    throw new CkxEmbedError('CKX_EMBED_BAD_RESULT', `未知结果类型 ${String(res.kind)}`);
  }

  async function decrypt(carrier, o = {}) {
    await ready();
    const value = typeof carrier === 'string' ? carrier : await toArrayBufferAsync(carrier);
    const res = await request(buildDecryptMessage(nonce, value, o.carrierName), '解密');
    const bytes = res.bytes ? new Uint8Array(res.bytes) : (typeof res.text === 'string' ? new TextEncoder().encode(res.text) : null);
    return { text: typeof res.text === 'string' ? res.text : null, bytes, meta: res.meta || {} };
  }

  /**
   * 容量预检（0.4.0）：不加密、不耗用户口令，先问 embed「装得下吗」。
   * @returns {Promise<{fits:boolean, mode?:string, medium?:string, payloadBytes?:number, containerBytes?:number, requiredBytes?:number, availableBytes?:number, detail?:object}>}
   */
  async function estimate(payload, o = {}) {
    await ready();
    const medium = o.medium || opts.medium || 'file';
    if (medium !== initMedium) await setMedium(medium);
    const value = medium === 'text' && typeof payload === 'string' ? payload : await toArrayBufferAsync(payload);
    const carrier = o.carrier ? await toArrayBufferAsync(o.carrier) : null;
    const res = await request(buildEstimateMessage(nonce, value, o.meta, carrier), '容量预检');
    return {
      fits: !!res.fits, mode: res.mode, medium: res.medium, binary: !!res.binary,
      payloadBytes: res.payloadBytes, containerBytes: res.containerBytes,
      requiredBytes: res.requiredBytes, availableBytes: res.availableBytes, detail: res.detail || null,
    };
  }

  function close() {
    if (state === 'closed') return;
    try { if (state === 'ready' && nonce) post(buildCancelMessage(nonce)); } catch (e) { /* ignore */ }
    if (bound) { try { win.removeEventListener('message', onMessage); } catch (e) {} bound = false; }
    if (root && root.parentNode) { try { root.parentNode.removeChild(root); } catch (e) {} }
    root = null; iframeEl = null;
    if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
    if (pending) { const p = pending; pending = null; if (p.timer) clearTimeout(p.timer); try { p.reject(new CkxEmbedError('CKX_EMBED_CLOSED', '客户端已关闭')); } catch (e) {} }
    if (readyReject) { try { readyReject(new CkxEmbedError('CKX_EMBED_CLOSED', '客户端已关闭')); } catch (e) {} }
    readyResolve = null; readyReject = null;
    state = 'closed';
    note('closed');
  }

  return {
    ready, encrypt, decrypt, estimate, close, setMedium,
    getState: () => state,
    getNonce: () => nonce,
    getMedium: () => initMedium || opts.medium || 'file',
    getCapabilities: () => (caps ? Object.assign({}, caps) : null),
    getLog: () => log.slice(),
    getEmbedUrl: () => embedSrc,
    isMock: () => useMock,
  };
}
