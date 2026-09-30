# PWA 仓库维护指南（面向智能体 / 协作者）

本文件说明 **kchart-srsi-pwa（公开 PWA 版）** 与 **源码版（主系统仓库）** 的关系、白名单构成、以及如何把改动同步到公开 GitHub 仓库并手动部署到 `srsi.openapi.im`。任何智能体按本文操作即可正确维护该 PWA 仓库与线上站点。

---

## 1. 两个仓库的关系

| 名称 | 路径 / 地址 | 是否公开 | 说明 |
|---|---|---|---|
| **源码版（主系统）** | 本地主仓目录（`<MAIN_REPO>`，不在本仓库内） | 否（无公开 remote） | 完整项目，含主系统 + PWA 全部源码、全部测试（`npm test` 跑 300+ 用例）。PWA 相关代码先在这里改、在这里跑全量测试。 |
| **脱敏版（本仓库）** | GitHub `https://github.com/aipayim/kchart-srsi-pwa`；本仓库本地路径（`<SANITIZED_REPO>`） | 是（public） | 仅含 PWA **白名单**文件，已脱敏，部署到 `https://srsi.openapi.im`。 |

> **核心原则**：所有改动先在「源码版」开发并跑全量测试；通过后，仅把**白名单内**的改动文件复制到「脱敏版」，再在脱敏版跑精简测试 + 构建 + 提交 + 部署。脱敏版**绝不**反向合入主系统内部文件。

---

## 2. 白名单（本仓库实际包含的文件 —— 由 `git ls-files` 生成，2026-09-30 核对）

> ⚠️ 本清单是**唯一权威**：新增/删除文件后必须同步更新本节（两份 `MAINTENANCE.md` 保持一致）。

```
# --- 根目录 ---
.gitignore
AGENTS.md
GOAL.md
LICENSE
MAINTENANCE.md
README.md
index.html
kchart.html
package-lock.json
package.json
styles.css
version.generated.js
vite.config.js

# --- public/ ---
public/_redirects
public/favicon.png
public/pwa-192.png
public/pwa-512.png
public/tsev-weights.json

# --- scripts/ ---
scripts/gen-icon.mjs
scripts/gen-version.mjs
scripts/verify-pwa-data.mjs

# --- src/engine/ ---
  engine/adaptivePortfolioMath.js
  engine/adaptiveRisk.js
  engine/chanlun.js
  engine/chanlunDisplay.js
  engine/disciplineAnalysis.js
  engine/fees.js
  engine/funding.js
  engine/indicators.js
  engine/jevSrsiStats.js
  engine/jevState.js
  engine/liqHeatmapVol.js
  engine/liquidation.js
  engine/maRelation.js
  engine/maRibbonBox.js
  engine/regimeParams.js
  engine/srsiOptimizer.js
  engine/thresholds.js
  engine/timeframe.js

# --- src/pwa/ ---
  pwa/adaptivePortfolio.js
  pwa/alphaCore.js
  pwa/alphaLab.js
  pwa/carryLeg.js
  pwa/data.js
  pwa/jevClient.js
  pwa/jevSrsiAudit.js
  pwa/kchartApp.js
  pwa/localLoop.js
  pwa/pwa.css
  pwa/pwaShell.js
  pwa/signalSounds.js

# --- src/tech2/ ---
  tech2/adaptivePanel.js
  tech2/chanlunPanel.js
  tech2/jevAuditPanel.js
  tech2/jevPanel.js
  tech2/kchart.js
  tech2/maRelGauge.js
  tech2/maRibbonBoxPanel.js
  tech2/ruleMonitor.js
  tech2/signalAlerts.js
  tech2/signalCockpit.js
  tech2/toolBoard.js

# --- src/ 其余（PWA 运行/构建所需的主系统模块，均为精简变体或零依赖纯函数） ---
  ai/llmClient.js
  auth/apiKeyStore.js
  exchange/ExchangeAdapter.js
  exchange/PaperEngine.js
  exchange/orderState.js
  legacy.js
  main.js
  persistence/indexdb.js
  styles.css
  version.generated.js

# --- tests/ ---
  adaptivePanel.test.mjs
  adaptivePortfolio.test.mjs
  chanlun.test.mjs
  chanlunDisplay.test.mjs
  consistency.test.mjs
  disciplineAnalysis.test.mjs
  fixtures/bnbusdt_klines.json
  jev.test.mjs
  jevSrsiAudit.test.mjs
  jevSrsiStats.test.mjs
  kchart.test.mjs
  liqHeatmapVol.test.mjs
  localLoop.test.mjs
  maRelGauge.test.mjs
  maRelation.test.mjs
  maRibbonBox.test.mjs
  orderManager.test.mjs
  paperSim.test.mjs
  pwaAlphaCore.test.mjs
  signalAlerts.test.mjs
  signalCockpit.test.mjs
  signalSounds.test.mjs
  toolBoard.test.mjs

# --- docs/（仅设计稿/预览，无密钥） ---
  design/GOAL17-CYBER-PREVIEW.html
  design/GOAL18-CYBER-v2-preview.png
  design/GOAL18-CYBER-v2.html
  design/GOAL19-COLDSTEEL-desktop.png
  design/GOAL19-COLDSTEEL-mobile.png
  design/GOAL19-COLDSTEEL.html
  research/GOAL17-MOBILE-UX.md

```

> 说明：`src/main.js`/`src/legacy.js`/`index.html`/`src/styles.css`/`AGENTS.md`/`GOAL.md` 在脱敏仓中为**精简变体**（去掉主系统设置页/账本/密钥面板等），并非主仓原文件整拷。新增文件必须显式加入本节。

---

## 3. 排除项（主仓存在、脱敏仓**不含**）

- 主系统 UI 与交易核心：`src/tech/`、`src/tech2/fusionBacktest.js`、`src/ai/`（**例外见 §2**：仅 `llmClient.js`）、
  `src/auth/`（**例外见 §2**：仅 `apiKeyStore.js`）、`index.legacy.html.bak`、`pwa-redesign-demo.html`
- 主系统研究/内部脚本：`scripts/measure-*`、`scripts/analyze-*`、`scripts/bt-*`、`scripts/release.mjs`、
  `scripts/rehearse-tsev.mjs`、`scripts/jev-srsi-verdict.mjs`、`scripts/jev-srsi-checkpoint.mjs`、`scripts/adaptive-portfolio/`、`scripts/carry-harvest/`、
  `scripts/liq-heatmap/`、`scripts/signal-lab/`、`scripts/dvol-research/`、`scripts/_debug_disc.mjs`
- 主系统测试：`tests/{engine,persist,reconcile,ai,regime}.test.mjs`（覆盖主系统模块）
- 内部文档与计划：`PLAN.md`、`CHANGELOG.md`、`GOAL_jev-srsi.md`、`docs/*.md`、`docs/research/`、`analysis/`、`.pi/`
- 构建产物与数据：`dist/`、`dev-dist/`、`node_modules/`、`data/`（均已在 `.gitignore`）
- **任何密钥 / Token / API Key 的值**（详见第 6 节）——⚠️ 本文档一律用占位符
  （`<CF_ACCOUNT_ID>` / `<CF_TOKEN>` / `<SECRETS_FILE>` / `<MAIN_REPO>` / `<SANITIZED_REPO>`），绝不可写真实值
  （2026-09-30 修复：曾误留 CF 账户 ID 与 token 掩码片段）。

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
# ⚠️ 必须整条 && 链执行：先 cd 到本仓库并打印 pwd + ls dist/assets（防错门），再注入凭证部署。
# 历史事故：曾多次在主仓 cwd 误部署未脱敏产物 → 必须有防错门。
cd /mnt/d/TEST/app/app36-trader-hst/kchart-srsi-pwa-脱敏版 && pwd && ls dist/assets \
  && [ -f package.json ] \
  && ! ls dist/assets/main-*.js >/dev/null 2>&1 \
  && ls dist/assets/kchart-*.js >/dev/null 2>&1 \
  && echo SANITIZED_CHECK_OK \
  && TOKEN=$(sed -n '6p' <SECRETS_FILE> | sed 's/^Token://' | tr -d '\r') \
  && CLOUDFLARE_API_TOKEN="$TOKEN" CLOUDFLARE_ACCOUNT_ID=<CF_ACCOUNT_ID> CI=1 \
     npx wrangler pages deploy dist --project-name srsi-pwa --branch main
```

- **⚠️ 凭证取第 6 行**：`<SECRETS_FILE>` 第 1 行是 GitHub PAT、第 6 行才是 Cloudflare token。用 `grep -m1 '^Token:'` 在部分环境下会取错（或取到非 ASCII 内容）→ `Authentication error [code:10000]` / ByteString 错。务必用 `sed -n '6p' ... | sed 's/^Token://' | tr -d '\r'`。
- **禁止 `--commit-dirty`**：`<SECRETS_FILE>` 含中文，`cat` 整文件作 token 或该标志会引发 wrangler 的 `Authorization` 头 ByteString 错误。
- **防错门（SANITIZED_CHECK_OK）**：脱敏版 dist 只有 `kchart-*.{js,css}`，**不含 `main-*.js`**；若出现 `main-*.js` 说明当前 cwd 是主仓（未脱敏）→ 拒绝部署。
- 部署后 `https://srsi.openapi.im/kchart` 即为最新版；根路径 `/` 经 `public/_redirects` 302 跳转到 `/kchart.html`。
- **⚠️ 分支必须是 `main`**：自定义域 `srsi.openapi.im` **只服务 Production 部署**，而 Cloudflare Pages 把 `main` 分支视为 Production。用 `--branch production`（或其它名）部署只会产生 **Preview** 部署，自定义域**不会更新**，线上仍显示旧版。务必 `--branch main`。
- 首次/罕见情况下 wrangler 上传较慢会超时，重试一次即可；**不要用 `--yes`**（该子命令不识别此标志，会打印用法）。
- 验证：`curl -s -o /dev/null -w "%{http_code}" https://srsi.openapi.im/kchart` 应返回 `200`；并确认线上 JS 含本次改动（如 `curl -s https://srsi.openapi.im/kchart | grep kchartSrsiCard`）。
- 浏览器若仍缓存旧 Service Worker：用 PWA「刷新」按钮（unregister SW + 清 Cache + 硬刷新），或新开标签页。

---

## 6. 凭证与安全（务必遵守）

- **凭证位置**：`<SECRETS_FILE>`，内含：
  - `github_pat_…`（GitHub PAT，用于 `gh` / `git push`）
  - `Token: <CF_TOKEN>`（Cloudflare API Token，用于 `wrangler pages deploy`）
  - Cloudflare Account ID / 区域 ID 等
- **使用方式**：仅在运行时通过环境变量注入（见上），**绝不**把明文写进代码、提交信息或本仓库任何文件。
- **公开仓库零密钥**：本仓库除 `.gitignore` 外不含任何密钥；`vite.config.js` 的 `base:'./'` 与 PWA 配置均为公开参数。
- **脱敏红线**：不提交主系统内部文档、不含任何交易所 Key（PWA 本就不需要 Key）、不在 README/MAINTENANCE 中写真实 Token 值。

GitHub 推送所需的 `GH_TOKEN`：
```bash
export GH_TOKEN="$(grep -m1 'github_pat_' <SECRETS_FILE>)"
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
