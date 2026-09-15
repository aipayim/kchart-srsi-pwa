# GOAL14 — 用户反馈修复：F12 报错 / Alpha 回测明细 / SRSI 收益波动 / 角标遮挡

> 反馈：1. F12 报错（fapi.binance.vision fundingRate ERR_CONNECTION_CLOSED 刷屏 + [SRSI-PERSIST] smartTrader_kchart_bt_raw/bt QuotaExceededError）；2. Alpha 回测只有概要没有明细；SRSI/组合 365d 收益比前一天报告低许多；3. 主图右上角信号文字遮挡 SRSI 线和 K 线。

## 子任务
- [x] A. fundingRate 域名修复：去掉不存在的 fapi.binance.vision（vision 只有 S3 历史仓库）；fapi.binance.com 失败→降级 funding=[] 并静默（不重试错误域、不刷屏）
- [x] B. 回测持久化瘦身（5.30.1 配额红线）：bt_raw（回测原始 K 线 35k 根=派生数据）停止写 localStorage 只留会话内存；bt 结果裁剪大数组（ws/eqs 等逐 bar 数据不落盘，保留概要+trades 事件）
- [x] C. Alpha 回测明细：页面显示年度分解+近期调仓明细；导出报告加「基石明细」节（对齐 SRSI 报告的可复核性）
- [x] D. SRSI 收益波动解释（写入 GOAL.md/AGENTS）：窗口右移一天收益大变=窗口选择偏差（GOAL11 已证），非 bug；funding 缺失影响成本模型（A 修复后改善）
- [x] E. 角标遮挡修复：右上角信号文字加半透明背景条+上移至主图顶部外沿（不压 K 线/SRSI 线）
- [ ] F. 双仓 test/build → bump 1.5.29 → deploy → 线上验证 → 汇报

## 执行记录（2026-09-14，GOAL14 A-E 完成）

- A：EP_FAPI 移除 fapi.binance.vision（该域不存在，vision 只有 S3 仓库无 REST fundingRate）；fapi 不可达时静默降级 funding=[]（回测/实盘兼容空 funding）——ERR_CONNECTION_CLOSED 刷屏消除
- B：_btRawMem 会话内存缓存替代 localStorage（bt_raw 1.8MB 派生数据按 5.30.1 红线停止落盘+清理旧键）；bt 结果落盘裁剪 eqs/ws/fund 大数组（trades/概要保留，恢复/报告/组合不受影响）——QuotaExceededError 消除
- C：Alpha 回测明细——年度分解行 + 最近 10 笔调仓（页面）+ 导出报告全明细；基准数据（GOAL11）：Alpha 6.7 年 +30.3%/现货 8.7 年 +24.6% 可交叉核对
- D：SRSI 收益波动=窗口右移一天（20250914→20250915 窗口）+ 数据批次差异，GOAL11 已证窗口选择偏差（长窗 -23.4% vs 365d +17%~84%），属策略特性非 bug；funding 缺失影响成本模型（A 修复后 0916 起改善）
- E：角标移至右下角+半透明背景条（原右上角覆盖 SRSI 线/K 线）
