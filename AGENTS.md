# AGENTS.md — 项目工作流与关键决策（对 AI 助手 & 人类开发者的权威说明）

> 本文件是项目唯一的事实来源：任何上下文压缩/会话丢失后，按本文件即可完整恢复开发状态。
> 请在新会话开始时先读本文件，再读 `CHANGELOG.md` 了解最近改动。

## 0. 沟通规则（强制）
- **默认用中文回复用户**（含本会话的全部解释、总结、问答）。代码注释/标识符仍按各文件既有约定（中文注释或英文均可，但改动文件时沿用其风格）。
- 终端命令、文件路径、符号名等保持原样（不翻译）。

## 1. 这是什么
`smart-trader` — 智能交易系统（纸面/模拟）。纯前端 Vite 应用，含：
- 双所行情（Binance + OKX，REST + WebSocket）+ 事件溯源持久化（IndexedDB + localStorage）
- 技术分析（EMA/RSI/MACD/SRSI/AIS 自适应通道/共振/多周期）+ AI 自动交易（信号评分制）
- 套利监控、子账户模拟引擎（`src/exchange/PaperEngine.js`）、真实资金**默认硬锁**
- 测试：`tests/*.test.mjs`（Node 原生，无框架）

## 2. 目录结构
```
src/legacy.js            主逻辑（状态、设置、AI、渲染、数据获取）— 单文件 ~1600 行
src/main.js              入口：挂载引擎、事件溯源、设置页
src/engine/indicators.js 技术指标（EMA/RSI/MACD/SRSI/ATR/AIS/共振 + winLossByAtr 等回测纯函数）
src/engine/disciplineAnalysis.js  交易纪律方向因子消融·共享分析核心（前端面板 + Node 分析器同源）
src/engine/timeframe.js  多周期重采样
src/exchange/PaperEngine.js  纸面撮合引擎（订单/保证金/止盈止损/强平/资金费率）
src/persistence/         事件溯源、账本、备份/恢复、IndexedDB
src/auth/                测试网 API Key（AES-GCM 本地加密）
src/tech/                技术分析画布与面板
src/tech2/fusionBacktest.js  融合页「🧪 因子消融回测」面板（读 /data/*.jsonl，dev-only）
src/version.generated.js 版本文件（由 npm run version:gen 生成，勿手改）
index.html               页面骨架（含设置面板、数据融合页、AI 管理页）
scripts/gen-version.mjs  生成版本文件
scripts/release.mjs      发布脚本（升版本+打标签）
scripts/measure-discipline-factors.mjs       回测采集（浏览器内跑，追加 data/discipline-factors.jsonl）
scripts/measure-discipline-factors-loop.mjs  后台累积循环（每60min，跨行情）
scripts/analyze-discipline-factors.mjs       消融分析器（薄壳，用共享核心）
scripts/gen-discipline-readme.mjs            生成 data/README.md 进度快照
data/                 回测数据（discipline-factors.jsonl / energy-regime.jsonl）+ README.md（不打包进 dist）
```

## 3. 常用命令
```bash
npm run dev               # 本地开发（vite）
npm test                  # 全部单元测试（4 个文件）
npm run build             # 构建到 dist/
npm run version:gen       # 重新生成 src/version.generated.js
npm run release [patch|minor|major|1.2.3]   # 发布：升版本+提交+打 tag
```

### 重要：`/mnt/d` 是 WSL 挂载盘，**没有文件监听**
改完代码后**必须手动重启 dev 服务器**，否则浏览器仍用旧代码：
```bash
./stop.sh && ./start.sh
# 验证: curl -s -o /dev/null -w "%{http_code}" http://localhost:5173/src/legacy.js  # 期望 200
```

## 4. 版本管理（重点：真正挂钩 git，任何时刻可回滚）
- **版本号单一来源 = `package.json` 的 `version`**，发布时同步打 git tag `vX.Y.Z`。
- `src/version.generated.js` 由 `scripts/gen-version.mjs` 从 package.json + git describe 生成，
  内含 `APP_VERSION / APP_TAG / APP_COMMIT / APP_DESCRIBE / APP_DIRTY / APP_BUILD_TIME`。
- 应用头部 logo 与设置页底部显示当前版本 + git commit + 构建时间（`renderVersion()`）。
- **每次发布 = 一个 git tag = 一个可回滚点**：
  - `git tag`                       查看所有版本
  - `git checkout v1.1.0`           检出任意版本（回滚）
  - `git revert v1.1.0`             撤销某版本
  - `git log --oneline`             查看提交历史
- `STATE_VER`（legacy.js）是 **localStorage 数据 schema 版本**，与 app 版本**解耦**：
  只有当 saveState/loadState 的存储结构改变时才需递增；改 schema 后旧状态会被清空重建。
- **发布流程**：`npm test` → `npm run build` → 手动验证 → `npm run release patch`
  （release 脚本要求工作区干净，会自动 commit + tag）。

### 4.1 硬性规则：每次修改后、部署前必须检查并更新版本（PWA/前端通用）
- **任何会进入生产（`dist/` 并部署 Cloudflare Pages）的代码改动，部署前都必须 bump 版本**，否则线上用户会被旧 Service Worker / 浏览器缓存卡住，看不到修复（本仓库已多次踩坑）。
- 操作步骤（PWA / 前端主系统一致）：
  1. `npm test` 全绿（任何改动先跑测试，禁止跳过）。
  2. 改 `package.json` 的 `version`（语义化：hotfix/小修 `patch`，新功能 `minor`，破坏性 `major`）。
  3. `npm run build`（其 `prebuild` 会自动 `version:gen` 重新生成 `src/version.generated.js`，
     内含新的 `APP_VERSION` 与唯一 `APP_BUILD_TIME`；PWA 右下角版本徽章显示 `v<APP_VERSION> · <构建日期>`）。
  4. 部署后核实：浏览器打开 PWA → 右下角徽章版本号/日期已更新；并在 F12 看 `[SRSI-DIAG]` 等新诊断日志是否生效。
- **版本门控已内置**：`kchartApp.js` 的 `applyVersionGate()` 在 `APP_BUILD_TIME` 变化时带 `?_swclear=APP_VER` 强制重定向清缓存；
  `public/_headers` 对 `kchart.html/index.html/sw.js/registerSW.js` 设 `no-cache`，防止 Cloudflare 边缘缓存旧入口。
  但版本号不 bump 时 `APP_BUILD_TIME` 不变 → 门控不触发，故**bump 版本才是根治**。
- 提交/打 tag 走 `npm run release`（要求工作区干净）；若只想先部署验证而不提交，可仅 bump `package.json` + `npm run build` + 部署，后续再统一 release。
- 切勿把"修复已写完"等同于"用户已看到"——**没 bump 版本 + 没部署，等于没修**。

## 5. 近期关键决策（务必知悉，勿误改/勿回退）
### 5.1 纸面交易冷启动不成交的修复（已上线）
- `S.ai.lastExecT`：冷却以**实际成交时刻**计（此前以"上次检测时刻"计导致永远冷却）。
- `S.ai.lastEnter`：**同一币+同方向 60 秒内不重复进场**。
- updateAI 增加多 1t 指标信号（短线多头/空头、站上/跌破AIS、SRSI超买/超卖、MACD多头/空头、
  持仓量OI 升降、资金费率、恐惧贪婪、鲸鱼、多周期共振、趋势 ×0.4 过滤、触发门槛）。
- 拦截原因实时输出到终端与 AI 管理页（`S.ai.lastBlock`）。

### 5.2 设置面板全面审计：曾经的"装饰性设置"已全部生效
- 原硬编码/失效：`setMinConf`（硬编码65）、`setAiMax`（每日AI上限）、`setMaxOrder`（单笔最大）、
  `setMaxDailyLoss`（每日最大亏损）、`setMaxLev`（最大杠杆）、`setBothSide`（必须双边）、
  数据融合 4 开关（无 id 纯摆设）。
- 现已全部读取生效；新增风控：数据新鲜度（`S.prices[sym].lastT` >30s 拦截）、
  ATR 爆表拦截、同向仓位≥3 拦截、AI 单日计数 `S.ai.dayCount`（跨天自动重置）。
- 风险预设 `RP`（conservative/standard/aggressive）含 `aiLev`（AI 杠杆上限，激进最高 30x）、
  `minConf/aiMax/maxOrder/maxDailyLoss`（联动 AI 置信门槛/每日上限/单笔/每日亏损）。
  切换预设时自动把 AI 风控参数同步到设置面板 DOM；用户手动改后以手动值为准并持久化。
- 设置持久化在 localStorage `smartTrader` 的 `settings` 块。

### 5.3 已确认待办/已知问题（本批次前）
- 数据融合页 `fus_score` 卡片此前是**随机数**（`Math.random()`）——**v1.1 已改为真实评分**。
- AI 统计面板此前不显示"今日已用 N/20"——**v1.1 已添加**。
- `SYMS` 交易对硬编码 8 个——**v1.1 已动态化**（设置页可添加/删除，localStorage `smartTrader_syms` 持久化）。

### 5.4 版本管理 & 本地仓库（v1.0 起）
- git 仓库位于项目根目录，主分支 `main`；版本号单一来源 `package.json`，每次发布打 tag `vX.Y.Z`。
- 版本文件 `src/version.generated.js` 由 `npm run version:gen` 从 package.json + git 生成。
- 发布：`npm test` → `npm run build` → 手动验证 → `npm run release patch|minor|major|1.2.3`。
- 回滚：`git checkout v1.1.0` 检出、`git revert v1.1.0` 撤销、`git log --oneline` 看历史。

### 5.5 动态交易对（v1.1）
- `SYMS` 由 `loadSymbols()` 从 localStorage `smartTrader_syms` 读取（默认 8 个，上限 20）。
- `addSymbol/removeSymbol`：增删时重建 WS 订阅（`reconnectWS`）、初始化/清理全部数据源、保存持久化。
- 删除有持仓的币种会被拦截；`S.sel` 被删时自动切换到第一个币种。
- 融合页选择器 `#fusionSel`、设置页列表 `#symList` 由 `refreshSymbolSelectors/renderSymList` 渲染。

### 5.6 技术分析增强：回测胜率/市场情境/交易计划/纸面覆盖（v1.2）
- **回测胜率叠加**：`techChart.js` 每次渲染时对每个周期调用 `signalBacktest()`（纯函数 `indicators.js`），在图上画 ✓/✗ 标记（按"下一波 1×ATR 先到"判定胜负），结果缓存于 `window.__techBT[tf]`。
- **市场情境**：`detectRegime()` 纯函数，依据 AIS 线斜率 + 价格位置 + ATR 状态判断趋势/震荡/回调 + 波动扩张/收缩。显示在技术信号面板。
- **信号置信度 0-100**：`computeConviction()` 综合多周期一致占比(50%)、强度(30%)、情境对齐(20%)。
- **一键交易计划**：`renderTradePlan()` 渲染在 `#techPlan` 容器，方向切换（自动/做多/做空）+ 风险%滑杆 + 杠杆选择 + 入场/止损(1.5×ATR)/止盈(3×ATR, R:R 1:2) + 建议仓位 + 开多/开空按钮（调 `openModal`）。
- **纸面成交覆盖**：`drawPaperOverlay()` 在图上画持仓入场横线 + 历史平仓赢/亏圆点。`S.closed` 记录新增 `entry`/`exit` 字段（PaperEngine 与 legacy.js 手动平仓共同写入）。
- **AI 信号增强**：`updateAI()` 加入 regime 过滤（趋势市压制逆势 ×0.5）+ 1t 共振信号按回测胜率加减权（`window.__techBT['1t']`，胜率≥60% 加分，≤40% 降权 ×0.6）。拦截原因在 `S.ai.lastRegime` 记录。
- **渲染顺序**：`renderTech()` 先画布再面板，确保 `__techBT` 在面板读取前已填充。

### 5.7 LLM 可参与交易 + 会话上下文 + 账本净化（v1.3）
- **LLM 可参与交易角色**：`updateAI()` 中 `llmFire`（role=trade 且 LLM 方向与最终方向一致且置信达标）可独立触发开仓；
  执行门槛放宽为 `effConf>=minConf && (信号≥2 || llmFire) && (触发||llmFire)`，仓位/杠杆按 `effConf`（规则与 LLM 置信较大者）计算；
  `lastCtx.llmTrade` 标记 + 信号串带 `[LLM触发]` 标签入库。方向门仍是硬约束（逆势 LLM 信号被清零不触发）。
- **会话上下文记忆**：`S.ai.llmHistory` 每次分析后记录 `{ts,verdict,reasoning,symbols,prices快照}`；
  双上限截断（`llmHistKeep` 条数默认100 + `llmHistDays` 天数默认7，均可设置），随 localStorage 持久化；
  每次对话仅注入最近 `llmHistPrompt` 条（默认8，可设1-20）到 prompt 的「历史会话回顾」，
  含时间戳与 ✓/✗ 对错标注供 LLM 自我修正；AI 管理页「会话历史」面板展示（滚动，最多显示20条）。
- **账本净化**：`log()` 不再写入事件账本（避免终端日志噪音淹没）；新增 `recordLedgerEvent(tag,msg)` 仅记录
  有审计意义的事件——AI开仓/AI拦截/风控预设切换/LLM分析完成；成交/平仓/资金费/强平仍由 `paperEngine.onOrder/onFunding/onLiquidation` 记录。
  账本时间显示加日期（YYYY-MM-DD HH:MM:SS）；`getStats()` 用 `count()` 显示真实总条数。
- 风险预设 `RP` 联动 AI 风控（见 5.2）：`minConf/aiMax/maxOrder/maxDailyLoss` 随预设推送。

### 5.8 AI 平仓管理（提前平仓）（v1.3）
- **角色定位**：AI 原来只开仓不平仓（平仓全由 `tick()` 固定风控规则：保本/阶梯止盈/跟踪止损/硬止损/超时24h，
  对 AI 仓与手动仓一视同仁）。v1.3 起新增 `manageAIExits()`（`updateAI` 末尾调用，每 15s 一次）。
- **总开关默认关闭**：`setAiMgmtOn`（设置页 AI 设置卡片，`settings` 块持久化）。关闭时完全不生效，原有风控不受影响。
- **两种触发（任一满足即平）**：`src/ai/exitLogic.js` 纯函数（无 DOM，可单测）：
  - `shouldLLMExit(pos, verdict, confThr)`：持仓方向 vs LLM 当前方向相反且置信≥`setAiMgmtConf`（默认60）→ 平仓
  - `shouldScoreExit(pos, curScore, spreadThr)`：当前 `ls/ss` 反向且反向分比持仓方向分高≥30 → 平仓
- **评分缓存**：`updateAI` SYMS 循环内把未阻尼的 `{ls,ss,side}` 存到 `S.ai.lastScores[sym]`（供评分反转用，先于已有仓位×0.3阻尼）。
- **防抖保护**：`pos.openTime + setAiMgmtHoldMin`（默认10分钟）内不平；每日提前平仓计数 `S.ai.mgmtCount`（默认上限5次，
  跨天用 `aiDayStr()` 重置，随 localStorage 持久化）。
- **平仓路径**：`closePos(i, reason)` 新增可选 reason 参数（默认"手动平仓"），AI 平仓传 `[AI] LLM逆势平仓 …`/`[AI] 评分反转平仓 …`，
  走 paperEngine → 账本/`S.closed`/知识库完整记录。
- **生效范围**：两种 LLM 角色（signal/trade）都生效，仅针对 `pos.ai===true` 的 AI 仓。

### 5.9 数据融合页增强（v1.3）
- **数据源 Bug 修复**：资金费率/持仓量改为**双所原始值分存**（`S.fusion.frB/frO/oiB/oiO`），
  由 `mergeFusionData()` 每周期取可用源平均（双所均有取均值，单所失败时 OKX 不再被跳过）；
  `lastFR/lastOI` 时间戳只在有数据时更新；历史采样统一由 `updateFusion()` 每 2s 推进（不再双倍推送）。
- **数据新鲜度指示**：FR/OI/F&G 卡片底部显示「更新 Xs/m 前」，>90s 变黄、>180s 变红、无数据显"暂无数据"。
- **鲸鱼按币种过滤**：只显示当前选中币种的鲸鱼（`S.fusion.whales.filter(w=>w.sym===sym).slice(0,3)`）。
- **评分操作建议**：综合趋势评分卡片新增操作建议（≥60 偏多可做多 / ≤40 偏空可做空 / 否则观望）+ 置信度标签（高/中/低）。
- **市场广度卡片**：全币种 24h 涨跌统计「涨/跌 (X%涨)」，涨多绿跌多红。
- **渲染频率**：`updateFusion()`（每 2s）在 `curPage==='fusion'` 时额外调 `renderFusion()` 保证新鲜度文本实时刷新。

### 5.10 数据融合页扩展：17 卡片全景（v1.3）
数据融合页由 7 卡扩展为 **17 卡**（全部展开，`renderFusion` 网格），分四类：
- **现有 7 卡**：资金费率 / 持仓量OI / 恐惧贪婪 / 跨所价差 / 鲸鱼(按币过滤) / 市场广度 / 综合趋势评分（含操作建议+置信度）。
- **新增-技术面（复用指标）**：技术信号卡（1t RSI 超买卖 + MACD 多空 + AIS 上下方 + **多周期共振** `combineResonance`(1t/10t/1m) 一致度与强弱）、
  市场情境卡（`detectRegime` 趋势/震荡/回调 + 波动扩张收缩 + AIS斜率%，叠加 1m `trendGate` 中期方向）。
- **新增-信号与仓位（复用 AI）**：AI 多空评分卡（`S.ai.lastScores[sym]` 的 ls/ss 双条 + 方向 + 信号串 + 新鲜度）、
  LLM 判断卡（`S.ai.llm.symbols[sym]` 方向/置信/理由）、持仓状态卡（当前币持仓方向/杠杆/浮盈）、
  24h 行情卡（涨跌%/最高最低/距高低点距离/成交量+**新增 quoteVolume**）、波动率卡（`S.ai.atrHis` 当前 vs 中位数 → 扩张/收缩）。
- **新增-多空比（新 API，默认开启）**：`fetchBinanceLSData()` 拉 **3 个 fapi futures/data 公开接口**（仅当前选中币 `S.sel`，60s 一次 + 切币/进页立即刷新）：
  `globalLongShortAccountRatio`（散户多空账户比）、`topLongShortAccountRatio`（顶级交易者多空比）、`takerlongshortRatio`（主动买卖量比），
  存 `S.fusion.lsG/lsT/tk[sym]` + `lastLS` 新鲜度，展示多/空占比条与 Taker 买卖比。
- **设置开关全部生效**：`setFusionFR/OI/FG/Whale/LS`（5 个，index.html 数据融合设置卡）在 `renderFusion` 中真实控制对应卡片显隐
  （此前 FR/OI/FG/Whale 仅持久化未生效——装饰性，已接线）。`qVol` 从 Binance WS `q` 字段与 REST `quoteVolume` 捕获。
- **多周期计算扩展**：`updateIndicators` 的 10t/1m 计算从"仅 techConfig.symbol"扩展到"tech 页选中币 + 融合页选中币 `S.sel`"。
- 测试：55 通过（含多空比解析：占比/回退/Taker 换算 5 项）。

### 5.11 数据融合页再扩展：27 卡片全景（v1.4）
数据融合页由 17 卡扩展为 **27 卡**（全部展开、不加新开关、纯前端复用数据），`renderFusion` 中 `cards.push` 共 27 处：
- **A组-历史趋势（40点历史数组，只要数字）**：
  费率趋势卡（`S.fusion.frHis[sym]` 当前 vs 20点前 → 上升/下降/平稳 + 变化%）、
  OI 趋势卡（`S.fusion.oiHis[sym]` 5点/20点变化 → 资金流入/流出）、
  价格走势卡（`S.spark[sym]` 10点动量% + 40点区间%，复用 updateAI 急涨>1.5%/急跌<-1.5% 阈值）、
  恐惧贪婪趋势卡（`S.fusion.fgHis` 当前 vs 5点前 → 情绪升温/降温）。
- **B组-AI 信号表现（复用 AI 统计）**：
  AI 信号胜率卡（`S.ai.lastScores[sym].sig` 当前触发信号 → 查 `S.ai.sigScore[名]` 的 wins/total/胜率%/avgPnl，无记录显示暂无）、
  AI 战绩卡（`S.ai.winTrades/loseTrades` 按 sym 过滤 → 胜率/净盈亏/笔数）、
  近期平仓卡（`S.closed` 按 sym 过滤最近 3 笔 → 方向/盈亏/原因/时间）。
- **C组-深度技术（复用 indicators）**：
  AIS 通道位置卡（`i1.current` price 在 aisUpper/aisLower 通道内位置% + 距上/下轨% + 上沿/下沿/中部）、
  EMA 趋势卡（`ema20 vs ema120` → 金叉/死叉/无交叉 + 价差%）、
  回测胜率卡（调 `signalBacktest(i1.series)` 纯函数 → 买/卖信号历史胜率 + 总样本）。
- **性能保护**：回测胜率卡结果缓存于模块级 `__btCache[sym]={t,stats}`，仅切币或缓存>60s 重算（`signalBacktest` 遍历 1t ~7200 点 × horizon60，不宜每 2s 跑）。
- `signalBacktest` 已加入 legacy.js 的 indicators 导入列表。
- 测试：64 通过（新增 9 项：动量急涨/急跌/偏涨、信号胜率查表/回退、AIS 通道位置 0/50/100/钳制）。

### 5.11.1 第 0 卡：价格 & 多周期涨跌（新增第 1 张卡，v1.4 后续）
- **位置**：`renderFusion()` 的 `cards` 数组最前面（`fus_mtf`），在资金费率卡之前 → 现在共 **28 卡**。
- **数据**：`fetchMultiTF()`（legacy.js，仿 `fetchBinanceLSData`）对 `S.sel` 并行拉 Binance **spot** klines（跨所价差卡同源）：
  `5m/15m/30m/1h/4h/8h` 各 `limit=5`、`1d` 拉 `limit=31`（7d/30d 从日线回推：`closes[len-1-7]` / `closes[0]`）。存 `S.fusion.multiTF[sym]={pct,long,short,flat,overall,price}` + `lastTF` 新鲜度时间戳。
- **纯函数**：`computeTFChanges(klinesMap)`（indicators.js，带单测）解析 Binance klines（close=idx4）算各周期涨跌%，计数多数方向（`flatEps=0.05`）→ `overall:long/short/flat`。7d/30d 用 `agoMap` 回推。
- **节流**：并入 `fetchAllFusionData`（60s 一次，计数变 7 源）+ `switchPage('fusion')` 进页立即 + `setFusionSym` 切币立即。
- **渲染（UI 定稿）**：实时价格**移出卡片**，显示在页面顶部 h3（`#fusionPrice`，在 `#fusionLSRatio` 多空比**前**，▲/▼+`$价` 涨绿跌红）；卡片内只保留 **3×3 网格**（上=5m/15m/30m、中=1h/4h/8h、下=1d/7d/30d），每格单行 `周期 箭头 涨跌%`（`5m ▲ +0.31%`），行间/列间分隔线，底部「多周期 偏多/偏空/中性」+ 新鲜度。标题改为「多周期涨跌」。
- 附带修复：`S.ai.atrHis` 原仅 updateAI 内懒初始化，renderFusion 早于首帧读取会崩（`S.ai.atrHis[sym]`）→ S 初始化加 `atrHis:{}` + 渲染读取改防御 `(S.ai.atrHis||{})`。
- 测试：indicators 135 + 主套件 64 全过（computeTFChanges 10 用例：解析/7d30d 回推/多数方向/单源失败/数据不足）。

## 5.12 1小时实盘监控分析 + 信号系统修复（v1.4）
### 5.12.1 监控方法
- Playwright headless Chromium 挂真实 `paperEngine` 钩子，每 20s 全量快照 + 实时记录 engine `onOrder/onFunding/onLiquidation` 事件。
- 脚本：`/tmp/trader-monitor.mjs`，产物：`/tmp/trader-monitor/snapshots.jsonl`（175 快照，58 分钟）、`events.jsonl`。
- 监控期间市场为**横盘**（BTC ±0.2%/h，8 币全在 ±0.2% 内），但 Binance 24h chg 约 -2%（误读为"下跌市"的陷阱来源）。

### 5.12.2 关键发现
1. **信号方向混录污染学习**：`updateAI` 把多头/空头信号全塞进同一个 `sig` 数组，`openTrade` 原样写入 `pos.sig`，平仓时 `recordSigResult` 按 `+` 拆分**把"共振卖出/超涨"等反向信号也算进多头交易的输赢** → `getSigScore` 学到的是脏权重。
2. **sigScore 空表永远返回 1.0**：`getSigScore` 在 `total<1` 时返回 1，而 `s.sigScore` 初始为空、且平仓极少（持仓 24h 超时才会平）→ 自适应权重长期失效。
3. **方向门硬清零**：`gate.gate==='long'→ss=0` / `'none'→ls=ss=0`。横盘市里门在 long/none 间抖动，导致**单边禁做空 + 69% 时间评分为 0**，系统形同瘫痪。
4. **超跌/超涨用 24h 静态值**：`超跌/超涨` 基于 `p.chg`（Binance 24h 涨跌），被当作实时动量。横盘 + 24h 为负 → 8 币全天持续触发"超跌"，开成逆势多单。
5. **交易对后多空比显示错误**：`#fusionLSRatio` 与 LS 卡片把 Binance `longAccount`（0~1 小数，0.5399=53.99%）直接当百分比 → 显示"多1%/空99%"，徽章 `(0.54>50)=false` 反显"空"。
6. `lastScores.side` 在 `ls=ss=0` 时误显 `'short'`（误导）。

### 5.12.3 已落地修复（legacy.js + indicators.js，64 测试全过）
1. **信号分向入库**：`filterSignalsBySide(sig, side)` 只把与成交方向一致的信号写入 `pos.sig`（纯函数 `indicators.js`，带单测）。`recordSigResult` 不再污染反向信号学习。
2. **sigScore 数据驱动种子**：每 120s 对 1t 序列跑 `signalBacktest`，把回测胜率作为 `共振买入/共振卖出` 的初始 `winRate`（仅当真实样本<3 时覆盖，真实成交后自动接管）。
3. **方向门连续抑制**：`gateKeepFactor(slopePct)` 替代硬清零——弱趋势(slope≈0.15%)×0.78 轻抑，强趋势(slope≥1.6%)×0.15 近禁；横盘门由 `ls=ss=0` 改为 ×0.6 轻抑，允许震荡市均值回归。
4. **超跌/超涨改实时动量**：`realMomentumPct()` 优先 1m K线近 3 根、回退 spark 12 点，脱离 24h 静态值（`p.chg` 仅保留显示在 F&G/24h 卡片）。
5. **多空比显示修正**：新增 `normLongRatio(v)`（indicators.js，带单测）把 0~1 小数归一化为 0~100 百分比，修复 `#fusionLSRatio`、`lsBar`、两张 LS 卡片徽章的数值与方向（taker `buySellRatio` 本就是比率，`>=1` 判定正确，无需改）。
6. **side 显示**：`ls=ss=0` 时 `side='flat'`，且 `bestSide` 非 long/short 时不开仓。

### 5.12.4 徽章逻辑复核结论（融合页 27 卡）
- **已确认正确**：恐惧贪婪(<30多/ >70空)、市场广度、综合评分、技术共振、市场情境、AI/LLM/持仓/24h/各趋势卡的方向判定。资金费率卡 `fr>=0→空` 为**合理逆向约定**（多头拥挤→看空），保持不变。
- 已修：LS 多空账户比 / 顶级交易者比（数值×100 + 方向反置 bug）；跨所价差卡 `Binance>OKX→多`（Binance 价更高=买压偏多，原标"空"已翻转）。

### 5.12.5 数据融合页多周期(1t/10t/1m)同屏显示（v1.4 后续）
- **需求**：融合页全部 6 张技术类卡片（技术信号/市场情境/AIS通道位置/EMA趋势/波动率/回测胜率）并排显示 1t/10t/1m。
- **数据层**：`updateIndicators()` 改为 1t 每 tick 实时算全币种；10t/1m 加节流 `_slowIndT`，**每 1.5s 对全部 8 币种重算**（此前仅选中币算，导致非选中币"多周期共振"名不副实），未到期复用上次值避免闪烁。
- **渲染层**：新增 `tfMini(getter)` 辅助（renderFusion 内），对 `['1t','10t','1m']` 各取读数拼 9px 小字；波动率卡保留原"1t 当前 vs 中位数 扩张/收缩"提示并追加三周期 ATR%；回测胜率卡用 `__btCache[sym+'|'+tf]` 分周期缓存（60s）。
- **性能**：慢周期节流后每 1.5s 仅 ~10 次 computeIndicators（10t≈720点/1m≈300点，远小于 1t 的 7200 点），无每消息重算卡顿；1t 实时性不变。
- 测试：64 通过（多周期为渲染层改动，纯函数未新增；节流逻辑内联于 updateIndicators）。

### 5.13 自适应 ATR 止损/超时 + ATR 监督机制（v1.4 后续）
- **背景（5h 监控 v2 分析）**：监控发现同向仓位拦截 900/900 全为"同向仓位过多(多)[5]"、sigScore 权重停滞——根因是**平仓极少**（5h 仅 2 笔，且全因 24h 超时），`dirStat`/`sigScore` 样本饥饿导致自适应机制无法学习。止损 -8% 硬编码 + 超时 24h 固定是"贴标签"参数。
- **新增 `superviseATR()`（indicators.js 纯函数，带单测）五层防护**：
  1. 输入校验（atr/price 为 0、NaN、Infinity）→ fallback
  2. 合理范围（atrPct 0.01%~15%）→ clamped 钳制到中位数
  3. 变化率看门狗（当前/上次 >3x 或 <1/3）→ replaced 复用上次有效值
  4. 中位数偏离（>3x）→ 仅预警不替换（记 alert）
  5. 三级回退链：上次有效值 → 中位数 → 默认 0.2%
- **监督状态**：`S.ai.atrSuper[sym][tf]={prev,pctHis[40],alerts[],warned}` 仅内存不持久化（避免旧市场环境的中位数污染当前判断，重启 1~2 分钟重建）。`superviseTFATR()`（legacy.js）集成于 `updateIndicators`，每周期计算后把监督结果写回 `ind.atr/current.atr/series.atr`，供止损/超时/交易计划/波动率风控一致使用。
- **自适应止损（替换 -8% 硬编码）**：tick() 中 `2×ATR`(已监督) 价格止损，最小 1.5% 价格防超紧；使用 1t ATR。原因记录 `ATR止损`。
- **自适应超时（替换 24h 固定）**：`timeoutH = clamp(24×(ATR中位数/当前ATR), 6, 48)`。波动高→早走，波动低→多等。中位数来自监督 pctHis。原因记录 `超时平仓(Nh)`。
- **AI 平仓管理默认开启**：`setAiMgmtOn` HTML 默认值 0→**1**（`manageAIExits` 每 15s 扫描评分反转/LLM 逆势），为 dirStat/sigScore 提供平仓样本源。
- **dirCap 学习加速**：样本门槛 `n<3→n<1`（Direction 胜率一有 1 笔即开始自适应 3/5/7）。
- 测试：indicators 125 + 主套件 64 全过，其中 superviseATR 13 用例（正常/fallback 三级/超范围钳制/突变替换/中位数偏离预警/冷启动/atrFromPct）。
- **验证**：headless 重启后 warm-up 阶段 ATR=0/无效被监督钳制到 0.2%（防坏值穿透），数据填满后无新 alert；`S.ai.atrSuper` 各币 1t/1m 40 点历史正常累积。

### 5.14 融合页卡片拖放排序 + 持久化 + 恢复默认（v1.4 后续）
- **需求**：融合页 28 卡支持拖拽换位置，移动后持久保存（localStorage），可恢复默认顺序。
- **实现（0 改动 28 条 cards.push）**：`renderFusion` 末尾内联写入改为
  `if(!window.__fusionDrag){fg.innerHTML=cards.join('');applyFusionOrder();}`；`applyFusionOrder()` 渲染后
  用 `h4.childNodes[0].nodeValue` 反向查 `t()` 字典给每卡设 `data-c`（如 `fus_mtf`）、`draggable=true`，
  再按保存顺序 `appendChild` 重排（未在保存列表的新卡自动追加末尾）。
- **拖拽**：`initFusionDnD()` 用事件委托挂在 `#fusionGrid`（dragstart/dragover/drop/dragend）；
  `dragover` 按命中卡片中线 `insertBefore` 实时移动；`drop` → `saveFusionOrderFromDOM()` 存
  `smartTrader_fusionOrder`（data-c 数组）→ 重渲染。拖拽期间 `__fusionDrag=true` 会跳过 2s 周期重渲染，避免中断。
- **恢复默认**：`resetFusionOrder()` 删 key + 重渲染；index.html h3 多空比后加 `↺` 按钮（onclick 直调，
  `resetFusionOrder` 已加入 exposeGlobals）。CSS 加 `.fusion-card{cursor:grab}` + `.dragging{opacity:.5;border-color:var(--accent)}`。
- **边界**：卡片开关(FR/OI/FG/Whale/LS)关闭时不在 DOM → 不在保存列表，重新打开后追加末尾；
  新版本新增卡不在保存列表 → 自动追加末尾；touch 设备不支持 HTML5 DnD（优雅降级为不可拖）。
- **验证**：headless 实测 28 卡全 draggable、模拟拖拽 `fus_mtf→末尾` 后 localStorage 保存正确、
  2s 重渲染后顺序保持、`↺` 点击清 key 恢复默认；测试 64+135 全过，build 成功。

### 5.15 融合页 4 卡多周期化（v1.4 后续）
- **需求**：综合趋势评分 / 24h 行情 / 市场广度 / 价格走势 4 卡融入 1t/10t/1m 数据（此前仅技术类 6 卡有 tfMini）。
- **新增纯函数（indicators.js，带单测）**：
  - `techScore(sig, res, opts)`：0-100 技术融合分，基准 50。RSI 超买/超卖 ±10、MACD柱 vs Signal ±8、
    价 vs EMA20 ±8、EMA20 vs EMA120 ±8、AIS 通道位置（上/下/中轨）±5、共振 buy/sell ±10，clamp 5-95。
    返回 `{score, parts}`（parts 为带权重的说明串数组，如 `'共振买+10'`）。空数据返回 null。
  - `momentumPct(series, lookback=10)`：`(last - ref)/ref*100`，ref=倒数第 lookback 根；数据不足返回 null。
- **渲染（renderFusion）**：
  - **fus_score**：卡片底部新增「周期」行，1t/10t/1m 各算 `techScore(ind.current, ind.resonance)` 并排显示（≥60 绿/≤40 红/中 金），
    多周期一致度：≥2 个 ≥60 →「一致偏多」、≥2 个 ≤40 →「一致偏空」、否则「分歧(N多/M空)」。
  - **fus_24h**：原 24h 静态行情下方新增 1t/10t/1m 序列动量行（`momentumPct(series.price,10)`）。
  - **fus_breadth**：原 24h 涨跌广度下方新增三周期「价格 vs EMA20」广度（每周期统计全币种 `price>ema20` 的 ↑/↓ 数）。
  - **fus_priceTrend**：原 spark 10/40 点动量保留，下方新增 1t/10t/1m 动量行 + 周期一致度标签（一致偏多/偏空/分歧）。
- **踩坑**：`h24Html`/`priceTrendHtml` 追加行时原声明被改为拼接（h24Html0 + 条件拼接）；卡片多周期行全部用 `ind.series.price`
  （`momentumPct` 需要有序价格序列）——`current.price` 只有单点无法算动量。
- **10t 冷启动**：`S.history` 仅内存、vite 重启后重新累积；`updateIndicators` 的 10t 要求 `resample(history,10)`≥30 点
  （即 history≥300 tick），约 2-3 分钟才出现。1m 来自 `hist1m` 回填，较快可用；1t 实时。验证时须等 history 攒够 300。
- **验证**：headless 实测 0 报错、28 卡完整、4 卡三周期全显并随 2s 周期自动刷新；10t 暖机后 `1t｜10t｜1m` 三值齐全。
  测试 149（indicators 新增 techScore 8 + momentumPct 6）+ 主套件 64 全过，build 成功。

### 5.16 多空比数据时间序 bug 修复（v1.4 后续）
- **现象**：`#fusionLSRatio` 与多空账户比/顶级交易者/Taker 三卡数值长时间不变，显示像"冻住"。
- **根因**：Binance fapi `futures/data/*`（globalLongShortAccountRatio / topLongShortAccountRatio / takerlongshortRatio）
  **按时间升序返回**（`[0]`=最旧约148分钟前，`[last]`=最新约3分钟前）。`fetchBinanceLSData()` 误取 `g.value[0]`，
  存的是 2.5 小时前的旧值；且 5m 周期每 5 分钟窗口只滑动一点点，肉眼几乎看不出变化。
- **修复**：`fetchBinanceLSData` 改用 `lastEl(arr)`＝取数组最后一根（最新时间）再判断（`Array.isArray` + `length`）。
  `lsG/lsT/tk` 现在都是最新值，卡显示"更新 Xs前"≈真实新鲜度。
- **验证**：headless 实测 lsG/lsT 数据 ts 距 now 由 148 分钟 → 4 分钟；`#fusionLSRatio` 显示"多53%/空47%"、
  多空账户比 53.4% 等正确渲染；测试 149 + 64 全过。
- **顶部多空比改为全卡片聚合联动**：`#fusionLSRatio` 不再只显示 lsG 单源。`refreshFusionRatio(sym)` 在
  renderFusion 的 grid 渲染后（`refreshFusionRatio` 调用放 `fg.innerHTML` 之后）读取**所有卡片** h4 徽章文本
  （多/空/偏多/偏空），聚合计数后**换算百分比**，显示在实时价格后：`看多60% / 看空40%`（无数量/方向/卡数等冗余）。
  每张卡徽章仍由各自原有规则计算，仅汇总展示，不改任何卡片的后台逻辑。无任何方向徽章时回退显示散户多空账户比
  (标注"账户比")。`refreshFusionRatio` 已入 exposeGlobals。
   验证：翻转 24h 徽章方向后顶部从"看多70%/看空30%"实时变为"看多56%/看空44%"；数据恢复后自动回到真实聚合。

### 5.17 过拟合 7 项修复批次（v1.4 后续）
监控 + 代码审计发现的**回测/信号过拟合**问题，P0(严重)→P2(一般) 全部落地：
- **P0-1 样本前视污染修复**：`walkForwardWinRate()`（indicators.js 纯函数，用**前一个回测窗口**的胜率预测当前窗口）替代 `signalBacktest` 前视胜率。
  `__btSeed` 重写为写 `S.ai.prior[sym]={t,winRate}`；`getSigScore` 真实样本<3 时用 prior；`updateAI` 回测校验改用 walk-forward，不再伪造样本。
- **P0-2 PaperEngine 真实化**：标记价格走公开 REST（`fetchMarkPrices` 合并 Binance `fapi/v1/premiumIndex` + OKX `api/v5/public/mark-price`，`getMarkPrice` 缓存）；滑点按波动率 `SLIP_K=0.1`（ATR%/交易量差）`SLIP_CAP=0.01` 封顶；成交**显式 taker 费**（`isMaker:false`，BNB 折扣走 `fees.js`）；MMR 档位用 `setTiers` 注入（`liquidation.js`，无需联网）；资金费率 notional 按标记价。
- **P1-1 sigScore 学习完整性**：`getSigScore` 近期加成改**精确匹配**（同名才加分，`recentBonus`）；`dirCap` 门槛 n<1 已达标；`recordSigResult` 分向路径、不污染反向信号学习。无假样本。
- **P1-2 阈值集中化**：新增 `src/engine/thresholds.js` 单一 `THRESH` 对象，接线到 `indicators.js`/`PaperEngine.js`/`exitLogic.js`/`legacy.js`（tick、AI、回测、动量、新鲜度等）。**自适应百分位默认关**（`ADAPTIVE_PERCENTILE=false`），先零行为、常量收口。
- **P1-3 移除假回退**：`pullbackEntry` 去掉 `price*0.001` 假 ATR；`signalBacktest` 去掉 `p*0.002` 假止盈；`ATR_BT_FALLBACK` 从 THRESH 删除。假数据全部清零。
- **P2-1 ATR 基准化离场**：tick() 保本/阶梯止盈/跟踪止损改用**受监督 1t ATR% × 杠杆 → margin%** 基准（`supervisedAtrPct()`，无效回退中位数→固定%），阈值取 `THRESH.EXIT_BE_MULT/EXIT_TRAIL_MULT/EXIT_LADDER_MULTS`；无 ATR 数据回退原固定 `P.bp/P.tp/[20,35,50,80]`。
- **P2-2 测试去重 + 常量推导**：融合页解析逻辑抽成**真实纯函数** `momentumState()`/`takerBuyPct()`（indicators.js，与 `normLongRatio` 并列），renderFusion 与 ai.test 共用同源（删掉测试自写副本 `lsLongPct/momState/takerBuyPct`）；`pointToIndex` 测试期望从 `VIEW_LEN` 常量推导（不硬编码 magic 值 400）。
- **验证**：测试 167(indicators) + 66(main) 全过（main 由 64→66 新增：多空比小数归一化、momentumState 数据不足 null），build 成功，dev 已重启。

### 5.18 四阶段增强：量价背离/支撑阻力 + 链上数据 + 三层共振 + 触发式 LLM（v1.5）
按四阶段顺序落地（本版本不涉及 spot，全部合约侧）：
- **阶段一（量价/支撑阻力）**：`volumeDivergence` / `supportResistance`（indicators.js 纯函数，带单测）。
  新信号 `量价底背离/顶背离/触及支撑/触及阻力` 入 `SIG_DIR`（分向入库供学习）；`updateAI` 加置信；技术信号卡新增两行；LLM 提示词每币 meta 追加。
- **阶段二（链上 ETH/BNB）**：`fetchOnChain()` ETH 用 Etherscan V2（`stats/ethsupply`）或 **Blockchair 免 Key 回退**（已验证），BNB 用 BscScan V2（需 Key）。
  新增 2 卡（链上活跃度 / BNB销毁·ETH供应）→ 融合页 **30 卡**；Key 存 `apiKeyStore` IndexedDB（exchange `'OnChain'`）；`chainOf` 映射（注意正则须带 `$` 锚定，防 BUSD 误匹配 BNBUSDT）。
  纯函数：`hexToNum` / `parseScanV2` / `parseBlockchairStats` / `onChainTrend`。并入 `fetchAllFusionData`（第 9 源）。
- **阶段三（三层共振）**：`threeLayerResonance(price, vol, atr, side)`（indicators.js 纯函数，10 单测）——
  层1=AI方向、层2=量价背离、层3=支撑/阻力，`agree>=2` → `resonance=true`。`updateAI`：共振 → 信号 `三层共振多/空` + **置信+15** + `S.ai.llmTrigger` 记录；LLM 提示词 meta 含 `三层共振/部分共振(N/3)`。
- **阶段四（触发式 LLM）**：`llmShouldRefresh(cfg)` —— 固定频率到期 **或** 新鲜强触发（`S.ai.llmTrigger` 30s 内 + 距上次刷新≥60s，`THRESH.LLM_TRIGGER_FRESH/GAP`）→ 立即分析。`buildMarketPrompt` 支持 `opts.trigger`「触发原因」段落；日志区分触发式/定时。`llmShouldRefresh`/`llmCacheStale` 入 exposeGlobals。
- **验证**：测试 213(indicators) + 66(main) 全过，build 成功，dev 已重启；headless 验证 30 卡、三层共振 agree 逻辑、llmShouldRefresh 四场景（无缓存/新鲜无触发/新鲜触发/过期触发）。

### 5.19 新闻情绪信号（消息面层，v1.5.1）
- **纯函数**：`newsSentiment(items)`（indicators.js，带单测）解析 RSS 标题/分类，关键词加权（`盈亏/利好/看涨`+1，`亏损/利空/看跌`-1，`net>=2`→bullish、`<=-2`→bearish），大小写不敏感、正负抵消。
- **数据源**：`fetchNews()`（CoinDesk RSS，经 `/rss-proxy` vite 代理绕过 CORS）+ `fetchNewsCryptoCompare()` 备选；`vite.config.js` 已加 `/rss-proxy` → `coindesk.com/arc/outboundfeeds/rss`。
- **融合页**：新增 1 卡「新闻情绪」（最新标题 + 利好/利空/中性标签 + 计数 + 来源）→ 融合页 **31 卡**；`S.fusion.news[sym]` 按币过滤，`THRESH.NEWS_MAX_ITEMS=10`。
- **LLM 联动**：`buildMarketPrompt` 每币 meta 追加 `新闻:正面(N利/N空):标题`，LLM 获得消息面上下文。
- **验证**：indicators 新增 10 用例全过；此功能与 5.20 自适应修复同属 v1.5.1 发布。

### 5.20 自适应参数引擎（修复所有市场数据，v1.5.1 核心）
六阶段全链路实施，目标：**不为任何单一市场手工调参，市场状态一变参数自动跟着变**。上一批监控发现 sigScore 脏表（winRate=1.15）、方向门硬清零、超时 24h 固定导致样本饥饿——本批系统性修复。
- **阶段0（sigScore 数据清洗）**：`sanitizeSigScoreTable(ss)` 纯函数扫描并清除 winRate>1 或 w+l≠total 的脏行；`loadState` 幂等挂接（`S.ai.cleaned==='v1.6'` 标记，仅清理一次）。
- **阶段1（regime 状态机连续化）**：`detectRegimeState(series,{pctHis})` 返回连续量 `{type,direction,strength,volatility,atrState,stability,deadZone,slopePct}`；死区 ATR 自适应 `max(0.1%, ATR中位数×0.5)`，替代原固定 0.15% 死区；`strength=|slope|/(死区×6)` 封顶 1。`ADAPTIVE_PERCENTILE=true`（P=75），止损/超时改由历史分位数驱动。
- **阶段2（参数引擎）**：`src/engine/regimeParams.js` 新模块（纯函数）：
  - `regimeParams(state)`：5 类离散映射（`THRESH.REGIME_RANGE`）——trend-up/down `{stopMult:1.5,ladderMult:[3,6,9,12],exitSpreadThr:40,aiMaxScale:1.0,trendW:1.5,meanW:0.5}`、range `{2.5,[6,10,15,20],25,0.6,0.5,1.5}`、pullback `{2.0,[4,8,12,16],35,0.8,1.0,1.0}`；弱趋势按 strength 向 range 线性插值防突变；unknown→`REGIME_DEFAULT_PARAM`（等价修复前固定参数）。
  - `volFactor(state)`：阶梯止盈比例 `0.25×(1+vol)` 钳制 `[0.15,1]`（波动高→快跑锁利），无状态→0.25 零行为变化。
  - `regimeSignalWeight(sigName,state)`：趋势市顺势信号×`trendW`(1.5)/均值回归×`meanW`(0.5)，震荡市反向，回调/未知→1.0。
- **阶段3（tick 离场自适应）**：保本/阶梯止盈/跟踪止损/ATR 止损/超时全部走 `regimeParams` 的 `stopMult/ladderMult`；部分平仓比例由 `volFactor` 驱动；超时走 ADAPTIVE_PERCENTILE 分位分支。
- **阶段4（评分反转 N 帧确认）**：`shouldScoreExit(pos,curScore,thr,{hist,confirmBars:2})` —— 连续 2 帧反向分差达标才平（单帧不满足计数清零防横跳）；`manageAIExits` 用 `S.ai.reversalHist`（**仅内存，saveState 不写入**，重启重建）+ 动态 `exitSpreadThr`（regime 联动）。
- **阶段5（AI 信号权重+频率自适应）**：`getSigScore` 结果 × `regimeSignalWeight`（`S.ai._regime` 由 updateAI 每币循环设置、循环结束复位，防 AI 进化页读到陈旧状态）；`aiMaxEff=max(4, round(aiMax×aiMaxScale))` 动态每日上限（高波日 range→aiMaxScale=0.6 自动降频）。
- **阶段6（closePartial 记账）**：`PaperEngine.closePartial` 新增 `recordSig` 选项，AI 仓部分平仓也记 `recordDirResult`+`recordSigResultRef`，修 tt 与 w+l 记账盲区；tick 保本出/阶梯止盈传 `recordSig:!!pos.ai`。
- **暴露到 window**：`detectRegimeState`/`regimeParams`/`volFactor`/`regimeSignalWeight`/`sanitizeSigScoreTable`/`shouldScoreExit`/`THRESH`（exposeGlobals，CDP 调试用）。
- **测试**：`tests/regime.test.mjs` 新建 45 项（5 类映射/插值/volFactor 三态/regimeSignalWeight 方向/评分反转 N 帧/清洗）；`npm test` 并入（6 文件）；ai.test 的 shouldScoreExit 用例适配 N 帧。
- **验证**：338 测试全过（227+66+45）、build 成功、dev 已重启、headless CDP 实测——BTCUSDT 横盘被识别为 `range`，映射 `stopMult:2.5/ladderMult:[6,10,15,20]/exitSpreadThr:25/aiMaxScale:0.6`，volFactor=0.333，N 帧确认 r1=false/r2=true，sigScore 脏表已净化为真实数据。

### 5.21 K线分析页 SRSI warmup 修复 + K线拉取量提升（v1.5.3.1 后续）
- **症状**：K线分析页 SRSI 子图 KD 只画右侧约 1/3 宽；10m 面板完全无 KD。
- **根因（已实测）**：SRSI 默认 RSI=85 warmup 长（K 首次非空索引 94、D 在 98）；页面**先 `slice(-150)` 再 `srsiKD()`** → 150 根里只有最后 ~52 根有 KD（≈1/3 宽）；且 10m=5m 每 2 根合成、原 fetch `limit=150` → 10m 仅 **75 根**，到不了索引 98 → 全程 null。技术分析页 `techChart.js` 有**完全相同**的 `slice(-150)` 问题。
- **修复**：
  - 数据层：`refreshTechKlines` K 线 `limit=150→THRESH.KLINE_LIMIT(500)`（`thresholds.js`）。现各周期 500 根、10m ~250 根 ≥248（RSI=85 下 KD 铺满 150 宽窗口所需）。
  - K线页：新增纯函数 `srsiPanelSeries(price, cfg, bars)`（**先全量算 srsiKD 做 warmup，仅把展示 `slice(-cfg.bars)`**），`drawSub` SRSI 分支改用它；`drawSrsiPanel` 0..n-1 索引无需动。
  - 技术页：`drawSubChart`(行 788) 与 hover(行 669) 两处 SRSI 去掉 `.slice(-150)`，用全量 `series.price` 算 `srsiLinesFor`（展示由 `viewInfo`/`drawLine`/`pointToIndex` 统一取最近 ~150 根，自洽对齐）；主图 SRSI 叠加因 `tfPrice` 变 500 根自动受益。
- **测试**：kchart.test 新增 `srsiPanelSeries` 12 用例（500/250 根全宽、150 根旧截断首值仍 null 还原 bug、bars 超长/不足、空输入）→ kchart 26→**39**，全绿；build 成功、dev 已重启。
- **验证**：无头 Chrome——5m klines=500、10m=250（OHLC/时间戳对齐）、5m 与 10m `srsiPanelSeries` 均 `kFirst=0/dFirst=0`（KD 全宽）、11 个 SRSI 子图含 10m、无 kchart 相关报错（剩余仅有预存 CoinDesk RSS 代理 500/断连，与本次无关）。

### 5.22 K线分析页 hover 信息 + 成交量（v1.5.3.2）
- **成交量**：`S.klinesV[sym][tf]` 存 klines 第 6 位；纯函数 `sumVol(vols,step)`（右对齐分组求和，与 `downsampleOHLC` 对齐）供 10m 下采样累加；`getTFData` 返回 `v`。
- **纯函数（可测）**：`idxFromFrac(frac,len,bars)`、`fmtVol`、`fmtTime`、`mainHoverAt`（O/H/L/C/量/时间/涨跌%）、`subHoverAt`（RSI/MACD/SRSI 读数）。
- **悬停渲染（`drawHover`）**：竖十字线 + 主图横虚线+价 chip + **顶部联动汇总栏**（任意位置显示时间+主图C价±%/量+各子图读数，命中面板高亮）+ **命中面板浮动详情框**（`drawFloatBox` 跟随/翻转；主图 O·C/H·L/量+涨跌%、RSI 超买超卖、MACD 三值、SRSI K/D+金叉死叉）。
- **测试**：kchart 39→72（sumVol/idxFromFrac/fmtVol/mainHoverAt/subHoverAt 各边界），全绿；build 成功、dev 已重启。
- **验证**：无头——5m/10m 成交量等长、`sumVol(5m,2)` 与 10m 全等（除末根 in-flight）、鼠标悬停主图/子图无报错、像素采样确认联动栏与十字线已绘制；仅剩预存 RSS 代理报错（无关）。
- **Bug 修复**：`subHoverAt` SRSI 分支用**绝对索引 `i`** 取 `srsiPanelSeries` 的切片数组（`slice(-bars)`，索引 0..n-1），`len=500>bars=150` 时 `sl.k[425]` 越界恒 `null`→联动栏 `SRSI tf --/--` 与子图浮动框 `K -- D--`。修复：`off=max(0,len-min(bars,len))`，用局部索引 `li=i-off` 取值。回归测试 11 项（kchart 72→83）。

### 5.23 K线分析页 交易纪律分析面板（v1.5.3.3）
- **需求**：K线分析页新增实时纪律分析面板，给新用户直观的结论（无需记忆纪律规则），纯函数引擎 `analyzeTradeDiscipline` + DOM `renderTradeDiscipline`。
- **预演验证**（实现前跑过真实 BNBUSDT/ETH/SOL 数据）：引擎输出与人工分析结论一致（大趋势上升 + 4h 超卖回调 = 顺势低吸、日线超买 = 长期风险不追高），并据此修正两处：①入场确认改为**扫描全部短周期取最新鲜穿越**（非写死 5m）；②置信度联动**多周期分歧惩罚 + 入场确认加分**。
- **纯函数（kchart.js 导出，可单测）**：`analyzeTradeDiscipline(priceMap, srsiCfg, {bars, mainTF})` →
  `{trend:{tf,up,label,e20,e120,spreadPct}, multiTf:{bull,bear,verdict}, zones:{daily,main,scalp}, confirm:{dir,fresh,tf,confirmed}, entry:{dir,conf,confLabel,confParts,reason,entryCue,stop,target,risk}, rules:[5条]}`
  - 趋势：取最长可用周期（≥120 点）的 EMA20 vs EMA120；EMA120 不足时回退到 SMA(60) 作为慢线
  - 5 条规则（硬编码，与术语百科「交易纪律」分类一致）：顺势交易 / 多周期共振 / 逆势信号警惕 / 回调≠反转 / 信号只是提示
  - 置信度：方向基准 70/45/30 → `+10`多周期一致 / `-15`周期分歧 / `+10`入场已确认 / `-5`未确认 / `-10`日线极端反向 → clamp 10-90 → 高(≥70)/中(≥45)/低
  - 止损：当前价 ∓ 1.5×ATR（`atrClose` 无监督）；目标：长周期 EMA20
- **DOM 渲染**：`renderTradeDiscipline()` 双栏布局（左=方向/置信/理由/入场/目标/止损/调整说明，右=日线·主周期区域/多周期共识/入场确认/规则清单 ✓⚠）；签名守卫 `_discSig`（同 `renderSrsiOverview` 防 hover 重建）；`setKDisc`/`toggleKDisc`（`kchartApi` + `window` 绑定）；`cfg.discOpen` 默认开、折叠持久化
- **UI**：`index.html` 在速览表与画布间加 `#kchartDiscWrap`（带「📋 交易纪律分析」折叠头）；`styles.css` 加 `.kchart-disc*`/`.disc-*` 样式
- **验证**：kchart 129 全绿（新增 18 项：S1 顺势做多/中置信/回调≠反转通过、S2 顺势做空、S3 分歧惩罚、S4 空数据 null、S5 单周期不抛异常、S6 confirm 字段、S7 5条规则名），主套件 283+其余全过，build 成功，dev 已重启
- **Bug 修复（用户实测方向错乱）**：①**趋势被勾选周期污染**——原从勾选 TF 中挑最长算趋势，`日内`预设只勾短周期导致错判做空；修复：`renderTradeDiscipline` 传**全部 KLINE_TF 数据** + `klineSel`，`analyzeTradeDiscipline` 趋势取**全部 TF 最长周期**、SRSI/共识仍用勾选 TF（`opts.klineSel`）。②**做空目标在现价上方**——target 加方向保护（做多 `te20>p?te20:p*1.02` / 做空 `te20<p?te20:p*0.98`）。③**观察态无止损**——补 ∓1.0×ATR。回归测试 S8/S9/S10 → kchart 135 全绿
  - **实时价（用户提需）**：纪律面板左栏「入场/目标」之间加 `当前价: <实时> 距目标±% · 距止损±%`。实现要点：`renderTradeDiscipline` 顶部 **`_discSig` 守卫之前**每 800ms 调 `updateDiscLivePrice(box)` 直接改写 `#kchartDiscPrice`/`#kchartDist` span（绕过 60s K线重建），纯函数 `discLiveInfo(sym,analysis)`（读 `window.S.prices[sym].last/.chg` 算距目标/止损%）单测 11 项 → kchart 148 全绿
  - **双维度同框（消除"速览偏多 vs 纪律做空"视觉矛盾，v1.5.x 后续）**：两面板用**不同标尺**——速览 `bull/bear` 来自 SRSI 穿越(短中期动能)，纪律 `dir` 来自**最长周期 EMA 趋势**(`longestTrend()`，BTC=30d)——两者背离会让用户觉得系统自相矛盾、不可信。修复（不伪造一致，只透明化推导）：①抽取纯函数 `longestTrend(priceMap)`（趋势=最长可用周期 EMA20/EMA120）与 `trendConflictNote(up,verdict,trendTF)`（**双向对称**：趋势↓+一致偏多 / 趋势↑+一致偏空 才提示，同向或分歧均 null）；②`renderSrsiOverview` 页脚改为双维度 `偏多N·偏空M·一致偏多｜趋势↓(30d EMA -X%)`，趋势用全部 KLINE_TF 与纪律面板口径一致；③`analyzeTradeDiscipline` 返回 `conflictNote`，`renderTradeDiscipline` 在理由下方渲染醒目 `.disc-conflict` 横幅（如"金叉仅视为下跌中的反弹（回调≠反转），不顺加多"）。方向逻辑(趋势=方向基准)保持不变。单测 `longestTrend`/`trendConflictNote`/接线(含"短周期V反弹不被长周期下降污染") → kchart 185 全绿。

### 5.24 独立迷你 PWA 监控系统（K线多周期 SRSI + 纪律分析，v1.5.1 附加，不改动主系统）
- **目标**：把 K线分析页抽成**独立纯前端 PWA**，部署 Cloudflare Pages 免费空间、手机主屏离线壳运行；**绝不改动** legacy.js / main.js / index.html 主入口（现有智能交易系统原样不动）。
- **数据一致性硬约束（用户强要求）**：迷你系统显示的 K线/SRSI/RSI/MACD/纪律结论 **必须 = 主系统 K线分析页**。两道保证：
  1. `src/pwa/data.js` 的 `parseKlines(tf,raw)` **逐行 1:1 镜像** `refreshTechKlines` 解析（索引 c[1..5]/c[0]、`downsampleOHLC`+`sumVol`、`times.slice(-closes.length)`、`limit=THRESH.KLINE_LIMIT`），且只 import 共享模块（`indicators/timeframe/thresholds`），**不 import legacy.js** → 写入的 `S.klines[sym][tf]` 与主系统逐元素相同。
  2. RSI/MACD 子图所需 `S.indicators[sym][tf].series` 由 `computeSeries(closes)` 用**同一批共享函数** + 与主系统默认一致的 `techConfig.ais`（全开）算出 → 等于主系统 `computeIndicators` 输出。SRSI 子图直接用共享 `srsiPanelSeries` + 同一 `cfg.srsi` → 一致。
- **验证**：`tests/consistency.test.mjs`（已并入 `npm test`）用录制快照 `tests/fixtures/bnbusdt_klines.json` 断言 `parseKlines` 逐元素 = 逐行复制的主系统解析、且两侧 `buildSrsiOverview` 速览相等；另 `scripts/verify-pwa-data.mjs` 实时拉 Binance 跨检。无头 Chromium 实测：0 报错、速览/纪律面板正常、数据同源同算法。
- **文件**：`kchart.html`（独立入口，复用主系统 kchart 区块全部元素 ID + 自由币对输入框 `#symInput/#symBtn/#kchartFresh` + 本地交易对列表 `#symList`）、`src/pwa/data.js`、`src/pwa/kchartApp.js`（挂载+轮询：行情5s/K线60s、暴露 `window.setKSymbol/addPSymbol/removePSymbol` 等钩子）、`scripts/gen-icon.mjs`（zlib 免依赖生成图标）、`scripts/verify-pwa-data.mjs`、`docs/PWA_DEPLOY.md`。
- **本地交易对列表（v1.5.x 后续）**：PWA 自带独立交易对列表，**不读主系统 `smartTrader_syms`**，持久化在 `localStorage['pwa_syms']`（JSON 数组，默认 `['BTCUSDT']`），刷新/重开 PWA 仍保留。输入币对+`载入`→`addSymbol()`（规范化大写、去重后加入列表并切换）；列表 chip 点名→`loadSymbol` 切换、点 `×`→`removeSymbol`（删空回退默认 BTCUSDT，删当前则切到剩余第一个）。最近使用的币被 `touchSym` 移到列表末尾，`init` 重载时回到上次使用的币。UI 样式为 `kchart.html` 内联 `.pwa-sym-chip/.pwa-sym-name/.pwa-sym-del`（PWA 自包含，不改共享 styles.css）。
- **构建**：`vite.config.js` 多页（`index.html`+`kchart.html`）+ `vite-plugin-pwa`（manifest/`sw.js`/图标 glob 预缓存）。kchart 入口 chunk ~55KB（**未携带** legacy 主程序 240KB）。`npm run build` 前自动 `gen-icon`+`gen-version`；新增 `npm run pwa:icons`。
- **部署（⚠️ 分支必须是 `main`，否则白部署）**：自定义域 `srsi.openapi.im` **只服务 Production 部署**，而 Cloudflare Pages 把 `main` 分支视为 Production。命令：`rsync -a dist/ /tmp/srsi-pwa-deploy/ && TOKEN=$(sed -n '6p' /mnt/d/TEST/app/app29-openapi/pat.txt | sed 's/^Token://' | tr -d '\r'); CLOUDFLARE_API_TOKEN=$TOKEN CLOUDFLARE_ACCOUNT_ID=766d2b730eb31ff7aac0210a1808ad7f CI=1 npx wrangler pages deploy /tmp/srsi-pwa-deploy --project-name srsi-pwa --branch main`（**勿加 `--commit-dirty`**：pat.txt 含中文，`cat` 整文件作 token 会让 wrangler 的 Authorization 头含非 ASCII 而报 ByteString 错。⚠️ token 必须取第 6 行 `Token:x0EH4…M5e`——`grep -oE '[A-Za-z0-9_-]{40}' | head -1` 会把第 1 行的 GitHub PAT 截断误当 CF token 而报 `Authentication error [code:10000]`，改用上面的 `sed -n '6p'` 提取）。用 `--branch production`（或其它名）只会生成 **Preview** 部署，自定义域**不会更新**、线上仍显示旧版。浏览器若仍缓存旧 SW：用 PWA「刷新」按钮（unregister SW + 清 Cache + 硬刷新），或新开标签页。详见 `MAINTENANCE.md` §5。
- **部署必达机制（v1.5.1 后续）**：`public/_headers` 对 `/kchart.html` `/index.html` `/sw.js` `/registerSW.js` 设 `Cache-Control: no-cache`（防止 Cloudflare 边缘缓存旧入口/旧 SW 导致「部署了用户却还在跑旧包」）；`src/pwa/kchartApp.js` 的 `applyVersionGate()` 在 `APP_VER`（`APP_BUILD_TIME`）变化时**带随构建唯一的 `?_swclear=APP_VER` 参数强制重定向**（`forceClearCaches` 后 `location.replace`），确保下次加载必拿最新 HTML+JS。PWA 右下角有**版本徽章**（`showVersionBadge()`，显示 `APP_TAG · 构建日期`）供用户直观确认是否在最新构建；切币对时 console 打印 `[SRSI-DIAG] sym optTfs=… cfg15=… pwaByTf?… shByTf?…` 便于排查「切币丢参」是否真发生（`src/tech2/kchart.js` `diagSrsi`）。
- **运行/地域**：WSL 改完需 `./stop.sh && ./start.sh`；`kchart.html` 自由输入币对（默认 BTCUSDT）；Binance 公共 REST 直连（CORS `*`），若所在地区 `api.binance.com` 被墙，设 `window.KCHART_BINANCE_API` 换端点即可（改动一行）。**已知微小差异**：迷你系统实时价取 Binance `/ticker/24hr`（与主系统部分走 CoinGecko 的 `S.prices` 可能 ~0.1% 点差），但 K线/SRSI/纪律结论不受影响（全来自 klines）。
- **底部「安装到本机」提示条**：`kchart.html` 新增 `#pwaInstall` 固定底部条（样式内联在 kchart.html `<style>`，不改动 shared `styles.css`）。
- **滚动修复**：`styles.css` 的 `body{height:100vh;overflow:hidden;display:flex}` 是主系统固定全高布局；独立页复用同 styles.css 会裁切无法滚动。在 `kchart.html` 内联 `<style>` 里覆盖 `body{height:auto;min-height:100vh;overflow:auto;display:block}`（同特异度、位于 link 之后故生效），使独立页可滚动查看完整画布与底部子图；不改动 styles.css。安装条 `position:fixed;bottom:0` + `env(safe-area-inset-bottom)` 适配 iOS 安全区。
- **「刷新」按钮**（#pwaRefreshBtn，位于「载入」旁）：点击 `clearCacheAndReload()`——`unregister` 所有 Service Worker 注册 + `caches.delete` 清空 Cache Storage + `location.reload(true)` 硬刷新，用于解决 dev/部署后旧 PWA 缓存不更新（用户实测安装后不能滚动即因缓存了修复前版本）。`src/pwa/kchartApp.js` 绑定。
- **页面缩放按钮**（#pwaZoomOut / #pwaZoomIn / #pwaZoomLbl，位于「刷新」旁）：对 `document.body` 设 `style.zoom`（区间 0.6×–3×，步长 0.1，默认 100%，点标签复位），`localStorage 'pwa_zoom'` 持久化。整页统一缩放（含底部安装条），桌面 Chrome/Edge 与 iPad/桌面 Safari 均支持 `zoom`；缩放后滚动、K线 hover 坐标仍正常。
- **纪律面板单列全宽**：`styles.css` 的 `.kchart-disc` 默认 `grid-template-columns:1fr 1fr`（双列），在窄/半宽处易让长行换行（"到页面中间就换行"）。在 `kchart.html` 内联 `<style>` 覆盖为 `.kchart-disc{grid-template-columns:1fr}`（右栏去左边框、改上边框分隔），使面板始终单列全宽，与主系统观感一致；不改动 styles.css。`src/pwa/kchartApp.js` 的 `setupInstallPrompt()` 监听 `beforeinstallprompt`（桌面 Chrome/Edge/安卓触发按钮 → `prompt()` 系统安装框）、`appinstalled`（安装后隐藏）、并对无该事件的 Safari/iOS 显示手动「分享→添加到主屏幕/程序坞」指引；已 standalone 或用户关闭（`localStorage pwa_install_dismissed`）则不再显示。`vite.config.js` 设 `devOptions.enabled:true` 以便本地 dev 也能触发安装事件（生产 pages.dev HTTPS 原生可用）。
- **SRSI 优选参数切币后恢复 + 面板着陆（v1.5.x 后续）**：核心数据层（`applyPwaOverlay` 回填 preview.best→srsiByTf、setSym 先持久化旧币对、切币往返）经反复验证是**正确的**——程序「切币往返 + 刷新」不会丢优选参数（回归测试含 PWA 私有键闭环）。用户实测"切币丢参数"实为**面板误读**：面板把 `cfg.srsiByTf[cfg.srsiEditTf] || cfg.srsi` 显示在**当前编辑周期** tab 上，而 `srsiEditTf` 随币对默认 `'5m'`——切到只优选过其它周期（如 1h）的币对时，面板停在 5m 显示默认值，看似"参数丢了"。修复：新增纯函数 `firstOptimizedTf(cfg)`（按 `KLINE_TF` 短→长取首个 `srsiOptSource[tf]==='optimized'` 周期，无则 null）；`setSym` 在 `loadCfg()` 后若 `srsiOptSource[cfg.srsiEditTf]!=='optimized'` 则 `cfg.srsiEditTf=firstOptimizedTf(cfg)`，使切币后面板直接停在已优选周期并显示优参（◆/已优选 N 同步）。脱敏版已同步；kchart 测试 892 全绿（新增 12 项切币往返 + 面板着陆）；全套 302/66/56/57/892/16/35/12/11/10/8 通过；生产已部署（chunk `kchart-CqKMctd5.js`，setSym 着陆逻辑与 firstOptimizedTf 均确认在产物中）。

### 5.30 localStorage 配额红线 + SRSI 参数持久化修复（v1.5.4）
- **根因（v1.5.3 实测暴露）**：`src/tech2/kchart.js` 的 `_optWriteStore` 把**每币每周期约 2 年原始 K 线**（closes+opens+times，15m 单份 ~6 万根 ≈ 1.8MB）写入 `localStorage` 键 `srsiOptHist:v8:<sym>|<tf>|<days>|<maxBars>`。几次优选即撑爆 ~5MB 配额 → 此后**全部** `localStorage.setItem`（`persist` 写 STATE_KEY='smartTrader_kchart'、`writePwaSrsiOpt` 写 pwa 键、回测原始K线键等）因 `try{...}catch(e){}` 静默吞错而**全部写入失败** → SRSI 参数/配置从未落盘，刷新/切币全丢。
- **修复（已部署 v1.5.4，chunk `localLoop-u5D78h-v.js`）**：
  1. `_optWriteStore` 改为**不持久化 K 线到 localStorage**（仅保留会话内 `_optHistCache` 秒回；跨会话重新拉取 90–240s 可接受）。K 线历史是可重新拉取的**衍生数据**，不属于"必须持久化的用户数据"。
  2. 新增 `_safeSetItem(key,str)`：写入抛 `QuotaExceededError`（`e.name==='QuotaExceededError'`/`code 22`/`1014`）时先 `pruneOptHistory()` 清掉所有 `srsiOptHist:*` 键释放配额再重试，并打印 `[SRSI-PERSIST]` 错误日志（不再静默吞掉）。
  3. `persist()`(STATE_KEY)、`writePwaSrsiOpt`/`writePwaSrsiAuto`(经 `_writeJson`)、`resetSymbolCfg`、`_btCfgSave`/`_btWriteStore`/`_btWriteRaw`/`_btWriteFund`/`clearBacktestStore` 全部改走 `_safeSetItem`。**关键保证**：即便某历史残留把配额撑满，首次 `persist` 写 STATE_KEY 时会自动 prune 并成功落盘——用户已撑爆的旧 localStorage 在首次写入时**自愈**。
- **红线（对接交易所真实交易前务必遵守）**：任何用户配置/账户/成交/参数数据绝不能以"静默 catch 吞掉失败"的方式写 `localStorage`；写入必须走 `_safeSetItem` 且失败时**显式报错并尽量自愈**（先清理可重建的巨型缓存再重试）。配额敏感型数据（历史行情等派生数据）**不要**持久化进 localStorage，改走 IndexedDB 或仅内存缓存。
- **验证**：`tests/srsiOptFetch.test.mjs` 改称验会话内 `_optHistCache`（新增 `__getOptHistCache` 导出）；全套 302+57+896+16+35+12+11+10 全过；生产 `https://srsi.openapi.im/kchart.html` 已引用新 `localLoop-u5D78h-v.js`。


### 5.31 Alpha 基石策略定调（GOAL12，v1.5.27 —— 战略级决策，务必先读）
- **用户确认（2026-09-14）：Alpha = 本项目基石策略（core）**。证据链（GOAL11 长窗复现，vision 官方历史数据 BTCUSDT）：永续 6.7 年 CAGR +30.3%/maxDD 29%（与 GOAL2 六年 +29.3% 跨数据源重复验证 ✓）、现货只多 8.7 年 +24.6%、8 年 6 正无毁灭年、0 爆仓、参数平台宽（GOAL10：81 组网格无一负 Sharpe）。
- **SRSI 降级为卫星层**：GOAL11 实锤——SRSI 默认参 6.7 年长窗 -23.4%/215 次爆仓/DD99%（vs 365d 报告 +17%~+84%）→ **窗口选择偏差实锤，SRSI 历史报告数字必须打折**；现货只多 8.7 年仅 +1.9%（收益全靠杠杆+做空+高波年）。防爆对比（6.7 年）：filter 182$（爆仓 215→160）> revconf 反手 121$（反手更差，与 5.30.1 v1.5.8 教训一致）> none 82$——filter 方向对但仍 -82%，不够格配资金。
- **UI 策略选择（地位声明）**：回测设置面板顶部新增「🧭 策略」块（.kt-bt-strategy，每策略独占一行）：①**Alpha 实验（基石策略 ★）**（cfg.btStrategy='alpha'，**默认选中=第一位**）②SRSI 策略（卫星层）③SRSI+Alpha 组合（原 ktBtAlphaCombo checkbox 并入，字段 alphaCombo 仍兼容但 UI 由 btStrategy 驱动）。交易条同步垂直排列：①「Alpha 基石实盘(paper)」（ktAlphaLive，接 __alphaLab.startLive/stopLive/isLive，仅 PWA）②「SRSI 自动永续合约(卫星)」③「SRSI·应用回测参数」。
- **Alpha 参数身份 = 固化，不优选**：GOAL2-4 定版（vt30%/levCap3/band5%/combo 权重 carry0.5+momo0.2+brk0.3），GOAL10 证明参数平台宽（精调无益、自动优选引入过拟合风险）——alphaLab 面板与回测报告均已标注固化声明；**严禁给 Alpha 加自动优选**。
- **卫星策略入场券制度（F 路线图）**：任何其它策略（含 SRSI 参数适配）要在实盘配资金，必须依次通过：①本地**长窗**（2018→今 vision 数据）回测为正贡献（/tmp/goal11-bt.mjs + btsa fork 可重跑）②防爆强化（predictDanger 多因子 filter 长窗转正）③regime 闸门（高波分位启用/低波阴跌降杠杆三态）④本地验证无过拟合（参数网格平台 + 跨币）→ 才进实盘小仓位。
- **工程坑**：runSrsiBacktest 开头按 btStrategy 分流（'alpha'→runAlphaBacktest 单独报告+导出「基石策略」节）；Node 长窗回测必须用 /tmp/goal11-btsa.mjs fork（EMA 查表 O(1)，与生产逐位对齐）——生产 backtestSrsiAuto 每根 4×klineDirFromCloses 全量 EMA=O(n²) 长窗不可用；backtestSrsiAuto 防爆 config 字段名=**srsiAutoDanger**（'none'|'filter'|'revconf'）；funding 参数=对象 {fundingTime,fundingRate}；vision 2025 后 open_time 微秒要 /1000。


### 5.32 交易面板独立折叠 + 主图实盘信号层（GOAL13，v1.5.28）
- **交易面板折叠**：kchartTradeBar（手动下单+SRSI 自动+回测面板整体）包进 #ktPanelWrap（kchart-discwrap 折叠模式，仿交易纪律分析），**默认收缩**，cfg.tradePanelOpen 记忆（localStorage），刷新恢复；头部 #ktPanelState 状态徽章（renderQuickTrade 更新：●Alpha实盘青/●SRSI自动绿）。kToggleTradePanel 经 main.js/kchartApp.js 绑 window（HTML onclick 直调——**新增 onclick 直调函数必须同时绑 kchartApi + window**，GOAL13 踩坑）。
- **主图实盘信号层**（叠加栏「实盘信号」chip，cfg.sigOverlay 默认开）：策略勾选即映射——SRSI自动开启→SRSI 信号（▲绿开多/▼红开空实心三角+灰点平仓）；Alpha基石实盘(live)→Alpha 信号（◆#22d3ee 多/◆#f59e0b 空 实心菱形+空心灰菱形平仓）；应用回测参数→组合角标。**信号=真实交易**：数据源为实际成交动作（__srsiLiveTrades=placeOrder 成功+SRSI自动 exitPosition；__alphaLiveMarks=alphaLive 实际调仓），持仓 S.pos/历史 S.closed 本地持久化（pwa_paper_state/smartTrader）随时可查。
- **多策略路线（讨论定调）**：基石（Alpha，全周期持有）之上的卫星策略按**市场周期分层应用**而非全周期全开——高波动分位期启用 SRSI 类短线（2020/2022 型年单年数倍）；低波阴跌期（2025 型）基石降杠杆+卫星禁用。卫星入场券=GOAL12 5.31 四关（长窗正贡献/防爆强化/regime 闸门/参数平台）。候选后续策略须先本地长窗验证（/tmp/goal11-bt.mjs fork 体系可复用），禁止直接实盘。

## 6. 冒烟测试速查
用 `node /tmp/smoke_settings.mjs`（或更新版）做设置/AI 行为冒烟：
环境需 mock `globalThis.document`（terminalBody 需返回 `{children:[]}` 否则 log() 崩）、
`localStorage`、canvas（`getContext` 返回带 `createLinearGradient` 的 stub）。
注意：mock 下 `setRiskPreset` 会触发 render 链，需足够 DOM stub。

## 7. 数据流速览
- 价格：Binance WS/REST + OKX WS/REST + CoinGecko → `S.prices`/`S.okx`（含 `lastT`/`okxT` 时间戳）
- 融合：资金费率（双所取均值）、持仓量 OI（双所均值）、恐惧贪婪指数、鲸鱼（CoinLobster）
- AI：`updateAI` 每 4s → 算 1t 信号分 `ls/ss` → 乘 `getSigScore()`（历史胜率加成）→ 阈值触发
- 持久化：localStorage `smartTrader`（设置+子账户+持仓+AI统计） + IndexedDB 事件溯源/账本

### 5.25 SRSI 钩信号（死钩/金钩，v1.5.x 后续）
- **命名（用户定义）**：死钩 = 高位死叉 + 跌破超买线（K 由 ≥超买 跌到 <超买「掉落上限带」且近 `lookback`(默认15) 根内发生 K 下穿 D 翻转）；金钩 = 低位金叉 + 突破超卖线（K 由 ≤超卖 升到 >超卖「突破下限带」且近 lookback 根内发生 K 上穿 D 翻转）。二者均标记在「带退出」那根。
- **纯函数**：`indicators.js` 新增 `srsiHooks(kArr, dArr, opts)`（带退出 + 附近 K/D 翻转判定，前后方向都算）。`srsiCrossings` 仍是「K 穿越 80/20 带」(反手策略) 旧标签——勿混淆。
- **展示**：`buildSrsiOverview` 每周期取最近 `row.hook`/`row.hookFresh` 与最近 band-cross（`row.crossing`/`row.fresh`）。多周期速览「穿越」列用 `latestCross(row)` 取**离当前最近**的一根信号：钩(死钩/金钩) 与 钗(金叉/死叉) 比新鲜度，更近者显示（同新鲜度优先钩），红/绿加粗（CSS `.ov-hook-death/.ov-hook-gold`）；新鲜度列随显示标记走。`subHoverAt`/`drawSubDetail` 的 SRSI 悬浮按**命中那根**显示 穿越(钗) 与 钩 两行；`drawSrsiPanel` 在钩处画红/绿菱形 ◆。
- **权重（仅入场确认）**：`analyzeTradeDiscipline` 抽出纯函数 `pickConfirm(rows)`，与速览 `latestCross` 同一套"最近信号"逻辑——先取每周期离当前最近的一根（钩或钗，钩仅当为最近事件才以钩计），再跨周期按新鲜度取最近；钩为最近事件时置信 `+15`（否则 `+10`），纪律面板/提示语显示 金钩/死钩 并标 `[钩]`。**不动** 多周期共识(verdict)/底部偏多偏空（K 轴动量，与钩的均值回归轴分离）。速览「穿越」列与纪律入场确认均已对齐"显示最近的"。
- **测试**：`tests/indicators.test.mjs`(srsiHooks 正/负例) + `tests/kchart.test.mjs`(dirName/pickConfirm)。合成价难以触发（深跌易把 RSI 钉 0 致 K=D 无交叉），真实行情数据正常触发。

### 5.26 K线分析页 · 模拟真实交易（纸面快捷合约，v1.5.x 后续）
- **目标**：K线分析页新增**快捷合约交易条**（主系统 `index.html` 与 PWA `kchart.html` 共用 `#kchartTradeBar`，由共享 `src/tech2/kchart.js` 渲染）。
- **方向定死**：开空=U本位 / 开多=币本位（按钮文案即明示）。**平仓利润的 50% 自动再投**到另一资产（U本位利润→买币；币本位利润→卖币变现 USDT）。
- **仓位**：杠杆滑杆(1–30，默认10) + 仓位两种都要——比例滑块(占可用保证金资产 25/50/100%) 与 固定数额输入（按保证金资产：空填USDT、多填币）。
- **引擎扩展**（`src/exchange/PaperEngine.js`）：
  - `placeOrder` 新增 `marginMode`(默认 `'usdt'`，兼容 AI 旧路径) 与 `reinvest`；币本位 `qty=amt*lev`（非除以价）、费按 USDT 名义计。
  - `subs` 子项加 `type('spot'|'perp')` + `coins{sym}`；`_openPosition`/`_settle`/`exitPosition`/`closePartial`/`_liquidate` 统一走 `_settle`（按 marginMode 返还保证金 + 50%再投）。
  - 新增 `seedSim(sim)`/`resetSim(sim)`/`getPerpSub()`/`getSpotSub()`；`sim={spotUsdt,perpUsdt,coin{sym}}`，两 USDT 池分离、币库存按交易对一份。
- **设置（主系统 + PWA 均持久化、可重置）**：现货 USDT 池、永续U本位 USDT 池、各交易对币本位库存（现货与永续同量）。
  - 主系统：`legacy.js` 的 `S.sim` + 设置卡「模拟真实交易」「K线快捷交易」；`setKchartTradeOn`(总开关)/`setKchartLink`(联动主系统资金) 写 `S.kchartTradeOn`/`S.kchartTradeLinked`。
  - PWA：`localStorage('pwa_sim_settings')` + `localStorage('pwa_paper_state')`（账户+持仓持久）；`src/pwa/kchartApp.js` 用 `globalThis.S` 作引擎 state，独立纸面模拟。
- **联动**：默认联动（`window.paperEngine` 即主系统 `S`，进 PnL/子账户）；关「联动」→ 独立隔离引擎 `window.__isolatedPE`（不进主 PnL）。**AI 自动交易开关**仍只管 AI（快捷交易为手动，不受其控）。
- **UI 接线**：`kchartApi.setTradeEngine(engine)` + `setTradeConfig({on})`；`renderKChart` 每次重绘时顺带 `renderQuickTrade()`（实时余额/持仓/价）；键盘 ↑开多/↓开空/空格平仓（仅交易条可见时）；防误触（首次点击 arm，3s 内再点确认）。
- **持久化**：主系统沿用 `smartTrader`（subs 加 coins/type、pos 加 marginMode/reinvest、加 sim 块）；PWA 独立 localStorage。
 - **测试**：`tests/paperSim.test.mjs`（U本位空盈利→币增、币本位多盈利→USDT增、币库存0拒开、reinvest=false 不转换、seed 幂等、reset 重建）全过；`npm test` 全绿（含 288 主套件 + paperSim）。

### 5.27 订单管理弹窗（对冲模式 + 全功能，v1.5.x 后续）
 - **持仓模型=对冲**：引擎 `PaperEngine._openPosition` 仅 `S.pos.push(pos)`，**无净仓/同币限制**，天然支持同交易对同时多空并存、同方向多单。之前"只显示一个订单"是交易条只显示当前币首仓（`S.pos.find`）的 UI 局限，已由本弹窗解决。
 - **入口**：快捷交易条新增 `持仓(N)` 按钮（`renderQuickTrade` 骨架），点击 → `kchartApi.openOrderManager()`。主系统与 PWA 共用（弹窗 DOM 由 JS 动态创建挂在 `body`，复用 `.modal-overlay` 样式）。
 - **弹窗内容**（`src/tech2/kchart.js`）：列出**全部**持仓，列：交易对/方向/模式(U本位·币本位)/杠杆/开仓价/标记价/浮盈($·%)/TP/SL/操作；每行操作 = `平仓`(全平) / `平50%`(部分，`closePartial` ratio 0.5) / `反手`(`reversePosition`：平旧+同参数反向开) / 杠杆输入(改 `pos.lev`) / TP·SL 价格输入；顶部 `一键全平` + 实时单数；打开时 800ms 重绘（浮盈随现有 1s 循环已算好）。
 - **止盈止损（用户价位点）**：持仓新增 `pos.tp`/`pos.sl`（价格或 null）。纯函数 `checkUserTpSl(engine)` 按方向触发（多单 `价≥tp→止盈`、`价≤sl→止损`；空单镜像），在**现有两个 1s 循环**（主 `main.js` / PWA `kchartApp.js`）各调用一次，主系统联动/隔离两引擎都覆盖；逻辑只写一处。
 - **复用**：`exitPosition`(全平) / `closePartial`(部分) / `placeOrder`(反手) 均为引擎既有接口；`reversePosition`/`checkUserTpSl` 导出在 `kchartApi`。
 - **测试**：`tests/orderManager.test.mjs`（多/空 TP·SL 触发与未触发、部分平仓 qty/amt 减半、反手生成反向仓且保持币本位）全过；`npm test` 全绿。

### 5.28 K线纪律分析 · 方向基准视野化 + 死区滞回（v1.5.x 后续）
- **背景**：`longestTrend` 原取"全部 TF 中最长"（常是 7d/30d 周线）做方向基准，实盘横盘期 7d 周线方向全向下 → 纪律面板误导"做空"，且 EMA20/120 价差远小于 1 根 K 线波动 → 横盘期信号当作方向。多币种实时预演确认新方案。
- **方向基准**：`horizonTrend(priceMap,{capMin:240})`（indicators 纯函数改在 kchart.js）取**勾选内最长但 ≤4h** 的 EMA20/120 趋势；7d/30d 归**宏观带** `macroTrend()`（只做冲突扣分，不参与方向）。
- **死区（固定/自适应滞回）**：默认固定 `THRESH.HORIZON_DEAD_FIXED=0.5%`（spread 低于 → `flat=true` → 观望）；`atrPctHistory()` 现算 ATR/close% 历史，`deadZoneLatch(ratio)` 滞回状态机（极端 ratio≥2.0 或 ≤0.4 连续 3 帧 → adaptive，ratio 0.6~1.5 连续 3 帧 → 回 fixed），`deadZoneValue()` 合成 clamp(中位ATR%×0.5, 0.1%, 3%)。
- **共享状态**：`updateHorizonState(sym,priceMap)`（模块级 `__hzLatch` Map + `__hzCache`，仅内存）在 `renderKChart` 每次推进，`renderSrsiOverview(hz)`/`renderTradeDiscipline(hz)` **共用同一 deadZone/同一基准周期**（两面板口径一致）；`hz.mode/deadZone` 加入 `_ovSig/_discSig`（死区翻转强制重建 DOM）。
- **宏观冲突扣分**：`conflictPenalty(mt,dir)` = clamp(|宏观 spread%|×0.5, 10, 20)，方向与宏观反向时从置信度扣（confParts `宏观反向-N`）+ 横幅 `macroConflict`。
- **回调≠反转数据驱动**：不再假设主周期方向，改用**实际 SRSI 读数**（主周期超卖/超买 + 勾选周期超买超卖广度 ob/osCount）拼「常规回调/深度回调」文字；横盘时注明"回调≠反转暂不适用"。
- **横盘语义**：`trend.flat` → 规则1「横盘观望」、方向 `观望`、reason 含死区%、入场提示"等价差突破死区或 SRSI 共振"。
- **测试**：kchart 213→**214**（新增 horizonTrend 8 / macroTrend 4 / atrPctHistory 3 / deadZoneLatch 3 / deadZoneValue 3 / conflictPenalty 7 + S8b 横盘4；替换原 longestTrend 5）；S8 期望 1d→4h、pmC 由"V反弹被30d污染为做空"翻转为"方向基准取4h、30d 变宏观冲突扣分"。全绿 + build 成功 + dev 已重启。

### 5.28.1 方向基准口径修正 + 速览脚部防误读标签（后续修复）
- **问题（用户实测困惑）**：主周期 `mainTF` 选 1d/7d/30d 时，`renderKChart` 的 `capMin = Math.max(THRESH.HORIZON_CAP_MIN, minutesOf(cfg.mainTF))` 会把方向基准**上探到该长周期**（如 1d=1440 分钟）。于是 BNB 上看到 `方向↑(1d EMA 6.9%)｜宏观7d↓`，纪律面板判"做多"，但用户见"宏观 7d 向下 + 速览表大量超买死叉"以为该做空 → 视觉矛盾。7d/30d 本应按 5.28 归宏观带（只扣分、不参与方向），却因 capMin 上探被绕过了。
- **修复 1（方向基准固定 ≤4h）**：`renderKChart`（kchart.js）改 `const capMin = THRESH.HORIZON_CAP_MIN;`（固定 240=4h），**不再随 mainTF 上探**。7d/30d 永远只做宏观冲突扣分（`macroTrend`/`conflictPenalty`），与 AGENTS.md 5.28「方向基准≤4h」口径一致。三处消费方（`updateHorizonState`/`renderSrsiOverview`/`renderTradeDiscipline`）接收同一 capMin，两面板口径一致性不受影响。
  - **实测影响（改前）**：BNB 各周期 EMA——4h `↑+2.90%`、1d `↑+6.59%`、7d `↓-2.31%`。固定 4h 后方向基准取 4h(↑) → 方向仍是"做多"（与上探 1d 相同）；但方向基准周期从 1d 变 4h，更贴近战术短线，且 7d 回落为纯宏观背景。
- **修复 2（速览脚部防误读标签）**：`renderSrsiOverview` 页脚 `trendTxt` 拆分为有标签的两行：`【趋势方向·决策】↑做多(4h 2.9%)`（决定做多做空）与 `【大趋势·仅扣分】↑/↓(7d x%)`（只降置信度不改方向），外加一行小字说明「短周期箭头≠趋势方向，大趋势反向≠翻方向，仅降置信度」。杜绝"宏观↓→该做空"的误读。
- **核心口径（务必遵守）**：**趋势方向=EMA(≤4h)决定做多做空；短周期 SRSI(速览表)只定入场时机与置信度；大趋势(7d/30d)反向只降置信度、不翻方向。** 三者是不同标尺，不互相打架。
- **验证**：改后经 CDP 实测 BNB 方向基准取 4h、脚部显示新标签；`npm test` 全绿、build 成功、dev 已重启。

### 5.29 交易纪律方向因子消融回测（方向精度，v1.5.x 后续 · 长期累积中）
- **目标**：纯后端回测对「交易纪律分析」多空方向做**因子消融**——逐个测候选因子增量贡献，只保留样本外有正贡献者，据结果修正 `analyzeTradeDiscipline`。**不做「事后择优」**（杜绝前视）。
- **判定口径**（用户确认）：入场 = 纪律分析给出方向(做多/做空)的 1h 评估点；出场 = `2×ATR 止盈 / 1.5×ATR 止损`先到判盈亏（`winLossByAtr`，`THRESH.BT_TP_ATR=2 / BT_SL_ATR=1.5`）；前 2/3 调参 → 后 1/3 验证。样本单位=「信号」非快照。
- **候选因子池（F1-F7）**：F1 领跑能量 `leading.score/isClear`、F2 入场确认 `confirm.fresh/isHook/contrarian/confirmed`、F3 多周期一致 `verdict/bull/bear`、F4 波动率 `atrPct`、F5 策略切换 `strategy`、F6 宏观冲突扣分、F7 基准趋势 `trend.up/flat/spreadPct`。
- **纯函数**（`src/engine/indicators.js`）：`winLossByAtr(price,atrArr,{entryIdx,direction,tpAtr,slAtr,horizon})` → `{win:1|-1|null,pnlPct,barsHeld,exitDir}`；`atrClose`（ATR 用）。
- **共享分析核心**（`src/engine/disciplineAnalysis.js`，纯函数，前端+Node 同源）：`parseJsonl`/`dedupeRows`(同 sym,ts 去重留最新)/`decorrelate`(同 sym+dir 连续 run 折叠)/`coverageMatrix`/`buildAblation(rows,{decorr,minGroupN})`/`FACTORS`/`REGIMES`/`DIRS`/`MIN_SAMPLE=600`。**前端融合页面板与 `scripts/analyze-discipline-factors.mjs` 都必须复用此核心，禁止两侧各自实现**（否则数字不一致）。
- **采集脚本**（`scripts/measure-discipline-factors.mjs`）：浏览器 CDP 内拉 Binance 带时间戳 klines（15m/1h/4h，评估轴=1h≈42天），walk-forward 跑 `analyzeTradeDiscipline`(mainTF=1h) 得方向 → `winLossByAtr` 判前向盈亏 → 记录 F1-F7 因子值 → 追加 `data/discipline-factors.jsonl`。**带增量过滤**（只追加比已记录最新 ts 更新的评估点，重跑全历史不重复追加旧点）。
- **后台累积**：`scripts/measure-discipline-factors-loop.mjs 60`（每 60 分钟采样一次，跨时间覆盖不同行情）。**当前正在运行**：每 60min 由 `(setsid node ... &)` 拉起（进程名 `measure-discipline-factors-loop`，日志 `/tmp/disc-loop.log`；同机还有 `measure-energy-regime-loop` 30min 在跑旧快照式测量，勿混用口径）。
- **分析脚本**：`scripts/analyze-discipline-factors.mjs`（薄壳，全逻辑在共享核心；`--decorr` 看独立 run）。
- **进度文档**：`scripts/gen-discipline-readme.mjs` 生成 `data/README.md`（当前快照：样本跨度/覆盖矩阵/因子表/如何续跑）。
- **前端面板**：`src/tech2/fusionBacktest.js`（`ensureFusionBacktestPanel` 挂在融合页底部「🧪 因子消融回测」，读 `/data/discipline-factors.jsonl`，覆盖矩阵+因子表+去相关开关，5min 自动刷）。接线于 `legacy.js` `renderPage` 的 `p==='fusion'` 分支（`renderFusion()` 后调用）。**面板仅在 dev 可用**（data/ 不打包进 dist，生产 404 走错误提示，属预期）。融合页卡片仍 31 卡不变。
- **测试**：`tests/disciplineAnalysis.test.mjs` 23 项（parseJsonl/dedupe/decorrelate/coverageMatrix/buildAblation/decorr 模式），已并入 `npm test`；`tests/indicators.test.mjs` 新增 winLossByAtr 14 项（→302）。当前全套：engine+persist+reconcile 全过、indicators 302、ai 66、regime 56、disciplineAnalysis 23、kchart 261、consistency 8 —— **全绿**。
- **⚠️ 关键现状（新会话务必先读）**：**因子消融结论尚不可下**。当前 ~10 天数据是**单一上涨行情**：覆盖矩阵唯 `pullback-up/buy` 达 1013≥600✓，其余格（卖/震荡/回调）远不足 600；去相关后仅 59 个独立 run。**方向基线≈47-50%（近抛硬币）**。必须靠 loop 长期跨行情累积，等到覆盖矩阵多格 ≥600 才能据实修正 `analyzeTradeDiscipline`。**尚未改动 analyzeTradeDiscipline 的方向逻辑**，生产行为与 v5.28 一致。
- **续跑步骤**：确认两个 loop 存活（pgrep）→ 跑 `node scripts/analyze-discipline-factors.mjs` 看消融 → `node scripts/gen-discipline-readme.mjs` 刷快照 → 前端融合页看面板 → 覆盖矩阵达标后再决策是否改 `analyzeTradeDiscipline`（改时须加回归单测、改 `__ovSig/_discSig` 相关常量不涉及）。

### 5.30.1 回测基线 (9) +84.2% 复现与防爆反手语义（v1.5.9，务必先读，防止改崩现场）
- **(9) 报告文件**：`C:\Users\hctem\Downloads\BTCUSDT-20250911-20260911-365d-perp (9).txt`（收益 +84.2%、1148 笔、66 强平、净损失 -$2763.9、期末 $1842）。**这是不容退化的基线**：任何对回测引擎/防爆逻辑/EMA/危险信号的改动，都必须跑同参回测，确认 防爆反手 / 预防爆仓 仍 ≈ +84.2%、66 强平、-$2763.9（允许 ±1 笔/±$50 数值抖动，因分笔滑动/资金费时点）。
- **(9) 关键参数**（回测设置面板须可复现）：币对 BTCUSDT；账户 合约-USDT本位；本金 $1000；杠杆 7x；模式 跟随；方向 多空；仓位类型 固定数额；仓位基准 15%；#4 乘法缩放 4h+30%/1h+20%/30m+10% 未命中扣对应权重；自动优选 关；连开上限 10；带 90/强平 10；费率 0.045% 开/平；滑点 0.020%；资金费 计入；SRSI 15m R14/S9/K2/D3；4h R5/S5；1h R21/S21；30m R5/S14；5m R5/S28；10m R7/S28（自动优选关时全部用这些手动参数）。
- **(9) 的收益来源（关键）**：(9) 的「防爆反手」在 v1.5.9 中 = **过滤/避开危险单**（模型键命中才反手、无键则避开），**不是**自动反手开反向。+84.2% 来自**避开**了 emaOpp2 判定的危险单（≥2 个 4h/1h/30m 的 EMA120 反向），而非反手盈利。同参 (23) 预防爆仓 = (24) 防爆反手 = +84.1%/+84.2%，且 (24) 的 `reverseOpens=0` 证实无反手开单 → 二者在 v1.5.9 完全等价。
- **v1.5.8 的陷阱（已回退，勿重蹈）**：v1.5.8 曾把防爆反手实现为「危险时**自动反手开反向**」（resolveEntryDecision 的 reverse 分支）。回测 (19) 显示这反而净亏（+21.1%、256 强平、maxDD 110.5%），因为反手信号与正向同样脆弱。**v1.5.9 已回退**到 (9) 的过滤语义。
- **用户定义的防爆反手（待 v1.5.10 恢复）**：用户明确「防爆反手 = 危险时刻**反方向开仓**」（用 srsiAutoReversePct/srsiAutoReverseLev，若为 0 则回退正常%/杠杆），且**反手单不计入同向连开上限**。但 AGENTS 5.30 的结论是：朴素反手（v1.5.8 式、基于 emaOpp2）净亏，**必须先有更聪明的危险信号 `predictDanger`**（基于 liqLog 特征，见 5.31 强平归因）才能让反手单正贡献。因此恢复反手的前提 = Stage 2 的 predictDanger 落地，且回测验证 防爆反手 净收益 > 预防爆仓。
- **66 笔强平是优化杠杆**：-$2763.9 ≈ 毛收益的 1/3。这 66 笔**未被 emaOpp2 捕获**（emaOpp2 只在 ≥2 周期 EMA120 反向才报警，而这 66 笔开仓时 EMA 并未反向）。Stage 0（强平归因 liqLog/openLog，已落地）导出这 66 笔开仓时刻技术面 + 对照组，供第三方 AI 找真正的爆仓共同特征 → 构建 predictDanger。
- **版本红线**：改回测相关代码后，必须 `npm test` 全绿 + 跑 (9) 同参回测核对 + bump 版本 + `npm run build` + 部署 srsi.openapi.im（preview 分支 main）。生产已验证 serving 1.5.9。

## 8. 安全红线
- 真实资金默认硬锁（`locked`）；仅当双所测试网对账全部通过才 `armed`；本版本不开放 `live`。
- API Key 只存 IndexedDB（AES-GCM），绝不进 git、绝不上传。
