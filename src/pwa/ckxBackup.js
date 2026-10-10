/**
 * PWA 设置页 · 🔐 加密备份 / 恢复（CKX）面板
 *
 * 两种加密方式**平级并列**（用户裁定）：
 *  - 🔒 本机加密：vendored SDK（离线、口令在本地输入）→ 产物 `.ckx` / 密文串
 *  - 🌐 CKX 在线：官方 embed 浮层（口令在官方界面输入，宿主看不到）→ 同一 `.ckx` 容器
 *
 * 范围：全量业务数据；**凭证默认排除**（勾选需二次确认）。
 * 导入：先**解密预览**（dry-run），再选「覆盖 / 合并」应用。
 * 本机保留**最近 5 个加密备份**（免密码清单，可重下载/删除）。
 *
 * 安全：不写日志、不落盘明文/口令；口令只在内存中短暂存在，导出后立即清空输入框。
 */
import {
  collectVault, exportVaultBytes, inspectVault, importVault, applyVault,
  vaultSummary, vaultFilename, CKX_SDK,
} from '../persistence/ckxVault.js';

// embed 客户端懒加载（仅当用户选「CKX 在线」时才拉取该 chunk；不进首屏预加载）
// mock 模式（开发/自测，`window.__ckxEmbedMock=true`）固定指向自包含演示页的 embed 角色。
async function embedClient(cfg) {
  const m = await import('../persistence/ckxEmbed.js');
  return m.createCkxEmbedClient(cfg);
}
function embedCfg(opts, medium) {
  const mock = !!opts.mock;
  return Object.assign({ medium, label: 'srsi-backup' }, opts.embedCfg || {}, mock ? { mock: true, mockUrl: opts.mockUrl || './ckx-demo.html?embed=mock' } : {});
}

export const BACKUP_DB = 'smartTraderCKX';
export const BACKUP_STORE = 'backups';
export const BACKUP_MAX = 5;

// ---------------------------------------------------------------- 纯函数
export function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + ' B';
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
  return (v / 1024 / 1024).toFixed(2) + ' MB';
}
export function mediumLabel(m) { return m === 'text' ? '密文串' : '.ckx 文件'; }
export function methodLabel(m) { return m === 'embed' ? 'CKX 在线' : '本机加密'; }
export function fmtTime(t) {
  try { return new Date(t).toLocaleString(); } catch (_) { return String(t || ''); }
}

/** 保留最近 N 个备份（按时间倒序），纯函数。 */
export function trimBackups(items, max = BACKUP_MAX) {
  const arr = Array.isArray(items) ? items.slice() : [];
  arr.sort((a, b) => (b.t || 0) - (a.t || 0));
  return arr.slice(0, max);
}

/** 从 vault 摘要生成「将备份什么」几行文本（纯函数）。 */
export function planLines(sum) {
  if (!sum) return ['（无法读取本机数据）'];
  const idbParts = Object.entries(sum.idbDetail || {}).map(([k, n]) => `${k} ×${n}`);
  return [
    `localStorage：${sum.lsCount} 个键`,
    `IndexedDB：${sum.idbRecords} 条记录${idbParts.length ? '（' + idbParts.join('、') + '）' : ''}`,
    '不包含：SRSI 优选历史 / 回测缓存（可重建）；凭证默认排除',
  ];
}

/** 最近备份列表行（纯函数，可单测）。 */
export function backupRowsHtml(items, opts = {}) {
  const list = trimBackups(items);
  if (!list.length) return '<div class="pwa-empty">暂无本机备份 · 导出后会自动保留最近 ' + BACKUP_MAX + ' 个</div>';
  return list.map((it) => {
    const id = esc(it.id);
    return '<div class="ckx-row" data-id="' + id + '">' +
      '<span class="ckx-row-t">' + esc(fmtTime(it.t)) + '</span>' +
      '<span class="ckx-row-m">' + esc(mediumLabel(it.medium)) + ' · ' + esc(fmtBytes(it.size)) +
        (it.hasSecrets ? ' · <b style="color:#f59e0b">含凭证</b>' : '') + '</span>' +
      (opts.canDownload === false ? '' : '<button type="button" class="ckx-row-b" data-act="dl" data-id="' + id + '">下载</button>') +
      '<button type="button" class="ckx-row-b ckx-del" data-act="del" data-id="' + id + '">删除</button>' +
      '</div>';
  }).join('');
}

/** 解密预览块（纯函数）。 */
export function previewHtml(sum, meta, opts = {}) {
  if (!sum) return '';
  const sec = sum.hasSecrets ? '<b style="color:#f59e0b">含凭证（API Key / Jev Token）</b>' : '不含凭证';
  return '<div class="ckx-prev">' +
    '<div><b style="color:#2ecc71">✓ 校验通过</b> · schema <code>' + esc(sum.schema) + '</code> v' + esc(sum.schemaVersion) + '</div>' +
    '<div>导出时间：' + esc(String(sum.exportedAt || '—')) + ' · 应用版本：' + esc((sum.app && sum.app.version) || '—') + '</div>' +
    '<div>localStorage ' + esc(sum.lsCount) + ' 键 · IndexedDB ' + esc(sum.idbRecords) + ' 条 · ' + sec + '</div>' +
    (meta && meta.label ? '<div>标签：' + esc(meta.label) + (meta.createdAt ? ' @ ' + esc(meta.createdAt) : '') + '</div>' : '') +
    '</div>';
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------- 备份存储（IndexedDB，可注入）
function defaultIdb() {
  if (typeof indexedDB === 'undefined' || !indexedDB) return null;
  function open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(BACKUP_DB, 1);
      r.onupgradeneeded = (e) => { const d = e.target.result; if (!d.objectStoreNames.contains(BACKUP_STORE)) d.createObjectStore(BACKUP_STORE, { keyPath: 'id' }); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  function run(mode, fn) {
    return open().then((db) => new Promise((res, rej) => {
      const t = db.transaction(BACKUP_STORE, mode);
      const s = t.objectStore(BACKUP_STORE);
      let out;
      try { out = fn(s, res, rej); } catch (e) { rej(e); return; }
      t.oncomplete = () => { try { db.close(); } catch (_) {} res(out); };
      t.onerror = () => { try { db.close(); } catch (_) {} rej(t.error); };
    }));
  }
  return {
    async list() { return (await run('readonly', (s, res) => { const q = s.getAll(); q.onsuccess = () => res(q.result || []); })) || []; },
    async put(rec) { await run('readwrite', (s) => { s.put(rec); }); },
    async del(id) { await run('readwrite', (s) => { s.delete(id); }); },
    async clear() { await run('readwrite', (s) => { s.clear(); }); },
  };
}

let _idb = null;
function store(deps) { return deps && (deps.backupStore || deps.idbStore) ? (deps.backupStore || deps.idbStore) : (_idb || (_idb = defaultIdb())); }

/** 读取本机备份清单（已裁剪到 BACKUP_MAX）。 */
export async function listBackups(deps) {
  const s = store(deps);
  if (!s) return [];
  try { return trimBackups(await s.list()); } catch (_) { return []; }
}
/** 保存一个备份（自动裁剪最旧）。 */
export async function saveBackup(rec, deps) {
  const s = store(deps);
  if (!s) return false;
  try {
    await s.put(rec);
    const all = await s.list();
    const keep = trimBackups(all);
    const keepIds = new Set(keep.map((x) => x.id));
    for (const it of all) if (!keepIds.has(it.id)) { try { await s.del(it.id); } catch (_) {} }
    return true;
  } catch (_) { return false; }
}
export async function deleteBackup(id, deps) { const s = store(deps); if (!s) return false; try { await s.del(id); return true; } catch (_) { return false; } }
export async function clearBackups(deps) { const s = store(deps); if (!s) return false; try { await s.clear(); return true; } catch (_) { return false; } }

// ---------------------------------------------------------------- 导出 / 导入
/**
 * 导出保险箱。method='local' 用 SDK；method='embed' 用官方浮层（口令在 embed 内输入，hostPw 忽略）。
 * @returns {Promise<{medium,bytes?,text?,meta,summary,filename}>}
 */
export async function exportBackup(opts = {}, deps = {}) {
  const method = opts.method === 'embed' ? 'embed' : 'local';
  const medium = opts.medium === 'text' ? 'text' : 'file';
  const vault = await collectVault({ includeSecrets: !!opts.includeSecrets }, deps);
  const filename = vaultFilename();
  if (method === 'embed') {
    const client = await embedClient(embedCfg(opts, medium));
    try {
      const out = await client.encrypt(JSON.stringify(vault), { medium });
      const meta = out.meta || {};
      const hasSecrets = Object.prototype.hasOwnProperty.call(vault, 'secrets');
      if (medium === 'text') return { medium, text: out.text, meta, summary: vaultSummary(vault), filename: filename.replace(/\.ckx$/, '.ckx.txt'), hasSecrets };
      return { medium, bytes: out.bytes, meta, summary: vaultSummary(vault), filename: out.name || filename, hasSecrets };
    } finally { try { client.close(); } catch (_) {} }
  }
  const bytes = await exportVaultBytes(vault, opts.password, { label: 'srsi-backup' }, deps);
  const insp = await inspectVault(bytes, deps);
  if (medium === 'text') {
    return { medium: 'text', text: toBase64Url(bytes), meta: insp.meta || {}, summary: vaultSummary(vault), filename: filename.replace(/\.ckx$/, '.ckx.txt'), hasSecrets: Object.prototype.hasOwnProperty.call(vault, 'secrets'), bytes };
  }
  return { medium: 'file', bytes, meta: insp.meta || {}, summary: vaultSummary(vault), filename, hasSecrets: Object.prototype.hasOwnProperty.call(vault, 'secrets') };
}

/** 解密预览（dry-run）。method='embed' 时口令在官方界面输入。 */
export async function previewBackup(carrier, opts = {}, deps = {}) {
  if (opts.method === 'embed') {
    const client = await embedClient(embedCfg(opts, opts.medium || 'file'));
    try {
      const out = await client.decrypt(carrier, { carrierName: opts.carrierName || 'vault.ckx' });
      const text = out.text != null ? out.text : new TextDecoder().decode(out.bytes || new Uint8Array());
      const vault = parseJsonVault(text);
      return { vault, summary: vaultSummary(vault), meta: out.meta || {}, medium: opts.medium || 'file' };
    } finally { try { client.close(); } catch (_) {} }
  }
  return await importVault(carrier, opts.password, {}, deps);
}

function parseJsonVault(text) {
  const v = JSON.parse(text);
  if (!v || v.schema !== 'srsi.vault.v1') { const e = new Error('schemaId 不匹配'); e.code = 'VAULT_SCHEMA_MISMATCH'; throw e; }
  return v;
}

/** 应用预览（写回本机）。 */
export async function applyBackup(preview, opts = {}, deps = {}) {
  return await applyVault(preview, { mode: opts.mode === 'merge' ? 'merge' : 'overwrite' }, deps);
}

function toBase64Url(u8) {
  let bin = '';
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------------------------------------------------------------- DOM（PWA 设置页卡）
let _items = null;          // 备份清单缓存
let _pending = null;        // 待应用的预览
let _busy = false;

function $(id) { return typeof document !== 'undefined' ? document.getElementById(id) : null; }
function msg(text, color) { const m = $('pwaCkxMsg'); if (m) { m.textContent = text || ''; m.style.color = color || 'var(--text2)'; } }
function impMsg(text, color) { const m = $('pwaCkxImpMsg'); if (m) { m.textContent = text || ''; m.style.color = color || 'var(--text2)'; } }

/**
 * 信任条（纯函数，可单测）：明确「加解密由 CKX 官方执行」+ 可验证的版本/哈希 + 官方 Verified 徽章。
 * 外链徽章加载失败不影响功能（仅缺图）。
 */
export function ckxTrustHtml() {
  const short = String(CKX_SDK.esmSha384 || '').replace('sha384-', '').slice(0, 12);
  return '<div class="ckx-trust">' +
    '<img class="ckx-badge" src="' + esc(CKX_SDK.badgeUrl) + '" alt="CKX Verified Integrator" title="CKX 已验证合作方（cryptokey.im）" loading="lazy" referrerpolicy="no-referrer" width="120" height="30">' +
    '<div class="ckx-trust-t">加解密<b>全部由 CKX（cryptokey.im）执行</b>，本产品不自行实现密码学。<br>' +
      '本机加密用官方 SDK <code>' + esc(CKX_SDK.version) + '</code> · <code>sha384-' + esc(short) + '…</code> · ' +
      '<a href="' + esc(CKX_SDK.manifestUrl) + '" target="_blank" rel="noopener noreferrer">官方清单</a> · ' +
      '<a href="' + esc(CKX_SDK.registryUrl) + '" target="_blank" rel="noopener noreferrer">公开注册表</a>' +
    '</div></div>';
}

export function ckxCardHtml() {
  return ckxTrustHtml() +
    '<div class="ckx-sec">' +
      '<div id="pwaCkxPlan" class="ckx-plan">读取本机数据…</div>' +
      '<div class="setting-row" style="flex-wrap:wrap;gap:8px">' +
        '<label>介质</label><select id="pwaCkxMedium"><option value="file">.ckx 文件（推荐）</option><option value="text">密文串（可复制）</option></select>' +
        '<label class="ckx-chk"><input type="checkbox" id="pwaCkxSecrets"> 包含凭证（API Key / Jev Token）</label>' +
      '</div>' +
      '<div class="setting-row"><label>口令</label><input id="pwaCkxPw" type="password" autocomplete="new-password" placeholder="设置一个强口令（无找回）" style="flex:1;min-width:120px">' +
        '<input id="pwaCkxPw2" type="password" autocomplete="new-password" placeholder="再输一次" style="flex:1;min-width:120px"></div>' +
      '<div class="setting-row" style="flex-wrap:wrap;gap:6px">' +
        '<button id="pwaCkxExpLocal" class="ckx-primary">🔒 本机加密导出</button>' +
        '<button id="pwaCkxExpEmbed">🌐 CKX 在线导出</button>' +
        '<button id="pwaCkxRefreshPlan">刷新概览</button>' +
      '</div>' +
      '<div id="pwaCkxMsg" class="ckx-hint"></div>' +
      '<div class="ckx-hint">口令即一切：CKX 无服务端、<b>无法找回</b>。图片/视频载体易损坏，推荐 .ckx 文件。</div>' +
    '</div>' +
    '<div class="ckx-sec">' +
      '<div class="ckx-sub">恢复</div>' +
      '<div class="setting-row" style="flex-wrap:wrap;gap:6px">' +
        '<input id="pwaCkxFile" type="file" accept=".ckx,application/octet-stream" style="max-width:200px">' +
        '<input id="pwaCkxPaste" type="text" placeholder="或粘贴密文串" style="flex:1;min-width:140px">' +
        '<button id="pwaCkxClearIn">清空</button>' +
      '</div>' +
      '<div class="setting-row"><label>口令</label><input id="pwaCkxImpPw" type="password" autocomplete="off" style="flex:1;min-width:120px">' +
        '<button id="pwaCkxPrevLocal" class="ckx-primary">🔓 本机解密预览</button>' +
        '<button id="pwaCkxPrevEmbed">🌐 CKX 在线解密</button></div>' +
      '<div id="pwaCkxPrev"></div>' +
      '<div id="pwaCkxImpMsg" class="ckx-hint"></div>' +
    '</div>' +
    '<div class="ckx-sec">' +
      '<div class="ckx-sub">最近备份（免密码） <button id="pwaCkxClearAll" class="ckx-tiny">清空</button></div>' +
      '<div id="pwaCkxList"></div>' +
    '</div>';
}

function renderList() {
  const box = $('pwaCkxList');
  if (!box) return;
  const html = backupRowsHtml(_items || []);
  if (box.__sig !== html) { box.__sig = html; box.innerHTML = html; }
}

async function refreshList() { _items = await listBackups(); renderList(); }

async function renderPlan() {
  const box = $('pwaCkxPlan');
  if (!box) return;
  box.textContent = '读取本机数据…';
  try {
    const vault = await collectVault({ includeSecrets: false });
    box.innerHTML = '<div class="ckx-sub">将备份</div>' + planLines(vaultSummary(vault)).map((l) => '<div>' + esc(l) + '</div>').join('');
  } catch (e) {
    box.textContent = '读取失败：' + (e && e.message ? e.message : e);
  }
}

function download(name, bytes, text) {
  const blob = text != null ? new Blob([text], { type: 'text/plain;charset=utf-8' }) : new Blob([bytes], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 1500);
}

function readPw() {
  const a = $('pwaCkxPw'); const b = $('pwaCkxPw2');
  const pw = a ? a.value : '';
  const pw2 = b ? b.value : '';
  return { pw, pw2 };
}
function wipePw() { const a = $('pwaCkxPw'); const b = $('pwaCkxPw2'); if (a) a.value = ''; if (b) b.value = ''; }

async function doExport(method) {
  if (_busy) return;
  const medium = ($('pwaCkxMedium') && $('pwaCkxMedium').value) || 'file';
  const includeSecrets = !!($('pwaCkxSecrets') && $('pwaCkxSecrets').checked);
  const { pw, pw2 } = readPw();
  if (method === 'local') {
    if (!pw) { msg('请先输入口令', '#ff8a8a'); return; }
    if (pw !== pw2) { msg('两次口令不一致', '#ff8a8a'); return; }
    if (pw.length < 8) { msg('口令太短（建议 ≥ 8 位）', '#f59e0b'); return; }
  }
  _busy = true;
  msg(method === 'embed' ? '已打开 CKX 在线界面，请在浮层内输入口令并处理…' : '加密中…');
  try {
    const out = await exportBackup({ method, medium, includeSecrets, password: pw, mock: !!globalThis.__ckxEmbedMock });
    const rec = {
      id: 'bk-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      t: Date.now(), medium: out.medium, size: out.medium === 'text' ? (out.text || '').length : (out.bytes ? out.bytes.length : 0),
      hasSecrets: !!out.hasSecrets, meta: out.meta || {},
      label: out.filename,
      text: out.medium === 'text' ? out.text : null,
      bytes: out.medium === 'file' && out.bytes ? out.bytes.buffer.slice(out.bytes.byteOffset, out.bytes.byteOffset + out.bytes.byteLength) : null,
    };
    const saved = await saveBackup(rec);
    if (out.medium === 'text') { try { await navigator.clipboard.writeText(out.text); } catch (_) {} download(out.filename, null, out.text); }
    else download(out.filename, out.bytes, null);
    wipePw();
    await refreshList();
    msg('✅ 导出完成：' + mediumLabel(out.medium) + ' ' + fmtBytes(rec.size) + (saved ? '（已保留在本机备份清单）' : '（本机清单写入失败）'), '#2ecc71');
  } catch (e) {
    msg('❌ ' + (e && e.code ? e.code + ': ' : '') + (e && e.message ? e.message : e), '#ff8a8a');
  } finally { _busy = false; }
}

async function readCarrier() {
  const fileEl = $('pwaCkxFile');
  const pasted = ($('pwaCkxPaste') && $('pwaCkxPaste').value.trim()) || '';
  if (fileEl && fileEl.files && fileEl.files[0]) return { carrier: new Uint8Array(await fileEl.files[0].arrayBuffer()), name: fileEl.files[0].name };
  if (pasted) return { carrier: pasted, name: 'pasted.txt' };
  return null;
}

async function doPreview(method) {
  if (_busy) return;
  const got = await readCarrier();
  if (!got) { impMsg('请选择 .ckx 文件或粘贴密文串', '#ff8a8a'); return; }
  const pw = ($('pwaCkxImpPw') && $('pwaCkxImpPw').value) || '';
  if (method === 'local' && !pw) { impMsg('请输入口令', '#ff8a8a'); return; }
  _busy = true;
  impMsg(method === 'embed' ? '已打开 CKX 在线界面，请在浮层内输入口令并处理…' : '解密中…');
  try {
    const prev = await previewBackup(got.carrier, { method, password: pw, carrierName: got.name, mock: !!globalThis.__ckxEmbedMock });
    _pending = prev;
    const box = $('pwaCkxPrev');
    if (box) box.innerHTML = previewHtml(prev.summary, prev.meta) +
      '<div class="setting-row" style="margin-top:4px;flex-wrap:wrap;gap:8px">' +
        '<label class="ckx-chk"><input type="radio" name="pwaCkxMode" value="overwrite" checked> 覆盖（先清空本机再写入）</label>' +
        '<label class="ckx-chk"><input type="radio" name="pwaCkxMode" value="merge"> 合并（保留本机现有）</label>' +
        '<button id="pwaCkxApply" class="ckx-primary">应用恢复</button>' +
      '</div>';
    bindApply();
    const inp = $('pwaCkxImpPw'); if (inp) inp.value = '';
    impMsg('预览完成（未写入）。确认后点「应用恢复」。', '#2ecc71');
  } catch (e) {
    _pending = null;
    const box = $('pwaCkxPrev'); if (box) box.innerHTML = '';
    impMsg('❌ ' + (e && e.code ? e.code + ': ' : '') + (e && e.message ? e.message : e), '#ff8a8a');
  } finally { _busy = false; }
}

function bindApply() {
  const btn = $('pwaCkxApply');
  if (!btn || btn.__bound) return;
  btn.__bound = true;
  btn.addEventListener('click', async () => {
    if (!_pending || _busy) return;
    const sel = document.querySelector('input[name="pwaCkxMode"]:checked');
    const mode = sel ? sel.value : 'overwrite';
    if (mode === 'overwrite' && typeof confirm === 'function' && !confirm('覆盖恢复会先清空本机现有配置/账户/交易记录，再写入备份内容。继续？')) return;
    _busy = true; impMsg('写入中…');
    try {
      const r = await applyBackup(_pending, { mode });
      impMsg('✅ 恢复完成：localStorage ' + r.ls + ' 键 · IndexedDB ' + r.idb + ' 条' + (r.secretIdb ? ' · 凭证 ' + r.secretIdb + ' 条' : '') + '。请刷新页面生效。', '#2ecc71');
      _pending = null;
      const box = $('pwaCkxPrev'); if (box) box.innerHTML = '';
      await refreshList();
    } catch (e) { impMsg('❌ 写入失败：' + (e && e.message ? e.message : e), '#ff8a8a'); }
    finally { _busy = false; }
  });
}

export function bindCkxBackup() {
  const body = $('pwaCkxBody');
  if (!body) return;
  const on = (id, fn) => { const el = $(id); if (el && !el.__bound) { el.__bound = true; el.addEventListener('click', fn); } };
  on('pwaCkxExpLocal', () => doExport('local'));
  on('pwaCkxExpEmbed', () => doExport('embed'));
  on('pwaCkxRefreshPlan', () => { renderPlan(); });
  on('pwaCkxPrevLocal', () => doPreview('local'));
  on('pwaCkxPrevEmbed', () => doPreview('embed'));
  on('pwaCkxClearIn', () => { const f = $('pwaCkxFile'); if (f) f.value = ''; const p = $('pwaCkxPaste'); if (p) p.value = ''; const ip = $('pwaCkxImpPw'); if (ip) ip.value = ''; const b = $('pwaCkxPrev'); if (b) b.innerHTML = ''; impMsg(''); _pending = null; });
  on('pwaCkxClearAll', async () => { if (typeof confirm === 'function' && !confirm('删除本机保留的全部加密备份？（不影响本机配置/账户）')) return; await clearBackups(); await refreshList(); msg('已清空本机备份清单'); });
  const sec = $('pwaCkxSecrets');
  if (sec && !sec.__bound) {
    sec.__bound = true;
    sec.addEventListener('change', () => {
      if (sec.checked && typeof confirm === 'function' && !confirm('包含凭证会把 API Key / Jev Token 一起加密进备份。\n用弱口令等于泄露；丢失口令则永久无法恢复。确定包含？')) sec.checked = false;
    });
  }
  const list = $('pwaCkxList');
  if (list && !list.__bound) {
    list.__bound = true;
    list.addEventListener('click', async (ev) => {
      const b = ev.target && ev.target.closest ? ev.target.closest('button[data-act]') : null;
      if (!b) return;
      const id = b.getAttribute('data-id');
      const it = (_items || []).find((x) => x.id === id);
      if (!it) return;
      if (b.getAttribute('data-act') === 'del') { await deleteBackup(id); await refreshList(); msg('已删除该备份'); return; }
      if (it.text) download(it.label || 'vault.ckx.txt', null, it.text);
      else if (it.bytes) download(it.label || 'vault.ckx', new Uint8Array(it.bytes), null);
      else msg('该备份无内容（可能已被浏览器清理）', '#f59e0b');
    });
  }
}

/** 设置页卡渲染入口（幂等；每秒刷新只更新列表）。 */
export function renderCkxBackup() {
  const body = $('pwaCkxBody');
  if (!body) return;
  if (!body.__built) {
    body.__built = true;
    body.innerHTML = ckxCardHtml();
    bindCkxBackup();
    renderPlan();
    refreshList();
    return;
  }
  renderList();
}
