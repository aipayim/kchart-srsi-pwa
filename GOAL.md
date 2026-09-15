# GOAL13 — 交易面板独立收缩 + 主图策略信号映射 + 多策略路线讨论

> 1. 交易面板（手动下单+SRSI 自动+回测面板）独立为可收缩面板（仿交易纪律分析），默认收缩、状态记忆；2. Alpha基石/SRSI自动/应用回测参数 勾选后信号映射到主图（颜色/方式区分），信号=真实交易（历史/持仓本地持久化可见）；3. 讨论基石之上的多策略应用（按周期 or 全周期）。

## 子任务
- [x] A. 交易面板折叠容器：kchartTradeBar（含手动下单+SRSI 自动+回测 ktBtBody）包进「🧭 交易面板」折叠头（仿 #kchartDiscWrap），默认收缩，localStorage `kchartTradePanelOpen` 记忆，刷新恢复
- [x] B. 主图信号映射：drawMain 新增「实盘信号层」——勾 Alpha基石实盘→Alpha 信号（青蓝菱形◆开/空心平）；勾 SRSI自动→SRSI 信号（▲绿/▼红开仓+灰点平仓）；勾应用回测参数→组合角标；不同策略样式区分；总开关 cfg.sigOverlay（默认开）
- [x] C. 信号=真实交易核对：确认 SRSI 标记数据源=placeOrder/exitPosition 实际调用点、Alpha=alphaLive 实际调仓、历史（S.closed）/持仓（S.pos）本地持久化（pwa_paper_state/smartTrader）可查——文档说明主图信号与成交一一对应
- [x] D. 讨论+文档：多策略路线（AGENTS 5.31 入场券制度细化：按市场周期分层应用 vs 全周期；候选策略清单与验证门槛）
- [x] E. 双仓 test/build → bump 1.5.28 → commit+push → deploy → 线上验证（折叠记忆/信号层/一致性）→ 汇报

## 执行记录（2026-09-14，GOAL13 A-C 完成）

- A：#ktPanelWrap 折叠容器（discwrap 复用+ovhead+kToggleTradePanel）默认收缩、cfg.tradePanelOpen 记忆、renderKChart 恢复；头部 #ktPanelState 状态徽章（renderQuickTrade 更新：●Alpha实盘青/●SRSI自动绿）
- B：drawMain 实盘信号层重构——sigOverlay 总开关（叠加栏「实盘信号」chip，青色同 α 信号风格）；SRSI 勾选→▲绿/▼红三角+灰点；Alpha live 勾选→◆青多/◆橙空菱形+空心平仓；应用回测参数→组合角标；信号与真实交易一一对应（数据源=placeOrder/exitPosition/alphaLive 调仓动作）
- C：数据源核对——SRSI 标记写入点=kchart.js placeOrder 成功后（~5699）+4 处 SRSI自动 exitPosition（5749/5753/5761/5765）；Alpha=alphaLab tickLive 实际调仓后；持仓 S.pos/历史 S.closed 本地持久化（pwa_paper_state/smartTrader）✓

## 发布（v1.5.28 已上线验证 2026-09-14）

- 线上（srsi-pwa.pages.dev 合成数据 e2e）：默认收缩 ✓ / 点击展开 ✓ / 刷新记忆展开 ✓ / 实盘信号 chip ✓ / 1.5.28 ✓ / 策略顺序 Alpha 第一 ✓ / 0 页面错误；坑：onclick 直调函数必须绑 window（main.js+kchartApp.js）
- 双仓全绿（kchart 903）；commit b508774→23bedf5（脱敏版 push 成功）；AGENTS 5.32 已固化
