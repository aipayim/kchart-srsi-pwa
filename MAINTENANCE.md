# PWA 仓库维护指南（面向智能体 / 协作者）

本文件说明 **kchart-srsi-pwa（公开 PWA 版）** 与 **源码版（主系统仓库）** 的关系、白名单构成、以及如何把改动同步到公开 GitHub 仓库并手动部署到 `srsi.openapi.im`。任何智能体按本文操作即可正确维护该 PWA 仓库与线上站点。

---

## 1. 两个仓库的关系

| 名称 | 路径 / 地址 | 是否公开 | 说明 |
|---|---|---|---|
| **源码版（主系统）** | 本地 `/mnt/d/TEST/app/app36-trader-hst/` | 否（无公开 remote） | 完整项目，含主系统 + PWA 全部源码、全部测试（`npm test` 跑 300+ 用例）。PWA 相关代码先在这里改、在这里跑全量测试。 |
| **脱敏版（本仓库）** | GitHub `https://github.com/aipayim/kchart-srsi-pwa`；本地 `/mnt/d/TEST/app/app36-trader-hst/kchart-srsi-pwa-脱敏版/` | 是（public） | 仅含 PWA **白名单**文件，已脱敏，部署到 `https://srsi.openapi.im`。 |

> **核心原则**：所有改动先在「源码版」开发并跑全量测试；通过后，仅把**白名单内**的改动文件复制到「脱敏版」，再在脱敏版跑精简测试 + 构建 + 提交 + 部署。脱敏版**绝不**反向合入主系统内部文件。

---

## 2. 白名单（本仓库实际包含的文件）

```
.gitignore
LICENSE
README.md
MAINTENANCE.md
kchart.html
package.json
package-lock.json
vite.config.js
styles.css
version.generated.js
public/_redirects
public/favicon.png
public/pwa-192.png
public/pwa-512.png
scripts/gen-icon.mjs
scripts/gen-version.mjs
scripts/verify-pwa-data.mjs
src/engine/{indicators,thresholds,timeframe,regimeParams,fees,funding,liquidation,disciplineAnalysis,srsiOptimizer}.js
src/exchange/{PaperEngine,ExchangeAdapter,orderState}.js
src/pwa/{data.js,kchartApp.js,localLoop.js}
src/tech2/kchart.js
tests/{kchart.test.mjs,consistency.test.mjs}
tests/fixtures/bnbusdt_klines.json
public/tsev-weights.json
```

> 这些文件就是 PWA 运行 / 构建 / 测试所需的全部依赖闭环。新增文件必须属于此白名单，否则不要入库。

---

## 3. 排除项（绝不入库 / 已脱敏）

- 主系统 UI 与交易核心：`index.html`、`src/legacy.js`、`src/main.js`、`src/ai/`、`src/tech/`、`src/auth/`、`src/tech2/fusionBacktest.js`
- 主系统研究/内部脚本：`scripts/measure-*`、`scripts/analyze-discipline-factors.mjs`、`scripts/gen-discipline-readme.mjs`、`scripts/gen-tsev-weights.mjs`、`scripts/rehearse-tsev.mjs`、`scripts/release.mjs`、`scripts/_debug_disc.mjs`
- 主系统测试（覆盖主系统模块）：`tests/engine|persist|reconcile|ai|regime|disciplineAnalysis.test.mjs`
- 内部文档：`AGENTS.md`、`PLAN.md`、`CHANGELOG.md`、`index.legacy.html.bak`、`docs/`（含真实 Cloudflare 区域/账户 ID）
- 构建产物与数据：`dist/`、`dev-dist/`、`node_modules/`、`data/`（均已在 `.gitignore`）
- **任何密钥 / Token / API Key**（详见第 6 节）

---

## 4. 日常工作流（改代码 → 同步 → 部署）

以修复 `src/tech2/kchart.js` 为例：

```bash
# ① 在源码版改代码
cd /mnt/d/TEST/app/app36-trader-hst
# …编辑 src/tech2/kchart.js / src/pwa/* / src/engine/* …
npm test                 # 全量测试必须全绿（kchart 295 + 其余）

# ①-b 若改动了 TSEV：重新生成全局权重快照（需 data/discipline-factors.jsonl 含 factors+fut 样本）
#     无网络环境会产出空权重（PWA 回落经典逻辑，本机 loop 仍可逐设备自学习）
node scripts/gen-tsev-weights.mjs

# ② 仅把白名单内改动同步到脱敏版
cp src/tech2/kchart.js /mnt/d/TEST/app/app36-trader-hst/kchart-srsi-pwa-脱敏版/src/tech2/kchart.js
cp src/engine/disciplineAnalysis.js /mnt/d/TEST/app/app36-trader-hst/kchart-srsi-pwa-脱敏版/src/engine/disciplineAnalysis.js
cp src/engine/srsiOptimizer.js /mnt/d/TEST/app/app36-trader-hst/kchart-srsi-pwa-脱敏版/src/engine/srsiOptimizer.js  # SRSI 优选器（kchart.js 已 import，须随包发布）
cp src/pwa/localLoop.js /mnt/d/TEST/app/app36-trader-hst/kchart-srsi-pwa-脱敏版/src/pwa/localLoop.js
cp public/tsev-weights.json /mnt/d/TEST/app/app36-trader-hst/kchart-srsi-pwa-脱敏版/public/tsev-weights.json
# 若改了测试，也同步：
cp tests/kchart.test.mjs /mnt/d/TEST/app/app36-trader-hst/kchart-srsi-pwa-脱敏版/tests/kchart.test.mjs

# ③ 在脱敏版跑精简测试 + 构建
cd /mnt/d/TEST/app/app36-trader-hst/kchart-srsi-pwa-脱敏版
npm test                 # 仅 kchart + consistency（白名单测试）
npm run build            # 产出 dist/

# ④ 提交并推送到公开 GitHub
git add -A
git commit -m "fix: <简明改动说明>"
git push origin main

# ⑤ 部署到 srsi.openapi.im（见第 5 节）
```

> 若改动涉及多个白名单文件，逐一对齐复制即可；不要 `git add -A` 源码版后整体拷贝，以免带入排除项。

---

## 5. 手动部署到 srsi.openapi.im

站点由 **Cloudflare Pages** 项目 `srsi-pwa` 托管，自定义域名 `srsi.openapi.im`（CNAME → `srsi-pwa.pages.dev`）。

```bash
cd /mnt/d/TEST/app/app36-trader-hst/kchart-srsi-pwa-脱敏版

# 凭证从本地 pat.txt 读取（详见第 6 节，勿硬编码）
export CLOUDFLARE_API_TOKEN="$(grep -m1 '^Token:' /mnt/d/TEST/app/app29-openapi/pat.txt | sed 's/^Token://')"
export CLOUDFLARE_ACCOUNT_ID="766d2b730eb31ff7aac0210a1808ad7f"

npx wrangler pages deploy dist --project-name=srsi-pwa --branch main --commit-dirty=true
```

- 部署后 `https://srsi.openapi.im/kchart` 即为最新版；根路径 `/` 经 `public/_redirects` 302 跳转到 `/kchart.html`。
- **⚠️ 分支必须是 `main`**：自定义域 `srsi.openapi.im` **只服务 Production 部署**，而 Cloudflare Pages 把 `main` 分支视为 Production。用 `--branch production`（或其它名）部署只会产生 **Preview** 部署，自定义域**不会更新**，线上仍显示旧版。务必 `--branch main`。
- 首次/罕见情况下 wrangler 上传较慢会超时，重试一次即可；**不要用 `--yes`**（该子命令不识别此标志，会打印用法）。
- 验证：`curl -s -o /dev/null -w "%{http_code}" https://srsi.openapi.im/kchart` 应返回 `200`；并确认线上 JS 含本次改动（如 `curl -s https://srsi.openapi.im/kchart | grep kchartSrsiCard`）。
- 浏览器若仍缓存旧 Service Worker：用 PWA「刷新」按钮（unregister SW + 清 Cache + 硬刷新），或新开标签页。

---

## 6. 凭证与安全（务必遵守）

- **凭证位置**：`/mnt/d/TEST/app/app29-openapi/pat.txt`，内含：
  - `github_pat_…`（GitHub PAT，用于 `gh` / `git push`）
  - `Token: x0EH4…`（Cloudflare API Token，用于 `wrangler pages deploy`）
  - Cloudflare Account ID / 区域 ID 等
- **使用方式**：仅在运行时通过环境变量注入（见上），**绝不**把明文写进代码、提交信息或本仓库任何文件。
- **公开仓库零密钥**：本仓库除 `.gitignore` 外不含任何密钥；`vite.config.js` 的 `base:'./'` 与 PWA 配置均为公开参数。
- **脱敏红线**：不提交主系统内部文档、不含任何交易所 Key（PWA 本就不需要 Key）、不在 README/MAINTENANCE 中写真实 Token 值。

GitHub 推送所需的 `GH_TOKEN`：
```bash
export GH_TOKEN="$(grep -m1 'github_pat_' /mnt/d/TEST/app/app29-openapi/pat.txt)"
git push origin main
```

---

## 7. 常见任务速查

| 任务 | 操作 |
|---|---|
| 改 PWA 逻辑 | 改 `src/tech2/kchart.js` / `src/pwa/*` / `src/engine/*`，按 §4 流程 |
| 加新依赖文件 | 必须属于 §2 白名单；若引入主系统独有模块，先评估是否需脱敏或内联 |
| 改样式 | 改 `styles.css`（共享，含 `.disc-*` 纪律面板类） |
| 改构建/图标 | `vite.config.js`（仅 `kchart` 入口）、`scripts/gen-icon.mjs` |
| 回滚线上 | `git revert <commit>` 或 `git checkout <commit> -- .` 后重新 §4→§5 |
| 本地预览 | `npm run dev` → 打开 `http://localhost:5173/kchart.html` |
| 跑一致性校验 | `npm test`（= kchart + consistency） |

---

## 8. 发布前验证清单

- [ ] 源码版 `npm test` 全绿
- [ ] 脱敏版对应文件已同步（白名单内）
- [ ] 脱敏版 `npm test` 绿 + `npm run build` 成功
- [ ] `git status` 无排除项/密钥混入（`git ls-files` 核对 §2）
- [ ] 已 `git push origin main`
- [ ] `wrangler pages deploy` 成功，线上 `srsi.openapi.im/kchart` 返回 200 且含本次改动

---

> 本文件与 `README.md`、`LICENSE` 一同构成公开仓库的维护依据。任何协作者/智能体严格按 §4–§6 操作即可安全维护该 PWA。
