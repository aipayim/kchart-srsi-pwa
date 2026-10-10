/**
 * CKX iframe embed 客户端测试（B 模式，postMessage 协议 v1）
 *
 * 覆盖：
 *  - 纯函数：makeNonce / buildInitMessage（schema 能力门控）/ checkEmbedMessage / toArrayBufferAsync / fetchEmbedPolicy
 *  - 协议握手：ckx:ready → ckx:init（回显 nonce）→ ckx:encrypt/decrypt → ckx:result/plaintext
 *  - 安全：错误 origin / 错误 source / 错误 nonce 一律忽略；ckx:error 映射为 CkxEmbedError
 *  - 两种介质（file / text）与真实 SDK 互通（本地 SDK 冒充 embed 源）
 *  - 超时、关闭、并发拒绝
 *  - ckxVault 的 embed 包装（deps.embed 注入，无需 iframe）
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  createCkxEmbedClient, checkEmbedMessage, buildInitMessage, buildEncryptMessage, buildDecryptMessage,
  makeNonce, toArrayBufferAsync, fetchEmbedPolicy,
  CkxEmbedError, CKX_EMBED_ORIGIN, CKX_PROTOCOL_V,
} from '../src/persistence/ckxEmbed.js';
import {
  exportVaultViaEmbed, importVaultViaEmbed, collectVault, VAULT_SCHEMA_ID, VaultError, VAULT_CODES,
} from '../src/persistence/ckxVault.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CKX = await import('../src/vendor/ckx/ckx.esm.js');

let fails = 0;
const check = (name, cond) => { if (!cond) { fails++; console.error('FAIL:', name); } else console.log('ok:', name); };
const rejects = async (name, fn, code) => {
  try { await fn(); fails++; console.error('FAIL (no throw):', name); }
  catch (e) { check(name + ' → ' + (e.code || e.name), e.code === code); }
};

// ---------------------------------------------------------------- 假浏览器环境（宿主 + 可编程 embed）
function createFakeEnv(opts = {}) {
  const embedOrigin = opts.embedOrigin || CKX_EMBED_ORIGIN;
  const hostOrigin = opts.hostOrigin || 'https://host.test';
  const listeners = new Set();
  const iframes = [];
  let embed = opts.embed || null;

  const win = {
    location: { origin: hostOrigin, search: '', href: hostOrigin + '/' },
    URL: globalThis.URL,
    URLSearchParams: globalThis.URLSearchParams,
    addEventListener(type, fn) { if (type === 'message') listeners.add(fn); },
    removeEventListener(type, fn) { if (type === 'message') listeners.delete(fn); },
  };
  function emit(ev) { for (const fn of [...listeners]) fn(ev); }
  function fromEmbed(iframe, data, originOverride) {
    emit({ origin: originOverride || embedOrigin, source: iframe.contentWindow, data });
  }
  function makeEl(tag) {
    const el = {
      tagName: tag, style: {}, _listeners: {}, _text: '', children: [], parentNode: null,
      src: '', _attrs: {},
      setAttribute(k, v) { this._attrs[k] = v; }, getAttribute(k) { return this._attrs[k]; },
      appendChild(c) { c.parentNode = this; this.children.push(c); if (c.tagName === 'iframe') onIframe(c); return c; },
      removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; },
      addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
      click() { (this._listeners.click || []).forEach((f) => f({})); },
    };
    Object.defineProperty(el, 'textContent', { get() { return this._text; }, set(v) { this._text = v; } });
    Object.defineProperty(el, 'innerHTML', { get() { return this._html || ''; }, set(v) { this._html = v; } });
    if (tag === 'iframe') {
      el.contentWindow = { postMessage(msg) { onHostPost(el, msg); } };
    }
    return el;
  }
  const doc = { body: makeEl('body'), referrer: hostOrigin + '/', createElement: makeEl, getElementById: () => null };

  function onIframe(iframe) {
    iframes.push(iframe);
    if (!embed) return;
    setTimeout(() => { embed.onLoad && embed.onLoad({ iframe, fromEmbed: (d, o) => fromEmbed(iframe, d, o) }); }, 0);
  }
  function onHostPost(iframe, msg) {
    if (!embed) return;
    setTimeout(() => { embed.onMessage && embed.onMessage(msg, { iframe, fromEmbed: (d, o) => fromEmbed(iframe, d, o) }); }, 0);
  }

  return { win, doc, iframes, emit: (ev) => emit(ev), fromEmbed: (d, o) => iframes[0] && fromEmbed(iframes[0], d, o), setEmbed: (e) => { embed = e; } };
}

/** 一个"协议正确"的假 embed（可切换 fake / 真 SDK 加解密）。 */
function makeFakeEmbed({ embedOrigin = CKX_EMBED_ORIGIN, cryptoMode = 'fake', failOn = null, echoNonce = true, readyNonce = null, autoReturnPlaintext = true } = {}) {
  const nonce = readyNonce || 'ready-nonce-abcdef';
  let sessionNonce = nonce;
  const log = [];
  return {
    log,
    onLoad({ fromEmbed }) { fromEmbed({ v: 1, type: 'ckx:ready', formatVersion: '1', nonce, capabilities: ['text', 'image', 'file', 'video'], pro: false }); },
    async onMessage(msg, { fromEmbed }) {
      log.push(msg.type);
      if (msg.type === 'ckx:init') {
        sessionNonce = echoNonce ? msg.nonce : 'WRONG-' + msg.nonce;
        fromEmbed({ v: 1, type: 'ckx:capabilities', nonce: sessionNonce, capabilities: ['text', 'image', 'file', 'video'], pro: false, granted: [], expiresAt: null, source: 'none' });
        return;
      }
      if (failOn === msg.type) { fromEmbed({ v: 1, type: 'ckx:error', nonce: sessionNonce, code: 'CKX_CAPABILITY_REQUIRED', message: '需要签约能力' }); return; }
      if (msg.type === 'ckx:encrypt') {
        if (cryptoMode === 'real') {
          const meta = msg.meta || {};
          if (typeof msg.payload === 'string') {
            const text = await CKX.encryptToText(msg.payload, 'pw-in-embed', { app: 'https://embed.test' });
            fromEmbed({ v: 1, type: 'ckx:result', nonce: sessionNonce, kind: 'ciphertext', text, meta: { ckx: '1', app: 'https://embed.test' } });
          } else {
            const bytes = await CKX.encryptToFile(new Uint8Array(msg.payload), 'pw-in-embed', { app: 'https://embed.test', label: meta.label });
            fromEmbed({ v: 1, type: 'ckx:result', nonce: sessionNonce, kind: 'carrier', file: { name: 'real.ckx', mime: 'application/octet-stream', bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }, meta: { ckx: '1', app: 'https://embed.test' } });
          }
        } else if (typeof msg.payload === 'string') {
          const text = 'CT:' + Buffer.from(msg.payload, 'utf8').toString('base64url');
          fromEmbed({ v: 1, type: 'ckx:result', nonce: sessionNonce, kind: 'ciphertext', text, meta: { ckx: '1', app: 'fake' } });
        } else {
          const buf = Buffer.concat([Buffer.from('FAKE'), Buffer.from(new Uint8Array(msg.payload))]);
          const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
          fromEmbed({ v: 1, type: 'ckx:result', nonce: sessionNonce, kind: 'carrier', file: { name: 'fake.ckx', mime: 'application/octet-stream', bytes: ab }, meta: { ckx: '1', app: 'fake' } });
        }
        return;
      }
      if (msg.type === 'ckx:decrypt') {
        let text = null, bytes = null, meta = { ckx: '1', app: 'fake' };
        if (cryptoMode === 'real') {
          const out = await CKX.decrypt(typeof msg.carrier === 'string' ? msg.carrier : new Uint8Array(msg.carrier), 'pw-in-embed');
          text = out.text; bytes = out.plaintext; meta = out.meta;
        } else if (typeof msg.carrier === 'string') {
          text = Buffer.from(String(msg.carrier).replace(/^CT:/, ''), 'base64url').toString('utf8');
        } else {
          const u8 = new Uint8Array(msg.carrier);
          text = Buffer.from(u8.slice(4)).toString('utf8');
        }
        const m = { v: 1, type: 'ckx:plaintext', nonce: sessionNonce, meta };
        if (autoReturnPlaintext) { if (text != null) m.text = text; else if (bytes) m.bytes = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); fromEmbed(m); }
        else { (globalThis.__pendingPlaintext ||= []).push(m); }
        return;
      }
    },
  };
}

// ---------------------------------------------------------------- 1) 纯函数
{
  const n = makeNonce(8);
  check('P1 makeNonce 长度/字符集', /^[0-9a-f]{16}$/.test(n) && makeNonce(8) !== n);
  const mi = buildInitMessage('N1', { app: 'https://a', mode: 'file', label: 'L' });
  check('P2 buildInitMessage 无 schema 时不含 schema 字段', mi.type === 'ckx:init' && mi.v === 1 && mi.nonce === 'N1' && !('schema' in mi) && mi.label === 'L');
  const mi2 = buildInitMessage('N1', { app: 'https://a', schema: 'x.v1', schemaVersion: 2 });
  check('P3 显式 schema 才带上（免费层默认不带）', mi2.schema === 'x.v1' && mi2.schemaVersion === '2');
  check('P4 encrypt/decrypt 消息形状', buildEncryptMessage('N', 'p').type === 'ckx:encrypt' && buildDecryptMessage('N', 'c', 'f.ckx').carrierName === 'f.ckx');

  const okCtx = { allowOrigins: [CKX_EMBED_ORIGIN], sourceOk: true, nonce: 'N', requireNonce: true };
  check('P5 checkEmbedMessage 正常通过', checkEmbedMessage({ origin: CKX_EMBED_ORIGIN, data: { v: 1, type: 'ckx:result', nonce: 'N' } }, okCtx).ok === true);
  check('P6 错误 origin 拒绝', checkEmbedMessage({ origin: 'https://evil.test', data: { v: 1, type: 'ckx:result', nonce: 'N' } }, okCtx).reason === 'origin');
  check('P7 错误 source 拒绝', checkEmbedMessage({ origin: CKX_EMBED_ORIGIN, data: { v: 1, type: 'ckx:result', nonce: 'N' } }, Object.assign({}, okCtx, { sourceOk: false })).reason === 'source');
  check('P8 错误 nonce 拒绝', checkEmbedMessage({ origin: CKX_EMBED_ORIGIN, data: { v: 1, type: 'ckx:result', nonce: 'X' } }, okCtx).reason === 'nonce');
  check('P9 协议版本不符拒绝', checkEmbedMessage({ origin: CKX_EMBED_ORIGIN, data: { v: 2, type: 'ckx:result', nonce: 'N' } }, okCtx).reason === 'version');
  check('P10 非 ckx: 前缀拒绝', checkEmbedMessage({ origin: CKX_EMBED_ORIGIN, data: { v: 1, type: 'evil', nonce: 'N' } }, okCtx).reason === 'type');

  check('P11 toArrayBufferAsync string', new TextDecoder().decode(await toArrayBufferAsync('ab')) === 'ab');
  check('P12 toArrayBufferAsync Uint8Array 偏移正确', new Uint8Array(await toArrayBufferAsync(new Uint8Array([9, 1, 2, 3]).subarray(1)))[0] === 1);
  await rejects('P13 toArrayBufferAsync 非法类型', () => toArrayBufferAsync(42), 'CKX_EMBED_BAD_PAYLOAD');

  const seenPolicy = [];
  const pol = await fetchEmbedPolicy('https://x.test', { fetch: async (u) => { seenPolicy.push(String(u)); return { ok: true, json: async () => ({ ok: true, allowed: true }) }; } });
  check('P14 fetchEmbedPolicy 拼 origin 参数 + 归一化（0.4.0 无 origins）', pol.allowed === true && seenPolicy[0].includes('origin=https%3A%2F%2Fx.test') && !('origins' in pol), seenPolicy[0]);
  check('P15 CKX_EMBED_ORIGIN 常量', CKX_EMBED_ORIGIN === 'https://cryptokey.im' && CKX_PROTOCOL_V === 1);
}

// ---------------------------------------------------------------- 2) 握手 + file 介质（fake 加密）
{
  const env = createFakeEnv({ embed: makeFakeEmbed() });
  const client = createCkxEmbedClient({ win: env.win, doc: env.doc, app: 'https://host.test', timeoutMs: 3000 });
  const caps = await client.ready();
  check('H1 握手完成 capabilities', caps.capabilities.includes('file') && caps.pro === false);
  check('H2 已发送 ckx:init', env.iframes.length === 1);
  const out = await client.encrypt(JSON.stringify({ a: 1 }), { medium: 'file' });
  check('H3 file 介质返回 .ckx 字节', out.medium === 'file' && out.bytes instanceof Uint8Array && out.bytes.length > 4 && out.name === 'fake.ckx');
  check('H4 载体含 FAKE 标记（假加密）', new TextDecoder().decode(out.bytes.slice(0, 4)) === 'FAKE');
  const dec = await client.decrypt(out.bytes);
  check('H5 解密回原文', dec.text === JSON.stringify({ a: 1 }));
  check('H6 日志记录了 ready', client.getLog().some((l) => l.evt === 'ready'));
  client.close();
  check('H7 关闭后状态 closed 且移除 iframe', client.getState() === 'closed' && env.doc.body.children.length === 0);
}

// ---------------------------------------------------------------- 3) text 介质
{
  const env = createFakeEnv({ embed: makeFakeEmbed() });
  const client = createCkxEmbedClient({ win: env.win, doc: env.doc, timeoutMs: 3000 });
  const out = await client.encrypt('hello-世界', { medium: 'text' });
  check('T1 text 介质返回密文串', out.medium === 'text' && typeof out.text === 'string' && out.text.startsWith('CT:'));
  const dec = await client.decrypt(out.text);
  check('T2 text 密文串解回', dec.text === 'hello-世界');
  client.close();
}

// ---------------------------------------------------------------- 4) 安全：错误 origin / source / nonce 被忽略
{
  // 4a 错误 origin
  {
    const embed = makeFakeEmbed();
    const env = createFakeEnv({ embed, embedOrigin: 'https://evil.test', hostOrigin: 'https://host.test' });
    const client = createCkxEmbedClient({ win: env.win, doc: env.doc, timeoutMs: 120 });
    await rejects('S1 错误 origin 的 ready 被忽略 → 超时', () => client.ready(), 'CKX_TIMEOUT');
    client.close();
  }
  // 4b 错误 nonce（init 未回显）
  {
    const env = createFakeEnv({ embed: makeFakeEmbed({ echoNonce: false }) });
    const client = createCkxEmbedClient({ win: env.win, doc: env.doc, timeoutMs: 120 });
    await rejects('S2 init 未回显 nonce → 结果被忽略 → 超时', async () => { await client.ready(); await client.encrypt('x', { medium: 'file' }); }, 'CKX_TIMEOUT');
    client.close();
  }
  // 4c 错误 source（非 iframe.contentWindow）
  {
    const env = createFakeEnv({ embed: makeFakeEmbed() });
    const client = createCkxEmbedClient({ win: env.win, doc: env.doc, timeoutMs: 300 });
    const p = client.ready();
    await new Promise((r) => setTimeout(r, 10));
    env.emit({ origin: CKX_EMBED_ORIGIN, source: { fake: 'other-window' }, data: { v: 1, type: 'ckx:result', nonce: 'ready-nonce-abcdef', kind: 'ciphertext', text: 'EVIL' } });
    const caps = await p;
    check('S3 错误 source 被忽略（握手仍成功）', caps.capabilities.includes('file'));
    client.close();
  }
}

// ---------------------------------------------------------------- 5) 错误映射 / 超时 / 并发 / 关闭
{
  const env = createFakeEnv({ embed: makeFakeEmbed({ failOn: 'ckx:encrypt' }) });
  const client = createCkxEmbedClient({ win: env.win, doc: env.doc, timeoutMs: 2000 });
  await rejects('E1 ckx:error 映射为 CkxEmbedError', () => client.encrypt('x', { medium: 'file' }), 'CKX_CAPABILITY_REQUIRED');
  client.close();
}
{
  const env = createFakeEnv({ embed: { onLoad({ fromEmbed }) { fromEmbed({ v: 1, type: 'ckx:ready', formatVersion: '1', nonce: 'n', capabilities: [], pro: false }); }, onMessage() { /* 永不回复 */ } } });
  const client = createCkxEmbedClient({ win: env.win, doc: env.doc, timeoutMs: 120 });
  await client.ready();
  await rejects('E2 请求超时', () => client.encrypt('x', { medium: 'file' }), 'CKX_TIMEOUT');
  client.close();
}
{
  const env = createFakeEnv({ embed: makeFakeEmbed() });
  const client = createCkxEmbedClient({ win: env.win, doc: env.doc, timeoutMs: 2000 });
  await client.ready();
  // 并发第二个请求（第一个用 text 立刻返回 → 需要人工占位；这里直接检查 request 守卫）
  const p1 = client.encrypt('a', { medium: 'file' });
  const p2 = client.encrypt('b', { medium: 'file' });
  const r = await Promise.allSettled([p1, p2]);
  check('E3 并发第二请求被拒（BUSY）', r.some((x) => x.status === 'rejected' && x.reason.code === 'CKX_EMBED_BUSY'));
  client.close();
}
{
  const env = createFakeEnv({ embed: makeFakeEmbed() });
  const client = createCkxEmbedClient({ win: env.win, doc: env.doc, timeoutMs: 5000 });
  const p = client.ready();
  client.close();
  await rejects('E4 关闭后 ready 被 reject', () => p, 'CKX_EMBED_CLOSED');
  await rejects('E5 关闭后调用被拒', () => client.encrypt('x', { medium: 'file' }), 'CKX_EMBED_CLOSED');
}

// ---------------------------------------------------------------- 6) 未知结果类型
{
  const env = createFakeEnv({
    embed: {
      onLoad({ fromEmbed }) { fromEmbed({ v: 1, type: 'ckx:ready', formatVersion: '1', nonce: 'n', capabilities: [], pro: false }); },
      onMessage(msg, { fromEmbed }) { if (msg.type === 'ckx:encrypt') fromEmbed({ v: 1, type: 'ckx:result', nonce: 'n', kind: 'weird', meta: {} }); },
    },
  });
  const client = createCkxEmbedClient({ win: env.win, doc: env.doc, timeoutMs: 2000 });
  await rejects('E6 未知 kind 报错', () => client.encrypt('x', { medium: 'file' }), 'CKX_EMBED_BAD_RESULT');
  client.close();
}

// ---------------------------------------------------------------- 7) 真实 SDK 冒充 embed（协议 ↔ 真实容器互通）
{
  const env = createFakeEnv({ embed: makeFakeEmbed({ cryptoMode: 'real' }) });
  const client = createCkxEmbedClient({ win: env.win, doc: env.doc, timeoutMs: 30000 });
  const payload = JSON.stringify({ schema: VAULT_SCHEMA_ID, schemaVersion: 1, data: { ls: {}, idb: {} } });
  const out = await client.encrypt(payload, { medium: 'file' });
  check('R1 真实容器 magic=SAFE/version=3', new TextDecoder().decode(out.bytes.slice(0, 4)) === 'SAFE' && out.bytes[4] === 3);
  const insp = await CKX.readMeta(out.bytes);
  check('R2 meta 免密码可读且无 schemaId（免费层）', insp && insp.ckx === '1' && !insp.schemaId);
  const dec = await client.decrypt(out.bytes);
  check('R3 真实容器解回原 JSON', JSON.parse(dec.text).schema === VAULT_SCHEMA_ID);
  client.close();
}

// ---------------------------------------------------------------- 8) ckxVault 的 embed 包装（注入 client，无需 iframe）
function fakeEmbedClient({ text, medium = 'file' }) {
  const calls = [];
  return {
    calls,
    async encrypt(payload, o) {
      calls.push(['encrypt', o && o.medium]);
      if ((o && o.medium) === 'text') return { medium: 'text', text: 'FAKECT', meta: { ckx: '1' } };
      return { medium: 'file', bytes: new TextEncoder().encode(payload), name: 'v.ckx', mime: 'application/octet-stream', meta: { ckx: '1' } };
    },
    async decrypt(carrier) {
      calls.push(['decrypt']);
      return { text: text != null ? text : new TextDecoder().decode(carrier), bytes: null, meta: { ckx: '1' } };
    },
    close() { calls.push(['close']); },
  };
}
function fakeLs(init = {}) {
  const m = new Map(Object.entries(init));
  return { keys: () => [...m.keys()], get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, String(v)), remove: (k) => m.delete(k) };
}
{
  const embed = fakeEmbedClient({});
  const out = await exportVaultViaEmbed({ includeSecrets: false, medium: 'file' }, { embed, ls: fakeLs({ smartTrader: '{"a":1}', pwa_zoom: '1' }), idb: null });
  check('V1 embed 导出返回 bytes + vault + summary', out.medium === 'file' && out.bytes instanceof Uint8Array && out.vault.schema === VAULT_SCHEMA_ID && out.summary.lsCount === 2);
  check('V2 未注入 close 时不关闭外部 client', !embed.calls.some((c) => c[0] === 'close'));

  const vaultJson = JSON.stringify(out.vault);
  const embed2 = fakeEmbedClient({ text: vaultJson });
  const prev = await importVaultViaEmbed(new Uint8Array([1, 2, 3]), {}, { embed: embed2 });
  check('V3 embed 导入返回 dry-run 预览', prev.vault.schema === VAULT_SCHEMA_ID && prev.summary.lsCount === 2 && prev.medium === 'file');

  const embed3 = fakeEmbedClient({ text: JSON.stringify({ schema: 'other.v1', schemaVersion: 1, data: {} }) });
  await rejects('V4 embed 导入 schema 不匹配', () => importVaultViaEmbed(new Uint8Array([1]), {}, { embed: embed3 }), VAULT_CODES.SCHEMA_MISMATCH);
  const embed4 = fakeEmbedClient({ text: 'not-json' });
  await rejects('V5 embed 导入非 JSON', () => importVaultViaEmbed(new Uint8Array([1]), {}, { embed: embed4 }), VAULT_CODES.BAD_PAYLOAD);

  // 未注入 embed 时应自行创建（Node 无 window → 抛 CKX_EMBED_NO_WINDOW）
  const ls = fakeLs({ smartTrader: 'x' });
  await rejects('V6 Node 下未注入 client 报无窗口', () => exportVaultViaEmbed({}, { ls, idb: null }), 'CKX_EMBED_NO_WINDOW');
}

// ---------------------------------------------------------------- 9) 与 ckxVault SDK 路径的产物互通
{
  // SDK 加密 → embed（fake client 直传文本）解密；以及 embed 产物 → SDK 解密
  const vault = await collectVault({}, { ls: fakeLs({ smartTrader: '{"a":1}' }), idb: null });
  const embed = makeFakeEmbed({ cryptoMode: 'real' });
  const env = createFakeEnv({ embed });
  const client = createCkxEmbedClient({ win: env.win, doc: env.doc, timeoutMs: 30000 });
  const out = await client.encrypt(JSON.stringify(vault), { medium: 'file' });
  // 用 SDK 解 embed 产物
  const sdkDec = await CKX.decrypt(out.bytes, 'pw-in-embed');
  check('X1 SDK 能解 embed 产物（同容器格式）', JSON.parse(sdkDec.text).schema === VAULT_SCHEMA_ID);
  // 用 SDK 加密 → embed 解
  const sdkBytes = await CKX.encryptToFile('{"hello":1}', 'pw-in-embed', { app: 'https://x' });
  const embedDec = await client.decrypt(sdkBytes);
  check('X2 embed 能解 SDK 产物', embedDec.text === '{"hello":1}');
  client.close();
}

// ---------------------------------------------------------------- 10) medium 只在 ckx:init 生效 → 切换必须重新 init
// 回归（浏览器子代理实测抓出的客户端隐患）：client 用默认 medium 建好后，encrypt({medium:'image',carrier})
// 若不重新 init，embed 仍按旧 mode 处理 → **静默产出错介质**。
{
  const modes = [];
  const env = createFakeEnv({
    embed: {
      onLoad({ fromEmbed }) { fromEmbed({ v: 1, type: 'ckx:ready', formatVersion: '1', nonce: 'n10', capabilities: ['text', 'image', 'file'], pro: false }); },
      onMessage(msg, { fromEmbed }) {
        if (msg.type === 'ckx:init') { modes.push(msg.mode); fromEmbed({ v: 1, type: 'ckx:capabilities', nonce: 'n10', capabilities: ['text', 'image', 'file'], pro: false, granted: [], expiresAt: null, source: 'none' }); return; }
        if (msg.type === 'ckx:encrypt') {
          const mode = modes[modes.length - 1];
          const file = mode === 'image'
            ? { name: 'c.png', mime: 'image/png', bytes: new ArrayBuffer(4) }
            : { name: 'c.ckx', mime: 'application/octet-stream', bytes: new ArrayBuffer(4) };
          fromEmbed({ v: 1, type: 'ckx:result', nonce: 'n10', kind: 'carrier', file, meta: {} });
        }
      },
    },
  });
  const client = createCkxEmbedClient({ win: env.win, doc: env.doc, timeoutMs: 3000 });   // 客户端默认 medium=file
  await client.ready();
  await new Promise((r) => setTimeout(r, 20));   // 等假 embed 处理排队的 ckx:init
  check('M10a 初始 ckx:init 的 mode=file', modes[0] === 'file', modes.join(','));
  const out = await client.encrypt('p', { medium: 'image', carrier: new ArrayBuffer(8) });
  check('M10b 切换 medium 触发了重新 ckx:init(mode=image)', modes.includes('image'), modes.join(','));
  check('M10c 结果按新 mode 处理（mime=image/png）', out.mime === 'image/png', out.mime);
  check('M10d getMedium() 已更新为 image', client.getMedium() === 'image', client.getMedium());
  check('M10e 日志记录 medium-reinit', client.getLog().some((l) => String(l.evt).startsWith('medium-reinit')), JSON.stringify(client.getLog().slice(-3)));
  // 同 medium 再调一次不应重复 init
  const before = modes.length;
  await client.encrypt('q', { medium: 'image' });
  check('M10f 同 medium 不重复 init', modes.length === before, `${before} -> ${modes.length}`);
  client.close();
}

// ---------------------------------------------------------------- 11) embed 会话重启（超时后自动重开）→ 在途请求必须快速失败
// 浏览器实测：embed 空闲超时后会换 nonce 自动重开；旧会话的 ckx:error 会被新 nonce 校验忽略 → 请求挂到自身 timeoutMs。
{
  let readyCount = 0;
  const env = createFakeEnv({
    embed: {
      onLoad({ fromEmbed }) { readyCount++; fromEmbed({ v: 1, type: 'ckx:ready', formatVersion: '1', nonce: 'sess-' + readyCount, capabilities: ['file'], pro: false }); },
      onMessage(msg, { fromEmbed }) {
        if (msg.type === 'ckx:init') { fromEmbed({ v: 1, type: 'ckx:capabilities', nonce: 'sess-' + readyCount, capabilities: ['file'], pro: false, granted: [], expiresAt: null, source: 'none' }); return; }
        // 故意不回复 ckx:encrypt（模拟用户未操作 → 超时重开）
        if (msg.type === 'ckx:encrypt') {
          setTimeout(() => { readyCount++; fromEmbed({ v: 1, type: 'ckx:ready', formatVersion: '1', nonce: 'sess-' + readyCount, capabilities: ['file'], pro: false }); }, 30);
        }
      },
    },
  });
  const client = createCkxEmbedClient({ win: env.win, doc: env.doc, timeoutMs: 60000 });  // 自身超时很长
  await client.ready();
  await new Promise((r) => setTimeout(r, 20));
  const t0 = Date.now();
  const e = await client.encrypt('x', { medium: 'file' }).then(() => null, (err) => err);
  const ms = Date.now() - t0;
  check('N1 会话重启 → 在途请求以 CKX_EMBED_SESSION_RESTARTED 失败', !!e && e.code === 'CKX_EMBED_SESSION_RESTARTED', e && e.code);
  check('N2 快速失败（未等到自身 60s 超时）', ms < 5000, ms + 'ms');
  check('N3 日志记录 session-restarted', client.getLog().some((l) => l.evt === 'session-restarted'), '');
  check('N4 重启后 nonce 已更新', client.getNonce() === 'sess-' + readyCount, client.getNonce());
  client.close();
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
