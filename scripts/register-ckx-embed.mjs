#!/usr/bin/env node
/**
 * CKX iframe embed 域名白名单自助注册（CKX 接入方式 B）
 *
 * 两步（官方流程）：
 *   ① POST /v1/ckx/embed/register {origin}            → 返回 challenge `ckx-verify-<hex>`
 *   ② 把 challenge 发布到 https://<origin>/.well-known/cryptokey-ckx.txt（单行，≤4KB，不重定向）
 *   ③ POST /v1/ckx/embed/register {origin, verify:true} → status: active（≤60s 生效）
 *
 * 用法：
 *   node scripts/register-ckx-embed.mjs --origin https://srsi.openapi.im            # 取 challenge
 *   node scripts/register-ckx-embed.mjs --origin https://srsi.openapi.im --write    # 取 challenge 并写入 public/.well-known/
 *   node scripts/register-ckx-embed.mjs --origin https://srsi.openapi.im --verify   # 完成验证
 *   node scripts/register-ckx-embed.mjs --origin https://srsi.openapi.im --status   # 查询状态
 *   node scripts/register-ckx-embed.mjs --origin https://srsi.openapi.im --policy   # 查询白名单是否生效
 *   node scripts/register-ckx-embed.mjs --integrators                              # 公开合作方名单（/registry 数据源）
 *
 * 环境：Node ≥18（自带 fetch/WebCrypto）。受限网络下 Node 不读 http_proxy；可试
 *   `NODE_USE_ENV_PROXY=1 http_proxy=... https_proxy=... node scripts/register-ckx-embed.mjs ...`
 *
 * ⚠️ 步骤 ② 必须**先部署**该文件，否则 verify 会返回 VERIFICATION_FETCH_FAILED。
 * ⚠️ 撤销需 admin token（`Authorization: Bearer <CKX_ADMIN_API_KEY>`），本脚本不做（用 curl）。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const DEFAULT_ENDPOINT = 'https://cryptokey.im';
const WELLKNOWN_REL = 'public/.well-known/cryptokey-ckx.txt';

/** 校验并归一化 origin（与官方规则一致：仅 scheme+host+port，禁 * / null / 非 http(s)）。 */
export function normalizeOrigin(input) {
  if (!input || typeof input !== 'string') return { ok: false, error: 'INVALID_ORIGIN' };
  let u;
  try { u = new URL(input); } catch (_) { return { ok: false, error: 'INVALID_ORIGIN' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, error: 'INVALID_ORIGIN' };
  if (!u.hostname || u.hostname.includes('*')) return { ok: false, error: 'INVALID_ORIGIN' };
  return { ok: true, origin: `${u.protocol}//${u.host}` };
}

/** 从注册响应里取 challenge（兼容 challenge / token 字段）。 */
export function challengeOf(resp) {
  if (!resp || typeof resp !== 'object') return null;
  const c = resp.challenge || resp.token || (resp.verification && resp.verification.token);
  return typeof c === 'string' && c.startsWith('ckx-verify-') ? c : null;
}

/** 验证文件内容（官方接受两种形式；这里用「等号」形式）。 */
export function wellKnownContent(challenge) {
  return `cryptokey-ckx-verify=${challenge}\n`;
}

export function wellKnownPath(repo = REPO) {
  return join(repo, WELLKNOWN_REL);
}

async function jsonFetch(url, init = {}, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(url, init);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch (_) { body = { raw: text.slice(0, 400) }; }
  return { status: res.status, ok: res.ok, body };
}

function usage() {
  process.stdout.write(`用法: node scripts/register-ckx-embed.mjs --origin <origin> [--write] [--verify] [--status] [--policy] [--integrators] [--json] [--endpoint <url>]\n`);
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  const writeFile = deps.writeFile || writeFileSync;
  const mkdir = deps.mkdir || mkdirSync;
  const log = deps.log || ((s) => process.stdout.write(s + '\n'));
  const out = { steps: [] };
  const has = (f) => argv.includes(f);
  const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
  const json = has('--json');
  const endpoint = (val('--endpoint') || DEFAULT_ENDPOINT).replace(/\/+$/, '');
  if (has('--integrators')) { /* 无需 --origin，见下方早退分支 */ }
  const originRaw = val('--origin');
  if (has('--integrators')) {
    const ir = await jsonFetch(`${endpoint}/v1/ckx/integrators`, {}, fetchImpl);
    if (json) return { ok: ir.ok, integrators: ir.body, steps: [{ step: 'integrators', ok: ir.ok, body: ir.body }] };
    log(`integrators: ${JSON.stringify((ir.body && ir.body.origins) || [])}`);
    return { ok: ir.ok, integrators: ir.body };
  }
  if (!originRaw || has('-h') || has('--help')) { usage(); return { ok: false, error: 'USAGE' }; }
  const norm = normalizeOrigin(originRaw);
  if (!norm.ok) { log(`❌ 非法 origin: ${originRaw}（需要 http(s)://host[:port]，禁 * / null）`); return { ok: false, error: norm.error }; }
  const origin = norm.origin;
  const url = `${endpoint}/v1/ckx/embed/register`;

  const emit = (o) => { if (json) out.steps.push(o); else if (o.text) log(o.text); };

  if (has('--policy')) {
    const r = await jsonFetch(`${endpoint}/v1/ckx/embed/policy?origin=${encodeURIComponent(origin)}`, {}, fetchImpl);
    emit({ step: 'policy', ok: r.ok, body: r.body });
    // 0.4.0：只回该 origin 的 {allowed, sla}（不再含全量 origins；全量见 --integrators）
    if (!json) log(`policy: allowed=${r.body && r.body.allowed} sla=${r.body && r.body.sla}（全量名单请用 --integrators）`);
    return { ok: r.ok, origin, policy: r.body, ...out };
  }
  if (has('--status')) {
    const r = await jsonFetch(`${url}?origin=${encodeURIComponent(origin)}`, {}, fetchImpl);
    emit({ step: 'status', ok: r.ok, body: r.body });
    if (!json) log(`status: ${r.body && r.body.status} (registeredAt=${r.body && r.body.registeredAt})`);
    return { ok: r.ok, origin, status: r.body, ...out };
  }
  if (has('--verify')) {
    const r = await jsonFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ origin, verify: true }) }, fetchImpl);
    emit({ step: 'verify', ok: r.ok, body: r.body });
    if (!json) log(r.body && r.body.status === 'active' ? `✅ 已验证并生效：${origin}（≤60s 传播）` : `⚠️ 验证结果: ${JSON.stringify(r.body)}`);
    return { ok: !!(r.ok && r.body && r.body.status === 'active'), origin, verify: r.body, ...out };
  }

  // 默认：取 challenge（--write 时同时写入 public/.well-known/）
  const r = await jsonFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ origin }) }, fetchImpl);
  const challenge = challengeOf(r.body);
  emit({ step: 'challenge', ok: !!(r.ok && challenge), body: r.body });
  if (!r.ok || !challenge) { if (!json) log(`❌ 取 challenge 失败: HTTP ${r.status} ${JSON.stringify(r.body)}`); return { ok: false, origin, ...out }; }
  if (!json) log(`challenge: ${challenge}`);
  if (has('--write')) {
    const p = wellKnownPath(deps.repo || REPO);
    mkdir(dirname(p), { recursive: true });
    writeFile(p, wellKnownContent(challenge));
    if (!json) log(`已写入 ${p}`);
    out.wrote = p;
  } else if (!json) {
    log(`下一步：${has('--write') ? '' : '（加 --write 自动写入）'} 把下面内容发布到 https://${origin.replace(/^https?:\/\//, '')}/.well-known/cryptokey-ckx.txt 后，再跑 --verify`);
    log(wellKnownContent(challenge).trim());
  }
  return { ok: true, origin, challenge, ...out };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === (process.argv[1].startsWith('/') ? process.argv[1] : join(process.cwd(), process.argv[1]));
if (isMain) {
  main().then((r) => { process.exit(r && r.ok === false ? 1 : 0); }).catch((e) => { console.error('❌', e && e.message ? e.message : e); process.exit(2); });
}
