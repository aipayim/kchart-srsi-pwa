/**
 * 向后兼容回归：**旧版本 .ckx（SAFE v3）在 SDK 0.6.0 下仍可读/可解**
 * + 新增 `verifyIntegrity()`（0.6.0，免密码结构自检 → 回应 P1-2）。
 *
 * fixture `tests/fixtures/vault-sdk-0.4.0.json` 由 **@cryptokey/ckx 0.4.0（首次发布版）** 真实加密产生。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { inspectVault, importVault, exportVaultBytes, collectVault, CKX_SDK } from '../src/persistence/ckxVault.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CKX = await import('../src/vendor/ckx/ckx.esm.js');
const fx = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'vault-sdk-0.4.0.json'), 'utf8'));
const bytes = new Uint8Array(Buffer.from(fx.containerB64, 'base64'));

let fails = 0;
const check = (name, cond, extra) => { if (!cond) { fails++; console.error('FAIL:', name, extra == null ? '' : extra); } else console.log('ok:', name); };
const caught = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

// ---- 1) 旧容器：免密码读 meta + 结构自检 + 解密 ----
const insp = await inspectVault(bytes);
check('B1 旧容器（0.4.0 产出）免密码 readMeta 可读', insp.readable === true && insp.schemaOk === true, JSON.stringify(insp.meta));
const integ = CKX.verifyIntegrity(bytes);
check('B2 verifyIntegrity 对完好容器 ok=true', integ && integ.ok === true, JSON.stringify(integ));
const prev = await importVault(bytes, fx.password);
check('B3 旧容器在 0.6.0 下可解密并校验通过', prev.vault.schema === 'srsi.vault.v1' && prev.summary.lsCount === 2 && prev.summary.idbRecords === 3);
check('B4 旧容器不含 secrets（默认）', prev.summary.hasSecrets === false);

// ---- 2) verifyIntegrity 的**边界**（实测确认）----
// 2a 结构损坏（头部/meta 区不成立）→ 免密码即可判定
const structural = bytes.slice(0, 60);                     // < 41+metaLen+16，结构不成立
const itS = CKX.verifyIntegrity(structural);
check('B5 结构损坏 → verifyIntegrity ok=false（免密码可判定）', itS && itS.ok === false, JSON.stringify(itS));
const eDmg = await caught(() => importVault(structural, fx.password));
check('B6 结构损坏解密 → CKX_CARRIER_DAMAGED', eDmg && eDmg.code === 'CKX_CARRIER_DAMAGED', eDmg && eDmg.code);
const eDmg2 = await caught(() => { const c = bytes.slice(); c[4] = 9; return importVault(c, fx.password); });
check('B6b 版本字段被改 → CKX_UNSUPPORTED_FORMAT_VERSION', eDmg2 && eDmg2.code === 'CKX_UNSUPPORTED_FORMAT_VERSION', eDmg2 && eDmg2.code);

// 2b ⚠️ 密文区截断：verifyIntegrity 仍 ok（结构自洽），解密只能是 WRONG_PASSWORD —— 无口令的固有限制
const ctCut = bytes.slice(0, bytes.length - 40);
const itC = CKX.verifyIntegrity(ctCut);
check('B5b 密文区截断：verifyIntegrity 仍 ok=true（结构自洽，属固有限制）', itC && itC.ok === true, JSON.stringify(itC && itC.reason));
const eCut = await caught(() => importVault(ctCut, fx.password));
check('B6c 密文区截断 → CKX_WRONG_PASSWORD（无法与密码错区分）', eCut && eCut.code === 'CKX_WRONG_PASSWORD', eCut && eCut.code);
const ePw = await caught(() => importVault(bytes, 'wrong-pw'));
check('B7 密码错 → CKX_WRONG_PASSWORD（可区分）', ePw && ePw.code === 'CKX_WRONG_PASSWORD', ePw && ePw.code);
const itBad = CKX.verifyIntegrity(new Uint8Array([1, 2, 3, 4, 5]));
check('B8 非容器 verifyIntegrity ok=false', itBad && itBad.ok === false, JSON.stringify(itBad));

// ---- 3) 新产物同样可被自检（正向往返）----
const vault = await collectVault({}, { ls: { keys: () => ['smartTrader'], get: () => '{"a":1}', set() {}, remove() {} }, idb: null });
const fresh = await exportVaultBytes(vault, 'pw-new-060');
check('B9 新产物 verifyIntegrity ok=true', CKX.verifyIntegrity(fresh).ok === true);
check('B10 CKX_SDK 已是 0.6.0', CKX_SDK.version === '0.6.0', CKX_SDK.version);

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
