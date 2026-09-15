# GOAL18 — 手机/PAD 方案落地 + 赛博设计稿 v2（1:1 成品页）

> 手机/PAD 方案已获批 → 实现；赛博设计 v1 被否（不够前卫/动感/平庸）→ 重做为 1:1 全页面成品 mockup（非说明页）。

## 子任务
- [x] A. K线触屏取值：touchstart/touchmove 映射现有 hover（点按显示 OHLC/SRSI 读数，复用 mainHoverAt/subHoverAt）
- [x] B. 手机拇指区快捷条：触屏设备固定底部「▲开多/▼开空/平仓」≥44px（复用防误触+openModal），@media (pointer:coarse) 显示
- [x] C. PAD 横屏自动展开交易面板（matchMedia 检测）
- [x] D. 赛博设计稿 v2：docs/design/GOAL18-CYBER-v2.html —— 1:1 全页面 mockup（顶栏/主图K线canvas mock/左信号卡/子图/交易面板/融合卡/纪律面板），HUD 风+动效（扫描线/网格/呼吸发光/数据流），前卫动感
- [ ] E. 双仓 test/build → bump 1.5.33 → deploy → 线上验证 → 汇报

## 执行记录（2026-09-14，GOAL18 A-D 完成）

- A：K线触屏取值——touchstart/touchmove 映射 _hover（同 mousemove 路径，mainHoverAt/subHoverAt 全部读数），松手 2s 后清除
- B：拇指区快捷条 #ktThumbBar——触屏设备（pointer:coarse）固定底部：▲开多/平仓(→订单管理弹窗)/▼开空/🧭面板，≥44px+safe-area；开平仓复用 kchartTradeOpen（含防误触）
- C：PAD 横屏自动展开交易面板（pointer:coarse+landscape+≥900px 一次性检测）
- D：设计稿 v2 docs/design/GOAL18-CYBER-v2.html——**1:1 全页面动态 mockup**（顶栏 chips+动态发光 K线 canvas+左信号卡+子图×3+交易面板+持仓行+6 融合卡），HUD 风：切角面板/角框标记/网格+扫描线+暗角、青×品红撞色、动效（尾端脉冲/数据流/等化器条/呼吸浮动）；无头验证 0 错误+截图 docs/design/GOAL18-CYBER-v2-preview.png
