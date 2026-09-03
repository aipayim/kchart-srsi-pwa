# K线多周期 SRSI + 交易纪律分析（独立 PWA）

> 纯前端、零后端、纸面模拟、开源（MIT）的 K 线技术分析小程序。
> Standalone PWA for multi-timeframe K-line SRSI & trade-discipline analysis — client-only, paper trading, MIT licensed.

---

## 中文

### 这是什么
一个独立的渐进式 Web 应用（PWA），打开网页即可使用，可「安装到主屏」离线运行。它把 K 线分析页（多周期 SRSI、RSI/MACD 子图、交易纪律分析面板）抽成**独立纯前端**版本，与主交易系统解耦。

### 功能
- 📈 多周期 K 线（5m/15m/30m/1h/4h/8h/1d/7d/30d）+ SRSI/RSI/MACD 子图
- 🧭 **交易纪律分析**：趋势方向、多周期共振、入场确认（金钩/死钩）、止损/目标、置信度、冲突提示
- 📋 信号生命周期呈现：酝酿 → 确认 → 活跃 → 老化 → 失效
- 💱 纸面合约快捷交易（U 本位 / 币本位，利润 50% 自动再投）
- 🌐 数据源容错：默认 `api.binance.com`，失败自动回退 `data-api.binance.vision`
- 📱 PWA：可安装、可离线、移动端可滚动

### 快速开始
```bash
npm install
npm run dev        # 本地开发 http://localhost:5173/kchart.html
npm run build      # 产出 dist/
npm test           # 运行 kchart + 一致性测试
```
打开 `http://localhost:5173/kchart.html`，输入任意币对（默认 BTCUSDT）即可。

### 部署（以 Cloudflare Pages 为例）
1. `npm run build` 生成 `dist/`。
2. 在 Cloudflare Pages 新建项目，构建命令 `npm run build`、输出目录 `dist`。
3. 绑定自定义域名（可选）。由于 PWA 用相对路径 `base: './'`，根路径需重定向到 `/kchart.html`——已内置 `public/_redirects`（`/ /kchart.html 302`）。

> 提示：本项目**不含**任何自动部署脚本，部署完全由你掌控。

### 自定义数据源
若所在地区 `api.binance.com` 被墙，可在加载前设置：
```html
<script>window.KCHART_BINANCE_API = 'https://data-api.binance.vision';</script>
```
应用会直连该端点；成功后会把该端点缓存到 `localStorage`，下次打开默认使用，不再等待超时。

### 安全说明（务必阅读）
- 🔒 **纯前端、无后端**：所有计算在你的浏览器本地完成，没有服务器收集任何数据。
- 🚫 **不要求、不收集任何 API Key / 私钥**：行情直接来自币安公开 REST 接口（CORS `*`），无需登录。
- 💰 **纸面模拟、无真实资金风险**：交易为本地虚拟资金，不连接任何真实交易所账户，不能也不会发生真实下单。
- 🗂 **本地存储仅含非敏感数据**：`localStorage` 只保存自选币对列表、UI 偏好、本地模拟账户状态，可随时在浏览器清除。
- 🌍 **数据源透明可换**：默认走公开行情接口，你完全可以自托管或指定任意兼容端点。
- ⚠️ 不要把任何交易所密钥提交进代码或 Issue——**本项目本就不需要密钥**。

---

## English

### What is this
A standalone Progressive Web App (PWA) you can open in a browser and "install to home screen" for offline use. It extracts the K-line analysis page (multi-timeframe SRSI, RSI/MACD subcharts, trade-discipline panel) into a **self-contained frontend** decoupled from the full trading system.

### Features
- 📈 Multi-timeframe K-line (5m/15m/30m/1h/4h/8h/1d/7d/30d) + SRSI/RSI/MACD subcharts
- 🧭 **Trade-discipline analysis**: trend direction, multi-TF consensus, entry confirmation (gold/death hook), stop/target, conviction, conflict notes
- 📋 Signal-lifecycle presentation: brewing → confirmed → active → aging → stale
- 💱 Paper-trading quick bar (USDT-margin / coin-margin, 50% profit reinvest)
- 🌐 Data-source fallback: defaults to `api.binance.com`, auto-falls back to `data-api.binance.vision`
- 📱 Installable, offline-capable, mobile-scrollable PWA

### Quick start
```bash
npm install
npm run dev      # dev server http://localhost:5173/kchart.html
npm run build    # outputs dist/
npm test         # run kchart + consistency tests
```
Open `http://localhost:5173/kchart.html` and enter any symbol (default BTCUSDT).

### Deploy (e.g. Cloudflare Pages)
1. `npm run build` produces `dist/`.
2. Create a Cloudflare Pages project: build command `npm run build`, output dir `dist`.
3. Bind a custom domain (optional). The PWA uses relative `base: './'`; the root must redirect to `/kchart.html` — `public/_redirects` (`/ /kchart.html 302`) is already included.

> Note: this project ships **no** auto-deploy scripts; deployment is entirely under your control.

### Custom data source
If `api.binance.com` is blocked in your region, set before load:
```html
<script>window.KCHART_BINANCE_API = 'https://data-api.binance.vision';</script>
```
The app will use that endpoint directly, and cache it in `localStorage` so subsequent opens use it by default without waiting for timeouts.

### Security (please read)
- 🔒 **Client-only, no backend**: all computation runs locally in your browser; no server collects any data.
- 🚫 **No API key / secret required or collected**: market data comes from Binance's public REST API (CORS `*`); no login needed.
- 💰 **Paper trading, no real-funds risk**: trades use local virtual balances and never connect to any real exchange account — no real orders can be placed.
- 🗂 **Local storage holds only non-sensitive data**: `localStorage` keeps your symbol list, UI preferences, and local paper account only — clearable anytime.
- 🌍 **Transparent, swappable data source**: defaults to public market endpoints; you may self-host or point to any compatible endpoint.
- ⚠️ Do not put any exchange keys into code or Issues — **this project needs no keys**.

---

## 参与贡献 / Contributing
欢迎 Issue 与 PR。本地改动后请跑 `npm test` 与 `npm run build` 确保通过。
Issues and PRs are welcome. After local changes, please run `npm test` and `npm run build`.

## 许可证 / License
MIT —— 开源、不限使用。
