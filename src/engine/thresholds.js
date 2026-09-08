/**
 * thresholds.js — 交易触发/风控阈值集中定义（单一事实来源）
 *
 * 目的：此前大量魔法数字散落在 legacy.js / indicators.js / PaperEngine.js /
 *       exitLogic.js / funding.js 中，逐处硬编码、难以审计与调参。
 *       本模块把它们集中到 THRESH，各模块 import 引用，保持"零行为变化"（数值与
 *       原实现完全一致），后续调参只改这一处。
 *
 * 单位约定：
 *  - *_PCT 表示百分比数值（如 0.15 表示 0.15%，用于 detectRegime 的 slope%）
 *  - ATR_PCT_MIN/MAX 同理为百分比数值（superviseATR 沿用原语义）
 *  - *_SECS / *_MS 为时间
 *  - 其余为纯比率/倍数
 *
 * 自适应分位（ADAPTIVE_PERCENTILE）：
 *  - 默认关闭 → 所有路径行为与硬编码版本完全一致（零行为变化）。
 *  - 开启后，ATR 止损/超时阈值将改由历史 pctHis 的分位数驱动（见 legacy.js superviseTFATR
 *    与 tick() 的消费点），波动环境自适应。
 */
export const THRESH = {
  // ---------- 版本指纹：改动阈值前请对照此表保证数值一致 ----------
  // ---- 市场情境 / 方向门 (indicators.js detectRegime/trendGate/gateKeepFactor) ----
  REGIME_DEAD_SLOPE_PCT: 0.15,      // |slope%| < 0.15 → 震荡市(死区)
  REGIME_DEAD_MIN_PCT: 0.1,         // detectRegimeState 死区下限(%) — ATR 自适应死区最小值
  REGIME_DEAD_ATR_MULT: 0.5,        // detectRegimeState 死区 = max(下限, ATR%中位数×0.5)
  REGIME_STRENGTH_MULT: 6,          // 强度归一: |slope%|/(死区×6)=1 → 满强度
  GATE_KEEP_BASE: 0.85,             // gateKeepFactor = 0.85 - |slope%|*0.45
  GATE_KEEP_SLOPE: 0.45,
  GATE_KEEP_MIN: 0.15,
  GATE_KEEP_MAX: 0.85,

  // ---- ATR 监督 (indicators.js superviseATR / superviseTFATR / signalBacktest) ----
  ATR_DEFAULT_PCT: 0.2,             // 兜底波动率(%)
  ATR_PCT_MIN: 0.01,                // ATR% 合理范围下限(%)
  ATR_PCT_MAX: 15,                  // ATR% 合理范围上限(%)
  ATR_SPIKE_RATIO: 3,               // 单帧突变阈值(当前/上次)
  ATR_MED_DEV: 3,                   // 偏离中位数预警阈值
  // 注: 原 signalBacktest 无 ATR 兜底 p*0.002 已在 P1-3 移除(假值污染判定)→ 样本计为 unresolved

  // ---- 自适应止损/超时 (legacy.js tick) ----
  ATR_STOP_MULT: 2,                 // 止损 = 2×ATR
  ATR_STOP_MIN_PCT: 1.5,            // 最小止损距离(% of entry)
  ATR_STOP_FALLBACK_PCT: 2,         // 无有效 ATR 时兜底 _p*0.02
  ATR_TIMEOUT_BASE_H: 24,           // 基准超时 24h
  ATR_TIMEOUT_MIN_H: 6,
  // ---- K线数据拉取 (legacy.js refreshTechKlines) ----
  // SRSI 默认 RSI=85 需 ~98 根 warmup 才能看到 KD(到索引98), 且 10m=5m 每2根合成(折半)。
  // 500 根 → 各周期 500 根、10m 下采样 ~250 根 ≥248(默认RSI=85下 KD 铺满 150 宽窗口所需)。
  KLINE_LIMIT: 500,                 // 各 K 线周期 REST 拉取根数(10m 由此 5m 源下采样)

  ATR_TIMEOUT_MAX_H: 48,
  ATR_TIMEOUT_MIN_SAMPLES: 5,       // pctHis >= 5 才启用自适应超时
  ATR_BLOWUP_MULT: 2.5,             // 波动率爆表标记: atrPct > base*2.5 → vFlag
  ATR_BLOWUP_PCT: 0.15,             // 且 > 0.15%

  // ---- 回测 / 先验 (walkForwardWinRate / __btSeed / updateAI 回测验证) ----
  BT_TARGET_ATR: 1,                 // signalBacktest 目标波幅 = 1×ATR
  BT_HORIZON: 60,                   // 胜负判定最多向后看 60 bar
  BT_TP_ATR: 2,                     // winLossByAtr 止盈 = 2×ATR (纪律因子消融)
  BT_SL_ATR: 1.5,                   // winLossByAtr 止损 = 1.5×ATR
  BT_WF_LAG: 30,                    // walk-forward 滞后 30 个信号(样本外)
  BT_CACHE_MS: 120000,              // __btSeed 重算间隔 120s
  BT_PRIOR_MIN_SAMPLES: 5,          // 先验取用最小样本(wins+losses>=5)
  BT_REAL_MIN_SAMPLES: 3,           // 真实样本>=3 → 接管学习
  BT_VERIFY_HI: 0.6,                // 先验胜率 >=0.6 → 加分
  BT_VERIFY_LO: 0.4,                // 先验胜率 <=0.4 → 降权
  BT_VERIFY_BONUS: 8,               // 回测验证加分权重
  BT_VERIFY_PENALTY: 0.6,           // 回测低胜率降权乘数

  // ---- 动量 / 风控 (legacy.js updateAI / tick) ----
  MOM_RUSH_PCT: 1.5,                // 急涨/急跌(1m K线近3根) 触发阈值
  MOM_CHG_SURGE_PCT: 2.5,           // 24h 超涨阈值
  FRESH_SECS: 30,                   // 行情新鲜度(>30s 拦截)
  FRESH_SECS_HI: 90,                // 融合页琥珀色阈值
  FRESH_SECS_CRIT: 180,             // 融合页红色阈值
  SAME_ENTER_COOLDOWN: 60000,       // 同币同向进场冷却 60s

  // ---- AI 提前平仓 (exitLogic.js / manageAIExits) ----
  EXIT_CONF_THR: 60,                // LLM 逆势平仓置信阈值(默认)
  EXIT_SPREAD_THR: 30,              // 评分反转平仓分差阈值(默认)
  EXIT_HOLD_MIN: 10,                // 最短持有(分钟)
  EXIT_MAX_DAY: 5,                  // 每日提前平仓上限

  // ---- 纸面撮合 (PaperEngine.js) ----
  SLIP_K: 0.1,                      // 波动滑点: slip = base + SLIP_K×ATR%
  SLIP_CAP: 0.01,                   // 滑点上限(1%)

  // ---- 离场参数 (legacy.js tick) ----
  // P2-1: 保本出/阶梯止盈/跟踪止损由"固定margin%"改为 ATR% 基准(价格×lev→margin%),
  //       仍以 RP 预设值(P.bp/P.tp, 即 margin% floor)兜底, 避免低波时过度收紧;
  //       ATR 不可用(监督缺数据)时回退原固定百分比。
  EXIT_BE_MULT: 1,                  // 保本出 = 1×ATR (价格)
  EXIT_LADDER_MULTS: [4, 8, 12, 16],// 阶梯止盈 4/8/12/16×ATR (价格)
  EXIT_TRAIL_MULT: 2,               // 跟踪止损距离 = 2×ATR (价格)

  // ---- 自适应分位(默认关 → 零行为变化; 开启后由历史分位数动态化阈值) ----
  // v1.6: 开启 — 止损/超时阈值改由历史 pctHis 分位数驱动, 波动环境自适应
  ADAPTIVE_PERCENTILE: true,
  ADAPTIVE_P: 75,                   // 使用 pctHis 的 75 分位

  // ---- 参数自适应引擎 (regimeParams.js: 5类regime离散映射 + 插值) ----
  REGIME_RANGE: {
    'trend-up':   { gateKeep: 0.30, stopMult: 1.5, ladderMult: [3, 6, 9, 12], exitSpreadThr: 40, aiMaxScale: 1.0, trendW: 1.5, meanW: 0.5 },
    'trend-down': { gateKeep: 0.30, stopMult: 1.5, ladderMult: [3, 6, 9, 12], exitSpreadThr: 40, aiMaxScale: 1.0, trendW: 1.5, meanW: 0.5 },
    'range':      { gateKeep: 0.60, stopMult: 2.5, ladderMult: [6, 10, 15, 20], exitSpreadThr: 25, aiMaxScale: 0.6, trendW: 0.5, meanW: 1.5 },
    'pullback-up':   { gateKeep: 0.50, stopMult: 2.0, ladderMult: [4, 8, 12, 16], exitSpreadThr: 35, aiMaxScale: 0.8, trendW: 1.0, meanW: 1.0 },
    'pullback-down': { gateKeep: 0.50, stopMult: 2.0, ladderMult: [4, 8, 12, 16], exitSpreadThr: 35, aiMaxScale: 0.8, trendW: 1.0, meanW: 1.0 },
  },
  REGIME_DEFAULT_PARAM: { gateKeep: 0.5, stopMult: 2.0, ladderMult: [4, 8, 12, 16], exitSpreadThr: 30, aiMaxScale: 1.0, trendW: 1.0, meanW: 1.0 },
  REGIME_VOL_FLOOR: 0.15,           // volFactor 阶梯止盈比例下限(高波动时快跑, 不低于此)
  REGIME_VOL_FLOOR_PCT: 0.25,       // volFactor 基准比例(原固定 0.25 阶梯止盈)
  REGIME_LADDER_LEG_MAX: 4,         // 阶梯最大档位(与 _ladder 长度对齐)

  // ---- 触发式 LLM (v1.5 阶段四: 真实信号触发时立即分析, 不等固定频率) ----
  LLM_TRIGGER_MIN_GAP: 60000,       // 触发式刷新最小间隔 60s(防刷)
  LLM_TRIGGER_FRESH: 30000,         // 触发事件在 30s 内视为新鲜

  // ---- 消息面(新闻) (v1.5 后续: CoinDesk RSS 免 Key 接入, 三层分析之"消息面") ----
  NEWS_FETCH_INTERVAL: 120000,      // 拉取间隔 120s
  NEWS_MAX_ITEMS: 5,                // 每币最多保留新闻条数
  NEWS_SENTIMENT_SCORE: 2,          // 信号加分权重(适中, 不喧宾夺主)
  NEWS_SENTIMENT_THR: 2,            // 净分阈值触发信号(|net|>=2)
  NEWS_FRESH_MAX: 300000,           // 新鲜度上限(5min), 超时标注"新闻暂不可用"
  NEWS_RSS_URL: 'https://www.coindesk.com/arc/outboundfeeds/rss',
  NEWS_PROXY_PATH: '/rss-proxy',    // 开发模式 vite 代理路径(生产可换 CORS 代理)

  // ---- K线纪律·方向基准视野化 + 死区固定/自适应滞回 (v1.5.x 后续) ----
  // 方向基准 = 勾选周期中最长、但 ≤ HORIZON_CAP_MIN(4h) 的 EMA20/120 趋势(7d/30d 归宏观带)。
  // 死区默认固定 HORIZON_DEAD_FIXED; 极端高低波动(ATR%相对中位数)被滞回识别后转自适应,
  // 极端过后自动回固定值 —— 避免低波时死区过宽(永远观望)、高波时过窄(把噪声当趋势)。
  HORIZON_CAP_MIN: 240,             // 方向基准最大周期(分钟)=4h
  // 短线钩反转加权: 当 ≥4h 周期进入超买/超卖极值带, 且 ≤1h 出现新鲜钩(死钩/金钩)时,
  // 该钩权重放大此倍数, 使其压过 4h 趋势权重(用户要求"1h权重>4h")→ 近线段(均值回归/见顶回落)反转被识别。
  // 注: 极值带内 4h 的 K-D 间距本就收窄→自身权重偏低, 故 8x 即可让 1h 钩稳定压过; 触发条件窄(极值带+低周期钩), 属"决定性反转"而非常态。
  HOOK_OVERRIDE_MULT: 8.0,
  HORIZON_DEAD_FIXED: 0.5,          // 默认固定死区 %(EMA20/120 spread 绝对值)
  HORIZON_DEAD_ATR_MULT: 0.5,       // 自适应死区 = 中位ATR% × 0.5(与 detectRegimeState 同构)
  HORIZON_DEAD_MIN: 0.1,            // 自适应死区下限 %
  HORIZON_DEAD_MAX: 3.0,            // 自适应死区上限 %
  HORIZON_ATR_HIS: 40,              // ATR% 历史窗口(根)
  HORIZON_ATR_MIN: 20,              // ATR% 至少多少样本才计算中位数/允许进自适应
  HORIZON_VOL_HI_ENTER: 2.0,        // 进入自适应: 高波 ratio(curATR%/medATR%) ≥ 2.0
  HORIZON_VOL_LO_ENTER: 0.4,        // 进入自适应: 低波 ratio ≤ 0.4
  HORIZON_VOL_HI_EXIT: 1.5,         // 退出自适应(回固定): ratio ≤ 1.5
  HORIZON_VOL_LO_EXIT: 0.6,         // 退出自适应(回固定): ratio ≥ 0.6
  HORIZON_VOL_CONFIRM: 3,           // 滞回确认帧数(连续满足才切换, 防抖)
};