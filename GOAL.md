# GOAL19 — 信号卡显示修复 + 冷钢铁风设计稿 v3

> 1. 主图左居中信号卡用户环境不显示（GOAL16 合成验证通过但真实环境失败）——诊断+防御修复；2. 设计稿 v2 固化，v3 更冷钢铁风（金融向、全响应式 电脑/手机/PAD）。

## 子任务
- [x] A. 信号卡修复：srsiKD 输入防御（老配置缺字段深合并默认）；失败原因写 window.__manualSigErr + [SIG-CARD] 诊断日志；验证渲染路径
- [x] B. 设计稿 v3：docs/design/GOAL19-COLDSTEEL.html——冷钢铁金融风（钢青/冰蓝/银灰、金属渐变、细线 HUD、锐利切角）+ **全响应式**（desktop grid→PAD 双栏→手机单列+拇指条 mock）
- [x] C. 双仓 test/build → bump 1.5.34 → deploy → 线上验证 → 汇报

## 执行记录（2026-09-14，GOAL19 A-B 完成）

- A：信号卡“不显示”根因实锤=**Y 坐标用了整画布高度 (PAD_T+(H-PAD_B))/2 落进子图区域，被子图随后绘制覆盖**（合成验证只测了 window.__manualSignal 值未验渲染像素）；修复=主图区垂直居中 (PAD_T→mainBottom)/2；附带修复 atrClose 返回数组未取尾值（stop/target 永远 null）；srsi 配置深合并防御+__manualSigErr/[SIG-CARD] 诊断
- B：设计稿 v3 docs/design/GOAL19-COLDSTEEL.html——冷钢铁金融风：钢青底#0a0e14+冰蓝#4fc3f7+银灰拉丝、金属渐变面板+铆钉+状态灯、细线 HUD（SIGNAL//01 标注）、SL/TP 独立格+进度计、克制动效（价格跳动/状态灯呼吸）；**全响应式**：桌面 grid 双栏→PAD≤1080 侧栏横排+子图 2 列→手机≤640 单列+拇指条常显（6 项融卡）；无头验证 0 错误+桌面/手机双截图
- 线上 e2e（1.5.34）：manualSignal wait/观望 ✓、err=null、**主图 kchartCanvas 像素扫描确认信号卡背景 127 万像素=渲染可见 ✓**（前两轮误报=采样错到 300×300 迷你图 canvas；正确对象=kchartCanvas）

# GOAL20 — 组合角标归位主图 + 设计稿暂停

> 反馈：1.「组合实盘ON…」显示在页面底部 MACD 右下角（错在整画布坐标系）——应归位主图；2. 设计稿暂停（v3 风格不认同，等用户方向再启）。

## 子任务
- [x] A. 角标位置修复：drawMain 组合角标 by=H-PAD_B-26（整画布底=落到 MACD 子图）→ by=PAD_T+MAIN_H-26（主图区内右下角，与左居中信号卡对角呼应，半透明背景条保可读）
- [x] B. 设计稿暂停记录（v1 说明页否/v2 青品红 HUD 已固化保留/v3 冷钢铁不认同——待用户给方向再启）
- [x] C. test/build → 1.5.35 → deploy → 验证 → 汇报
- 线上 e2e（1.5.35）：主图区右下角标背景像素 11555 ✓ 归位确认；双仓全绿；脱敏版 cbdc699 已 push

# GOAL21 — 持久化根因防御 + 主图底部状态带

> 反馈：①「Alpha基石实盘」「SRSI应用回测参数」刷新丢勾选 ②「α信号/实盘信号」chip 不持久 ③组合角标压 SRSI 下限带（建议 SRSI0 下方腾位置）④「α空7% 54s前」压上限带。

## 子任务
- [x] A. 根因排查：Node 往返测试（persist→loadCfg）全部字段保留 ✓ → 丢态在浏览器时序（checkbox 视觉恢复缺位+启动早期陈旧写入覆盖）
- [x] B. 修复：renderQuickTrade 每次重绘按 cfg 对齐 ktSrsiAuto/ktSrsiApplyBt/ktAlphaLive 勾选视觉（时序无关）；loadCfg 尾部 800ms 快照固化 persist（防早期覆盖）
- [x] C. 主图底部状态带 STATUS_H=22：分隔虚线+SRSI0 线下方专用信息条；组合实盘角标→带左、α 信号角标（α空7%·54s前）→带右；子图 y0 下移、BASE_H+22 全链自适应——不再压 K 线/上限带/下限带
- [x] D. test/build → 1.5.36 → deploy → 验证 → 汇报
- 线上 e2e（1.5.36）：状态带区深色像素 13063≈角标条面积（组合条 230×18+α文字）✓；sig 正常 ✓ 0 报错；双仓全绿；脱敏版已 push

# GOAL22 — 状态带文字越界 + SRSI 刻度避让

> 反馈：①状态带左下角文字一半超出页面 ②主图顶部 100/底部 0 被挡一半。

## 子任务
- [x] A. 组合角标 textAlign 残留 right → 文字以右对齐锚点画在左缘=向左延伸出画布；改 left+textBaseline alphabetic
- [x] B. SRSI 0-100 副轴刻度 y 钳制 [PAD_T+6, PAD_T+MAIN_H-6]——顶部 100/底部 0 完整显示
- [ ] C. test → 1.5.37 → deploy → 验证 → 汇报
