# GOAL15 — 反馈修复：Alpha 回测导出 + 信号 chip 慢响应

> 1. Alpha 回测只有概要+近10笔，没有像 SRSI 那样的「导出」——补导出按钮（全明细 txt）；2. 「α 信号」「实盘信号」chip 点击后十几秒才生效（按钮一直亮/角标残留）——修即时反馈+性能。

## 子任务
- [x] A. Alpha 回测导出按钮：结果区加「📄 导出」，导出基石报告全文（_btAlphaText 已含年度/近10笔）+ 全部逐笔调仓 txt（下载格式同 SRSI 报告）
- [x] B. chip 即时反馈：setSigOverlay/setAlphaSignal 点击**立即**更新 chip 样式（乐观 UI，不等重绘）；renderKChart 延迟到 rAF/微任务；排查 setAlphaSignal 是否同步等待 alphaSignalProvider 重算（6 年全量回放）并异步化
- [x] C. 角标残留：确认关闭实盘信号后右上角角标同步消失（sigOverlay 关→整层不画，含角标）
- [ ] D. 双仓 test/build → bump 1.5.30 → deploy → 线上验证（点击响应 <300ms 体感、导出文件正确）→ 汇报

## 执行记录（2026-09-14，GOAL15 A-C 完成）

- A：Alpha 结果区加「📄 导出基石报告」（年度分解+全部逐笔调仓 txt，文件名 alpha-SYM-起-止-365d.txt）
- B：慢响应根因=①setAlphaSignal await __alphaSignalProvider（6 年全量回放同步等待十几秒）②setSigOverlay 同步全量重绘。修：乐观 UI——点击立即翻 chip 样式（与初始渲染同色系无跳变）+ renderKChart 放 rAF/微任务 + provider 后台跑完补帧
- C：sigOverlay 关→drawMain 外层条件整层不画（含角标）逻辑本就正确，残留=重绘慢所致（B 修复后下一帧消失）
