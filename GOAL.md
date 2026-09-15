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
- [x] C. test → 1.5.37 → deploy → 验证 → 汇报
- 线上 e2e（1.5.37）：状态带左缘越界像素 0 ✓；双仓全绿；脱敏版 941f345 已 push

# GOAL23 — α 角标刷新后不显示修复

> 反馈：主图「α空7%·54s前」刷新后不显示，需重点击「α信号」——排查：chip/cfg 已持久恢复（GOAL21 ✓），真因=**刷新后 alphaSignalProvider 不自动运行，A 数据为空 → GOAL6 绘制块无数据跳过**（非持久化问题）。

## 子任务
- [x] A. loadCfg 800ms 快照固化块内追加：cfg.alphaSignalOn=true 时自动后台跑 __alphaSignalProvider，完成后 renderKChart 补帧（切币场景同样覆盖）
- [x] B. test → 1.5.38 → deploy → 验证 → 汇报
- 线上 e2e（1.5.38）：0 错误 ✓；α 角标数据链路=cfg.alphaSignalOn（已持久）+800ms 自动 provider 重算+renderKChart 补帧

# GOAL24 — 拇指条补全（GOAL17-D ④ 收尾批）

> GOAL26 起拇指条已有骨架（fixed bottom/44px/pointer:coarse），对照 GOAL17-D ④ 有 6 差距：平仓按钮不直接平仓（开订单管理）、无强制防误触（依赖 _safeguard 可被关）、arm 状态不同步（无「确认?」反馈）、无状态行（价/持仓/浮盈）、遮挡页面底部（body 无 padding 补偿）、与安装条重叠（z-index 9999>50 全盖住）。

## 子任务
- [x] A. kchart.js：kchartTradeOpen(side,forceArm)/kchartTradeClose(forceArm) 强制两段确认（_safeguard||forceArm）；arm 判定去 _safeguard 前缀（纯时效）；thumb 骨架改 4 按钮（▲开多/平仓/▼开空/☰持仓）+ 状态行；renderQuickTrade 早退分支隐藏 thumb；_tradeOn=false 同步隐藏；export 供测试
- [x] B. styles.css：thumb 两行布局+状态行+armed 样式；去 display !important（JS 内联接管）
- [x] C. kchart.html：@media(pointer:coarse) body padding-bottom 补偿（防拇指条遮底部内容）
- [x] D. kchartApp.js：安装条 show/hide 时 thumb bottom 实测错位（offsetHeight）
- [x] E. tests：forceArm 两段确认/超时重 arm/_safeguard=false 直接下单/close 路径
- [x] F. 双仓 test → 1.5.39 → build → deploy → 线上验证 → 同步脱敏版 → 汇报

## 执行记录（2026-09-15，GOAL24 完成）

- 踩坑（重要）：原 GOAL18-B thumb 创建块**缩进错乱实挂在 setSrsiAutoOn 的 document 分支内**（非 renderQuickTrade），首轮替换后 thumb 仅在 Alpha 一键开启路径创建——PWA 主循环（renderQuickTrade 每秒）永不触发。症状：手动 api.renderQuickTrade() 立即出现、自然加载 15s 不出现。修复=renderQuickTrade 真实尾部（renderSrsiAutoPanel 后）调 syncThumbBar（commit f214bb0，重新部署 0ca291e1）
- 线上 e2e（1.5.39，iPhone 13 仿真 pointer:coarse=true）：thumb 自然创建 ✓、状态行「BTCUSDT 77118 ▲多10x -38.6」实时 ✓、arm 两段确认（确认开多?→下单 amt=0.25 币本位 ✓ / 确认平仓?→pos=0 ✓）、4 按钮（▲开多/平仓/▼开空/☰持仓）✓、body padding-bottom 92px ✓、80px 高 ✓、桌面回归 coarse=false 不创建 ✓、0 pageerror ✓
- 已知遗留（GOAL26 既有，未动）：①币本位 pos.pnlPct 口径失真（pnl/amt，amt 为币数 → %异常巨大；主系统同）；②PWA 新用户 coins 空 → 拇指条开多（币本位）alert「可用保证金不足」，需先在设置页填币库存
- 测试：kchart 903（+12 GOAL24 用例：_tradeOn=false 无下单/第一击 arm/第二击执行/参数/超时重 arm/超时后执行/换方向重 arm/空单 U本位/无持仓平仓无操作/平仓 arm/平仓执行）全绿

# GOAL25 — 触屏手势（双指缩放/长按锁定）+ pnlPct 口径修复 + 库存提示（用户反馈驱动）

> 反馈：①手机双指缩放主图/子图无效，屏幕跟着滚动；②处理 GOAL24 遗留（币本位 pnlPct 失真 / 库存 0 alert）+ GOAL17-D ①（点按取值已有、长按锁定缺失）。

## 子任务
- [x] A. 纯函数（indicators.js + 单测）：positionPnlPct(pos,price)（币本位分母=amt×entry 保证金 USDT 价值/U本位=amt）；barsFromPinch(bars0,d0,d1,min,max)（张开=放大=根数少）；insufficientMsg(mm,sym,held)（库存 0 引导文案）
- [x] B. kchart.js 手势：双指 pinch → cfg.bars（60-300）+persist+滑块同步；单指长按 500ms 锁定十字线（移动>8px 取消，再次点按解锁）；drawHover 汇总栏🔒；canvas touch-action:none + iOS gesturestart 拦截；kchartTradeOpen 库存 0 细化 alert
- [x] C. pnlPct 口径：legacy.js 浮盈循环 + kchartApp.js 主循环改 positionPnlPct
- [x] D. 双仓 test → 1.5.40 → build → deploy → 手机仿真验证 → 脱敏版 → 汇报

## 执行记录（2026-09-15，GOAL25 完成）

- A：indicators.js 三纯函数（positionPnlPct/barsFromPinch/insufficientMsg）+ 16 单测。**踩坑修正**：amt 缺失回退 entry×qty/lev 已直接是 USDT 保证金（币本位=entry×amt、U本位≈amt），勿再乘 entry
- B：触摸块重写——双指 pinch→cfg.bars（张开=放大=根数少）+滑块同步（persist 放 touchend 一次性落盘）；单指长按 500ms 锁定十字线（移动>8px 取消、再次点按解锁、锁定期间不触发 2s 自动清除）；drawHover 顶部「🔒 锁定·点按解锁」金色提示；canvas touch-action:none + iOS gesturestart/change 拦截；kchartTradeOpen 库存 0 放 insufficientMsg 引导文案
- **额外捕获线上崩溃（GOAL26 既有）**：合成触摸验证时暴露 `subHoverAt` SRSI 分支 `sl.hooks[-1]` 崩——空数据 tf → idxFromFrac=-1 → li=-1，且 srsiPanelSeries 空结构缺 hooks 字段。修=空结构补 hooks:[] + safe() 负索引/范围防御（kchart 903+3 回归全绿）。教训：**触屏取值路径线上从未被真实触发过，GOAL26 的 hover 修复只测了桌面路径**
- C：legacy.js 浮盈循环 + kchartApp.js 主循环改调 positionPnlPct（币本位 pnlPct 从 pnl/币数 失真口径 → pnl/amt×entry 保证金收益率）
- D：测试 indicators 319(+16)/kchart 903(+3)/全套无 FAIL；1.5.40 部署后复验发现崩溃→1.5.41 修复重部署。线上 e2e（iPhone13 仿真+合成 TouchEvent）：touchAction=none ✓、pinch 150→60→192（张开/捏合双向）✓、🔒金色 68px 出现→跨 2.5s 清除期仍在→解锁消失 ✓、0 PAGEERROR ✓
- 验证方法论：CDP dispatchTouchEvent 与 playwright mobile 仿真不兼容（e.touches 空）→ 用页面内 new TouchEvent+new Touch 合成事件驱动；🔒验证用 getImageData 金色像素采样

# GOAL26 — 底部 Tab 导航（GOAL17-D ③，拇指区单页切换）

> GOAL17-D ③：K线/交易/回测/设置——kchart.html 单页内切 panel 显隐（无路由改动）。⑤横屏 PAD 自动展开已由 GOAL18-C 实现（kchartApp.js initPwaTrade matchMedia landscape）无需重做。

## 子任务
- [x] A. kchart.html：内容块加 data-tab-block 标记（K线=根线数/子图开关/速览/纪律/主工具/画布；交易=ktPanelWrap；回测=alphaLabWrap；设置=SRSI参数/模拟交易设置/数据源；header 常驻不参与）+ 底部 Tab 条 DOM（4 按钮 ≥44px）
- [x] B. kchartApp.js：setupTabNav（切显隐+active+localStorage pwa_tab 记忆+切回K线 renderKChart 尺寸刷新）；kchart.js 加 export ktStackOffset()（Tab条高+安装条高）；thumb bottom 改走 ktStackOffset（kchart.js/kchartApp.js 共用公式）
- [x] C. 样式：#pwaTabBar fixed bottom 0（pointer:coarse 显示，桌面隐藏）；body padding-bottom 92→140；thumb/安装条叠层公式统一
- [x] D. 双仓 test → 1.5.42 → build → deploy → e2e（切tab后canvas重绘/拇指条位置/桌面回归）→ 汇报

## 执行记录（2026-09-15，GOAL26 完成）

- A/B：12 个内容块 data-tab-block 分组（K线=根线数/子图/hint/速览/纪律/主工具/画布 7 块；交易=ktPanelWrap；回测=alphaLabWrap；设置=SRSI参数/模拟交易设置/数据源 3 块；header 常驻）；#pwaTabBar 4 按钮（≥44px，fixed bottom 0，z-index 9998 低于 thumb 9999）；setupTabNav 切显隐+active+pwa_tab 记忆+切回K线 api.render()（canvas 从 none→block 需按实际尺寸重绘）
- C：kchart.js 新增 export ktStackOffset()（Tab条可见高+安装条可见高）——thumb bottom 每秒主循环校正走统一公式；kchartApp syncThumbForInstall 退役为同公式包装；body padding 92→140px（thumb+tab 叠加）
- **桌面回归踩坑**：setupTabNav 初版无条件激活分组切换——桌面无 Tab 条但 trade/bt/settings 块被 display:none（用户看不到交易面板！）。修=matchMedia(pointer:coarse) 不匹配直接 return（桌面全部块默认显示）。**教训：PWA 触屏特性的 JS 激活必须与 CSS media 条件同步**
- 线上 e2e（1.5.43）：桌面 Tab 隐藏+全块显示 ✓；手机 Tab flex+K线组 7/7+切设置/交易/回测显隐正确+pwa_tab 记忆 ✓；thumb bottom=53px（tab 49px+边距）随公式 ✓；0 PAGEERROR ✓
- 测试：kchart 906/indicators 319/全套无 FAIL（Tab 为纯 DOM 逻辑，e2e 为准）

# GOAL27 — SRSI 时机降频确认 bar（GOAL17-D 二.2，回应 GOAL16-B 成本问题）

> GOAL16-B 实锤：15m 带反手死因=0.13%/往返成本×1.2笔/日（年吞 ~80% 权益）。需笔/年<100 或降频。本 GOAL 给 SRSI 自动交易（实盘+回测）加「确认 bar」：带边沿信号后 N 根 15m 收盘仍满足带内条件才执行（0=关=现行为），滤掉「信号后立即出带」的假边沿，降频省成本。

## 子任务
- [x] A. 纯函数 srsiConfirmPass(k,d,upper,lower,side,count,confirmBars)→{inBand,fire,count,active}（kchart.js，单测）
- [x] B. 回测接线：backtestSrsiAuto 加 config.srsiAutoConfirmBars（钳 0-5），edge→pending{side,idx,count}（新 edge 替换旧），每根收盘 srsiConfirmPass 推进：fire→_execEdge(平盈利对向+开仓)；出带→作废；超窗(+5)防御作废。confirm=0 走原路径（_execEdge 逐行搬移）
- [x] C. 实盘接线：runSrsiAutoTrade 抽 _execEdgeLive；edge 时 confirm>0 → st.pendingConfirm={side,barT,count,setTs}（_autoState 存活）；每秒推进：新 15m 根（getTFData().t[last]>barT）→ srsiPanelSeries(c,srsi15,150)[len-2]=刚收盘根 k/d → srsiConfirmPass；超时 (N×15+30)min 作废；resetSrsiAuto 清 pendingConfirm
- [x] D. UI+persist：设置面板 #ktSrsiConfirm + 回测面板 #ktBtConfirm（0-5，默认 0）+绑定+同步；btCfg.confirmBars/_btOverlayFor/applyBtSnapshot nums 接线；回测条件展示加确认 bar 行
- [x] E. 长窗验证：(9) 365d 窗口 confirm=0/1/2/3 对比（笔数/成本占比/净值）；目标笔数降、净不劣化
- [x] F. test→bump 1.5.44→build→deploy→线上 e2e（设置项渲染/默认 0 行为不变）→脱敏版→汇报

## 执行记录（2026-09-15，GOAL27 完成）

- **实施**：纯函数 srsiConfirmPass + 实盘/回测双接线（pending{side,idx/barT,count} 镜像 pendingRev 模式）；实盘确认根=srsiPanelSeries(c,srsi15,150) 取 **[len-2]**（buildSrsiOverview 只返回最新一行，不能用）；confirm=0 路径为 _execEdge/_execEdgeLive 逐行搬移（零行为变化）。UI：设置面板「确认bar」+回测面板「确认bar」双输入（0-5 默认 0）+persist+回测条件展示行
- **踩坑（重要）**：srsiConfirmPass 返回 {fire:true,active:false}（消费）与作废 {active:false} 同为 active=false，推进逻辑首版 `if(!cp.active) 作废` 把 fire 也误杀→确认永不执行（回测 confirm≥1 全部 0 笔的假象、实盘 3 用例 FAIL）。修复=**推进逻辑 fire 优先于 active**（实盘+回测两处）；教训：**多标志返回值先查终态再查非终态**
- **测试**：kchart 928（+25：srsiConfirmPass 11 / 实盘 6：confirm=1 挂起·执行·confirm=2 两帧·confirm=0 不变·平盈利对向延迟 / 回测 6：降频生效·钳制）+ indicators 319 全绿
- **红线核对（版本对比法）**：vision 数据 BTCUSDT 永续（(9) 365d 窗口，23 万根 15m，(9) 参数近似：perp/follow/1000/7x/15%/maxSame10/带90-10/filter/费 0.045%/滑 0.020%/funding 计入），**git stash 前后 confirm=0 全部 10 字段逐位一致**（opens=570/liq=79/finalEq=533.7672/net=-466.2328/maxDD=79.43%/winRate=0.9735/fee/funding/reverseOpens=0）→ 零行为变化严格证明；(9) 基线自动保持
- **长窗验证（confirm 0/1/2/3 对比，同窗同参）**：笔数 570→355→267→172（÷3.3）；强平 79→57→46→32；净收益 **-466→-261→-160→+46.84（转正）**；maxDD 79.4%→75.8%→68.4%→42.3%。降频滤假边沿显著降成本/回撤，confirm=2~3 净值翻正——建议实盘用 confirm=2（笔数÷2.1、净+$306）或 confirm=3（笔数÷3.3、转正）
- **线上 e2e（1.5.44）**：#ktSrsiConfirm/#ktBtConfirm 渲染+min/max 0-5 ✓；persist 闭环（0→2→0 / 0→3→0 落盘 bySymbol.BTCUSDT / bt_cfg）✓；版本徽章 v1.5.44 ✓；0 PAGEERROR ✓。踩坑：persist 结构=bySymbol.<SYM>，e2e 读顶层键误判未落盘（读对位置后闭环）

## 红线
- **默认 confirm=0 零行为变化**：版本对比法核对（stash 前后同参同数据逐位一致）+ (9) 基线精神核对
- kchart.js 缩进陷阱：改前核对函数边界；版本必 bump（PWA 缓存门控）
