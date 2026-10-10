/**
 * CKX 0.4.0 新消息回归：`ckx:estimate` / `ckx:resize` / `ckx:idle-warning` / 扩展 `ckx:capabilities`
 *
 * 覆盖两层：
 *  A) 宿主客户端 `createCkxEmbedClient`：
 *     - `estimate()` 正常 / `fits:false` 带 detail；请求携带 payload/carrier
 *     - `ckx:resize`：默认改浮层高度；`autoHeight:false` 不改；超视口被钳制；`onResize` 回调
 *     - `ckx:idle-warning`：回调触发、不进错误路径（不 reject 进行中的请求）、日志含 idle-warning
 *     - `ckx:capabilities` 扩展字段：ignored / sdkVersion / idleTimeoutSec / schemas / mediums
 *     - 协议版本 / nonce 校验对新消息同样生效（错 nonce 被忽略）
 *  B) 本地 mock embed `mountCkxMockEmbed`（`ckx-demo.html?embed=mock`）：
 *     - 启动发 `ckx:ready` + `ckx:resize`
 *     - 处理 `ckx:estimate` → 用 vendored SDK 回 `ckx:estimate.result`（含 `detail.mock`）
 */
import {
  createCkxEmbedClient, CKX_EMBED_ORIGIN, CKX_PROTOCOL_V,
} from '../src/persistence/ckxEmbed.js';
import { mountCkxMockEmbed } from '../src/persistence/ckxDemo.js';

const CKX = await import('../src/vendor/ckx/ckx.esm.js');

let fails = 0;
const check = (name, cond, extra) => { if (!cond) { fails++; console.error('FAIL:', name, extra == null ? '' : extra); } else console.log('ok:', name); };
const tick = (ms = 8) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 假浏览器环境（宿主 + 可编程 embed）
function createFakeEnv(opts = {}) {
  const embedOrigin = opts.embedOrigin || CKX_EMBED_ORIGIN;
  const hostOrigin = opts.hostOrigin || 'https://host.test';
  const listeners = new Set();
  const iframes = [];
  let embed = null;
  const win = {
    location: { origin: hostOrigin, search: '', href: hostOrigin + '/' },
    innerHeight: opts.innerHeight || 800,
    URL: globalThis.URL, URLSearchParams: globalThis.URLSearchParams,
    addEventListener(t, fn) { if (t === 'message') listeners.add(fn); },
    removeEventListener(t, fn) { if (t === 'message') listeners.delete(fn); },
  };
  const emit = (ev) => { for (const fn of [...listeners]) fn(ev); };
  const fromEmbed = (iframe, data, originOverride) => emit({ origin: originOverride || embedOrigin, source: iframe.contentWindow, data });

  function onIframe(iframe) {
    iframes.push(iframe);
    if (!embed) return;
    setTimeout(() => { embed.onLoad && embed.onLoad({ iframe, fromEmbed: (d, o) => fromEmbed(iframe, d, o) }); }, 0);
  }
  function onHostPost(iframe, msg) {
    if (!embed) return;
    setTimeout(() => { embed.onMessage && embed.onMessage(msg, { iframe, fromEmbed: (d, o) => fromEmbed(iframe, d, o) }); }, 0);
  }
  function makeEl(tag) {
    const el = {
      tagName: tag, style: {}, _text: '', _html: '', children: [], parentNode: null, _listeners: {}, _attrs: {},
      setAttribute(k, v) { this._attrs[k] = v; }, getAttribute(k) { return this._attrs[k]; },
      appendChild(c) { c.parentNode = this; this.children.push(c); if (c.tagName === 'iframe') onIframe(c); return c; },
      removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; },
      addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
      click() { (this._listeners.click || []).forEach((f) => f({})); },
    };
    Object.defineProperty(el, 'textContent', { get() { return this._text; }, set(v) { this._text = v; } });
    Object.defineProperty(el, 'innerHTML', { get() { return this._html; }, set(v) { this._html = v; } });
    if (tag === 'iframe') el.contentWindow = { postMessage(msg) { onHostPost(el, msg); } };
    return el;
  }
  const body = makeEl('body');
  const doc = { body, referrer: hostOrigin + '/', createElement: makeEl, getElementById: () => null };
  return {
    win, doc, iframes,
    setEmbed: (e) => { embed = e; },
    fromEmbed: (d, o) => iframes[0] && fromEmbed(iframes[0], d, o),
    getBox: () => { const root = body.children.find((c) => c._attrs && c._attrs['data-ckx-embed']); return root ? root.children[0] : null; },
  };
}

/** 可编程 embed：握手固定正确，业务消息交给 `onRequest`。 */
function makeEmbed({ readyNonce = 'rn-0', capabilities = ['text', 'image', 'file', 'video'], capsExtra = {}, origin = CKX_EMBED_ORIGIN } = {}) {
  const seen = [];
  const embed = {
    seen, origin, onRequest: null,
    onLoad({ fromEmbed }) { fromEmbed({ v: 1, formatVersion: '1', type: 'ckx:ready', nonce: readyNonce, capabilities, pro: false }, origin); },
    onMessage(msg, { fromEmbed }) {
      seen.push(msg);
      if (msg.type === 'ckx:init') {
        const nonce = msg.nonce;
        fromEmbed(Object.assign({ v: 1, formatVersion: '1', type: 'ckx:capabilities', nonce, capabilities, pro: false, granted: [], expiresAt: null, source: 'none' }, capsExtra), origin);
        return;
      }
      if (embed.onRequest) embed.onRequest(msg, { fromEmbed: (d, o) => fromEmbed(d, o || origin), nonce: msg.nonce });
    },
  };
  return embed;
}

// ---------------------------------------------------------------- A1) estimate() 正常
{
  const env = createFakeEnv();
  const embed = makeEmbed();
  embed.onRequest = (msg, { fromEmbed }) => {
    if (msg.type !== 'ckx:estimate') return;
    fromEmbed({ v: 1, formatVersion: '1', type: 'ckx:estimate.result', nonce: msg.nonce, mode: 'file', medium: 'C', binary: true, payloadBytes: 5, containerBytes: 67, requiredBytes: 67, availableBytes: 5242880, fits: true });
  };
  env.setEmbed(embed);
  const client = createCkxEmbedClient({ win: env.win, doc: env.doc, app: 'https://host.test', timeoutMs: 3000 });
  await client.ready();
  const est = await client.estimate('hello', { medium: 'file' });
  check('A1 estimate() 返回 fits/medium/requiredBytes/availableBytes', est.fits === true && est.medium === 'C' && est.requiredBytes === 67 && est.availableBytes === 5242880);
  const sent = embed.seen.find((m) => m.type === 'ckx:estimate');
  check('A2 请求带 payload（已转 ArrayBuffer）', !!sent && sent.payload && sent.payload.byteLength === 5, sent && String(sent.payload && sent.payload.byteLength));
  check('A3 estimate 不走错误分支（无 CKX_EMBED_BAD_RESULT）', est.mode === 'file' && est.binary === true);
  client.close();
}

// ---------------------------------------------------------------- A4) estimate() fits=false + detail
{
  const env = createFakeEnv();
  const embed = makeEmbed();
  embed.onRequest = (msg, { fromEmbed }) => {
    if (msg.type === 'ckx:estimate') fromEmbed({ v: 1, formatVersion: '1', type: 'ckx:estimate.result', nonce: msg.nonce, mode: 'image', medium: 'B', binary: true, payloadBytes: 1000, requiredBytes: 1000, availableBytes: 64, fits: false, detail: { limit: 64, actual: 1000 } });
  };
  env.setEmbed(embed);
  const client = createCkxEmbedClient({ win: env.win, doc: env.doc, app: 'https://host.test', timeoutMs: 3000 });
  await client.ready();
  const est = await client.estimate('x', { medium: 'file' });
  check('A4 fits=false 且能拿到 detail.limit/actual', est.fits === false && est.detail && est.detail.limit === 64 && est.detail.actual === 1000, JSON.stringify(est.detail));
  client.close();
}

// ---------------------------------------------------------------- A5) estimate() 带 carrier 直通
{
  const env = createFakeEnv();
  const embed = makeEmbed({ capabilities: ['text', 'image', 'file', 'video'] });
  embed.onRequest = (msg, { fromEmbed }) => {
    if (msg.type === 'ckx:estimate') fromEmbed({ v: 1, formatVersion: '1', type: 'ckx:estimate.result', nonce: msg.nonce, mode: 'image', medium: 'B', binary: true, payloadBytes: 3, requiredBytes: 3, availableBytes: 1024, fits: true });
  };
  env.setEmbed(embed);
  const client = createCkxEmbedClient({ win: env.win, doc: env.doc, app: 'https://host.test', medium: 'image', timeoutMs: 3000 });
  await client.ready();
  await client.estimate('abc', { medium: 'image', carrier: new ArrayBuffer(64) });
  const sent = embed.seen.find((m) => m.type === 'ckx:estimate');
  check('A5 estimate 请求携带 carrier', !!sent && sent.carrier && sent.carrier.byteLength === 64, sent && String(sent.carrier && sent.carrier.byteLength));
  client.close();
}

// ---------------------------------------------------------------- B) ckx:resize
{
  // B1 默认改高度 + onResize 回调
  const env = createFakeEnv({ innerHeight: 800 });
  const resized = [];
  const embed = makeEmbed();
  env.setEmbed(embed);
  const client = createCkxEmbedClient({ win: env.win, doc: env.doc, app: 'https://host.test', timeoutMs: 3000, onResize: (m) => resized.push(m.height) });
  await client.ready();
  await tick();
  const box = env.getBox();
  check('B0 浮层 box 已建立', !!box);
  env.fromEmbed({ v: 1, formatVersion: '1', type: 'ckx:resize', nonce: client.getNonce(), height: 640 });
  check('B1 ckx:resize 默认把 box 高度设为 height', box.style.height === '640px', box.style.height);
  check('B2 onResize 回调被调用', resized.length === 1 && resized[0] === 640, JSON.stringify(resized));

  // B3 超视口钳制（innerHeight 800 → max 768）
  env.fromEmbed({ v: 1, formatVersion: '1', type: 'ckx:resize', nonce: client.getNonce(), height: 5000 });
  check('B3 超视口被钳制', box.style.height === '768px', box.style.height);
  // B4 过小钳到下限 220
  env.fromEmbed({ v: 1, formatVersion: '1', type: 'ckx:resize', nonce: client.getNonce(), height: 100 });
  check('B4 过小钳到 220', box.style.height === '220px', box.style.height);
  // B5 无 height / 非有限值忽略
  env.fromEmbed({ v: 1, formatVersion: '1', type: 'ckx:resize', nonce: client.getNonce() });
  check('B5 缺 height 被忽略（保持 220）', box.style.height === '220px', box.style.height);
  client.close();
}
{
  // B6 autoHeight:false → 不改高度
  const env = createFakeEnv({ innerHeight: 800 });
  const resized = [];
  const embed = makeEmbed();
  env.setEmbed(embed);
  const client = createCkxEmbedClient({ win: env.win, doc: env.doc, app: 'https://host.test', timeoutMs: 3000, autoHeight: false, onResize: (m) => resized.push(m.height) });
  await client.ready();
  await tick();
  const box = env.getBox();
  env.fromEmbed({ v: 1, formatVersion: '1', type: 'ckx:resize', nonce: client.getNonce(), height: 700 });
  check('B6 autoHeight:false 不改高度', box.style.height === undefined, box.style.height);
  check('B7 autoHeight:false 仍触发 onResize 回调', resized.length === 1 && resized[0] === 700, JSON.stringify(resized));
  client.close();
}

// ---------------------------------------------------------------- C) ckx:idle-warning
{
  const env = createFakeEnv();
  const warned = [];
  let reply = null;
  const embed = makeEmbed();
  embed.onRequest = (msg, { fromEmbed }) => {
    if (msg.type === 'ckx:encrypt') {
      reply = () => fromEmbed({ v: 1, formatVersion: '1', type: 'ckx:result', nonce: msg.nonce, kind: 'carrier', file: { name: 'x.ckx', mime: 'application/octet-stream', bytes: new ArrayBuffer(4) }, meta: {} });
    }
  };
  env.setEmbed(embed);
  const client = createCkxEmbedClient({ win: env.win, doc: env.doc, app: 'https://host.test', timeoutMs: 3000, onIdleWarning: (m) => warned.push(m.remainingMs) });
  await client.ready();
  await tick();
  const p = client.encrypt('x', { medium: 'file' });
  await tick();                                   // 让 embed 收到 encrypt 并挂起回复
  env.fromEmbed({ v: 1, formatVersion: '1', type: 'ckx:idle-warning', nonce: client.getNonce(), remainingMs: 15000 });
  await tick();
  check('C1 onIdleWarning 回调被调用', warned.length === 1 && warned[0] === 15000, JSON.stringify(warned));
  check('C2 idle-warning 未被当作错误（请求仍 pending）', reply != null);
  reply();
  let out = null, err = null;
  try { out = await p; } catch (e) { err = e; }
  check('C3 进行中的请求随后正常成功（未被 idle-warning reject）', !err && out && out.bytes instanceof Uint8Array, err && (err.code || err.message));
  check('C4 日志含 idle-warning', client.getLog().some((l) => l.evt === 'idle-warning'));
  client.close();
}

// ---------------------------------------------------------------- D) ckx:capabilities 扩展字段
{
  const env = createFakeEnv();
  const embed = makeEmbed({ capsExtra: { ignored: ['schema'], sdkVersion: '0.4.0', idleTimeoutSec: 120, schemas: ['srsi.vault.v1'], mediums: { text: { hostCarrier: false, carrier: 'A' } } } });
  env.setEmbed(embed);
  const client = createCkxEmbedClient({ win: env.win, doc: env.doc, app: 'https://host.test', timeoutMs: 3000 });
  await client.ready();
  await tick();
  const caps = client.getCapabilities();
  check('D1 ignored 读入', caps && Array.isArray(caps.ignored) && caps.ignored[0] === 'schema', JSON.stringify(caps && caps.ignored));
  check('D2 sdkVersion 读入', caps && caps.sdkVersion === '0.4.0', caps && caps.sdkVersion);
  check('D3 idleTimeoutSec 读入', caps && caps.idleTimeoutSec === 120, caps && String(caps.idleTimeoutSec));
  check('D4 schemas / mediums 读入', caps && caps.schemas[0] === 'srsi.vault.v1' && caps.mediums && caps.mediums.text.carrier === 'A');
  // 缺省时安全回落
  const env2 = createFakeEnv();
  env2.setEmbed(makeEmbed());
  const c2 = createCkxEmbedClient({ win: env2.win, doc: env2.doc, app: 'https://host.test', timeoutMs: 3000 });
  await c2.ready();
  await tick();
  const caps2 = c2.getCapabilities();
  check('D5 缺省扩展字段安全回落（空数组/null）', caps2.ignored.length === 0 && caps2.sdkVersion === null && caps2.idleTimeoutSec === null);
  c2.close(); client.close();
}

// ---------------------------------------------------------------- E) 新消息同样受协议/nonce 校验
{
  const env = createFakeEnv({ innerHeight: 800 });
  const resized = [];
  const warned = [];
  const embed = makeEmbed();
  env.setEmbed(embed);
  const client = createCkxEmbedClient({ win: env.win, doc: env.doc, app: 'https://host.test', timeoutMs: 3000, onResize: (m) => resized.push(m.height), onIdleWarning: (m) => warned.push(m.remainingMs) });
  await client.ready();
  await tick();
  const box = env.getBox();
  env.fromEmbed({ v: 1, formatVersion: '1', type: 'ckx:resize', nonce: 'WRONG-NONCE', height: 500 });
  env.fromEmbed({ v: 1, formatVersion: '1', type: 'ckx:idle-warning', nonce: 'WRONG-NONCE', remainingMs: 1 });
  check('E1 错 nonce 的 ckx:resize 被忽略', box.style.height === undefined && resized.length === 0, box.style.height + '/' + JSON.stringify(resized));
  check('E2 错 nonce 的 ckx:idle-warning 被忽略', warned.length === 0, JSON.stringify(warned));
  check('E3 忽略原因记为 nonce', client.getLog().filter((l) => l.evt === 'ignored' && l.reason === 'nonce').length >= 2);
  // 错误协议版本
  env.fromEmbed({ v: 2, formatVersion: '1', type: 'ckx:resize', nonce: client.getNonce(), height: 500 });
  check('E4 错误协议版本的 ckx:resize 被忽略', box.style.height === undefined && resized.length === 0);
  // 错误 origin
  env.fromEmbed({ v: 1, formatVersion: '1', type: 'ckx:resize', nonce: client.getNonce(), height: 500 }, 'https://evil.test');
  check('E5 错误 origin 的 ckx:resize 被忽略', box.style.height === undefined && resized.length === 0);
  client.close();
}

// ---------------------------------------------------------------- F) 本地 mock embed 支持新消息
{
  const outbox = [];
  const listeners = new Set();
  const parent = { postMessage: (m) => outbox.push(m) };
  const win = {
    parent,
    addEventListener(t, fn) { if (t === 'message') listeners.add(fn); },
    removeEventListener(t, fn) { if (t === 'message') listeners.delete(fn); },
    _dispatch(ev) { for (const fn of [...listeners]) fn(ev); },
  };
  const byId = new Map();
  const mk = (tag) => {
    const el = {
      tagName: tag, style: {}, _text: '', _html: '', children: [], _listeners: {},
      appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
      removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
      addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
      setAttribute() {}, getAttribute() { return null; },
    };
    Object.defineProperty(el, 'textContent', { get() { return this._text; }, set(v) { this._text = v; } });
    Object.defineProperty(el, 'innerHTML', { get() { return this._html; }, set(v) { this._html = v; } });
    return el;
  };
  const doc = { referrer: 'https://host.test/', body: mk('body'), createElement: mk, getElementById: (id) => { if (!byId.has(id)) byId.set(id, mk('div')); return byId.get(id); } };
  const handle = mountCkxMockEmbed({ win, doc, ckx: CKX });
  check('F1 mock 挂载返回 nonce 句柄', !!handle && typeof handle.getNonce() === 'string' && handle.getNonce().length > 0);
  const ready = outbox.find((m) => m.type === 'ckx:ready');
  check('F2 mock 启动发 ckx:ready', !!ready && ready.formatVersion === '1');
  check('F3 mock ready 后发 ckx:resize', outbox.some((m) => m.type === 'ckx:resize') && outbox.filter((m) => m.type === 'ckx:resize').every((m) => m.height >= 320));

  const rn = ready.nonce;
  win._dispatch({ source: parent, data: { v: 1, type: 'ckx:init', nonce: rn, app: 'https://host.test', mode: 'file' } });
  const caps = outbox.find((m) => m.type === 'ckx:capabilities');
  check('F4 mock 处理 ckx:init → ckx:capabilities', !!caps && caps.nonce === rn);

  win._dispatch({ source: parent, data: { v: 1, type: 'ckx:estimate', nonce: rn, payload: 'hello', meta: { app: 'https://host.test' } } });
  const est = outbox.filter((m) => m.type === 'ckx:estimate.result').pop();
  check('F5 mock 处理 ckx:estimate → ckx:estimate.result', !!est && est.formatVersion === '1' && est.mode === 'file' && est.fits === true);
  check('F6 mock estimate 标 detail.mock 且 medium 合理', est.detail && est.detail.mock === true && est.medium === 'C' && est.requiredBytes > 0, JSON.stringify(est.detail));

  // image 模式：小载体 → 容量不足
  win._dispatch({ source: parent, data: { v: 1, type: 'ckx:init', nonce: rn, app: 'https://host.test', mode: 'image' } });
  win._dispatch({ source: parent, data: { v: 1, type: 'ckx:estimate', nonce: rn, payload: new ArrayBuffer(2000), carrier: new ArrayBuffer(4 * 32 * 32) } });
  const estI = outbox.filter((m) => m.type === 'ckx:estimate.result').pop();
  check('F7 mock image 容量不足 → fits=false + detail.limit/actual', estI.fits === false && estI.detail.actual === 2000 && typeof estI.detail.limit === 'number', JSON.stringify(estI.detail));

  // 协议版本不符 / 错 nonce 忽略
  const before = outbox.filter((m) => m.type === 'ckx:estimate.result').length;
  win._dispatch({ source: parent, data: { v: 2, type: 'ckx:estimate', nonce: rn, payload: 'x' } });
  win._dispatch({ source: parent, data: { v: 1, type: 'ckx:estimate', nonce: 'WRONG', payload: 'x' } });
  check('F8 mock 忽略错误协议版本 / 错 nonce', outbox.filter((m) => m.type === 'ckx:estimate.result').length === before);
}

// ---------------------------------------------------------------- 常量兜底
{
  check('G1 CKX_PROTOCOL_V 仍为 1', CKX_PROTOCOL_V === 1 && CKX_EMBED_ORIGIN === 'https://cryptokey.im');
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
