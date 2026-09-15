# GOAL12 — Alpha 固化为基石策略（文档 + 源码 + 参数身份）

> 用户决策：确认并同意 **Alpha 为本项目基石策略（core）**。要求：①固化修订所有相关文档 ②修订源码回测/实盘的策略选择 UI（「Alpha 实验」放第一位，SRSI 等其它策略排后面，每策略一行，不并排）③确认 Alpha 在 PWA 的参数身份（固化/优选/自动优选）④再讨论其它策略如何在 Alpha 基础上实现（本地验证无过拟合才有资格）。

## 子任务
- [x] A. 回测设置面板：新增「🧭 策略」垂直选择块（①Alpha 实验（基石策略）②SRSI 策略 ③SRSI+Alpha 组合），cfg.btStrategy 默认 'alpha'（第一位=默认选中=地位声明）；原 ktBtAlphaCombo checkbox 并入（向后兼容）
- [x] B. 回测执行分支：strategy='alpha' → fetchKlinesRange(1h/1d)+runBacktest → 报告渲染进 ktSrsiBtResult + 报告导出新增「基石策略」节；'srsi' → 原流程；'combo' → 双跑+combineDaily（原 alphaCombo 路径）
- [x] C. 实盘交易条：策略块垂直排列——①「Alpha 基石实盘(paper)」checkbox（接 window.__alphaLab.startLive/stopLive，__alphaLab 不存在时提示仅 PWA）②「SRSI 自动永续合约」+「应用回测参数」（SRSI 行内）
- [x] D. Alpha 参数身份定稿：**固化参数**（GOAL10 平台证据：81 组网格无一负 Sharpe，精调无益；优选=引入过拟合风险）——回测报告/文档标注「基石参数=GOAL2-4 定版固化，不参与自动优选」；alphaLab 面板显示参数固化声明
- [x] E. 文档固化：AGENTS.md 新增「5.31 Alpha 基石策略」节（身份地位/UI/参数决策/卫星策略入场券制度）；GOAL.md 记录
- [x] F. 卫星策略路线图（讨论性写入文档，不实现）：SRSI 防爆强化（filter 多因子长窗转正）→ regime 闸门（高波/低波/阴跌三态）→ 本地长窗验证无过拟合 → 才配资金
- [ ] G. bump 1.5.27 → 双仓 test/build → commit+push 脱敏版 → wrangler 部署 → 线上验证 → 汇报

## 验收
- 回测面板策略列表：Alpha 第一行、SRSI 第二行、组合第三行，各占一行
- 勾「Alpha 实验」跑回测 → 出 Alpha 单独报告（年化/Sharpe/DD/调仓次数/期末额）
- 交易条策略块同序；测试全绿；线上 1.5.27 可见


## 执行记录（2026-09-14）

- A-C：回测面板策略块（Alpha 第一/默认）+ runAlphaBacktest（fetch 走 _btFetch 桩可测，兼容 stub 对象格式）+ 交易条 ktAlphaLive（isLive 恢复）+ alphaCombo→btStrategy=combo 兼容
- D：alphaLab 面板固化声明（GOAL2-4 定版参数，不参与优选）+ 报告导出「基石策略」节
- E：AGENTS.md 5.31 节固化；测试补 btStrategy（SRSI 用例显式 srsi）；双仓 npm test 全绿（源码 kchart 903 / 脱敏版 903）
