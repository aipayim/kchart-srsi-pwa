# Vendored: `@cryptokey/ckx` SDK (CKX v1)

本目录是 **原样 vendoring** 的第三方 SDK，**请勿修改其中任何文件的内容**（改动会使 sha384 校验失败）。

## 来源

| 项 | 值 |
|---|---|
| 包名 | `@cryptokey/ckx` |
| 版本 | **0.3.0** |
| 规范 | CKX format version **1**（`SAFE v3` 容器） |
| 下载 | `https://cryptokey.im/ckx/sdk/ckx-sdk-latest.zip`（60,729 B） |
| 完整性清单 | `https://cryptokey.im/ckx/sdk/MANIFEST.json`（`generatedAt: 2026-10-04T23:26:46.080Z`） |
| 许可 | **Apache-2.0**（见同目录 `LICENSE`；商标/Logo 不在授权内，本项目不使用其商标） |
| 运行时依赖 | 无（zero dependencies，仅 Web Crypto） |
| 引擎要求 | Node ≥ 18 / 现代浏览器（需 `crypto.subtle`） |

## 收录文件与 sha384

| 文件 | 字节 | sha384 |
|---|---|---|
| `ckx.esm.js` | 23,862 | `sha384-xaI7CqZ0AokQ5FJgll3MCFYbW9zGGSuA6Vq88YVI1y3LxHAfRgR4KWARCUbUMgVV` |
| `ckx.d.ts` | 12,700 | `sha384-2cwgYdijBHHs03Gzfj8jlXhBR5EE8OTNy6sNjJAsat3qpbREQbOnJC2lJAzzxkKz` |
| `LICENSE` | 11,347 | `sha384-GM/3Jrs/y6+jGEosIuuAA1h6oD7Y9C3DghiynB5tWJofjn4Y6qvz9QFSh0PzRZBv` |

校验：`node scripts/verify-ckx-sdk.mjs`（也可 `npm run verify:ckx`）。该校验使用 Node 内置
`crypto.createHash('sha384')`，与 `MANIFEST.json` 的值逐字节比对；任何篡改/漂移都会失败。

## 为什么 vendoring（而不是 npm / CDN）

- 该 SDK **未发布到 npm**（`publishConfig.access: public` 但尚无 npm 包），无法用版本号锁定。
- 运行时从 CDN `import` 会引入供应链与 CSP/离线风险；本项目 PWA 要求可离线运行。
- 因此固定字节 + 哈希校验 + 本地 `import()`（**动态懒加载**，不撑大首屏 chunk）。

## 用法（本项目）

```js
// 懒加载（Vite 会代码分割，SDK 不进首屏）
const CKX = await import('../vendor/ckx/ckx.esm.js');
await CKX.encryptToFile(payload, password, { app, schema, schemaVersion });
```

- 介质 **D**（`.ckx` 文件 = `SAFE v3` 容器原字节）为本项目推荐的默认导出格式。
- 介质 A（base64url 文本）/ B（PNG 文本 LSB）/ E（视频尾挂）为可选载体；图片/视频易被压缩/转码损坏。
- 免费开放层能力：`text` / `image` / `file` / `video`，**本地使用不发任何服务端请求**、不耗额度。

## 升级步骤

1. 下载新 zip，比对 `MANIFEST.json`。
2. 覆盖 `ckx.esm.js` / `ckx.d.ts`，更新本文件中的版本号、字节数、sha384。
3. 覆盖 `LICENSE`（若变更）。
4. `node scripts/verify-ckx-sdk.mjs` 通过。
5. 跑 `npm test`（含 `tests/ckxVault.test.mjs` 的官方测试向量自检）。
