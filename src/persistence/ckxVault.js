/**
 * CKX 加密保险箱（阶段 1 适配层）—— 用 cryptokey.im 的 CKX v1 容器做**加密全量备份/恢复**
 *
 * 设计要点（见 notebook 页 `ckx-integration`）：
 *  - **纯逻辑、无 DOM 依赖**：存储通过可注入适配器访问 → 可在 Node 直接 import 单测。
 *  - **按需懒加载 SDK**：动态 `import()` vendored `@cryptokey/ckx`（Vite 会代码分割，不进首屏）。
 *  - **凭证默认排除**：`includeSecrets:true` 才把 `crypto.deviceKey` / `crypto.apiKeys`（含 Jev Token）
 *    放进 `secrets`，其余业务数据一律进 `data`。
 *  - **可重建的派生键默认排除**：`srsiOptHist:*`、`smartTrader_kchart_bt*`（历史行情/回测缓存，
 *    体积大且可重算；见 AGENTS §5.30 localStorage 配额红线）。
 *  - **安全**：不写日志、不落盘明文/口令；解密所得的 plaintext 字节在用后清零；
 *    CKX meta **不加密** → 只放 schemaId/版本/时间等非敏感字段。
 *  - **两段式导入**：`importVault` 只解密 + 校验 + 返回 **dry-run 预览**；`applyVault` 才写回，
 *    且支持 `overwrite`（清空后写入）/ `merge`（仅覆盖同键）。
 *
 * 容器格式：介质 D `.ckx`（SAFE v3 原字节），推荐默认；介质 A/B/E 为可选载体。
 */
import { APP_VERSION, APP_TAG } from '../version.generated.js';

// ---------------------------------------------------------------- 常量
export const VAULT_SCHEMA_ID = 'srsi.vault.v1';
export const VAULT_SCHEMA_VERSION = 1;
export const VAULT_APP_ID = 'https://srsi.openapi.im';
export const VAULT_CAPS = ['text', 'file'];

/**
 * vendored CKX SDK 的「发布身份」（供 UI 展示可验证信息 + 被 `scripts/verify-ckx-sdk.mjs` 交叉校验，
 * 单一定义处；任何漂移都会让 `npm test` 失败）。
 */
export const CKX_SDK = {
  version: '0.6.0',
  esmBytes: 38339,
  esmSha384: 'sha384-MX/J65JF+GfT+z5z9bUqU8GSad4QIQRkh4ahqNERSuvshVdzg1LXpJUqypvA+1F0',
  manifestUrl: 'https://cryptokey.im/ckx/sdk/MANIFEST.json',
  /** 0.6.0 起提供**版本化不可变**包（同版本重发布问题已由官方修复，见反馈 N-2） */
  zipUrl: 'https://cryptokey.im/ckx/sdk/ckx-sdk-0.6.0.zip',
  releaseUrl: 'https://cryptokey.im/v1/ckx/release',
  badgeUrl: 'https://cryptokey.im/badge/ckx-verified.svg',
  registryUrl: 'https://cryptokey.im/registry',
  sri: 'sha384-MX/J65JF+GfT+z5z9bUqU8GSad4QIQRkh4ahqNERSuvshVdzg1LXpJUqypvA+1F0',
};

export const VAULT_CODES = {
  SCHEMA_MISMATCH: 'VAULT_SCHEMA_MISMATCH',
  VERSION_UNSUPPORTED: 'VAULT_VERSION_UNSUPPORTED',
  BAD_PAYLOAD: 'VAULT_BAD_PAYLOAD',
  NO_STORAGE: 'VAULT_NO_STORAGE',
  BAD_PASSWORD: 'VAULT_BAD_PASSWORD',
};

export class VaultError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'VaultError';
    this.code = code;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------- 备份范围清单（白名单）
/** 显式纳入的 localStorage 键（用户配置 / 账户 / 已学权重 / 事件历史）。 */
export const LS_INCLUDE_EXACT = [
  // 主系统
  'smartTrader',
  'smartTrader_kchart',
  'smartTrader_syms',
  'smartTrader_fusionOrder',
  'smartTrader_cockpitEvents',
  'smartTrader_cockpitNotif',
  'smartTrader_cockpitOpen',
  'smartTrader_ruleMonitor',
  'smartTrader_rv',
  'smartTrader_kchart_marks',
  'smartTrader_jevAudit',
  // PWA
  'pwa_srsi_opt',
  'pwa_srsi_auto',
  'pwa_paper_state',
  'pwa_sim_settings',
  'pwa_signal_events',
  'pwa_signal_sounds',
  'pwa_adaptive_portfolio',
  'pwa_adaptive_hist',
  'pwa_adaptive_symbols',
  'pwa_tsev_ver',
  'pwa_jev',
  'pwa_alpha_paper',
  'pwa_alpha_live',
  'pwa_alpha_open',
  'pwa_last_sym',
  'pwa_syms',
  'pwa_binance_proxy',
  'pwa_zoom',
  'pwa_tab',
  'pwa_motion',
  'pwa_fs_info',
  'pwa_trade_on',
  'pwa_trade_panel_touched',
  'pwa_install_dismissed',
  'pwa_bt_body_touched',
  'pwa_snd_open',
  'pwa_tool_more',
  'pwa_sub_default',
  'pwa_disc_default',
  'pwa_cockpit_acc',
  'pwa_jev_scalp_open',
  'pwa_jev_all_open',
  'pwa_kpi_collapsed',
  'pwa_tool_collapsed',
  'pwa_alert_sound',
  'pwa_alert_toast',
];

/** 前缀纳入（动态生成的 UI 记忆键）。 */
export const LS_INCLUDE_PREFIX = ['pwa_acc_', 'pwa_set_'];

/** 精确排除：可重建的派生缓存 / 设备本地标记 / 探针键。 */
export const LS_EXCLUDE_EXACT = [
  'kchartVer',                 // 版本门标记（设备本地）
  'pwa_ep_pref',               // Binance 端点记忆（随地域/网络变化，设备本地）
  '__st_probe__',              // 存储自检探针
  'smartTrader_kchart_bt',     // 回测结果缓存（可重算）
  'smartTrader_kchart_bt_raw', // 回测原始 K 线（可重拉）
  'smartTrader_kchart_bt_fund',// 回测资金费（可重拉）
  'smartTrader_kchart_bt_cfg', // 回测参数缓存（可重算）
];

/** 前缀排除：巨型派生历史（首选 SRSI 参数优选所用的 K 线快照）。 */
export const LS_EXCLUDE_PREFIX = ['srsiOptHist:'];

/** 需要备份的 IndexedDB 库 / store。 */
export const IDB_PLAN = [
  { db: 'smart-trader-v1', stores: ['events', 'state', 'candles', 'trades', 'reconcile'] },
  { db: 'kchart_jev', stores: ['decisions', 'srsiPairs'] },
  { db: 'smartTraderRM', stores: ['ruleSignals'] },
  { db: 'kchart_pwa', stores: ['disc'] },        // TSEV 已学权重 + 本地因子样本（localLoop）
  { db: 'smartTraderAP', stores: ['events'] },   // 自适应组合事件流
];

/** 无 keyPath（out-of-line key）的 store 的记录包封字段：必须连 key 一起备份，否则恢复丢 key。 */
export const KEYLESS_WRAP = { key: '__ckxKey', value: '__ckxValue' };

/** 凭证所在的 IDB 记录键（默认不进 `data`，仅 `includeSecrets` 时进 `secrets`）。 */
export const SECRET_IDB = {
  'smart-trader-v1': { state: ['crypto.deviceKey', 'crypto.apiKeys'] },
};

// ---------------------------------------------------------------- 键筛选
export function isVaultLsKey(key) {
  if (typeof key !== 'string' || !key) return false;
  for (const p of LS_EXCLUDE_PREFIX) if (key.startsWith(p)) return false;
  if (LS_EXCLUDE_EXACT.includes(key)) return false;
  if (LS_INCLUDE_EXACT.includes(key)) return true;
  for (const p of LS_INCLUDE_PREFIX) if (key.startsWith(p)) return true;
  return false;
}

// ---------------------------------------------------------------- 存储适配器
function defaultLsAdapter() {
  if (typeof localStorage === 'undefined' || !localStorage) return null;
  return {
    keys() {
      const a = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k) a.push(k);
      }
      return a;
    },
    get(k) { return localStorage.getItem(k); },
    set(k, v) { localStorage.setItem(k, v); },
    remove(k) { localStorage.removeItem(k); },
  };
}

function defaultIdbAdapter() {
  if (typeof indexedDB === 'undefined' || !indexedDB) return null;
  function open(name) {
    return new Promise((res, rej) => {
      const r = indexedDB.open(name);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  function withStore(dbName, storeName, mode, fn) {
    return open(dbName).then((db) => {
      try {
        if (!db.objectStoreNames.contains(storeName)) return Promise.resolve({ missing: true });
        const t = db.transaction(storeName, mode);
        const s = t.objectStore(storeName);
        return fn(s).then((out) => { db.close(); return out; }, (e) => { db.close(); throw e; });
      } catch (e) {
        try { db.close(); } catch (_) {}
        throw e;
      }
    });
  }
  return {
    async list(dbName, storeName) {
      // 用游标而非 getAll：**无 keyPath 的 store 必须连 key 一起取出**（否则恢复时丢 key）
      const r = await withStore(dbName, storeName, 'readonly', (s) => new Promise((res, rej) => {
        const keyless = s.keyPath == null;
        const out = [];
        const q = s.openCursor();
        q.onsuccess = () => {
          const c = q.result;
          if (!c) return res(out);
          out.push(keyless ? { [KEYLESS_WRAP.key]: c.key, [KEYLESS_WRAP.value]: c.value } : c.value);
          c.continue();
        };
        q.onerror = () => rej(q.error);
      }));
      return r && r.missing ? [] : r;
    },
    async put(dbName, storeName, rec) {
      const r = await withStore(dbName, storeName, 'readwrite', (s) => new Promise((res, rej) => {
        let q;
        const wrapped = rec && typeof rec === 'object' && KEYLESS_WRAP.key in rec && KEYLESS_WRAP.value in rec;
        if (wrapped) q = s.put(rec[KEYLESS_WRAP.value], rec[KEYLESS_WRAP.key]);   // 无 keyPath：显式 key
        else q = s.put(rec);
        q.onsuccess = () => res(true);
        q.onerror = () => rej(q.error);
      }));
      if (r && r.missing) throw new VaultError(VAULT_CODES.NO_STORAGE, `IndexedDB store 不存在: ${dbName}/${storeName}`);
      return true;
    },
    async clear(dbName, storeName) {
      const r = await withStore(dbName, storeName, 'readwrite', (s) => new Promise((res, rej) => {
        const q = s.clear();
        q.onsuccess = () => res(true);
        q.onerror = () => rej(q.error);
      }));
      if (r && r.missing) throw new VaultError(VAULT_CODES.NO_STORAGE, `IndexedDB store 不存在: ${dbName}/${storeName}`);
      return true;
    },
  };
}

function resolveDeps(deps = {}) {
  return {
    ls: deps.ls !== undefined ? deps.ls : defaultLsAdapter(),
    idb: deps.idb !== undefined ? deps.idb : defaultIdbAdapter(),
    ckx: deps.ckx || null,
  };
}

// ---------------------------------------------------------------- SDK 懒加载
let _ckxPromise = null;
async function loadCkx(injected) {
  if (injected) return injected;
  if (!_ckxPromise) _ckxPromise = import('../vendor/ckx/ckx.esm.js');
  return _ckxPromise;
}

// ---------------------------------------------------------------- 收集
function collectLs(ls) {
  const out = {};
  let keys = [];
  try { keys = ls.keys(); } catch (_) { keys = []; }
  for (const k of Array.isArray(keys) ? keys : []) {
    if (!isVaultLsKey(k)) continue;
    let v = null;
    try { v = ls.get(k); } catch (_) { continue; }
    if (v == null) continue;
    out[k] = v;
  }
  return out;
}

async function idbList(idb, db, store) {
  try {
    const r = await idb.list(db, store);
    return Array.isArray(r) ? r : [];
  } catch (_) {
    return [];
  }
}

/**
 * 汇总要备份的数据。
 * @param {{includeSecrets?:boolean, app?:{version?:string,tag?:string}}} opts
 * @param {{ls?:object|null, idb?:object|null}} deps 存储适配器（Node 单测注入）
 * @returns {Promise<object>} vault 信封
 */
export async function collectVault(opts = {}, deps = {}) {
  const env = resolveDeps(deps);
  const includeSecrets = !!opts.includeSecrets;
  if (!env.ls && !env.idb) throw new VaultError(VAULT_CODES.NO_STORAGE, '没有可用的存储适配器（localStorage / IndexedDB 均不可用）');

  const ls = env.ls ? collectLs(env.ls) : {};
  const idb = {};
  const secrets = { ls: {}, idb: {} };

  if (env.idb) {
    for (const { db, stores } of IDB_PLAN) {
      for (const store of stores) {
        const recs = await idbList(env.idb, db, store);
        if (!recs.length) continue;
        const secKeys = (SECRET_IDB[db] || {})[store];
        if (!secKeys) {
          (idb[db] = idb[db] || {})[store] = recs;
          continue;
        }
        const dataRecs = recs.filter((r) => !(r && typeof r === 'object' && secKeys.includes(r.key)));
        const secRecs = recs.filter((r) => r && typeof r === 'object' && secKeys.includes(r.key));
        if (dataRecs.length) (idb[db] = idb[db] || {})[store] = dataRecs;
        if (includeSecrets && secRecs.length) (secrets.idb[db] = secrets.idb[db] || {})[store] = secRecs;
      }
    }
  }

  const appInfo = opts.app || {};
  const vault = {
    schema: VAULT_SCHEMA_ID,
    schemaVersion: VAULT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    app: {
      version: String(appInfo.version ?? APP_VERSION ?? ''),
      tag: String(appInfo.tag ?? APP_TAG ?? ''),
    },
    data: { ls, idb },
  };
  const secIdbCount = Object.keys(secrets.idb).length;
  const secLsCount = Object.keys(secrets.ls).length;
  if (includeSecrets && (secIdbCount || secLsCount)) vault.secrets = secrets;
  return vault;
}

// ---------------------------------------------------------------- 导出
function assertPassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new VaultError(VAULT_CODES.BAD_PASSWORD, '口令不能为空');
  }
}

/**
 * 把 vault 加密为 `.ckx` 文件字节（介质 D，SAFE v3 容器原字节）。
 * @returns {Promise<Uint8Array>}
 */
export async function exportVaultBytes(vault, password, meta = {}, deps = {}) {
  assertPassword(password);
  if (!vault || typeof vault !== 'object') throw new VaultError(VAULT_CODES.BAD_PAYLOAD, 'vault 不能为空');
  const CKX = await loadCkx(deps.ckx);
  const payload = JSON.stringify(vault);
  const metaInput = {
    app: meta.app || VAULT_APP_ID,
    schema: vault.schema || VAULT_SCHEMA_ID,
    schemaVersion: String(vault.schemaVersion ?? VAULT_SCHEMA_VERSION),
    label: meta.label || `srsi-vault-${String(vault.exportedAt || '').slice(0, 10)}`,
    caps: VAULT_CAPS,
    createdAt: vault.exportedAt || new Date().toISOString(),
  };
  return CKX.encryptToFile(payload, password, metaInput);
}

/**
 * 免密码的**结构完整性自检**（SDK 0.6.0 新增 `verifyIntegrity`）→ `{ok, reason, medium, containerBytes, metaBytes, payloadBytes, meta}`。
 * ⚠️ 只覆盖头部/结构；**密文区**被截断/篡改仍会表现为 `CKX_WRONG_PASSWORD`（无口令的固有限制，见反馈 P1-2 补充）。
 */
export async function inspectVaultIntegrity(bytes, deps = {}) {
  const CKX = await loadCkx(deps.ckx);
  try { return CKX.verifyIntegrity(bytes); } catch (e) { return { ok: false, reason: (e && e.code) || 'verify-failed' }; }
}

/** 免密码读取载体公开元数据（meta 不加密）。 */
export async function inspectVault(bytes, deps = {}) {
  const CKX = await loadCkx(deps.ckx);
  let meta = null;
  try { meta = CKX.readMeta(bytes); } catch (_) { meta = null; }
  const readable = !!(meta && typeof meta === 'object');
  return {
    readable,
    meta,
    schemaOk: !!(readable && meta.schemaId === VAULT_SCHEMA_ID),
    formatVersion: readable ? meta.ckx : null,
  };
}

// ---------------------------------------------------------------- 导入（dry-run）
export function validateVault(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw new VaultError(VAULT_CODES.BAD_PAYLOAD, '保险箱内容不是合法对象');
  }
  if (v.schema !== VAULT_SCHEMA_ID) {
    throw new VaultError(VAULT_CODES.SCHEMA_MISMATCH, `schemaId 不匹配（期望 ${VAULT_SCHEMA_ID}，实际 ${String(v.schema)}）`);
  }
  const ver = Number(v.schemaVersion);
  if (!Number.isFinite(ver) || ver < 1) {
    throw new VaultError(VAULT_CODES.BAD_PAYLOAD, 'schemaVersion 非法');
  }
  if (ver > VAULT_SCHEMA_VERSION) {
    throw new VaultError(VAULT_CODES.VERSION_UNSUPPORTED, `schemaVersion ${ver} 高于本机支持的 ${VAULT_SCHEMA_VERSION}`);
  }
  if (!v.data || typeof v.data !== 'object' || Array.isArray(v.data)) {
    throw new VaultError(VAULT_CODES.BAD_PAYLOAD, '缺少 data 段');
  }
}

function vaultSummary(v) {
  const ls = (v && v.data && v.data.ls) || {};
  const idb = (v && v.data && v.data.idb) || {};
  const lsKeys = Object.keys(ls);
  const idbDetail = {};
  let idbRecords = 0;
  for (const [db, stores] of Object.entries(idb)) {
    for (const [store, recs] of Object.entries(stores || {})) {
      const n = Array.isArray(recs) ? recs.length : 0;
      idbDetail[`${db}/${store}`] = n;
      idbRecords += n;
    }
  }
  const sec = (v && v.secrets) || {};
  const secIdb = sec.idb || {};
  const secretDetail = {};
  let secretRecords = 0;
  for (const [db, stores] of Object.entries(secIdb)) {
    for (const [store, recs] of Object.entries(stores || {})) {
      const n = Array.isArray(recs) ? recs.length : 0;
      secretDetail[`${db}/${store}`] = n;
      secretRecords += n;
    }
  }
  return {
    schema: v.schema,
    schemaVersion: v.schemaVersion,
    exportedAt: v.exportedAt,
    app: v.app,
    lsKeys,
    lsCount: lsKeys.length,
    idbRecords,
    idbDetail,
    hasSecrets: !!(sec && (secretRecords || Object.keys(sec.ls || {}).length)),
    secretRecords,
    secretDetail,
  };
}

/**
 * 解密 + 校验 + 返回 **dry-run 预览**（不写任何存储）。
 * 错密码 → 原样抛出 CKX 的 `CKX_WRONG_PASSWORD`（CkxError）。
 * @returns {Promise<{vault:object, summary:object, meta:object, medium:string}>}
 */
export async function importVault(bytes, password, opts = {}, deps = {}) {
  assertPassword(password);
  const CKX = await loadCkx(deps.ckx);
  const res = await CKX.decrypt(bytes, password, { schema: VAULT_SCHEMA_ID });
  let text = null;
  try {
    text = res.text != null ? res.text : new TextDecoder().decode(res.plaintext);
  } finally {
    // 明文字节用后清零（JS 字符串副本无法清零，但为短生命周期局部变量；不落盘/不写日志）
    if (res.plaintext && typeof res.plaintext.fill === 'function') {
      try { res.plaintext.fill(0); } catch (_) {}
    }
  }
  return makePreview(parseVaultText(text), res.meta, res.medium);
}

/** 解析 + 校验保险箱明文（供 SDK / embed 两条路径复用）。 */
export function parseVaultText(text) {
  let vault;
  try { vault = JSON.parse(text); }
  catch (e) { throw new VaultError(VAULT_CODES.BAD_PAYLOAD, '保险箱内容不是合法 JSON', e && e.message); }
  validateVault(vault);
  return vault;
}

/** 组装 dry-run 预览对象。 */
export function makePreview(vault, meta, medium) {
  return { vault, summary: vaultSummary(vault), meta: meta || null, medium: medium || 'file' };
}

// ---------------------------------------------------------------- 写回
/**
 * 把预览（或原始 vault）写回本地存储。
 * @param {object} input `importVault()` 的返回值，或裸 vault
 * @param {{mode?:'overwrite'|'merge'}} opts
 */
export async function applyVault(input, opts = {}, deps = {}) {
  const vault = input && input.vault && input.vault.data ? input.vault : input;
  validateVault(vault);
  const mode = opts.mode === 'merge' ? 'merge' : 'overwrite';
  const env = resolveDeps(deps);
  const result = { mode, ls: 0, idb: 0, secretIdb: 0, secretLs: 0, clearedLs: 0, clearedStores: 0 };

  // localStorage
  if (env.ls) {
    if (mode === 'overwrite') {
      let keys = [];
      try { keys = env.ls.keys(); } catch (_) { keys = []; }
      for (const k of Array.isArray(keys) ? keys : []) {
        if (!isVaultLsKey(k)) continue;
        try { env.ls.remove(k); result.clearedLs++; } catch (_) {}
      }
    }
    for (const [k, v] of Object.entries(vault.data.ls || {})) {
      env.ls.set(k, v);
      result.ls++;
    }
  }

  // IndexedDB 业务数据
  if (env.idb) {
    for (const { db, stores } of IDB_PLAN) {
      for (const store of stores) {
        const recs = ((vault.data.idb || {})[db] || {})[store];
        if (!Array.isArray(recs)) continue;
        if (mode === 'overwrite') {
          try { await env.idb.clear(db, store); result.clearedStores++; } catch (_) {}
        }
        for (const rec of recs) {
          await env.idb.put(db, store, rec);
          result.idb++;
        }
      }
    }
  }

  // 凭证（仅当 vault 含有）
  const secIdb = (vault.secrets && vault.secrets.idb) || {};
  if (env.idb) {
    for (const [db, stores] of Object.entries(secIdb)) {
      for (const [store, recs] of Object.entries(stores || {})) {
        if (!Array.isArray(recs)) continue;
        for (const rec of recs) {
          await env.idb.put(db, store, rec);
          result.secretIdb++;
        }
      }
    }
  }
  const secLs = (vault.secrets && vault.secrets.ls) || {};
  if (env.ls) {
    for (const [k, v] of Object.entries(secLs)) {
      env.ls.set(k, v);
      result.secretLs++;
    }
  }

  return result;
}

// ---------------------------------------------------------------- 便捷门面
/** 收集 + 加密一步到位，返回 `.ckx` 字节。 */
export async function exportVault(opts = {}, deps = {}) {
  const vault = await collectVault(opts, deps);
  const bytes = await exportVaultBytes(vault, opts.password, opts.meta || {}, deps);
  return { bytes, vault, summary: vaultSummary(vault) };
}

/** 便捷：读出文件名的扩展名（供 UI 决定下载名；纯函数）。 */
export function vaultFilename(now = new Date()) {
  const d = now.toISOString().slice(0, 10);
  return `srsi-vault-${d}.ckx`;
}

// ---------------------------------------------------------------- embed 路径（CKX 接入方式 B）
// 与 SDK 路径互补：embed 免 SDK、需域名白名单、免费层不支持 schema 能力 → 产物 meta 无 schemaId，
// 依靠加密信封内的 vault.schema 校验。`mode:'file'` 产物与 SDK 的 `.ckx` 同为 SAFE v3 → 可互通。
async function withEmbedClient(opts, deps, fn) {
  if (deps.embed) return fn(deps.embed);
  const mod = await import('./ckxEmbed.js');
  const cfg = Object.assign({}, opts.embed, { medium: opts.medium || (opts.embed && opts.embed.medium) || 'file' });
  const client = mod.createCkxEmbedClient(cfg);
  try { return await fn(client); }
  finally { if (!opts.keepOpen) client.close(); }
}

/**
 * 经由 CKX embed（浮层 iframe）加密整个保险箱。
 * @returns {Promise<{medium:'file'|'text', bytes?:Uint8Array, text?:string, name?:string, mime?:string, vault:object, summary:object}>}
 */
export async function exportVaultViaEmbed(opts = {}, deps = {}) {
  const vault = await collectVault(opts, deps);
  const medium = opts.medium || (opts.embed && opts.embed.medium) || 'file';
  const out = await withEmbedClient(opts, deps, (client) => client.encrypt(JSON.stringify(vault), { medium, meta: opts.meta }));
  return Object.assign({}, out, { vault, summary: vaultSummary(vault) });
}

/**
 * 经由 CKX embed 解密并返回 dry-run 预览（不写回）。
 * `carrier`：密文串（medium A）或 `.ckx` 字节（medium D，自动识别）。
 */
export async function importVaultViaEmbed(carrier, opts = {}, deps = {}) {
  const out = await withEmbedClient(opts, deps, (client) => client.decrypt(carrier, { carrierName: opts.carrierName }));
  const text = out.text != null ? out.text : new TextDecoder().decode(out.bytes || new Uint8Array());
  return makePreview(parseVaultText(text), out.meta, opts.medium || 'file');
}

export { vaultSummary };
