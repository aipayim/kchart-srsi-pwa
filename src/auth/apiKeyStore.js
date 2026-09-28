/**
 * API Key 加密存储 — WebCrypto AES-GCM（纸面模式默认不启用真实资金）
 *
 * 安全模型：
 *  - 密钥绝不落 localStorage（易被备份/脚本直接读取）
 *  - 加密主密钥随机生成，存入 IndexedDB 'state' 的 crypto.deviceKey
 *  - 若用户设置口令，则用 PBKDF2 派生密钥（更强；每次会话需输入口令解锁）
 *  - 真实资金模式为硬锁：默认 'locked'，必须显示解锁且通过双 Testnet 对账才可切换
 */
import * as db from '../persistence/indexdb.js';

const DEVICE_KEY_ID = 'crypto.deviceKey';
const API_KEY_ID = 'crypto.apiKeys';

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64encode(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function b64decode(str) {
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function sha256(buf) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
}

function genAesKey() {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

function importAesKey(raw) {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** 从口令 + 盐派生 AES 密钥（PBKDF2） */
export async function deriveKeyFromPassphrase(passphrase, salt) {
  const baseKey = await crypto.subtle.importKey(
    'raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 150000, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function aesEncrypt(plaintext, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));
  return b64encode(new Uint8Array([...iv, ...new Uint8Array(ct)]));
}

async function aesDecrypt(data, key) {
  const raw = b64decode(data);
  const iv = raw.slice(0, 12);
  const ct = raw.slice(12);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return dec.decode(pt);
}

/** 获取设备主密钥（不存在则生成并存入 IndexedDB） */
export async function getDeviceKey() {
  const existing = await db.get('state', DEVICE_KEY_ID);
  if (existing && existing.value) {
    return importAesKey(b64decode(existing.value));
  }
  const key = await genAesKey();
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  await db.put('state', { key: DEVICE_KEY_ID, value: b64encode(raw), ts: Date.now() });
  return key;
}

/** 解锁密钥：优先口令派生；未设口令则用设备主密钥 */
export async function unlockKey(passphrase) {
  if (passphrase && passphrase.length >= 4) {
    const salt = new Uint8Array(await sha256(enc.encode('smart-trader:' + passphrase.length)));
    return deriveKeyFromPassphrase(passphrase, salt);
  }
  return getDeviceKey();
}

/** 加密保存 API Key（真实交易所凭证），无口令时用设备主密钥 */
export async function saveApiKey({ exchange, apiKey, secret, passphrase }) {
  const key = await unlockKey(passphrase || '');
  const store = (await db.get('state', API_KEY_ID)) || { key: API_KEY_ID, value: {} };
  store.value[exchange] = {
    apiKey: await aesEncrypt(apiKey || '', key),
    secret: await aesEncrypt(secret || '', key),
    savedAt: Date.now(),
    hasPassphrase: !!(passphrase && passphrase.length >= 4)
  };
  await db.put('state', { ...store, ts: Date.now() });
  return true;
}

/** 读取解密后的 API Key；口令错误时解密失败返回 null */
export async function getApiKey(exchange, passphrase) {
  const row = await db.get('state', API_KEY_ID);
  if (!row || !row.value || !row.value[exchange]) return null;
  try {
    const key = await unlockKey(passphrase || '');
    return {
      apiKey: await aesDecrypt(row.value[exchange].apiKey, key),
      secret: await aesDecrypt(row.value[exchange].secret, key)
    };
  } catch {
    return null; // 口令错误或数据损坏
  }
}

export async function hasApiKey(exchange) {
  const row = await db.get('state', API_KEY_ID);
  return !!(row && row.value && row.value[exchange]);
}

export async function clearApiKey(exchange) {
  const row = await db.get('state', API_KEY_ID);
  if (row && row.value) {
    delete row.value[exchange];
    await db.put('state', { ...row, ts: Date.now() });
  }
  return true;
}

export const REAL_MODE_KEY = 'settings.realMode';

/** 真实资金模式状态：'locked'（硬锁）| 'armed'（对账通过可切换）| 'live'（已开启） */
export async function getRealMode() {
  const row = await db.get('state', REAL_MODE_KEY);
  return (row && row.value) || 'locked';
}

/** 只有在双 Testnet 对账通过后，才允许将状态从 locked 提升到 armed；live 需用户显式确认 */
export async function setRealMode(mode) {
  const current = await getRealMode();
  if (current === 'locked' && mode !== 'locked') {
    throw new Error('真实资金模式处于硬锁状态：必须先通过双 Testnet 对账验证（到达 armed）');
  }
  await db.put('state', { key: REAL_MODE_KEY, value: mode, ts: Date.now() });
  return true;
}
