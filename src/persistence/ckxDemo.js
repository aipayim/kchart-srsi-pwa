/**
 * CKX 接入自检页（诊断用）—— **不是**正式备份 UI，仅用于验证 iframe 协议与白名单。
 *
 * 一个页面两种角色（由 URL 决定）：
 *  - `ckx-demo.html`            → **宿主角色**：调起 embed 浮层，加/解密示例 vault。
 *  - `ckx-demo.html?embed=mock` → **本地 mock embed**：用 vendored SDK 真实加解密，模拟官方界面
 *                                 （同源 → 无需白名单，供本地 dev 验证宿主接线）。
 *
 * 真实 embed（`https://cryptokey.im/ckx/embed/`）需先把本 origin 注册进白名单，否则会被
 * `frame-ancestors` 拒绝（表现为一直等不到 `ckx:ready`）。
 */
import { createCkxEmbedClient, fetchEmbedPolicy, makeNonce, CKX_EMBED_ORIGIN, CKX_EMBED_URL, CKX_PROTOCOL_V } from './ckxEmbed.js';

const ESC = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function originOf(url) { try { return new URL(url).origin; } catch (_) { return ''; } }
function fmtBytes(n) { return n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`; }

// ============================================================ mock embed 角色
export function mountCkxMockEmbed({ win, doc, ckx }) {
  const parentOrigin = originOf(doc.referrer) || '*';
  const readyNonce = makeNonce();
  let nonce = readyNonce;
  let session = { app: '', mode: 'file', label: '' };
  let staged = null;       // { kind:'encrypt', payload } | { kind:'decrypt', carrier }
  let decrypted = null;    // { text, bytes, meta }
  let busy = false;
  let lastError = null;

  const root = doc.createElement('div');
  root.style.cssText = 'font:13px/1.5 system-ui,sans-serif;color:#dbe6f2;background:#0d141d;min-height:100vh;box-sizing:border-box;padding:14px';
  root.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
      <span style="font-weight:700;color:#7fd1ff">CKX 本地 mock</span>
      <span style="font-size:11px;color:#8fa6bd;border:1px solid #2b3a4d;border-radius:99px;padding:1px 7px">非官方界面</span>
    </div>
    <div style="font-size:11px;color:#8fa6bd;margin-bottom:10px">用 vendored SDK 真实加解密，用于验证宿主接线。真实嵌入需 <code style="color:#b9d4ee">${CKX_EMBED_ORIGIN}</code> 白名单。</div>
    <div id="mk-state" style="font-size:11px;color:#9fb3c8;background:#0a1119;border:1px solid #1d2836;border-radius:8px;padding:8px;margin-bottom:10px;white-space:pre-wrap"></div>
    <label style="display:block;font-size:11px;color:#8fa6bd;margin:0 0 4px">口令（模拟用户在官方界面内输入）</label>
    <input id="mk-pw" type="password" placeholder="口令" style="width:100%;box-sizing:border-box;background:#0a1119;border:1px solid #2b3a4d;color:#e6eef8;border-radius:8px;padding:8px;margin-bottom:10px" />
    <div id="mk-body" style="margin-bottom:10px"></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button id="mk-go" style="flex:1;min-height:38px;border:0;border-radius:8px;background:#1f6feb;color:#fff;font-weight:600;cursor:pointer">处理</button>
      <button id="mk-return" style="flex:1;min-height:38px;border:1px solid #2b3a4d;border-radius:8px;background:#111c28;color:#cfe2f5;cursor:pointer" disabled>送返回宿主</button>
      <button id="mk-cancel" style="min-height:38px;border:1px solid #2b3a4d;border-radius:8px;background:#111c28;color:#cfe2f5;cursor:pointer;padding:0 12px">取消</button>
    </div>
    <div id="mk-msg" style="font-size:11px;color:#ffb4b4;margin-top:8px;white-space:pre-wrap"></div>`;
  doc.body.innerHTML = '';
  doc.body.style.cssText = 'margin:0;background:#0d141d';
  doc.body.appendChild(root);

  const $ = (id) => doc.getElementById(id);
  function post(msg) { try { win.parent.postMessage(msg, parentOrigin); } catch (_) {} }

  function renderState() {
    $('mk-state').textContent = [
      `app:   ${session.app || '（未 init）'}`,
      `mode:  ${session.mode}`,
      `nonce: ${String(nonce).slice(0, 10)}…`,
      `待处理: ${staged ? (staged.kind === 'encrypt' ? `加密 ${fmtBytes(staged.size || 0)}` : `解密 ${fmtBytes(staged.size || 0)}`) : '（无，等待宿主 ckx:encrypt / ckx:decrypt）'}`,
      `capabilities: text,image,file,video · pro=false · source=mock`,
    ].join('\n');
  }

  function renderBody() {
    if (decrypted) {
      const text = decrypted.text != null ? decrypted.text : `（二进制 ${fmtBytes(decrypted.bytes ? decrypted.bytes.length : 0)}）`;
      $('mk-body').innerHTML = `<div style="font-size:11px;color:#8fa6bd;margin-bottom:4px">解密结果（点「送返回宿主」后才会回传）</div><pre style="max-height:180px;overflow:auto;background:#0a1119;border:1px solid #1d2836;border-radius:8px;padding:8px;font-size:11px;white-space:pre-wrap;margin:0">${ESC(text)}</pre>`;
      $('mk-return').disabled = false;
    } else if (staged) {
      $('mk-body').innerHTML = `<div style="font-size:11px;color:#8fa6bd">已收到宿主内容，输入口令后点「处理」。</div>`;
      $('mk-return').disabled = true;
    } else {
      $('mk-body').innerHTML = '';
      $('mk-return').disabled = true;
    }
  }

  win.addEventListener('message', (ev) => {
    if (ev.source !== win.parent) return;
    const d = ev.data;
    if (!d || typeof d !== 'object' || d.v !== CKX_PROTOCOL_V) return;
    if (d.type === 'ckx:init') {
      nonce = d.nonce;
      session = { app: d.app || '', mode: d.mode || 'file', label: d.label || '', schema: d.schema };
      post({ v: 1, type: 'ckx:capabilities', nonce, capabilities: ['text', 'image', 'file', 'video'], pro: false, granted: [], expiresAt: null, source: 'mock' });
      renderState();
      return;
    }
    if (!nonce || d.nonce !== nonce) return;
    if (d.type === 'ckx:encrypt') {
      const payload = d.payload;
      const size = typeof payload === 'string' ? payload.length : (payload && payload.byteLength) || 0;
      staged = { kind: 'encrypt', payload, meta: d.meta, size }; decrypted = null; renderState(); renderBody();
    } else if (d.type === 'ckx:decrypt') {
      const c = d.carrier;
      const size = typeof c === 'string' ? c.length : (c && c.byteLength) || 0;
      staged = { kind: 'decrypt', carrier: c, size }; decrypted = null; renderState(); renderBody();
    } else if (d.type === 'ckx:cancel') {
      staged = null; decrypted = null; renderState(); renderBody();
    }
  });

  $('mk-go').addEventListener('click', async () => {
    if (busy || !staged) return;
    const pw = $('mk-pw').value;
    if (!pw) { $('mk-msg').textContent = '口令不能为空'; return; }
    busy = true; lastError = null; $('mk-msg').textContent = '处理中…';
    try {
      if (staged.kind === 'encrypt') {
        const meta = { app: session.app || 'mock', label: session.label || undefined };
        if (typeof staged.payload === 'string') {
          const text = await ckx.encryptToText(staged.payload, pw, meta);
          $('mk-msg').textContent = '';
          post({ v: 1, type: 'ckx:result', nonce, kind: 'ciphertext', text, meta: { ckx: '1', app: meta.app, label: meta.label } });
        } else {
          const bytes = await ckx.encryptToFile(new Uint8Array(staged.payload), pw, meta);
          $('mk-msg').textContent = '';
          post({ v: 1, type: 'ckx:result', nonce, kind: 'carrier', file: { name: 'mock-vault.ckx', mime: 'application/octet-stream', bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }, meta: { ckx: '1', app: meta.app, label: meta.label } });
        }
      } else {
        const carrier = typeof staged.carrier === 'string' ? staged.carrier : new Uint8Array(staged.carrier);
        const out = await ckx.decrypt(carrier, pw);
        decrypted = { text: out.text, bytes: out.text == null ? out.plaintext : null, meta: out.meta };
        $('mk-msg').textContent = '';
        renderBody();
      }
    } catch (e) {
      lastError = e && e.code ? `${e.code}: ${e.message}` : String(e);
      $('mk-msg').textContent = lastError;
    } finally {
      busy = false;
    }
  });

  $('mk-return').addEventListener('click', () => {
    if (!decrypted) return;
    const msg = { v: 1, type: 'ckx:plaintext', nonce, meta: decrypted.meta || {} };
    if (decrypted.text != null) msg.text = decrypted.text;
    else if (decrypted.bytes) msg.bytes = decrypted.bytes.buffer.slice(decrypted.bytes.byteOffset, decrypted.bytes.byteOffset + decrypted.bytes.byteLength);
    post(msg);
    decrypted = null; renderBody(); renderState();
  });

  $('mk-cancel').addEventListener('click', () => {
    staged = null; decrypted = null; $('mk-msg').textContent = ''; renderState(); renderBody();
    post({ v: 1, type: 'ckx:error', nonce, code: 'CKX_MOCK_CANCELLED', message: 'mock 用户取消' });
  });

  renderState(); renderBody();
  post({ v: 1, type: 'ckx:ready', formatVersion: '1', nonce: readyNonce, capabilities: ['text', 'image', 'file', 'video'], pro: false });
  return { getNonce: () => nonce };
}

// ============================================================ 宿主角色
function download(doc, win, name, bytes, mime) {
  const blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
  const url = win.URL.createObjectURL(blob);
  const a = doc.createElement('a');
  a.href = url; a.download = name;
  doc.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => { try { win.URL.revokeObjectURL(url); } catch (_) {} }, 1500);
}

export function mountCkxDemo({ win, doc }) {
  const origin = win.location.origin;
  const root = doc.createElement('div');
  root.style.cssText = 'font:13px/1.55 system-ui,sans-serif;color:#dbe6f2;background:#0b0f16;min-height:100vh;box-sizing:border-box;padding:16px;max-width:900px;margin:0 auto';
  root.innerHTML = `
    <h1 style="font-size:17px;margin:0 0 4px">CKX iframe embed 自检</h1>
    <p style="font-size:12px;color:#8fa6bd;margin:0 0 14px">诊断页，非正式备份 UI。验证 postMessage 协议 v1 与域名白名单。</p>
    <div style="background:#0d141d;border:1px solid #1d2836;border-radius:10px;padding:12px;margin-bottom:12px">
      <div style="font-size:12px;color:#8fa6bd">宿主 origin</div>
      <div id="dp-origin" style="font-family:ui-monospace,monospace;font-size:12px;margin-bottom:8px"></div>
      <div style="font-size:12px;color:#8fa6bd">真实 embed 白名单状态（GET /v1/ckx/embed/policy）</div>
      <div id="dp-policy" style="font-size:12px;margin-bottom:0">查询中…</div>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
      <label style="font-size:12px;color:#8fa6bd">载体</label>
      <select id="dp-target" style="background:#0a1119;border:1px solid #2b3a4d;color:#e6eef8;border-radius:8px;padding:6px">
        <option value="mock">本地 mock（同源，无需白名单）</option>
        <option value="real">真实 CKX embed（需白名单）</option>
      </select>
      <label style="font-size:12px;color:#8fa6bd">介质</label>
      <select id="dp-medium" style="background:#0a1119;border:1px solid #2b3a4d;color:#e6eef8;border-radius:8px;padding:6px">
        <option value="file">.ckx 文件（SAFE v3，与 SDK 互通）</option>
        <option value="text">密文串（medium A）</option>
      </select>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
      <button id="dp-enc" style="min-height:38px;border:0;border-radius:8px;background:#1f6feb;color:#fff;font-weight:600;cursor:pointer;padding:0 16px">加密示例 vault</button>
      <button id="dp-dec" style="min-height:38px;border:1px solid #2b3a4d;border-radius:8px;background:#111c28;color:#cfe2f5;cursor:pointer;padding:0 16px">解密上面产物</button>
      <label style="min-height:38px;display:inline-flex;align-items:center;gap:6px;border:1px solid #2b3a4d;border-radius:8px;background:#111c28;color:#cfe2f5;cursor:pointer;padding:0 12px">
        <input id="dp-file" type="file" accept=".ckx,application/octet-stream" style="display:none" />选择 .ckx 文件
      </label>
      <button id="dp-clear" style="min-height:38px;border:1px solid #2b3a4d;border-radius:8px;background:#111c28;color:#cfe2f5;cursor:pointer;padding:0 16px">清空</button>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div>
        <div style="font-size:12px;color:#8fa6bd;margin-bottom:4px">结果</div>
        <pre id="dp-out" style="height:260px;overflow:auto;background:#0a1119;border:1px solid #1d2836;border-radius:8px;padding:8px;font-size:11px;white-space:pre-wrap;margin:0"></pre>
      </div>
      <div>
        <div style="font-size:12px;color:#8fa6bd;margin-bottom:4px">状态日志</div>
        <pre id="dp-log" style="height:260px;overflow:auto;background:#0a1119;border:1px solid #1d2836;border-radius:8px;padding:8px;font-size:11px;white-space:pre-wrap;margin:0"></pre>
      </div>
    </div>
    <p style="font-size:11px;color:#7d8fa3;margin-top:12px">提示：真实 embed 未注册白名单时会一直等不到 <code>ckx:ready</code>（浏览器按 <code>frame-ancestors</code> 拒绝加载），属预期。本地 mock 永远可用。</p>`;
  doc.body.innerHTML = '';
  doc.body.style.cssText = 'margin:0;background:#0b0f16';
  doc.body.appendChild(root);
  const $ = (id) => doc.getElementById(id);

  const SAMPLE = {
    schema: 'srsi.vault.v1', schemaVersion: 1, exportedAt: new Date().toISOString(),
    app: { version: 'demo', tag: 'demo' },
    data: { ls: { 'pwa_zoom': '1.25', pwa_tab: 'chart' }, idb: { 'smart-trader-v1': { state: [{ key: 'state.full', value: { bal: 1000 } }] } } },
  };
  let last = null;  // { medium, bytes?|text? }

  $('dp-origin').textContent = origin;
  $('dp-policy').textContent = '查询中…';
  fetchEmbedPolicy(origin).then((p) => {
    $('dp-policy').textContent = p.allowed ? `✅ 已白名单（active）· 公开列表 ${p.origins.length} 项` : `❌ 未白名单（allowed=false）→ 真实 embed 会被拒绝；公开列表: ${JSON.stringify(p.origins)}`;
    $('dp-policy').style.color = p.allowed ? '#6ee7a8' : '#ffb4b4';
  }).catch((e) => { $('dp-policy').textContent = `查询失败：${e.message}（可能是网络/代理）`; });

  function newClient() {
    const target = $('dp-target').value;
    return createCkxEmbedClient({
      win, doc, app: origin,
      mock: target === 'mock',
      medium: $('dp-medium').value,
      label: 'srsi-demo',
      theme: 'dark',
      onLog: null,
    });
  }
  function show(obj) { $('dp-out').textContent = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2); }
  function logLines(client) {
    const lines = (client.getLog() || []).map((l) => `${new Date(l.t).toLocaleTimeString()} ${l.evt}${l.reason ? ' (' + l.reason + ')' : ''}`);
    $('dp-log').textContent = lines.join('\n') || '（无）';
  }
  function timerLog(client) { const t = setInterval(() => { logLines(client); if (client.getState() === 'closed') clearInterval(t); }, 400); return t; }

  $('dp-enc').addEventListener('click', async () => {
    const client = newClient();
    const t = timerLog(client);
    show('加密中…（在弹出的 embed 里输入口令并处理）');
    try {
      const medium = $('dp-medium').value;
      const out = await client.encrypt(JSON.stringify(SAMPLE), { medium });
      logLines(client);
      if (out.medium === 'text') {
        last = { medium: 'text', text: out.text };
        show({ medium: 'text', bytes: out.text.length, meta: out.meta, preview: out.text.slice(0, 120) + '…' });
      } else {
        last = { medium: 'file', bytes: out.bytes };
        download(doc, win, out.name || 'vault.ckx', out.bytes, out.mime);
        show({ medium: 'file', name: out.name, bytes: out.bytes.length, meta: out.meta });
      }
    } catch (e) { show(`❌ ${e.code || e.name}: ${e.message}`); logLines(client); }
    finally { clearInterval(t); client.close(); }
  });

  $('dp-dec').addEventListener('click', async () => {
    if (!last) { show('先加密，或选择 .ckx 文件'); return; }
    const client = newClient();
    const t = timerLog(client);
    show('解密中…（在 embed 里输入同一口令并点「送返回宿主」）');
    try {
      const out = await client.decrypt(last.medium === 'text' ? last.text : last.bytes, { carrierName: 'vault.ckx' });
      logLines(client);
      show({ text: out.text, meta: out.meta });
    } catch (e) { show(`❌ ${e.code || e.name}: ${e.message}`); logLines(client); }
    finally { clearInterval(t); client.close(); }
  });

  $('dp-file').addEventListener('change', async (ev) => {
    const f = ev.target.files && ev.target.files[0];
    if (!f) return;
    last = { medium: 'file', bytes: new Uint8Array(await f.arrayBuffer()) };
    show(`已载入 ${f.name}（${fmtBytes(last.bytes.length)}）→ 点「解密上面产物」`);
  });

  $('dp-clear').addEventListener('click', () => { last = null; show('（已清空）'); $('dp-log').textContent = ''; });
  show('（就绪）');
}

/** 入口：按 URL 决定角色。 */
export function bootCkxDemo({ win, doc, ckx }) {
  const params = new win.URLSearchParams(win.location.search);
  if (params.get('embed') === 'mock') { mountCkxMockEmbed({ win, doc, ckx }); return 'mock'; }
  mountCkxDemo({ win, doc, ckx });
  return 'host';
}

export { CKX_EMBED_URL, CKX_EMBED_ORIGIN };
