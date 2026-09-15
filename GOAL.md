# GOAL19 — 信号卡显示修复 + 冷钢铁风设计稿 v3

> 1. 主图左居中信号卡用户环境不显示（GOAL16 合成验证通过但真实环境失败）——诊断+防御修复；2. 设计稿 v2 固化，v3 更冷钢铁风（金融向、全响应式 电脑/手机/PAD）。

## 子任务
- [x] A. 信号卡修复：srsiKD 输入防御（老配置缺字段深合并默认）；失败原因写 window.__manualSigErr + [SIG-CARD] 诊断日志；验证渲染路径
- [x] B. 设计稿 v3：docs/design/GOAL19-COLDSTEEL.html——冷钢铁金融风（钢青/冰蓝/银灰、金属渐变、细线 HUD、锐利切角）+ **全响应式**（desktop grid→PAD 双栏→手机单列+拇指条 mock）
- [ ] C. 双仓 test/build → bump 1.5.34 → deploy → 线上验证 → 汇报

## 执行记录（2026-09-14，GOAL19 A-B 完成）

- A：信号卡“不显示”根因实锤=**Y 坐标用了整画布高度 (PAD_T+(H-PAD_B))/2 落进子图区域，被子图随后绘制覆盖**（合成验证只测了 window.__manualSignal 值未验渲染像素）；修复=主图区垂直居中 (PAD_T→mainBottom)/2；附带修复 atrClose 返回数组未取尾值（stop/target 永远 null）；srsi 配置深合并防御+__manualSigErr/[SIG-CARD] 诊断
- B：设计稿 v3 docs/design/GOAL19-COLDSTEEL.html——冷钢铁金融风：钢青底#0a0e14+冰蓝#4fc3f7+银灰拉丝、金属渐变面板+铆钉+状态灯、细线 HUD（SIGNAL//01 标注）、SL/TP 独立格+进度计、克制动效（价格跳动/状态灯呼吸）；**全响应式**：桌面 grid 双栏→PAD≤1080 侧栏横排+子图 2 列→手机≤640 单列+拇指条常显（6 项融卡）；无头验证 0 错误+桌面/手机双截图
