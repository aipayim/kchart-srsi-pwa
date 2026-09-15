# GOAL17 — 反馈修复：信号卡位置/勾选持久化/切币有效性 + 设计稿

> 1. 盯盘信号卡左上角→左侧垂直居中（不挡币对/周期/根数提示）；2. 交易面板 checkbox 刷新丢勾选——全部选项本地持久化（「本地清空」才恢复初始）；3. 切币/周期有效性确认与说明；4. 手机/PAD 盯盘体验 + 准确率提升方案（讨论稿）；5. 赛博风格设计稿 HTML（浏览器预览，确认后再实现）。

## 子任务
- [x] A. 盯盘信号卡移至主图左侧垂直居中（半透明背景条保持）
- [x] B. 交易面板全部 checkbox 持久化审计+修复（Alpha基石实盘/SRSI自动/应用回测参数/快捷交易开关/联动等，读写走 cfg，刷新恢复用户状态；本地清空=全初始）
- [x] C. 切币/周期有效性：manualSignal 跟随当前币（全币对有效）、SRSI 时机固定 15m、EMA 趋势随主图周期——卡片加币对+周期标签明示
- [ ] D. 手机/PAD 盯盘体验 + 准确率提升方案（docs/research/GOAL17-MOBILE-UX.md 讨论稿）
- [ ] E. 赛博风格设计稿 HTML（独立预览页，等用户确认后实现）
- [ ] F. 双仓 test/build → bump 1.5.32 → deploy → 线上验证 → 汇报

## 执行记录（2026-09-14，GOAL17 A-C 完成）

- A：信号卡移主图左侧垂直居中（3行：币对·周期标签 / 动作·时机 / 理由·SL·TP·EMA），不挡左上角币对/周期/根数提示
- B：持久化审计——已持久：SRSI自动/应用回测参数/自动可平人工单/SRSI面板参数；修复未持久 4 项：①Alpha基石实盘（cfg.alphaLiveOn+刷新自动 startLive）②防误触 ktSafe ③固定数额 ktUseFixed ④PWA 快捷交易开关（localStorage pwa_trade_on+select 回显）+ tradeOn/tradeLinked 入 cfg；本地清空按钮清 localStorage → 全部回初始 ✓
- C：切币有效性确认——manualSignal 每帧按当前选中币（sym）计算=全币对有效；SRSI 时机固定 15m（用户盯盘口径）；EMA 趋势随主图当前周期；卡片已加「SYM · 15m SRSI」标签明示
